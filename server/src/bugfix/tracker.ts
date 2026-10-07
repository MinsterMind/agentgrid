import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { realQuery } from "../runner/sdk.js";
import { stripForgeSecrets } from "../env.js";
import { ISSUE_KEY, assertIssueKey } from "./git.js";
import type { TrackerConfig } from "./integrations.js";
import type { IssueSummary, TrackerIssue } from "./types.js";

export type JsonRunner = (args: { prompt: string; allowedTools: string[]; cwd: string }) => Promise<string>;

export interface Transition { id: string; name: string; to: string }
export type TransitionResult = { ok: true; status: string } | { ok: false; error: string };

export interface TrackerProvider {
  listMyIssues(): Promise<IssueSummary[]>;
  fetchIssue(ref: string): Promise<TrackerIssue>;
  comment(key: string, text: string): Promise<void>;
  /** Many tickets in one tracker call; keys it didn't return are `missing`. Absent when the preset can't. */
  fetchIssues?(keys: string[]): Promise<{ issues: TrackerIssue[]; missing: string[] }>;
  /** The workflow moves the ticket can make right now. Absent when the preset can't (no status sync). */
  listTransitions?(key: string): Promise<Transition[]>;
  /** Move the ticket by the transition's name. Absent when the preset can't. */
  transition?(key: string, name: string): Promise<TransitionResult>;
}

/** Many tickets: one batched call when the tracker can, else (or when that call fails) one by one, at most
 *  3 at a time. Never throws; `errors` says why a ticket couldn't be read. */
export async function fetchIssuesVia(t: TrackerProvider, keys: string[]): Promise<{ issues: TrackerIssue[]; missing: string[]; errors: Record<string, string> }> {
  if (t.fetchIssues) {
    try {
      const r = await t.fetchIssues(keys);
      return { ...r, errors: Object.fromEntries(r.missing.map(k => [k, "not in the tracker's answer"])) };
    } catch { /* a failed batch (max turns, an unparseable answer): read this batch one by one instead */ }
  }
  const found = new Map<string, TrackerIssue>(); const errors: Record<string, string> = {};
  let next = 0;
  const worker = async () => { while (next < keys.length) { const k = keys[next++]; try { found.set(k, await t.fetchIssue(k)); } catch (e) { errors[k] = (e as Error).message; } } };
  await Promise.all(Array.from({ length: Math.min(3, keys.length) }, worker));
  return { issues: keys.filter(k => found.has(k)).map(k => found.get(k)!), missing: keys.filter(k => k in errors), errors };
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

/** A batch reply: the issues it holds, and which of the requested keys it lacked. */
export function parseIssues(raw: string, keys: string[]): { issues: TrackerIssue[]; missing: string[] } {
  const arr = extractJson(raw);
  if (!Array.isArray(arr)) throw new Error(`tracker returned no list: ${raw.slice(0, 200)}`);
  const issues: TrackerIssue[] = [];
  for (const o of arr) { try { issues.push(parseIssue(JSON.stringify(o))); } catch { /* skip an entry that isn't an issue */ } }
  const got = new Set(issues.map(i => i.key.toUpperCase()));
  return { issues, missing: keys.filter(k => !got.has(k.toUpperCase())) };
}

export function parseTransitions(raw: string): Transition[] {
  const arr = extractJson(raw);
  if (!Array.isArray(arr)) throw new Error(`tracker returned no transitions: ${raw.slice(0, 200)}`);
  return arr.filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof (t as Record<string, unknown>).name === "string")
    .map(t => ({ id: String(t.id ?? ""), name: String(t.name), to: String(t.to ?? t.name) }));
}

export function parseTransitionResult(raw: string): TransitionResult {
  try {
    const o = extractJson(raw) as Record<string, unknown>;
    if (o && o.ok === true) return { ok: true, status: String(o.status ?? "") };
    if (o && o.ok === false) return { ok: false, error: String(o.error ?? "the tracker refused the move") };
  } catch { /* fall through */ }
  return { ok: false, error: `the tracker gave no clear answer: ${raw.trim().slice(0, 120)}` };
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
  for await (const m of realQuery({ prompt, options: { cwd, settingSources: ["user", "project"], model: "claude-haiku-4-5-20251001",
      // `tools: []` removes every built-in tool (Bash, file writes, web): the session can only use the
      // tracker's MCP tools — it reads text anyone can write into a ticket. `env` drops forge credentials.
      effort: "low", maxTurns: 12, allowedTools, tools: [], env: stripForgeSecrets(process.env),
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } as never })) {
    if (m.type === "assistant") for (const b of (m as any).message.content) if (b.type === "text" && b.text.trim()) last = b.text;
    if (m.type === "result" && (m as any).subtype !== "success") throw new Error(`tracker query failed: ${(m as any).subtype}`);
  }
  return last;
};

/** Tracker access through whatever MCP the user has configured; prompts come from the preset file. */
/** A transition name as workflows name them — never a sentence an agent could read as an instruction. */
const PLAIN_NAME = /^[\w .\-()/&]{1,60}$/;

/**
 * Every tracker call is a `claude` process with the user's MCP servers: at most 3 at once, across
 * prefetch, batches and status moves. What a person is waiting on (their list, a ticket they opened,
 * Settings) goes ahead of background work.
 */
class Limiter {
  private running = 0;
  private waiting: Array<{ urgent: boolean; go: () => void }> = [];
  constructor(private max: number) {}
  async run<T>(urgent: boolean, fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>(go => {
      const i = urgent ? this.waiting.findIndex(w => !w.urgent) : -1;
      this.waiting.splice(i === -1 ? this.waiting.length : i, 0, { urgent, go });
    });
    else this.running++;
    try { return await fn(); }
    finally { const next = this.waiting.shift(); if (next) next.go(); else this.running--; }
  }
}

export function mcpTracker(cfg: TrackerConfig, presetsDir: string, run: JsonRunner = defaultJsonRunner): TrackerProvider {
  const limiter = new Limiter(3);
  const URGENT = new Set(["listMyIssues", "fetchIssue", "listTransitions"]);
  const ask = async (name: string, vars: Record<string, string>) => {
    const prompt = await section(presetsDir, cfg.preset, name, { hints: cfg.hints ?? "", ...vars });
    return limiter.run(URGENT.has(name), () => run({ prompt, allowedTools: [cfg.toolPrefix], cwd: process.cwd() }));
  };
  // Which optional operations this preset offers — a section per operation (spec 2026-10-08 §3.2, §4.1).
  let sections = new Set<string>();
  try { sections = new Set(readFileSync(path.join(presetsDir, "tracker", `${cfg.preset}.md`), "utf8").split(/^## /m).slice(1).map(b => b.split("\n")[0].trim())); }
  catch { /* the base sections report their own error when called */ }
  return {
    async listMyIssues() { return parseIssueList(await ask("listMyIssues", {})); },
    async fetchIssue(ref: string) { return parseIssue(await ask("fetchIssue", { ref })); },
    async comment(key: string, text: string) { await ask("comment", { key, text }); },
    ...(sections.has("fetchIssues") ? { async fetchIssues(keys: string[]) { return parseIssues(await ask("fetchIssues", { keys: keys.map(assertIssueKey).join(", ") }), keys); } } : {}),
    ...(sections.has("listTransitions") ? { async listTransitions(key: string) { return parseTransitions(await ask("listTransitions", { key: assertIssueKey(key) })); } } : {}),
    ...(sections.has("transition") ? { async transition(key: string, name: string): Promise<TransitionResult> {
      if (!PLAIN_NAME.test(name)) return { ok: false, error: `"${name.slice(0, 60)}" is not a plain transition name — pick it again in Settings → Ticket statuses` };
      return parseTransitionResult(await ask("transition", { key: assertIssueKey(key), transition: name }));
    } } : {}),
  };
}
