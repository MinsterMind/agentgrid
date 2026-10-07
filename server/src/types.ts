export type { BugTask } from "./bugfix/types.js";
import type { BugTask, IssueSummary, TrackerIssue } from "./bugfix/types.js";

export type AgentState = "free" | "working" | "waiting" | "done" | "failed";
export type AssignmentState = Exclude<AgentState, "free">;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";
export type SettingSource = "user" | "project" | "local";

export interface RoleDef {
  /** One line on what this role does — shown on the New agent dialog's role cards. */
  description: string;
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

/** `suggestedRule`: what "Always allow" saves (permissions/rules.ts); `ruleIsBroad`: it would allow every command or file change. Questions carry "" / false. */
export type Pending =
  | { kind: "permission"; toolUseId: string; toolName: string; input: Record<string, unknown>; suggestions: unknown[]; suggestedRule: string; ruleIsBroad: boolean }
  | { kind: "question";   toolUseId: string; toolName: "AskUserQuestion"; input: Record<string, unknown>; suggestions: unknown[]; suggestedRule: string; ruleIsBroad: boolean };

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
  /** The pull request this task names, as last read from the forge (see agentpr.ts). */
  pr?: AgentPr;
}

/** A task's pull request. `note` says why there is no status; `reviewedSha` is the head the finished run reviewed. */
export interface AgentPr {
  number: number; url?: string;
  state?: "OPEN" | "MERGED" | "CLOSED"; reviewDecision?: string | null; checks?: string | null;
  headSha?: string | null; reviewedSha?: string; note?: string;
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
  | { type: "session-status"; status: SessionActivity }
  | { type: "bugtask"; task: BugTask }
  | { type: "bugtask-removed"; id: string }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission-settled"; id: string }
  | { type: "tracker-issues"; list: IssueList }
  | { type: "tracker-issue"; issue: TrackerIssue }
  | { type: "batch"; state: BatchState };

/** A "start many" run (spec 2026-10-08 §5.2): where it is, and what happened to each ticket. */
export interface BatchState {
  batchId: string; total: number; done: number;
  started: Array<{ key: string; taskId: string }>;
  skipped: Array<{ key: string; message: string }>;
  failed: Array<{ key: string; message: string }>;
  finished: boolean;
}

/** My open bugs, as the tracker cache holds them (spec 2026-10-08 §3.3): answered at once, refreshed behind the scenes. */
export interface IssueList { issues: IssueSummary[]; fetchedAt: string | null; refreshing: boolean; error: string | null;
  /** Bumped when the cache is cleared (a tracker change): a client keeps the list with the highest generation. */ generation: number }

export interface GridState { roles: RoleDef[]; agents: Agent[]; assignments: Assignment[]; liveSessions: SessionInfo[]; sessionStatuses: SessionActivity[]; bugTasks: BugTask[]; permissions: PermissionRequest[] }

/** A permission request from an embedded terminal session, waiting on a human in AgentGrid (see permissions/broker.ts).
 *  `suggestedRule` is what "Always allow" would save; `ruleIsBroad` means it would allow every command or file change. */
export interface PermissionRequest {
  id: string; agentId: string; source: "sdk" | "terminal"; sessionId: string | null;
  toolName: string; input: Record<string, unknown>; suggestedRule: string; ruleIsBroad: boolean; createdAt: string;
}

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
  /** The tool the session is running right now. Not a prompt: whether Claude Code is asking comes from the PermissionRequest hook. */
  runningTool?: { name: string; summary: string };
  updatedAt: string;
}
