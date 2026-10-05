import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export class OutsideRoot extends Error { status = 400; }
export class NotFoundDir extends Error { status = 404; }

import type { DirEntry, DirListing } from "./types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
export type { DirEntry, DirListing };

/** List the subdirectories of `target` (default: root), confined to `root`. Hidden dirs are skipped; git repos sort first. */
export async function listDir(root: string, target: string | undefined): Promise<DirListing> {
  const base = path.resolve(root);
  const dir = path.resolve(target ?? base);
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new OutsideRoot(`path must be inside ${base}`);

  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new NotFoundDir(`not a directory: ${dir}`);

  const entries: DirEntry[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const full = path.join(dir, d.name);
    const isRepo = await stat(path.join(full, ".git")).then(s => s.isDirectory(), () => false);
    entries.push({ name: d.name, path: full, isRepo });
  }
  entries.sort((a, b) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name));
  return { root: base, path: dir, parent: dir === base ? null : path.dirname(dir), entries };
}

const exec = promisify(execFile);
type Runner = (cmd: string, args: string[], cwd: string) => Promise<string>;
const defaultRun: Runner = async (cmd, args, cwd) => (await exec(cmd, args, { cwd, timeout: 5_000 })).stdout;

/** What the New agent dialog says about a folder: there, a git repo, which branch, clean or not.
 *  Confined to the browse root exactly as `listDir` is. */
export async function repoStatus(root: string, target: string, run: Runner = defaultRun):
  Promise<{ exists: boolean; isRepo: boolean; branch: string | null; clean: boolean | null }> {
  const base = path.resolve(root); const dir = path.resolve(target);
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new OutsideRoot(`path must be inside ${base}`);
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return { exists: false, isRepo: false, branch: null, clean: null };
  try {
    const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir)).trim();
    const dirty = (await run("git", ["status", "--porcelain"], dir)).trim().length > 0;
    return { exists: true, isRepo: true, branch, clean: !dirty };
  } catch {
    return { exists: true, isRepo: false, branch: null, clean: null };
  }
}
