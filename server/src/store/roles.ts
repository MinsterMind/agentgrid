import matter from "gray-matter";
import { readdir, readFile, copyFile, mkdir } from "node:fs/promises";
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

export async function ensureDefaultRoles(rolesDir: string, defaultsDir: string): Promise<void> {
  await mkdir(rolesDir, { recursive: true });
  const existing = (await readdir(rolesDir)).filter(f => f.endsWith(".md"));
  if (existing.length > 0) return;
  for (const f of (await readdir(defaultsDir)).filter(f => f.endsWith(".md"))) {
    await copyFile(path.join(defaultsDir, f), path.join(rolesDir, f));
  }
}
