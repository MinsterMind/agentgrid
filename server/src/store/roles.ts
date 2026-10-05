import matter from "gray-matter";
import { readdir, readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RoleDef } from "../types.js";

/**
 * A role without a `description` (one written before they existed, or by hand) still gets a
 * readable line: the prompt's first sentence, skipping headings and list markers, where a sentence
 * ends at . ! ? followed by whitespace or the end — so "e.g." and "v2.0" do not cut it short —
 * and capped so a run-on first line stays a line.
 */
function firstSentence(content: string): string {
  const line = content.split("\n").map(l => l.trim()).find(l => l && !/^#{1,6}\s/.test(l)) ?? "";
  const text = line.replace(/^([-*+]|\d+[.)])\s+/, "");
  const m = /^.*?[.!?](?=\s+[A-Z]|$)/.exec(text);
  const out = (m ? m[0] : text).trim();
  return out.length > 120 ? out.slice(0, 119).trimEnd() + "…" : out;
}

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
    description: typeof data.description === "string" && data.description.trim() ? data.description.trim() : firstSentence(content),
  };
}

export async function loadRoles(rolesDir: string, defaultsDir?: string): Promise<RoleDef[]> {
  const files = (await readdir(rolesDir)).filter(f => f.endsWith(".md")).sort();
  // A role copied from a shipped default before descriptions existed is never overwritten
  // (`ensureDefaultRoles`), so it would only ever show the prompt fallback. Give it the shipped line.
  const shipped = new Map<string, string>();
  if (defaultsDir) {
    for (const f of (await readdir(defaultsDir).catch(() => [] as string[])).filter(f => f.endsWith(".md"))) {
      const d = matter(await readFile(path.join(defaultsDir, f), "utf8")).data.description;
      if (typeof d === "string" && d.trim()) shipped.set(f.replace(/\.md$/, ""), d.trim());
    }
  }
  const roles: RoleDef[] = [];
  for (const f of files) {
    const md = await readFile(path.join(rolesDir, f), "utf8");
    const role = parseRole(md, f.replace(/\.md$/, ""));
    const own = matter(md).data.description;
    if (!(typeof own === "string" && own.trim()) && shipped.has(role.name)) role.description = shipped.get(role.name)!;
    roles.push(role);
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
