import { execFile } from "node:child_process";
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
  execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
    err ? rej(new Error(String(stderr).trim() || err.message)) : res(String(stdout))));

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
}
