import { useEffect, useState } from "react";
import { Bug, CheckCircle2, CircleAlert, ExternalLink, FolderOpen, GitBranch, RefreshCw } from "lucide-react";
import { api } from "../api";
import { useBugStart } from "../hooks/useBugStart";
import type { BugTask, TrackerIssue } from "../types";
import { Markdown } from "./Markdown";

const prio = (p: string) => /highest|critical|blocker/i.test(p) ? "red" : /high/i.test(p) ? "amber" : "";

/** A bug assigned to you that hasn't been started: the ticket itself, and everything needed to start it right here. */
export function TicketDetail({ ticketKey, onStarted }: { ticketKey: string; onStarted?: (t: BugTask) => void }) {
  const [issue, setIssue] = useState<TrackerIssue | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true; setIssue(null); setLoadErr(null);
    api.issue(ticketKey).then(i => { if (live) setIssue(i); }).catch(e => { if (live) setLoadErr((e as Error).message); });
    return () => { live = false; };
  }, [ticketKey, attempt]);

  const st = useBugStart({ issueRef: ticketKey, onCreated: onStarted });
  // The repo this project was last fixed in, once it is known — never over something typed already.
  const remembered = st.rememberedFor(ticketKey);
  useEffect(() => { if (remembered && !st.repo) st.setRepo(remembered); }, [remembered]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="bugdetail ticket" data-testid="ticket-detail">
      <header className="dhead">
        <div className="dtitle">
          <h2><span className="key">{ticketKey}</span>{issue?.title ?? (loadErr ? "" : "Loading…")}</h2>
          {issue && <div className="meta">
            <span className={`chip ${prio(issue.priority)}`}>{issue.priority}</span>
            <span className="chip">{issue.status}</span>
            <a href={issue.url} target="_blank" rel="noreferrer"><ExternalLink /> Ticket</a>
            <span className="chip">Not started</span>
          </div>}
        </div>
      </header>

      {loadErr && <div className="panel"><div className="errtext"><CircleAlert /> {loadErr}</div>
        <button className="btn sm" onClick={() => setAttempt(n => n + 1)}><RefreshCw /> Retry</button></div>}

      {issue && <>
        <section className="panel" aria-label="Description">
          <h3 className="panel-title">Description</h3>
          {issue.description.trim() ? <Markdown text={issue.description} /> : <p className="dim">The ticket has no description.</p>}
          {issue.acceptanceCriteria.length > 0 && <>
            <h3 className="panel-title">Acceptance criteria</h3>
            <ul className="ac">{issue.acceptanceCriteria.map(a => <li key={a}>{a}</li>)}</ul>
          </>}
        </section>

        <section className="panel start" aria-label="Start fixing">
          <h3 className="panel-title"><Bug /> Start fixing</h3>
          <div className="field">
            <label className="label" htmlFor="ticket-repo">Repo</label>
            <div className="row pathrow">
              <input id="ticket-repo" className="input mono" value={st.repo} placeholder="/Users/you/project" onChange={e => st.setRepo(e.target.value)} />
              <button className="btn" onClick={async () => { const r = await api.pickFolder().catch(() => undefined); if (r?.path) st.setRepo(r.path); }}><FolderOpen /> Browse…</button>
            </div>
            {st.repoTrimmed && !st.repoValid && <div className="errtext"><CircleAlert /> Enter an absolute repo path</div>}
            {st.checking && <p className="help">Checking repo…</p>}
            {st.preflight && !st.preflight.ok && <div className="errtext" style={{ alignItems: "flex-start" }}><CircleAlert /><div>{st.preflight.problems.map(p => <div key={p}>{p}</div>)}</div></div>}
            {st.preflight?.ok && st.preflight.remote && <span className="oktext"><CheckCircle2 /> Remote found: <span className="mono">{st.preflight.remote}</span></span>}
            {st.preflight?.ok && (st.preflight.branches?.length ?? 0) > 0 && (
              <div className="row base-row">
                <label className="help" htmlFor="ticket-base"><GitBranch /> Branch from</label>
                <select id="ticket-base" className="input mono" value={st.base} onChange={e => st.setBase(e.target.value)}>
                  {st.preflight.branches!.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            )}
          </div>
          {st.err && <div className="err">{st.err.split("\n").map((line, i) => <div key={i}>{line}</div>)}
            {st.alreadyOnBase && <div className="row"><button className="btn" disabled={st.busy} onClick={() => void st.start(true)}>Start anyway</button></div>}</div>}
          <div className="row">
            <span className="help">The agent writes a plan first; nothing is pushed until you approve the diff.</span>
            <button className="btn p" disabled={st.blocked} onClick={() => void st.start()}>{st.busy ? "Starting…" : "Start fixing"}</button>
          </div>
        </section>
      </>}
    </div>
  );
}
