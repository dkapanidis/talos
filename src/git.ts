import { execFile } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
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

  /**
   * A cached clone of the repo, fetched up to date.
   *
   * The clone lives on a persistent volume and is reused across runs and pod
   * restarts, so nothing here may assume a fresh checkout.
   */
  async ensureCloned(repoSlug: string, repoUrl: string, token?: string): Promise<string> {
    const dir = this.repoDir(repoSlug);
    const url = this.authedUrl(repoUrl, token);

    // A directory without .git is a clone that was interrupted partway. It can
    // never be fetched into, so start it over rather than failing every run.
    if (existsSync(dir) && !existsSync(join(dir, ".git"))) {
      rmSync(dir, { recursive: true, force: true });
    }

    if (!existsSync(dir)) {
      await exec("git", ["clone", url, dir]);
      return dir;
    }

    // Credentials are baked into the remote URL at clone time and a GitHub App
    // installation token expires after an hour, so a cached clone has to be
    // re-pointed at a fresh one before it can fetch or push.
    await exec("git", ["remote", "set-url", "origin", url], { cwd: dir });
    // Drop metadata for worktrees whose directories are gone, so a re-added
    // worktree at the same path is not rejected as already registered.
    await exec("git", ["worktree", "prune"], { cwd: dir }).catch(() => {});
    await exec("git", ["fetch", "--prune", "--tags", "origin"], { cwd: dir });
    return dir;
  }

  /** The remote's default branch, e.g. "main". */
  private async defaultBranch(repoDir: string): Promise<string> {
    const read = () =>
      exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], { cwd: repoDir });
    const { stdout } = await read().catch(async () => {
      // origin/HEAD is written at clone time and can be missing on a cache that
      // predates a default-branch rename. Ask the remote and retry.
      await exec("git", ["remote", "set-head", "origin", "--auto"], { cwd: repoDir });
      return read();
    });
    return stdout.trim().replace(/^origin\//, "");
  }

  private async refExists(repoDir: string, ref: string): Promise<boolean> {
    return exec("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repoDir })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * An isolated worktree for one issue's branch, off the cached clone.
   *
   * Always starts from the freshly fetched remote tip: a new branch off
   * origin/<default>, an existing one reset to its own remote branch. Anything
   * left in the worktree by an earlier run is discarded — committed work is
   * safe on the branch, and uncommitted leftovers from a crashed run would
   * otherwise leak into the next one.
   */
  async createWorktree(
    repoSlug: string,
    repoUrl: string,
    branchName: string,
    token?: string,
  ): Promise<string> {
    const repoDir = await this.ensureCloned(repoSlug, repoUrl, token);
    const wtDir = this.worktreeDir(repoSlug, branchName);

    if (existsSync(wtDir)) {
      await exec("git", ["worktree", "remove", wtDir, "--force"], { cwd: repoDir }).catch(() => {});
      rmSync(wtDir, { recursive: true, force: true });
      await exec("git", ["worktree", "prune"], { cwd: repoDir }).catch(() => {});
    }

    const remoteBranch = `origin/${branchName}`;
    const hasRemote = await this.refExists(repoDir, `refs/remotes/${remoteBranch}`);
    const hasLocal = await this.refExists(repoDir, `refs/heads/${branchName}`);

    if (hasLocal) {
      await exec("git", ["worktree", "add", wtDir, branchName], { cwd: repoDir });
      // The remote wins where it exists: the agent pushes as it works, so a
      // local branch ahead of it is the debris of a run that died mid-task.
      if (hasRemote) {
        await exec("git", ["reset", "--hard", remoteBranch], { cwd: wtDir });
      }
      return wtDir;
    }

    if (hasRemote) {
      await exec("git", ["worktree", "add", "--track", "-b", branchName, wtDir, remoteBranch], {
        cwd: repoDir,
      });
      return wtDir;
    }

    const base = await this.defaultBranch(repoDir);
    await exec("git", ["worktree", "add", "-b", branchName, wtDir, `origin/${base}`], {
      cwd: repoDir,
    });
    return wtDir;
  }

  /**
   * Drop an issue's worktree, keeping the cached clone. Best-effort: this runs
   * on the way out of a run, including a failed one, and the disk is persistent
   * — a worktree left behind here is wasted space until the next run on the
   * same branch, not a broken state.
   */
  async cleanupWorktree(repoSlug: string, branchName: string): Promise<void> {
    const repoDir = this.repoDir(repoSlug);
    const wtDir = this.worktreeDir(repoSlug, branchName);
    if (!existsSync(repoDir)) return;
    if (existsSync(wtDir)) {
      await exec("git", ["worktree", "remove", wtDir, "--force"], { cwd: repoDir }).catch(() => {
        rmSync(wtDir, { recursive: true, force: true });
      });
    }
    await exec("git", ["worktree", "prune"], { cwd: repoDir }).catch(() => {});
  }
}
