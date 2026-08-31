export interface ProgressEvent {
  kind: "thought" | "action" | "response" | "error";
  body?: string;
  action?: string;
  parameter?: string;
}

/** The subset of the GitHub client this needs, so it can be tested without network. */
export interface ProgressClient {
  createComment(slug: string, number: number, body: string): Promise<number>;
  updateComment(slug: string, commentId: number, body: string): Promise<void>;
}

const MAX_STEPS_SHOWN = 15;
const MAX_PARAMETER_LENGTH = 120;

export interface ProgressOptions {
  /** Minimum gap between edits. GitHub throttles bursts of write requests. */
  minIntervalMs?: number;
  now?: () => number;
}

/**
 * A live-updating status comment.
 *
 * GitHub has no streaming surface for issues, so "live" means one comment that
 * is rewritten as the run proceeds — the same shape GitHub's own bots use. Edits
 * are throttled and coalesced: an agent emits events far faster than a comment
 * should be rewritten, and bursts of writes hit secondary rate limits.
 */
export class GitHubProgress {
  private commentId: number | null = null;
  private steps: string[] = [];
  private latest = "";
  private lastWriteAt = 0;
  private pending = false;
  private inFlight: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private minIntervalMs: number;
  private now: () => number;

  constructor(
    private client: ProgressClient,
    private slug: string,
    private issueNumber: number,
    private branchName: string,
    options: ProgressOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Post the initial "working on it" comment. Failure here is not fatal. */
  async start(): Promise<void> {
    try {
      this.commentId = await this.client.createComment(
        this.slug,
        this.issueNumber,
        this.render("Starting up…"),
      );
      this.lastWriteAt = this.now();
    } catch (err) {
      console.error("Failed to post the initial progress comment:", err);
    }
  }

  record(event: ProgressEvent): void {
    if (event.kind === "action") {
      const parameter = (event.parameter ?? "").replace(/\s+/g, " ").trim();
      const truncated =
        parameter.length > MAX_PARAMETER_LENGTH
          ? `${parameter.slice(0, MAX_PARAMETER_LENGTH)}…`
          : parameter;
      this.steps.push(`\`${event.action ?? "tool"}\`${truncated ? ` ${truncated}` : ""}`);
    } else if (event.body?.trim()) {
      this.latest = event.body.trim();
      if (event.kind === "thought") this.steps.push(`_${firstLine(event.body)}_`);
    }
    this.schedule();
  }

  /** Replace the status comment with the final result. */
  async finish(result: string): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = false;
    await this.inFlight.catch(() => {});
    if (this.commentId === null) return;
    await this.client
      .updateComment(this.slug, this.commentId, result)
      .catch((err) => console.error("Failed to post the final result:", err));
  }

  private schedule(): void {
    if (this.commentId === null || this.pending) return;
    const elapsed = this.now() - this.lastWriteAt;
    const wait = Math.max(0, this.minIntervalMs - elapsed);
    this.pending = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = false;
      this.inFlight = this.flush();
    }, wait);
    // Never hold the process open for a status edit.
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.commentId === null) return;
    this.lastWriteAt = this.now();
    await this.client
      .updateComment(this.slug, this.commentId, this.render())
      .catch((err) => console.error("Failed to update the progress comment:", err));
  }

  private render(status?: string): string {
    return renderProgressBody({
      branchName: this.branchName,
      status: status ?? this.latest,
      steps: this.steps,
    });
  }
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0];
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

export function renderProgressBody(input: {
  branchName: string;
  status: string;
  steps: string[];
}): string {
  const { branchName, status, steps } = input;
  const shown = steps.slice(-MAX_STEPS_SHOWN);
  const hidden = steps.length - shown.length;

  const lines = [`### 🔄 Working on this…`, "", `Branch \`${branchName}\`.`];
  if (status.trim()) lines.push("", status.trim());

  if (shown.length) {
    lines.push(
      "",
      `<details open><summary>Progress — ${steps.length} step${steps.length === 1 ? "" : "s"}</summary>`,
      "",
      ...(hidden > 0 ? [`_…${hidden} earlier step${hidden === 1 ? "" : "s"}_`, ""] : []),
      ...shown.map((s) => `- ${s}`),
      "",
      "</details>",
    );
  }

  return lines.join("\n");
}
