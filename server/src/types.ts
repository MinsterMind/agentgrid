export type AgentState = "free" | "working" | "waiting" | "done" | "failed";
export type AssignmentState = Exclude<AgentState, "free">;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";
export type SettingSource = "user" | "project" | "local";

export interface RoleDef {
  name: string;
  avatar: string;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  settingSources: SettingSource[];
  allowedTools: string[];
  maxTurns: number;
  maxBudgetUsd?: number;
  prompt: string; // markdown body = persona/system prompt
}

export interface Agent {
  id: string;            // "<role>@<repoBasename>[-n]"
  role: string;
  repo: string;          // absolute path
  displayName: string;
  createdAt: string;     // ISO
  state: AgentState;
  currentAssignmentId: string | null;
  /** When set, every assignment resumes this Claude Code session instead of starting fresh (adopted sessions). */
  resumeSessionId?: string;
}

export type Pending =
  | { kind: "permission"; toolUseId: string; toolName: string; input: Record<string, unknown>; suggestions: unknown[] }
  | { kind: "question";   toolUseId: string; toolName: "AskUserQuestion"; input: Record<string, unknown>; suggestions: unknown[] };

export interface Assignment {
  id: string;            // "a<n>"
  agentId: string;
  prompt: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  sessionId: string | null;
  state: AssignmentState;
  activity: string;
  pending: Pending | null;
  outcome: string | null;
  error: string | null;
  turns: number;
  costUsd: number;
}

export type Decision =
  | { kind: "allow" }
  | { kind: "always" }
  | { kind: "deny"; message?: string }
  | { kind: "answers"; answers: Record<string, string>; response?: string };

export interface MemoryFile { file: string; name: string; description: string }

export type GridEvent =
  | { type: "agent"; agent: Agent }
  | { type: "agent-removed"; id: string }
  | { type: "assignment"; assignment: Assignment }
  | { type: "roles"; roles: RoleDef[] }
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "session-status"; status: SessionActivity };

export interface GridState { roles: RoleDef[]; agents: Agent[]; assignments: Assignment[]; liveSessions: SessionInfo[]; sessionStatuses: SessionActivity[] }

export interface DirEntry { name: string; path: string; isRepo: boolean }
export interface DirListing { root: string; path: string; parent: string | null; entries: DirEntry[] }

export type SessionKind = "interactive" | "background" | "history";
export type SessionStatus = "busy" | "idle" | "blocked" | "ended";
export interface SessionInfo {
  sessionId: string;
  cwd: string;
  title: string;
  kind: SessionKind;
  status: SessionStatus;
  /** Live: process start; history: last activity. Epoch ms. */
  at: number;
  /** Background sessions: the short id `claude attach` takes. */
  bgId?: string;
  /** Set when a grid agent owns this session (adopted, or produced by an assignment). */
  agentId?: string;
  /** "grid" when the live process is AgentGrid's own embedded terminal (reconnectable, never a foreign terminal). */
  owner?: "grid";
  canAdopt: boolean;
}

export type SessionPhase = "working" | "waiting" | "idle" | "unknown";
/** Live activity of a session derived from its transcript (works for embedded-terminal sessions too). */
export interface SessionActivity {
  sessionId: string;
  phase: SessionPhase;
  lastMessage: string;
  lastPrompt: string;
  question?: { text: string; options: string[]; multiSelect: boolean };
  pendingTool?: { name: string; summary: string };
  updatedAt: string;
}
