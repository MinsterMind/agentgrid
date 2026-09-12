import type { Agent, AgentState, Assignment, GridEvent, GridState, RoleDef } from "../types";

export interface UiState { roles: RoleDef[]; agents: Agent[]; assignments: Record<string, Assignment>; selectedId: string | null; connected: boolean }
export type Action =
  | { type: "snapshot"; state: GridState }
  | { type: "change"; event: GridEvent }
  | { type: "select"; id: string | null }
  | { type: "connected"; value: boolean };

export const initial: UiState = { roles: [], agents: [], assignments: {}, selectedId: null, connected: false };

export function reducer(s: UiState, a: Action): UiState {
  switch (a.type) {
    case "snapshot":
      return { ...s, roles: a.state.roles, agents: a.state.agents,
        assignments: Object.fromEntries(a.state.assignments.map(x => [x.id, x])),
        selectedId: a.state.agents.some(x => x.id === s.selectedId) ? s.selectedId : null };
    case "change": {
      const e = a.event;
      if (e.type === "roles") return { ...s, roles: e.roles };
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
