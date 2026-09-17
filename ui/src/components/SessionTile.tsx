import { useState } from "react";
import type { RoleDef, SessionInfo } from "../types";
import { basename, elapsed } from "../format";

/** A live Claude Code session that isn't on the grid yet — shown so nothing running is invisible. */
export function SessionTile({ session, roles, onPullIn }: { session: SessionInfo; roles: RoleDef[]; onPullIn: (sessionId: string, role: string) => Promise<void> }) {
  const [role, setRole] = useState(roles[0]?.name ?? "coder");
  const [busy, setBusy] = useState(false);
  const bg = session.kind === "background";
  return (
    <div className="tile ghost" data-state={session.status} data-testid={`session-${session.sessionId}`}>
      <span className="badge live">{session.status}</span>
      <div className="hd">
        <div className="av">{bg ? "⏳" : "🖥️"}</div>
        <div><div className="name" title={session.sessionId}>{session.title}</div><div className="repo" title={session.cwd}>{basename(session.cwd)} · {bg ? "background" : "terminal"}</div></div>
      </div>
      <div className="act dim">Live Claude Code session · {elapsed(new Date(session.at).toISOString())}</div>
      <div className="row" onClick={e => e.stopPropagation()}>
        <select value={role} onChange={e => setRole(e.target.value)} aria-label="Role">{roles.map(r => <option key={r.name} value={r.name}>{r.avatar} {r.name}</option>)}</select>
        <button className="btn p sm" disabled={busy} onClick={async () => { setBusy(true); try { await onPullIn(session.sessionId, role); } finally { setBusy(false); } }}>Pull in</button>
      </div>
    </div>
  );
}
