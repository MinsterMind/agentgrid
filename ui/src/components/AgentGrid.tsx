import type { Agent, Assignment, RoleDef, SessionInfo } from "../types";
import { SessionTile } from "./SessionTile";
import { AgentTile } from "./AgentTile";
import { sectionize } from "../state/sections";

export function AgentGrid({ agents, roles, assignments, selectedId, recentFor, onSelect, onAssign, liveSessions = [], liveFor, onPullIn }: {
  agents: Agent[]; roles: RoleDef[]; assignments: Record<string, Assignment>; selectedId: string | null;
  recentFor: (agentId: string) => string[]; onSelect: (id: string) => void; onAssign: (id: string, prompt: string) => void;
  /** Live sessions with no tile yet. */ liveSessions?: SessionInfo[];
  /** Live session bound to an adopted agent, if its process is running. */ liveFor?: (agent: Agent) => SessionInfo | null;
  onPullIn?: (sessionId: string, role: string, takeover: boolean) => Promise<void>;
}) {
  const sections = sectionize(agents);
  let index = 0;
  return (
    <div className="board">
      {sections.map(sec => (
        <section key={sec.key} className={`section ${sec.key}`} data-testid={`section-${sec.key}`}>
          <h3 className="sect">{sec.title} <span className="count">{sec.agents.length}</span></h3>
          <div className="grid">
            {sec.agents.map(agent => (
              <AgentTile key={agent.id} agent={agent} index={index++} role={roles.find(r => r.name === agent.role)}
                assignment={agent.currentAssignmentId ? assignments[agent.currentAssignmentId] ?? null : null}
                selected={agent.id === selectedId} recent={recentFor(agent.id)} onSelect={onSelect} onAssign={onAssign} live={liveFor?.(agent) ?? null} />
            ))}
          </div>
        </section>
      ))}
      {liveSessions.length > 0 && (
        <section className="section live" data-testid="section-live">
          <h3 className="sect">Live Claude Code sessions <span className="count">{liveSessions.length}</span><span className="sub">running outside the grid · newest first</span></h3>
          <div className="strip">{[...liveSessions].sort((a, b) => b.at - a.at).map(l => <SessionTile key={l.sessionId} session={l} roles={roles} onPullIn={onPullIn ?? (async () => {})} />)}</div>
        </section>
      )}
      {agents.length === 0 && liveSessions.length === 0 && <div className="empty">No agents yet — press <b>+ Spawn</b> to add one.</div>}
    </div>
  );
}
