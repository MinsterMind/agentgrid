import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { BugTask } from "../types";

interface DiffData { patch: string; files: Array<{ path: string; additions: number; deletions: number }>; additions: number; deletions: number }

/** Per-file slice of a unified diff, so each file can be expanded on its own. */
function hunksFor(patch: string, file: string): string {
  const parts = patch.split(/^diff --git /m).slice(1);
  const hit = parts.find(p => p.split("\n")[0].includes(file));
  // Fall back to the whole patch when a per-file section can't be isolated (e.g. a single-file
  // patch whose header doesn't literally name every file in the summary) rather than show nothing.
  return hit ? `diff --git ${hit}`.trimEnd() : patch;
}

/** Turns a thrown ApiError (or anything else) into what the panel should say — see api.ts's ApiError comment. */
function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 501) return "The bug-fix workflow isn't enabled on this server yet.";
    if (e.status === 404) return "This task no longer exists.";
    if (e.status === 0) return "Couldn't reach the server — check your connection.";
  }
  return (e as Error).message;
}

export function BugPanel({ task, onChanged }: { task: BugTask; onChanged: (t: BugTask) => void }) {
  const [plan, setPlan] = useState<string | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffData | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const gate = task.gate?.kind;
  useEffect(() => {
    if (gate !== "plan") return;
    setPlan(null); setPlanErr(null);
    let live = true;
    api.bugPlan(task.id).then(r => { if (live) setPlan(r.markdown); }).catch(e => { if (live) setPlanErr(describeError(e)); });
    return () => { live = false; };
  }, [gate, task.id]);
  useEffect(() => {
    if (gate !== "diff") return;
    setDiff(null); setDiffErr(null);
    let live = true;
    api.bugDiff(task.id).then(r => { if (live) setDiff(r); }).catch(e => { if (live) setDiffErr(describeError(e)); });
    return () => { live = false; };
  }, [gate, task.id]);

  const act = async (fn: () => Promise<BugTask>) => {
    setBusy(true); setErr(null);
    try { onChanged(await fn()); setAsking(false); setNote(""); }
    catch (e) {
      // 409 means someone else already acted on this task — the local view is just stale.
      // Refresh it instead of showing an error the user did nothing to cause.
      if (e instanceof ApiError && e.status === 409) {
        try { const fresh = (await api.listBugTasks()).find(t => t.id === task.id); if (fresh) onChanged(fresh); }
        catch { /* best-effort refresh; the SSE stream will catch us up */ }
      } else {
        setErr(describeError(e));
      }
    }
    finally { setBusy(false); }
  };

  // Never let a gate action fire before its content has actually loaded — an unseen plan or
  // diff is not something the user has reviewed, whatever the button says.
  const planReady = plan !== null && !planErr;
  const diffReady = diff !== null && !diffErr;

  return (
    <div className="bugpanel" data-testid="bug-panel">
      <div className="bughead">
        <a className="bugkey" href={task.issue.url} target="_blank" rel="noreferrer">{task.issue.key}</a>
        <span className="bugtitle">{task.issue.title}</span>
      </div>
      <div className="row dim">
        <span data-testid="bug-stage" className={`chip ${task.stage}`}>{task.stage}</span>
        <span>{task.issue.priority}</span>
        <span>{task.branch}</span>
        {task.pr && <a href={task.pr.url} target="_blank" rel="noreferrer">PR #{task.pr.number}</a>}
        <span style={{ marginLeft: "auto" }}>${task.costUsd.toFixed(2)}</span>
      </div>

      {err && <div className="err">{err}</div>}

      {gate === "plan" && (
        <div className="gate" data-testid="gate-plan">
          <h4>Plan</h4>
          {planErr
            ? <div className="err">{planErr}</div>
            : <pre className="planmd">{plan ?? "Loading…"}</pre>}
          <div className="row">
            <button className="btn p" disabled={busy || !planReady} onClick={() => act(() => api.approveBug(task.id))}>Approve &amp; implement</button>
            <button className="btn" disabled={busy} onClick={() => setAsking(true)}>Request changes…</button>
            <button className="btn d" disabled={busy} onClick={() => act(() => api.cancelBug(task.id))}>Cancel task</button>
          </div>
        </div>
      )}

      {gate === "diff" && (
        <div className="gate" data-testid="gate-diff">
          <h4>Diff review</h4>
          {diffErr && <div className="err">{diffErr}</div>}
          <div className="row" data-testid="diff-summary">
            <b>{diff ? `${diff.files.length} files` : diffErr ? "Failed to load" : "Loading…"}</b>
            {diff && <span className="add">+{diff.additions}</span>}
            {diff && <span className="del">−{diff.deletions}</span>}
          </div>
          <ul className="difffiles">
            {(diff?.files ?? []).map(f => (
              <li key={f.path}>
                <button className="folder" onClick={() => setOpen(open === f.path ? null : f.path)}>
                  {f.path} <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                </button>
                {open === f.path && <pre className="hunks">{hunksFor(diff!.patch, f.path)}</pre>}
              </li>
            ))}
          </ul>
          <div className="row">
            <button className="btn p" disabled={busy || !diffReady} onClick={() => act(() => api.approveBug(task.id))}>Create PR</button>
            <button className="btn" disabled={busy} onClick={() => setAsking(true)}>Request changes…</button>
            <button className="btn d" disabled={busy} onClick={() => act(() => api.cancelBug(task.id))}>Cancel task</button>
          </div>
        </div>
      )}

      {asking && (
        <form className="row" onSubmit={e => { e.preventDefault(); void act(() => api.requestBugChanges(task.id, note.trim())); }}>
          <input autoFocus aria-label="What should change" value={note} placeholder="What should change?" onChange={e => setNote(e.target.value)} />
          <button className="btn p sm" type="submit" disabled={!note.trim() || busy}>Send</button>
          <button className="btn sm" type="button" onClick={() => setAsking(false)}>Cancel</button>
        </form>
      )}

      {task.stage === "failed" && (
        <div className="gate err" data-testid="gate-failed">
          <h4>Stage failed</h4>
          <pre className="outcome err">{task.error}</pre>
          <div className="row">
            <button className="btn p" disabled={busy} onClick={() => act(() => api.retryBug(task.id))}>Retry stage</button>
            <button className="btn d" disabled={busy} onClick={() => act(() => api.cancelBug(task.id))}>Cancel task</button>
          </div>
        </div>
      )}

      {task.stage === "monitoring" && (
        <p className="hint">PR open — tracked manually in this version. Merge it in the forge when you're ready.</p>
      )}
    </div>
  );
}
