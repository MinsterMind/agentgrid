import { useEffect, useState } from "react";
import type { RoleDef, SessionInfo } from "../types";
import { api } from "../api";
import { basename, elapsed } from "../format";

const REFRESH_MS = 10_000;

export function SessionsPanel({ roles, agentNames, onAdopted, onClose }: {
  roles: RoleDef[]; agentNames: Record<string, string>; onAdopted: (agentId: string) => void; onClose: () => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [roleFor, setRoleFor] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [byId, setById] = useState(""); const [byIdRole, setByIdRole] = useState(roles[0]?.name ?? "coder");
  const [filter, setFilter] = useState("");

  const refresh = () => api.listSessions().then(s => { setSessions(s); setErr(null); }).catch(e => setErr((e as Error).message));
  useEffect(() => { void refresh(); const t = setInterval(refresh, REFRESH_MS); return () => clearInterval(t); }, []);

  const adopt = async (s: SessionInfo) => {
    setBusy(s.sessionId);
    try { const a = await api.adoptSession(s.sessionId, { role: roleFor[s.sessionId] ?? roles[0]?.name ?? "coder" }); onAdopted(a.id); await refresh(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };
  const pullInById = async () => {
    const id = byId.trim(); if (!id) return;
    setBusy("byid");
    try {
      const info = await api.getSession(id);
      if (!info.canAdopt) throw new Error(info.agentId ? `already on the grid as ${agentNames[info.agentId] ?? info.agentId}` : "cannot be adopted");
      const takeover = info.kind === "interactive" && info.owner !== "grid";
      if (takeover && !window.confirm(`"${info.title}" is open in a terminal. Close it there and continue it in the grid?`)) return;
      const a = await api.adoptSession(id, { role: byIdRole, takeover }); setById(""); onAdopted(a.id); await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const rename = async (s: SessionInfo) => {
    const title = window.prompt("Session name", s.title);
    if (title === null || !title.trim() || title.trim() === s.title) return;
    try { await api.renameSession(s.sessionId, title.trim()); await refresh(); } catch (e) { setErr((e as Error).message); }
  };
  const attach = (s: SessionInfo) => api.attachSession(s.sessionId).then(r => { if (!r.opened) { navigator.clipboard?.writeText(r.command); setErr(`Copied: ${r.command}`); } }).catch(e => setErr((e as Error).message));

  const q = filter.trim().toLowerCase();
  const matches = (s: SessionInfo) => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.sessionId.startsWith(q);
  const live = sessions?.filter(s => s.kind !== "history" && matches(s)) ?? [];
  const recent = sessions?.filter(s => s.kind === "history" && matches(s)) ?? [];
  const owner = (s: SessionInfo) => s.agentId ? <span className="tag own">on grid as {agentNames[s.agentId] ?? s.agentId}</span> : null;

  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog wide" onClick={e => e.stopPropagation()}>
        <div className="hd"><h3 style={{ margin: 0 }}>Claude Code sessions</h3><button className="btn sm" style={{ marginLeft: "auto" }} onClick={refresh}>↻</button><button className="btn sm" onClick={onClose}>✕</button></div>
        {err && <div className="err">{err}</div>}
        <div className="row byid">
          <input value={byId} placeholder="Pull in by session id (e.g. 6de15081-…)" onChange={e => setById(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void pullInById(); }} aria-label="Session id" />
          <select value={byIdRole} onChange={e => setByIdRole(e.target.value)} aria-label="Role for session id">{roles.map(r => <option key={r.name} value={r.name}>{r.avatar} {r.name}</option>)}</select>
          <button className="btn p sm" disabled={!byId.trim() || busy === "byid"} onClick={pullInById}>Pull in</button>
        </div>
        <div className="row"><input value={filter} placeholder="Filter by name, repo or id…" onChange={e => setFilter(e.target.value)} aria-label="Filter sessions" /></div>
        {!sessions && !err && <p className="hint">Loading…</p>}

        <h4>Live ({live.length})</h4>
        <ul className="sessions" data-testid="sessions-live">
          {live.map(s => (
            <li key={s.sessionId}>
              <span className={`st ${s.status}`}>● {s.status}</span>
              <span className="title" title={s.sessionId}>{s.title}</span>
              <button className="btn sm" title="Rename session" aria-label={`Rename ${s.title}`} onClick={() => rename(s)}>✎</button>
              <span className="repo" title={s.cwd}>{basename(s.cwd)}</span>
              <span className="dim">{s.owner === "grid" ? "grid terminal" : s.kind === "background" ? "background" : "terminal"} · {elapsed(new Date(s.at).toISOString())}</span>
              {owner(s)}
              {s.bgId && <button className="btn sm" onClick={() => attach(s)}>Attach in Terminal ↗</button>}
            </li>
          ))}
          {sessions && live.length === 0 && <li className="dim">No running sessions.</li>}
        </ul>

        <h4>Recent ({recent.length})</h4>
        <ul className="sessions" data-testid="sessions-recent">
          {recent.map(s => (
            <li key={s.sessionId}>
              <span className="st ended">○</span>
              <span className="title" title={s.sessionId}>{s.title}</span>
              <button className="btn sm" title="Rename session" aria-label={`Rename ${s.title}`} onClick={() => rename(s)}>✎</button>
              <span className="repo" title={s.cwd}>{basename(s.cwd)}</span>
              <span className="dim">{elapsed(new Date(s.at).toISOString())} ago</span>
              {owner(s)}
              {s.canAdopt && <>
                <select value={roleFor[s.sessionId] ?? roles[0]?.name ?? ""} onChange={e => setRoleFor(r => ({ ...r, [s.sessionId]: e.target.value }))}>
                  {roles.map(r => <option key={r.name} value={r.name}>{r.avatar} {r.name}</option>)}
                </select>
                <button className="btn p sm" disabled={busy === s.sessionId} onClick={() => adopt(s)}>Adopt into grid</button>
              </>}
            </li>
          ))}
          {sessions && recent.length === 0 && <li className="dim">No recent sessions.</li>}
        </ul>
        <p className="hint">Adopting puts a session on the grid as an agent that <b>continues that conversation</b> with every prompt you assign. Sessions open in a terminal can't be adopted until you close them.</p>
      </div>
    </div>
  );
}
