import { readFileSync } from "fs";
import yaml from "js-yaml";

export interface RepoConfig {
  url: string;
  systemPrompt?: string;
  teamIds?: string[];
  /** Issue label names that route an issue to this repo. Matched case-insensitively. */
  labels?: string[];
}

export type TokenStoreKind = "none" | "file" | "kubernetes";

export interface TokenStoreConfig {
  kind: TokenStoreKind;
  /** File path, when kind is "file". */
  path: string;
  /** Secret name for the OAuth pair, when kind is "kubernetes". */
  secretName: string;
  /** File path for remembered repo choices, when kind is "file". */
  repoPath: string;
  /** Secret name for remembered repo choices, when kind is "kubernetes". */
  repoSecretName: string;
  /** Namespace, when kind is "kubernetes". Defaults to the pod's own namespace. */
  namespace: string;
}

export interface GitHubConfig {
  /** Numeric App ID from the GitHub App's settings page. */
  appId: string;
  /** PEM private key generated for the App. */
  privateKey: string;
  /** Webhook secret configured on the App. */
  webhookSecret: string;
  /** Literal @name that triggers the agent in a comment. Defaults to botMentionName. */
  mentionName: string;
  /** Adding this label to an issue triggers the agent — Apps cannot be assignees. */
  triggerLabel: string;
}

export interface Config {
  linearApiKey: string;
  linearAccessToken: string;
  linearRefreshToken: string;
  linearClientId: string;
  linearClientSecret: string;
  linearWebhookSecret: string;
  githubToken: string;
  server: { port: number; host: string };
  botUserId: string;
  botMentionName: string;
  workDir: string;
  systemPrompt: string;
  repos: Record<string, RepoConfig>;
  tokenStore: TokenStoreConfig;
  github: GitHubConfig;
}

export function loadConfig(path: string): Config {
  const raw = yaml.load(readFileSync(path, "utf-8")) as Record<string, unknown>;

  return {
    linearApiKey: (raw.linearApiKey as string) || process.env.LINEAR_API_KEY || "",
    linearAccessToken: (raw.linearAccessToken as string) || process.env.LINEAR_ACCESS_TOKEN || "",
    linearRefreshToken: (raw.linearRefreshToken as string) || process.env.LINEAR_REFRESH_TOKEN || "",
    linearClientId: (raw.linearClientId as string) || process.env.LINEAR_CLIENT_ID || "",
    linearClientSecret: (raw.linearClientSecret as string) || process.env.LINEAR_CLIENT_SECRET || "",
    linearWebhookSecret: (raw.linearWebhookSecret as string) || process.env.LINEAR_WEBHOOK_SECRET || "",
    githubToken: (raw.githubToken as string) || process.env.GH_TOKEN || "",
    server: {
      port: (raw.server as { port?: number })?.port ?? 3000,
      host: (raw.server as { host?: string })?.host ?? "0.0.0.0",
    },
    botUserId: (raw.botUserId as string) || "",
    botMentionName: (raw.botMentionName as string) || "",
    workDir: (raw.workDir as string) || "./work",
    systemPrompt: (raw.systemPrompt as string) || "",
    repos: (raw.repos as Record<string, RepoConfig>) || {},
    tokenStore: loadTokenStoreConfig(raw.tokenStore as Record<string, unknown> | undefined),
    github: loadGitHubConfig(
      raw.github as Record<string, unknown> | undefined,
      (raw.botMentionName as string) || "",
    ),
  };
}

/**
 * Where refreshed OAuth tokens are persisted. Defaults to "none" (in-memory
 * only), which is fine for a local run but means a restart falls back to the
 * tokens in config.yaml — see TokenStore for why that goes stale.
 */
function loadTokenStoreConfig(raw?: Record<string, unknown>): TokenStoreConfig {
  const kind = ((raw?.kind as string) || process.env.TOKEN_STORE_KIND || "none") as TokenStoreKind;
  if (!["none", "file", "kubernetes"].includes(kind)) {
    throw new Error(`Invalid tokenStore.kind "${kind}": expected none, file, or kubernetes`);
  }
  return {
    kind,
    path: (raw?.path as string) || "./.talos-tokens.json",
    secretName: (raw?.secretName as string) || "talos-oauth-tokens",
    repoPath: (raw?.repoPath as string) || "./.talos-repos.json",
    repoSecretName: (raw?.repoSecretName as string) || "talos-repo-memory",
    namespace: (raw?.namespace as string) || process.env.POD_NAMESPACE || "",
  };
}

/** GitHub App credentials and triggers. All optional — omit to disable GitHub. */
function loadGitHubConfig(raw: Record<string, unknown> | undefined, botMentionName: string): GitHubConfig {
  const privateKey =
    (raw?.privateKey as string) || process.env.GITHUB_APP_PRIVATE_KEY || "";
  return {
    appId: String((raw?.appId as string | number) ?? process.env.GITHUB_APP_ID ?? ""),
    // Tolerate \n-escaped PEMs, which is how they survive most secret stores.
    privateKey: privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey,
    webhookSecret: (raw?.webhookSecret as string) || process.env.GITHUB_WEBHOOK_SECRET || "",
    mentionName: (raw?.mentionName as string) || botMentionName,
    triggerLabel: (raw?.triggerLabel as string) || "talos",
  };
}
