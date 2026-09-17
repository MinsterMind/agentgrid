import { execFile } from "node:child_process";
import { listSessions as sdkListSessions } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, SessionInfo, SessionStatus } from "./types.js";

export interface LiveSession { sessionId: string; cwd: string; name: string; kind: "interactive" | "background"; status: SessionStatus; startedAt: number; bgId?: string }
export interface HistorySession { sessionId: string; cwd: string; title: string; lastActiveAt: number }

/** Normalise `claude agents --json`: interactive rows carry `status`, background rows carry `state`. */
export function parseLiveSessions(json: string): LiveSession[] {
  let rows: unknown;
  try { rows = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const out: LiveSession[] = [];
  for (const r of rows as any[]) {
    if (typeof r?.sessionId !== "string" || typeof r?.cwd !== "string") continue;
    const kind = r.kind === "background" ? "background" : "interactive";
    const raw = String(r.status ?? r.state ?? "idle");
    const status: SessionStatus = raw === "busy" || raw === "blocked" ? raw : "idle";
    out.push({ sessionId: r.sessionId, cwd: r.cwd, name: String(r.name ?? r.sessionId.slice(0, 8)), kind, status, startedAt: Number(r.startedAt ?? 0), ...(kind === "background" && r.id ? { bgId: String(r.id) } : {}) });
  }
  return out;
}

export function listLiveSessions(): Promise<LiveSession[]> {
  return new Promise(res => execFile("claude", ["agents", "--json"], { timeout: 8000 }, (err, stdout) => res(err ? [] : parseLiveSessions(String(stdout)))));
}

export async function listHistorySessions(limit = 50): Promise<HistorySession[]> {
  const rows = await sdkListSessions({ limit }).catch(() => []);
  return rows.filter(r => r.cwd).map(r => ({ sessionId: r.sessionId, cwd: r.cwd!, title: r.customTitle || r.summary || r.firstPrompt || r.sessionId.slice(0, 8), lastActiveAt: r.lastModified }));
}

/** Live rows win; history newest-first; sessions owned by grid agents are annotated and never adoptable twice. */
export function mergeSessions(live: LiveSession[], history: HistorySession[], agents: Agent[], assignmentSessionIds: Map<string, string>): SessionInfo[] {
  const owner = new Map<string, string>();
  for (const a of agents) {
    if (a.resumeSessionId) owner.set(a.resumeSessionId, a.id);
    const sid = a.currentAssignmentId ? assignmentSessionIds.get(a.currentAssignmentId) : undefined;
    if (sid) owner.set(sid, a.id);
  }
  const seen = new Set<string>();
  const out: SessionInfo[] = [];
  for (const l of live) {
    seen.add(l.sessionId);
    const agentId = owner.get(l.sessionId);
    out.push({ sessionId: l.sessionId, cwd: l.cwd, title: l.name, kind: l.kind, status: l.status, at: l.startedAt, ...(l.bgId ? { bgId: l.bgId } : {}), ...(agentId ? { agentId } : {}), canAdopt: !agentId });
  }
  for (const h of [...history].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) {
    if (seen.has(h.sessionId)) continue;
    seen.add(h.sessionId);
    const agentId = owner.get(h.sessionId);
    out.push({ sessionId: h.sessionId, cwd: h.cwd, title: h.title, kind: "history", status: "ended", at: h.lastActiveAt, ...(agentId ? { agentId } : {}), canAdopt: !agentId });
  }
  return out;
}

export async function listAllSessions(agents: Agent[], assignmentSessionIds: Map<string, string>, deps = { live: listLiveSessions, history: listHistorySessions }): Promise<SessionInfo[]> {
  const [live, history] = await Promise.all([deps.live(), deps.history()]);
  return mergeSessions(live, history, agents, assignmentSessionIds);
}

/**
 * Polls the live session list and reports changes. `snapshot()` is the last known list,
 * annotated against the current agents by the caller-supplied `annotate`.
 */
export class LiveSessionWatcher {
  private last: LiveSession[] = [];
  private timer: NodeJS.Timeout | null = null;
  constructor(private fetch: () => Promise<LiveSession[]>, private onChange: (live: LiveSession[]) => void, private intervalMs = 5000) {}
  get current(): LiveSession[] { return this.last; }
  isLive(sessionId: string): boolean { return this.last.some(s => s.sessionId === sessionId); }
  async poll(): Promise<void> {
    const next = await this.fetch().catch(() => this.last);
    if (JSON.stringify(next) !== JSON.stringify(this.last)) { this.last = next; this.onChange(next); }
  }
  start(): void { void this.poll(); this.timer = setInterval(() => void this.poll(), this.intervalMs); this.timer.unref?.(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
