import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { LinearClient } from "@linear/sdk";
import type { IssueContext } from "./agent.js";
import type { Config, RepoConfig } from "./config.js";

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function extensionFromUrlOrType(url: string, contentType?: string | null): string {
  try {
    const path = new URL(url).pathname;
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext && /^[a-z0-9]{1,8}$/.test(ext)) return ext;
  } catch { /* ignore invalid URL */ }
  if (contentType) {
    const sub = contentType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
    if (sub && /^[a-z0-9.+-]{1,16}$/.test(sub)) return sub.replace(/[+.]/g, "_");
  }
  return "bin";
}

export class LinearService {
  private client: LinearClient;
  private config: Config;
  private accessToken: string;
  private refreshToken: string;

  constructor(config: Config) {
    this.config = config;
    this.accessToken = config.linearAccessToken;
    this.refreshToken = config.linearRefreshToken;
    this.client = this.accessToken
      ? new LinearClient({ accessToken: this.accessToken })
      : new LinearClient({ apiKey: config.linearApiKey });
  }

  /** Refresh the OAuth access token using the stored refresh token. */
  async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken || !this.config.linearClientId || !this.config.linearClientSecret) {
      throw new Error("Cannot refresh: refreshToken, clientId, or clientSecret missing from config");
    }
    const body = new URLSearchParams({
      client_id: this.config.linearClientId,
      client_secret: this.config.linearClientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Linear token refresh failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token: string; refresh_token?: string };
    this.accessToken = data.access_token;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    this.client = new LinearClient({ accessToken: this.accessToken });
  }

  /** Resolve an issue ID into the context needed by the agent. */
  async getIssueContext(issueId: string): Promise<IssueContext> {
    const issue = await this.client.issue(issueId);
    const comments = await issue.comments();

    return {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      branchName: issue.branchName,
      url: issue.url,
      labels: (await issue.labels()).nodes.map((l) => l.name),
      comments: comments.nodes.map((c) => c.body),
    };
  }

  /**
   * Download every user-uploaded file referenced on the issue. Linear stores
   * uploads on `uploads.linear.app` and embeds them in the description and
   * comment markdown — it has no dedicated "issue files" endpoint, so we
   * scrape the URLs out of the text fields and download each one.
   */
  async downloadIssueAttachments(
    issueId: string,
    destDir: string,
  ): Promise<Array<{ path: string; title?: string }>> {
    const issue = await this.client.issue(issueId);
    const comments = await issue.comments();
    const texts = [issue.description ?? "", ...comments.nodes.map((c) => c.body ?? "")];

    const urlRe = /https?:\/\/uploads\.linear\.app\/[^\s)\]"']+/g;
    const urls = Array.from(new Set(texts.flatMap((t) => t.match(urlRe) ?? [])));
    if (urls.length === 0) return [];

    mkdirSync(destDir, { recursive: true });
    const auth = this.accessToken
      ? `Bearer ${this.accessToken}`
      : this.config.linearApiKey || "";

    const results: Array<{ path: string; title?: string }> = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const res = await fetch(url, { headers: auth ? { Authorization: auth } : {} });
        if (!res.ok) {
          console.error(`Failed to download ${url}: ${res.status}`);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const ext = extensionFromUrlOrType(url, res.headers.get("content-type"));
        const urlBase = (() => {
          try {
            const p = new URL(url).pathname;
            const last = p.split("/").filter(Boolean).pop() ?? "";
            return last.replace(/\.[^.]+$/, "");
          } catch {
            return "";
          }
        })();
        const base = safeFilename(urlBase) || `attachment-${i + 1}`;
        const filename = base.endsWith(`.${ext}`) ? base : `${base}.${ext}`;
        const fullPath = join(destDir, filename);
        writeFileSync(fullPath, buf);
        results.push({ path: fullPath });
      } catch (err) {
        console.error(`Error downloading ${url}:`, err);
      }
    }
    return results;
  }

  /**
   * Find which repo config matches this issue.
   *
   * 1. Filter to repos whose `teamIds` include the issue's team key. Repos
   *    without `teamIds` are treated as applicable to any team and are
   *    included in this scope.
   * 2. Within that team scope, narrow to repos that have at least one
   *    matching label. If none match, keep the full team scope.
   * 3. If the resulting set has exactly one repo, return it. If it has
   *    several, return them as `candidates` for elicitation. If it's empty,
   *    fall back to the single configured repo or `null`.
   */
  async resolveRepo(
    issueId: string,
  ): Promise<
    | { slug: string; repoConfig: RepoConfig }
    | { candidates: Array<{ slug: string; repoConfig: RepoConfig }> }
    | null
  > {
    const issue = await this.client.issue(issueId);
    const team = await issue.team;
    const labels = (await issue.labels()).nodes;
    const labelNames = new Set<string>();
    for (const label of labels) {
      const name = label.name.toLowerCase();
      labelNames.add(name);
      const parent = await label.parent;
      if (parent?.name) {
        const parentName = parent.name.toLowerCase();
        labelNames.add(`${parentName}:${name}`);
        labelNames.add(`${parentName}/${name}`);
      }
    }

    const entries = Object.entries(this.config.repos);

    const teamScope = team
      ? entries.filter(([, cfg]) => !cfg.teamIds?.length || cfg.teamIds.includes(team.key))
      : entries;

    const labelScope = teamScope.filter(([, cfg]) =>
      (cfg.labels ?? []).some((l) => labelNames.has(l.toLowerCase())),
    );

    const finalScope = labelScope.length > 0 ? labelScope : teamScope;

    if (finalScope.length === 1) {
      const [slug, repoConfig] = finalScope[0];
      return { slug, repoConfig };
    }
    if (finalScope.length > 1) {
      return { candidates: finalScope.map(([slug, repoConfig]) => ({ slug, repoConfig })) };
    }

    if (entries.length === 1) {
      const [slug, repoConfig] = entries[0];
      return { slug, repoConfig };
    }

    return null;
  }

  /** Post an elicitation activity asking the user to pick a repository. */
  async postRepoSelection(
    agentSessionId: string,
    candidates: Array<{ slug: string; repoConfig: RepoConfig }>,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.client.createAgentActivity as any)({
      agentSessionId,
      content: {
        type: "elicitation",
        body: "Multiple repositories could match this issue. Which one should I work in?",
      },
      signal: "select",
      signalMetadata: {
        options: candidates.map((c) => ({ label: c.slug, value: c.slug })),
      },
    });
  }

  /** Post a comment on a Linear issue. */
  async postComment(issueId: string, body: string): Promise<void> {
    await this.client.createComment({
      issueId,
      body,
    });
  }

  /** Update issue state (e.g., move to "In Progress"). */
  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    await this.client.updateIssue(issueId, { stateId });
  }

  /** Move the issue to the team's first `started` workflow state, if not already started/completed. */
  async moveToInProgress(issueId: string): Promise<void> {
    const issue = await this.client.issue(issueId);
    const currentState = await issue.state;
    if (currentState && (currentState.type === "started" || currentState.type === "completed")) {
      return;
    }
    const team = await issue.team;
    if (!team) return;
    const states = await team.states();
    const started = states.nodes
      .filter((s) => s.type === "started")
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
    if (!started) return;
    await this.client.updateIssue(issueId, { stateId: started.id });
  }

  /** Post an agent activity (thought/action/response/error) to a session. */
  async postActivity(
    agentSessionId: string,
    input:
      | { type: "thought" | "response" | "error"; body: string }
      | { type: "action"; action: string; parameter: string },
  ): Promise<void> {
    let content: Record<string, unknown>;
    if (input.type === "action") {
      if (!input.action.trim()) return;
      content = { type: "action", action: input.action, parameter: input.parameter ?? "" };
    } else {
      if (!input.body.trim()) return;
      content = { type: input.type, body: input.body };
    }
    await this.client.createAgentActivity({ agentSessionId, content });
  }
}
