import { describe, test, expect } from "bun:test";
import { safeFilename, extensionFromUrlOrType, isAuthError, LinearService } from "./linear.js";

describe("safeFilename", () => {
  test("replaces spaces and special chars with underscores", () => {
    expect(safeFilename("hello world")).toBe("hello_world");
    expect(safeFilename("my file (1)")).toBe("my_file_1");
  });

  test("preserves allowed characters: letters, digits, dots, dashes, underscores", () => {
    expect(safeFilename("my-file_v1.2.txt")).toBe("my-file_v1.2.txt");
  });

  test("trims leading and trailing underscores", () => {
    expect(safeFilename("__hello__")).toBe("hello");
    expect(safeFilename("  spaces  ")).toBe("spaces");
  });

  test("truncates to 80 characters", () => {
    const long = "a".repeat(100);
    expect(safeFilename(long).length).toBe(80);
  });

  test("handles empty string", () => {
    expect(safeFilename("")).toBe("");
  });

  test("handles string with only special chars", () => {
    expect(safeFilename("!!!")).toBe("");
  });
});

describe("extensionFromUrlOrType", () => {
  test("extracts extension from URL pathname", () => {
    expect(extensionFromUrlOrType("https://uploads.linear.app/abc/file.png")).toBe("png");
    expect(extensionFromUrlOrType("https://example.com/document.pdf")).toBe("pdf");
    expect(extensionFromUrlOrType("https://example.com/image.JPEG")).toBe("jpeg");
  });

  test("falls back to content-type when URL has no extension", () => {
    expect(extensionFromUrlOrType("https://example.com/file", "image/jpeg")).toBe("jpeg");
    expect(extensionFromUrlOrType("https://example.com/file", "application/pdf")).toBe("pdf");
  });

  test("handles content-type with parameters", () => {
    expect(extensionFromUrlOrType("https://example.com/f", "text/plain; charset=utf-8")).toBe("plain");
  });

  test("normalizes content-type subtype separators", () => {
    expect(extensionFromUrlOrType("https://example.com/f", "image/svg+xml")).toBe("svg_xml");
  });

  test("returns 'bin' when no extension and no content-type", () => {
    expect(extensionFromUrlOrType("https://example.com/file")).toBe("bin");
    expect(extensionFromUrlOrType("https://example.com/file", null)).toBe("bin");
  });

  test("ignores extensions longer than 8 characters", () => {
    expect(extensionFromUrlOrType("https://example.com/file.toolongext", "image/png")).toBe("png");
  });

  test("handles invalid URL gracefully", () => {
    expect(extensionFromUrlOrType("not-a-url", "image/png")).toBe("png");
    expect(extensionFromUrlOrType("not-a-url")).toBe("bin");
  });
});

describe("isAuthError", () => {
  test("recognises the Linear SDK authentication error shape", () => {
    expect(isAuthError({ type: "AuthenticationLinearError", status: 401 })).toBe(true);
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ errors: [{ type: "AuthenticationError" }] })).toBe(true);
  });

  test("ignores unrelated failures", () => {
    expect(isAuthError({ status: 500 })).toBe(false);
    expect(isAuthError(new Error("network down"))).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError("nope")).toBe(false);
  });
});

describe("LinearService token refresh", () => {
  const baseConfig = {
    linearApiKey: "",
    linearAccessToken: "stale-access",
    linearRefreshToken: "old-refresh",
    linearClientId: "client-id",
    linearClientSecret: "client-secret",
    linearWebhookSecret: "",
    githubToken: "",
    server: { port: 0, host: "127.0.0.1" },
    botUserId: "",
    botMentionName: "",
    workDir: "./work",
    systemPrompt: "",
    repos: {},
    tokenStore: { kind: "none" as const, path: "", secretName: "", namespace: "" },
  };

  function memoryStore() {
    const writes: Array<{ accessToken: string; refreshToken: string }> = [];
    return {
      writes,
      stored: null as { accessToken: string; refreshToken: string } | null,
      async read() {
        return this.stored;
      },
      async write(t: { accessToken: string; refreshToken: string }) {
        writes.push(t);
        this.stored = t;
      },
    };
  }

  test("persists the rotated pair after a refresh", async () => {
    const store = memoryStore();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    try {
      const service = new LinearService(baseConfig, store);
      await service.refreshAccessToken();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(store.writes).toEqual([{ accessToken: "new-access", refreshToken: "new-refresh" }]);
  });

  test("collapses concurrent refreshes into one token exchange", async () => {
    const store = memoryStore();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const service = new LinearService(baseConfig, store);
      await Promise.all([
        service.refreshAccessToken(),
        service.refreshAccessToken(),
        service.refreshAccessToken(),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toBe(1);
  });

  test("init adopts persisted tokens over the ones in config", async () => {
    const store = memoryStore();
    store.stored = { accessToken: "persisted-access", refreshToken: "persisted-refresh" };

    const service = new LinearService(baseConfig, store);
    await service.init();

    // The adopted refresh token is the one sent to Linear on the next exchange.
    const originalFetch = globalThis.fetch;
    let sentRefreshToken: string | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentRefreshToken = new URLSearchParams(init.body as string).get("refresh_token");
      return new Response(JSON.stringify({ access_token: "a", refresh_token: "r" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      await service.refreshAccessToken();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(sentRefreshToken).toBe("persisted-refresh");
  });
});
