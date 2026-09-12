import { useState } from "react";
import type { RoleDef } from "../types";

export function SpawnDialog({ roles, recentRepos, onSpawn, onClose }: {
  roles: RoleDef[]; recentRepos: string[]; onSpawn: (input: { role: string; repo: string; displayName?: string }) => Promise<void>; onClose: () => void;
}) {
  const [role, setRole] = useState(roles[0]?.name ?? ""); const [repo, setRepo] = useState(recentRepos[0] ?? "");
  const [name, setName] = useState(""); const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!role || !repo.startsWith("/")) { setErr("Pick a role and an absolute repo path"); return; }
    try { await onSpawn({ role, repo: repo.trim(), displayName: name.trim() || undefined }); onClose(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h3>Spawn agent</h3>
        <label>Role<select value={role} onChange={e => setRole(e.target.value)}>{roles.map(r => <option key={r.name} value={r.name}>{r.avatar} {r.name}</option>)}</select></label>
        <label>Repo path<input list="recent-repos" value={repo} placeholder="/Users/you/project" onChange={e => setRepo(e.target.value)} />
          <datalist id="recent-repos">{recentRepos.map(r => <option key={r} value={r} />)}</datalist></label>
        <label>Name (optional)<input value={name} placeholder="auto" onChange={e => setName(e.target.value)} /></label>
        {err && <div className="err">{err}</div>}
        <div className="row"><button className="btn p" onClick={submit}>Spawn</button><button className="btn" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}
