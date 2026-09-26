import { useEffect, useRef, useState } from "react";
import { api, ApiError, type MergeMethod } from "../api";
import type { BugTask, PrInfo } from "../types";

interface DiffData { patch: string; files: Array<{ path: string; additions: number; deletions: number }>; additions: number; deletions: number }

/**
 * Per-file slice of a unified diff, so each file can be expanded on its own.
 * When the split can't isolate this file (a rename, or a header format that doesn't literally
 * name every path in `files[]`), fall back to the whole patch — but flag it as unisolated so the
 * card never presents unrelated content as if it were this file's diff.
 */
function hunksFor(patch: string, file: string): { text: string; isolated: boolean } {
  const parts = patch.split(/^diff --git /m).slice(1);
  // Match the header exactly, not by substring: in a monorepo one path is routinely a suffix of
  // another ("package.json" vs "ui/package.json"), and a substring match then picks the wrong
  // section *and* reports it as isolated, showing file B's hunks under file A's name.
  const hit = parts.find(p => p.split("\n")[0].trimEnd() === `a/${file} b/${file}`);
  return hit ? { text: `diff --git ${hit}`.trimEnd(), isolated: true } : { text: patch, isolated: false };
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

/** Renders a possibly-multi-line message as one <div> per line — the same convention
 *  BugLauncher's intake error already uses, reused here for the cleanup message a `done`
 *  task with leftovers carries (it names paths and the exact commands to clear them, so the
 *  lines have to stay lines). */
function Lines({ text, className }: { text: string; className?: string }) {
  return <div className={className}>{text.split("\n").map((line, i) => <div key={i}>{line}</div>)}</div>;
}

const REVIEW_LABEL: Record<string, string> = { CHANGES_REQUESTED: "Changes requested", APPROVED: "Approved", REVIEW_REQUIRED: "Review required" };
const CHECKS_LABEL: Record<string, string> = { SUCCESS: "Checks passing", FAILURE: "Checks failing", ERROR: "Checks failing", PENDING: "Checks pending" };
const MERGEABLE_LABEL: Record<string, string> = { MERGEABLE: "Mergeable", CONFLICTING: "Conflicting", UNKNOWN: "Mergeable state unknown" };

/** The PR's forge-state chips, shared by the monitoring and merge-gate cards. The PR link
 *  itself is already rendered once, in the head row above, for every stage that has a PR —
 *  this only adds the state that the head row doesn't carry. */
function PrChips({ pr }: { pr: PrInfo }) {
  return (
    <div className="row" data-testid="pr-summary">
      {pr.reviewDecision && <span className="chip">{REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision}</span>}
      {pr.checks && <span className="chip">{CHECKS_LABEL[pr.checks] ?? pr.checks}</span>}
      {pr.mergeable && <span className="chip">{MERGEABLE_LABEL[pr.mergeable] ?? pr.mergeable}</span>}
    </div>
  );
}

export function BugPanel({ task, onChanged, onTranscript }: { task: BugTask; onChanged: (t: BugTask) => void; onTranscript?: (agentId: string) => void }) {
  const [plan, setPlan] = useState<string | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffData | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>(task.mergeMethod);
  // The select's own override, only — it must NOT track every prop update (an SSE-refreshed
  // `task` for the SAME task shouldn't clobber what the human just picked), but it MUST reset
  // when the panel is repointed at a DIFFERENT task: SidePanel keeps one BugPanel mounted
  // across the whole sidebar's lifetime and re-renders it with a new `task` prop on selection
  // change, with no `key` to force a remount — so without this, switching from task A to task
  // B while A's method is still selected would merge B with A's method.
  useEffect(() => { setMergeMethod(task.mergeMethod); }, [task.id]);

  // The freshest task prop the parent has handed us, kept outside render so an in-flight
  // 409 refetch can compare against the CURRENT props when it resolves, not the ones captured
  // when the click fired (the SSE stream may have moved the task on in the meantime).
  const taskRef = useRef(task);
  useEffect(() => { taskRef.current = task; }, [task]);

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
      // Refresh it instead of showing an error the user did nothing to cause. But only apply
      // the refetch if it's actually newer than what's in props by the time it lands — a
      // genuine SSE update may have arrived first, and this correction has no business
      // overwriting a state that's already fresher than what we're about to write.
      if (e instanceof ApiError && e.status === 409) {
        try {
          const fresh = (await api.listBugTasks()).find(t => t.id === task.id);
          if (fresh && fresh.id === taskRef.current.id && fresh.updatedAt > taskRef.current.updatedAt) onChanged(fresh);
        }
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
          {task.gate?.reason === "feedback" && (
            <div className="hint" data-testid="gate-reason">
              <b>Reviewers asked for changes.</b>
              {(() => {
                const comments = [...task.history].reverse().find(h => h.stage === "review-feedback")?.note;
                return comments ? <p>{comments}</p> : null;
              })()}
            </div>
          )}
          {task.gate?.reason === "rebase" && (
            <p className="hint" data-testid="gate-reason"><b>This branch conflicts with <code>{task.baseBranch}</code>.</b></p>
          )}
          {/* The diff above is a live `git diff`; this is the commit the server pinned when the
              gate opened, and the one it will insist on before pushing. */}
          {task.approvedHead && <p className="hint" data-testid="diff-commit">Reviewing commit {task.approvedHead.slice(0, 7)}</p>}
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
                {open === f.path && (() => { const h = hunksFor(diff!.patch, f.path); return (
                  <>
                    {!h.isolated && <p className="hint">Could not isolate this file's hunks — showing the full diff instead.</p>}
                    <pre className="hunks">{h.text}</pre>
                  </>
                ); })()}
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
        <div className="gate" data-testid="gate-monitoring">
          <h4>Monitoring</h4>
          {task.pr && <PrChips pr={task.pr} />}
          {task.pr && <p className="hint" data-testid="pr-last-checked">Last checked {new Date(task.pr.lastSeenEventAt).toLocaleString()}</p>}
          {task.error && task.error.startsWith("could not check") && <div className="err">{task.error}</div>}
          <div className="row">
            <button className="btn p" disabled={busy} onClick={() => act(() => api.addressComments(task.id))}>Ask the agent to address these</button>
            <button className="btn d" disabled={busy} onClick={() => act(() => api.cancelBug(task.id))}>Cancel task</button>
          </div>
        </div>
      )}

      {gate === "merge" && (
        <div className="gate" data-testid="gate-merge">
          <h4>Ready to merge</h4>
          {task.pr && <PrChips pr={task.pr} />}
          <label className="row">Merge method
            <select value={mergeMethod} onChange={e => setMergeMethod(e.target.value as MergeMethod)}>
              <option value="squash">Squash and merge</option>
              <option value="merge">Merge commit</option>
              <option value="rebase">Rebase and merge</option>
            </select>
          </label>
          <div className="row">
            <button className="btn p" disabled={busy} onClick={() => act(() => api.approveBug(task.id, mergeMethod))}>Merge</button>
            <button className="btn" disabled={busy} onClick={() => setAsking(true)}>Request changes…</button>
            <button className="btn d" disabled={busy} onClick={() => act(() => api.cancelBug(task.id))}>Cancel task</button>
          </div>
        </div>
      )}

      {(task.stage === "pushing" || task.stage === "merging") && (
        <p className="hint" data-testid="gate-server-stage">{task.stage === "pushing" ? "Pushing…" : "Merging…"}</p>
      )}

      {task.stage === "done" && (() => {
        // A `done` task with an error isn't automatically a failure: any error on a task
        // whose PR actually landed as "MERGED" is cleanup left behind by that merge — a
        // worktree or branch teardown that didn't finish, never the merge itself — and must
        // render as "merged, with leftovers", not as a failed outcome (Task 9's `doMerge`).
        // A "pr-closed" ending never sets `pr.state` to "MERGED" (only `doMerge` does, after
        // asserting the forge itself reports "MERGED"), so this checks that field rather than
        // matching the human-readable error text: a copy edit to that message must not be
        // able to flip a real "closed without merging" into a reported success.
        const merged = task.pr?.state === "MERGED";
        return (
          <div className="gate" data-testid="gate-done">
            <h4>{merged ? "Merged" : "Closed without merging"}</h4>
            {task.error && merged && (
              <>
                <p className="hint">Merged, but cleanup left something behind:</p>
                <Lines className="outcome err" text={task.error} />
              </>
            )}
            {task.error && !merged && <div className="err">{task.error}</div>}
            {onTranscript && task.agentId && <div className="row"><button className="btn" onClick={() => onTranscript(task.agentId)}>Transcript</button></div>}
            <p className="hint">Dismissing removes this task and frees its agent — this cannot be undone.</p>
            <div className="row">
              <button className="btn d" disabled={busy} onClick={() => act(async () => { await api.dismissBug(task.id); return task; })}>Dismiss</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
