import { readdir, stat, realpath, readFile } from "node:fs/promises";
import path from "node:path";

export class OutsideRoot extends Error { status = 400; }
export class NotFoundDir extends Error { status = 404; }

import type { DirEntry, DirListing } from "./types.js";
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


/** What the New agent dialog says about a folder: there, a git repo, which branch.
 *
 *  It never runs git. A repo's own config can define commands git executes (core.fsmonitor, a
 *  clean filter on `git status`), and this route can be reached for any folder under the browse
 *  root — reading `.git/HEAD` answers the question with no process at all. Confined to the browse
 *  root exactly as `listDir` is, after resolving symlinks, so a link cannot step outside it. */
export async function repoStatus(root: string, target: string): Promise<{ exists: boolean; isRepo: boolean; branch: string | null }> {
  const base = await realpath(path.resolve(root)).catch(() => path.resolve(root));
  const resolved = path.resolve(target);
  const dir = await realpath(resolved).catch(() => resolved);
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new OutsideRoot(`path must be inside ${base}`);
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return { exists: false, isRepo: false, branch: null };
  const head = await readHead(dir);
  if (head === undefined) return { exists: true, isRepo: false, branch: null };
  return { exists: true, isRepo: true, branch: head };
}

/** The branch HEAD names (null when detached), or undefined when `dir` is not a repo's root.
 *  Handles a worktree, whose `.git` is a file pointing at its real git dir. */
async function readHead(dir: string): Promise<string | null | undefined> {
  const dotGit = path.join(dir, ".git");
  const st = await stat(dotGit).catch(() => null);
  if (!st) return undefined;
  let gitDir = dotGit;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8").catch(() => ""));
    if (!m) return undefined;
    gitDir = path.resolve(dir, m[1].trim());
  }
  const headText = await readFile(path.join(gitDir, "HEAD"), "utf8").catch(() => null);
  if (headText === null) return undefined;
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(headText);
  return ref ? ref[1].trim() : null;
}
