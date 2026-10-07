import { useEffect, useRef, useState } from "react";
import { api, ApiError, type MergeMethod } from "../api";
import { bugMerged } from "../format";
import type { BugTask, PrInfo } from "../types";
import { stageLabel } from "../bugView";
import { DiffView, hunksFor } from "./DiffView";
import { ErrorCard } from "./ErrorCard";
import { Markdown } from "./Markdown";
import { PlanView } from "./PlanView";

interface DiffData { patch: string; files: Array<{ path: string; additions: number; deletions: number }>; additions: number; deletions: number }

/** Turns a thrown ApiError (or anything else) into what the panel should say — see api.ts's ApiError comment. */
function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 501) return "The bug-fix workflow isn't enabled on this server yet.";
    if (e.status === 404) return "This task no longer exists.";
    if (e.status === 0) return "Couldn't reach the server — check your connection.";
  }
  return (e as Error).message;
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

/** The gate cards — plan, diff, failed, monitoring, merge, done — shared by the side panel's
 *  BugPanel and the bug screen, so an action behaves identically wherever it is taken. */
export function BugGates({ task, onChanged, onTranscript }: { task: BugTask; onChanged: (t: BugTask) => void; onTranscript?: (agentId: string) => void }) {
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
  const [overriding, setOverriding] = useState(false); const [why, setWhy] = useState("");
  // The diff adds no test, and no reason was given for this very commit (spec 2026-10-07 §3.3).
  const noTest = task.gate?.kind === "diff" && Array.isArray(task.testsInDiff) && task.testsInDiff.length === 0 && task.testOverride?.head !== task.approvedHead;
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
    <div className="buggates">
      {err && <div className="err">{err}</div>}

      {gate === "plan" && (
        <div className="gate" data-testid="gate-plan">
          <h4>Plan</h4>
          {planErr
            ? <div className="err">{planErr}</div>
            : (plan === null ? <div className="skeleton" aria-label="Loading the plan"><div /><div /><div /></div> : <PlanView markdown={plan} />)}
          {(task.plannedTests ?? []).length > 0 && (
            <div className="planned-tests" data-testid="planned-tests">
              <h5>Tests that will stop this coming back</h5>
              <ul>{task.plannedTests.map(t => <li key={t}>{t}</li>)}</ul>
            </div>
          )}
          {task.verdict && (
            <div className="verdict" data-testid="gate-verdict">
              <b>The plan found nothing to change.</b> <span>{task.verdict}</span>
            </div>
          )}
          <div className="row">
            {task.verdict ? <>
              <button className="btn p" disabled={busy || !planReady} onClick={() => act(() => api.closeBugNoChange(task.id))}>Close — no change needed</button>
              <button className="btn" disabled={busy || !planReady} onClick={() => act(() => api.approveBug(task.id))}>Make a change anyway</button>
            </> : <button className="btn p" disabled={busy || !planReady} onClick={() => act(() => api.approveBug(task.id))}>Approve &amp; implement</button>}
            <button className="btn" disabled={busy} onClick={() => setAsking(true)}>Request changes…</button>
            <span className="hint gate-explain">{task.verdict ? "Closing pushes nothing and opens no pull request." : "Approving lets the agent write the fix. You review the diff before anything is pushed."}</span>
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
                return comments ? <Markdown text={comments} /> : null;
              })()}
            </div>
          )}
          {task.gate?.reason === "external" && (
            <div className="hint" data-testid="gate-reason">
              <b>{task.pr ? <a href={task.pr.url} target="_blank" rel="noreferrer">Pull request #{task.pr.number}</a> : "A pull request"} was opened outside AgentGrid.</b>{" "}
              It has commits you haven't reviewed here. Approving starts watching it; requesting changes sends the agent to fix them on its branch.
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
                    <DiffView patch={h.text} />
                  </>
                ); })()}
              </li>
            ))}
          </ul>
          {Array.isArray(task.testsInDiff) && task.testsInDiff.length > 0 && <p className="hint ok" data-testid="tests-in-diff">Tests in this change: {task.testsInDiff.join(", ")}</p>}
          {noTest && (
            <div className="warnline" data-testid="no-test">
              <b>No regression test in this change</b> — without one, this bug can come back unnoticed.
              {!overriding && <button className="btn sm" disabled={busy} onClick={() => setOverriding(true)}>Approve without a test…</button>}
            </div>
          )}
          {noTest && overriding && (
            <form className="row override" onSubmit={e => { e.preventDefault(); void act(() => api.overrideTests(task.id, why.trim())); }}>
              <textarea autoFocus aria-label="Why there is no regression test" rows={2} value={why} placeholder="Why is there no regression test?" onChange={e => setWhy(e.target.value)} />
              <button className="btn p sm" type="submit" disabled={busy || !why.trim()}>Approve without a test</button>
              <button className="btn sm" type="button" onClick={() => setOverriding(false)}>Cancel</button>
            </form>
          )}
          <div className="row">
            <button className="btn p" disabled={busy || !diffReady || noTest} title={noTest ? "This change has no regression test — approve without one, giving a reason" : undefined} onClick={() => act(() => api.approveBug(task.id))}>{task.gate?.reason ? "Approve" : "Create PR"}</button>
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
          <ErrorCard text={task.error ?? "The stage failed."} />
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
          {/* `prCheckedAt` is when the server actually polled the forge. Deliberately NOT
              `pr.lastSeenEventAt`, which is the PR's own `updatedAt`: on a quiet PR that claims
              hours ago while polling is healthy, and when the forge is unreachable it sits still
              — wrong in both directions, and about a different thing entirely. */}
          {task.pr && <p className="hint" data-testid="pr-last-checked">
            {task.prCheckedAt ? `Last checked ${new Date(task.prCheckedAt).toLocaleString()}` : "Not checked yet"}
          </p>}
          {/* Any error resting on a monitoring task is something the user needs: either the
              forge could not be read, or the feedback-round cap has stopped the watcher from
              dispatching — and the cap changes no stage, so this card is its only signal. */}
          {task.error && <ErrorCard testId="monitoring-error" text={task.error} />}
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

      {(task.stage === "pushing" || task.stage === "creating-pr" || task.stage === "merging") && (
        <p className="hint" data-testid="gate-server-stage">
          {stageLabel(task.stage)}…
        </p>
      )}

      {task.stage === "done" && (() => {
        // A `done` task with an error isn't automatically a failure: any error on a task that
        // actually merged is cleanup left behind by that merge — a worktree or branch teardown
        // that didn't finish, never the merge itself — and must render as "merged, with
        // leftovers", not as a failed outcome. The classification is the server's own durable
        // `outcome` (see `bugMerged`), not the error's wording and not `pr.state`.
        const merged = bugMerged(task);
        if (task.outcome === "no-change") return (
          <div className="gate" data-testid="gate-done">
            <h4>No change needed</h4>
            {task.report && <div className="report">{task.report.split("\n").map((l, i) => l.trim() ? <p key={i}>{l}</p> : null)}</div>}
            {onTranscript && task.agentId && <div className="row"><button className="btn" onClick={() => onTranscript(task.agentId)}>Transcript</button></div>}
            <p className="hint">Dismissing removes this task and frees its agent — this cannot be undone.</p>
            <div className="row">
              <button className="btn d" disabled={busy} onClick={() => act(async () => { await api.dismissBug(task.id); return task; })}>Dismiss</button>
            </div>
          </div>
        );
        return (
          <div className="gate" data-testid="gate-done">
            <h4>{merged ? "Merged" : "Closed without merging"}</h4>
            {task.error && merged && (
              <>
                <ErrorCard title="Merged, but cleanup left something behind" text={task.error} />
              </>
            )}
            {task.error && !merged && <ErrorCard text={task.error} />}
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
