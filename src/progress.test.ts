import { describe, test, expect } from "bun:test";
import { GitHubProgress, renderProgressBody, type ProgressClient } from "./progress.js";

function fakeClient() {
  const updates: string[] = [];
  let nextId = 100;
  const client: ProgressClient & { updates: string[]; created: string[] } = {
    updates,
    created: [],
    async createComment(_slug, _number, body) {
      client.created.push(body);
      return nextId++;
    },
    async updateComment(_slug, _id, body) {
      updates.push(body);
    },
  };
  return client;
}

/** Drain the scheduled timers the progress writer sets. */
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("renderProgressBody", () => {
  test("names the branch so the reader can follow along", () => {
    const body = renderProgressBody({ branchName: "talos/issue-4-fix", status: "", steps: [] });
    expect(body).toContain("Working on this");
    expect(body).toContain("`talos/issue-4-fix`");
  });

  test("includes the latest status text", () => {
    const body = renderProgressBody({
      branchName: "b",
      status: "Reading the config loader",
      steps: [],
    });
    expect(body).toContain("Reading the config loader");
  });

  test("lists steps inside a collapsible block", () => {
    const body = renderProgressBody({ branchName: "b", status: "", steps: ["`Read` a.ts"] });
    expect(body).toContain("<details");
    expect(body).toContain("Progress — 1 step");
    expect(body).toContain("- `Read` a.ts");
  });

  test("keeps only the most recent steps and says how many were dropped", () => {
    const steps = Array.from({ length: 20 }, (_, i) => `step-${i}`);
    const body = renderProgressBody({ branchName: "b", status: "", steps });
    expect(body).toContain("step-19");
    expect(body).not.toContain("step-0\n");
    expect(body).toContain("5 earlier steps");
    expect(body).toContain("Progress — 20 steps");
  });
});

describe("GitHubProgress", () => {
  test("posts a starting comment before any work happens", async () => {
    const client = fakeClient();
    const progress = new GitHubProgress(client, "o/r", 1, "talos/issue-1");
    await progress.start();

    expect(client.created).toHaveLength(1);
    expect(client.created[0]).toContain("Working on this");
    expect(client.created[0]).toContain("Starting up…");
  });

  test("coalesces a burst of events into a single edit", async () => {
    const client = fakeClient();
    const progress = new GitHubProgress(client, "o/r", 1, "b", { minIntervalMs: 5 });
    await progress.start();

    for (let i = 0; i < 50; i++) {
      progress.record({ kind: "action", action: "Read", parameter: `file-${i}.ts` });
    }
    await tick(20);

    expect(client.updates).toHaveLength(1);
    // The coalesced edit reflects the last event, not the first.
    expect(client.updates[0]).toContain("file-49.ts");
  });

  test("edits again after the interval has passed", async () => {
    const client = fakeClient();
    const progress = new GitHubProgress(client, "o/r", 1, "b", { minIntervalMs: 5 });
    await progress.start();

    progress.record({ kind: "action", action: "Read", parameter: "a.ts" });
    await tick(20);
    progress.record({ kind: "action", action: "Edit", parameter: "b.ts" });
    await tick(20);

    expect(client.updates.length).toBe(2);
    expect(client.updates[1]).toContain("b.ts");
  });

  test("finish replaces the comment with the result", async () => {
    const client = fakeClient();
    const progress = new GitHubProgress(client, "o/r", 1, "b", { minIntervalMs: 5 });
    await progress.start();
    progress.record({ kind: "action", action: "Read", parameter: "a.ts" });
    await progress.finish("All done — opened #12.");

    expect(client.updates.at(-1)).toBe("All done — opened #12.");
  });

  test("finish cancels a pending edit so the result is not overwritten", async () => {
    const client = fakeClient();
    const progress = new GitHubProgress(client, "o/r", 1, "b", { minIntervalMs: 50 });
    await progress.start();

    progress.record({ kind: "action", action: "Read", parameter: "a.ts" });
    await progress.finish("Final answer.");
    await tick(80);

    expect(client.updates.at(-1)).toBe("Final answer.");
  });

  test("truncates a long tool parameter", async () => {
    const client = fakeClient();
    const progress = new GitHubProgress(client, "o/r", 1, "b", { minIntervalMs: 1 });
    await progress.start();
    progress.record({ kind: "action", action: "Bash", parameter: "x".repeat(500) });
    await tick(20);

    expect(client.updates[0]).toContain("…");
    expect(client.updates[0].length).toBeLessThan(500);
  });

  test("keeps working when the initial comment could not be posted", async () => {
    const client = fakeClient();
    client.createComment = async () => {
      throw new Error("403");
    };
    const progress = new GitHubProgress(client, "o/r", 1, "b", { minIntervalMs: 1 });

    await progress.start();
    progress.record({ kind: "action", action: "Read", parameter: "a.ts" });
    await tick(20);
    await progress.finish("done");

    // No comment id, so nothing to edit — and no throw.
    expect(client.updates).toHaveLength(0);
  });

  test("survives an edit that fails", async () => {
    const client = fakeClient();
    client.updateComment = async () => {
      throw new Error("500");
    };
    const progress = new GitHubProgress(client, "o/r", 1, "b", { minIntervalMs: 1 });
    await progress.start();

    progress.record({ kind: "action", action: "Read", parameter: "a.ts" });
    await tick(20);
    await progress.finish("done");
    expect(true).toBe(true);
  });
});
