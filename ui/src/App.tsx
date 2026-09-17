import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { api } from "./api";
import { reducer, initial, assignmentFor, counts, todaySpend, waitingIds } from "./state/reducer";
import { AgentGrid } from "./components/AgentGrid";
import { SidePanel } from "./components/SidePanel";
import { TopBar } from "./components/TopBar";
import { SpawnDialog } from "./components/SpawnDialog";
import { SessionsPanel } from "./components/SessionsPanel";
import { useKeyboard } from "./hooks/useKeyboard";
import { notifyFinished, notifyWaiting, setTitleCount, settings } from "./notify";
import type { Decision } from "./types";

export function App() {
  const [s, dispatch] = useReducer(reducer, initial);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const prevStates = useRef<Record<string, string>>({});
  const showErr = (e: unknown) => { setToast((e as Error).message); setTimeout(() => setToast(null), 4000); };

  useEffect(() => api.subscribe(st => dispatch({ type: "snapshot", state: st }), ev => dispatch({ type: "change", event: ev }), v => dispatch({ type: "connected", value: v })), []);

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
    setTitleCount(waitingIds(s).length);
  }, [s]);

  const selected = s.agents.find(a => a.id === s.selectedId) ?? null;
  const selectedAsg = selected ? assignmentFor(s, selected) : null;
  const recentRepos = useMemo(() => [...new Set(s.agents.map(a => a.repo))], [s.agents]);
  const recentFor = useCallback((id: string) => [...new Set(Object.values(s.assignments).filter(a => a.agentId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(a => a.prompt))].slice(0, 8), [s.assignments]);

  const cycleWaiting = useCallback(() => { const ids = waitingIds(s); if (!ids.length) return; const i = ids.indexOf(s.selectedId ?? ""); dispatch({ type: "select", id: ids[(i + 1) % ids.length] }); }, [s]);
  const decide = useCallback((agentId: string, toolUseId: string, d: Decision) => api.answer(agentId, toolUseId, d).catch(showErr), []);
  const openTerminal = useCallback((id: string) => api.openTerminal(id).then(r => { if (!r.opened) { navigator.clipboard?.writeText(r.command); setToast(`Copied: ${r.command}`); setTimeout(() => setToast(null), 6000); } }).catch(showErr), []);

  useKeyboard(useMemo(() => ({
    select: (i: number) => { const a = s.agents[i]; if (a) dispatch({ type: "select", id: a.id }); },
    allow: () => { if (selected && selectedAsg?.pending?.kind === "permission") void decide(selected.id, selectedAsg.pending.toolUseId, { kind: "allow" }); },
    deny: () => { if (selected && selectedAsg?.pending?.kind === "permission") void decide(selected.id, selectedAsg.pending.toolUseId, { kind: "deny" }); },
    open: () => { if (selected && selectedAsg?.sessionId) void openTerminal(selected.id); },
    escape: () => { if (sessionsOpen) { setSessionsOpen(false); return; } if (spawnOpen) { setSpawnOpen(false); return; } dispatch({ type: "select", id: null }); },
  }), [s.agents, selected, selectedAsg, decide, openTerminal, spawnOpen, sessionsOpen]));

  return (
    <div className="app">
      <TopBar counts={counts(s)} spend={todaySpend(s)} connected={s.connected} waitingCount={waitingIds(s).length} onCycleWaiting={cycleWaiting} onSpawn={() => setSpawnOpen(true)} onSessions={() => setSessionsOpen(true)} />
      <div className="split">
        <AgentGrid agents={s.agents} roles={s.roles} assignments={s.assignments} selectedId={s.selectedId} recentFor={recentFor}
          onSelect={id => dispatch({ type: "select", id })}
          onAssign={(id, prompt) => api.assign(id, prompt).then(() => dispatch({ type: "select", id })).catch(showErr)} />
        <SidePanel agent={selected} role={s.roles.find(r => r.name === selected?.role)} assignment={selectedAsg}
          onDecide={decide} onCancel={id => api.cancel(id).catch(showErr)} onAck={id => api.ack(id).catch(showErr)} onOpenTerminal={openTerminal}
          onDelete={id => api.deleteAgent(id).catch(showErr)} />
      </div>
      <footer className="foot">
        <label><input type="checkbox" defaultChecked={settings.notifyWaiting} onChange={e => (settings.notifyWaiting = e.target.checked)} /> notify when someone needs me</label>
        <label><input type="checkbox" defaultChecked={settings.notifyFinished} onChange={e => (settings.notifyFinished = e.target.checked)} /> notify on done/failed</label>
        <span className="dim">keys: 1–9 select · a allow · d deny · o terminal · esc</span>
      </footer>
      {spawnOpen && <SpawnDialog roles={s.roles} recentRepos={recentRepos} onSpawn={async i => { const a = await api.createAgent(i); dispatch({ type: "select", id: a.id }); }} onClose={() => setSpawnOpen(false)} />}
      {sessionsOpen && <SessionsPanel roles={s.roles} agentNames={Object.fromEntries(s.agents.map(a => [a.id, a.displayName]))}
        onAdopted={id => { setSessionsOpen(false); dispatch({ type: "select", id }); }} onClose={() => setSessionsOpen(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
