# Layouts

Framework: React 19 + Vite (SPA), TypeScript. No component library — all components are custom. CSS: one hand-written vanilla stylesheet (`ui/src/styles.css`), class-based, no Tailwind/CSS modules. Routing: hash-based (`ui/src/hooks/useHashRoute.ts`). Dark-only theme. Desktop app wraps it in Electron.

- `App.tsx`: app shell — TopBar, then either the agent grid + side panel (`.split` two-column) or the full-page BugScreen; footer with notification toggles and key hints; modal dialogs layered on top.
- `TopBar.tsx`: brand, agent count pills (working / need you / done / failed / free / spend), Bugs/Grid toggle, Fix a bug, Sessions, Settings, + Spawn.
- `SidePanel.tsx`: right column (340px) for the selected agent: header, task, live transcript, pending permission/question prompt, memory, actions, embedded terminal tab, bug card.

### `ui/src/App.tsx`

```tsx
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { api } from "./api";
import { reducer, initial, assignmentFor, counts, todaySpend, waitingIds, unclaimedLiveSessions, liveSessionFor, activityFor, sessionIdFor, bugTaskFor } from "./state/reducer";
import { visualOrder } from "./state/sections";
import { AgentGrid } from "./components/AgentGrid";
import { SidePanel } from "./components/SidePanel";
import { TopBar } from "./components/TopBar";
import { SpawnDialog } from "./components/SpawnDialog";
import { BugLauncher } from "./components/BugLauncher";
import { SettingsDialog } from "./components/SettingsDialog";
import { SessionsPanel } from "./components/SessionsPanel";
import { TranscriptView } from "./components/TranscriptView";
import { BugScreen } from "./components/BugScreen";
import { useHashRoute } from "./hooks/useHashRoute";
import { useKeyboard } from "./hooks/useKeyboard";
import { notifyBugTask, notifyFinished, notifyWaiting, setTitleCount, settings } from "./notify";
import { bugMerged } from "./format";
import type { Decision } from "./types";

export function App() {
  const [s, dispatch] = useReducer(reducer, initial);
  const route = useHashRoute();
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [bugOpen, setBugOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [transcriptFor, setTranscriptFor] = useState<string | null>(null);
  const [openTerminalRequest, setOpenTerminalRequest] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const prevStates = useRef<Record<string, string>>({});
  const showErr = (e: unknown) => { setToast((e as Error).message); setTimeout(() => setToast(null), 4000); };

  useEffect(() => api.subscribe(st => dispatch({ type: "snapshot", state: st }), ev => dispatch({ type: "change", event: ev }), v => dispatch({ type: "connected", value: v })), []);

  // Transcript-derived activity → notifications, so embedded-terminal work is covered too.
  const prevPhase = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const a of s.agents) {
      const sid = sessionIdFor(s, a); if (!sid) continue;
      const act = s.activity[sid]; if (!act) continue;
      const prev = prevPhase.current[sid];
      if (prev && prev !== act.phase) {
        if (act.phase === "waiting") notifyWaiting(a.displayName, act.question ? `asks: ${act.question.text.slice(0, 80)}` : `wants to run ${act.pendingTool?.name ?? "a tool"}`);
        if (act.phase === "idle" && prev === "working") notifyFinished(a.displayName, true);
      }
      prevPhase.current[sid] = act.phase;
    }
  }, [s.activity, s.agents]);

  // transitions → notifications + title
  useEffect(() => {
    for (const a of s.agents) {
      const prev = prevStates.current[a.id];
      if (prev && prev !== a.state) {
        const asg = assignmentFor(s, a);
        if (prev === "working" && a.state === "waiting") notifyWaiting(a.displayName, asg?.pending?.kind === "question" ? "has a question" : `wants to run ${asg?.pending?.toolName ?? "a tool"}`);
        if (a.state === "done" || a.state === "failed") notifyFinished(a.displayName, a.state === "done");
      }
      prevStates.current[a.id] = a.state;
    }
    const liveIds = new Set(s.agents.map(a => a.id));
    for (const id of Object.keys(prevStates.current)) if (!liveIds.has(id)) delete prevStates.current[id];
    setTitleCount(new Set([...waitingIds(s), ...s.agents.filter(a => activityFor(s, a)?.phase === "waiting" && a.state === "free").map(a => a.id)]).size);
  }, [s]);

  // Bug-task stage transitions → notifications, for the moments a user isn't looking at the
  // grid: reviewers asked for changes, the merge gate opened, or the task reached its end
  // (merged, or closed without merging). The engine already emits a "bugtask" event on every
  // stage change (bugfix/store.ts, forwarded onto the same event bus agent/assignment events
  // use — see start.ts), which is what keeps `s.bugTasks` current here; this just watches the
  // stage each one carries for the transitions worth surfacing.
  const prevBugStage = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const t of Object.values(s.bugTasks)) {
      const prev = prevBugStage.current[t.id];
      if (prev && prev !== t.stage) {
        const key = t.issue.key;
        if (t.stage === "review-feedback") notifyBugTask(`${key}: reviewers asked for changes`, "attention");
        else if (t.stage === "approved") notifyBugTask(`${key}: PR approved — ready to merge`, "attention");
        else if (t.stage === "done") {
          // The server's own recorded outcome, not the error text: a merged task can carry an
          // error (cleanup leftovers) and a closed one's message is prose.
          notifyBugTask(bugMerged(t) ? `${key}: merged` : `${key}: PR closed without merging`, "finished");
        }
      }
      prevBugStage.current[t.id] = t.stage;
    }
    const liveBugIds = new Set(Object.keys(s.bugTasks));
    for (const id of Object.keys(prevBugStage.current)) if (!liveBugIds.has(id)) delete prevBugStage.current[id];
  }, [s.bugTasks]);

  const selected = s.agents.find(a => a.id === s.selectedId) ?? null;
  const selectedAsg = selected ? assignmentFor(s, selected) : null;
  // Session the side-panel Terminal tab opens: the running assignment's, else the adopted one, else the latest finished one.
  const terminalSessionId = selected ? (selectedAsg?.sessionId ?? selected.resumeSessionId
    ?? Object.values(s.assignments).filter(a => a.agentId === selected.id && a.sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.sessionId ?? null) : null;
  const recentRepos = useMemo(() => [...new Set(s.agents.map(a => a.repo))], [s.agents]);
  const recentFor = useCallback((id: string) => [...new Set(Object.values(s.assignments).filter(a => a.agentId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(a => a.prompt))].slice(0, 8), [s.assignments]);

  const cycleWaiting = useCallback(() => { const ids = waitingIds(s); if (!ids.length) return; const i = ids.indexOf(s.selectedId ?? ""); dispatch({ type: "select", id: ids[(i + 1) % ids.length] }); }, [s]);
  const decide = useCallback((agentId: string, toolUseId: string, d: Decision) => api.answer(agentId, toolUseId, d).catch(showErr), []);
  const openTerminal = useCallback((id: string) => api.openTerminal(id).then(r => { if (!r.opened) { navigator.clipboard?.writeText(r.command); setToast(`Copied: ${r.command}`); setTimeout(() => setToast(null), 6000); } }).catch(showErr), []);

  useKeyboard(useMemo(() => ({
    // The grid's bare-key shortcuts act on the grid's selection, which the bug screen does not
    // show — a stray "a" there would approve a permission request nobody can see.
    select: (i: number) => { if (route.view === "bugs") return; const a = visualOrder(s.agents)[i]; if (a) dispatch({ type: "select", id: a.id }); },
    allow: () => { if (route.view === "bugs") return; if (selected && selectedAsg?.pending?.kind === "permission") void decide(selected.id, selectedAsg.pending.toolUseId, { kind: "allow" }); },
    deny: () => { if (route.view === "bugs") return; if (selected && selectedAsg?.pending?.kind === "permission") void decide(selected.id, selectedAsg.pending.toolUseId, { kind: "deny" }); },
    open: () => { if (route.view === "bugs") return; if (selected && selectedAsg?.sessionId) void openTerminal(selected.id); },
    escape: () => { if (transcriptFor) { setTranscriptFor(null); return; } if (sessionsOpen) { setSessionsOpen(false); return; } if (spawnOpen) { setSpawnOpen(false); return; } if (bugOpen) { setBugOpen(false); return; } if (settingsOpen) { setSettingsOpen(false); return; } if (route.view === "bugs") { route.go({ view: "grid" }); return; } dispatch({ type: "select", id: null }); },
  }), [s.agents, selected, selectedAsg, decide, openTerminal, spawnOpen, sessionsOpen, transcriptFor, bugOpen, settingsOpen, route]));

  return (
    <div className="app">
      <TopBar counts={counts(s)} spend={todaySpend(s)} connected={s.connected} waitingCount={waitingIds(s).length} onCycleWaiting={cycleWaiting} onSpawn={() => setSpawnOpen(true)} onSessions={() => setSessionsOpen(true)} onFixBug={() => setBugOpen(true)} onOpenSettings={() => setSettingsOpen(true)}
        bugsActive={route.view === "bugs"} onToggleBugs={() => route.go(route.view === "bugs" ? { view: "grid" } : { view: "bugs" })} />
      {route.view === "bugs" ? (
        <BugScreen state={s} selectedId={route.bugId} onSelect={(id, opts) => route.go({ view: "bugs", bugId: id }, opts)}
          onBugChanged={t => dispatch({ type: "change", event: { type: "bugtask", task: t } })} onTranscript={id => setTranscriptFor(id)}
          onOpenSettings={() => setSettingsOpen(true)} onFixBug={() => setBugOpen(true)} />
      ) : (
      <div className="split">
        <AgentGrid agents={s.agents} roles={s.roles} assignments={s.assignments} selectedId={s.selectedId} recentFor={recentFor}
          onSelect={id => dispatch({ type: "select", id })}
          onAssign={(id, prompt) => api.assign(id, prompt).then(() => dispatch({ type: "select", id })).catch(showErr)}
          liveSessions={unclaimedLiveSessions(s)} liveFor={ag => liveSessionFor(s, ag)} activityFor={ag => activityFor(s, ag)}
          onPullIn={(sid, role, takeover) => api.adoptSession(sid, { role, takeover }).then(a => { dispatch({ type: "select", id: a.id }); if (takeover) setOpenTerminalRequest(n => n + 1); }).catch(showErr)}
          bugStageFor={ag => bugTaskFor(s, ag)?.stage} />
        <SidePanel agent={selected} role={s.roles.find(r => r.name === selected?.role)} assignment={selectedAsg}
          onDecide={decide} onCancel={id => api.cancel(id).catch(showErr)} onAck={id => api.ack(id).catch(showErr)} onOpenTerminal={openTerminal} onTranscript={id => setTranscriptFor(id)} hasSession={!!selected && Object.values(s.assignments).some(a => a.agentId === selected.id && a.sessionId)} terminalSessionId={terminalSessionId} live={selected ? liveSessionFor(s, selected) : null} openTerminalRequest={openTerminalRequest}
          activity={selected ? activityFor(s, selected) : null}
          onSay={(id, text) => api.say(id, text).catch(showErr)}
          onReset={id => api.resetSession(id).catch(showErr)}
          onRenameSession={(sid, title) => api.renameSession(sid, title).catch(showErr)}
          onDelete={id => api.deleteAgent(id).catch(showErr)}
          bugTask={selected ? bugTaskFor(s, selected) : null}
          onBugChanged={t => dispatch({ type: "change", event: { type: "bugtask", task: t } })} />
      </div>
      )}
      <footer className="foot">
        <label><input type="checkbox" defaultChecked={settings.notifyWaiting} onChange={e => (settings.notifyWaiting = e.target.checked)} /> notify when someone needs me</label>
        <label><input type="checkbox" defaultChecked={settings.notifyFinished} onChange={e => (settings.notifyFinished = e.target.checked)} /> notify on done/failed</label>
        <span className="dim">{route.view === "bugs" ? "keys: ↑↓ move · enter open · esc grid" : "keys: 1–9 select · a allow · d deny · o terminal · esc"}</span>
      </footer>
      {spawnOpen && <SpawnDialog roles={s.roles} recentRepos={recentRepos} onSpawn={async i => { const a = await api.createAgent(i); dispatch({ type: "select", id: a.id }); }} onClose={() => setSpawnOpen(false)} />}
      {bugOpen && <BugLauncher onCreated={t => { setBugOpen(false); dispatch({ type: "select", id: t.agentId }); route.go({ view: "bugs", bugId: t.id }); }} onClose={() => setBugOpen(false)} onOpenSettings={() => { setBugOpen(false); setSettingsOpen(true); }} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {sessionsOpen && <SessionsPanel roles={s.roles} agentNames={Object.fromEntries(s.agents.map(a => [a.id, a.displayName]))}
        onAdopted={id => { setSessionsOpen(false); dispatch({ type: "select", id }); }} onClose={() => setSessionsOpen(false)} />}
      {transcriptFor && (() => { const ag = s.agents.find(a => a.id === transcriptFor); if (!ag) return null;
        return <TranscriptView agent={ag} activity={assignmentFor(s, ag)?.activity ?? ""} onClose={() => setTranscriptFor(null)} />; })()}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
```

### `ui/src/components/TopBar.tsx`

```tsx
import type { AgentState } from "../types";
import { usd } from "../format";

export function TopBar({ counts, spend, connected, waitingCount, onCycleWaiting, onSpawn, onSessions, onFixBug, onOpenSettings, onToggleBugs, bugsActive }: {
  counts: Record<AgentState, number>; spend: number; connected: boolean; waitingCount: number; onCycleWaiting: () => void; onSpawn: () => void; onSessions: () => void; onFixBug: () => void; onOpenSettings: () => void; onToggleBugs: () => void; bugsActive: boolean;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <header className="topbar">
      <span className="brand">⬢ AgentGrid</span>
      <span className="pill">{total} agents</span>
      <div className="sum">
        <span className="pill">● {counts.working} working</span>
        <button className={`pill w ${waitingCount ? "hot" : ""}`} onClick={onCycleWaiting} disabled={!waitingCount}>● {waitingCount} need you</button>
        <span className="pill">● {counts.done} done</span>
        {counts.failed > 0 && <span className="pill f">● {counts.failed} failed</span>}
        <span className="pill">○ {counts.free} free</span>
        <span className="pill">{usd(spend)} today</span>
        {!connected && <span className="pill f">disconnected</span>}
      </div>
      <button className={`btn ${bugsActive ? "on" : ""}`} onClick={onToggleBugs}>{bugsActive ? "Grid" : "Bugs"}</button>
      <button className="btn" onClick={onFixBug}>🐞 Fix a bug</button>
      <button className="btn" onClick={onSessions}>Sessions</button>
      <button className="btn" onClick={onOpenSettings}>⚙︎ Settings</button>
      <button className="btn p" onClick={onSpawn}>+ Spawn</button>
    </header>
  );
}
```

### `ui/src/components/SidePanel.tsx`

```tsx
import { Suspense, lazy, useEffect, useState } from "react";
import type { Agent, Assignment, BugTask, Decision, MemoryFile, RoleDef, SessionInfo, SessionActivity } from "../types";
import { api } from "../api";
import { PendingPrompt } from "./PendingPrompt";
import { BugPanel } from "./BugPanel";
import { ErrorCard } from "./ErrorCard";
import { Markdown } from "./Markdown";
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

export function SidePanel({ agent, role, assignment, onDecide, onCancel, onAck, onOpenTerminal, onTranscript, onDelete, hasSession, terminalSessionId, live, openTerminalRequest, activity, onSay, onReset, onRenameSession, bugTask, onBugChanged }: {
  agent: Agent | null; role: RoleDef | undefined; assignment: Assignment | null;
  onDecide: (agentId: string, toolUseId: string, d: Decision) => void; onCancel: (id: string) => void; onAck: (id: string) => void; onOpenTerminal: (id: string) => void; onTranscript?: (id: string) => void; onDelete: (id: string) => void; hasSession?: boolean;
  /** Session the Terminal tab would open; null when the agent has none yet. */ terminalSessionId?: string | null;
  /** Live process for an adopted session, if any: background → terminal attaches; interactive → terminal unavailable. */ live?: SessionInfo | null;
  /** Bumping this (with a value) opens the Terminal tab — used right after a pull-in. */ openTerminalRequest?: number;
  /** Transcript-derived activity of the agent's session (works while it runs in the embedded terminal). */ activity?: SessionActivity | null;
  onSay?: (id: string, text: string) => Promise<unknown>;
  onReset?: (id: string) => Promise<unknown>;
  onRenameSession?: (sessionId: string, title: string) => Promise<unknown>;
  /** In-flight bug-fix task for the selected agent, if any. */ bugTask?: BugTask | null;
  onBugChanged?: (t: BugTask) => void;
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
      {bugTask && <BugPanel task={bugTask} onChanged={t => onBugChanged?.(t)} onTranscript={onTranscript} />}
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
        {a.state === "done" && <><h4>Outcome</h4><div className="outcome"><Markdown text={a.outcome ?? ""} /></div></>}
        {a.state === "failed" && <><h4>Failed</h4><ErrorCard text={a.error ?? "The run failed."} /></>}
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
```

### `ui/src/main.tsx`

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<App />);
```
