import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleDashed, Hand, Loader, MinusCircle, XCircle } from "lucide-react";
import { api } from "../api";
import { blockersFor, isNew, listStatus, nowFor, orderAssumptions, pipelineFor, stageLabel, type Blocker, type ListStatus, type StepState } from "../bugView";
import { elapsed, relativeTime, usd } from "../format";
import { activityFor, assignmentFor, type UiState } from "../state/reducer";
import type { BugTask, SetupReport } from "../types";
import { BugGates } from "./BugGates";
import { DiffView, hunksFor } from "./DiffView";
import { ErrorCard } from "./ErrorCard";
import { Markdown } from "./Markdown";
import { PlanView } from "./PlanView";

const STATUS: Record<ListStatus, { Icon: typeof Hand; word: string }> = {
  running: { Icon: Loader, word: "Running" }, waiting: { Icon: Hand, word: "Waiting on you" },
  failed: { Icon: XCircle, word: "Failed" }, done: { Icon: CheckCircle2, word: "Done" }, cancelled: { Icon: MinusCircle, word: "Cancelled" },
};
const STEP: Record<StepState, { icon: string; word: string }> = {
  done: { icon: "✓", word: "done" }, current: { icon: "●", word: "in progress" }, waiting: { icon: "⚠", word: "waiting on you" },
  failed: { icon: "✗", word: "failed" }, cancelled: { icon: "–", word: "cancelled" }, todo: { icon: "○", word: "not reached" },
};
/** For a failed or cancelled task, the stage it stopped at — "Failed · Implementing" says where. */
const lastRealStage = (t: BugTask) => [...t.history].reverse().find(h => h.stage !== "failed" && h.stage !== "cancelled")?.stage ?? t.stage;
const ACTIVE_FIRST: ListStatus[] = ["waiting", "running", "failed", "done", "cancelled"];

/** Re-render every 30s so relative times and elapsed stay honest. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  return now;
}

function When({ iso, now }: { iso?: string | null; now: number }) {
  if (!iso) return null;
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{relativeTime(iso, now)}</time>;
}

export function BugScreen({ state, selectedId, onSelect, onBugChanged, onTranscript, onOpenSettings, onFixBug }: {
  state: UiState; selectedId: string | null; onSelect: (id: string, opts?: { replace?: boolean }) => void; onBugChanged: (t: BugTask) => void;
  onTranscript: (agentId: string) => void; onOpenSettings: () => void; onFixBug: () => void;
}) {
  const now = useNow();
  const agentWaiting = (t: BugTask) => {
    const ag = state.agents.find(a => a.id === t.agentId);
    return !!ag && !!assignmentFor(state, ag)?.pending;
  };
  const tasks = useMemo(() => Object.values(state.bugTasks)
    .map(t => ({ t, status: listStatus(t, agentWaiting(t)) }))
    .sort((a, b) => ACTIVE_FIRST.indexOf(a.status) - ACTIVE_FIRST.indexOf(b.status) || b.t.updatedAt.localeCompare(a.t.updatedAt)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [state.bugTasks, state.assignments, state.agents]);

  const task = tasks.find(x => x.t.id === selectedId)?.t ?? null;
  // Review Focus 4: a stale or missing selection falls back to the first bug, and the URL follows.
  useEffect(() => { if (!task && tasks.length) onSelect(tasks[0].t.id, { replace: true }); }, [task, tasks, onSelect]);
  const shown = task ?? tasks[0]?.t ?? null;

  if (!tasks.length) {
    return (
      <div className="bugscreen empty-screen" data-testid="bug-screen">
        <p>No bug fixes yet. Start one and it will appear here, step by step.</p>
        <button className="btn p" onClick={onFixBug}>🐞 Fix a bug</button>
      </div>
    );
  }

  const move = (delta: number) => {
    const i = tasks.findIndex(x => x.t.id === shown?.id);
    const next = tasks[Math.min(tasks.length - 1, Math.max(0, i + delta))];
    if (next) onSelect(next.t.id);
  };

  return (
    <div className="bugscreen" data-testid="bug-screen">
      <aside className="buglist">
        <div className="lh"><span>Bug fixes</span><span className="mono">{tasks.length}</span></div>
        <ul role="listbox" aria-label="Bug fixes" onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
          if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        }}>
          {tasks.map(({ t, status }) => {
            const { Icon, word } = STATUS[status];
            return (
              <li key={t.id} role="option" aria-selected={t.id === shown?.id} tabIndex={t.id === shown?.id ? 0 : -1}
                className="bugrow" data-status={status} onClick={() => onSelect(t.id)} onKeyDown={e => { if (e.key === "Enter") onSelect(t.id); }}>
                <span className="k">{t.issue.key}</span>
                <span className="t" title={t.issue.title}>{t.issue.title}</span>
                <span className={`s ${status}`}><Icon /> {word} · {stageLabel(t.stage === "failed" || t.stage === "cancelled" ? lastRealStage(t) : t.stage)}</span>
              </li>
            );
          })}
        </ul>
        <div className="lfoot"><kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>⏎</kbd> open</div>
      </aside>
      {shown && <BugDetail key={shown.id} task={shown} state={state} now={now} onBugChanged={onBugChanged} onTranscript={onTranscript} onOpenSettings={onOpenSettings} />}
    </div>
  );
}

function BugDetail({ task, state, now, onBugChanged, onTranscript, onOpenSettings }: {
  task: BugTask; state: UiState; now: number; onBugChanged: (t: BugTask) => void; onTranscript: (agentId: string) => void; onOpenSettings: () => void;
}) {
  const agent = state.agents.find(a => a.id === task.agentId) ?? null;
  const asg = agent ? assignmentFor(state, agent) : null;
  const activity = agent ? activityFor(state, agent) : null;
  const pending = asg?.pending ?? null;

  const [setup, setSetup] = useState<SetupReport | null>(null);
  const [setupError, setSetupError] = useState(false);
  useEffect(() => {
    let live = true;
    api.getSetup().then(r => { if (live) { setSetup(r); setSetupError(false); } }).catch(() => { if (live) setSetupError(true); });
    return () => { live = false; };
  }, [task.stage]);

  // The plan and the diff, shown outside their own gates once they exist.
  const [plan, setPlan] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ patch: string; files: Array<{ path: string; additions: number; deletions: number }> } | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const hasPlan = task.stage !== "intake" && task.stage !== "analyzing";
  const hasDiff = !!task.approvedHead && task.stage !== "done" && task.stage !== "cancelled";
  useEffect(() => { let live = true; if (hasPlan) api.bugPlan(task.id).then(r => { if (live) setPlan(r.markdown || null); }).catch(() => {}); return () => { live = false; }; }, [task.id, hasPlan]);
  useEffect(() => {
    let live = true;
    if (hasDiff) api.bugDiff(task.id).then(r => { if (live) { setDiff(r); setDiffErr(null); } }).catch(e => { if (live) setDiffErr((e as Error).message); });
    return () => { live = false; };
  }, [task.id, hasDiff, task.approvedHead]);

  const steps = pipelineFor(task, !!pending);
  const nowLine = nowFor({ task, pending, activity });
  const blockers = blockersFor({ task, pending, setup, setupError });
  const items = orderAssumptions(task.assumptions);
  const openInDiff = (p: string) => { setOpenFile(p); document.getElementById("bug-changes")?.scrollIntoView({ behavior: "smooth" }); };

  return (
    <div className="bugdetail">
      <header className="bugdetail-head">
        <h2><a href={task.issue.url} target="_blank" rel="noreferrer">{task.issue.key}</a> <span>{task.issue.title}</span></h2>
        <div className="row dim">
          {task.pr && <a href={task.pr.url} target="_blank" rel="noreferrer">Pull request #{task.pr.number}</a>}
          <code title="Worktree">{task.worktree}</code>
          <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(task.worktree)}>Copy path</button>
          <span>{usd(task.costUsd)}</span>
          {task.feedbackRounds > 0 && <span>Review round {task.feedbackRounds}</span>}
          {agent && <button className="btn sm" onClick={() => onTranscript(agent.id)}>Transcript</button>}
        </div>
      </header>

      <ol className="pipeline" aria-label="Pipeline">
        {steps.map(s => (
          <li key={s.id} data-state={s.state} className={`step ${s.state}`}>
            <span className="step-icon" aria-hidden>{STEP[s.state].icon}</span>
            <span className="step-label">{s.label}</span>
            <span className="step-word">{STEP[s.state].word}</span>
            {s.badge && <span className="chip">{s.badge}</span>}
          </li>
        ))}
      </ol>

      <section className={`blocking ${blockers.length ? "has" : "none"}`} aria-label="Blocking">
        <h3>Blocking</h3>
        {blockers.length === 0 ? <p className="dim">Nothing is blocking this bug.</p> : (
          <ul>{blockers.map((b, i) => <BlockerRow key={i} b={b} onOpenSettings={onOpenSettings} />)}</ul>
        )}
      </section>

      <section className="now" aria-label="Now">
        <h3>Now</h3>
        <div className="now-line"><b>{nowLine.headline}</b>{nowLine.since && <> · <Since iso={nowLine.since} kind={nowLine.sinceKind} now={now} /></>}</div>
        {nowLine.detail && <div className="now-detail">{nowLine.detail}</div>}
      </section>

      <section className="gates" aria-label="Actions">
        <BugGates task={task} onChanged={onBugChanged} onTranscript={onTranscript} />
      </section>

      <section className="assumptions" aria-label="Assumptions and questions">
        <h3>Assumptions & questions {items.length > 0 && <span className="dim">({items.length})</span>}</h3>
        {task.assumptionsProblem && <div className="warnline">⚠ {task.assumptionsProblem}</div>}
        {items.length === 0 ? <p className="dim">The agent has not reported any assumptions yet.</p> : (
          <ul>{items.map(a => (
            <li key={a.id} className={`assumption ${a.kind}`}>
              <span className="akind">{a.kind === "question" ? "? Question" : "• Assumed"}</span>
              <Markdown inline text={a.text} />
              <span className="atag">{stageLabel(a.stage)}{a.round > 0 ? ` · round ${a.round}` : ""}</span>
              {isNew(a, task) && <span className="chip new">new</span>}
            </li>
          ))}</ul>
        )}
      </section>

      {task.issue.description.trim() && (
        <details className="section-collapse"><summary>Ticket</summary>
          <Markdown text={task.issue.description} />
          {task.issue.acceptanceCriteria.length > 0 && <><h4>Acceptance criteria</h4><ul>{task.issue.acceptanceCriteria.map((c, i) => <li key={i}><Markdown inline text={c} /></li>)}</ul></>}
        </details>
      )}

      {plan && task.gate?.kind !== "plan" && (
        <details className="section-collapse"><summary>Plan</summary>
          <PlanView markdown={plan} files={diff?.files.map(f => f.path)} onOpenFile={openInDiff} />
        </details>
      )}

      {hasDiff && task.gate?.kind !== "diff" && (
        <section id="bug-changes" aria-label="Changes">
          <h3>Changes</h3>
          {diffErr ? <ErrorCard text={`Could not load the changes. ${diffErr}`} />
            : !diff ? <div className="skeleton" aria-label="Loading the changes"><div /><div /></div>
            : <ul className="difffiles">{diff.files.map(f => (
                <li key={f.path}>
                  <button className="folder" aria-expanded={openFile === f.path} onClick={() => setOpenFile(openFile === f.path ? null : f.path)}>
                    <code>{f.path}</code> <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                  </button>
                  {openFile === f.path && (() => { const h = hunksFor(diff.patch, f.path); return <>
                    {!h.isolated && <p className="hint">Could not isolate this file's changes — showing the full diff instead.</p>}
                    <DiffView patch={h.text} />
                  </>; })()}
                </li>
              ))}</ul>}
        </section>
      )}

      <section className="timeline" aria-label="Timeline">
        <h3>Timeline</h3>
        <ol>{[...task.history].reverse().map((h, i) => (
          <li key={i}><When iso={h.at} now={now} /> <b>{stageLabel(h.stage)}</b>{h.note && <> — <Markdown inline text={h.note} /></>}</li>
        ))}</ol>
      </section>
    </div>
  );
}

/** "for 6m" while running, "waiting 6m" at a gate, "last checked 2 min ago" for the PR watcher. */
function Since({ iso, kind, now }: { iso: string; kind?: "running" | "waiting" | "checked"; now: number }) {
  const title = new Date(iso).toLocaleString();
  if (kind === "checked") return <time dateTime={iso} title={title}>last checked {relativeTime(iso, now)}</time>;
  return <time dateTime={iso} title={title}>{kind === "waiting" ? "waiting" : "for"} {elapsed(iso, now)}</time>;
}

function BlockerRow({ b, onOpenSettings }: { b: Blocker; onOpenSettings: () => void }) {
  // The error itself is shown once, on the failed-stage card with Retry; Blocking points at it.
  if (b.kind === "failed") return (
    <li className="blocker failed">
      <span>{b.title}</span>
      <button className="btn sm" onClick={() => document.querySelector(".bugdetail .gates")?.scrollIntoView({ behavior: "smooth" })}>See why</button>
    </li>
  );
  return (
    <li className={`blocker ${b.kind}`}>
      <span>{b.title}</span>
      {b.detail && <span className="dim"> — {b.detail}</span>}
      {b.kind === "setup" && <button className="btn sm" onClick={onOpenSettings}>Open Settings</button>}
      {b.kind === "gate" && <button className="btn sm" onClick={() => document.querySelector(".bugdetail .gates")?.scrollIntoView({ behavior: "smooth" })}>Go to it</button>}
      {b.kind === "agent" && <span className="hint"> Answer it in the agent's side panel on the grid.</span>}
    </li>
  );
}
