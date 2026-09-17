import { Suspense, lazy, useEffect, useState } from "react";
import type { Agent, Assignment, Decision, MemoryFile, RoleDef, SessionInfo } from "../types";
import { api } from "../api";
import { PendingPrompt } from "./PendingPrompt";
const TerminalPane = lazy(() => import("./TerminalPane").then(m => ({ default: m.TerminalPane })));
import { elapsed, usd } from "../format";

type Entry = { ts: string; role: string; kind: string; text: string };

export function SidePanel({ agent, role, assignment, onDecide, onCancel, onAck, onOpenTerminal, onTranscript, onDelete, hasSession, terminalSessionId, live, openTerminalRequest }: {
  agent: Agent | null; role: RoleDef | undefined; assignment: Assignment | null;
  onDecide: (agentId: string, toolUseId: string, d: Decision) => void; onCancel: (id: string) => void; onAck: (id: string) => void; onOpenTerminal: (id: string) => void; onTranscript?: (id: string) => void; onDelete: (id: string) => void; hasSession?: boolean;
  /** Session the Terminal tab would open; null when the agent has none yet. */ terminalSessionId?: string | null;
  /** Live process for an adopted session, if any: background → terminal attaches; interactive → terminal unavailable. */ live?: SessionInfo | null;
  /** Bumping this (with a value) opens the Terminal tab — used right after a pull-in. */ openTerminalRequest?: number;
}) {
  const [feed, setFeed] = useState<Entry[]>([]); const [memory, setMemory] = useState<MemoryFile[]>([]);
  const [tab, setTab] = useState<"details" | "terminal">("details"); const [wide, setWide] = useState(false);
  const asgId = assignment?.id; const activity = assignment?.activity; const agentId = agent?.id;
  useEffect(() => { setTab("details"); }, [agentId]);
  useEffect(() => { if (openTerminalRequest && terminalSessionId) setTab("terminal"); }, [openTerminalRequest]);

  useEffect(() => { if (!asgId) { setFeed([]); return; } let live = true; api.transcript(asgId).then(f => live && setFeed(f.slice(-30))).catch(() => {}); return () => { live = false; }; }, [asgId, activity]);
  useEffect(() => { if (!agentId) { setMemory([]); return; } let live = true; api.memory(agentId).then(m => live && setMemory(m)).catch(() => {}); return () => { live = false; }; }, [agentId, assignment?.state]);

  if (!agent) return <aside className="side"><p className="hint">Select an agent to see details. Press 1–9 to jump.</p></aside>;
  const a = assignment;
  // Deleting archives the agent (with its memory) — only safe while it isn't mid-flight
  // on an SDK session (working/waiting would orphan the run).
  const canDelete = agent.state === "free" || agent.state === "done" || agent.state === "failed";
  const busy = agent.state === "working" || agent.state === "waiting";
  const termAvailable = !!terminalSessionId && !busy && live?.kind !== "interactive";
  if (tab === "terminal" && terminalSessionId) {
    return (
      <aside className={`side term ${wide ? "wide" : ""}`} data-testid="side-panel">
        <div className="tabs">
          <button className="tab" onClick={() => setTab("details")}>Details</button>
          <button className="tab on">Terminal</button>
          <button className="btn sm" style={{ marginLeft: "auto" }} title={wide ? "Shrink" : "Expand"} onClick={() => setWide(w => !w)}>{wide ? "⤡" : "⤢"}</button>
        </div>
        <Suspense fallback={<p className="hint">Loading terminal…</p>}><TerminalPane sessionId={terminalSessionId} /></Suspense>
      </aside>
    );
  }
  return (
    <aside className="side" data-testid="side-panel">
      <div className="tabs">
        <button className="tab on">Details</button>
        <button className="tab" disabled={!termAvailable} title={busy ? "Wait for the current task to finish" : live?.kind === "interactive" ? "Open in another terminal — close it there to use it here" : live ? "Attach to the background session" : terminalSessionId ? "Open this session in a terminal here" : "No session yet"} onClick={() => setTab("terminal")}>Terminal</button>
      </div>
      <div className="hd"><div className="av" data-state={agent.state}>{role?.avatar ?? "🤖"}</div>
        <div><div className="name">{agent.displayName} — {agent.role}</div><div className="repo">{agent.repo}{a ? ` · #${a.id}` : ""}</div>{agent.resumeSessionId && <div className="repo">🔗 continues session {agent.resumeSessionId.slice(0, 8)}…{live && <span className="st-live"> · live in {live.kind === "background" ? "background" : "terminal"} ({live.status})</span>}</div>}</div></div>
      {a && <>
        <h4>Task</h4><div className="task">{a.prompt}</div>
        <h4>Recent activity</h4>
        <div className="transcript">{feed.map((e, i) => <div key={i} className={`e ${e.kind}`}>▸ <span>{e.text}</span></div>)}{feed.length === 0 && <div className="e">…</div>}</div>
        {a.pending && <PendingPrompt pending={a.pending} onDecide={d => onDecide(agent.id, a.pending!.toolUseId, d)} />}
        {a.state === "done" && <><h4>Outcome</h4><pre className="outcome">{a.outcome}</pre></>}
        {a.state === "failed" && <><h4>Failed</h4><pre className="outcome err">{a.error}</pre></>}
        <div className="row">
          {a.sessionId && <button className="btn" onClick={() => onOpenTerminal(agent.id)}>Open in Terminal ↗</button>}
          {(a.sessionId || agent.resumeSessionId) && onTranscript && <button className="btn" onClick={() => onTranscript(agent.id)}>Transcript</button>}
          {(a.state === "working" || a.state === "waiting") && <button className="btn d" onClick={() => onCancel(agent.id)}>Cancel task</button>}
          {(a.state === "done" || a.state === "failed") && <button className="btn p" onClick={() => onAck(agent.id)}>Ack → free</button>}
          {canDelete && <button className="btn d" onClick={() => onDelete(agent.id)}>Delete agent</button>}
        </div>
        <div className="ft"><span>{elapsed(a.startedAt ?? a.createdAt)} · {a.turns} turns</span><span>{usd(a.costUsd)}</span></div>
      </>}
      {!a && <>
        <p className="hint">Idle. Type in the tile to assign work.</p>
        <div className="row">
          {(agent.resumeSessionId || hasSession) && onTranscript && <button className="btn" onClick={() => onTranscript(agent.id)}>Transcript</button>}
          {canDelete && <button className="btn d" onClick={() => onDelete(agent.id)}>Delete agent</button>}
        </div>
      </>}
      <h4>Memory ({memory.length})</h4>
      <ul className="memory">{memory.map(m => <li key={m.file} title={m.description}>{m.name} <span className="dim">— {m.description}</span></li>)}</ul>
    </aside>
  );
}
