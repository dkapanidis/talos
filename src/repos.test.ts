import { describe, test, expect } from "bun:test";
import { RepoDiscovery, RepoMemory, extractRepoSlugs, memoryKey } from "./repos.js";
import { FileRecordStore, NullRecordStore } from "./tokens.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("extractRepoSlugs", () => {
  test("pulls the repo out of a linked pull request", () => {
    expect(extractRepoSlugs("see https://github.com/harbur/ray-app/pull/42")).toEqual([
      "harbur/ray-app",
    ]);
  });

  test("pulls the repo out of a linked branch URL", () => {
    expect(
      extractRepoSlugs("https://github.com/dkapanidis/talos/tree/talos/ray-151-add-tests"),
    ).toEqual(["dkapanidis/talos"]);
  });

  test("handles clone URLs and .git suffixes", () => {
    expect(extractRepoSlugs("git@github.com:harbur/ray-app.git")).toEqual(["harbur/ray-app"]);
    expect(extractRepoSlugs("https://github.com/harbur/ray-app.git")).toEqual(["harbur/ray-app"]);
  });

  test("de-duplicates repeated references", () => {
    const text = `
      https://github.com/harbur/ray-app/pull/1
      https://github.com/harbur/ray-app/issues/2
    `;
    expect(extractRepoSlugs(text)).toEqual(["harbur/ray-app"]);
  });

  test("returns every distinct repo when an issue spans several", () => {
    const text = "https://github.com/harbur/ray-app/pull/1 and https://github.com/dkapanidis/talos/pull/7";
    expect(extractRepoSlugs(text)).toEqual(["harbur/ray-app", "dkapanidis/talos"]);
  });

  test("ignores non-repository github URLs", () => {
    expect(extractRepoSlugs("https://github.com/orgs/harbur/projects/3")).toEqual([]);
    expect(extractRepoSlugs("https://github.com/settings/tokens")).toEqual([]);
  });

  test("returns nothing for text with no repo links", () => {
    expect(extractRepoSlugs("Create an FAQ page, see the design in Figma")).toEqual([]);
  });
});

describe("memoryKey", () => {
  test("is stable regardless of label order or case", () => {
    expect(memoryKey("RAY", ["Component:UI", "bug"])).toBe(memoryKey("RAY", ["bug", "component:ui"]));
  });

  test("separates different teams", () => {
    expect(memoryKey("RAY", ["bug"])).not.toBe(memoryKey("OPS", ["bug"]));
  });

  test("separates different label sets on one team", () => {
    expect(memoryKey("RAY", ["app:talos"])).not.toBe(memoryKey("RAY", ["component:api"]));
  });

  test("handles an issue with no team and no labels", () => {
    expect(memoryKey(undefined, [])).toBe("-|");
  });
});

describe("RepoMemory", () => {
  test("remembers a choice across instances", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "talos-repos-")), "repos.json");
    const key = memoryKey("RAY", ["app:talos"]);

    await new RepoMemory(new FileRecordStore(path)).set(key, "dkapanidis/talos");
    expect(await new RepoMemory(new FileRecordStore(path)).get(key)).toBe("dkapanidis/talos");
  });

  test("returns null for a combination never chosen", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "talos-repos-")), "repos.json");
    expect(await new RepoMemory(new FileRecordStore(path)).get(memoryKey("RAY", []))).toBeNull();
  });

  test("a later choice replaces an earlier one for the same key", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "talos-repos-")), "repos.json");
    const memory = new RepoMemory(new FileRecordStore(path));
    const key = memoryKey("RAY", []);
    await memory.set(key, "harbur/ray-app");
    await memory.set(key, "dkapanidis/talos");
    expect(await memory.get(key)).toBe("dkapanidis/talos");
  });

  test("keeps unrelated keys when writing", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "talos-repos-")), "repos.json");
    const memory = new RepoMemory(new FileRecordStore(path));
    await memory.set(memoryKey("RAY", ["app:talos"]), "dkapanidis/talos");
    await memory.set(memoryKey("RAY", ["component:api"]), "harbur/ray-app");
    expect(await memory.get(memoryKey("RAY", ["app:talos"]))).toBe("dkapanidis/talos");
  });

  test("survives a store that cannot be read", async () => {
    const memory = new RepoMemory(new NullRecordStore());
    expect(await memory.get(memoryKey("RAY", []))).toBeNull();
  });
});

describe("RepoDiscovery", () => {
  test("lists non-archived repos and caches the result", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify([
          { full_name: "harbur/ray-app", archived: false, pushed_at: "2026-08-31T00:00:00Z" },
          { full_name: "harbur/old-thing", archived: true, pushed_at: "2020-01-01T00:00:00Z" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const discovery = new RepoDiscovery("ghp_test");
      expect(await discovery.list()).toEqual(["harbur/ray-app"]);
      expect(await discovery.list()).toEqual(["harbur/ray-app"]);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns nothing without a token rather than calling GitHub", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    try {
      expect(await new RepoDiscovery("").list()).toEqual([]);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns an empty list when GitHub rejects the token", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"message":"Bad credentials"}', { status: 401 })) as typeof fetch;

    try {
      expect(await new RepoDiscovery("ghp_bad").list()).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
