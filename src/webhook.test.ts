import { describe, test, expect } from "bun:test";
import crypto from "crypto";
import { createServer, signatureMatches } from "./webhook.js";
import type { Config } from "./config.js";

const SECRET = "test-webhook-secret";

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
    tokenStore: { kind: "none", path: "", secretName: "", namespace: "" },
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
