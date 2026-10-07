import { useEffect, useMemo, useState } from "react";
import { Bug, CheckCircle2, CircleAlert, FolderOpen, GitBranch, RotateCcw } from "lucide-react";
import { api } from "../api";
import type { BatchState, IssueSummary } from "../types";

type Preflight = { ok: boolean; problems: string[]; remote?: string | null; baseBranch?: string | null; branches?: string[] };
type Group = { repo: string; preflight: Preflight | null; checking: boolean; base: string };
const projectOf = (key: string) => key.split("-")[0] ?? key;
const CHUNK = 500;

/**
 * Start fixes for several bugs at once (spec 2026-10-08 §5): one repo and branch per project, then the
 * server starts them — each repo fetched once, tickets read 20 at a time — and reports each ticket:
 * started, skipped because it may already be fixed (Start anyway), or failed (Retry).
 */
export function BulkStart({ selected, batches, onStarted, onClose }: { selected: IssueSummary[]; batches: Record<string, BatchState>;
  /** The run began: the parent keeps this selection on screen though its bugs stop being "not started". */ onStarted?: () => void;
  /** Done looking at the results. */ onClose?: () => void }) {
  const projects = useMemo(() => [...new Set(selected.map(i => projectOf(i.key)))].sort(), [selected]);
  const [groups, setGroups] = useState<Record<string, Group>>({});
  const [ids, setIds] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The repo each project was last fixed in.
  useEffect(() => {
    let live = true;
    api.getIntegrations().then(i => {
      if (!live) return;
      setGroups(g => {
        const next = { ...g };
        for (const p of projects) if (!next[p]) next[p] = { repo: i.projectRepos?.[p] ?? "", preflight: null, checking: false, base: "" };
        return next;
      });
    }).catch(() => {});
    return () => { live = false; };
  }, [projects]);

  const setRepo = (p: string, repo: string) => setGroups(g => ({ ...g, [p]: { ...(g[p] ?? { base: "", checking: false }), repo, preflight: null } as Group }));
  // Each project's repo is checked (remote, forge, branch to cut from) as it is set.
  const repoKey = projects.map(p => `${p}=${groups[p]?.repo ?? ""}`).join("|");
  useEffect(() => {
    let live = true;
    for (const p of projects) {
      const g = groups[p];
      if (!g || !g.repo.trim().startsWith("/") || g.preflight || g.checking) continue;
      setGroups(x => ({ ...x, [p]: { ...x[p]!, checking: true } }));
      api.bugPreflight(g.repo.trim()).then(pf => { if (live) setGroups(x => ({ ...x, [p]: { ...x[p]!, preflight: pf, checking: false, base: x[p]!.base || pf.baseBranch || "" } })); })
        .catch(e => { if (live) setGroups(x => ({ ...x, [p]: { ...x[p]!, preflight: { ok: false, problems: [(e as Error).message] }, checking: false } })); });
    }
    return () => { live = false; };
  }, [repoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const itemsFor = (keys: string[]) => keys.map(k => { const g = groups[projectOf(k)]!; return { issueRef: k, repo: g.repo.trim(), ...(g.base ? { baseBranch: g.base } : {}) }; });
  const send = async (keys: string[], anyway?: string[]) => {
    setBusy(true); setErr(null);
    try {
      const items = itemsFor(keys); const started: string[] = [];
      for (let i = 0; i < items.length; i += CHUNK) started.push((await api.startBatch(items.slice(i, i + CHUNK), anyway)).batchId);
      setIds(x => [...new Set([...x, ...started])]);
      onStarted?.();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const ready = projects.every(p => groups[p]?.preflight?.ok);
  const n = selected.length;

  // Everything sent so far, as one picture.
  const runs = ids.map(id => batches[id]).filter((b): b is BatchState => !!b);
  const total = runs.reduce((s, b) => s + b.total, 0), done = runs.reduce((s, b) => s + b.done, 0);
  const started = runs.flatMap(b => b.started), skipped = runs.flatMap(b => b.skipped), failed = runs.flatMap(b => b.failed);
  const startedKeys = new Set(started.map(s => s.key));
  const stillSkipped = skipped.filter(s => !startedKeys.has(s.key)), stillFailed = failed.filter(f => !startedKeys.has(f.key));

  return (
    <div className="bugdetail bulk" data-testid="bulk-start">
      <header className="dhead"><div className="dtitle"><h2><Bug /> Start {n} fix{n === 1 ? "" : "es"}</h2>
        <p className="help">Each repo is fetched once and the tickets read together; the agents-at-once limit paces the fixes.</p></div></header>

      {projects.map(p => {
        const g = groups[p]; const keys = selected.filter(i => projectOf(i.key) === p);
        return (
          <section key={p} className="panel" aria-label={`Project ${p}`}>
            <h3 className="panel-title">{p} · {keys.length} bug{keys.length === 1 ? "" : "s"}</h3>
            <ul className="bulk-keys">{keys.map(i => <li key={i.key}><span className="mono">{i.key}</span> {i.title}</li>)}</ul>
            <div className="row pathrow">
              <label className="help" htmlFor={`bulk-repo-${p}`}>Repo for {p}</label>
              <input id={`bulk-repo-${p}`} className="input mono" value={g?.repo ?? ""} placeholder="/Users/you/project" onChange={e => setRepo(p, e.target.value)} />
              <button className="btn" onClick={async () => { const r = await api.pickFolder().catch(() => undefined); if (r?.path) setRepo(p, r.path); }}><FolderOpen /> Browse…</button>
            </div>
            {g?.checking && <p className="help">Checking repo…</p>}
            {g?.preflight && !g.preflight.ok && <div className="errtext"><CircleAlert /><div>{g.preflight.problems.map(x => <div key={x}>{x}</div>)}</div></div>}
            {g?.preflight?.ok && (g.preflight.branches?.length ?? 0) > 0 && (
              <div className="row base-row">
                <label className="help" htmlFor={`bulk-base-${p}`}><GitBranch /> Branch from for {p}</label>
                <select id={`bulk-base-${p}`} className="input mono" value={g.base} onChange={e => setGroups(x => ({ ...x, [p]: { ...x[p]!, base: e.target.value } }))}>
                  {g.preflight.branches!.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            )}
          </section>
        );
      })}

      {err && <div className="err">{err}</div>}
      {ids.length === 0 && (
        <div className="row"><span className="help">Nothing is pushed until you approve each diff.</span>
          <button className="btn p" disabled={!ready || busy} onClick={() => void send(selected.map(i => i.key))}>{busy ? "Starting…" : `Start ${n} fix${n === 1 ? "" : "es"}`}</button></div>
      )}

      {ids.length > 0 && (
        <section className="panel" aria-label="Progress">
          <div className="row"><div className="now-line"><b>Started {started.length} of {total || n}</b>{done < total && <> · {done} of {total} handled</>}</div>
            {onClose && <button className="btn sm" style={{ marginLeft: "auto" }} onClick={onClose}>Done</button>}</div>
          <div className="bar"><span style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></div>
          {started.length > 0 && <p className="oktext"><CheckCircle2 /> {started.map(s => s.key).join(", ")}</p>}
        </section>
      )}
      {stillSkipped.length > 0 && (
        <section className="panel" aria-label="Skipped — may already be fixed">
          <h3 className="panel-title">Skipped — may already be fixed ({stillSkipped.length})</h3>
          <ul>{stillSkipped.map(s => <li key={s.key}>{s.message.split("\n").map((l, i) => <div key={i} className={i ? "mono help" : ""}>{l}</div>)}
            <button className="btn sm" disabled={busy} onClick={() => void send([s.key], [s.key])}>Start {s.key} anyway</button></li>)}</ul>
          <button className="btn" disabled={busy} onClick={() => void send(stillSkipped.map(s => s.key), stillSkipped.map(s => s.key))}>Start all anyway</button>
        </section>
      )}
      {stillFailed.length > 0 && (
        <section className="panel" aria-label="Failed">
          <h3 className="panel-title">Failed ({stillFailed.length})</h3>
          <ul>{stillFailed.map(f => <li key={f.key}><b className="mono">{f.key}</b> {f.message.split("\n").map((l, i) => <div key={i} className={i ? "mono help" : ""}>{l}</div>)}
            <button className="btn sm" disabled={busy} aria-label={`Retry ${f.key}`} onClick={() => void send([f.key])}><RotateCcw /> Retry</button></li>)}</ul>
          {stillFailed.length > 1 && <button className="btn" disabled={busy} onClick={() => void send(stillFailed.map(f => f.key))}>Retry all</button>}
        </section>
      )}
    </div>
  );
}
