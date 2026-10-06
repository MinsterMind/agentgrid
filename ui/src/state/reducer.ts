import { attention } from "./attention";
import type { Agent, AgentState, Assignment, BugTask, GridEvent, GridState, PermissionRequest, RoleDef, SessionInfo, SessionActivity } from "../types";

export interface UiState { roles: RoleDef[]; agents: Agent[]; assignments: Record<string, Assignment>; liveSessions: SessionInfo[]; activity: Record<string, SessionActivity>; bugTasks: Record<string, BugTask>; /** Open permission requests from embedded terminals, by id. */ permissions: Record<string, PermissionRequest>; selectedId: string | null; connected: boolean; /** A snapshot has arrived: until then, "no agents" means "not known yet". */ loaded: boolean }
export type Action =
  | { type: "snapshot"; state: GridState }
  | { type: "change"; event: GridEvent }
  | { type: "select"; id: string | null }
  | { type: "connected"; value: boolean };

export const initial: UiState = { roles: [], agents: [], assignments: {}, liveSessions: [], activity: {}, bugTasks: {}, permissions: {}, selectedId: null, connected: false, loaded: false };

export function reducer(s: UiState, a: Action): UiState {
  switch (a.type) {
    case "snapshot":
      return { ...s, loaded: true, roles: a.state.roles, agents: a.state.agents,
        assignments: Object.fromEntries(a.state.assignments.map(x => [x.id, x])),
        liveSessions: a.state.liveSessions ?? [],
        activity: Object.fromEntries((a.state.sessionStatuses ?? []).map(x => [x.sessionId, x])),
        bugTasks: Object.fromEntries((a.state.bugTasks ?? []).map(t => [t.id, t])),
        permissions: Object.fromEntries((a.state.permissions ?? []).map(r => [r.id, r])),
        selectedId: a.state.agents.some(x => x.id === s.selectedId) ? s.selectedId : null };
    case "change": {
      const e = a.event;
      if (e.type === "roles") return { ...s, roles: e.roles };
      if (e.type === "sessions") return { ...s, liveSessions: e.sessions };
      if (e.type === "session-status") return { ...s, activity: { ...s.activity, [e.status.sessionId]: e.status } };
      if (e.type === "assignment") return { ...s, assignments: { ...s.assignments, [e.assignment.id]: e.assignment } };
      if (e.type === "agent-removed") return { ...s, agents: s.agents.filter(x => x.id !== e.id), selectedId: s.selectedId === e.id ? null : s.selectedId };
      if (e.type === "bugtask") return { ...s, bugTasks: { ...s.bugTasks, [e.task.id]: e.task } };
      if (e.type === "permission") return { ...s, permissions: { ...s.permissions, [e.request.id]: e.request } };
      if (e.type === "permission-settled") { const { [e.id]: _gone, ...permissions } = s.permissions; return { ...s, permissions }; }
      if (e.type === "bugtask-removed") { const { [e.id]: _drop, ...bugTasks } = s.bugTasks; return { ...s, bugTasks }; }
      const i = s.agents.findIndex(x => x.id === e.agent.id);
      const agents = i === -1 ? [...s.agents, e.agent] : s.agents.map((x, j) => (j === i ? e.agent : x));
      return { ...s, agents };
    }
    case "select": return { ...s, selectedId: a.id };
    case "connected": return { ...s, connected: a.value };
  }
}

export const assignmentFor = (s: UiState, agent: Agent): Assignment | null =>
  agent.currentAssignmentId ? s.assignments[agent.currentAssignmentId] ?? null : null;

export const counts = (s: UiState): Record<AgentState, number> => {
  const c: Record<AgentState, number> = { free: 0, working: 0, waiting: 0, done: 0, failed: 0 };
  for (const a of s.agents) c[a.state]++;
  return c;
};

export const todaySpend = (s: UiState, now = new Date()): number => {
  const today = now.toDateString();
  return Object.values(s.assignments).filter(a => new Date(a.createdAt).toDateString() === today).reduce((n, a) => n + a.costUsd, 0);
};

/** Agents that need you, for any reason (see attention.ts) — what NEEDS YOU counts and N cycles through. */
/** The oldest open permission request from this agent's embedded terminal, if any. */
export const permissionFor = (s: UiState, agent: Agent): PermissionRequest | null =>
  Object.values(s.permissions).filter(r => r.agentId === agent.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
export const needsYou = (s: UiState, agent: Agent): boolean => attention(agent, assignmentFor(s, agent), activityFor(s, agent), permissionFor(s, agent)) !== null;
export const waitingIds = (s: UiState): string[] => s.agents.filter(a => needsYou(s, a)).map(a => a.id);

/** Live sessions not yet represented by a grid agent — shown as ghost tiles. */
export const unclaimedLiveSessions = (s: UiState): SessionInfo[] => {
  const owned = new Set<string>();
  for (const a of s.agents) if (a.resumeSessionId) owned.add(a.resumeSessionId);
  for (const x of Object.values(s.assignments)) if (x.sessionId) owned.add(x.sessionId);
  return s.liveSessions.filter(l => !l.agentId && !owned.has(l.sessionId) && l.owner !== "grid");
};

/** The live session an adopted agent is bound to, if its process is running *outside* the grid (our own embedded terminal doesn't count). */
export const liveSessionFor = (s: UiState, agent: Agent): SessionInfo | null =>
  agent.resumeSessionId ? s.liveSessions.find(l => l.sessionId === agent.resumeSessionId && l.owner !== "grid") ?? null : null;

/** The session an agent is "about" right now: its running assignment's, else the adopted one, else its latest finished one. */
export const sessionIdFor = (s: UiState, agent: Agent): string | null => {
  const cur = agent.currentAssignmentId ? s.assignments[agent.currentAssignmentId] : null;
  if (cur?.sessionId) return cur.sessionId;
  if (agent.resumeSessionId) return agent.resumeSessionId;
  return Object.values(s.assignments).filter(a => a.agentId === agent.id && a.sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.sessionId ?? null;
};
export const activityFor = (s: UiState, agent: Agent): SessionActivity | null => { const sid = sessionIdFor(s, agent); return sid ? s.activity[sid] ?? null : null; };

// "cancelled" has no card of its own in BugPanel — nothing to show, so it stays hidden the
// moment it lands, exactly like before. "done" is different: it has its own card (Merged /
// Closed without merging) with the Dismiss button that actually clears it, so hiding it here
// too would take the card away in the same tick it appears — before a human could ever see or
// dismiss it. It stays visible until dismissed, which removes it from the store outright.
const HIDDEN_BUG_STAGES = ["cancelled"];
/** The bug task an agent is currently working, if any — preferring an active task over a
 *  `done` one lingering on the same (now reused) agent, so a fresh assignment isn't shadowed
 *  by a stale card the human just hasn't dismissed yet. */
export const bugTaskFor = (s: UiState, agent: Agent): BugTask | null => {
  const mine = Object.values(s.bugTasks).filter(t => t.agentId === agent.id && !HIDDEN_BUG_STAGES.includes(t.stage));
  return mine.find(t => t.stage !== "done") ?? mine.find(t => t.stage === "done") ?? null;
};
