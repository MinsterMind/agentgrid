import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listDir, NotFoundDir, OutsideRoot } from "../src/fs.js";

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
