import { useEffect, useState } from "react";
import { api } from "../api";
import type { BugTask, IssueSummary } from "../types";

/** Start a bug-fix task: pick a ticket (list or URL), pick the repo, check preflight. */
export function BugLauncher({ onCreated, onClose }: { onCreated: (task: BugTask) => void; onClose: () => void }) {
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [issuesErr, setIssuesErr] = useState<string | null>(null);
  const [issueRef, setIssueRef] = useState("");
  const [repo, setRepo] = useState("");
  const [mergePolicy, setMergePolicy] = useState<"ask" | "auto">("ask");
  const [projectRepos, setProjectRepos] = useState<Record<string, string>>({});
  const [preflight, setPreflight] = useState<{ ok: boolean; problems: string[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.myIssues().then(v => { if (live) setIssues(v); }).catch(e => { if (live) setIssuesErr((e as Error).message); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true;
    api.getIntegrations().then(i => { if (live) setProjectRepos(i.projectRepos ?? {}); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const repoTrimmed = repo.trim();
  const repoValid = repoTrimmed.startsWith("/");

  // Any previous preflight result describes the OLD repo value, not this one — it must never
  // outlive a repo edit, and Start must stay blocked until a fresh check for THIS value lands.
  useEffect(() => {
    setPreflight(null);
    if (!repoTrimmed || !repoValid) { setChecking(false); return; }
    let live = true;
    setChecking(true);
    const t = setTimeout(() => {
      api.bugPreflight(repoTrimmed)
        .then(p => { if (live) { setPreflight(p); setChecking(false); } })
        .catch(e => { if (live) { setErr((e as Error).message); setChecking(false); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [repoTrimmed, repoValid]);

  const pickIssue = (i: IssueSummary) => {
    setIssueRef(i.key);
    const remembered = projectRepos[i.key.split("-")[0] ?? ""];
    if (remembered) setRepo(remembered);
  };

  const start = async () => {
    setBusy(true); setErr(null);
    try { onCreated(await api.createBugTask({ issueRef: issueRef.trim(), repo: repoTrimmed, mergePolicy })); onClose(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const blocked = !issueRef.trim() || !repoTrimmed || !repoValid || busy || checking || !preflight || !preflight.ok;

  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog wide" onClick={e => e.stopPropagation()}>
        <h3>🐞 Fix a bug</h3>

        <div className="bugs">
          <h4>My open bugs</h4>
          {!issues && !issuesErr && <p className="hint">Loading from the tracker…</p>}
          {issuesErr && <div className="err">{issuesErr}</div>}
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
        </div>

        <label>Issue URL or key
          <input value={issueRef} placeholder="PAY-42 or https://…/browse/PAY-42" onChange={e => setIssueRef(e.target.value)} /></label>
        <label>Repo
          <div className="row pathrow">
            <input value={repo} placeholder="/Users/you/project" onChange={e => setRepo(e.target.value)} />
            <button className="btn" onClick={async () => { const r = await api.pickFolder().catch(() => undefined); if (r?.path) setRepo(r.path); }}>Browse…</button>
          </div></label>
        {repoTrimmed && !repoValid && <div className="err">Enter an absolute repo path</div>}
        {/* `mergePolicy: "auto"` is validated and persisted by the server but read nowhere —
            nothing implements auto-merge, and the merge gate is the whole point of this workflow.
            The option stays listed, because it is a real planned behaviour and hiding it would
            make the single remaining choice look like a pointless control, but it must not be
            selectable: offering it would promise a merge that never happens. */}
        <label>When the PR is approved
          <select value={mergePolicy} onChange={e => setMergePolicy(e.target.value as "ask" | "auto")}>
            <option value="ask">ask me before merging</option>
            <option value="auto" disabled>merge automatically (not yet available)</option>
          </select></label>

        {checking && <p className="hint">Checking repo…</p>}
        {preflight && !preflight.ok && <div className="err">{preflight.problems.map(p => <div key={p}>{p}</div>)}</div>}
        {/* Some errors (e.g. a leftover-worktree conflict from intake) are several lines —
            "say exactly what to run" only works if those lines actually render as lines,
            not one collapsed run-on. Rendered one <div> per line, the same convention the
            preflight-problems list above already uses. */}
        {err && <div className="err">{err.split("\n").map((line, i) => <div key={i}>{line}</div>)}</div>}
        <div className="row">
          <button className="btn p" disabled={blocked} onClick={start}>{busy ? "Starting…" : "Start fixing"}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
