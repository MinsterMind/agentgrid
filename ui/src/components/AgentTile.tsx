import { Activity, CheckCircle2, Hand, Moon, XCircle } from "lucide-react";
import type { Agent, Assignment, Decision, RoleDef, SessionInfo, SessionActivity } from "../types";
import { AssignBox } from "./AssignBox";
import { describeRequest, summarise } from "./PendingPrompt";
import { basename, elapsed, usd } from "../format";

export interface AgentTileProps {
  agent: Agent; role: RoleDef | undefined; assignment: Assignment | null; selected: boolean; index: number; recent?: string[];
  onSelect: (id: string) => void; onAssign: (id: string, prompt: string) => void;
  /** Answer the agent's pending request from the tile — the same path the side panel uses. */
  onDecide?: (agentId: string, toolUseId: string, d: Decision) => void;
  /** Set when the adopted session's process is currently running outside the grid. */ live?: SessionInfo | null;
  /** Transcript-derived activity (embedded terminal work shows up here). */ activity?: SessionActivity | null;
  /** Stage of this agent's in-flight bug-fix task, if any. */ bugStage?: string;
}

const STATE = {
  working: { Icon: Activity, word: "Working" }, waiting: { Icon: Hand, word: "Needs you" },
  done: { Icon: CheckCircle2, word: "Done" }, failed: { Icon: XCircle, word: "Failed" }, free: { Icon: Moon, word: "Idle" },
} as const;

interface Q { question: string; multiSelect?: boolean; options: Array<{ label: string }> }

/** The request card on a waiting tile. It answers only what fits on a card: one permission, or
 *  one single-choice question. Anything bigger goes to the side panel rather than half-answered. */
function TileRequest({ agent, a, onDecide, onSelect }: { agent: Agent; a: Assignment | null; onDecide?: AgentTileProps["onDecide"]; onSelect: (id: string) => void }) {
  const p = a?.pending;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  if (!p || !onDecide) {
    return <div className="tile-req" data-testid="tile-request" onClick={stop}>Waiting for you — open it to see what it needs.</div>;
  }
  if (p.kind === "permission") {
    const say = describeRequest(p.toolName);
    return (
      <div className="tile-req" data-testid="tile-request" onClick={stop}>
        <div className="msg">{say[0].toUpperCase() + say.slice(1)}</div>
        <div className="cmd">{summarise(p.input)}</div>
        <div className="acts">
          <button className="btn p sm" onClick={() => onDecide(agent.id, p.toolUseId, { kind: "allow" })}>Allow</button>
          <button className="btn d sm" onClick={() => onDecide(agent.id, p.toolUseId, { kind: "deny" })}>Deny</button>
        </div>
      </div>
    );
  }
  const qs = (p.input.questions as Q[] | undefined) ?? [];
  if (qs.length === 1 && !qs[0].multiSelect) {
    const q = qs[0];
    return (
      <div className="tile-req" data-testid="tile-request" onClick={stop}>
        <div className="msg">{q.question}</div>
        <div className="acts">{q.options.map(o => <button key={o.label} className="btn sm" onClick={() => onDecide(agent.id, p.toolUseId, { kind: "answers", answers: { [q.question]: o.label } })}>{o.label}</button>)}</div>
      </div>
    );
  }
  return (
    <div className="tile-req" data-testid="tile-request" onClick={stop}>
      <div className="msg">Has {qs.length > 1 ? `${qs.length} questions` : "a question"} for you.</div>
      <div className="acts"><button className="btn sm" onClick={() => onSelect(agent.id)}>Answer in the side panel</button></div>
    </div>
  );
}

export function AgentTile({ agent, role, assignment, selected, index, recent, onSelect, onAssign, onDecide, live, activity, bugStage }: AgentTileProps) {
  const a = assignment;
  const { Icon, word } = STATE[agent.state];
  const line = agent.state === "free" || agent.state === "waiting" ? null
    : agent.state === "done" ? a?.outcome?.split("\n").filter(Boolean).at(-1) ?? "Finished"
    : agent.state === "failed" ? a?.error ?? "The run failed"
    : a?.activity ?? "";
  return (
    <div className={`tile ${selected ? "selected" : ""}`} data-state={agent.state} data-testid={`tile-${agent.id}`} onClick={() => onSelect(agent.id)}>
      <span className="idx">{index < 9 ? index + 1 : ""}</span>
      <div className="hd">
        <div className="av">{role?.avatar ?? "🤖"}</div>
        <div><div className="name">{agent.displayName} <span className="role">— {agent.role}</span>{agent.resumeSessionId && <span title="Continues an adopted Claude Code session"> 🔗</span>}</div><div className="repo">{basename(agent.repo)}</div></div>
        {bugStage && <span className="chip" data-testid="tile-bug-stage">{bugStage}</span>}
      </div>
      <div className={`tile-state ${agent.state}`} data-testid="tile-state"><Icon /> {word}</div>
      {a && <div className="tasktitle" title={a.prompt}>{a.prompt.split("\n")[0].slice(0, 90)}</div>}
      {!a && activity?.lastPrompt && <div className="tasktitle" title={activity.lastPrompt}>{activity.lastPrompt.split("\n")[0].slice(0, 90)}</div>}
      {agent.state === "waiting" && <TileRequest agent={agent} a={a} onDecide={onDecide} onSelect={onSelect} />}
      {line !== null && <div className="act">{line}</div>}
      {agent.state === "free" && activity && activity.phase !== "unknown" && (
        <div className={`act phase ${activity.phase}`} data-testid="tile-phase">
          {activity.phase === "waiting" ? (activity.question ? "Asking you a question in the terminal" : `Needs approval in the terminal: ${activity.pendingTool?.name ?? ""}`) : activity.phase === "working" ? "Working in the terminal" : "Idle — your turn"}
        </div>
      )}
      {agent.state === "free" && live && <div className="act dim" data-testid="live-note">Live in {live.kind === "background" ? "the background" : "a terminal"} ({live.status}) — close it to assign, or use the Terminal tab</div>}
      {agent.state === "free" && !live && <AssignBox agentId={agent.id} recent={recent} onSubmit={onAssign} />}
      {a && <div className="ft"><span>#{a.id} · {elapsed(a.startedAt ?? a.createdAt)}{a.turns ? ` · ${a.turns} turns` : ""}</span><span>{usd(a.costUsd)}</span></div>}
    </div>
  );
}
