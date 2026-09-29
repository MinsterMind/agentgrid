import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface McpServerFound {
  name: string;
  /** Copied verbatim from Claude Code's own config. May contain credentials — never log it. */
  definition: Record<string, unknown>;
  origin: "user" | "project" | "repo" | "settings";
  originDetail?: string;
}
export interface Discovery { importable: McpServerFound[]; accountOnly: string[]; problems: string[] }

/** Reads one JSON file. A missing file is `undefined`; an unreadable one is a reported problem. */
async function readJson(file: string, problems: string[]): Promise<any | undefined> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (err) {
    // Absent is normal — most machines have no repo-scoped .mcp.json, and many have no
    // ~/.claude at all. Anything else (EACCES, EISDIR) is a file we were meant to read and
    // could not: saying "nothing found" there would state something false.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      problems.push(`${file} could not be read: ${(err as Error).message}`);
    }
    return undefined;
  }
  try { return JSON.parse(raw); }
  catch (err) { problems.push(`${file} could not be parsed: ${(err as Error).message}`); return undefined; }
}

function collect(into: Map<string, McpServerFound>, servers: unknown, origin: McpServerFound["origin"], originDetail?: string): void {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
  for (const [name, definition] of Object.entries(servers as Record<string, unknown>)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
    into.set(name, { name, definition: definition as Record<string, unknown>, origin, ...(originDetail ? { originDetail } : {}) });
  }
}

/**
 * Everything Claude Code stores about MCP servers that is readable from disk.
 *
 * Account-level (claude.ai) connectors keep their definitions server-side: `~/.claude.json`
 * records only that they were connected, by name, so they can be reported but never imported.
 * Verified 2026-09-29 — see the spec's §3.
 *
 * Never throws, never writes. Later scopes overwrite earlier ones for the same name, so the
 * order below is least-specific first.
 */
export async function discoverMcpServers(opts: { home?: string; repo?: string }): Promise<Discovery> {
  const home = opts.home ?? os.homedir();
  const problems: string[] = [];
  const found = new Map<string, McpServerFound>();

  const settings = await readJson(path.join(home, ".claude", "settings.json"), problems);
  collect(found, settings?.mcpServers, "settings");

  const claudeJson = await readJson(path.join(home, ".claude.json"), problems);
  collect(found, claudeJson?.mcpServers, "user");

  const projects = claudeJson?.projects;
  if (projects && typeof projects === "object") {
    for (const [dir, entry] of Object.entries(projects as Record<string, any>)) {
      collect(found, entry?.mcpServers, "project", dir);
    }
  }

  if (opts.repo) {
    const repoConfig = await readJson(path.join(opts.repo, ".mcp.json"), problems);
    collect(found, repoConfig?.mcpServers, "repo", opts.repo);
  }

  const accountOnly = Array.isArray(claudeJson?.claudeAiMcpEverConnected)
    ? claudeJson.claudeAiMcpEverConnected.filter((n: unknown): n is string => typeof n === "string" && !found.has(n))
    : [];

  return { importable: [...found.values()], accountOnly, problems };
}
