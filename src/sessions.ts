import type { RecordStore } from "./tokens.js";

/** A run that has started and not yet reported a terminal activity. */
export interface OpenSession {
  issueId: string;
  /** Absent for runs triggered by a plain comment rather than an agent session. */
  agentSessionId?: string;
  identifier?: string;
  startedAt: string;
}

/** What a caller needs in order to close a session out. */
export interface SessionReporter {
  postActivity(
    agentSessionId: string,
    input: { type: "thought" | "response" | "error"; body: string },
  ): Promise<void>;
  postComment(issueId: string, body: string): Promise<void>;
}

/** The key a session is tracked under: its own id, or the issue's. */
export function sessionKey(issueId: string, agentSessionId?: string): string {
  return agentSessionId ?? `issue:${issueId}`;
}

export const INTERRUPTED_MESSAGE =
  "Talos restarted while this run was in progress, so it stopped early. " +
  "Anything already committed is on the branch — mention @talos again to pick it up.";

/**
 * Tracks in-flight runs, and remembers them somewhere durable.
 *
 * Linear ends an agent session on a terminal activity — a `response` or an
 * `error`. A session that never gets one is not marked complete or failed; it
 * sits in a working state until Linear gives up and marks it stale. So every
 * run has to be closed out, including the ones this process does not get to
 * finish.
 *
 * A graceful stop can report on its way out. A SIGKILL — an OOM, or a grace
 * period that ran out — cannot, which is what the durable record is for: the
 * next process reads it, finds the sessions its predecessor never closed, and
 * closes them.
 */
export class SessionRegistry {
  private open = new Map<string, OpenSession>();

  constructor(private store: RecordStore) {}

  async begin(session: OpenSession): Promise<void> {
    this.open.set(sessionKey(session.issueId, session.agentSessionId), session);
    await this.persist();
  }

  async end(issueId: string, agentSessionId?: string): Promise<void> {
    this.open.delete(sessionKey(issueId, agentSessionId));
    await this.persist();
  }

  /** Runs this process started and has not closed out. */
  list(): OpenSession[] {
    return [...this.open.values()];
  }

  /**
   * Sessions left open by a previous process, cleared from the store as they
   * are handed over. Call once at startup, before any new run is recorded.
   */
  async takeOrphans(): Promise<OpenSession[]> {
    const record = await this.store.read().catch(() => null);
    if (!record) return [];
    const orphans: OpenSession[] = [];
    for (const value of Object.values(record)) {
      try {
        orphans.push(JSON.parse(value) as OpenSession);
      } catch {
        // A malformed entry is not worth failing startup over.
      }
    }
    if (orphans.length) await this.store.write({}).catch(() => {});
    return orphans;
  }

  /**
   * Post a terminal activity for each session, so none is left to go stale.
   * Best-effort per session: one failing must not strand the rest, and this
   * runs on the way out of the process.
   */
  async closeOut(sessions: OpenSession[], reporter: SessionReporter): Promise<void> {
    await Promise.allSettled(
      sessions.map(async (s) => {
        try {
          if (s.agentSessionId) {
            await reporter.postActivity(s.agentSessionId, {
              type: "error",
              body: INTERRUPTED_MESSAGE,
            });
          } else {
            await reporter.postComment(s.issueId, INTERRUPTED_MESSAGE);
          }
        } catch (err) {
          console.error(`Failed to close out session for ${s.identifier ?? s.issueId}:`, err);
        }
      }),
    );
  }

  private async persist(): Promise<void> {
    const record: Record<string, string> = {};
    for (const [key, session] of this.open) {
      // Secret keys must match [-._a-zA-Z0-9]+, and an issue-scoped key carries
      // a colon.
      record[Buffer.from(key, "utf-8").toString("hex")] = JSON.stringify(session);
    }
    await this.store.write(record).catch((err) => {
      // Losing the record costs recovery after a kill, not the run in progress.
      console.error("Failed to persist open sessions:", err);
    });
  }
}
