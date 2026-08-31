import { join, resolve } from "path";
import { runAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { GitManager } from "./git.js";
import { GitHubApp, branchNameFor } from "./github.js";
import { LinearService } from "./linear.js";
import { createServer } from "./webhook.js";

const configPath = process.argv[2] || "config.yaml";
const config = loadConfig(configPath);

const linear = new LinearService(config);
// Adopt any persisted OAuth tokens before serving: the pair in config.yaml is
// only the bootstrap value and is stale after the first refresh.
await linear.init();
const git = new GitManager(resolve(config.workDir), config.githubToken);
const github = new GitHubApp(config.github, config.githubToken);

// Track active sessions to avoid duplicate runs
const activeSessions = new Set<string>();
// Abort controllers keyed by agent session id for cancel requests
const sessionAborts = new Map<string, AbortController>();
// Issues awaiting a repo selection from the user.
// The memory key travels with the candidates so the answer can be remembered.
const pendingRepoSelection = new Map<string, { slugs: string[]; memoryKey: string }>();

function cancelSession(agentSessionId: string): void {
  const ctrl = sessionAborts.get(agentSessionId);
  if (!ctrl) {
    console.log(`No active agent for session ${agentSessionId} to cancel`);
    return;
  }
  console.log(`Cancelling agent for session ${agentSessionId}`);
  ctrl.abort();
}

async function handleIssue(
  issueId: string,
  agentSessionId?: string,
  userPrompt?: string,
): Promise<void> {
  if (activeSessions.has(issueId)) {
    console.log(`Issue ${issueId} already has an active session, skipping`);
    return;
  }
  activeSessions.add(issueId);

  const abortController = new AbortController();
  if (agentSessionId) sessionAborts.set(agentSessionId, abortController);

  const notify = async (event: {
    kind: "thought" | "action" | "response" | "error";
    body?: string;
    action?: string;
    parameter?: string;
  }) => {
    if (agentSessionId) {
      try {
        if (event.kind === "action") {
          await linear.postActivity(agentSessionId, {
            type: "action",
            action: event.action ?? "tool",
            parameter: event.parameter ?? "",
          });
        } else {
          await linear.postActivity(agentSessionId, {
            type: event.kind,
            body: event.body ?? "",
          });
        }
      } catch (err) {
        console.error(`Failed to post ${event.kind} activity:`, err);
      }
    } else if ((event.kind === "response" || event.kind === "error") && event.body) {
      await linear.postComment(issueId, event.body).catch(() => {});
    }
  };

  try {
    let resolved: { slug: string; repoConfig: import("./config.js").RepoConfig } | null = null;

    // If the user is replying to a pending repo-selection elicitation, try to match.
    const pending = pendingRepoSelection.get(issueId);
    if (pending && userPrompt) {
      const prompt = userPrompt.toLowerCase();
      // Match the full slug, or just the repo half of it ("ray-app").
      const pick =
        pending.slugs.find((slug) => prompt.includes(slug.toLowerCase())) ??
        pending.slugs.find((slug) => prompt.includes(slug.split("/")[1].toLowerCase()));
      if (pick) {
        resolved = {
          slug: pick,
          repoConfig: config.repos[pick] ?? { url: `https://github.com/${pick}` },
        };
        pendingRepoSelection.delete(issueId);
        await linear.rememberRepo(pending.memoryKey, pick);
      }
    }

    if (!resolved) {
      const repoMatch = await linear.resolveRepo(issueId);
      if (!repoMatch) {
        console.error(`No repo configured for issue ${issueId}`);
        await notify({ kind: "error", body: "Could not determine which repository to work in for this issue." });
        return;
      }
      if ("candidates" in repoMatch) {
        const slugs = repoMatch.candidates.map((c) => c.slug);
        pendingRepoSelection.set(issueId, { slugs, memoryKey: repoMatch.memoryKey });
        if (agentSessionId) {
          await linear
            .postRepoSelection(agentSessionId, repoMatch.candidates)
            .catch((err) => console.error("Failed to post repo selection:", err));
        } else {
          await notify({
            kind: "response",
            body: `Multiple repos could match this issue: ${slugs.join(", ")}. Reply with the one to use.`,
          });
        }
        return;
      }
      resolved = repoMatch;
    }

    const repoMatch = resolved;

    const issue = await linear.getIssueContext(issueId);
    console.log(`Working on ${issue.identifier}: ${issue.title}`);

    await linear.moveToInProgress(issueId).catch((err) => {
      console.error(`Failed to move ${issue.identifier} to In Progress:`, err);
    });

    const worktreeDir = await git.createWorktree(
      repoMatch.slug,
      repoMatch.repoConfig.url,
      issue.branchName,
    );
    console.log(`Worktree ready at ${worktreeDir}`);

    issue.attachments = await linear
      .downloadIssueAttachments(issueId, join(worktreeDir, ".linear-attachments"))
      .catch((err) => {
        console.error(`Failed to download attachments for ${issue.identifier}:`, err);
        return [];
      });
    if (issue.attachments.length) {
      console.log(`Downloaded ${issue.attachments.length} attachment(s) for ${issue.identifier}`);
    }

    await notify({ kind: "thought", body: `Starting work on branch \`${issue.branchName}\`.` });

    const result = await runAgent(
      config,
      repoMatch.repoConfig,
      issue,
      worktreeDir,
      (event) => {
        notify(event).catch(() => {});
        const preview =
          event.kind === "action"
            ? `${event.action ?? ""} ${event.parameter ?? ""}`
            : event.body ?? "";
        process.stdout.write(`[agent:${issue.identifier}:${event.kind}] ${preview.slice(0, 200)}\n`);
      },
      abortController.signal,
    );

    if (abortController.signal.aborted) {
      await notify({ kind: "response", body: "Agent stopped at user request." });
    } else if (!result.success) {
      await notify({ kind: "error", body: "Agent finished with errors. Manual review needed." });
    }

    await git.cleanupWorktree(repoMatch.slug, issue.branchName);
  } finally {
    activeSessions.delete(issueId);
    if (agentSessionId) sessionAborts.delete(agentSessionId);
  }
}

/**
 * Run the agent for a GitHub issue or pull request. The repo is named by the
 * event, so none of the Linear repo-resolution applies; results are posted back
 * as an issue comment.
 */
async function handleGitHubIssue(
  repoSlug: string,
  issueNumber: number,
  userPrompt?: string,
): Promise<void> {
  const key = `${repoSlug}#${issueNumber}`;
  if (activeSessions.has(key)) {
    console.log(`${key} already has an active session, skipping`);
    return;
  }
  activeSessions.add(key);

  try {
    const issue = await github.getIssue(repoSlug, issueNumber);
    console.log(`Working on ${key}: ${issue.title}`);

    const branchName = branchNameFor(issue.number, issue.title, config.github.mentionName || "talos");
    const token = await github.tokenFor(repoSlug);
    const worktreeDir = await git.createWorktree(
      repoSlug,
      `https://github.com/${repoSlug}.git`,
      branchName,
      token,
    );
    console.log(`Worktree ready at ${worktreeDir}`);

    const result = await runAgent(
      config,
      config.repos[repoSlug],
      {
        identifier: key,
        title: issue.title,
        description: issue.body,
        branchName,
        url: issue.url,
        labels: issue.labels,
        // The mention that triggered this run is the instruction to follow.
        comments: userPrompt ? [...issue.comments, userPrompt] : issue.comments,
      },
      worktreeDir,
      (event) => {
        const preview =
          event.kind === "action"
            ? `${event.action ?? ""} ${event.parameter ?? ""}`
            : event.body ?? "";
        process.stdout.write(`[agent:${key}:${event.kind}] ${preview.slice(0, 200)}\n`);
      },
      undefined,
      token,
    );

    const body = result.success
      ? result.output.trim() || "Done."
      : "Agent finished with errors. Manual review needed.";
    await github.postComment(repoSlug, issueNumber, body).catch((err) => {
      console.error(`Failed to comment on ${key}:`, err);
    });

    await git.cleanupWorktree(repoSlug, branchName);
  } catch (err) {
    console.error(`Failed to handle ${key}:`, err);
    await github
      .postComment(repoSlug, issueNumber, `Could not complete this request: ${String(err)}`)
      .catch(() => {});
  } finally {
    activeSessions.delete(key);
  }
}

// Start the server
const app = createServer(config, handleIssue, cancelSession, handleGitHubIssue);

app.listen({ port: config.server.port, host: config.server.host }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Linear agent listening on ${config.server.host}:${config.server.port}`);
});

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down…`);
  for (const [id] of sessionAborts) cancelSession(id);
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
