import type { Agent, Assignment, RoleDef } from "../types";
import { AgentTile } from "./AgentTile";

export function AgentGrid({ agents, roles, assignments, selectedId, recentFor, onSelect, onAssign }: {
  agents: Agent[]; roles: RoleDef[]; assignments: Record<string, Assignment>; selectedId: string | null;
  recentFor: (agentId: string) => string[]; onSelect: (id: string) => void; onAssign: (id: string, prompt: string) => void;
}) {
  return (
    <div className="grid">
      {agents.map((agent, i) => (
        <AgentTile key={agent.id} agent={agent} index={i} role={roles.find(r => r.name === agent.role)}
          assignment={agent.currentAssignmentId ? assignments[agent.currentAssignmentId] ?? null : null}
          selected={agent.id === selectedId} recent={recentFor(agent.id)} onSelect={onSelect} onAssign={onAssign} />
      ))}
      {agents.length === 0 && <div className="empty">No agents yet — press <b>+ Spawn</b> to add one.</div>}
    </div>
  );
}
