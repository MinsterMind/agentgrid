import { useEffect, useState } from "react";
import { ArrowUp, ChevronDown, ChevronUp, CircleAlert, Folder, FolderGit2, FolderOpen, FolderX, GitBranch, Plus, ShieldCheck, X } from "lucide-react";
import type { DirListing, RoleDef } from "../types";
import { api } from "../api";

type RepoStatus = { exists: boolean; isRepo: boolean; branch: string | null; clean: boolean | null };

/** New agent: a role (as cards that say what each does), a folder (with a live check of what it
 *  is), and an optional first task — so the agent starts working the moment it exists. */
export function SpawnDialog({ roles, recentRepos, onSpawn, onClose }: {
  roles: RoleDef[]; recentRepos: string[];
  onSpawn: (input: { role: string; repo: string; displayName?: string; task?: string }) => Promise<void>; onClose: () => void;
}) {
  const [role, setRole] = useState(roles[0]?.name ?? ""); const [repo, setRepo] = useState(recentRepos[0] ?? "");
  const [name, setName] = useState(""); const [task, setTask] = useState(""); const [err, setErr] = useState<string | null>(null);
  const [listing, setListing] = useState<DirListing | null>(null); const [browseErr, setBrowseErr] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false); const [picking, setPicking] = useState(false);
  const [status, setStatus] = useState<RepoStatus | null>(null);

  const browse = (path?: string) => api.listDir(path).then(l => { setListing(l); setBrowseErr(null); }).catch(e => setBrowseErr((e as Error).message));
  useEffect(() => { if (panelOpen && !listing) void browse(); }, [panelOpen]);

  // Debounced, and an answer only lands if its path is still the one in the field: typing a path
  // fires one check, and a slow answer for an earlier path can never describe the current one.
  useEffect(() => {
    setStatus(null);
    const p = repo.trim();
    if (!p.startsWith("/")) return;
    let live = true;
    const t = setTimeout(() => { api.repoStatus(p).then(s => { if (live) setStatus(s); }).catch(() => { /* outside the browse root: say nothing */ }); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [repo]);

  // Native picker first (macOS); on any failure fall back to the inline panel.
  const pick = async () => {
    setPicking(true);
    try { const r = await api.pickFolder(); if (r?.path) setRepo(r.path); }
    catch { setPanelOpen(true); }
    finally { setPicking(false); }
  };

  const submit = async () => {
    if (!role || !repo.startsWith("/")) { setErr("Pick a role and an absolute repo path"); return; }
    try { await onSpawn({ role, repo: repo.trim(), displayName: name.trim() || undefined, task: task.trim() || undefined }); onClose(); } catch (e) { setErr((e as Error).message); }
  };

  // Breadcrumb segments from the browse root down; each maps to the cumulative path up to that segment.
  const crumbs = listing ? [
    { seg: listing.root.split("/").filter(Boolean).pop() ?? "/", path: listing.root },
    ...listing.path.slice(listing.root.length).split("/").filter(Boolean).map((seg, i, all) => ({ seg, path: listing.root + "/" + all.slice(0, i + 1).join("/") })),
  ] : [];

  const statusLine = !status ? null
    : !status.exists ? <span className="errtext" data-testid="repo-status"><FolderX /> Folder not found</span>
    : !status.isRepo ? <span className="warntext" data-testid="repo-status"><Folder /> Not a git repo — the agent can still work here</span>
    : <span className="oktext" data-testid="repo-status"><GitBranch /> Git repo on {status.branch} · {status.clean ? "clean" : "uncommitted changes"}</span>;

  return (
    <div className="modal" onClick={onClose}>
      <section className="dialog" role="dialog" aria-label="New agent" onClick={e => e.stopPropagation()}>
        <div className="dlg-hd">
          <span className="dlg-ic"><Plus /></span>
          <div><h2>New agent</h2><p>An agent is one Claude Code worker with a role, in one repo.</p></div>
          <button className="x" aria-label="Close" onClick={onClose}><X /></button>
        </div>
        <div className="dlg-body">
          <div className="field">
            <span className="label"><span className="step-n done">1</span> Role — how it works and which model it uses</span>
            <div className="roles" role="radiogroup" aria-label="Role">
              {roles.map(r => (
                <button key={r.name} type="button" role="radio" aria-checked={role === r.name} className={`role ${role === r.name ? "sel" : ""}`} onClick={() => setRole(r.name)}>
                  <span className="rn">{r.avatar} {r.name}</span>
                  {r.description && <span className="rd">{r.description}</span>}
                  <span className="rm mono">{r.model} · {r.effort}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="label"><span className="step-n done">2</span> Repo — the folder it works in</span>
            <div className="row pathrow">
              <input className="input mono" list="recent-repos" value={repo} placeholder="/Users/you/project" aria-label="Repo folder" onChange={e => setRepo(e.target.value)} />
              <button className="btn" onClick={pick} disabled={picking}><FolderOpen /> {picking ? "Choosing…" : "Browse…"}</button>
              <button className="btn sm" title={panelOpen ? "Hide folder list" : "Show folder list"} aria-label={panelOpen ? "Hide folder list" : "Show folder list"} onClick={() => setPanelOpen(o => !o)}>{panelOpen ? <ChevronUp /> : <ChevronDown />}</button>
            </div>
            <datalist id="recent-repos">{recentRepos.map(r => <option key={r} value={r} />)}</datalist>
            {statusLine}
            {recentRepos.length > 0 && (
              <div className="recent-chips"><span className="help">Recent:</span>
                {recentRepos.map(r => <button key={r} className={`chipbtn ${repo === r ? "on" : ""}`} onClick={() => setRepo(r)} title={r}>{r.split("/").pop()}</button>)}
              </div>
            )}
            {panelOpen && <div className="browser">
              <div className="crumbs">
                {/* The accessible name stays "⬆ up": tests and the e2e find this button by it. */}
                <button className="btn" aria-label="⬆ up" disabled={!listing?.parent} onClick={() => listing?.parent && browse(listing.parent)}><ArrowUp /> up</button>
                {crumbs.map((c, i) => <span key={c.path}>{i > 0 && <span className="dim">/</span>}<button className="crumb" onClick={() => browse(c.path)}>{c.seg}</button></span>)}
                {listing && <button className="btn p sm" onClick={() => setRepo(listing.path)}>Use this folder</button>}
              </div>
              <ul className="folders">
                {listing?.entries.map(e => (
                  <li key={e.path}>
                    <button className={`folder ${e.isRepo ? "repo" : ""}`} onClick={() => (e.isRepo ? setRepo(e.path) : browse(e.path))}>
                      <span aria-hidden="true">{e.isRepo ? <FolderGit2 /> : <Folder />} </span>{e.name}{e.isRepo && <span className="tag">git</span>}
                    </button>
                    {e.isRepo && <button className="btn sm" title="Browse inside" onClick={() => browse(e.path)}>›</button>}
                  </li>
                ))}
                {listing && listing.entries.length === 0 && <li className="dim">No subfolders</li>}
                {!listing && !browseErr && <li className="dim">Loading…</li>}
              </ul>
              {browseErr && <div className="errtext"><CircleAlert /> {browseErr}</div>}
            </div>}
          </div>

          <div className="field">
            <label className="label" htmlFor="first-task"><span className="step-n on">3</span> First task <span className="help">— optional</span></label>
            <textarea id="first-task" className="input" rows={3} value={task} onChange={e => setTask(e.target.value)} placeholder="e.g. Add idempotency keys to the Stripe webhook handler, with tests" />
            <span className="help">Leave it empty to start the agent idle; you can assign work from its card any time.</span>
          </div>

          <div className="field">
            <label className="label" htmlFor="agent-name">Name <span className="help">— optional</span></label>
            <input id="agent-name" className="input" value={name} placeholder="auto" onChange={e => setName(e.target.value)} />
          </div>
          {err && <div className="errtext"><CircleAlert /> {err}</div>}
        </div>
        <div className="dlg-ft">
          <span className="help"><ShieldCheck /> It starts as soon as you create it, and asks you before any risky command.</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn p" onClick={submit}>Create agent</button>
        </div>
      </section>
    </div>
  );
}
