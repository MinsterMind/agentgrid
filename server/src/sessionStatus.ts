import { readFile, stat } from "node:fs/promises";
import { transcriptPath } from "./transcript.js";

import type { SessionPhase, SessionActivity } from "./types.js";
export type { SessionPhase, SessionActivity };

const summarise = (input: any): string => String(input?.command ?? input?.file_path ?? input?.pattern ?? input?.description ?? Object.values(input ?? {}).find(v => typeof v === "string") ?? "").slice(0, 160);

/** Pure: derive status from the parsed JSONL rows (newest last). */
export function deriveStatus(sessionId: string, rows: any[]): SessionActivity {
  const turns = rows.filter(e => (e.type === "user" || e.type === "assistant") && !e.isSidechain);
  let lastMessage = "", lastPrompt = "", updatedAt = "";
  const openTools = new Map<string, { name: string; input: any }>();
  let phase: SessionPhase = "unknown";
  for (const e of turns) {
    const c = e.message?.content; updatedAt = e.timestamp ?? updatedAt;
    if (e.type === "user") {
      if (typeof c === "string") { lastPrompt = c; phase = "working"; openTools.clear(); continue; }
      let sawResult = false, sawText = false;
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type === "tool_result") { openTools.delete(b.tool_use_id); sawResult = true; }
        if (b.type === "text" && b.text?.trim()) { lastPrompt = b.text; sawText = true; }
      }
      if (sawText && !sawResult) openTools.clear();
      phase = "working";
    } else {
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type === "text" && b.text?.trim()) lastMessage = b.text.trim();
        if (b.type === "tool_use") openTools.set(b.id, { name: b.name, input: b.input ?? {} });
      }
      phase = openTools.size > 0 ? "waiting" : e.message?.stop_reason === "end_turn" ? "idle" : "working";
    }
  }
  const out: SessionActivity = { sessionId, phase, lastMessage: lastMessage.slice(0, 2000), lastPrompt: lastPrompt.slice(0, 500), updatedAt };
  const pending = [...openTools.values()].at(-1);
  if (pending) {
    if (pending.name === "AskUserQuestion") {
      const q = pending.input?.questions?.[0];
      if (q) out.question = { text: String(q.question ?? ""), options: (q.options ?? []).map((o: any) => String(o.label ?? o)), multiSelect: Boolean(q.multiSelect) };
    } else out.pendingTool = { name: pending.name, summary: summarise(pending.input) };
  }
  return out;
}

export async function readSessionStatus(cwd: string, sessionId: string, claudeHome?: string): Promise<SessionActivity | null> {
  const file = transcriptPath(cwd, sessionId, claudeHome);
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return null;
  const rows: any[] = [];
  for (const line of raw.split("\n")) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch { /* partial line */ } }
  return deriveStatus(sessionId, rows);
}

/**
 * Polls the transcript files of watched sessions and reports status changes.
 * Cheap: only re-parses when the file's mtime/size moved.
 */
export class SessionStatusWatcher {
  private watched = new Map<string, { cwd: string; sig: string; status: SessionActivity | null }>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private onChange: (status: SessionActivity) => void, private intervalMs = 1500, private claudeHome?: string) {}

  watch(sessionId: string, cwd: string): void { if (!this.watched.has(sessionId)) this.watched.set(sessionId, { cwd, sig: "", status: null }); }
  unwatch(sessionId: string): void { this.watched.delete(sessionId); }
  get(sessionId: string): SessionActivity | null { return this.watched.get(sessionId)?.status ?? null; }
  list(): SessionActivity[] { return [...this.watched.values()].map(w => w.status).filter((s): s is SessionActivity => !!s); }

  async poll(): Promise<void> {
    for (const [sid, w] of this.watched) {
      const st = await stat(transcriptPath(w.cwd, sid, this.claudeHome)).catch(() => null);
      const sig = st ? `${st.mtimeMs}:${st.size}` : "";
      if (sig === w.sig) continue;
      w.sig = sig;
      const status = await readSessionStatus(w.cwd, sid, this.claudeHome);
      if (!status) continue;
      const changed = !w.status || w.status.phase !== status.phase || w.status.lastMessage !== status.lastMessage || JSON.stringify(w.status.question) !== JSON.stringify(status.question) || JSON.stringify(w.status.pendingTool) !== JSON.stringify(status.pendingTool);
      w.status = status;
      if (changed) this.onChange(status);
    }
  }
  start(): void { this.timer = setInterval(() => void this.poll(), this.intervalMs); this.timer.unref?.(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
