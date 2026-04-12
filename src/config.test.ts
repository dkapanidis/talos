import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `talos-test-${Date.now()}.yaml`);
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  test("loads values from YAML file", () => {
    writeFileSync(tmpFile, `
linearApiKey: test-api-key
githubToken: ghp_test
server:
  port: 8080
  host: 127.0.0.1
botUserId: bot-123
botMentionName: talos
workDir: /tmp/work
systemPrompt: "You are a bot"
repos:
  myrepo:
    url: https://github.com/org/repo
`);
    const config = loadConfig(tmpFile);
    expect(config.linearApiKey).toBe("test-api-key");
    expect(config.githubToken).toBe("ghp_test");
    expect(config.server.port).toBe(8080);
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.botUserId).toBe("bot-123");
    expect(config.botMentionName).toBe("talos");
    expect(config.workDir).toBe("/tmp/work");
    expect(config.systemPrompt).toBe("You are a bot");
    expect(config.repos["myrepo"].url).toBe("https://github.com/org/repo");
  });

  test("uses default values when fields are missing", () => {
    writeFileSync(tmpFile, `{}`);
    const config = loadConfig(tmpFile);
    expect(config.server.port).toBe(3000);
    expect(config.server.host).toBe("0.0.0.0");
    expect(config.workDir).toBe("./work");
    expect(config.systemPrompt).toBe("");
    expect(config.repos).toEqual({});
  });

  test("falls back to environment variables", () => {
    writeFileSync(tmpFile, `{}`);
    const originalKey = process.env.LINEAR_API_KEY;
    const originalToken = process.env.GH_TOKEN;
    try {
      process.env.LINEAR_API_KEY = "env-linear-key";
      process.env.GH_TOKEN = "env-gh-token";
      const config = loadConfig(tmpFile);
      expect(config.linearApiKey).toBe("env-linear-key");
      expect(config.githubToken).toBe("env-gh-token");
    } finally {
      if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalKey;
      if (originalToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalToken;
    }
  });

  test("YAML values take precedence over environment variables", () => {
    writeFileSync(tmpFile, `linearApiKey: yaml-key`);
    const original = process.env.LINEAR_API_KEY;
    try {
      process.env.LINEAR_API_KEY = "env-key";
      const config = loadConfig(tmpFile);
      expect(config.linearApiKey).toBe("yaml-key");
    } finally {
      if (original === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = original;
    }
  });

  test("loads repo config with optional fields", () => {
    writeFileSync(tmpFile, `
repos:
  org/repo:
    url: https://github.com/org/repo
    systemPrompt: "Repo-specific prompt"
    teamIds:
      - TEAM1
    labels:
      - backend
      - api
`);
    const config = loadConfig(tmpFile);
    const repo = config.repos["org/repo"];
    expect(repo.url).toBe("https://github.com/org/repo");
    expect(repo.systemPrompt).toBe("Repo-specific prompt");
    expect(repo.teamIds).toEqual(["TEAM1"]);
    expect(repo.labels).toEqual(["backend", "api"]);
  });
});
