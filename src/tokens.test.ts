import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  FileRecordStore,
  FileTokenStore,
  NullRecordStore,
  NullTokenStore,
  createRepoMemoryStore,
  createTokenStore,
} from "./tokens.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "talos-tokens-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("FileTokenStore", () => {
  test("round-trips a token pair", async () => {
    const store = new FileTokenStore(join(tmpDir(), "tokens.json"));
    await store.write({ accessToken: "at-1", refreshToken: "rt-1" });
    expect(await store.read()).toEqual({ accessToken: "at-1", refreshToken: "rt-1" });
  });

  test("returns null when the file does not exist", async () => {
    expect(await new FileTokenStore(join(tmpDir(), "missing.json")).read()).toBeNull();
  });

  test("returns null for malformed or incomplete contents", async () => {
    const path = join(tmpDir(), "bad.json");
    writeFileSync(path, "not json");
    expect(await new FileTokenStore(path).read()).toBeNull();

    // A half-written pair is unusable: refreshing needs both halves.
    writeFileSync(path, JSON.stringify({ accessToken: "at-only" }));
    expect(await new FileTokenStore(path).read()).toBeNull();
  });

  test("overwrites a previous pair", async () => {
    const path = join(tmpDir(), "tokens.json");
    const store = new FileTokenStore(path);
    await store.write({ accessToken: "at-1", refreshToken: "rt-1" });
    await store.write({ accessToken: "at-2", refreshToken: "rt-2" });
    expect(await store.read()).toEqual({ accessToken: "at-2", refreshToken: "rt-2" });
  });
});

describe("NullTokenStore", () => {
  test("reads back nothing after a write", async () => {
    const store = new NullTokenStore();
    await store.write({ accessToken: "at", refreshToken: "rt" });
    expect(await store.read()).toBeNull();
  });
});

describe("createTokenStore", () => {
  const base = { path: "", secretName: "", namespace: "", repoPath: "", repoSecretName: "" };

  test("a file-backed store round-trips the token pair", async () => {
    const path = join(tmpDir(), "t.json");
    const store = createTokenStore({ ...base, kind: "file", path });
    await store.write({ accessToken: "at", refreshToken: "rt" });
    expect(await store.read()).toEqual({ accessToken: "at", refreshToken: "rt" });
  });

  test("a 'none' store keeps nothing", async () => {
    const store = createTokenStore({ ...base, kind: "none" });
    await store.write({ accessToken: "at", refreshToken: "rt" });
    expect(await store.read()).toBeNull();
  });

  test("refuses a kubernetes store with no namespace outside a cluster", () => {
    expect(() => createTokenStore({ ...base, kind: "kubernetes", secretName: "s" })).toThrow(
      /namespace/,
    );
  });

  test("repo memory is kept separately from the tokens", async () => {
    const dir = tmpDir();
    const config = {
      ...base,
      kind: "file" as const,
      path: join(dir, "tokens.json"),
      repoPath: join(dir, "repos.json"),
    };
    await createTokenStore(config).write({ accessToken: "at", refreshToken: "rt" });
    await createRepoMemoryStore(config).write({ someKey: "owner/repo" });

    expect(await createTokenStore(config).read()).toEqual({
      accessToken: "at",
      refreshToken: "rt",
    });
    expect(await createRepoMemoryStore(config).read()).toEqual({ someKey: "owner/repo" });
  });
});

describe("FileRecordStore", () => {
  test("keeps only string values", async () => {
    const path = join(tmpDir(), "rec.json");
    const store = new FileRecordStore(path);
    await store.write({ a: "1", b: "2" });
    expect(await store.read()).toEqual({ a: "1", b: "2" });
  });
});

describe("NullRecordStore", () => {
  test("reads back nothing after a write", async () => {
    const store = new NullRecordStore();
    await store.write({ a: "1" });
    expect(await store.read()).toBeNull();
  });
});
