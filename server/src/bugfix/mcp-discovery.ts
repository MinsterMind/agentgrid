import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeJsonParseError } from "./json-parse-error.js";

export interface McpServerFound {
  name: string;
  /** What `allowedTools` needs to name, to reach this server's tools. Never a definition. */
  toolPrefix: string;
  origin: "account" | "user" | "project" | "repo" | "settings";
  originDetail?: string;
}
export interface Discovery { servers: McpServerFound[]; problems: string[] }

/**
 * The tool prefix Claude Code exposes a server's tools under. Verified 2026-09-30 against a
 * live session: `claude.ai Claude Docs` → `mcp__claude_ai_Claude_Docs`. Naming this prefix in
 * `allowedTools` is what connects an account connector — without it the session reports the
 * server `pending` and exposes none of its tools (spec §2).
 */
export function toolPrefixFor(name: string): string {
  return `mcp__${name.replace(/^claude\.ai /, "claude_ai_").replace(/ /g, "_")}`;
}

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
  // Never surface the raw parser message here: it may embed a source excerpt straight out of a
  // credential-bearing MCP definition (see `describeJsonParseError`).
  catch (err) { problems.push(`${file} could not be parsed: ${describeJsonParseError(err)}`); return undefined; }
}

function collect(into: Map<string, McpServerFound>, servers: unknown, origin: McpServerFound["origin"], originDetail?: string): void {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
  for (const [name, definition] of Object.entries(servers as Record<string, unknown>)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
    into.set(name, { name, toolPrefix: toolPrefixFor(name), origin, ...(originDetail ? { originDetail } : {}) });
  }
}

/**
 * Every MCP server Claude Code knows about, from every scope it reads, as one list — each entry
 * carrying only the tool prefix `allowedTools` needs, never the definition itself.
 *
 * Account-level (claude.ai) connectors keep their definitions server-side: `~/.claude.json`
 * records only that they were connected, by name. They need no definition to be usable — naming
 * their tool prefix in `allowedTools` is what connects them (spec §2). They are added first, so
 * a locally defined server of the same name wins.
 *
 * Never throws, never writes. Later scopes overwrite earlier ones for the same name, so the
 * order below is least-specific first.
 */
export async function discoverMcpServers(opts: { home?: string; repo?: string }): Promise<Discovery> {
  const home = opts.home ?? os.homedir();
  const problems: string[] = [];
  const found = new Map<string, McpServerFound>();

  const claudeJson = await readJson(path.join(home, ".claude.json"), problems);

  const account = Array.isArray(claudeJson?.claudeAiMcpEverConnected) ? claudeJson.claudeAiMcpEverConnected : [];
  for (const n of account) {
    if (typeof n === "string") found.set(n, { name: n, toolPrefix: toolPrefixFor(n), origin: "account" });
  }

  const settings = await readJson(path.join(home, ".claude", "settings.json"), problems);
  collect(found, settings?.mcpServers, "settings");

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

  return { servers: [...found.values()], problems };
}
