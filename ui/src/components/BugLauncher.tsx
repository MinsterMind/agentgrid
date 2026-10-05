import { useEffect, useState } from "react";
import { Bug, CheckCircle2, CircleAlert, FolderOpen, X } from "lucide-react";
import { api } from "../api";
import type { BugTask, IssueSummary, SetupReport } from "../types";

/** Start a bug-fix task: pick a ticket (list or URL), pick the repo, check preflight. */
export function BugLauncher({ onCreated, onClose, onOpenSettings }: { onCreated?: (task: BugTask) => void; onClose: () => void; onOpenSettings: () => void }) {
  const [setup, setSetup] = useState<SetupReport | null>(null);
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [issuesErr, setIssuesErr] = useState<string | null>(null);
  const [issueRef, setIssueRef] = useState("");
  const [repo, setRepo] = useState("");
  const [mergePolicy, setMergePolicy] = useState<"ask" | "auto">("ask");
  const [projectRepos, setProjectRepos] = useState<Record<string, string>>({});
  const [preflight, setPreflight] = useState<{ ok: boolean; problems: string[]; remote?: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.getSetup().then(r => { if (live) setSetup(r); }).catch(() => {});
    return () => { live = false; };
  }, []);
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
    try { onCreated?.(await api.createBugTask({ issueRef: issueRef.trim(), repo: repoTrimmed, mergePolicy })); onClose(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const blocked = !issueRef.trim() || !repoTrimmed || !repoValid || busy || checking || !preflight || !preflight.ok;

  // Only checks that actually stop a bug fix from starting: a missing forge token, for
  // instance, fails the forge call later with its own clear message and must not nag here
  // while a real blocker (e.g. no tracker) is what needs fixing first.
  const blocking = setup?.checks.filter(c => c.blocks && c.state !== "ok") ?? [];
  const notReady = setup !== null && !setup.ready;

  const KEY = /^[A-Z][A-Z0-9_]*-\d+$/i;
  const ref = issueRef.trim();
  // Anything with a "/" is a URL, scheme or not; keys are matched case-insensitively, as before.
  const keyBad = ref !== "" && !ref.includes("/") && !KEY.test(ref);
  const startTitle = !ref ? "Pick or paste a ticket first" : keyBad ? "Fix the ticket key first"
    : !repoValid ? "Enter the repo's absolute path" : checking ? "Checking the repo…"
    : preflight && !preflight.ok ? "Fix the repo problems above" : "";
  const prio = (p: string) => /highest|critical|blocker/i.test(p) ? "red" : /high/i.test(p) ? "amber" : "";

  return (
    <div className="modal" onClick={onClose}>
      <section className="dialog wide" role="dialog" aria-label="Fix a bug" onClick={e => e.stopPropagation()}>
        <div className="dlg-hd">
          <span className="dlg-ic amber"><Bug /></span>
          <div><h2>Fix a bug</h2><p>From ticket to merged pull request. You approve each step.</p></div>
          <button className="x" aria-label="Close" onClick={onClose}><X /></button>
        </div>

        {notReady ? (
          <div className="dlg-body">
            <p>The bug-fix workflow is not configured yet:</p>
            {blocking.map(c => <div key={c.id} className="errtext"><CircleAlert /> {c.detail}</div>)}
            <div className="row">
              <button className="btn p" onClick={onOpenSettings}>Open Settings</button>
              <button className="btn" onClick={onClose}>Cancel</button>
            </div>
          </div>
        ) : <>
        <div className="dlg-body">
          <div className="field">
            <span className="label"><span className={`step-n ${ref && !keyBad ? "done" : "on"}`}>1</span> Ticket</span>
            <div className="bugs">
            <span className="help">My open bugs</span>
            {!issues && !issuesErr && <p className="help">Loading from the tracker…</p>}
            {issuesErr && <div className="errtext"><CircleAlert /> {issuesErr}</div>}
            {issues && issues.length === 0 && <p className="help">Nothing assigned to you — paste a ticket below.</p>}
            {issues && issues.length > 0 && (
              <div className="tickets" aria-label="Assigned to you">
                {issues.map(i => (
                  <button key={i.key} className={`tk ${issueRef === i.key ? "sel" : ""}`} onClick={() => pickIssue(i)}>
                    <span className="k">{i.key}</span><span>{i.title}</span><span className={`chip ${prio(i.priority)}`}>{i.priority}</span>
                  </button>
                ))}
              </div>
            )}
            </div>
            <label className="help" htmlFor="issue-ref">Issue URL or key</label>
            <input id="issue-ref" className={`input mono ${keyBad ? "err" : ""}`} value={issueRef} placeholder="PAY-42 or https://…/browse/PAY-42" aria-invalid={keyBad} onChange={e => setIssueRef(e.target.value)} />
            {keyBad && <span className="errtext" data-testid="key-error"><CircleAlert /> A ticket key looks like PAY-123 — or paste the ticket's URL.</span>}
          </div>

          <div className="field">
            <span className="label"><span className={`step-n ${preflight?.ok ? "done" : ref ? "on" : ""}`}>2</span> <label htmlFor="bug-repo">Repo</label></span>
            <div className="row pathrow">
              <input id="bug-repo" className="input mono" value={repo} placeholder="/Users/you/project" onChange={e => setRepo(e.target.value)} />
              <button className="btn" onClick={async () => { const r = await api.pickFolder().catch(() => undefined); if (r?.path) setRepo(r.path); }}><FolderOpen /> Browse…</button>
            </div>
            {repoTrimmed && !repoValid && <div className="errtext"><CircleAlert /> Enter an absolute repo path</div>}
            {checking && <p className="help">Checking repo…</p>}
            {preflight && !preflight.ok && <div className="errtext" style={{ alignItems: "flex-start" }}><CircleAlert /><div>{preflight.problems.map(p => <div key={p}>{p}</div>)}</div></div>}
            {preflight?.ok && preflight.remote && <span className="oktext"><CheckCircle2 /> Remote found: <span className="mono">{preflight.remote}</span></span>}
          </div>

          {/* `mergePolicy: "auto"` is validated and persisted by the server but read nowhere —
              nothing implements auto-merge, and the merge gate is the whole point of this workflow.
              The option stays listed, because it is a real planned behaviour and hiding it would
              make the single remaining choice look like a pointless control, but it must not be
              selectable: offering it would promise a merge that never happens. */}
          <div className="field">
            <span className="label"><span className="step-n">3</span> When the PR is approved</span>
            <div className="opts" role="radiogroup" aria-label="When the PR is approved">
              <button type="button" role="radio" aria-checked={mergePolicy === "ask"} className={`opt ${mergePolicy === "ask" ? "sel" : ""}`} onClick={() => setMergePolicy("ask")}>
                <span className="radio" /><span><b>Ask me before merging</b><span className="help" style={{ display: "block" }}>You pick the merge method and press Merge.</span></span>
              </button>
              <button type="button" role="radio" aria-checked={false} aria-disabled="true" className="opt disabled" onClick={() => {}}>
                <span className="radio" /><span><b>Merge automatically</b><span className="help" style={{ display: "block" }}>Coming later — not available yet.</span></span>
              </button>
            </div>
          </div>

          <div className="next" aria-label="What happens next">
            <b>What happens next:</b>
            <span className="dot c" /> agent writes a plan →
            <span className="dot a" /> you approve →
            <span className="dot c" /> it fixes →
            <span className="dot a" /> you review the diff →
            <span className="dot c" /> PR opened
          </div>

          {/* Some errors (e.g. a leftover-worktree conflict from intake) are several lines —
              "say exactly what to run" only works if those lines actually render as lines,
              not one collapsed run-on. Rendered one <div> per line, the same convention the
              preflight-problems list above already uses. */}
          {err && <div className="err">{err.split("\n").map((line, i) => <div key={i}>{line}</div>)}</div>}
        </div>
        <div className="dlg-ft">
          <span className="help">Nothing is pushed until you approve the diff.</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn p" disabled={blocked || keyBad} title={startTitle} onClick={start}>{busy ? "Starting…" : "Start fixing"}</button>
        </div>
        </>}
      </section>
    </div>
  );
}
