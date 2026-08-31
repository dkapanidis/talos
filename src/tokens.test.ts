import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileTokenStore, NullTokenStore, createTokenStore } from "./tokens.js";

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
  test("builds a file store", () => {
    const path = join(tmpDir(), "t.json");
    const store = createTokenStore({ kind: "file", path, secretName: "", namespace: "" });
    expect(store).toBeInstanceOf(FileTokenStore);
  });

  test("builds a null store", () => {
    expect(
      createTokenStore({ kind: "none", path: "", secretName: "", namespace: "" }),
    ).toBeInstanceOf(NullTokenStore);
  });

  test("refuses a kubernetes store with no namespace outside a cluster", () => {
    expect(() =>
      createTokenStore({ kind: "kubernetes", path: "", secretName: "s", namespace: "" }),
    ).toThrow(/namespace/);
  });
});
