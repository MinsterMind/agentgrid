import type { Agent, Assignment, Decision, DirListing, GridEvent, GridState, MemoryFile, SessionInfo } from "./types";

export interface TranscriptEntry { ts: string; role: "user" | "assistant"; kind: "text" | "tool_use" | "tool_result"; text: string; tool?: string; input?: unknown }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status} ${res.statusText}`);
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  getState: () => call<GridState>("GET", "/api/state"),
  subscribe(onSnapshot: (s: GridState) => void, onChange: (e: GridEvent) => void, onConnected: (v: boolean) => void): () => void {
    const es = new EventSource("/api/events");
    es.addEventListener("snapshot", ev => { onConnected(true); onSnapshot(JSON.parse((ev as MessageEvent).data)); });
    es.addEventListener("change", ev => onChange(JSON.parse((ev as MessageEvent).data)));
    es.onerror = () => onConnected(false);
    return () => es.close();
  },
  createAgent: (input: { role: string; repo: string; displayName?: string }) => call<Agent>("POST", "/api/agents", input),
  deleteAgent: (id: string) => call<void>("DELETE", `/api/agents/${encodeURIComponent(id)}`),
  assign: (id: string, prompt: string) => call<Assignment>("POST", `/api/agents/${encodeURIComponent(id)}/assign`, { prompt }),
  answer: (id: string, toolUseId: string, decision: Decision) => call<void>("POST", `/api/agents/${encodeURIComponent(id)}/answer`, { toolUseId, decision }),
  cancel: (id: string) => call<void>("POST", `/api/agents/${encodeURIComponent(id)}/cancel`),
  ack: (id: string) => call<void>("POST", `/api/agents/${encodeURIComponent(id)}/ack`),
  openTerminal: (id: string) => call<{ command: string; opened: boolean }>("POST", `/api/agents/${encodeURIComponent(id)}/open-terminal`),
  memory: (id: string) => call<MemoryFile[]>("GET", `/api/agents/${encodeURIComponent(id)}/memory`),
  listSessions: () => call<SessionInfo[]>("GET", "/api/sessions"),
  adoptSession: (sessionId: string, input: { role: string; displayName?: string; takeover?: boolean }) => call<Agent>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/adopt`, input),
  getSession: (sessionId: string) => call<SessionInfo>("GET", `/api/sessions/${encodeURIComponent(sessionId)}`),
  renameSession: (sessionId: string, title: string) => call<void>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/rename`, { title }),
  attachSession: (sessionId: string) => call<{ command: string; opened: boolean }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/attach`),
  pickFolder: () => call<{ path: string } | undefined>("POST", "/api/fs/pick"),
  listDir: (path?: string) => call<DirListing>("GET", `/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  agentTranscript: (agentId: string) => call<{ sessionId: string | null; entries: TranscriptEntry[] }>("GET", `/api/agents/${encodeURIComponent(agentId)}/transcript`),
  transcript: (assignmentId: string) => call<Array<{ ts: string; role: string; kind: string; text: string }>>("GET", `/api/assignments/${assignmentId}/transcript`),
};
