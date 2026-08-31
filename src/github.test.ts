import { describe, test, expect } from "bun:test";
import crypto from "crypto";
import {
  branchNameFor,
  commandsAgent,
  isBotActor,
  mentionsAgent,
  redactTokens,
  triggersAgent,
  verifyGitHubSignature,
  GitHubApp,
} from "./github.js";

describe("verifyGitHubSignature", () => {
  const secret = "s3cret";
  const body = '{"action":"created"}';
  const good = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

  test("accepts a correct signature", () => {
    expect(verifyGitHubSignature(secret, body, good)).toBe(true);
  });

  test("rejects the wrong secret, the wrong body, and a malformed header", () => {
    expect(verifyGitHubSignature("other", body, good)).toBe(false);
    expect(verifyGitHubSignature(secret, '{"action":"deleted"}', good)).toBe(false);
    expect(verifyGitHubSignature(secret, body, "sha256=short")).toBe(false);
    expect(verifyGitHubSignature(secret, body, "")).toBe(false);
  });

  test("rejects a bare digest without the sha256= prefix GitHub sends", () => {
    const bare = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyGitHubSignature(secret, body, bare)).toBe(false);
  });
});

describe("mentionsAgent", () => {
  test("matches a mention anywhere in the comment", () => {
    expect(mentionsAgent("@talos please fix the build", "talos")).toBe(true);
    expect(mentionsAgent("hey @talos can you look?", "talos")).toBe(true);
    expect(mentionsAgent("cc @talos", "talos")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(mentionsAgent("@Talos help", "talos")).toBe(true);
  });

  test("does not match a longer name that merely starts the same", () => {
    expect(mentionsAgent("@talosbot help", "talos")).toBe(false);
  });

  test("does not match the bare word without an @", () => {
    expect(mentionsAgent("talos should do this", "talos")).toBe(false);
  });

  test("does not match inside a URL path", () => {
    expect(mentionsAgent("see https://example.com/@talos/readme", "talos")).toBe(false);
  });

  test("never matches when no mention name is configured", () => {
    expect(mentionsAgent("@talos hi", "")).toBe(false);
  });
});

describe("isBotActor", () => {
  test("recognises bots by type and by login suffix", () => {
    expect(isBotActor("talos[bot]", "Bot")).toBe(true);
    expect(isBotActor("talos[bot]", undefined)).toBe(true);
    expect(isBotActor("someone", "Bot")).toBe(true);
  });

  test("treats humans as humans", () => {
    expect(isBotActor("dkapanidis", "User")).toBe(false);
    expect(isBotActor(undefined, undefined)).toBe(false);
  });
});

describe("branchNameFor", () => {
  test("builds a slugged branch name", () => {
    expect(branchNameFor(42, "Create FAQ page", "talos")).toBe("talos/issue-42-create-faq-page");
  });

  test("strips punctuation and collapses separators", () => {
    expect(branchNameFor(7, "Fix: the *build* (again)!", "talos")).toBe(
      "talos/issue-7-fix-the-build-again",
    );
  });

  test("truncates a long title without leaving a trailing dash", () => {
    const name = branchNameFor(1, "a".repeat(80), "talos");
    expect(name.length).toBeLessThanOrEqual(70);
    expect(name.endsWith("-")).toBe(false);
  });

  test("still produces a usable branch for an empty or symbol-only title", () => {
    expect(branchNameFor(9, "", "talos")).toBe("talos/issue-9");
    expect(branchNameFor(9, "***", "talos")).toBe("talos/issue-9");
  });
});

describe("GitHubApp", () => {
  const appConfig = {
    appId: "",
    privateKey: "",
    webhookSecret: "",
    mentionName: "harbur-talos",
    commandName: "talos",
    triggerLabel: "talos",
  };

  test("falls back to the personal token when no App is configured", async () => {
    const app = new GitHubApp(appConfig, "ghp_fallback");
    expect(app.configured).toBe(false);
    expect(await app.tokenFor("harbur/ray-app")).toBe("ghp_fallback");
  });

  test("builds a clone URL carrying the token", async () => {
    const app = new GitHubApp(appConfig, "ghp_fallback");
    expect(await app.cloneUrl("harbur/ray-app")).toBe(
      "https://x-access-token:ghp_fallback@github.com/harbur/ray-app.git",
    );
  });

  test("mints and caches an installation token", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const app = new GitHubApp({ ...appConfig, appId: "12345", privateKey: pem });

    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url.toString());
      if (url.toString().endsWith("/installation")) {
        return new Response(JSON.stringify({ id: 99 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          token: "ghs_installation",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      expect(await app.tokenFor("harbur/ray-app")).toBe("ghs_installation");
      // Second call is served from cache: no further HTTP.
      expect(await app.tokenFor("harbur/ray-app")).toBe("ghs_installation");
      expect(calls.length).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back when the App is not installed on the repo", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const app = new GitHubApp({ ...appConfig, appId: "12345", privateKey: pem }, "ghp_fallback");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

    try {
      expect(await app.tokenFor("someone/elsewhere")).toBe("ghp_fallback");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("errors when the App is not installed and there is no fallback", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const app = new GitHubApp({ ...appConfig, appId: "12345", privateKey: pem });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

    try {
      await expect(app.tokenFor("someone/elsewhere")).rejects.toThrow(/not installed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("commandsAgent", () => {
  test("matches a command starting the comment", () => {
    expect(commandsAgent("/talos add tests", "talos")).toBe(true);
  });

  test("matches a command on a later line", () => {
    expect(commandsAgent("Some context.\n/talos add tests", "talos")).toBe(true);
  });

  test("tolerates leading whitespace", () => {
    expect(commandsAgent("  /talos go", "talos")).toBe(true);
  });

  test("does not match mid-sentence, so prose cannot trigger a run", () => {
    expect(commandsAgent("run /talos to start", "talos")).toBe(false);
  });

  test("does not match a URL path or a longer command", () => {
    expect(commandsAgent("https://example.com/talos", "talos")).toBe(false);
    expect(commandsAgent("/talosaurus", "talos")).toBe(false);
  });
});

describe("triggersAgent", () => {
  test("accepts either form", () => {
    expect(triggersAgent("@harbur-talos hi", "harbur-talos", "talos")).toBe(true);
    expect(triggersAgent("/talos hi", "harbur-talos", "talos")).toBe(true);
  });

  test("ignores a comment using neither", () => {
    expect(triggersAgent("looks good", "harbur-talos", "talos")).toBe(false);
  });

  test("does not fire on a bare mention of an unrelated account", () => {
    // @talos is a real GitHub user; only the configured name counts.
    expect(triggersAgent("cc @talos", "harbur-talos", "talos")).toBe(false);
  });
});

describe("redactTokens", () => {
  test("redacts credentials embedded in a clone URL", () => {
    const err =
      "Command failed: git clone https://x-access-token:ghp_AbCdEf123456@github.com/harbur/ray-app /app/work";
    const out = redactTokens(err);
    expect(out).not.toContain("ghp_AbCdEf123456");
    expect(out).toContain("https://***@github.com/harbur/ray-app");
  });

  test("redacts a bare token not attached to a URL", () => {
    expect(redactTokens("token github_pat_11ABCDE_xyz expired")).toBe(
      "token github_pat_*** expired",
    );
  });

  test("leaves text with no credentials alone", () => {
    const msg = "fatal: Authentication failed for 'https://github.com/harbur/ray-app/'";
    expect(redactTokens(msg)).toBe(msg);
  });
});
