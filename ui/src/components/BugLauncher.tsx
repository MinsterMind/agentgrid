import { useEffect, useState } from "react";
import { api } from "../api";
import type { BugTask, IssueSummary } from "../types";

/** Start a bug-fix task: pick a ticket (list or URL), pick the repo, check preflight. */
export function BugLauncher({ onCreated, onClose }: { onCreated: (task: BugTask) => void; onClose: () => void }) {
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [issueRef, setIssueRef] = useState("");
  const [repo, setRepo] = useState("");
  const [mergePolicy, setMergePolicy] = useState<"ask" | "auto">("ask");
  const [projectRepos, setProjectRepos] = useState<Record<string, string>>({});
  const [preflight, setPreflight] = useState<{ ok: boolean; problems: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.myIssues().then(setIssues).catch(e => setErr((e as Error).message)); }, []);
  useEffect(() => { api.getIntegrations().then(i => setProjectRepos(i.projectRepos ?? {})).catch(() => {}); }, []);
  useEffect(() => {
    if (!repo.trim()) { setPreflight(null); return; }
    let live = true;
    const t = setTimeout(() => { api.bugPreflight(repo.trim()).then(p => live && setPreflight(p)).catch(e => live && setErr((e as Error).message)); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [repo]);

  const pickIssue = (i: IssueSummary) => {
    setIssueRef(i.key);
    const remembered = projectRepos[i.key.split("-")[0] ?? ""];
    if (remembered) setRepo(remembered);
  };

  const start = async () => {
    setBusy(true); setErr(null);
    try { onCreated(await api.createBugTask({ issueRef: issueRef.trim(), repo: repo.trim(), mergePolicy })); onClose(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const blocked = !issueRef.trim() || !repo.trim() || busy || (preflight ? !preflight.ok : false);

  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog wide" onClick={e => e.stopPropagation()}>
        <h3>🐞 Fix a bug</h3>

        <h4>My open bugs</h4>
        {!issues && !err && <p className="hint">Loading from the tracker…</p>}
        {issues && issues.length === 0 && <p className="hint">Nothing assigned to you — paste a ticket below.</p>}
        <ul className="sessions">
          {(issues ?? []).map(i => (
            <li key={i.key}>
              <button className={`folder ${issueRef === i.key ? "repo" : ""}`} onClick={() => pickIssue(i)}>
                <b>{i.key}</b> {i.title}
              </button>
              <span className="dim">{i.priority} · {i.status}</span>
            </li>
          ))}
        </ul>

        <label>Issue URL or key
          <input value={issueRef} placeholder="PAY-42 or https://…/browse/PAY-42" onChange={e => setIssueRef(e.target.value)} /></label>
        <label>Repo
          <div className="row pathrow">
            <input value={repo} placeholder="/Users/you/project" onChange={e => setRepo(e.target.value)} />
            <button className="btn" onClick={async () => { const r = await api.pickFolder().catch(() => undefined); if (r?.path) setRepo(r.path); }}>Browse…</button>
          </div></label>
        <label>When the PR is approved
          <select value={mergePolicy} onChange={e => setMergePolicy(e.target.value as "ask" | "auto")}>
            <option value="ask">ask me before merging</option>
            <option value="auto">merge automatically</option>
          </select></label>

        {preflight && !preflight.ok && <div className="err">{preflight.problems.map(p => <div key={p}>{p}</div>)}</div>}
        {err && <div className="err">{err}</div>}
        <div className="row">
          <button className="btn p" disabled={blocked} onClick={start}>{busy ? "Starting…" : "Start fixing"}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
