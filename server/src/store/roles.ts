import matter from "gray-matter";
import { readdir, readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RoleDef } from "../types.js";

export function parseRole(markdown: string, fallbackName: string): RoleDef {
  const { data, content } = matter(markdown);
  if (typeof data.model !== "string" || !data.model) {
    throw new Error(`role "${data.name ?? fallbackName}": model is required`);
  }
  return {
    name: String(data.name ?? fallbackName),
    avatar: String(data.avatar ?? "🤖"),
    model: data.model,
    effort: data.effort ?? "high",
    permissionMode: data.permissionMode ?? "default",
    settingSources: data.settingSources ?? ["user", "project"],
    allowedTools: data.allowedTools ?? [],
    maxTurns: Number(data.maxTurns ?? 100),
    ...(data.maxBudgetUsd !== undefined ? { maxBudgetUsd: Number(data.maxBudgetUsd) } : {}),
    prompt: content.trim(),
    description: typeof data.description === "string" && data.description.trim()
      ? data.description.trim()
      : (content.trim().match(/^[^.!?\n]*[.!?]/)?.[0] ?? "").trim(),
  };
}

export async function loadRoles(rolesDir: string): Promise<RoleDef[]> {
  const files = (await readdir(rolesDir)).filter(f => f.endsWith(".md")).sort();
  const roles: RoleDef[] = [];
  for (const f of files) {
    roles.push(parseRole(await readFile(path.join(rolesDir, f), "utf8"), f.replace(/\.md$/, "")));
  }
  return roles;
}

/** Which default roles this dir has already been given, so each is copied exactly once. */
const SEEDED_MANIFEST = ".seeded-defaults.json";
/**
 * What every install seeded before the manifest existed received: the defaults as of the first
 * release (2026-09-12). A dir with roles but no manifest got exactly these, so any default not in
 * this list (`bugfix`, added 2026-09-25) is new to it — and one of these that is missing was
 * deleted by the user, and stays deleted.
 */
const LEGACY_SEEDED = ["architect.md", "coder.md", "demo-prep.md", "devops.md", "reviewer.md", "tester.md"];

/**
 * Copies each default role into `rolesDir` once. Seeding used to run only into an empty dir, so a
 * role shipped after someone's first run never reached them — and the bug-fix workflow, which
 * needs `bugfix`, failed on every machine set up before it existed. A default already copied is
 * never copied again (a deletion sticks), and a file the user already has is never overwritten.
 */
export async function ensureDefaultRoles(rolesDir: string, defaultsDir: string): Promise<void> {
  await mkdir(rolesDir, { recursive: true });
  const existing = (await readdir(rolesDir)).filter(f => f.endsWith(".md"));
  const defaults = (await readdir(defaultsDir)).filter(f => f.endsWith(".md"));
  const manifest = path.join(rolesDir, SEEDED_MANIFEST);
  let seeded: string[];
  try { seeded = JSON.parse(await readFile(manifest, "utf8")) as string[]; }
  catch { seeded = existing.length === 0 ? [] : LEGACY_SEEDED; }
  const fresh = defaults.filter(f => !seeded.includes(f));
  if (fresh.length === 0 && seeded.length > 0) return;
  for (const f of fresh) {
    if (!existing.includes(f)) await copyFile(path.join(defaultsDir, f), path.join(rolesDir, f));
  }
  await writeFile(manifest, JSON.stringify([...new Set([...seeded, ...defaults])].sort(), null, 2));
}
