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
import { useKeyboard } from "./hooks/useKeyboard";
import { notifyBugTask, notifyFinished, notifyWaiting, setTitleCount, settings } from "./notify";
import { bugMerged } from "./format";
import type { Decision } from "./types";

export function App() {
  const [s, dispatch] = useReducer(reducer, initial);
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
    select: (i: number) => { const a = visualOrder(s.agents)[i]; if (a) dispatch({ type: "select", id: a.id }); },
    allow: () => { if (selected && selectedAsg?.pending?.kind === "permission") void decide(selected.id, selectedAsg.pending.toolUseId, { kind: "allow" }); },
    deny: () => { if (selected && selectedAsg?.pending?.kind === "permission") void decide(selected.id, selectedAsg.pending.toolUseId, { kind: "deny" }); },
    open: () => { if (selected && selectedAsg?.sessionId) void openTerminal(selected.id); },
    escape: () => { if (transcriptFor) { setTranscriptFor(null); return; } if (sessionsOpen) { setSessionsOpen(false); return; } if (spawnOpen) { setSpawnOpen(false); return; } if (bugOpen) { setBugOpen(false); return; } if (settingsOpen) { setSettingsOpen(false); return; } dispatch({ type: "select", id: null }); },
  }), [s.agents, selected, selectedAsg, decide, openTerminal, spawnOpen, sessionsOpen, transcriptFor, bugOpen, settingsOpen]));

  return (
    <div className="app">
      <TopBar counts={counts(s)} spend={todaySpend(s)} connected={s.connected} waitingCount={waitingIds(s).length} onCycleWaiting={cycleWaiting} onSpawn={() => setSpawnOpen(true)} onSessions={() => setSessionsOpen(true)} onFixBug={() => setBugOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
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
      <footer className="foot">
        <label><input type="checkbox" defaultChecked={settings.notifyWaiting} onChange={e => (settings.notifyWaiting = e.target.checked)} /> notify when someone needs me</label>
        <label><input type="checkbox" defaultChecked={settings.notifyFinished} onChange={e => (settings.notifyFinished = e.target.checked)} /> notify on done/failed</label>
        <span className="dim">keys: 1–9 select · a allow · d deny · o terminal · esc</span>
      </footer>
      {spawnOpen && <SpawnDialog roles={s.roles} recentRepos={recentRepos} onSpawn={async i => { const a = await api.createAgent(i); dispatch({ type: "select", id: a.id }); }} onClose={() => setSpawnOpen(false)} />}
      {bugOpen && <BugLauncher onCreated={t => { setBugOpen(false); dispatch({ type: "select", id: t.agentId }); }} onClose={() => setBugOpen(false)} onOpenSettings={() => { setBugOpen(false); setSettingsOpen(true); }} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {sessionsOpen && <SessionsPanel roles={s.roles} agentNames={Object.fromEntries(s.agents.map(a => [a.id, a.displayName]))}
        onAdopted={id => { setSessionsOpen(false); dispatch({ type: "select", id }); }} onClose={() => setSessionsOpen(false)} />}
      {transcriptFor && (() => { const ag = s.agents.find(a => a.id === transcriptFor); if (!ag) return null;
        return <TranscriptView agent={ag} activity={assignmentFor(s, ag)?.activity ?? ""} onClose={() => setTranscriptFor(null)} />; })()}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
