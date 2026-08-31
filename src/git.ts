import { execFile } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { promisify } from "util";

const exec = promisify(execFile);

export class GitManager {
  constructor(
    private workDir: string,
    private githubToken: string,
  ) {
    mkdirSync(join(this.workDir, "repos"), { recursive: true });
    mkdirSync(join(this.workDir, "worktrees"), { recursive: true });
  }

  private repoDir(repoSlug: string): string {
    return join(this.workDir, "repos", repoSlug.replace("/", "-"));
  }

  private worktreeDir(repoSlug: string, branchName: string): string {
    const safeBranch = branchName.replace(/[^a-zA-Z0-9-_]/g, "-");
    return join(this.workDir, "worktrees", `${repoSlug.replace("/", "-")}-${safeBranch}`);
  }

  private authedUrl(url: string, token?: string): string {
    const effective = token || this.githubToken;
    if (!effective) return url;
    // Already carries credentials (e.g. a GitHub App clone URL).
    if (/^https:\/\/[^/]*@/.test(url)) return url;
    return url.replace("https://", `https://x-access-token:${effective}@`);
  }

  async ensureCloned(repoSlug: string, repoUrl: string, token?: string): Promise<string> {
    const dir = this.repoDir(repoSlug);
    if (existsSync(dir)) {
      await exec("git", ["fetch", "--all"], { cwd: dir });
      await exec("git", ["pull", "--ff-only"], { cwd: dir }).catch(() => {});
      return dir;
    }
    await exec("git", ["clone", this.authedUrl(repoUrl, token), dir]);
    return dir;
  }

  async createWorktree(
    repoSlug: string,
    repoUrl: string,
    branchName: string,
    token?: string,
  ): Promise<string> {
    const repoDir = await this.ensureCloned(repoSlug, repoUrl, token);
    const wtDir = this.worktreeDir(repoSlug, branchName);

    if (existsSync(wtDir)) {
      // Worktree already exists, just pull latest
      await exec("git", ["checkout", branchName], { cwd: wtDir }).catch(() => {});
      return wtDir;
    }

    const branchExists = await exec(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      { cwd: repoDir },
    )
      .then(() => true)
      .catch(() => false);

    if (branchExists) {
      await exec("git", ["worktree", "add", wtDir, branchName], { cwd: repoDir });
      return wtDir;
    }

    const { stdout: defaultBranch } = await exec(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
      { cwd: repoDir },
    );
    const base = defaultBranch.trim().replace("origin/", "");

    await exec("git", ["worktree", "add", "-b", branchName, wtDir, base], {
      cwd: repoDir,
    });

    return wtDir;
  }

  async cleanupWorktree(repoSlug: string, branchName: string): Promise<void> {
    const repoDir = this.repoDir(repoSlug);
    const wtDir = this.worktreeDir(repoSlug, branchName);
    if (existsSync(wtDir)) {
      await exec("git", ["worktree", "remove", wtDir, "--force"], { cwd: repoDir });
    }
  }
}
