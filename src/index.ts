import { join, resolve } from "path";
import { runAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { GitManager } from "./git.js";
import { GitHubApp, branchNameFor, redactTokens } from "./github.js";
import { GitHubProgress } from "./progress.js";
import { LinearService } from "./linear.js";
import { SessionRegistry, INTERRUPTED_MESSAGE } from "./sessions.js";
import { FileRecordStore } from "./tokens.js";
import { createServer } from "./webhook.js";

const configPath = process.argv[2] || "config.yaml";
const config = loadConfig(configPath);

const linear = new LinearService(config);
// Adopt any persisted OAuth tokens before serving: the pair in config.yaml is
// only the bootstrap value and is stale after the first refresh.
await linear.init();
const git = new GitManager(resolve(config.workDir), config.githubToken);
const github = new GitHubApp(config.github, config.githubToken);
// Kept in the work directory, which is the volume that survives a restart.
const sessions = new SessionRegistry(
  new FileRecordStore(join(resolve(config.workDir), ".talos-sessions.json")),
);

// Track active sessions to avoid duplicate runs
const activeSessions = new Set<string>();
// Abort controllers keyed by agent session id for cancel requests
const sessionAborts = new Map<string, AbortController>();
// Issues awaiting a repo selection from the user.
// The memory key travels with the candidates so the answer can be remembered.
const pendingRepoSelection = new Map<string, { slugs: string[]; memoryKey: string }>();
// In-flight runs, so a shutdown can wait for them to report before exiting.
const inFlight = new Map<string, Promise<void>>();
// Distinguishes a stop the user asked for from one a restart forced.
let shuttingDown = false;

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

  // Set once the worktree exists. The work directory is a persistent volume
  // now, so a worktree not dropped on the failure path leaks disk until the
  // next run on the same branch — cleanup belongs in the finally.
  let cleanup: (() => Promise<void>) | undefined;

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

    // From here the run owns a Linear session that has to be closed out, even
    // if this process does not survive to do it.
    await sessions.begin({
      issueId,
      agentSessionId,
      identifier: issue.identifier,
      startedAt: new Date().toISOString(),
    });

    await linear.moveToInProgress(issueId).catch((err) => {
      console.error(`Failed to move ${issue.identifier} to In Progress:`, err);
    });

    // Clone, push, and the agent's own `gh` calls all go through the App
    // installation token where the App is installed; tokenFor falls back to
    // config.githubToken for repos it does not cover.
    const token = await github.tokenFor(repoMatch.slug);
    const worktreeDir = await git.createWorktree(
      repoMatch.slug,
      repoMatch.repoConfig.url,
      issue.branchName,
      token,
    );
    cleanup = () => git.cleanupWorktree(repoMatch.slug, issue.branchName);
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
      token,
    );

    if (abortController.signal.aborted) {
      await notify(
        shuttingDown
          ? { kind: "error", body: INTERRUPTED_MESSAGE }
          : { kind: "response", body: "Agent stopped at user request." },
      );
    } else if (!result.success) {
      await notify({ kind: "error", body: "Agent finished with errors. Manual review needed." });
    }

  } catch (err) {
    // Without this the run dies in the logs and Linear shows nothing at all,
    // which is indistinguishable from the agent never having been triggered.
    console.error(`Failed to handle issue ${issueId}:`, err);
    await notify({
      kind: "error",
      body: `Could not complete this request: ${redactTokens(String(err))}`,
    }).catch(() => {});
  } finally {
    await cleanup?.().catch((err) => console.error("Failed to clean up worktree:", err));
    await sessions.end(issueId, agentSessionId);
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
  triggerCommentId?: number,
): Promise<void> {
  const key = `${repoSlug}#${issueNumber}`;
  if (activeSessions.has(key)) {
    console.log(`${key} already has an active session, skipping`);
    return;
  }
  activeSessions.add(key);

  // Acknowledge immediately: the run takes minutes, and an unreacted comment
  // looks like nothing happened.
  if (triggerCommentId) {
    await github
      .addReaction(repoSlug, triggerCommentId)
      .catch((err) => console.error(`Failed to react on ${key}:`, err));
  }

  let progress: GitHubProgress | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const issue = await github.getIssue(repoSlug, issueNumber);
    console.log(`Working on ${key}: ${issue.title}`);

    const branchName = branchNameFor(issue.number, issue.title, config.github.mentionName || "talos");
    progress = new GitHubProgress(github, repoSlug, issueNumber, branchName);
    await progress.start();
    const token = await github.tokenFor(repoSlug);
    const worktreeDir = await git.createWorktree(
      repoSlug,
      `https://github.com/${repoSlug}.git`,
      branchName,
      token,
    );
    cleanup = () => git.cleanupWorktree(repoSlug, branchName);
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
        progress?.record(event);
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
    await progress.finish(body);
  } catch (err) {
    console.error(`Failed to handle ${key}:`, err);
    const message = `Could not complete this request: ${redactTokens(String(err))}`;
    if (progress) await progress.finish(message);
    else await github.postComment(repoSlug, issueNumber, message).catch(() => {});
  } finally {
    await cleanup?.().catch((e) => console.error("Failed to clean up worktree:", e));
    activeSessions.delete(key);
  }
}

/** Runs a handler while keeping its promise, so a shutdown can wait on it. */
function tracked<A extends unknown[]>(
  key: string,
  handler: (...args: A) => Promise<void>,
  ...args: A
): Promise<void> {
  const run = handler(...args).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

// Close out anything a previous process was working on when it died. A SIGKILL
// — an OOM, or a grace period that ran out — leaves the Linear session with no
// terminal activity, and it sits in a working state until Linear marks it
// stale. This is the only path that covers that case.
const orphans = await sessions.takeOrphans();
if (orphans.length) {
  console.log(`Closing out ${orphans.length} session(s) left open by a previous run`);
  await sessions.closeOut(orphans, linear);
}

// Start the server
const app = createServer(
  config,
  (issueId, agentSessionId, userPrompt) =>
    tracked(issueId, handleIssue, issueId, agentSessionId, userPrompt),
  cancelSession,
  (slug, number, prompt, commentId) =>
    tracked(`${slug}#${number}`, handleGitHubIssue, slug, number, prompt, commentId),
);

app.listen({ port: config.server.port, host: config.server.host }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Linear agent listening on ${config.server.host}:${config.server.port}`);
});

/**
 * How long to let interrupted runs report before exiting.
 *
 * Kubernetes SIGKILLs at terminationGracePeriodSeconds, 30s by default, so this
 * has to leave room. It is not enough for a run to finish — those take minutes
 * — only for the aborted handlers to unwind and post their terminal activity,
 * which is a couple of API calls.
 */
const DRAIN_MS = 20_000;

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down…`);
  shuttingDown = true;

  // Stop taking new work before stopping the work in progress.
  await app.close().catch((err) => console.error("Failed to close the server:", err));
  for (const [id] of sessionAborts) cancelSession(id);

  // Gated on in-flight runs rather than Linear sessions, so a GitHub-triggered
  // run gets the same window to finish writing its status comment.
  if (inFlight.size) {
    console.log(`Waiting up to ${DRAIN_MS / 1000}s for ${inFlight.size} run(s) to report…`);
    await Promise.race([
      Promise.allSettled([...inFlight.values()]),
      new Promise((resolve) => setTimeout(resolve, DRAIN_MS).unref()),
    ]);
  }

  // Whatever did not manage to report for itself. Without this the session is
  // left with no terminal activity and goes stale rather than failed.
  const stranded = sessions.list();
  if (stranded.length) {
    console.log(`Closing out ${stranded.length} run(s) that did not report in time`);
    await sessions.closeOut(stranded, linear);
  }

  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
