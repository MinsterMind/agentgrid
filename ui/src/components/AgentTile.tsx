import type { Agent, Assignment, RoleDef, SessionInfo, SessionActivity } from "../types";
import { AssignBox } from "./AssignBox";
import { basename, elapsed, usd } from "../format";

export interface AgentTileProps {
  agent: Agent; role: RoleDef | undefined; assignment: Assignment | null; selected: boolean; index: number; recent?: string[];
  onSelect: (id: string) => void; onAssign: (id: string, prompt: string) => void;
  /** Set when the adopted session's process is currently running outside the grid. */ live?: SessionInfo | null;
  /** Transcript-derived activity (embedded terminal work shows up here). */ activity?: SessionActivity | null;
}

export function AgentTile({ agent, role, assignment, selected, index, recent, onSelect, onAssign, live, activity }: AgentTileProps) {
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
      {a && <div className="tasktitle" title={a.prompt}>{a.prompt.split("\n")[0].slice(0, 90)}</div>}
      {!a && activity?.lastPrompt && <div className="tasktitle" title={activity.lastPrompt}>{activity.lastPrompt.split("\n")[0].slice(0, 90)}</div>}
      {line !== null && <div className="act">{agent.state === "working" && <span className="dot" />}{line}</div>}
      {agent.state === "free" && activity && activity.phase !== "unknown" && (
        <div className={`act phase ${activity.phase}`} data-testid="tile-phase">
          {activity.phase === "waiting" ? (activity.question ? "❓ asking you" : `⏸ needs approval: ${activity.pendingTool?.name ?? ""}`) : activity.phase === "working" ? "● working in terminal" : "○ idle — your turn"}
        </div>
      )}
      {agent.state === "free" && live && <div className="act dim" data-testid="live-note">🟢 live in {live.kind === "background" ? "background" : "terminal"} ({live.status}) — close it to assign, or use the Terminal tab</div>}
      {agent.state === "free" && !live && <AssignBox agentId={agent.id} recent={recent} onSubmit={onAssign} />}
      {a && <div className="ft"><span>#{a.id} · {elapsed(a.startedAt ?? a.createdAt)}{a.turns ? ` · ${a.turns} turns` : ""}</span><span>{usd(a.costUsd)}</span></div>}
    </div>
  );
}
