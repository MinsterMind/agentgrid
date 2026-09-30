import { readFile } from "node:fs/promises";
import path from "node:path";
import { realQuery } from "../runner/sdk.js";
import { ISSUE_KEY, assertIssueKey } from "./git.js";
import type { TrackerConfig } from "./integrations.js";
import type { IssueSummary, TrackerIssue } from "./types.js";

export type JsonRunner = (args: { prompt: string; allowedTools: string[]; cwd: string }) => Promise<string>;

export interface TrackerProvider {
  listMyIssues(): Promise<IssueSummary[]>;
  fetchIssue(ref: string): Promise<TrackerIssue>;
  comment(key: string, text: string): Promise<void>;
}

/** Pull the first JSON value out of a model reply that may be fenced or padded with prose. */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.search(/[[{]/);
  if (start === -1) throw new Error(`tracker returned no usable JSON: ${raw.slice(0, 200)}`);
  const slice = body.slice(start);
  try { return JSON.parse(slice); } catch { /* fall through */ }
  // Trailing prose after the JSON: walk back to the last closing bracket.
  const end = Math.max(slice.lastIndexOf("}"), slice.lastIndexOf("]"));
  if (end === -1) throw new Error(`tracker returned no usable JSON: ${raw.slice(0, 200)}`);
  try { return JSON.parse(slice.slice(0, end + 1)); }
  catch { throw new Error(`tracker returned no usable JSON: ${raw.slice(0, 200)}`); }
}

export function parseIssue(raw: string): TrackerIssue {
  const o = extractJson(raw) as Record<string, unknown>;
  if (!o || typeof o !== "object" || typeof o.key !== "string" || !o.key) throw new Error(`tracker issue has no key: ${raw.slice(0, 200)}`);
  assertIssueKey(o.key); // e.g. a model echoing the preset's own "…" placeholder — the key becomes a branch name and worktree path downstream
  return {
    key: o.key, title: String(o.title ?? ""), url: String(o.url ?? ""),
    status: String(o.status ?? ""), priority: String(o.priority ?? ""),
    description: String(o.description ?? ""),
    acceptanceCriteria: Array.isArray(o.acceptanceCriteria) ? o.acceptanceCriteria.map(String) : [],
  };
}

export function parseIssueList(raw: string): IssueSummary[] {
  const arr = extractJson(raw);
  if (!Array.isArray(arr)) throw new Error(`tracker returned no list: ${raw.slice(0, 200)}`);
  return arr.filter((r): r is Record<string, unknown> =>
      !!r && typeof r === "object" && typeof (r as Record<string, unknown>).key === "string" && ISSUE_KEY.test((r as Record<string, unknown>).key as string))
    .map(r => ({ key: String(r.key), title: String(r.title ?? ""), url: String(r.url ?? ""), status: String(r.status ?? ""), priority: String(r.priority ?? "") }));
}

/** Renders `presets/tracker/<preset>.md`, split into `## section` blocks with {{placeholders}}. */
async function section(presetsDir: string, preset: string, name: string, vars: Record<string, string>): Promise<string> {
  const md = await readFile(path.join(presetsDir, "tracker", `${preset}.md`), "utf8");
  const blocks = md.split(/^## /m).slice(1);
  const block = blocks.find(b => b.split("\n")[0].trim() === name);
  if (!block) throw new Error(`tracker preset ${preset} has no "${name}" section`);
  return block.split("\n").slice(1).join("\n").trim()
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

/**
 * One-shot headless SDK query returning the model's final text. Routed through `realQuery`
 * (not the SDK's `query()` directly) so it resolves and uses the on-PATH `claude` executable
 * the same way the agent runner does — the packaged Electron app doesn't ship the SDK's bundled
 * binary, so without this every tracker call there would fail.
 */
export const defaultJsonRunner: JsonRunner = async ({ prompt, allowedTools, cwd }) => {
  let last = "";
  // No mcpServers here: naming the prefix in allowedTools is what connects a server, verified
  // 2026-09-30 through this same runner — an account connector's tool worked with no mcpServers
  // passed at all. "project" is required alongside "user": a config-defined server otherwise
  // does not load — probed directly, see the task-2 report for the probe transcript.
  for await (const m of realQuery({ prompt, options: { cwd, settingSources: ["user", "project"], model: "claude-opus-5",
      effort: "low", maxTurns: 12, allowedTools,
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } as never })) {
    if (m.type === "assistant") for (const b of (m as any).message.content) if (b.type === "text" && b.text.trim()) last = b.text;
    if (m.type === "result" && (m as any).subtype !== "success") throw new Error(`tracker query failed: ${(m as any).subtype}`);
  }
  return last;
};

/** Tracker access through whatever MCP the user has configured; prompts come from the preset file. */
export function mcpTracker(cfg: TrackerConfig, presetsDir: string, run: JsonRunner = defaultJsonRunner): TrackerProvider {
  const ask = async (name: string, vars: Record<string, string>) =>
    run({ prompt: await section(presetsDir, cfg.preset, name, { hints: cfg.hints ?? "", ...vars }),
          allowedTools: [cfg.toolPrefix], cwd: process.cwd() });
  return {
    async listMyIssues() { return parseIssueList(await ask("listMyIssues", {})); },
    async fetchIssue(ref: string) { return parseIssue(await ask("fetchIssue", { ref })); },
    async comment(key: string, text: string) { await ask("comment", { key, text }); },
  };
}
