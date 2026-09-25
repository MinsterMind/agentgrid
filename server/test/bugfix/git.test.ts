import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitOps, worktreePath, branchName } from "../../src/bugfix/git.js";

const sh = (cwd: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile("git", args, { cwd }, (err, out) => (err ? rej(err) : res(String(out)))));

let repo: string; const git = new GitOps();

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "repo-"));
  await sh(repo, ["init", "-b", "main"]);
  await sh(repo, ["config", "user.email", "t@t"]); await sh(repo, ["config", "user.name", "T"]);
  await writeFile(path.join(repo, "a.txt"), "one\n");
  await sh(repo, ["add", "."]); await sh(repo, ["commit", "-m", "init"]);
});

describe("GitOps", () => {
  it("derives names and reports the default branch", async () => {
    expect(branchName("PAY-42")).toBe("bugfix/PAY-42");
    expect(worktreePath("/r", "PAY-42")).toBe("/r/.worktrees/bugfix-PAY-42");
    expect(await git.defaultBranch(repo)).toBe("main");
  });

  it("creates a worktree on a new branch, then removes it with the branch", async () => {
    const wt = await git.createWorktree(repo, "bugfix/PAY-42", "main");
    expect(wt).toBe(worktreePath(repo, "PAY-42"));
    expect(await git.currentBranch(wt)).toBe("bugfix/PAY-42");
    expect(await git.commitsAhead(wt, "main")).toBe(0);
    await git.removeWorktree(repo, wt, "bugfix/PAY-42");
    expect((await sh(repo, ["worktree", "list"])).includes("bugfix-PAY-42")).toBe(false);
    expect((await sh(repo, ["branch", "--list", "bugfix/PAY-42"])).trim()).toBe("");
  });

  it("counts commits and produces a per-file diff with counts", async () => {
    const wt = await git.createWorktree(repo, "bugfix/PAY-42", "main");
    await appendFile(path.join(wt, "a.txt"), "two\nthree\n");
    await writeFile(path.join(wt, "b.txt"), "new file\n");
    await sh(wt, ["add", "."]); await sh(wt, ["commit", "-m", "fix"]);
    expect(await git.commitsAhead(wt, "main")).toBe(1);
    const d = await git.diff(wt, "main");
    expect(d.files.map(f => [f.path, f.additions, f.deletions]).sort()).toEqual([["a.txt", 2, 0], ["b.txt", 1, 0]]);
    expect(d.additions).toBe(3); expect(d.deletions).toBe(0);
    expect(d.patch).toContain("+two");
  });

  it("reports the origin remote, or null when there is none", async () => {
    expect(await git.hasRemote(repo)).toBeNull();
    await sh(repo, ["remote", "add", "origin", "git@github.com:acme/payments.git"]);
    expect(await git.hasRemote(repo)).toBe("git@github.com:acme/payments.git");
  });

  it("refuses to create a worktree for a branch that already exists", async () => {
    await git.createWorktree(repo, "bugfix/PAY-42", "main");
    await expect(git.createWorktree(repo, "bugfix/PAY-42", "main")).rejects.toThrow(/already exists/i);
  });
});
