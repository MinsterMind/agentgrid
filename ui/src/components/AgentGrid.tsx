import type { Agent, Assignment, Decision, RoleDef, SessionInfo, SessionActivity } from "../types";
import { SessionTile } from "./SessionTile";
import { AgentTile } from "./AgentTile";
import { Activity, CheckCircle2, Hand, Moon, RadioReceiver } from "lucide-react";
import { sectionize } from "../state/sections";

const ICON = { waiting: Hand, working: Activity, finished: CheckCircle2, free: Moon };

export function AgentGrid({ agents, roles, assignments, selectedId, recentFor, onSelect, onAssign, onDecide, liveSessions = [], liveFor, activityFor, onPullIn, bugStageFor, needsYou, onSay }: {
  agents: Agent[]; roles: RoleDef[]; assignments: Record<string, Assignment>; selectedId: string | null;
  recentFor: (agentId: string) => string[]; onSelect: (id: string) => void; onAssign: (id: string, prompt: string) => void;
  /** Answer an agent's pending request from its tile. */ onDecide?: (agentId: string, toolUseId: string, d: Decision) => void;
  /** Live sessions with no tile yet. */ liveSessions?: SessionInfo[];
  /** Live session bound to an adopted agent, if its process is running. */ liveFor?: (agent: Agent) => SessionInfo | null;
  activityFor?: (agent: Agent) => SessionActivity | null;
  onPullIn?: (sessionId: string, role: string, takeover: boolean) => Promise<void>;
  /** Stage of an agent's in-flight bug-fix task, if any. */ bugStageFor?: (agent: Agent) => string | undefined;
  /** Agents that need you for any reason — they sit in the Needs you section. */ needsYou?: (agent: Agent) => boolean;
  /** Answer a finished run's question from its tile. */ onSay?: (id: string, text: string) => void;
}) {
  const sections = sectionize(agents, needsYou);
  let index = 0;
  return (
    <div className="board">
      {sections.map(sec => (
        <section key={sec.key} className={`section ${sec.key}`} data-testid={`section-${sec.key}`}>
          <div className="sect-head">
            <h3 className={`sect ${sec.key}`}>{(() => { const I = ICON[sec.key]; return <I />; })()} {sec.title} <span className="count">{sec.agents.length}</span></h3>
            <p className="sect-desc">{sec.hint}</p>
          </div>
          <div className="grid">
            {sec.agents.map(agent => (
              <AgentTile key={agent.id} agent={agent} index={index++} role={roles.find(r => r.name === agent.role)}
                assignment={agent.currentAssignmentId ? assignments[agent.currentAssignmentId] ?? null : null}
                selected={agent.id === selectedId} recent={recentFor(agent.id)} onSelect={onSelect} onAssign={onAssign} onDecide={onDecide} live={liveFor?.(agent) ?? null} activity={activityFor?.(agent) ?? null} bugStage={bugStageFor?.(agent)} onSay={onSay} />
            ))}
          </div>
        </section>
      ))}
      {liveSessions.length > 0 && (
        <section className="section live" data-testid="section-live">
          <div className="sect-head">
            <h3 className="sect live"><RadioReceiver /> Running elsewhere <span className="count">{liveSessions.length}</span></h3>
            <p className="sect-desc">Claude Code sessions open outside AgentGrid. Pull one in to manage it here.</p>
          </div>
          <div className="strip">{[...liveSessions].sort((a, b) => b.at - a.at).map(l => <SessionTile key={l.sessionId} session={l} roles={roles} onPullIn={onPullIn ?? (async () => {})} />)}</div>
        </section>
      )}
      {agents.length === 0 && liveSessions.length === 0 && <div className="empty">No agents yet — press <b>+ Spawn</b> to add one.</div>}
    </div>
  );
}
