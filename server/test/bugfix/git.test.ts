import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitOps, worktreePath, branchName } from "../../src/bugfix/git.js";

const sh = (cwd: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile("git", args, { cwd }, (err, out) => (err ? rej(err) : res(String(out)))));

const run = (cmd: string, args: string[], opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string; code: number }> =>
  new Promise((res) =>
    execFile(cmd, args, { cwd: opts?.cwd }, (err, stdout, stderr) =>
      res({ stdout: String(stdout), stderr: String(stderr), code: err?.code || 0 })));

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

  it("reports the exact commit HEAD points at", async () => {
    const head = await git.revParse(repo);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(head).toBe((await sh(repo, ["rev-parse", "HEAD"])).trim());
    const wt = await git.createWorktree(repo, "bugfix/PAY-42", "main");
    expect(await git.revParse(wt)).toBe(head);            // same commit, new branch
    await appendFile(path.join(wt, "a.txt"), "two\n");
    await sh(wt, ["add", "."]); await sh(wt, ["commit", "-m", "fix"]);
    expect(await git.revParse(wt)).not.toBe(head);        // and it moves with a commit
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

  it("refuses issue keys that would escape the worktree directory", () => {
    expect(() => worktreePath("/r", "a/../../etc")).toThrow(/unsafe issue key/);
    expect(() => branchName("../evil")).toThrow(/unsafe issue key/);
    expect(worktreePath("/r", "PAY-42")).toBe("/r/.worktrees/bugfix-PAY-42");
  });

  it("reports a rename as a delete and an add, with real paths", async () => {
    const wt = await git.createWorktree(repo, "bugfix/PAY-43", "main");
    await sh(wt, ["mv", "a.txt", "renamed.txt"]);
    await sh(wt, ["commit", "-m", "rename"]);
    const d = await git.diff(wt, "main");
    expect(d.files.map(f => f.path).sort()).toEqual(["a.txt", "renamed.txt"]);
  });

  it("detects a leftover branch and worktree from an earlier, cancelled run", async () => {
    expect(await git.branchExists(repo, "bugfix/PAY-42")).toBe(false);
    expect(await git.worktreeRegistered(repo, worktreePath(repo, "PAY-42"))).toBe(false);
    const wt = await git.createWorktree(repo, "bugfix/PAY-42", "main");
    expect(await git.branchExists(repo, "bugfix/PAY-42")).toBe(true);
    expect(await git.worktreeRegistered(repo, wt)).toBe(true);
    // A different, unrelated path must not be mistaken for this one.
    expect(await git.worktreeRegistered(repo, worktreePath(repo, "OTHER-1"))).toBe(false);
  });

  // N2: git can lose track of a worktree directory (its `.git/worktrees/<name>` admin
  // metadata removed or corrupted some other way) while the directory itself is still on
  // disk. `worktreeRegistered` must report false for it — and, since the intake code that
  // consumes this then tells the user to `rm -rf` rather than `git worktree remove` for
  // exactly this reason, prove that choice is actually correct: `git worktree remove`
  // really does fail on it, and `rm -rf` really does clear it.
  it("does not report an unregistered worktree directory as registered, and proves each remedy actually works", async () => {
    const wt = await git.createWorktree(repo, "bugfix/PAY-44", "main");
    expect(await git.worktreeRegistered(repo, wt)).toBe(true);

    // Simulate git losing track of it: drop the worktree's own admin dir directly,
    // leaving the working directory (and the branch) untouched.
    const adminDirs = (await sh(repo, ["worktree", "list", "--porcelain"])).split("\n\n")
      .filter(b => b.includes(wt));
    expect(adminDirs).toHaveLength(1);
    await rm(path.join(repo, ".git", "worktrees", "bugfix-PAY-44"), { recursive: true, force: true });

    expect(await git.worktreeRegistered(repo, wt)).toBe(false);   // git no longer knows about it...
    expect(await git.branchExists(repo, "bugfix/PAY-44")).toBe(true);  // ...but the branch is still there

    // The remedy this shape gets (`rm -rf`) must actually work...
    await rm(wt, { recursive: true, force: true });
    expect(await git.worktreeRegistered(repo, wt)).toBe(false);
    // ...whereas `git worktree remove --force` — the remedy printed for a *registered*
    // worktree — genuinely fails on this shape, which is the whole reason to tell them apart.
    await expect(sh(repo, ["worktree", "remove", "--force", wt])).rejects.toThrow(/is not a working tree|does not exist/i);
  });

  it("surfaces a cleanup failure instead of silently succeeding", async () => {
    const failing = new GitOps(async (_cwd, args) => {
      if (args[0] === "worktree" && args[1] === "remove") throw new Error("fatal: worktree is locked");
      return "";
    });
    await expect(failing.removeWorktree(repo, "/nope", "bugfix/PAY-99")).rejects.toThrow(/cleanup incomplete/);
  });

  describe("push", () => {
    it("pushes the branch to a real remote, and handles local rewrites", async () => {
      // A bare repo on disk is a real remote: no network, but a genuine push.
      const remote = await mkdtemp(path.join(tmpdir(), "ag-remote-"));
      await run("git", ["init", "--bare", "-b", "main", remote]);
      const repo2 = await mkdtemp(path.join(tmpdir(), "ag-repo-"));
      await run("git", ["init", "-b", "main"], { cwd: repo2 });
      await run("git", ["config", "user.email", "t@t"], { cwd: repo2 });
      await run("git", ["config", "user.name", "t"], { cwd: repo2 });
      await writeFile(path.join(repo2, "a.txt"), "one\n");
      await run("git", ["add", "-A"], { cwd: repo2 });
      await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "one"], { cwd: repo2 });
      await run("git", ["remote", "add", "origin", remote], { cwd: repo2 });
      await run("git", ["push", "-u", "origin", "main"], { cwd: repo2 });

      const git2 = new GitOps();
      await run("git", ["checkout", "-b", "bugfix/X-1"], { cwd: repo2 });
      await writeFile(path.join(repo2, "a.txt"), "one\n");
      await run("git", ["add", "-A"], { cwd: repo2 });
      await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "one"], { cwd: repo2 });

      await git2.push(repo2, "bugfix/X-1");
      const onRemote = await run("git", ["ls-remote", remote, "refs/heads/bugfix/X-1"]);
      expect(onRemote.stdout).toMatch(/bugfix\/X-1/);

      // Rewrite local history; a plain push must be refused and a lease push must succeed.
      await run("git", ["commit", "--amend", "-m", "one (amended)", "--no-edit"], { cwd: repo2 });
      await expect(git2.push(repo2, "bugfix/X-1")).rejects.toThrow(/rejected|non-fast-forward/i);
      await git2.push(repo2, "bugfix/X-1", { force: true });
      const after = await run("git", ["log", "-1", "--format=%s", "bugfix/X-1"], { cwd: remote });
      expect(after.stdout.trim()).toBe("one (amended)");
    });

    it("force-with-lease refuses when the remote has moved, but bare --force succeeds (lease protection)", async () => {
      // Create a bare remote and clone it twice to simulate concurrent work.
      const bare = await mkdtemp(path.join(tmpdir(), "ag-bare-"));
      await run("git", ["init", "--bare", "-b", "main", bare]);

      // Set up the bare repo with an initial commit so we can clone it.
      const setup = await mkdtemp(path.join(tmpdir(), "ag-setup-"));
      await run("git", ["clone", bare, setup]);
      await run("git", ["config", "user.email", "t@t"], { cwd: setup });
      await run("git", ["config", "user.name", "t"], { cwd: setup });
      await writeFile(path.join(setup, "init.txt"), "init\n");
      await run("git", ["add", "."], { cwd: setup });
      await run("git", ["commit", "-m", "init"], { cwd: setup });
      await run("git", ["push"], { cwd: setup });

      // Clone twice: `a` will move the remote, `b` will have stale tracking info.
      const a = await mkdtemp(path.join(tmpdir(), "ag-a-"));
      const b = await mkdtemp(path.join(tmpdir(), "ag-b-"));
      await run("git", ["clone", bare, a]);
      await run("git", ["clone", bare, b]);
      await run("git", ["config", "user.email", "t@t"], { cwd: a });
      await run("git", ["config", "user.name", "t"], { cwd: a });
      await run("git", ["config", "user.email", "t@t"], { cwd: b });
      await run("git", ["config", "user.name", "t"], { cwd: b });

      // In `a`: create and push bugfix/X-1.
      await run("git", ["checkout", "-b", "bugfix/X-1"], { cwd: a });
      await writeFile(path.join(a, "a.txt"), "a\n");
      await run("git", ["add", "."], { cwd: a });
      await run("git", ["commit", "-m", "first"], { cwd: a });
      await run("git", ["push", "-u", "origin", "bugfix/X-1"], { cwd: a });

      // In `b`: fetch and check out bugfix/X-1, so `b` has the tracking info.
      await run("git", ["fetch"], { cwd: b });
      await run("git", ["checkout", "bugfix/X-1"], { cwd: b });

      // In `a`: move the branch forward (simulate other work).
      await writeFile(path.join(a, "a.txt"), "a2\n");
      await run("git", ["add", "."], { cwd: a });
      await run("git", ["commit", "-m", "second"], { cwd: a });
      await run("git", ["push"], { cwd: a });
      // Now the remote's bugfix/X-1 points to "second", but `b` still thinks it points to "first".

      // In `b`: diverge from the tracked state and try to force-push. Lease should refuse.
      await writeFile(path.join(b, "b.txt"), "b\n");
      await run("git", ["add", "."], { cwd: b });
      await run("git", ["commit", "-m", "b-diverge"], { cwd: b });

      const git = new GitOps();
      await expect(git.push(b, "bugfix/X-1", { force: true })).rejects.toThrow(/stale info|rejected/i);

      // Verify the discriminator: plain --force should succeed in the same state.
      const forceResult = await run("git", ["push", "--force", "origin", "bugfix/X-1"], { cwd: b });
      expect(forceResult.code).toBe(0);
    });
  });
});
