import { spawn } from "child_process";
import type { Config, RepoConfig } from "./config.js";

interface IssueContext {
  title: string;
  description: string;
  branchName: string;
  comments?: string[];
  labels?: string[];
  identifier: string;
  url: string;
  /** Local file paths of attachments downloaded from the issue. */
  attachments?: Array<{ path: string; title?: string }>;
}

interface AgentResult {
  success: boolean;
  /** The agent's closing summary — not the raw stream it arrived in. */
  output: string;
}

export function summarizeToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const pick = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);

  switch (tool) {
    case "Bash":
      return pick("command") ?? "";
    case "Read":
    case "Write":
    case "Edit":
      return pick("file_path") ?? "";
    case "Glob":
      return pick("pattern") ?? "";
    case "Grep":
      return pick("pattern") ?? "";
    case "WebFetch":
      return pick("url") ?? "";
    default: {
      const primary = pick("command") ?? pick("file_path") ?? pick("pattern") ?? pick("url") ?? pick("path");
      if (primary) return primary;
      const str = JSON.stringify(obj);
      return str.length > 500 ? str.slice(0, 500) + "…" : str;
    }
  }
}

export type AgentEventKind = "thought" | "action" | "response" | "error";
export interface AgentEvent {
  kind: AgentEventKind;
  body?: string;
  action?: string;
  parameter?: string;
}

export function buildPrompt(config: Config, repoConfig: RepoConfig | undefined, issue: IssueContext): string {
  const parts: string[] = [];

  // Layer 1: global system prompt
  if (config.systemPrompt) {
    parts.push(config.systemPrompt.trim());
  }

  // Layer 2: per-repo system prompt
  if (repoConfig?.systemPrompt) {
    parts.push("## Repo-specific instructions\n" + repoConfig.systemPrompt.trim());
  }

  // Layer 3: issue context
  const issueSection = [
    `## Task: ${issue.identifier}`,
    `**${issue.title}**`,
    "",
    issue.description || "(no description)",
  ];

  if (issue.labels?.length) {
    issueSection.push("", `Labels: ${issue.labels.join(", ")}`);
  }

  if (issue.comments?.length) {
    issueSection.push("", "### Comments");
    for (const comment of issue.comments) {
      issueSection.push(`- ${comment}`);
    }
  }

  if (issue.attachments?.length) {
    issueSection.push("", "### Attachments");
    issueSection.push(
      "The following files were attached to this issue and downloaded locally. Use the `Read` tool on each path to view them (images, PDFs, text, CSV, etc.).",
    );
    for (const att of issue.attachments) {
      issueSection.push(`- \`${att.path}\`${att.title ? ` — ${att.title}` : ""}`);
    }
  }

  issueSection.push("", `## Git`, `- Work on branch: \`${issue.branchName}\``);
  issueSection.push(`- Issue URL: ${issue.url}`);

  parts.push(issueSection.join("\n"));

  return parts.join("\n\n");
}

export function runAgent(
  config: Config,
  repoConfig: RepoConfig | undefined,
  issue: IssueContext,
  workDir: string,
  onEvent?: (event: AgentEvent) => void,
  abortSignal?: AbortSignal,
  /** Overrides GH_TOKEN for this run — a GitHub App installation token. */
  githubToken?: string,
): Promise<AgentResult> {
  const prompt = buildPrompt(config, repoConfig, issue);

  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve({ success: false, output: "" });
      return;
    }
    // The agent's closing summary, taken from the stream's `result` message.
    // Retaining the whole of stdout instead would grow without bound: under
    // --output-format stream-json --verbose every tool result comes through it,
    // including the full contents of every file the agent reads. A long run on
    // a large repo can put gigabytes through here, and the container also has
    // to hold the agent's own child processes — test runners, builds, nested
    // subagents — inside one memory limit.
    let finalResult = "";
    let buffer = "";

    const emit = (event: AgentEvent) => {
      try {
        onEvent?.(event);
      } catch (err) {
        process.stderr.write(`[agent:${issue.identifier}:emit-err] ${String(err)}\n`);
      }
    };

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        // ignore malformed lines
        return;
      }

      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            emit({ kind: "thought", body: block.text });
          } else if (block.type === "tool_use") {
            const name = block.name ?? "tool";
            const parameter = summarizeToolInput(name, block.input);
            emit({ kind: "action", action: name, parameter });
          }
        }
      } else if (msg.type === "result") {
        if (msg.is_error) {
          emit({ kind: "error", body: typeof msg.result === "string" ? msg.result : "Agent errored" });
        } else if (typeof msg.result === "string" && msg.result.trim()) {
          finalResult = msg.result;
          emit({ kind: "response", body: msg.result });
        }
      }
    };

    const proc = spawn(
      "claude",
      [
        "--print",
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        prompt,
      ],
      {
        cwd: workDir,
        env: (() => {
          const env: Record<string, string | undefined> = {
            ...process.env,
            GH_TOKEN: githubToken || config.githubToken,
          };
          if (!process.env.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
          return env as NodeJS.ProcessEnv;
        })(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );

    const killTree = (signal: NodeJS.Signals) => {
      if (!proc.pid) return;
      try {
        process.kill(-proc.pid, signal);
      } catch {
        try { proc.kill(signal); } catch { /* ignore */ }
      }
    };

    const onAbort = () => {
      emit({ kind: "thought", body: "Stop requested — halting agent." });
      killTree("SIGTERM");
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) killTree("SIGKILL");
      }, 2000).unref();
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      process.stderr.write(`[agent:${issue.identifier}:err] ${data.toString()}`);
    });

    proc.on("close", (code) => {
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      if (buffer.trim()) handleLine(buffer);
      resolve({
        success: code === 0,
        output: finalResult,
      });
    });
  });
}

export type { IssueContext, AgentResult };
