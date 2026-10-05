import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
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
  it("reports branch and cleanliness of a git repo", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rs-")); const repo = path.join(root, "r"); await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
    expect(await repoStatus(root, repo)).toEqual({ exists: true, isRepo: true, branch: "main", clean: true });
    await writeFile(path.join(repo, "f"), "x");
    expect((await repoStatus(root, repo)).clean).toBe(false);
  });
  it("says a plain folder is not a repo, and a missing one does not exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rs-")); await mkdir(path.join(root, "plain"));
    expect(await repoStatus(root, path.join(root, "plain"))).toEqual({ exists: true, isRepo: false, branch: null, clean: null });
    expect(await repoStatus(root, path.join(root, "nope"))).toEqual({ exists: false, isRepo: false, branch: null, clean: null });
  });
  it("refuses a path outside the root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rs-"));
    await expect(repoStatus(root, "/etc")).rejects.toThrow(/inside/);
  });
});
