import { describe, test, expect } from "bun:test";
import { summarizeToolInput, buildPrompt } from "./agent.js";
import type { IssueContext } from "./agent.js";
import type { Config, RepoConfig } from "./config.js";

describe("summarizeToolInput", () => {
  test("extracts command from Bash tool", () => {
    expect(summarizeToolInput("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  test("extracts file_path from Read, Write, and Edit tools", () => {
    expect(summarizeToolInput("Read", { file_path: "/src/index.ts" })).toBe("/src/index.ts");
    expect(summarizeToolInput("Write", { file_path: "/src/new.ts" })).toBe("/src/new.ts");
    expect(summarizeToolInput("Edit", { file_path: "/src/edit.ts" })).toBe("/src/edit.ts");
  });

  test("extracts pattern from Glob and Grep tools", () => {
    expect(summarizeToolInput("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(summarizeToolInput("Grep", { pattern: "import.*from" })).toBe("import.*from");
  });

  test("extracts url from WebFetch tool", () => {
    expect(summarizeToolInput("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
  });

  test("returns empty string for non-object input", () => {
    expect(summarizeToolInput("Bash", null)).toBe("");
    expect(summarizeToolInput("Bash", undefined)).toBe("");
    expect(summarizeToolInput("Bash", "string")).toBe("");
  });

  test("handles unknown tool with primary key fallback", () => {
    expect(summarizeToolInput("UnknownTool", { command: "do something" })).toBe("do something");
    expect(summarizeToolInput("UnknownTool", { file_path: "/some/path" })).toBe("/some/path");
    expect(summarizeToolInput("UnknownTool", { url: "https://example.com" })).toBe("https://example.com");
  });

  test("serializes unknown tool input to JSON when no primary key", () => {
    const result = summarizeToolInput("UnknownTool", { foo: "bar", baz: 42 });
    expect(result).toBe(JSON.stringify({ foo: "bar", baz: 42 }));
  });

  test("truncates long serialized JSON at 500 chars", () => {
    const large = { data: "x".repeat(600) };
    const result = summarizeToolInput("UnknownTool", large);
    expect(result.length).toBe(501); // 500 chars + "…"
    expect(result.endsWith("…")).toBe(true);
  });
});

const baseConfig: Config = {
  linearApiKey: "",
  linearAccessToken: "",
  linearRefreshToken: "",
  linearClientId: "",
  linearClientSecret: "",
  linearWebhookSecret: "",
  githubToken: "",
  server: { port: 3000, host: "0.0.0.0" },
  botUserId: "",
  botMentionName: "",
  workDir: "./work",
  systemPrompt: "",
  repos: {},
};

const baseIssue: IssueContext = {
  identifier: "RAY-1",
  title: "Fix bug",
  description: "Something is broken",
  branchName: "talos/ray-1-fix-bug",
  url: "https://linear.app/raydb/issue/RAY-1",
};

describe("buildPrompt", () => {
  test("includes issue title and description", () => {
    const prompt = buildPrompt(baseConfig, undefined, baseIssue);
    expect(prompt).toContain("## Task: RAY-1");
    expect(prompt).toContain("**Fix bug**");
    expect(prompt).toContain("Something is broken");
  });

  test("includes branch name and issue URL", () => {
    const prompt = buildPrompt(baseConfig, undefined, baseIssue);
    expect(prompt).toContain("talos/ray-1-fix-bug");
    expect(prompt).toContain("https://linear.app/raydb/issue/RAY-1");
  });

  test("shows (no description) when description is empty", () => {
    const issue = { ...baseIssue, description: "" };
    const prompt = buildPrompt(baseConfig, undefined, issue);
    expect(prompt).toContain("(no description)");
  });

  test("includes global system prompt when set", () => {
    const config = { ...baseConfig, systemPrompt: "You are a helpful bot." };
    const prompt = buildPrompt(config, undefined, baseIssue);
    expect(prompt.startsWith("You are a helpful bot.")).toBe(true);
  });

  test("includes repo-specific system prompt", () => {
    const repoConfig: RepoConfig = { url: "https://github.com/org/repo", systemPrompt: "Always use TypeScript." };
    const prompt = buildPrompt(baseConfig, repoConfig, baseIssue);
    expect(prompt).toContain("## Repo-specific instructions");
    expect(prompt).toContain("Always use TypeScript.");
  });

  test("includes labels when present", () => {
    const issue = { ...baseIssue, labels: ["backend", "bug"] };
    const prompt = buildPrompt(baseConfig, undefined, issue);
    expect(prompt).toContain("Labels: backend, bug");
  });

  test("does not include Labels section when labels array is empty", () => {
    const issue = { ...baseIssue, labels: [] };
    const prompt = buildPrompt(baseConfig, undefined, issue);
    expect(prompt).not.toContain("Labels:");
  });

  test("includes comments when present", () => {
    const issue = { ...baseIssue, comments: ["First comment", "Second comment"] };
    const prompt = buildPrompt(baseConfig, undefined, issue);
    expect(prompt).toContain("### Comments");
    expect(prompt).toContain("- First comment");
    expect(prompt).toContain("- Second comment");
  });

  test("includes attachments section with paths", () => {
    const issue = { ...baseIssue, attachments: [{ path: "/tmp/file.png", title: "Screenshot" }] };
    const prompt = buildPrompt(baseConfig, undefined, issue);
    expect(prompt).toContain("### Attachments");
    expect(prompt).toContain("/tmp/file.png");
    expect(prompt).toContain("Screenshot");
  });

  test("attachment without title omits the title suffix", () => {
    const issue = { ...baseIssue, attachments: [{ path: "/tmp/file.bin" }] };
    const prompt = buildPrompt(baseConfig, undefined, issue);
    expect(prompt).toContain("`/tmp/file.bin`");
    expect(prompt).not.toContain("—");
  });

  test("combines global and repo prompts in order", () => {
    const config = { ...baseConfig, systemPrompt: "Global prompt." };
    const repoConfig: RepoConfig = { url: "https://github.com/org/repo", systemPrompt: "Repo prompt." };
    const prompt = buildPrompt(config, repoConfig, baseIssue);
    const globalIdx = prompt.indexOf("Global prompt.");
    const repoIdx = prompt.indexOf("Repo prompt.");
    const issueIdx = prompt.indexOf("## Task:");
    expect(globalIdx).toBeLessThan(repoIdx);
    expect(repoIdx).toBeLessThan(issueIdx);
  });
});
