import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, realpath, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listDir, NotFoundDir, OutsideRoot, repoStatus } from "../src/fs.js";
import { execFileSync } from "node:child_process";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fs-")));
  await mkdir(path.join(root, "proj", ".git"), { recursive: true });
  await mkdir(path.join(root, "proj", "src"));
  await mkdir(path.join(root, "notes"));
  await mkdir(path.join(root, ".hidden"));
  await writeFile(path.join(root, "file.txt"), "x");
});

describe("listDir", () => {
  it("lists only visible directories, repos first then alphabetical, with parent", async () => {
    const r = await listDir(root, undefined);
    expect(r.root).toBe(root);
    expect(r.path).toBe(root);
    expect(r.parent).toBeNull();
    expect(r.entries).toEqual([
      { name: "proj", path: path.join(root, "proj"), isRepo: true },
      { name: "notes", path: path.join(root, "notes"), isRepo: false },
    ]);
  });

  it("descends and reports parent inside root", async () => {
    const r = await listDir(root, path.join(root, "proj"));
    expect(r.parent).toBe(root);
    expect(r.entries).toEqual([{ name: "src", path: path.join(root, "proj", "src"), isRepo: false }]);
  });

  it("refuses paths outside the root, including via ..", async () => {
    await expect(listDir(root, path.join(root, ".."))).rejects.toThrow(OutsideRoot);
    await expect(listDir(root, "/")).rejects.toThrow(OutsideRoot);
    await expect(listDir(root, path.join(root, "proj", "..", ".."))).rejects.toThrow(OutsideRoot);
  });

  it("404s on missing or non-directory paths", async () => {
    await expect(listDir(root, path.join(root, "nope"))).rejects.toThrow(NotFoundDir);
    await expect(listDir(root, path.join(root, "file.txt"))).rejects.toThrow(NotFoundDir);
  });
});

describe("repoStatus", () => {
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "ignore" });
  const mkRoot = async () => realpath(await mkdtemp(path.join(tmpdir(), "rs-")));

  it("names the branch of a git repo", async () => {
    const root = await mkRoot(); const repo = path.join(root, "r"); await mkdir(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x");
    expect(await repoStatus(root, repo)).toEqual({ exists: true, isRepo: true, branch: "main" });
  });

  // M-1: `git rev-parse` fails on a repo with no commits; it is still a repo.
  it("knows a brand-new repo with no commits is a repo", async () => {
    const root = await mkRoot(); const repo = path.join(root, "r"); await mkdir(repo);
    git(repo, "init", "-q", "-b", "trunk");
    expect(await repoStatus(root, repo)).toEqual({ exists: true, isRepo: true, branch: "trunk" });
  });

  it("reports a detached HEAD as no branch", async () => {
    const root = await mkRoot(); const repo = path.join(root, "r"); await mkdir(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x");
    git(repo, "checkout", "-q", "--detach");
    expect(await repoStatus(root, repo)).toEqual({ exists: true, isRepo: true, branch: null });
  });

  it("follows a worktree's .git file", async () => {
    const root = await mkRoot(); const repo = path.join(root, "r"); await mkdir(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x");
    git(repo, "worktree", "add", "-q", "-b", "feature", path.join(root, "wt"));
    expect(await repoStatus(root, path.join(root, "wt"))).toEqual({ exists: true, isRepo: true, branch: "feature" });
  });

  it("says a plain folder is not a repo, and a missing one does not exist", async () => {
    const root = await mkRoot(); await mkdir(path.join(root, "plain"));
    expect(await repoStatus(root, path.join(root, "plain"))).toEqual({ exists: true, isRepo: false, branch: null });
    expect(await repoStatus(root, path.join(root, "nope"))).toEqual({ exists: false, isRepo: false, branch: null });
  });

  it("refuses a path outside the root", async () => {
    const root = await mkRoot();
    await expect(repoStatus(root, "/etc")).rejects.toThrow(/inside/);
  });

  // M-2: a symlink under the root that points outside it is outside it.
  it("refuses a symlink that leaves the root", async () => {
    const root = await mkRoot(); const outside = await mkRoot();
    await symlink(outside, path.join(root, "link"));
    await expect(repoStatus(root, path.join(root, "link"))).rejects.toThrow(/inside/);
  });

  // C-1: a repo's own config can define commands git runs (fsmonitor, clean filters). Checking a
  // folder must never run any of them.
  it("never runs commands a repo's config defines", async () => {
    const root = await mkRoot(); const repo = path.join(root, "r"); await mkdir(repo);
    git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(repo, "f"), "x");
    git(repo, "add", "f"); git(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "x");
    // Planted after the commit, so only a later git command could run it.
    const marker = path.join(root, "PWNED");
    await writeFile(path.join(repo, ".git", "config"), `[core]\n\tfsmonitor = touch ${marker}\n[filter "x"]\n\tclean = touch ${marker}\n`, { flag: "a" });
    await mkdir(path.join(repo, ".git", "info"), { recursive: true });
    await writeFile(path.join(repo, ".git", "info", "attributes"), "* filter=x\n");
    await new Promise(r => setTimeout(r, 1100));
    await writeFile(path.join(repo, "f"), "changed");                 // stale stat: git status would rehash through the filter
    await repoStatus(root, repo);
    await expect(stat(marker)).rejects.toThrow();
  });
});
