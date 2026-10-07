import { useCallback, useEffect, useMemo, useState } from "react";
import { Bug, Check, CheckCircle2, CircleDashed, CircleDot, History, Lightbulb, MessageCircleQuestion, OctagonAlert, Radio, TriangleAlert, ClipboardList, Code2, Copy, ExternalLink, FileDiff, GitMerge, GitPullRequest, Hand, Inbox, Loader, Minus, MinusCircle, Radar, ScrollText, Search, RefreshCw, X, XCircle, Clock } from "lucide-react";
import { api } from "../api";
import { blockersFor, isNew, listStatus, nowFor, orderAssumptions, pipelineFor, stageLabel, type Blocker, type ListStatus, type StepState } from "../bugView";
import { elapsed, relativeTime, usd } from "../format";
import { activityFor, assignmentFor, permissionFor, type UiState } from "../state/reducer";
import type { BugTask, Decision, IssueList, IssueSummary, SetupReport } from "../types";
import { TicketDetail } from "./TicketDetail";
import { BulkStart } from "./BulkStart";
import { PendingPrompt, asPending } from "./PendingPrompt";
import { BugGates } from "./BugGates";
import { DiffView, hunksFor } from "./DiffView";
import { ErrorCard } from "./ErrorCard";
import { Markdown } from "./Markdown";
import { PlanView } from "./PlanView";

const STATUS: Record<ListStatus, { Icon: typeof Hand; word: string }> = {
  running: { Icon: Loader, word: "Running" }, waiting: { Icon: Hand, word: "Waiting on you" },
  failed: { Icon: XCircle, word: "Failed" }, done: { Icon: CheckCircle2, word: "Done" }, cancelled: { Icon: MinusCircle, word: "Cancelled" },
};
const STEP_ICON: Record<string, typeof Hand> = {
  intake: Inbox, analyze: Search, plan: ClipboardList, implement: Code2, diff: FileDiff, pr: GitPullRequest, monitor: Radar, merge: GitMerge,
};
const STEP_WORD: Record<StepState, string> = {
  done: "done", current: "in progress", waiting: "waiting on you", failed: "failed", cancelled: "cancelled", todo: "not reached",
};
function stepIcon(id: string, state: StepState) {
  const I = state === "done" ? Check : state === "waiting" ? Hand : state === "failed" ? X : state === "cancelled" ? Minus : STEP_ICON[id] ?? CircleDashed;
  return <I />;
}
/** For a failed or cancelled task, the stage it stopped at — "Failed · Implementing" says where. */
const lastRealStage = (t: BugTask) => [...t.history].reverse().find(h => h.stage !== "failed" && h.stage !== "cancelled")?.stage ?? t.stage;
const TERMINAL = ["done", "failed", "cancelled"];
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

/** One row of the bugs list: a ticket assigned to me, a task, or both. */
export type Row = { key: string; title: string; priority: string | null; task: BugTask | null; status: ListStatus | null; assigned: boolean };

/**
 * Every open bug assigned to me, merged with AgentGrid's tasks by ticket key. Order: tasks still in
 * play (waiting on you, running, failed), then bugs not started (tracker order), then finished ones;
 * tasks whose ticket is no longer assigned to me (reassigned, closed) come last, in their own group.
 */
export function mergeRows(issues: IssueSummary[] | null, tasks: Array<{ t: BugTask; status: ListStatus }>): Row[] {
  const mine = new Set((issues ?? []).map(i => i.key));
  const rank = (r: Row) => !r.assigned ? 4 : !r.status ? 2 : ["waiting", "running", "failed"].includes(r.status) ? 1 : 3;
  // Each ticket takes its most active task (tasks arrive active-first); any other task for it still gets a row.
  const used = new Set<string>();
  const rows: Row[] = (issues ?? []).map(i => {
    const x = tasks.find(y => y.t.issue.key === i.key);
    if (x) used.add(x.t.id);
    return { key: i.key, title: i.title, priority: i.priority, task: x?.t ?? null, status: x?.status ?? null, assigned: true };
  });
  for (const x of tasks) if (!used.has(x.t.id)) rows.push({ key: x.t.issue.key, title: x.t.issue.title, priority: x.t.issue.priority || null, task: x.t, status: x.status, assigned: issues === null || mine.has(x.t.issue.key) });
  // A stable sort keeps tracker order inside "not started", and the task order (active first) inside the rest.
  const taskOrder = new Map(tasks.map((x, i) => [x.t.id, i]));
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r)
    || (a.r.task && b.r.task ? taskOrder.get(a.r.task.id)! - taskOrder.get(b.r.task.id)! : a.i - b.i)).map(x => x.r);
}

/** My open bugs from the tracker: loaded on open, every 5 minutes and on Refresh; the last good list survives an error. */
/**
 * My open bugs, from the server's tracker cache (spec 2026-10-08 §3): the first read answers at once
 * from the cache; newer lists arrive as events (`live`); Refresh asks the server to re-read. A tracker
 * error keeps the last list and says why.
 */
function useMyIssues(live: IssueList | null) {
  const [list, setList] = useState<IssueList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const load = useCallback(() => {
    api.myIssues().then(v => { setList(v); setErr(null); }).catch(e => setErr((e as Error).message));
  }, []);
  // Ask again every minute: the server answers from its cache and re-reads the tracker once the list is stale.
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  const refresh = useCallback(() => {
    setAsking(true);
    void api.refreshIssues().catch(() => {}).then(() => load()).finally(() => setAsking(false));
  }, [load]);
  // The newer of what we fetched and what the server pushed: a higher generation (the cache was cleared —
  // a tracker change) wins outright, even before it has a time; then the later fetch.
  const newer = (a: IssueList, b: IssueList) => (a.generation ?? 0) !== (b.generation ?? 0) ? (a.generation ?? 0) > (b.generation ?? 0) : (a.fetchedAt ?? "") >= (b.fetchedAt ?? "");
  const cur = live && (!list || newer(live, list)) ? live : list;
  return { issues: cur ? cur.issues : null, fetchedAt: cur?.fetchedAt ?? null, refreshing: asking || !!cur?.refreshing,
    err: err ?? cur?.error ?? null, refresh };
}

export function BugScreen({ state, selectedId, onSelect, onBugChanged, onTranscript, onOpenSettings, onFixBug, onDecide, selectedTicket = null, onSelectTicket, onStarted }: {
  state: UiState; selectedId: string | null; onSelect: (id: string, opts?: { replace?: boolean }) => void; onBugChanged: (t: BugTask) => void;
  onTranscript: (agentId: string) => void; onOpenSettings: () => void; onFixBug: () => void;
  /** Answer the bug agent's permission request or question from here. */ onDecide?: (agentId: string, toolUseId: string, d: Decision) => void;
  /** A bug assigned to me, not started yet, shown on the right. */ selectedTicket?: string | null;
  onSelectTicket?: (key: string, opts?: { replace?: boolean }) => void;
  /** A ticket was just started from its view. */ onStarted?: (t: BugTask) => void;
}) {
  const now = useNow();
  const mine = useMyIssues(state.tracker ?? null);
  const agentWaiting = (t: BugTask) => {
    const ag = state.agents.find(a => a.id === t.agentId);
    return !!ag && (!!assignmentFor(state, ag)?.pending || !!permissionFor(state, ag));
  };
  const tasks = useMemo(() => Object.values(state.bugTasks)
    .map(t => ({ t, status: listStatus(t, agentWaiting(t)) }))
    .sort((a, b) => ACTIVE_FIRST.indexOf(a.status) - ACTIVE_FIRST.indexOf(b.status) || b.t.updatedAt.localeCompare(a.t.updatedAt)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [state.bugTasks, state.assignments, state.agents, state.permissions]);
  const rows = useMemo(() => mergeRows(mine.issues, tasks), [mine.issues, tasks]);
  // Place in line under the agents-at-once limit, oldest first (spec 2026-10-07 §5).
  const queued = useMemo(() => Object.values(state.bugTasks).filter(t => t.queuedAt && !TERMINAL.includes(t.stage)).sort((a, b) => a.queuedAt!.localeCompare(b.queuedAt!)), [state.bugTasks]);
  const queueOf = (t: BugTask) => { const i = queued.findIndex(q => q.id === t.id); return i === -1 ? undefined : { position: i + 1, of: queued.length }; };
  const conflicts = tasks.filter(x => x.t.stage === "conflict").length;
  // Bugs ticked for "start many" (spec 2026-10-08 §5.1): only assigned ones not started yet.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const startable = rows.filter(r => !r.task && r.assigned);
  const pickedRows = startable.filter(r => picked.has(r.key));
  // Once a run starts, its bugs stop being "not started" — keep the panel on what was sent, until Done.
  const [running, setRunning] = useState<IssueSummary[] | null>(null);
  const bulkShown = running ?? (pickedRows.length ? pickedRows.map(r => ({ key: r.key, title: r.title, url: "", status: "", priority: r.priority ?? "" })) : null);
  const toggle = (key: string) => setPicked(x => { const n = new Set(x); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const [resolving, setResolving] = useState(false);
  const resolveAll = () => { setResolving(true); void api.resolveConflicts().catch(() => {}).finally(() => setResolving(false)); };

  const task = tasks.find(x => x.t.id === selectedId)?.t ?? null;
  const ticket = !task && selectedTicket && rows.some(r => r.key === selectedTicket && !r.task) ? selectedTicket : null;
  // Review Focus 4: a stale or missing selection falls back to the first row, and the URL follows.
  // Never before the task list has loaded: a link to #/bugs/bt5 would otherwise "fall back" to the
  // first tracker row the moment the tracker answers first.
  useEffect(() => {
    if (!state.loaded || task || ticket || (selectedTicket && !mine.issues) || !rows.length) return;
    const first = rows[0];
    if (first.task) onSelect(first.task.id, { replace: true }); else onSelectTicket?.(first.key, { replace: true });
  }, [state.loaded, task, ticket, selectedTicket, rows, mine.issues, onSelect, onSelectTicket]);
  const shown = task ?? (ticket ? null : tasks[0]?.t ?? null);
  // What is on the right: a task (by id — one ticket can have several), or a not-started ticket (by key).
  const shownTicket = !task ? ticket ?? (selectedTicket && !mine.issues ? selectedTicket : null) : null;
  const shownTaskId = shownTicket ? null : (task ?? shown)?.id ?? null;
  const isShown = (r: Row) => r.task ? r.task.id === shownTaskId : r.key === shownTicket;

  if (!rows.length && !selectedTicket) {
    return (
      <div className="bugscreen empty-screen" data-testid="bug-screen">
        <span className="dlg-ic"><Bug /></span>
        <h2>No bug fixes yet</h2>
        <p>Turn a ticket into a merged pull request. You approve the plan, the diff and the merge — each fix appears here, step by step.</p>
        {mine.err && <div className="warnline"><TriangleAlert /> Couldn't load your bugs from the tracker: {mine.err}</div>}
        <button className="btn p" onClick={onFixBug}><Bug /> Fix a bug</button>
      </div>
    );
  }

  const open = (r: Row) => { if (r.task) onSelect(r.task.id); else onSelectTicket?.(r.key); };
  const move = (delta: number) => {
    const i = rows.findIndex(isShown);
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + delta))];
    if (next) open(next);
  };
  const firstUnassigned = rows.findIndex(r => !r.assigned && mine.issues !== null);

  return (
    <div className="bugscreen" data-testid="bug-screen">
      <aside className="buglist">
        <div className="lh"><span>My bugs</span><span className="mono">{rows.length}</span>
          {mine.fetchedAt && <span className="help updated" title={new Date(mine.fetchedAt).toLocaleString()}>updated {relativeTime(mine.fetchedAt, now)}</span>}
          <button className="btn sm" aria-label={mine.refreshing ? "Refreshing…" : "Refresh from the tracker"} title={mine.refreshing ? "Refreshing…" : "Refresh from the tracker"} disabled={mine.refreshing} onClick={mine.refresh}><RefreshCw className={mine.refreshing ? "spin" : ""} /></button></div>
        {startable.length > 0 && (
          <div className="row pick-row">
            {pickedRows.length < startable.length && <button className="btn sm" onClick={() => setPicked(new Set(startable.map(r => r.key)))}>Select all not started ({startable.length})</button>}
            {pickedRows.length > 0 && <button className="btn sm" onClick={() => setPicked(new Set())}>Clear</button>}
          </div>
        )}
        {conflicts > 0 && <button className="btn p resolve-all" disabled={resolving} title="Rebase every conflicted bug onto its base — the agents-at-once limit paces them, and you review each result" onClick={resolveAll}><GitMerge /> Resolve all {conflicts} conflict{conflicts === 1 ? "" : "s"}</button>}
        {mine.err && <div className="warnline"><TriangleAlert /> Couldn't refresh from the tracker: {mine.err}{mine.issues ? " — showing the last list." : ""}</div>}
        <ul role="listbox" aria-label="Bug fixes" onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
          if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        }}>
          {rows.map((r, i) => {
            const sel = isShown(r);
            const head = i === firstUnassigned ? <li role="presentation" className="group">Not assigned to you or closed</li> : null;
            if (!r.task) return [head, (
              <li key={r.key} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} className={`bugrow ${r.assigned ? "pickable" : ""}`} data-status="todo"
                onClick={() => open(r)} onKeyDown={e => { if (e.key === "Enter") open(r); }}>
                {r.assigned && <input type="checkbox" className="pick" aria-label={`Select ${r.key}`} checked={picked.has(r.key)}
                  onClick={e => e.stopPropagation()} onChange={() => toggle(r.key)} />}
                <span className="k">{r.key}</span>
                <span className="t" title={r.title}>{r.title}</span>
                <span className="s todo">{r.priority && <span className={`chip ${/highest|critical|blocker/i.test(r.priority) ? "red" : /high/i.test(r.priority) ? "amber" : ""}`}>{r.priority}</span>} Not started</span>
              </li>
            )];
            const t = r.task; const { Icon, word } = STATUS[r.status!];
            return [head, (
              <li key={t.id} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1}
                className="bugrow" data-status={r.status} onClick={() => open(r)} onKeyDown={e => { if (e.key === "Enter") open(r); }}>
                <span className="k">{t.issue.key}</span>
                <span className="t" title={t.issue.title}>{t.issue.title}</span>
                {queueOf(t)
                  ? <span className="s queued"><Clock /> Queued ({queueOf(t)!.position} of {queueOf(t)!.of}) · {stageLabel(t.stage)}</span>
                  : <span className={`s ${r.status}`}><Icon /> {word} · {stageLabel(t.stage === "failed" || t.stage === "cancelled" ? lastRealStage(t) : t.stage)}</span>}
              </li>
            )];
          })}
        </ul>
        <div className="lfoot"><kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>⏎</kbd> open</div>
      </aside>
      {bulkShown
        ? <BulkStart selected={bulkShown} batches={state.batches ?? {}} onStarted={() => setRunning(r => r ?? bulkShown)} onClose={() => { setRunning(null); setPicked(new Set()); }} />
        : task || (shown && !ticket && !selectedTicket)
        ? <BugDetail key={(task ?? shown)!.id} task={(task ?? shown)!} state={state} now={now} onBugChanged={onBugChanged} onTranscript={onTranscript} onOpenSettings={onOpenSettings} onDecide={onDecide} />
        : (ticket ?? selectedTicket) ? <TicketDetail key={ticket ?? selectedTicket!} ticketKey={(ticket ?? selectedTicket)!} onStarted={onStarted} /> : null}
    </div>
  );
}

function BugDetail({ task, state, now, onBugChanged, onTranscript, onOpenSettings, onDecide }: {
  task: BugTask; state: UiState; now: number; onBugChanged: (t: BugTask) => void; onTranscript: (agentId: string) => void; onOpenSettings: () => void;
  onDecide?: (agentId: string, toolUseId: string, d: Decision) => void;
}) {
  const agent = state.agents.find(a => a.id === task.agentId) ?? null;
  const asg = agent ? assignmentFor(state, agent) : null;
  const activity = agent ? activityFor(state, agent) : null;
  const permission = agent ? permissionFor(state, agent) : null;
  // What the agent is asking right now: its run's own request, or its embedded terminal's.
  const pending = asg?.pending ?? (permission ? asPending(permission) : null);

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
  const queuedAll = Object.values(state.bugTasks).filter(t => t.queuedAt && !TERMINAL.includes(t.stage)).sort((a, b) => a.queuedAt!.localeCompare(b.queuedAt!));
  const qi = queuedAll.findIndex(q => q.id === task.id);
  const nowLine = nowFor({ task, pending, activity, ...(qi !== -1 ? { queue: { position: qi + 1, of: queuedAll.length } } : {}) });
  const blockers = blockersFor({ task, pending, setup, setupError });
  const items = orderAssumptions(task.assumptions);
  const openInDiff = (p: string) => { setOpenFile(p); document.getElementById("bug-changes")?.scrollIntoView({ behavior: "smooth" }); };

  return (
    <div className="bugdetail">
      <header className="dhead">
        <div className="dtitle">
          <h2><span className="key">{task.issue.key}</span>{task.issue.title}</h2>
          <div className="meta">
            <a href={task.issue.url} target="_blank" rel="noreferrer"><ExternalLink /> Ticket</a>
            {task.pr && <a href={task.pr.url} target="_blank" rel="noreferrer"><GitPullRequest /> Pull request #{task.pr.number}</a>}
            <span className="mono path" title={task.worktree}><span className="sr-only">Worktree: </span>{task.worktree}</span>
            <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(task.worktree)}><Copy /> Copy path</button>
            {agent && <span className="chip">Bug fixer · {agent.displayName}</span>}
            {agent && <button className="btn sm" onClick={() => onTranscript(agent.id)}><ScrollText /> Transcript</button>}
          </div>
        </div>
        <div className="dcounters">
          <div className="counter"><span className="num">{usd(task.costUsd)}</span><span className="lbl">Cost</span></div>
          <div className={`counter ${task.feedbackRounds ? "" : "zero"}`}><span className="num">{task.feedbackRounds}</span><span className="lbl">Review rounds</span></div>
        </div>
      </header>

      <ol className="pipe" aria-label="Pipeline">
        {steps.map(s => (
          <li key={s.id} data-state={s.state} className={`pstep ${s.state}`}>
            <span className="pdot" aria-hidden>{stepIcon(s.id, s.state)}</span>
            <span className="pname">{s.label}</span>
            <span className="pword">{STEP_WORD[s.state]}</span>
            {s.badge && <span className="chip">{s.badge}</span>}
          </li>
        ))}
      </ol>

      <div className="row2">
        <section className={`panel blocking ${blockers.length ? "has" : "none"}`} aria-label="Blocking">
          <h3 className="panel-title"><OctagonAlert /> Blocking{blockers.length ? ` · ${blockers.length}` : ""}</h3>
          {blockers.length === 0 ? <p className="calm">Nothing is blocking this bug.</p> : (
            <ul>{blockers.map((b, i) => <BlockerRow key={i} b={b} onOpenSettings={onOpenSettings} />)}</ul>
          )}
        </section>
        <section className="panel now" aria-label="Now">
          <h3 className="panel-title"><Radio /> Now</h3>
          <div className="now-line"><b>{nowLine.headline}</b>{nowLine.since && <> · <Since iso={nowLine.since} kind={nowLine.sinceKind} now={now} /></>}</div>
          {nowLine.detail && <div className="now-detail">{nowLine.detail}</div>}
          {pending && agent && onDecide && <PendingPrompt who={agent.displayName} pending={pending} onDecide={d => onDecide(agent.id, pending.toolUseId, d)} />}
        </section>
      </div>

      <section className="panel gates" aria-label="Actions">
        <BugGates task={task} onChanged={onBugChanged} onTranscript={onTranscript} />
      </section>

      <section className="panel assumptions" aria-label="Assumptions and questions">
        <h3 className="panel-title"><Lightbulb /> Assumptions &amp; questions{items.length ? ` · ${items.length}` : ""}</h3>
        <p className="panel-desc">What the agent decided on its own, or couldn't decide. Overturn any of them with “Request changes”.</p>
        {task.assumptionsProblem && <div className="warnline"><TriangleAlert /> {task.assumptionsProblem}</div>}
        {items.length === 0 ? <p className="dim">The agent has not reported any assumptions yet.</p> : (
          <ul>{items.map(a => (
            <li key={a.id} className={`assumption ${a.kind}`}>
              <span className="akind">{a.kind === "question" ? <><MessageCircleQuestion /> Question</> : <><CircleDot /> Assumed</>}</span>
              <Markdown inline text={a.text} />
              <span className="atag">{stageLabel(a.stage)}{a.round > 0 ? ` · round ${a.round}` : ""}</span>
              {isNew(a, task) && <span className="chip new">new</span>}
            </li>
          ))}</ul>
        )}
      </section>

      {task.issue.description.trim() && (
        <details className="section-collapse panel"><summary>Ticket</summary>
          <Markdown text={task.issue.description} />
          {task.issue.acceptanceCriteria.length > 0 && <><h4>Acceptance criteria</h4><ul>{task.issue.acceptanceCriteria.map((c, i) => <li key={i}><Markdown inline text={c} /></li>)}</ul></>}
        </details>
      )}

      {plan && task.gate?.kind !== "plan" && (
        <details className="section-collapse panel"><summary>Plan</summary>
          <PlanView markdown={plan} files={diff?.files.map(f => f.path)} onOpenFile={openInDiff} />
        </details>
      )}

      {hasDiff && task.gate?.kind !== "diff" && (
        <section id="bug-changes" className="panel" aria-label="Changes">
          <h3 className="panel-title"><FileDiff /> Changes</h3>
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

      <section className="panel timeline" aria-label="Timeline">
        <h3 className="panel-title"><History /> Timeline</h3>
        <ol>{[...task.history].reverse().map((h, i) => (
<li key={i} data-tone={i === 0 && !TERMINAL.includes(task.stage) && (task.gate || pending) ? "waiting" : h.stage === "failed" ? "failed" : h.stage === "cancelled" ? "neutral" : i === 0 && !TERMINAL.includes(h.stage) ? "current" : "done"}>
            <When iso={h.at} now={now} /><span className="d" aria-hidden /><span><b>{stageLabel(h.stage)}</b>{h.note && <> — <Markdown inline text={h.note} /></>}</span>
          </li>
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
