import crypto from "crypto";
import Fastify from "fastify";
import type { Config } from "./config.js";

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

export function createServer(
  config: Config,
  onIssueAssigned: IssueHandler,
  onCancel?: CancelHandler,
) {
  const app = Fastify({ logger: true });

  app.post("/webhook", async (request, reply) => {
    // Verify webhook signature
    if (config.linearWebhookSecret) {
      const signature = request.headers["linear-signature"] as string;
      if (signature) {
        const body = JSON.stringify(request.body);
        const expected = crypto
          .createHmac("sha256", config.linearWebhookSecret)
          .update(body)
          .digest("hex");
        if (signature !== expected) {
          return reply.status(401).send({ error: "Invalid signature" });
        }
      }
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

  // Health check
  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
