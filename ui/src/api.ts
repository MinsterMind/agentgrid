import type { TrackerIssue } from "./types";
import type { Agent, Assignment, BugTask, Decision, DirListing, GridEvent, GridState, Integrations, IssueSummary, MemoryFile, SessionInfo, SetupReport } from "./types";

export interface TranscriptEntry { ts: string; role: "user" | "assistant"; kind: "text" | "tool_use" | "tool_result"; text: string; tool?: string; input?: unknown }

/**
 * Thrown by `call` on a non-2xx response, or when the request never reached the server.
 * Carries the HTTP status so callers can tell failure modes apart — for the bugfix routes
 * in particular: 409 means someone else already acted on this task, 501 means the bugfix
 * workflow isn't wired on this server, and the sentinel 0 means the request never left the
 * browser (offline, DNS, CORS — there is no real HTTP status to report). Task 13's panel
 * should say something different for each.
 */
export class ApiError extends Error { constructor(message: string, public status: number, options?: ErrorOptions, public code?: string) { super(message, options); } }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch (cause) {
    throw new ApiError("request never reached the server", 0, { cause });
  }
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new ApiError(b.error ?? `${res.status} ${res.statusText}`, res.status, undefined, typeof b.code === "string" ? b.code : undefined); }
  return res.status === 204 ? (undefined as T) : res.json();
}

export type MergeMethod = "squash" | "merge" | "rebase";

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
  say: (id: string, text: string) => call<{ via: "terminal" | "assignment" }>("POST", `/api/agents/${encodeURIComponent(id)}/say`, { text }),
  issue: (key: string) => call<TrackerIssue>("GET", `/api/bugfix/issues/${encodeURIComponent(key)}`),
  listRules: () => call<{ rules: Array<{ rule: string; addedAt: string }>; problem: string | null }>("GET", "/api/permissions/rules"),
  removeRule: (rule: string) => call<{ rules: Array<{ rule: string; addedAt: string }>; problem: string | null }>("DELETE", "/api/permissions/rules", { rule }),
  rereview: (id: string) => call<Assignment>("POST", `/api/agents/${encodeURIComponent(id)}/rereview`),
  resetSession: (id: string) => call<Agent>("POST", `/api/agents/${encodeURIComponent(id)}/reset`),
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
  listBugTasks: () => call<BugTask[]>("GET", "/api/bugtasks"),
  createBugTask: (input: { issueRef: string; repo: string; mergePolicy?: "ask" | "auto"; mergeMethod?: string; baseBranch?: string; startAnyway?: boolean }) => call<BugTask>("POST", "/api/bugtasks", input),
  resolveConflicts: () => call<{ ids: string[] }>("POST", "/api/bugtasks/resolve-conflicts"),
  overrideTests: (id: string, reason: string) => call<BugTask>("POST", `/api/bugtasks/${encodeURIComponent(id)}/override-tests`, { reason }),
  closeBugNoChange: (id: string) => call<BugTask>("POST", `/api/bugtasks/${encodeURIComponent(id)}/close-no-change`),
  bugPlan: (id: string) => call<{ markdown: string }>("GET", `/api/bugtasks/${encodeURIComponent(id)}/plan`),
  bugDiff: (id: string) => call<{ patch: string; files: Array<{ path: string; additions: number; deletions: number }>; additions: number; deletions: number }>("GET", `/api/bugtasks/${encodeURIComponent(id)}/diff`),
  approveBug: (id: string, mergeMethod?: MergeMethod) => call<BugTask>("POST", `/api/bugtasks/${encodeURIComponent(id)}/approve`, mergeMethod ? { mergeMethod } : undefined),
  requestBugChanges: (id: string, text: string) => call<BugTask>("POST", `/api/bugtasks/${encodeURIComponent(id)}/request-changes`, { text }),
  cancelBug: (id: string) => call<BugTask>("POST", `/api/bugtasks/${encodeURIComponent(id)}/cancel`),
  retryBug: (id: string) => call<BugTask>("POST", `/api/bugtasks/${encodeURIComponent(id)}/retry`),
  addressComments: (id: string, text?: string) => call<BugTask>("POST", `/api/bugtasks/${encodeURIComponent(id)}/address-comments`, text ? { text } : undefined),
  dismissBug: (id: string) => call<void>("DELETE", `/api/bugtasks/${encodeURIComponent(id)}`),
  myIssues: () => call<IssueSummary[]>("GET", "/api/bugfix/issues"),
  repoStatus: (path: string) => call<{ exists: boolean; isRepo: boolean; branch: string | null }>("GET", `/api/repo-status?path=${encodeURIComponent(path)}`),
  bugPreflight: (repo: string) => call<{ ok: boolean; problems: string[]; remote?: string | null; baseBranch?: string | null; branches?: string[] }>("GET", `/api/bugfix/preflight?repo=${encodeURIComponent(repo)}`),
  getIntegrations: () => call<Integrations>("GET", "/api/integrations"),
  putIntegrations: (patch: Partial<Integrations>) => call<Integrations>("PUT", "/api/integrations", patch),
  getSetup: () => call<SetupReport>("GET", "/api/setup"),
  testTracker: () => call<{ ok: boolean; message: string }>("POST", "/api/setup/test/tracker"),
  testForge: () => call<{ ok: boolean; message: string }>("POST", "/api/setup/test/forge"),
};
