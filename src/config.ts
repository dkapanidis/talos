import { readFileSync } from "fs";
import yaml from "js-yaml";

export interface RepoConfig {
  url: string;
  systemPrompt?: string;
  teamIds?: string[];
  /** Issue label names that route an issue to this repo. Matched case-insensitively. */
  labels?: string[];
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
  };
}
