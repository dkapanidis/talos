import type { RecordStore } from "./tokens.js";

/** github.com/<owner>/<repo>, in any of the shapes Linear puts in an issue. */
const GITHUB_REPO_RE =
  /(?:https?:\/\/(?:www\.)?github\.com\/|(?:^|\s)(?:git@github\.com:))([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?)\]\s]|$)/g;

/**
 * Pull repo slugs out of free text — issue descriptions, comments, and the URLs
 * Linear's GitHub integration attaches for linked branches and pull requests.
 */
export function extractRepoSlugs(text: string): string[] {
  const slugs: string[] = [];
  for (const m of text.matchAll(GITHUB_REPO_RE)) {
    const owner = m[1];
    const repo = m[2];
    // Not repositories: github.com/orgs/x, /settings, /features, …
    if (["orgs", "settings", "features", "about", "pricing", "apps"].includes(owner)) continue;
    const slug = `${owner}/${repo}`;
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

/** Cache key for a remembered choice: same team and same labels means same repo. */
export function memoryKey(teamKey: string | undefined, labels: string[]): string {
  const team = teamKey ?? "-";
  const sorted = [...new Set(labels.map((l) => l.toLowerCase()))].sort();
  return `${team}|${sorted.join(",")}`;
}

/**
 * Remembers which repo was chosen for a given team+label combination, so the
 * agent asks once rather than on every ambiguous issue.
 *
 * Secret keys must match [-._a-zA-Z0-9]+, so keys are hex-encoded on the way in.
 */
export class RepoMemory {
  private cache: Record<string, string> | null = null;

  constructor(private store: RecordStore) {}

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    this.cache = (await this.store.read().catch(() => null)) ?? {};
    return this.cache;
  }

  async get(key: string): Promise<string | null> {
    const rec = await this.load();
    return rec[encodeKey(key)] ?? null;
  }

  async set(key: string, slug: string): Promise<void> {
    const rec = await this.load();
    rec[encodeKey(key)] = slug;
    await this.store.write(rec);
  }
}

function encodeKey(key: string): string {
  return Buffer.from(key, "utf-8").toString("hex");
}

interface GitHubRepo {
  full_name: string;
  archived: boolean;
  pushed_at: string;
}

/**
 * Every non-archived repo the token can push to, most recently pushed first.
 * Used to populate the "which repo?" prompt so nothing has to be configured
 * up front. Cached briefly — this runs per ambiguous issue, not per request.
 */
export class RepoDiscovery {
  private cached: { at: number; slugs: string[] } | null = null;

  constructor(
    private token: string,
    private ttlMs = 10 * 60 * 1000,
  ) {}

  async list(): Promise<string[]> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.slugs;
    if (!this.token) return [];

    const slugs: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(
        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,organization_member,collaborator`,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "talos-agent",
          },
        },
      );
      if (!res.ok) {
        console.error(`GitHub repo listing failed: ${res.status} ${await res.text()}`);
        break;
      }
      const batch = (await res.json()) as GitHubRepo[];
      for (const repo of batch) {
        if (!repo.archived) slugs.push(repo.full_name);
      }
      if (batch.length < 100) break;
    }

    this.cached = { at: Date.now(), slugs };
    return slugs;
  }
}
