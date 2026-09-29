import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

export interface DiffFile { path: string; additions: number; deletions: number }
export interface DiffResult { patch: string; files: DiffFile[]; additions: number; deletions: number }

export const ISSUE_KEY = /^[A-Za-z0-9._-]+$/;
export const assertIssueKey = (key: string): string => {
  if (!ISSUE_KEY.test(key)) throw new Error(`unsafe issue key: ${key}`);
  return key;
};

export const branchName = (issueKey: string) => `bugfix/${assertIssueKey(issueKey)}`;
export const worktreePath = (repo: string, issueKey: string) => path.join(repo, ".worktrees", `bugfix-${assertIssueKey(issueKey)}`);

const defaultRun = (cwd: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (!err) { res(String(stdout)); return; }
    const e = new Error(String(stderr).trim() || err.message) as Error & { code?: number | string | null };
    // execFile sets `err.code` to the child's numeric exit code on a non-zero exit, or to a
    // string (e.g. 'ENOENT') on a spawn failure. Preserved on the rejection so a caller that
    // needs to tell "exit 1" apart from any other failure — `wouldConflict`, so far — doesn't
    // have to re-derive it from stderr text.
    e.code = (err as NodeJS.ErrnoException).code;
    rej(e);
  }));

/** Every git touch the workflow needs. Injectable runner so tests can fake git when they want to. */
export class GitOps {
  constructor(private run: (cwd: string, args: string[]) => Promise<string> = defaultRun) {}

  async defaultBranch(repo: string): Promise<string> {
    const head = await this.run(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
    const fromRemote = head.trim().replace(/^origin\//, "");
    if (fromRemote) return fromRemote;
    return (await this.run(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  async createWorktree(repo: string, branch: string, baseBranch: string): Promise<string> {
    const dir = worktreePath(repo, branch.replace(/^bugfix\//, ""));
    await this.run(repo, ["worktree", "add", "-b", branch, dir, baseBranch]);
    return dir;
  }

  async removeWorktree(repo: string, worktree: string, branch: string): Promise<void> {
    const failures: string[] = [];

    await this.run(repo, ["worktree", "remove", "--force", worktree]).catch((err: Error) => {
      failures.push(err.message);
    });
    await this.run(repo, ["worktree", "prune"]).catch((err: Error) => {
      failures.push(err.message);
    });
    await this.run(repo, ["branch", "-D", branch]).catch((err: Error) => {
      if (/not found/i.test(err.message)) return; // deleting an already-gone branch is not a failure
      failures.push(err.message);
    });

    if (failures.length > 0) {
      throw new Error(`worktree cleanup incomplete: ${failures.join("; ")}`);
    }
  }

  /** The exact commit a ref points at — the evidence that pins what a human approved to
   *  what actually gets pushed. */
  async revParse(dir: string, rev = "HEAD"): Promise<string> {
    return (await this.run(dir, ["rev-parse", rev])).trim();
  }

  async currentBranch(dir: string): Promise<string> {
    return (await this.run(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  async commitsAhead(dir: string, baseBranch: string): Promise<number> {
    const out = await this.run(dir, ["rev-list", "--count", `${baseBranch}..HEAD`]);
    return Number(out.trim()) || 0;
  }

  /** Diff of the task branch against its base, with per-file counts for the diff card. */
  async diff(dir: string, baseBranch: string): Promise<DiffResult> {
    const range = `${baseBranch}...HEAD`;
    const patch = await this.run(dir, ["diff", "--no-renames", range]);
    const numstat = await this.run(dir, ["diff", "--no-renames", "--numstat", range]);
    const files: DiffFile[] = [];
    for (const line of numstat.split("\n")) {
      const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      files.push({ path: m[3], additions: Number(m[1]) || 0, deletions: Number(m[2]) || 0 });
    }
    return { patch, files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0) };
  }

  async hasRemote(repo: string): Promise<string | null> {
    const out = await this.run(repo, ["remote", "get-url", "origin"]).catch(() => "");
    return out.trim() || null;
  }

  /** Whether `branch` already exists — `git worktree add -b` refuses otherwise. Spec §8
   *  deliberately leaves a cancelled task's branch and worktree in place, so re-launching
   *  the same ticket must detect this itself rather than surface git's raw error. */
  async branchExists(repo: string, branch: string): Promise<boolean> {
    return this.run(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  }

  /** Whether `dir` is already registered as a worktree of `repo` — `git worktree add`
   *  refuses otherwise, for the same cancelled-task-leftover reason as `branchExists`. */
  async worktreeRegistered(repo: string, dir: string): Promise<boolean> {
    const out = await this.run(repo, ["worktree", "list", "--porcelain"]).catch(() => "");
    // `git worktree list` reports real, symlink-resolved paths (e.g. macOS's
    // /private/var vs. the /var alias) — resolve `repo` the same way before comparing,
    // rather than comparing `dir` as given, or every leftover would go undetected.
    const realRepo = await realpath(repo).catch(() => repo);
    const target = path.resolve(realRepo, path.relative(repo, dir));
    return out.split("\n").some(l => l.startsWith("worktree ") && path.resolve(l.slice("worktree ".length).trim()) === target);
  }

  /**
   * Is a rebase half-finished in this worktree, and which paths are still conflicted?
   * `git status --porcelain` marks conflicts with U on either side (UU, AU, UD, …); the
   * rebase directories are how git itself knows a rebase is in flight.
   */
  async rebaseState(dir: string): Promise<{ inProgress: boolean; conflicted: string[] }> {
    const gitDir = (await this.run(dir, ["rev-parse", "--git-path", "rebase-merge"])).trim();
    const applyDir = (await this.run(dir, ["rev-parse", "--git-path", "rebase-apply"])).trim();
    const inProgress = [gitDir, applyDir].some(p => p && existsSync(path.resolve(dir, p)));
    const status = await this.run(dir, ["status", "--porcelain"]);
    const conflicted = status.split("\n")
      .filter(l => /^(DD|AU|UD|UA|DU|AA|UU)\s/.test(l))
      .map(l => l.slice(3).trim());
    return { inProgress, conflicted };
  }

  /**
   * Push the task's branch. `force` uses --force-with-lease, never --force: a lease refuses
   * when the remote moved under us, which is the difference between rewriting our own history
   * and destroying someone else's. Only the rebase path passes force, and only after the human
   * has approved the rebased diff.
   */
  /**
   * Delete the task branch on `origin` after a merge has been confirmed. Separate from the
   * merge call on purpose: `gh pr merge --delete-branch` also deletes the LOCAL branch, which
   * git refuses while that branch is checked out in the task's worktree — failing the whole
   * merge report over cleanup. Here the caller can treat a failure as a note instead.
   *
   * A branch that is already gone (a repo that deletes branches on merge, or a second pass
   * after a retry) is not a failure: there is nothing to clean up, which is the desired state.
   */
  async deleteRemoteBranch(dir: string, branch: string): Promise<void> {
    await this.run(dir, ["push", "origin", "--delete", branch]).catch((err: Error) => {
      if (/remote ref does not exist|unable to delete '[^']*': remote ref does not exist/i.test(err.message)) return;
      throw err;
    });
  }

  async push(dir: string, branch: string, opts: { force?: boolean } = {}): Promise<void> {
    const args = ["push", ...(opts.force ? ["--force-with-lease"] : []), "origin", `${branch}:${branch}`];
    await this.run(dir, args);
  }

  /**
   * Would merging the base into HEAD conflict? `merge-tree` answers without touching the
   * worktree. Nothing calls this yet, so its answer must be conservative rather than
   * convenient: `git merge-tree --write-tree` exits 1 for a genuine conflict, per its own
   * docs — but that same command also exits non-zero (and, on git < 2.38, fails outright
   * with "unknown option") for an unresolvable base ref, a missing object, or any other
   * "the question couldn't be answered" case. None of those are a conflict, and reading them
   * as one would eventually block a merge that has nothing wrong with it. Exit code 1 is
   * therefore the only signal read as CONFLICTING; every other non-zero exit or spawn
   * failure (e.g. git not on PATH) reports `null` — unknown, never "fine" and never "block".
   */
  async wouldConflict(dir: string, baseBranch: string): Promise<boolean | null> {
    try {
      await this.run(dir, ["merge-tree", "--write-tree", "--name-only", baseBranch, "HEAD"]);
      return false;
    } catch (err) {
      const code = (err as { code?: number | string | null } | undefined)?.code;
      return code === 1 ? true : null;
    }
  }
}
