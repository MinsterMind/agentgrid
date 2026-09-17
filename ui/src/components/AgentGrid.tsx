import type { Agent, Assignment, RoleDef, SessionInfo } from "../types";
import { SessionTile } from "./SessionTile";
import { AgentTile } from "./AgentTile";

export function AgentGrid({ agents, roles, assignments, selectedId, recentFor, onSelect, onAssign, liveSessions = [], liveFor, onPullIn }: {
  agents: Agent[]; roles: RoleDef[]; assignments: Record<string, Assignment>; selectedId: string | null;
  recentFor: (agentId: string) => string[]; onSelect: (id: string) => void; onAssign: (id: string, prompt: string) => void;
  /** Live sessions with no tile yet. */ liveSessions?: SessionInfo[];
  /** Live session bound to an adopted agent, if its process is running. */ liveFor?: (agent: Agent) => SessionInfo | null;
  onPullIn?: (sessionId: string, role: string) => Promise<void>;
}) {
  return (
    <div className="grid">
      {agents.map((agent, i) => (
        <AgentTile key={agent.id} agent={agent} index={i} role={roles.find(r => r.name === agent.role)}
          assignment={agent.currentAssignmentId ? assignments[agent.currentAssignmentId] ?? null : null}
          selected={agent.id === selectedId} recent={recentFor(agent.id)} onSelect={onSelect} onAssign={onAssign} live={liveFor?.(agent) ?? null} />
      ))}
      {liveSessions.map(l => <SessionTile key={l.sessionId} session={l} roles={roles} onPullIn={onPullIn ?? (async () => {})} />)}
      {agents.length === 0 && liveSessions.length === 0 && <div className="empty">No agents yet — press <b>+ Spawn</b> to add one.</div>}
    </div>
  );
}
