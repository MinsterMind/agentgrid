import { Activity, CheckCircle2, Hand, Moon, XCircle } from "lucide-react";
import type { Agent, Assignment, Decision, Pending, PermissionRequest, RoleDef, SessionInfo, SessionActivity } from "../types";
import { AssignBox } from "./AssignBox";
import { useState } from "react";
import { AlwaysAllow, asPending, describeRequest, summarise } from "./PendingPrompt";
import { basename, elapsed, usd } from "../format";
import { attention } from "../state/attention";
import { PrLine } from "./PrLine";

export interface AgentTileProps {
  agent: Agent; role: RoleDef | undefined; assignment: Assignment | null; selected: boolean; index: number; recent?: string[];
  onSelect: (id: string) => void; onAssign: (id: string, prompt: string) => void;
  /** Answer the agent's pending request from the tile — the same path the side panel uses. */
  onDecide?: (agentId: string, toolUseId: string, d: Decision) => void;
  /** Set when the adopted session's process is currently running outside the grid. */ live?: SessionInfo | null;
  /** Transcript-derived activity (embedded terminal work shows up here). */ activity?: SessionActivity | null;
  /** Stage of this agent's in-flight bug-fix task, if any. */ bugStage?: string;
  /** Answer a finished run's question in its own conversation. */ onSay?: (id: string, text: string) => void;
  /** Ask the same agent for a second look at its task's PR. */ onReReview?: (id: string) => void;
  /** An open permission request from this agent's embedded terminal (Claude Code is asking). */ permission?: PermissionRequest | null;
}

const STATE = {
  working: { Icon: Activity, word: "Working" }, waiting: { Icon: Hand, word: "Needs you" },
  done: { Icon: CheckCircle2, word: "Done" }, failed: { Icon: XCircle, word: "Failed" }, free: { Icon: Moon, word: "Idle" },
} as const;

interface Q { question: string; multiSelect?: boolean; options: Array<{ label: string }> }

/** The request card on a waiting tile. It answers only what fits on a card: one permission, or
 *  one single-choice question. Anything bigger goes to the side panel rather than half-answered. */
function TileRequest({ agent, p, onDecide, onSelect }: { agent: Agent; p: Pending | null; onDecide?: AgentTileProps["onDecide"]; onSelect: (id: string) => void }) {
  const [armed, setArmed] = useState(false);
  const stop = (e: { stopPropagation: () => void }) => { e.stopPropagation(); setArmed(false); };
  if (!p || !onDecide) {
    // No stopPropagation here: the card asks to be opened, so a click on it must reach the tile.
    return <div className="tile-req open" data-testid="tile-request">Waiting for you — open it to see what it needs.</div>;
  }
  if (p.kind === "permission") {
    const say = describeRequest(p.toolName);
    return (
      <div className="tile-req" data-testid="tile-request" onClick={stop}>
        <div className="msg">{say[0].toUpperCase() + say.slice(1)}</div>
        <div className="cmd">{summarise(p.input)}</div>
        <div className="acts">
          <button className="btn p sm" onClick={() => onDecide(agent.id, p.toolUseId, { kind: "allow" })}>Allow</button>
          {p.suggestedRule && <AlwaysAllow small pending={p} onDecide={d => onDecide(agent.id, p.toolUseId, d)} armed={armed} setArmed={setArmed} />}
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

export function AgentTile({ agent, role, assignment, selected, index, recent, onSelect, onAssign, onDecide, live, activity, bugStage, onSay, onReReview, permission }: AgentTileProps) {
  const a = assignment;
  // An agent waiting on you is never "Idle" or "Done", wherever it waits — say so, loudly.
  const need = attention(agent, a, activity, permission);
  const shown = need ? "waiting" : agent.state;
  const { Icon, word } = STATE[shown];
  const line = agent.state === "free" || agent.state === "waiting" || need?.kind === "asked" ? null
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
      <div className={`tile-state ${shown}`} data-testid="tile-state"><Icon /> {word}{need?.kind === "terminal" ? " (terminal)" : ""}</div>
      {a && <div className="tasktitle" title={a.prompt}>{a.prompt.split("\n")[0].slice(0, 90)}</div>}
      {a?.pr && <PrLine pr={a.pr} canReReview={agent.state === "done" || agent.state === "failed"} onReReview={onReReview && (() => onReReview(agent.id))} />}
      {!a && activity?.lastPrompt && <div className="tasktitle" title={activity.lastPrompt}>{activity.lastPrompt.split("\n")[0].slice(0, 90)}</div>}
      {(agent.state === "waiting" || permission) && <TileRequest agent={agent} p={a?.pending ?? (permission ? asPending(permission) : null)} onDecide={onDecide} onSelect={onSelect} />}
      {need?.kind === "asked" && (
        <div className="tile-req" data-testid="tile-request" onClick={e => e.stopPropagation()}>
          <div className="msg">{need.question}</div>
          {/* An idle adopted agent's own assign box below already continues its session. */}
          {agent.state !== "free" && onSay && <AssignBox agentId={agent.id} onSubmit={onSay} placeholder="Reply to continue… (⏎ to send)" label="Reply" />}
        </div>
      )}
      {agent.state !== "free" && need?.kind === "terminal" && <div className="act phase waiting" data-testid="tile-phase">{need.text}</div>}
      {line !== null && <div className="act">{line}</div>}
      {agent.state === "free" && !permission && activity && activity.phase !== "unknown" && (
        <div className={`act phase ${activity.phase}`} data-testid="tile-phase">
          {activity.phase === "waiting" ? "Asking you a question in the terminal" : activity.phase === "working" ? `Working in the terminal${activity.runningTool ? `: ${activity.runningTool.name}` : ""}` : "Idle — your turn"}
        </div>
      )}
      {agent.state === "free" && live && <div className="act dim" data-testid="live-note">Live in {live.kind === "background" ? "the background" : "a terminal"} ({live.status}) — close it to assign, or use the Terminal tab</div>}
      {agent.state === "free" && !live && <AssignBox agentId={agent.id} recent={recent} onSubmit={onAssign} />}
      {a && <div className="ft"><span>#{a.id} · {elapsed(a.startedAt ?? a.createdAt)}{a.turns ? ` · ${a.turns} turns` : ""}</span><span>{usd(a.costUsd)}</span></div>}
    </div>
  );
}
