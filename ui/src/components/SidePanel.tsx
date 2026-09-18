import { Suspense, lazy, useEffect, useState } from "react";
import type { Agent, Assignment, Decision, MemoryFile, RoleDef, SessionInfo, SessionActivity } from "../types";
import { api } from "../api";
import { PendingPrompt } from "./PendingPrompt";
const TerminalPane = lazy(() => import("./TerminalPane").then(m => ({ default: m.TerminalPane })));
import { elapsed, usd } from "../format";

type Entry = { ts: string; role: string; kind: string; text: string };

/** Clipboard write that also works where navigator.clipboard is unavailable (e.g. non-secure contexts). */
export function copyText(text: string): void {
  if (navigator.clipboard?.writeText) { void navigator.clipboard.writeText(text).catch(() => fallbackCopy(text)); return; }
  fallbackCopy(text);
}
function fallbackCopy(text: string): void {
  const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch { /* ignore */ } ta.remove();
}

export function SidePanel({ agent, role, assignment, onDecide, onCancel, onAck, onOpenTerminal, onTranscript, onDelete, hasSession, terminalSessionId, live, openTerminalRequest, activity, onSay, onReset, onRenameSession }: {
  agent: Agent | null; role: RoleDef | undefined; assignment: Assignment | null;
  onDecide: (agentId: string, toolUseId: string, d: Decision) => void; onCancel: (id: string) => void; onAck: (id: string) => void; onOpenTerminal: (id: string) => void; onTranscript?: (id: string) => void; onDelete: (id: string) => void; hasSession?: boolean;
  /** Session the Terminal tab would open; null when the agent has none yet. */ terminalSessionId?: string | null;
  /** Live process for an adopted session, if any: background → terminal attaches; interactive → terminal unavailable. */ live?: SessionInfo | null;
  /** Bumping this (with a value) opens the Terminal tab — used right after a pull-in. */ openTerminalRequest?: number;
  /** Transcript-derived activity of the agent's session (works while it runs in the embedded terminal). */ activity?: SessionActivity | null;
  onSay?: (id: string, text: string) => Promise<unknown>;
  onReset?: (id: string) => Promise<unknown>;
  onRenameSession?: (sessionId: string, title: string) => Promise<unknown>;
}) {
  const [feed, setFeed] = useState<Entry[]>([]); const [memory, setMemory] = useState<MemoryFile[]>([]);
  const [tab, setTab] = useState<"details" | "terminal">("details"); const [wide, setWide] = useState(false);
  const [reply, setReply] = useState(""); const [sending, setSending] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null); const [copied, setCopied] = useState(false);
  const asgId = assignment?.id; const asgActivity = assignment?.activity; const agentId = agent?.id;
  useEffect(() => { setTab("details"); }, [agentId]);
  useEffect(() => { if (openTerminalRequest && terminalSessionId) setTab("terminal"); }, [openTerminalRequest]);

  useEffect(() => { if (!asgId) { setFeed([]); return; } let live = true; api.transcript(asgId).then(f => live && setFeed(f.slice(-30))).catch(() => {}); return () => { live = false; }; }, [asgId, asgActivity]);
  useEffect(() => { if (!agentId) { setMemory([]); return; } let live = true; api.memory(agentId).then(m => live && setMemory(m)).catch(() => {}); return () => { live = false; }; }, [agentId, assignment?.state]);

  const sendReply = async (text: string) => {
    if (!agent || !onSay || !text.trim()) return;
    setSending(true);
    try { await onSay(agent.id, text.trim()); setReply(""); } finally { setSending(false); }
  };
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
        <div><div className="name">{agent.displayName} — {agent.role}</div><div className="repo">{agent.repo}{a ? ` · #${a.id}` : ""}</div>{agent.resumeSessionId && <div className="repo session-line">🔗 continues session <code title={agent.resumeSessionId}>{agent.resumeSessionId.slice(0, 8)}…</code>
          <button className="btn sm" title="Copy session id" onClick={() => { copyText(agent.resumeSessionId!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "copied" : "⧉"}</button>
          <button className="btn sm" title="Rename session" onClick={() => setRenaming(renaming === null ? "" : null)}>✎</button>
          {live && <span className="st-live"> · live in {live.kind === "background" ? "background" : "terminal"} ({live.status})</span>}</div>}
      {renaming !== null && agent.resumeSessionId && (
        <form className="row" onSubmit={async e => { e.preventDefault(); const t = renaming.trim(); if (t && onRenameSession) await onRenameSession(agent.resumeSessionId!, t); setRenaming(null); }}>
          <input autoFocus value={renaming} placeholder="Session name" aria-label="Session name" onChange={e => setRenaming(e.target.value)} />
          <button className="btn p sm" type="submit">Save</button><button className="btn sm" type="button" onClick={() => setRenaming(null)}>Cancel</button>
        </form>
      )}</div></div>
      {activity && (
        <div className={`status ${activity.phase}`} data-testid="session-status">
          <div className="st-head"><span className={`dot ${activity.phase}`} />
            {activity.phase === "waiting" ? (activity.question ? "Asking you a question" : `Waiting for approval: ${activity.pendingTool?.name ?? "tool"}`) : activity.phase === "working" ? "Working…" : activity.phase === "idle" ? "Idle — your turn" : "No activity yet"}
            <span className="dim" style={{ marginLeft: "auto" }}>{activity.updatedAt ? elapsed(activity.updatedAt) + " ago" : ""}</span></div>
          {activity.pendingTool && !activity.question && <div className="st-tool">{activity.pendingTool.summary}</div>}
          {activity.lastMessage && <div className="st-msg">{activity.lastMessage}</div>}
          {activity.question && (
            <div className="qbox">
              <div className="qtitle">{activity.question.text}</div>
              <div className="row">{activity.question.options.map(o => <button key={o} className="btn" disabled={sending} onClick={() => sendReply(o)}>{o}</button>)}</div>
            </div>
          )}
          {onSay && (
            <form className="row reply" onSubmit={e => { e.preventDefault(); void sendReply(reply); }}>
              <input value={reply} placeholder={activity.question ? "or type an answer…" : "Reply to the agent…"} aria-label="Reply" onChange={e => setReply(e.target.value)} disabled={sending} />
              <button className="btn p sm" type="submit" disabled={sending || !reply.trim()}>Send</button>
            </form>
          )}
        </div>
      )}
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
        <p className="hint">{agent.resumeSessionId ? "Idle. The next task continues this session — or start fresh." : "Idle. Type in the tile to assign work."}</p>
        <div className="row">
          {(agent.resumeSessionId || hasSession) && onTranscript && <button className="btn" onClick={() => onTranscript(agent.id)}>Transcript</button>}
          {agent.resumeSessionId && onReset && <button className="btn" title="Forget this session's context; the next task starts a new conversation (memory files are kept)" onClick={() => onReset(agent.id)}>Start fresh</button>}
          {canDelete && <button className="btn d" onClick={() => onDelete(agent.id)}>Delete agent</button>}
        </div>
      </>}
      <h4>Memory ({memory.length})</h4>
      <ul className="memory">{memory.map(m => <li key={m.file} title={m.description}>{m.name} <span className="dim">— {m.description}</span></li>)}</ul>
    </aside>
  );
}
