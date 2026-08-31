import { describe, test, expect } from "bun:test";
import crypto from "crypto";
import { createServer, signatureMatches } from "./webhook.js";
import type { Config } from "./config.js";

const SECRET = "test-webhook-secret";
const GH_SECRET = "test-github-secret";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    linearApiKey: "",
    linearAccessToken: "",
    linearRefreshToken: "",
    linearClientId: "",
    linearClientSecret: "",
    linearWebhookSecret: SECRET,
    githubToken: "",
    server: { port: 0, host: "127.0.0.1" },
    botUserId: "bot-1",
    botMentionName: "talos",
    workDir: "./work",
    systemPrompt: "",
    repos: {},
    tokenStore: { kind: "none", path: "", secretName: "", namespace: "", repoPath: "", repoSecretName: "" },
    github: {
      appId: "",
      privateKey: "",
      webhookSecret: GH_SECRET,
      mentionName: "talos",
      triggerLabel: "talos",
    },
    ...overrides,
  };
}

function sign(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("signatureMatches", () => {
  test("accepts a correct signature", () => {
    const body = '{"action":"create"}';
    expect(signatureMatches(SECRET, body, sign(SECRET, body))).toBe(true);
  });

  test("rejects a signature made with the wrong secret", () => {
    const body = '{"action":"create"}';
    expect(signatureMatches(SECRET, body, sign("other-secret", body))).toBe(false);
  });

  test("rejects a signature over different bytes", () => {
    expect(signatureMatches(SECRET, '{"a":1}', sign(SECRET, '{"a":2}'))).toBe(false);
  });

  test("rejects a malformed signature without throwing on length mismatch", () => {
    expect(signatureMatches(SECRET, "{}", "deadbeef")).toBe(false);
    expect(signatureMatches(SECRET, "{}", "")).toBe(false);
  });
});

describe("POST /webhook signature enforcement", () => {
  const payload = JSON.stringify({
    type: "Issue",
    action: "update",
    data: { id: "issue-1", assigneeId: "bot-1" },
    updatedFrom: { assigneeId: "someone-else" },
  });

  test("rejects a request with no signature header", async () => {
    let handled = false;
    const app = createServer(testConfig(), async () => {
      handled = true;
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(res.statusCode).toBe(401);
    expect(handled).toBe(false);
    await app.close();
  });

  test("rejects a request with a wrong signature", async () => {
    let handled = false;
    const app = createServer(testConfig(), async () => {
      handled = true;
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "linear-signature": sign("nope", payload) },
      payload,
    });

    expect(res.statusCode).toBe(401);
    expect(handled).toBe(false);
    await app.close();
  });

  test("accepts and dispatches a correctly signed request", async () => {
    let handledIssueId: string | undefined;
    const app = createServer(testConfig(), async (issueId) => {
      handledIssueId = issueId;
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "linear-signature": sign(SECRET, payload) },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(handledIssueId).toBe("issue-1");
    await app.close();
  });

  test("verifies against the raw bytes, not a re-serialisation of the parsed body", async () => {
    // Key order and whitespace differ from what JSON.stringify would produce.
    const raw = '{  "action":"update",\n  "type":"Issue",\n  "data":{"id":"issue-2","assigneeId":"bot-1"},"updatedFrom":{"assigneeId":"x"}}';
    let handledIssueId: string | undefined;
    const app = createServer(testConfig(), async (issueId) => {
      handledIssueId = issueId;
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "linear-signature": sign(SECRET, raw) },
      payload: raw,
    });

    expect(res.statusCode).toBe(200);
    expect(handledIssueId).toBe("issue-2");
    await app.close();
  });

  test("skips verification only when no secret is configured", async () => {
    let handled = false;
    const app = createServer(testConfig({ linearWebhookSecret: "" }), async () => {
      handled = true;
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(handled).toBe(true);
    await app.close();
  });
});

describe("POST /github/webhook", () => {
  function ghSign(body: string, secret = GH_SECRET): string {
    return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  }

  function inject(
    app: ReturnType<typeof createServer>,
    event: string,
    payload: unknown,
    signature?: string,
  ) {
    const body = JSON.stringify(payload);
    return app.inject({
      method: "POST",
      url: "/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        ...(signature === undefined ? { "x-hub-signature-256": ghSign(body) } : signature ? { "x-hub-signature-256": signature } : {}),
      },
      payload: body,
    });
  }

  const comment = (body: string, login = "dkapanidis") => ({
    action: "created",
    repository: { full_name: "harbur/ray-app" },
    sender: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
    issue: { number: 12 },
    comment: { body, user: { login } },
  });

  test("rejects an unsigned delivery", async () => {
    let called = false;
    const app = createServer(testConfig(), async () => {}, undefined, async () => {
      called = true;
    });
    const res = await inject(app, "issue_comment", comment("@talos fix it"), "");
    expect(res.statusCode).toBe(401);
    expect(called).toBe(false);
    await app.close();
  });

  test("rejects a wrongly signed delivery", async () => {
    let called = false;
    const app = createServer(testConfig(), async () => {}, undefined, async () => {
      called = true;
    });
    const payload = comment("@talos fix it");
    const res = await inject(app, "issue_comment", payload, ghSign(JSON.stringify(payload), "wrong"));
    expect(res.statusCode).toBe(401);
    expect(called).toBe(false);
    await app.close();
  });

  test("dispatches on a mention in an issue comment", async () => {
    const seen: Array<[string, number, string | undefined]> = [];
    const app = createServer(testConfig(), async () => {}, undefined, async (slug, n, p) => {
      seen.push([slug, n, p]);
    });
    const res = await inject(app, "issue_comment", comment("@talos please fix the build"));
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([["harbur/ray-app", 12, "@talos please fix the build"]]);
    await app.close();
  });

  test("ignores a comment that does not mention the agent", async () => {
    let called = false;
    const app = createServer(testConfig(), async () => {}, undefined, async () => {
      called = true;
    });
    await inject(app, "issue_comment", comment("looks good to me"));
    expect(called).toBe(false);
    await app.close();
  });

  test("ignores its own comments so a run cannot re-trigger itself", async () => {
    let called = false;
    const app = createServer(testConfig(), async () => {}, undefined, async () => {
      called = true;
    });
    await inject(app, "issue_comment", comment("@talos done", "talos[bot]"));
    expect(called).toBe(false);
    await app.close();
  });

  test("dispatches when the trigger label is added", async () => {
    const seen: Array<[string, number]> = [];
    const app = createServer(testConfig(), async () => {}, undefined, async (slug, n) => {
      seen.push([slug, n]);
    });
    await inject(app, "issues", {
      action: "labeled",
      repository: { full_name: "harbur/ray-app" },
      sender: { login: "dkapanidis", type: "User" },
      issue: { number: 5 },
      label: { name: "talos" },
    });
    expect(seen).toEqual([["harbur/ray-app", 5]]);
    await app.close();
  });

  test("ignores an unrelated label", async () => {
    let called = false;
    const app = createServer(testConfig(), async () => {}, undefined, async () => {
      called = true;
    });
    await inject(app, "issues", {
      action: "labeled",
      repository: { full_name: "harbur/ray-app" },
      sender: { login: "dkapanidis", type: "User" },
      issue: { number: 5 },
      label: { name: "bug" },
    });
    expect(called).toBe(false);
    await app.close();
  });

  test("answers the ping GitHub sends when the hook is created", async () => {
    const app = createServer(testConfig(), async () => {}, undefined, async () => {});
    const res = await inject(app, "ping", { zen: "Design for failure." });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
