import type { Agent, AgentState, Assignment, GridEvent, GridState, RoleDef, SessionInfo } from "../types";

export interface UiState { roles: RoleDef[]; agents: Agent[]; assignments: Record<string, Assignment>; liveSessions: SessionInfo[]; selectedId: string | null; connected: boolean }
export type Action =
  | { type: "snapshot"; state: GridState }
  | { type: "change"; event: GridEvent }
  | { type: "select"; id: string | null }
  | { type: "connected"; value: boolean };

export const initial: UiState = { roles: [], agents: [], assignments: {}, liveSessions: [], selectedId: null, connected: false };

export function reducer(s: UiState, a: Action): UiState {
  switch (a.type) {
    case "snapshot":
      return { ...s, roles: a.state.roles, agents: a.state.agents,
        assignments: Object.fromEntries(a.state.assignments.map(x => [x.id, x])),
        liveSessions: a.state.liveSessions ?? [],
        selectedId: a.state.agents.some(x => x.id === s.selectedId) ? s.selectedId : null };
    case "change": {
      const e = a.event;
      if (e.type === "roles") return { ...s, roles: e.roles };
      if (e.type === "sessions") return { ...s, liveSessions: e.sessions };
      if (e.type === "assignment") return { ...s, assignments: { ...s.assignments, [e.assignment.id]: e.assignment } };
      if (e.type === "agent-removed") return { ...s, agents: s.agents.filter(x => x.id !== e.id), selectedId: s.selectedId === e.id ? null : s.selectedId };
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

export const waitingIds = (s: UiState): string[] => s.agents.filter(a => a.state === "waiting").map(a => a.id);

/** Live sessions not yet represented by a grid agent — shown as ghost tiles. */
export const unclaimedLiveSessions = (s: UiState): SessionInfo[] => {
  const owned = new Set<string>();
  for (const a of s.agents) if (a.resumeSessionId) owned.add(a.resumeSessionId);
  for (const x of Object.values(s.assignments)) if (x.sessionId) owned.add(x.sessionId);
  return s.liveSessions.filter(l => !l.agentId && !owned.has(l.sessionId));
};

/** The live session an adopted agent is bound to, if its process is currently running. */
export const liveSessionFor = (s: UiState, agent: Agent): SessionInfo | null =>
  agent.resumeSessionId ? s.liveSessions.find(l => l.sessionId === agent.resumeSessionId) ?? null : null;
