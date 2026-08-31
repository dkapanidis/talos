import crypto from "crypto";
import Fastify from "fastify";
import type { Config } from "./config.js";
import { isBotActor, mentionsAgent, verifyGitHubSignature } from "./github.js";

export interface LinearWebhookPayload {
  action: string;
  type: string;
  data?: {
    id: string;
    identifier?: string;
    title?: string;
    assigneeId?: string;
    delegateId?: string | null;
    labelIds?: string[];
    body?: string;
    userId?: string;
    issue?: { id: string; identifier?: string };
    [key: string]: unknown;
  };
  agentSession?: {
    id: string;
    issue?: { id: string; identifier?: string };
    [key: string]: unknown;
  };
  agentActivity?: {
    id?: string;
    body?: string;
    signal?: string;
    content?: { type?: string; body?: string; signal?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  updatedFrom?: {
    assigneeId?: string;
    delegateId?: string | null;
    labelIds?: string[];
    [key: string]: unknown;
  };
}

type IssueHandler = (
  issueId: string,
  agentSessionId?: string,
  userPrompt?: string,
) => Promise<void>;
type CancelHandler = (agentSessionId: string) => void;

/** Triggered by a GitHub comment or label, rather than a Linear event. */
export type GitHubIssueHandler = (
  repoSlug: string,
  issueNumber: number,
  userPrompt?: string,
) => Promise<void>;

interface GitHubWebhookPayload {
  action?: string;
  repository?: { full_name?: string };
  sender?: { login?: string; type?: string };
  issue?: { number?: number; pull_request?: unknown };
  pull_request?: { number?: number };
  comment?: { body?: string; user?: { login?: string; type?: string } };
  label?: { name?: string };
}

/**
 * Constant-time hex digest comparison. Returns false on any length mismatch,
 * which `timingSafeEqual` throws on.
 */
export function signatureMatches(secret: string, rawBody: string, signature: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(signature, "utf-8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createServer(
  config: Config,
  onIssueAssigned: IssueHandler,
  onCancel?: CancelHandler,
  onGitHubIssue?: GitHubIssueHandler,
) {
  const app = Fastify({ logger: true });

  // Keep the exact bytes Linear signed. Re-serialising the parsed object is not
  // guaranteed to reproduce them, and any difference fails verification.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body: string, done) => {
      (req as unknown as { rawBody: string }).rawBody = body;
      try {
        done(null, body === "" ? {} : JSON.parse(body));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post("/webhook", async (request, reply) => {
    // Verify the webhook signature. The endpoint is public, so an unsigned or
    // wrongly signed request must be rejected outright rather than falling
    // through to the handlers below — they start agent runs with real
    // credentials.
    if (config.linearWebhookSecret) {
      const signature = request.headers["linear-signature"] as string | undefined;
      if (!signature) {
        request.log.warn("Rejecting webhook with no linear-signature header");
        return reply.status(401).send({ error: "Missing signature" });
      }
      const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? "";
      if (!signatureMatches(config.linearWebhookSecret, rawBody, signature)) {
        request.log.warn("Rejecting webhook with an invalid signature");
        return reply.status(401).send({ error: "Invalid signature" });
      }
    } else {
      request.log.warn(
        "linearWebhookSecret is not set — accepting webhooks without signature verification",
      );
    }

    const payload = request.body as LinearWebhookPayload;

    app.log.info(
      { type: payload.type, action: payload.action, payload },
      "Linear webhook received",
    );

    // Agent API: AgentSessionEvent fires when the agent is assigned or prompted
    if (payload.type === "AgentSessionEvent") {
      const session = payload.agentSession;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const issueId = session?.issue?.id ?? (payload.data as any)?.issue?.id;
      const sessionId = session?.id;
      const activity = payload.agentActivity;
      const signal = activity?.signal ?? activity?.content?.signal;
      const isStop = payload.action === "prompted" && signal === "stop";

      if (isStop && sessionId) {
        app.log.info({ sessionId, signal, activity }, `Stop requested for agent session ${sessionId}`);
        onCancel?.(sessionId);
      } else if ((payload.action === "created" || payload.action === "prompted") && issueId && sessionId) {
        app.log.info(`Agent session ${payload.action} for issue ${issueId}, starting agent...`);
        const promptBody =
          activity?.body ??
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (typeof activity?.content === "object" ? (activity?.content as any)?.body : undefined);
        onIssueAssigned(issueId, sessionId, promptBody).catch((err) => {
          app.log.error(err, `Failed to handle issue ${issueId}`);
        });
      }
    }

    // Mention in a comment: re-run the agent on the issue
    if (payload.type === "Comment" && payload.action === "create" && payload.data) {
      const data = payload.data;
      const body = data.body ?? "";
      const mentioned =
        config.botMentionName.length > 0 &&
        body.toLowerCase().includes(`@${config.botMentionName.toLowerCase()}`);
      const authoredByBot = data.userId === config.botUserId;
      const issueId = data.issue?.id;

      if (mentioned && !authoredByBot && issueId) {
        app.log.info(`Bot mentioned in comment on ${data.issue?.identifier}, starting agent...`);
        onIssueAssigned(issueId).catch((err) => {
          app.log.error(err, `Failed to handle comment on ${data.issue?.identifier}`);
        });
      }
    }

    // Legacy: plain Issue update webhooks (non-agent installs)
    if (payload.type === "Issue" && payload.action === "update" && payload.data) {
      const data = payload.data;
      const delegatedToBot =
        data.delegateId === config.botUserId &&
        payload.updatedFrom?.delegateId !== config.botUserId;
      const assignedToBot =
        data.assigneeId === config.botUserId &&
        payload.updatedFrom?.assigneeId !== config.botUserId;

      if (delegatedToBot || assignedToBot) {
        app.log.info(
          `Issue ${data.identifier} ${delegatedToBot ? "delegated" : "assigned"} to bot, starting agent...`,
        );
        onIssueAssigned(data.id).catch((err) => {
          app.log.error(err, `Failed to handle issue ${data.identifier}`);
        });
      }
    }

    return reply.status(200).send({ ok: true });
  });

  app.post("/github/webhook", async (request, reply) => {
    // Same rule as the Linear endpoint: this is public, and a delivery starts an
    // agent run with real credentials, so an unverifiable one is rejected.
    if (config.github.webhookSecret) {
      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      if (!signature) {
        request.log.warn("Rejecting GitHub webhook with no x-hub-signature-256 header");
        return reply.status(401).send({ error: "Missing signature" });
      }
      const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? "";
      if (!verifyGitHubSignature(config.github.webhookSecret, rawBody, signature)) {
        request.log.warn("Rejecting GitHub webhook with an invalid signature");
        return reply.status(401).send({ error: "Invalid signature" });
      }
    } else {
      request.log.warn(
        "github.webhookSecret is not set — accepting GitHub webhooks without verification",
      );
    }

    const event = request.headers["x-github-event"] as string | undefined;
    const payload = request.body as GitHubWebhookPayload;
    const slug = payload.repository?.full_name;

    app.log.info({ event, action: payload.action, repo: slug }, "GitHub webhook received");

    if (event === "ping") return reply.status(200).send({ ok: true });
    if (!slug || !onGitHubIssue) return reply.status(200).send({ ok: true });

    // Never react to our own comments, or another bot's: the agent posts its
    // results as a comment, which would otherwise trigger it again.
    if (isBotActor(payload.sender?.login, payload.sender?.type)) {
      return reply.status(200).send({ ok: true });
    }

    // A comment mentioning the agent, on an issue or a pull request.
    if (
      (event === "issue_comment" || event === "pull_request_review_comment") &&
      payload.action === "created"
    ) {
      const body = payload.comment?.body ?? "";
      const number = payload.issue?.number ?? payload.pull_request?.number;
      if (number && mentionsAgent(body, config.github.mentionName)) {
        app.log.info(`Mentioned in ${slug}#${number}, starting agent...`);
        onGitHubIssue(slug, number, body).catch((err) => {
          app.log.error(err, `Failed to handle ${slug}#${number}`);
        });
      }
    }

    // A label standing in for assignment, which GitHub Apps cannot receive.
    if (event === "issues" && payload.action === "labeled") {
      const number = payload.issue?.number;
      const label = payload.label?.name?.toLowerCase();
      if (number && label && label === config.github.triggerLabel.toLowerCase()) {
        app.log.info(`Label ${label} added to ${slug}#${number}, starting agent...`);
        onGitHubIssue(slug, number).catch((err) => {
          app.log.error(err, `Failed to handle ${slug}#${number}`);
        });
      }
    }

    return reply.status(200).send({ ok: true });
  });

  // Health check
  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
