import crypto from "crypto";
import type { GitHubConfig } from "./config.js";

const API = "https://api.github.com";

export interface GitHubIssue {
  slug: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  comments: string[];
  isPullRequest: boolean;
}

interface InstallationToken {
  token: string;
  expiresAt: number;
}

/** Base64url without padding, as JWT requires. */
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * A GitHub App identity.
 *
 * An App is not a user, so installing it consumes no seat on a paid plan — the
 * reason to prefer it over a machine account. It authenticates in two steps: a
 * short JWT signed with the App's private key proves which App this is, and
 * that buys a per-installation access token which is what actually touches
 * repositories.
 */
export class GitHubApp {
  private installationTokens = new Map<number, InstallationToken>();
  private installationIds = new Map<string, number>();

  constructor(
    private config: GitHubConfig,
    /** Personal access token used for repos where the App is not installed. */
    private fallbackToken: string = "",
  ) {}

  get configured(): boolean {
    return Boolean(this.config.appId && this.config.privateKey);
  }

  /** Short-lived App JWT. GitHub rejects anything over 10 minutes. */
  private appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({ iat: now - 60, exp: now + 8 * 60, iss: this.config.appId }),
    );
    const signature = crypto
      .createSign("RSA-SHA256")
      .update(`${header}.${payload}`)
      .sign(this.config.privateKey);
    return `${header}.${payload}.${b64url(signature)}`;
  }

  private async installationIdFor(slug: string): Promise<number | null> {
    const cached = this.installationIds.get(slug);
    if (cached) return cached;

    const res = await fetch(`${API}/repos/${slug}/installation`, {
      headers: {
        Authorization: `Bearer ${this.appJwt()}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "talos-agent",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Failed to look up installation for ${slug}: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { id: number };
    this.installationIds.set(slug, data.id);
    return data.id;
  }

  /**
   * An access token for this repo. Installation tokens last an hour, so they
   * are cached and renewed a minute before expiry rather than per request.
   */
  async tokenFor(slug: string): Promise<string> {
    if (!this.configured) return this.fallbackToken;

    const installationId = await this.installationIdFor(slug).catch((err) => {
      console.error(err);
      return null;
    });
    if (!installationId) {
      if (!this.fallbackToken) {
        throw new Error(
          `The talos GitHub App is not installed on ${slug}, and no githubToken fallback is set`,
        );
      }
      console.log(`App not installed on ${slug}, falling back to githubToken`);
      return this.fallbackToken;
    }

    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

    const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.appJwt()}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "talos-agent",
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to mint installation token: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { token: string; expires_at: string };
    this.installationTokens.set(installationId, {
      token: data.token,
      expiresAt: Date.parse(data.expires_at),
    });
    return data.token;
  }

  private async api<T>(slug: string, path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.tokenFor(slug);
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "talos-agent",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  /** Title, body, labels and the comment thread, as the agent prompt needs them. */
  async getIssue(slug: string, number: number): Promise<GitHubIssue> {
    const issue = await this.api<{
      title: string;
      body: string | null;
      html_url: string;
      labels: Array<{ name: string } | string>;
      pull_request?: unknown;
    }>(slug, `/repos/${slug}/issues/${number}`);

    const comments = await this.api<Array<{ body: string | null; user: { login: string } }>>(
      slug,
      `/repos/${slug}/issues/${number}/comments?per_page=100`,
    );

    return {
      slug,
      number,
      title: issue.title,
      body: issue.body ?? "",
      url: issue.html_url,
      labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
      comments: comments.map((c) => `@${c.user.login}: ${c.body ?? ""}`),
      isPullRequest: Boolean(issue.pull_request),
    };
  }

  /** Post a comment, returning its id so it can be edited as work proceeds. */
  async createComment(slug: string, number: number, body: string): Promise<number> {
    const created = await this.api<{ id: number }>(
      slug,
      `/repos/${slug}/issues/${number}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
    return created.id;
  }

  async postComment(slug: string, number: number, body: string): Promise<void> {
    await this.createComment(slug, number, body);
  }

  /** Rewrite an existing comment. The live-progress mechanism: one comment, edited. */
  async updateComment(slug: string, commentId: number, body: string): Promise<void> {
    await this.api(slug, `/repos/${slug}/issues/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
  }

  /** React to a comment — a cheap "seen it" ack, posted before any work starts. */
  async addReaction(slug: string, commentId: number, content = "eyes"): Promise<void> {
    await this.api(slug, `/repos/${slug}/issues/comments/${commentId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  /** Clone URL carrying an installation token, for private repos. */
  async cloneUrl(slug: string): Promise<string> {
    const token = await this.tokenFor(slug);
    return token
      ? `https://x-access-token:${token}@github.com/${slug}.git`
      : `https://github.com/${slug}.git`;
  }
}

/**
 * Verify the `X-Hub-Signature-256` header GitHub sends with every delivery.
 * Same shape as the Linear check: HMAC-SHA256 over the raw body, compared in
 * constant time.
 */
export function verifyGitHubSignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(signature, "utf-8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** A branch name for an issue, in the shape Linear would produce. */
export function branchNameFor(number: number, title: string, prefix: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return `${prefix}/issue-${number}${slug ? `-${slug}` : ""}`;
}

/**
 * Whether a comment @-mentions the agent.
 *
 * Matched as literal text, not as a resolved GitHub mention: an App cannot be
 * mentioned or assigned, but the webhook carries the comment body regardless.
 *
 * Note that GitHub *will* resolve the name if a real account happens to own it,
 * notifying that person — so prefer a mention name nobody holds, or the slash
 * command below, which lives outside the account namespace entirely.
 */
export function mentionsAgent(body: string, mentionName: string): boolean {
  if (!mentionName) return false;
  return new RegExp(`(^|[^\\w/])@${escapeRegex(mentionName)}\\b`, "i").test(body);
}

/**
 * Whether a comment issues the slash command, e.g. "/talos add tests".
 * Must start a line, so it cannot fire from prose or a quoted reply.
 */
export function commandsAgent(body: string, commandName: string): boolean {
  if (!commandName) return false;
  return new RegExp(`^[ \\t]*/${escapeRegex(commandName)}\\b`, "im").test(body);
}

/** Either trigger form. */
export function triggersAgent(body: string, mentionName: string, commandName: string): boolean {
  return mentionsAgent(body, mentionName) || commandsAgent(body, commandName);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bot-authored events, which must never re-trigger the agent. */
export function isBotActor(login: string | undefined, type: string | undefined): boolean {
  if (type === "Bot") return true;
  return Boolean(login && login.endsWith("[bot]"));
}
