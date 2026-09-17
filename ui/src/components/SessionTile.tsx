import { useState } from "react";
import type { RoleDef, SessionInfo } from "../types";
import { basename, elapsed } from "../format";

/** A live Claude Code session that isn't on the grid yet — shown so nothing running is invisible. */
export function SessionTile({ session, roles, onPullIn }: { session: SessionInfo; roles: RoleDef[]; onPullIn: (sessionId: string, role: string, takeover: boolean) => Promise<void> }) {
  const [role, setRole] = useState(roles[0]?.name ?? "coder");
  const [busy, setBusy] = useState(false);
  const bg = session.kind === "background";
  return (
    <div className="livecard" data-state={session.status} data-testid={`session-${session.sessionId}`}>
      <span className={`dot ${session.status}`} title={session.status} />
      <span className="kind">{bg ? "bg" : "tty"}</span>
      <span className="ltitle" title={session.sessionId}>{session.title}</span>
      <span className="lrepo" title={session.cwd}>{basename(session.cwd)}</span>
      <span className="lmeta">{session.status} · {elapsed(new Date(session.at).toISOString())}</span>
      <span className="lactions" onClick={e => e.stopPropagation()}>
        <select value={role} onChange={e => setRole(e.target.value)} aria-label="Role">{roles.map(r => <option key={r.name} value={r.name}>{r.avatar} {r.name}</option>)}</select>
        <button className="btn p sm" disabled={busy} title={bg ? "Put this background session on the grid (attach in the Terminal tab)" : "Close it in its terminal and continue it here"}
          onClick={async () => {
            if (!bg && !window.confirm(`Pull in "${session.title}"?\n\nThis closes the session in its terminal (Claude Code saves the conversation) and opens it in the grid's Terminal tab.`)) return;
            setBusy(true); try { await onPullIn(session.sessionId, role, !bg); } finally { setBusy(false); }
          }}>{busy ? "Pulling in…" : bg ? "Pull in" : "Pull in ↩"}</button>
      </span>
    </div>
  );
}
