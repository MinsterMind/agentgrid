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

/** A fresh, throwaway repo with one commit on `main` — for tests that don't need the shared
 *  `repo`/`beforeEach` fixture, e.g. because they build their own branch topology. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "repo-"));
  await sh(dir, ["init", "-b", "main"]);
  await sh(dir, ["config", "user.email", "t@t"]); await sh(dir, ["config", "user.name", "T"]);
  await writeFile(path.join(dir, "a.txt"), "one\n");
  await sh(dir, ["add", "."]); await sh(dir, ["commit", "-m", "init"]);
  return dir;
}

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

  describe("deleteRemoteBranch", () => {
    it("deletes the branch on the remote and tolerates one that is already gone", async () => {
      const remote = await mkdtemp(path.join(tmpdir(), "ag-remote-del-"));
      await run("git", ["init", "--bare", "-b", "main", remote]);
      const repo2 = await makeRepo();
      await run("git", ["remote", "add", "origin", remote], { cwd: repo2 });
      await run("git", ["push", "-u", "origin", "main"], { cwd: repo2 });
      await run("git", ["checkout", "-b", "bugfix/X-9"], { cwd: repo2 });
      await writeFile(path.join(repo2, "b.txt"), "two\n");
      await run("git", ["add", "-A"], { cwd: repo2 });
      await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "two"], { cwd: repo2 });
      await run("git", ["push", "origin", "bugfix/X-9"], { cwd: repo2 });
      expect((await run("git", ["ls-remote", remote, "refs/heads/bugfix/X-9"])).stdout).toMatch(/bugfix\/X-9/);

      await new GitOps().deleteRemoteBranch(repo2, "bugfix/X-9");
      expect((await run("git", ["ls-remote", remote, "refs/heads/bugfix/X-9"])).stdout.trim()).toBe("");

      // A repo configured to delete branches on merge (or a second pass after a retry) leaves
      // nothing to delete — that is not a failure anyone should be told about.
      await expect(new GitOps().deleteRemoteBranch(repo2, "bugfix/X-9")).resolves.toBeUndefined();
    });
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

describe("rebaseState", () => {
  it("reports a clean tree and a rebase left half-finished", async () => {
    const repo = await makeRepo();
    const git = new GitOps();
    expect(await git.rebaseState(repo)).toEqual({ inProgress: false, conflicted: [] });

    // Manufacture a real conflict: two branches touching the same line.
    await writeFile(path.join(repo, "c.txt"), "base\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: repo });
    await run("git", ["checkout", "-b", "side"], { cwd: repo });
    await writeFile(path.join(repo, "c.txt"), "side\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "side"], { cwd: repo });
    await run("git", ["checkout", "main"], { cwd: repo });
    await writeFile(path.join(repo, "c.txt"), "main\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "main"], { cwd: repo });
    await run("git", ["checkout", "side"], { cwd: repo });
    await run("git", ["rebase", "main"], { cwd: repo }).catch(() => {});   // leaves it conflicted

    const state = await git.rebaseState(repo);
    expect(state.inProgress).toBe(true);
    expect(state.conflicted).toContain("c.txt");
  });
});

describe("wouldConflict", () => {
  it("is true for a real conflict against the base and false for a clean merge", async () => {
    const repo = await makeRepo();
    await writeFile(path.join(repo, "c.txt"), "base\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: repo });
    await run("git", ["checkout", "-b", "side"], { cwd: repo });
    await writeFile(path.join(repo, "c.txt"), "side\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "side"], { cwd: repo });
    await run("git", ["checkout", "main"], { cwd: repo });
    await writeFile(path.join(repo, "c.txt"), "main\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "main"], { cwd: repo });
    await run("git", ["checkout", "side"], { cwd: repo });

    const git = new GitOps();
    expect(await git.wouldConflict(repo, "main")).toBe(true);

    const clean = await makeRepo();
    await run("git", ["checkout", "-b", "feature"], { cwd: clean });
    await writeFile(path.join(clean, "new.txt"), "only here\n");
    await run("git", ["add", "-A"], { cwd: clean });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "feature"], { cwd: clean });
    expect(await git.wouldConflict(clean, "main")).toBe(false);
  });

  it("reports unknown (null), not conflicting, when the command fails with an exit code other than 1", async () => {
    // A missing base ref, a missing object, or (on git < 2.38) an unrecognised --write-tree
    // flag can all fail this command outright with a non-1 exit — none of them mean the
    // merge would conflict, so this must not collapse to `true` the way a bare "reject means
    // conflict" implementation would.
    const failing = new GitOps(async () => {
      const e = new Error("usage: git merge-tree ...") as Error & { code?: number | string };
      e.code = 129;
      throw e;
    });
    expect(await failing.wouldConflict("/r", "main")).toBeNull();
  });

  it("reports unknown (null) rather than conflicting on a spawn failure (e.g. git missing)", async () => {
    const failing = new GitOps(async () => {
      const e = new Error("spawn git ENOENT") as Error & { code?: number | string };
      e.code = "ENOENT";
      throw e;
    });
    expect(await failing.wouldConflict("/r", "main")).toBeNull();
  });

  it("still reports conflicting (true) when the injected runner rejects with exit code 1", async () => {
    const conflicting = new GitOps(async () => {
      const e = new Error("CONFLICT (content): Merge conflict in c.txt") as Error & { code?: number | string };
      e.code = 1;
      throw e;
    });
    expect(await conflicting.wouldConflict("/r", "main")).toBe(true);
  });
});

/** origin's default branch is `main`, frozen at the first commit; `develop` is where the work is —
 *  the shape of the repo that cut a bug branch from "Initial commit" (PULSEAI-414). */
async function gitflowClone(opts: { developStale?: boolean } = {}): Promise<{ origin: string; clone: string; seed: string }> {
  const seed = await makeRepo();
  await sh(seed, ["checkout", "-q", "-b", "develop"]);
  await writeFile(path.join(seed, "src.txt"), "app\n"); await sh(seed, ["add", "."]); await sh(seed, ["commit", "-qm", "PULSEAI-414: fix the null check"]);
  await writeFile(path.join(seed, "src.txt"), "app v2\n"); await sh(seed, ["add", "."]); await sh(seed, ["commit", "-qm", "PULSEAI-4140: unrelated"]);
  if (opts.developStale) { await sh(seed, ["checkout", "-q", "main"]); await new Promise(r => setTimeout(r, 1100)); await writeFile(path.join(seed, "m.txt"), "m\n"); await sh(seed, ["add", "."]); await sh(seed, ["commit", "-qm", "main moves on"]); }
  const origin = await mkdtemp(path.join(tmpdir(), "origin-"));
  await sh(origin, ["clone", "-q", "--bare", seed, "."]);
  await sh(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const parent = await mkdtemp(path.join(tmpdir(), "clone-"));
  await sh(parent, ["clone", "-q", origin, "c"]);
  const clone = path.join(parent, "c");
  await sh(clone, ["config", "user.email", "t@t"]); await sh(clone, ["config", "user.name", "T"]);
  return { origin, clone, seed };
}

describe("GitOps — the branch a fix is cut from", () => {
  it("picks the integration branch: the newest of origin's default and the usual names", async () => {
    const { clone } = await gitflowClone();
    expect(await git.defaultBranch(clone)).toBe("main");                 // what the old code used
    expect(await git.integrationBranch(clone)).toBe("develop");
    const stale = await gitflowClone({ developStale: true });
    expect(await git.integrationBranch(stale.clone)).toBe("main");
    expect(await git.remoteBranches(clone)).toEqual(expect.arrayContaining(["develop", "main"]));
  });

  it("fetches, then cuts the branch from origin's tip — not a stale local branch — without tracking it", async () => {
    const { clone, seed, origin } = await gitflowClone();
    await writeFile(path.join(seed, "late.txt"), "x\n"); await sh(seed, ["add", "."]); await sh(seed, ["commit", "-qm", "landed after the clone"]);
    await sh(seed, ["push", "-q", origin, "develop"]);
    await git.fetch(clone);
    const wt = await git.createWorktree(clone, "bugfix/PULSEAI-414", "origin/develop");
    expect(await git.revParse(wt)).toBe(await git.revParse(clone, "origin/develop"));
    expect((await sh(seed, ["log", "-1", "--format=%s", "develop"])).trim()).toBe("landed after the clone");
    expect(await git.revParse(wt)).toBe((await sh(seed, ["rev-parse", "develop"])).trim());
    await expect(sh(wt, ["rev-parse", "--abbrev-ref", "@{upstream}"])).rejects.toThrow();   // no upstream: a pull can't drag develop in
    expect(await git.commitsAhead(wt, "origin/develop")).toBe(0);
  });

  it("finds commits on the base that name the ticket — the exact key, not a longer one", async () => {
    const { clone } = await gitflowClone();
    const hits = await git.ticketCommits(clone, "origin/develop", "PULSEAI-414");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^[0-9a-f]{7,} PULSEAI-414: fix the null check$/);
    expect(await git.ticketCommits(clone, "origin/develop", "PULSEAI-999")).toEqual([]);
  });
});
