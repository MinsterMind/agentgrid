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

/** A branch name from a forge, fit to hand to git: nothing option-like, range-like, or that git refuses as a ref. */
export function safeBranch(name: string): string {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.startsWith("-") || name.includes("..") || name.endsWith(".lock") || name.endsWith("/") || name.includes("//"))
    throw new Error(`unsafe branch name: ${name.slice(0, 80)}`);
  return name;
}

export const branchName = (issueKey: string) => `bugfix/${assertIssueKey(issueKey)}`;
export const worktreePath = (repo: string, issueKey: string) => path.join(repo, ".worktrees", `bugfix-${assertIssueKey(issueKey)}`);

const defaultRun = (cwd: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (!err) { res(String(stdout)); return; }
    const e = new Error(String(stderr).trim() || err.message) as Error & { code?: number | string | null; stdout?: string };
    // Some commands answer through a non-zero exit (merge-tree: 1 = conflicts, listed on stdout).
    e.stdout = String(stdout);
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

  /** Bring origin's branches up to date — a fix cut from a stale ref starts from code that has moved on. */
  async fetch(repo: string): Promise<void> {
    await this.run(repo, ["fetch", "--quiet", "--prune", "origin"]);
  }

  /** Branch names on origin (without the `origin/` prefix), newest commit first. */
  async remoteBranches(repo: string): Promise<string[]> {
    const out = await this.run(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:strip=3)", "refs/remotes/origin"]).catch(() => "");
    return out.split("\n").map(l => l.trim()).filter(l => l && l !== "HEAD");
  }

  /**
   * The branch work actually lands on. Origin's default branch is not always it: a gitflow repo
   * can leave `main` frozen at its first commit while everything merges to `develop` — and a fix
   * cut from there has no code to fix (PULSEAI-414). So: of origin's default and the usual
   * integration names, the one with the newest commit; on a tie, the one that contains the other.
   * Falls back to `defaultBranch` when origin has none of them.
   */
  async integrationBranch(repo: string): Promise<string> {
    const fallback = await this.defaultBranch(repo);
    const names = [...new Set([fallback, "develop", "development", "dev", "main", "master"])];
    const out = await this.run(repo, ["for-each-ref", "--format=%(committerdate:unix) %(refname:strip=3)", ...names.map(n => `refs/remotes/origin/${n}`)]).catch(() => "");
    const found = out.split("\n").map(l => l.trim().split(" ")).filter(p => p.length === 2).map(([ts, name]) => ({ ts: Number(ts), name }));
    if (!found.length) return fallback;
    let best = found[0];
    for (const c of found.slice(1)) {
      if (c.ts > best.ts || (c.ts === best.ts && await this.isAncestor(repo, `origin/${best.name}`, `origin/${c.name}`))) best = c;
    }
    return best.name;
  }

  private isAncestor(repo: string, a: string, b: string): Promise<boolean> {
    return this.run(repo, ["merge-base", "--is-ancestor", a, b]).then(() => true, () => false);
  }

  /** Commits on `ref` whose message names `issueKey` — a fix that already landed. Exact key only:
   *  PAY-42 must not match PAY-420. One `<short sha> <subject>` line each, newest first. */
  async ticketCommits(repo: string, ref: string, issueKey: string, limit = 10): Promise<string[]> {
    const key = assertIssueKey(issueKey).replace(/[.]/g, "\\.");
    const out = await this.run(repo, ["log", "--oneline", "-E", "-i", `--max-count=${limit}`, `--grep=(^|[^A-Za-z0-9_-])${key}([^A-Za-z0-9_]|$)`, ref, "--"]).catch(() => "");
    return out.split("\n").map(l => l.trim()).filter(Boolean);
  }

  /** git's version as [major, minor, patch], or null when git can't be run. */
  async gitVersion(): Promise<[number, number, number] | null> {
    const out = await this.run(process.cwd(), ["--version"]).catch(() => "");
    const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
  }

  /** The tip of `branch` on origin, read with `git ls-remote` — one cheap call, no forge quota.
   *  Null when origin has no such branch or can't be reached. */
  async remoteTip(repo: string, branch: string): Promise<string | null> {
    const out = await this.run(repo, ["ls-remote", "origin", `refs/heads/${branch}`]).catch(() => "");
    return out.trim().split(/\s+/)[0] || null;
  }

  /**
   * The files a merge of `head` into `base` would conflict on — `git merge-tree --write-tree`, which
   * needs no checkout and touches no worktree. [] = merges cleanly; null = couldn't tell (a missing
   * ref, an old git, git itself missing). Exit 1 is the only "conflict" answer, as in `wouldConflict`.
   */
  async conflictFiles(dir: string, base: string, head: string): Promise<string[] | null> {
    try {
      await this.run(dir, ["merge-tree", "--write-tree", "--name-only", base, head]);
      return [];
    } catch (err) {
      const e = err as { code?: number | string | null; stdout?: string };
      if (e.code !== 1 || typeof e.stdout !== "string") return null;
      // Line 1 is the merged tree's id; the conflicted paths follow, up to the first blank line.
      // No tree id means git refused the question itself (a bad ref also exits 1): unknown, not conflict.
      const all = e.stdout.split("\n");
      if (!/^[0-9a-f]{40,64}$/.test(all[0]?.trim() ?? "")) return null;
      const lines = all.slice(1);
      const end = lines.findIndex(l => !l.trim());
      return [...new Set((end === -1 ? lines : lines.slice(0, end)).map(l => l.trim()).filter(Boolean))];
    }
  }

  /** `startPoint` is a ref such as `origin/develop`. `--no-track`: the task branch must not have
   *  the base as its upstream, or a plain `git pull` inside the worktree merges the base in. */
  async createWorktree(repo: string, branch: string, startPoint: string): Promise<string> {
    const dir = worktreePath(repo, branch.replace(/^bugfix\//, ""));
    await this.run(repo, ["worktree", "add", "--no-track", "-b", branch, dir, startPoint]);
    return dir;
  }

  /** A worktree on an existing remote branch — an imported PR's own branch — at the ticket's usual path (spec 2026-10-09 §3.3).
   *  `-B` puts the local branch exactly at origin's tip; `--no-track` as in `createWorktree`. */
  async checkoutWorktree(repo: string, issueKey: string, branch: string): Promise<string> {
    const dir = worktreePath(repo, issueKey);
    const b = safeBranch(branch);
    await this.run(repo, ["worktree", "add", "--no-track", "-B", b, dir, `origin/${b}`]);
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

  /** Paths with changes not committed (staged, unstaged or untracked) — "nothing committed" only
   *  means "nothing to change" when this is empty too. */
  async uncommitted(dir: string): Promise<string[]> {
    const out = await this.run(dir, ["status", "--porcelain"]);
    return out.split("\n").filter(l => l.trim()).map(l => l.slice(3).trim());
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
