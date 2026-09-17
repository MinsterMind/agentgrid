import { useEffect, useState } from "react";
import type { DirListing, RoleDef } from "../types";
import { api } from "../api";

export function SpawnDialog({ roles, recentRepos, onSpawn, onClose }: {
  roles: RoleDef[]; recentRepos: string[]; onSpawn: (input: { role: string; repo: string; displayName?: string }) => Promise<void>; onClose: () => void;
}) {
  const [role, setRole] = useState(roles[0]?.name ?? ""); const [repo, setRepo] = useState(recentRepos[0] ?? "");
  const [name, setName] = useState(""); const [err, setErr] = useState<string | null>(null);
  const [listing, setListing] = useState<DirListing | null>(null); const [browseErr, setBrowseErr] = useState<string | null>(null);

  const browse = (path?: string) => api.listDir(path).then(l => { setListing(l); setBrowseErr(null); }).catch(e => setBrowseErr((e as Error).message));
  useEffect(() => { void browse(); }, []);

  const submit = async () => {
    if (!role || !repo.startsWith("/")) { setErr("Pick a role and an absolute repo path"); return; }
    try { await onSpawn({ role, repo: repo.trim(), displayName: name.trim() || undefined }); onClose(); } catch (e) { setErr((e as Error).message); }
  };

  // Breadcrumb segments from the browse root down; each maps to the cumulative path up to that segment.
  const crumbs = listing ? [
    { seg: listing.root.split("/").filter(Boolean).pop() ?? "/", path: listing.root },
    ...listing.path.slice(listing.root.length).split("/").filter(Boolean).map((seg, i, all) => ({ seg, path: listing.root + "/" + all.slice(0, i + 1).join("/") })),
  ] : [];

  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h3>Spawn agent</h3>
        <label>Role<select value={role} onChange={e => setRole(e.target.value)}>{roles.map(r => <option key={r.name} value={r.name}>{r.avatar} {r.name}</option>)}</select></label>
        <label>Repo path<input list="recent-repos" value={repo} placeholder="/Users/you/project" onChange={e => setRepo(e.target.value)} />
          <datalist id="recent-repos">{recentRepos.map(r => <option key={r} value={r} />)}</datalist></label>
        {recentRepos.length > 0 && (
          <div className="row quick">{recentRepos.map(r => <button key={r} className={`btn ${repo === r ? "on" : ""}`} onClick={() => setRepo(r)} title={r}>{r.split("/").pop()}</button>)}</div>
        )}
        <div className="browser">
          <div className="crumbs">
            <button className="btn" disabled={!listing?.parent} onClick={() => listing?.parent && browse(listing.parent)}>⬆ up</button>
            {crumbs.map((c, i) => <span key={c.path}>{i > 0 && <span className="dim">/</span>}<button className="crumb" onClick={() => browse(c.path)}>{c.seg}</button></span>)}
            {listing && <button className="btn p sm" onClick={() => setRepo(listing.path)}>Use this folder</button>}
          </div>
          <ul className="folders">
            {listing?.entries.map(e => (
              <li key={e.path}>
                <button className={`folder ${e.isRepo ? "repo" : ""}`} onClick={() => (e.isRepo ? setRepo(e.path) : browse(e.path))}>
                  <span aria-hidden="true">{e.isRepo ? "📁" : "📂"} </span>{e.name}{e.isRepo && <span className="tag">git</span>}
                </button>
                {e.isRepo && <button className="btn sm" title="Browse inside" onClick={() => browse(e.path)}>›</button>}
              </li>
            ))}
            {listing && listing.entries.length === 0 && <li className="dim">No subfolders</li>}
            {!listing && !browseErr && <li className="dim">Loading…</li>}
          </ul>
          {browseErr && <div className="err">{browseErr}</div>}
        </div>
        <label>Name (optional)<input value={name} placeholder="auto" onChange={e => setName(e.target.value)} /></label>
        {err && <div className="err">{err}</div>}
        <div className="row"><button className="btn p" onClick={submit}>Spawn</button><button className="btn" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}
