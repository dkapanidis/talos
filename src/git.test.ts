import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFile } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { GitManager } from "./git.js";

const exec = promisify(execFile);

/**
 * These run against real git repositories on disk. The behaviour under test is
 * entirely about what git does to a clone that is reused across runs, which a
 * mocked exec would assert nothing about.
 */
let root: string;
let origin: string;
let workDir: string;

const SLUG = "acme/widget";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

/** Add a commit to the origin's default branch and return its sha. */
async function commitToOrigin(message: string, file = "file.txt"): Promise<string> {
  writeFileSync(join(origin, file), `${message}\n`);
  await git(origin, "add", ".");
  await git(origin, "commit", "-m", message);
  return git(origin, "rev-parse", "HEAD");
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "talos-git-"));
  origin = join(root, "origin");
  workDir = join(root, "work");
  mkdirSync(origin, { recursive: true });

  await git(origin, "init", "--initial-branch=main");
  await git(origin, "config", "user.email", "test@example.com");
  await git(origin, "config", "user.name", "Test");
  // Cloning a non-bare repo is fine; pushes to the checked-out branch are not,
  // and nothing here pushes.
  await commitToOrigin("initial");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function manager(): GitManager {
  return new GitManager(workDir, "");
}

describe("ensureCloned", () => {
  test("clones once and reuses the clone on the next run", async () => {
    const g = manager();
    const first = await g.ensureCloned(SLUG, origin);
    writeFileSync(join(first, "marker"), "cached");

    const second = await g.ensureCloned(SLUG, origin);

    expect(second).toBe(first);
    // The marker surviving proves the directory was not re-cloned.
    expect(existsSync(join(second, "marker"))).toBe(true);
  });

  test("fetches commits pushed to origin since the clone", async () => {
    const g = manager();
    const dir = await g.ensureCloned(SLUG, origin);
    const sha = await commitToOrigin("second");

    await g.ensureCloned(SLUG, origin);

    expect(await git(dir, "rev-parse", "origin/main")).toBe(sha);
  });

  test("prunes remote branches deleted upstream", async () => {
    const g = manager();
    const dir = await g.ensureCloned(SLUG, origin);
    await git(origin, "branch", "doomed");
    await g.ensureCloned(SLUG, origin);
    expect(await git(dir, "branch", "-r")).toContain("origin/doomed");

    await git(origin, "branch", "-D", "doomed");
    await g.ensureCloned(SLUG, origin);

    expect(await git(dir, "branch", "-r")).not.toContain("origin/doomed");
  });

  test("re-clones a directory left behind by an interrupted clone", async () => {
    const g = manager();
    const dir = join(workDir, "repos", "acme-widget");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "partial"), "junk");

    await g.ensureCloned(SLUG, origin);

    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(existsSync(join(dir, "partial"))).toBe(false);
  });

  test("re-points the remote at a freshly credentialed URL", async () => {
    // The installation token embedded at clone time expires within the hour, so
    // a cached clone must not keep fetching through the stale one.
    const g = new GitManager(workDir, "");
    const dir = await g.ensureCloned(SLUG, origin);
    // Stand in for a clone made an hour ago with a since-expired token. Port 1
    // on localhost refuses immediately, so the fetch fails without a network.
    const stale = "https://x-access-token:tok-old@127.0.0.1:1/acme/widget.git";
    await git(dir, "remote", "set-url", "origin", stale);

    const fresh = new GitManager(workDir, "tok-new");
    // The fetch itself still fails; the remote URL must have been rewritten
    // before that point regardless, or the next run inherits the dead token.
    await fresh.ensureCloned(SLUG, "https://127.0.0.1:1/acme/widget.git").catch(() => {});

    const url = await git(dir, "remote", "get-url", "origin");
    expect(url).toContain("tok-new");
    expect(url).not.toContain("tok-old");
  });
});

describe("createWorktree", () => {
  test("bases a new branch on the latest origin HEAD, not the cached one", async () => {
    const g = manager();
    await g.ensureCloned(SLUG, origin);
    // origin moves on after the clone is already cached.
    const sha = await commitToOrigin("landed after clone");

    const wt = await g.createWorktree(SLUG, origin, "ray-1-feature");

    expect(await git(wt, "rev-parse", "HEAD")).toBe(sha);
  });

  test("gives each issue its own directory off one shared clone", async () => {
    const g = manager();
    const a = await g.createWorktree(SLUG, origin, "ray-1-one");
    const b = await g.createWorktree(SLUG, origin, "ray-2-two");

    expect(a).not.toBe(b);
    expect(await git(a, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ray-1-one");
    expect(await git(b, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ray-2-two");
    // One clone, two worktrees — the point of the shared cache.
    expect(await git(a, "rev-parse", "--git-common-dir")).toContain("repos/acme-widget");
  });

  test("checks out an existing remote branch at its remote tip", async () => {
    await git(origin, "checkout", "-b", "ray-3-existing");
    const sha = await commitToOrigin("work already on the branch");
    await git(origin, "checkout", "main");

    const wt = await manager().createWorktree(SLUG, origin, "ray-3-existing");

    expect(await git(wt, "rev-parse", "HEAD")).toBe(sha);
  });

  test("discards a worktree left behind by a crashed run", async () => {
    const g = manager();
    const first = await g.createWorktree(SLUG, origin, "ray-4-crash");
    writeFileSync(join(first, "file.txt"), "half-finished edit\n");
    writeFileSync(join(first, "stray.txt"), "debris\n");

    const second = await g.createWorktree(SLUG, origin, "ray-4-crash");

    expect(second).toBe(first);
    expect(existsSync(join(second, "stray.txt"))).toBe(false);
    expect(await git(second, "status", "--porcelain")).toBe("");
  });

  test("resets a local branch that fell behind its remote", async () => {
    const g = manager();
    const wt = await g.createWorktree(SLUG, origin, "ray-5-diverged");
    // A run that committed locally and died before pushing.
    writeFileSync(join(wt, "local.txt"), "never pushed\n");
    await git(wt, "config", "user.email", "test@example.com");
    await git(wt, "config", "user.name", "Test");
    await git(wt, "add", ".");
    await git(wt, "commit", "-m", "local only");
    // Meanwhile the branch exists on origin at a different commit.
    await git(origin, "checkout", "-b", "ray-5-diverged");
    const sha = await commitToOrigin("the real tip");
    await git(origin, "checkout", "main");

    const again = await g.createWorktree(SLUG, origin, "ray-5-diverged");

    expect(await git(again, "rev-parse", "HEAD")).toBe(sha);
    expect(existsSync(join(again, "local.txt"))).toBe(false);
  });
});

describe("cleanupWorktree", () => {
  test("removes the worktree and keeps the cached clone", async () => {
    const g = manager();
    const wt = await g.createWorktree(SLUG, origin, "ray-6-done");

    await g.cleanupWorktree(SLUG, "ray-6-done");

    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(workDir, "repos", "acme-widget", ".git"))).toBe(true);
  });

  test("is a no-op when there is nothing to clean up", async () => {
    await manager().cleanupWorktree(SLUG, "ray-7-never-started");
  });

  test("leaves the clone reusable for the next run on the same branch", async () => {
    const g = manager();
    await g.createWorktree(SLUG, origin, "ray-8-repeat");
    await g.cleanupWorktree(SLUG, "ray-8-repeat");

    const wt = await g.createWorktree(SLUG, origin, "ray-8-repeat");

    expect(existsSync(wt)).toBe(true);
    expect(await git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ray-8-repeat");
  });
});
