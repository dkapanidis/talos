import { describe, test, expect } from "bun:test";
import { SessionRegistry, INTERRUPTED_MESSAGE, sessionKey } from "./sessions.js";
import type { OpenSession, SessionReporter } from "./sessions.js";
import type { RecordStore } from "./tokens.js";

class MemoryStore implements RecordStore {
  record: Record<string, string> | null = null;
  async read(): Promise<Record<string, string> | null> {
    return this.record;
  }
  async write(record: Record<string, string>): Promise<void> {
    this.record = record;
  }
}

class RecordingReporter implements SessionReporter {
  activities: Array<{ sessionId: string; type: string; body: string }> = [];
  comments: Array<{ issueId: string; body: string }> = [];
  constructor(private fail = false) {}
  async postActivity(
    agentSessionId: string,
    input: { type: "thought" | "response" | "error"; body: string },
  ): Promise<void> {
    if (this.fail) throw new Error("linear is down");
    this.activities.push({ sessionId: agentSessionId, type: input.type, body: input.body });
  }
  async postComment(issueId: string, body: string): Promise<void> {
    if (this.fail) throw new Error("linear is down");
    this.comments.push({ issueId, body });
  }
}

const session = (over: Partial<OpenSession> = {}): OpenSession => ({
  issueId: "issue-1",
  agentSessionId: "sess-1",
  identifier: "RAY-1",
  startedAt: "2026-08-31T12:00:00.000Z",
  ...over,
});

describe("sessionKey", () => {
  test("prefers the agent session id", () => {
    expect(sessionKey("issue-1", "sess-1")).toBe("sess-1");
  });

  test("falls back to the issue for comment-triggered runs", () => {
    expect(sessionKey("issue-1")).toBe("issue:issue-1");
  });
});

describe("tracking open runs", () => {
  test("lists a run between begin and end", async () => {
    const reg = new SessionRegistry(new MemoryStore());
    await reg.begin(session());
    expect(reg.list()).toHaveLength(1);

    await reg.end("issue-1", "sess-1");

    expect(reg.list()).toEqual([]);
  });

  test("keeps runs on the same issue from different sessions apart", async () => {
    const reg = new SessionRegistry(new MemoryStore());
    await reg.begin(session({ agentSessionId: "sess-1" }));
    await reg.begin(session({ agentSessionId: undefined }));

    expect(reg.list()).toHaveLength(2);
  });

  test("survives a store that cannot be written", async () => {
    const store = new MemoryStore();
    store.write = async () => {
      throw new Error("secret is immutable");
    };
    const reg = new SessionRegistry(store);

    // Recovery is degraded, but the run in progress must not be affected.
    await reg.begin(session());

    expect(reg.list()).toHaveLength(1);
  });
});

describe("takeOrphans", () => {
  test("hands a dead process's open runs to the next one", async () => {
    const store = new MemoryStore();
    const died = new SessionRegistry(store);
    await died.begin(session());
    // No end() — stands in for a SIGKILL.

    const orphans = await new SessionRegistry(store).takeOrphans();

    expect(orphans).toHaveLength(1);
    expect(orphans[0].identifier).toBe("RAY-1");
    expect(orphans[0].agentSessionId).toBe("sess-1");
  });

  test("clears the record so the next restart does not report twice", async () => {
    const store = new MemoryStore();
    await new SessionRegistry(store).begin(session());

    const reg = new SessionRegistry(store);
    expect(await reg.takeOrphans()).toHaveLength(1);
    expect(await new SessionRegistry(store).takeOrphans()).toEqual([]);
  });

  test("finds nothing after a clean shutdown", async () => {
    const store = new MemoryStore();
    const clean = new SessionRegistry(store);
    await clean.begin(session());
    await clean.end("issue-1", "sess-1");

    expect(await new SessionRegistry(store).takeOrphans()).toEqual([]);
  });

  test("returns nothing when the store has never been written", async () => {
    expect(await new SessionRegistry(new MemoryStore()).takeOrphans()).toEqual([]);
  });

  test("skips a malformed entry rather than failing startup", async () => {
    const store = new MemoryStore();
    store.record = { deadbeef: "not json", cafe: JSON.stringify(session()) };

    const orphans = await new SessionRegistry(store).takeOrphans();

    expect(orphans).toHaveLength(1);
  });
});

describe("closeOut", () => {
  test("posts a terminal error activity so the session does not go stale", async () => {
    const reporter = new RecordingReporter();

    await new SessionRegistry(new MemoryStore()).closeOut([session()], reporter);

    expect(reporter.activities).toEqual([
      { sessionId: "sess-1", type: "error", body: INTERRUPTED_MESSAGE },
    ]);
  });

  test("falls back to an issue comment when there is no agent session", async () => {
    const reporter = new RecordingReporter();

    await new SessionRegistry(new MemoryStore()).closeOut(
      [session({ agentSessionId: undefined })],
      reporter,
    );

    expect(reporter.activities).toEqual([]);
    expect(reporter.comments).toEqual([{ issueId: "issue-1", body: INTERRUPTED_MESSAGE }]);
  });

  test("does not strand the rest when one session fails to report", async () => {
    const reporter = new RecordingReporter();
    let calls = 0;
    const original = reporter.postActivity.bind(reporter);
    reporter.postActivity = async (id, input) => {
      if (++calls === 1) throw new Error("linear is down");
      return original(id, input);
    };

    await new SessionRegistry(new MemoryStore()).closeOut(
      [session({ agentSessionId: "sess-1" }), session({ agentSessionId: "sess-2" })],
      reporter,
    );

    expect(reporter.activities.map((a) => a.sessionId)).toEqual(["sess-2"]);
  });

  test("resolves even when every report fails", async () => {
    await new SessionRegistry(new MemoryStore()).closeOut([session()], new RecordingReporter(true));
  });
});
