import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TranscriptEntry {
  ts: string; role: "user" | "assistant"; kind: "text" | "tool_use" | "tool_result"; text: string;
  /** tool_use only (full mode): tool name and its input. */
  tool?: string; input?: unknown;
}
export interface ReadOptions { claudeHome?: string; /** Everything, untruncated (default: last 200, summarised). */ full?: boolean }

export const encodeProjectDir = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

export function transcriptPath(cwd: string, sessionId: string, claudeHome = path.join(os.homedir(), ".claude")): string {
  return path.join(claudeHome, "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

const str = (c: unknown): string => typeof c === "string" ? c
  : Array.isArray(c) ? c.map(b => (b?.type === "text" ? b.text : typeof b === "string" ? b : "")).join("") : "";

export async function readTranscript(cwd: string, sessionId: string, opts: string | ReadOptions = {}): Promise<TranscriptEntry[]> {
  const { claudeHome, full = false } = typeof opts === "string" ? { claudeHome: opts } : opts;
  const raw = await readFile(transcriptPath(cwd, sessionId, claudeHome), "utf8").catch(() => "");
  const out: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "user" && e.type !== "assistant") continue;
    const role = e.type as "user" | "assistant"; const ts = e.timestamp ?? "";
    const content = e.message?.content;
    if (typeof content === "string") { out.push({ ts, role, kind: "text", text: content }); continue; }
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === "text" && b.text?.trim()) out.push({ ts, role, kind: "text", text: b.text });
      else if (b.type === "tool_use") {
        const v = b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? b.input?.description ?? "";
        const text = v ? `${b.name}: ${full ? String(v) : String(v).slice(0, 200)}` : b.name;
        out.push(full ? { ts, role, kind: "tool_use", text, tool: b.name, input: b.input ?? {} } : { ts, role, kind: "tool_use", text });
      } else if (b.type === "tool_result") { const t = str(b.content); out.push({ ts, role, kind: "tool_result", text: full ? t : t.slice(0, 500) }); }
    }
  }
  return full ? out : out.slice(-200);
}
