import type { Agent, Assignment, RoleDef, SessionInfo } from "../types";
import { AssignBox } from "./AssignBox";
import { basename, elapsed, usd } from "../format";

export interface AgentTileProps {
  agent: Agent; role: RoleDef | undefined; assignment: Assignment | null; selected: boolean; index: number; recent?: string[];
  onSelect: (id: string) => void; onAssign: (id: string, prompt: string) => void;
  /** Set when the adopted session's process is currently running outside the grid. */ live?: SessionInfo | null;
}

export function AgentTile({ agent, role, assignment, selected, index, recent, onSelect, onAssign, live }: AgentTileProps) {
  const a = assignment;
  const line = agent.state === "free" ? null
    : agent.state === "done" ? `✅ ${a?.outcome?.split("\n").filter(Boolean).at(-1) ?? "done"}`
    : agent.state === "failed" ? `❌ ${a?.error ?? "failed"}`
    : a?.activity ?? "";
  return (
    <div className={`tile ${selected ? "selected" : ""}`} data-state={agent.state} data-testid={`tile-${agent.id}`} onClick={() => onSelect(agent.id)}>
      {agent.state === "waiting" && <span className="badge">{a?.pending?.kind === "question" ? "question" : "needs you"}</span>}
      <span className="idx">{index < 9 ? index + 1 : ""}</span>
      <div className="hd">
        <div className="av">{role?.avatar ?? "🤖"}</div>
        <div><div className="name">{agent.displayName} — {agent.role}{agent.resumeSessionId && <span title="Continues an adopted Claude Code session"> 🔗</span>}</div><div className="repo">{basename(agent.repo)}</div></div>
      </div>
      {line !== null && <div className="act">{agent.state === "working" && <span className="dot" />}{line}</div>}
      {agent.state === "free" && live && <div className="act dim" data-testid="live-note">🟢 live in {live.kind === "background" ? "background" : "terminal"} ({live.status}) — close it to assign, or use the Terminal tab</div>}
      {agent.state === "free" && !live && <AssignBox agentId={agent.id} recent={recent} onSubmit={onAssign} />}
      {a && <div className="ft"><span>#{a.id} · {elapsed(a.startedAt ?? a.createdAt)}{a.turns ? ` · ${a.turns} turns` : ""}</span><span>{usd(a.costUsd)}</span></div>}
    </div>
  );
}
