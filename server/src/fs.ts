import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export class OutsideRoot extends Error { status = 400; }
export class NotFoundDir extends Error { status = 404; }

export interface DirEntry { name: string; path: string; isRepo: boolean }
export interface DirListing { path: string; parent: string | null; entries: DirEntry[] }

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
  return { path: dir, parent: dir === base ? null : path.dirname(dir), entries };
}
