import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { LinearClient } from "@linear/sdk";
import type { IssueContext } from "./agent.js";
import type { Config, RepoConfig } from "./config.js";
import { createRepoMemoryStore, createTokenStore, type TokenStore } from "./tokens.js";
import { RepoDiscovery, RepoMemory, extractRepoSlugs, memoryKey } from "./repos.js";

export function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

export function extensionFromUrlOrType(url: string, contentType?: string | null): string {
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

/** True for the Linear SDK / GraphQL shapes that mean "your token is no good". */
export function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; type?: string; errors?: Array<{ type?: string }> };
  if (e.status === 401) return true;
  if (e.type === "AuthenticationLinearError") return true;
  return (e.errors ?? []).some((inner) => inner?.type === "AuthenticationError");
}

export class LinearService {
  private client: LinearClient;
  private config: Config;
  private accessToken: string;
  private refreshToken: string;
  private store: TokenStore;
  private repoMemory: RepoMemory;
  private repoDiscovery: RepoDiscovery;
  /** De-duplicates concurrent refreshes so parallel issues share one token swap. */
  private refreshing: Promise<void> | null = null;

  constructor(config: Config, store: TokenStore = createTokenStore(config.tokenStore)) {
    this.config = config;
    this.accessToken = config.linearAccessToken;
    this.refreshToken = config.linearRefreshToken;
    this.store = store;
    this.repoMemory = new RepoMemory(createRepoMemoryStore(config.tokenStore));
    this.repoDiscovery = new RepoDiscovery(config.githubToken);
    this.client = this.accessToken
      ? new LinearClient({ accessToken: this.accessToken })
      : new LinearClient({ apiKey: config.linearApiKey });
  }

  /**
   * Adopt persisted tokens, if any. They are newer than config.yaml by
   * definition: the only writer is our own refresh path.
   */
  async init(): Promise<void> {
    if (!this.config.linearAccessToken) return;
    const stored = await this.store.read().catch((err) => {
      console.error("Failed to read persisted Linear tokens:", err);
      return null;
    });
    if (!stored) return;
    this.accessToken = stored.accessToken;
    this.refreshToken = stored.refreshToken;
    this.client = new LinearClient({ accessToken: this.accessToken });
    console.log("Loaded Linear OAuth tokens from the token store");
  }

  /**
   * Run a Linear call, and on an auth failure refresh the token once and retry.
   *
   * Linear OAuth access tokens last 24 hours, so without this every install
   * breaks a day after it is set up.
   */
  private async withAuth<T>(fn: (client: LinearClient) => Promise<T>): Promise<T> {
    try {
      return await fn(this.client);
    } catch (err) {
      if (!isAuthError(err) || !this.canRefresh()) throw err;
      console.log("Linear rejected the access token, refreshing…");
      await this.refreshAccessToken();
      return await fn(this.client);
    }
  }

  private canRefresh(): boolean {
    return Boolean(this.refreshToken && this.config.linearClientId && this.config.linearClientSecret);
  }

  /** Refresh the OAuth access token using the stored refresh token. */
  async refreshAccessToken(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
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
    // Linear rotates the refresh token and invalidates the previous one.
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    this.client = new LinearClient({ accessToken: this.accessToken });

    // Persist before returning: if this write is lost, the rotated refresh
    // token is gone and the next restart cannot recover without a re-install.
    try {
      await this.store.write({ accessToken: this.accessToken, refreshToken: this.refreshToken });
      console.log("Persisted refreshed Linear OAuth tokens");
    } catch (err) {
      console.error("Refreshed Linear tokens but failed to persist them:", err);
    }
  }

  /** Resolve an issue ID into the context needed by the agent. */
  async getIssueContext(issueId: string): Promise<IssueContext> {
    return this.withAuth(async (client) => {
    const issue = await client.issue(issueId);
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
    });
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
    const texts = await this.withAuth(async (client) => {
      const issue = await client.issue(issueId);
      const comments = await issue.comments();
      return [issue.description ?? "", ...comments.nodes.map((c) => c.body ?? "")];
    });

    const urlRe = /https?:\/\/uploads\.linear\.app\/[^\s)\]"']+/g;
    const urls = Array.from(new Set(texts.flatMap((t) => t.match(urlRe) ?? [])));
    if (urls.length === 0) return [];

    mkdirSync(destDir, { recursive: true });
    const authHeader = () =>
      this.accessToken ? `Bearer ${this.accessToken}` : this.config.linearApiKey || "";

    /** Uploads are plain HTTP, not GraphQL, so they need their own 401 retry. */
    const fetchWithAuth = async (url: string): Promise<Response> => {
      const auth = authHeader();
      const res = await fetch(url, { headers: auth ? { Authorization: auth } : {} });
      if (res.status !== 401 || !this.canRefresh()) return res;
      await this.refreshAccessToken();
      const retryAuth = authHeader();
      return fetch(url, { headers: retryAuth ? { Authorization: retryAuth } : {} });
    };

    const results: Array<{ path: string; title?: string }> = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const res = await fetchWithAuth(url);
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

  /** Config for a slug, synthesising the clone URL when it is not configured. */
  private repoConfigFor(slug: string): RepoConfig {
    const configured = this.config.repos[slug];
    return {
      ...configured,
      url: configured?.url || `https://github.com/${slug}`,
    };
  }

  /**
   * Work out which repo an issue belongs to, preferring evidence over config:
   *
   * 1. An explicit `repos` entry whose teamIds/labels single one out.
   * 2. A GitHub repo linked from the issue — Linear's integration attaches the
   *    branch and PR URLs, which name the repo outright.
   * 3. A remembered answer for this team+label combination.
   * 4. Otherwise ask, offering every repo the GitHub token can see. The answer
   *    is remembered, so a given team+label is only ever asked about once.
   */
  async resolveRepo(
    issueId: string,
  ): Promise<
    | { slug: string; repoConfig: RepoConfig }
    | { candidates: Array<{ slug: string; repoConfig: RepoConfig }>; memoryKey: string }
    | null
  > {
    const { team, labelNames, issueLabels, texts } = await this.withAuth(async (client) => {
      const issue = await client.issue(issueId);
      const team = await issue.team;
      const labels = (await issue.labels()).nodes;
      const labelNames = new Set<string>();
      const issueLabels: string[] = [];
      for (const label of labels) {
        const name = label.name.toLowerCase();
        labelNames.add(name);
        issueLabels.push(name);
        const parent = await label.parent;
        if (parent?.name) {
          const parentName = parent.name.toLowerCase();
          labelNames.add(`${parentName}:${name}`);
          labelNames.add(`${parentName}/${name}`);
        }
      }

      const comments = await issue.comments();
      const attachments = await issue.attachments();
      const texts = [
        issue.description ?? "",
        ...comments.nodes.map((c) => c.body ?? ""),
        ...attachments.nodes.map((a) => `${a.url ?? ""} ${a.title ?? ""}`),
      ];

      return { team, labelNames, issueLabels, texts };
    });

    // 1. Explicit configuration still wins when it is unambiguous.
    const entries = Object.entries(this.config.repos);
    const teamScope = team
      ? entries.filter(([, cfg]) => !cfg.teamIds?.length || cfg.teamIds.includes(team.key))
      : entries;
    const labelScope = teamScope.filter(([, cfg]) =>
      (cfg.labels ?? []).some((l) => labelNames.has(l.toLowerCase())),
    );
    if (labelScope.length === 1) {
      const [slug] = labelScope[0];
      return { slug, repoConfig: this.repoConfigFor(slug) };
    }
    const configuredScope = labelScope.length > 0 ? labelScope : teamScope;
    if (configuredScope.length === 1) {
      const [slug] = configuredScope[0];
      return { slug, repoConfig: this.repoConfigFor(slug) };
    }

    // 2. A repo linked from the issue itself is the strongest evidence there is.
    const linked = extractRepoSlugs(texts.join("\n"));
    if (linked.length === 1) {
      console.log(`Inferred repo ${linked[0]} from links on the issue`);
      return { slug: linked[0], repoConfig: this.repoConfigFor(linked[0]) };
    }

    const key = memoryKey(team?.key, issueLabels);

    // 3. Whatever was chosen last time for this team+label combination.
    const remembered = await this.repoMemory.get(key);
    if (remembered) {
      console.log(`Using remembered repo ${remembered} for ${key}`);
      return { slug: remembered, repoConfig: this.repoConfigFor(remembered) };
    }

    // 4. Ask. Prefer a narrowed-down set over the full listing.
    let choices: string[];
    if (linked.length > 1) {
      choices = linked;
    } else if (configuredScope.length > 1) {
      choices = configuredScope.map(([slug]) => slug);
    } else {
      choices = await this.repoDiscovery.list().catch((err) => {
        console.error("Failed to list repos from GitHub:", err);
        return [];
      });
    }

    if (choices.length === 1) {
      return { slug: choices[0], repoConfig: this.repoConfigFor(choices[0]) };
    }
    if (choices.length === 0) return null;

    return {
      candidates: choices.map((slug) => ({ slug, repoConfig: this.repoConfigFor(slug) })),
      memoryKey: key,
    };
  }

  /** Record the repo chosen for a team+label combination so it is not asked again. */
  async rememberRepo(key: string, slug: string): Promise<void> {
    await this.repoMemory.set(key, slug).catch((err) => {
      console.error("Failed to persist repo choice:", err);
    });
  }

  /** Post an elicitation activity asking the user to pick a repository. */
  async postRepoSelection(
    agentSessionId: string,
    candidates: Array<{ slug: string; repoConfig: RepoConfig }>,
  ): Promise<void> {
    await this.withAuth(async (client) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client.createAgentActivity as any)({
      agentSessionId,
      content: {
        type: "elicitation",
        body: "Multiple repositories could match this issue. Which one should I work in?",
      },
      signal: "select",
      signalMetadata: {
        options: candidates.map((c) => ({ label: c.slug, value: c.slug })),
      },
      }),
    );
  }

  /** Post a comment on a Linear issue. */
  async postComment(issueId: string, body: string): Promise<void> {
    await this.withAuth((client) => client.createComment({ issueId, body }));
  }

  /** Update issue state (e.g., move to "In Progress"). */
  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    await this.withAuth((client) => client.updateIssue(issueId, { stateId }));
  }

  /** Move the issue to the team's first `started` workflow state, if not already started/completed. */
  async moveToInProgress(issueId: string): Promise<void> {
    await this.withAuth(async (client) => {
    const issue = await client.issue(issueId);
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
    await client.updateIssue(issueId, { stateId: started.id });
    });
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
    await this.withAuth((client) => client.createAgentActivity({ agentSessionId, content }));
  }
}
