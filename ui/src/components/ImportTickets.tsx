import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, FolderOpen, Import, RotateCcw } from "lucide-react";
import { api } from "../api";
import { stageLabel } from "../bugView";
import type { BugStage, ImportState } from "../types";

type Preflight = { ok: boolean; problems: string[] };
const CHUNK = 500;
/** Ticket keys out of whatever was pasted: commas, spaces, lines; upper-cased, each once. */
export const parseKeys = (text: string): string[] =>
  [...new Set(text.split(/[\s,;]+/).map(k => k.trim().toUpperCase()).filter(k => /^[A-Z][A-Z0-9_]*-\d+$/.test(k)))];

/**
 * Import tickets already in progress (spec 2026-10-09 §3): paste keys, pick the repo, and each ticket is picked up where it
 * is — its open PR watched, its pushed branch reviewed, merged recorded as done — or a fix starts. A ticket with several
 * open PRs asks which one.
 */
export function ImportTickets({ imports, onClose }: { imports: Record<string, ImportState>; onClose: () => void }) {
  const [text, setText] = useState("");
  const [repo, setRepo] = useState("");
  const [repoTouched, setRepoTouched] = useState(false);
  const [projectRepos, setProjectRepos] = useState<Record<string, string>>({});
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, number>>({});
  const keys = parseKeys(text);

  useEffect(() => { let live = true; api.getIntegrations().then(i => { if (live) setProjectRepos(i.projectRepos ?? {}); }).catch(() => {}); return () => { live = false; }; }, []);
  // The repo this project was last fixed in, until the user types their own.
  const project = keys[0]?.split("-")[0];
  useEffect(() => { if (!repoTouched && project && projectRepos[project]) setRepo(projectRepos[project]); }, [project, projectRepos, repoTouched]);
  // Check the repo once typing pauses; an answer counts only for the path it was asked about.
  useEffect(() => {
    const asked = repo.trim(); setPreflight(null);
    if (!asked.startsWith("/")) return;
    const t = setTimeout(() => {
      setChecking(true);
      const apply = (pf: Preflight) => { setChecking(false); setPreflight(cur => (repo.trim() === asked ? pf : cur)); };
      api.bugPreflight(asked).then(apply).catch(e => apply({ ok: false, problems: [(e as Error).message] }));
    }, 250);
    return () => clearTimeout(t);
  }, [repo]);

  const send = async (ks: string[]) => {
    setBusy(true); setErr(null);
    try {
      const started: string[] = [];
      for (let i = 0; i < ks.length; i += CHUNK) started.push((await api.startImport(ks.slice(i, i + CHUNK), repo.trim())).importId);
      setIds(x => [...new Set([...x, ...started])]);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const choose = async (id: string, key: string) => {
    const n = picks[key]; if (n === undefined) return;
    try { await api.chooseImport(id, key, n); } catch (e) { setErr((e as Error).message); }
  };

  const runs = ids.map(id => imports[id]).filter((r): r is ImportState => !!r);
  const total = runs.reduce((s, r) => s + r.total, 0), done = runs.reduce((s, r) => s + r.done, 0);
  const imported = runs.flatMap(r => r.imported), skipped = runs.flatMap(r => r.skipped);
  const importedKeys = new Set(imported.map(i => i.key));
  const failed = runs.flatMap(r => r.failed).filter(f => !importedKeys.has(f.key));
  const choices = runs.flatMap(r => r.choose.map(c => ({ ...c, importId: r.importId })));
  const n = keys.length;

  return (
    <div className="bugdetail bulk" data-testid="import-tickets">
      <header className="dhead"><div className="dtitle"><h2><Import /> Import tickets</h2>
        <p className="help">For tickets already being worked on: an open pull request is watched, a pushed branch is reviewed, a merged one is recorded. The rest start as new fixes.</p></div></header>

      <section className="panel">
        <label className="help" htmlFor="import-keys">Ticket keys</label>
        <textarea id="import-keys" aria-label="Ticket keys" className="input mono" rows={4} placeholder="PAY-41, PAY-42 …" value={text} onChange={e => setText(e.target.value)} />
        <p className="help">{n} ticket{n === 1 ? "" : "s"}</p>
        <div className="row pathrow">
          <label className="help" htmlFor="import-repo">Repo</label>
          <input id="import-repo" aria-label="Repo" className="input mono" value={repo} placeholder="/Users/you/project" onChange={e => { setRepo(e.target.value); setRepoTouched(true); }} />
          <button className="btn" onClick={async () => { const r = await api.pickFolder().catch(() => undefined); if (r?.path) { setRepo(r.path); setRepoTouched(true); } }}><FolderOpen /> Browse…</button>
        </div>
        {checking && <p className="help">Checking repo…</p>}
        {preflight && !preflight.ok && <div className="errtext"><CircleAlert /><div>{preflight.problems.map(x => <div key={x}>{x}</div>)}</div></div>}
        <div className="row"><span className="help">Nothing is pushed until you approve.</span>
          <button className="btn p" disabled={!n || !preflight?.ok || busy} onClick={() => void send(keys)}>{busy ? "Importing…" : `Import ${n} ticket${n === 1 ? "" : "s"}`}</button>
          <button className="btn" onClick={onClose}>Done</button></div>
        {err && <div className="err">{err}</div>}
      </section>

      {runs.length > 0 && (
        <section className="panel" aria-label="Progress">
          <div className="now-line"><b>Imported {imported.length} of {total}</b>{done < total && <> · {done} of {total} handled</>}</div>
          <div className="bar"><span style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></div>
          {imported.length > 0 && <ul>{imported.map(i => <li key={i.key} className="oktext"><CheckCircle2 /> <span className="mono">{i.key}</span> — {stageLabel(i.stage as BugStage) ?? i.stage}</li>)}</ul>}
        </section>
      )}
      {choices.length > 0 && (
        <section className="panel" aria-label="Needs a choice">
          <h3 className="panel-title">Needs a choice ({choices.length})</h3>
          {choices.map(c => (
            <fieldset key={c.key}><legend className="mono">{c.key} — which pull request is the fix?</legend>
              {c.candidates.map(p => (
                <label key={p.number} className="row"><input type="radio" name={`pick-${c.key}`} checked={picks[c.key] === p.number} onChange={() => setPicks(x => ({ ...x, [c.key]: p.number }))} />
                  {`#${p.number} — ${p.title} (${p.branch})`}</label>))}
              <button className="btn sm" disabled={picks[c.key] === undefined} aria-label={`Use #${picks[c.key] ?? ""} for ${c.key}`} onClick={() => void choose(c.importId, c.key)}>Use #{picks[c.key] ?? "…"}</button>
            </fieldset>))}
        </section>
      )}
      {skipped.length > 0 && (
        <section className="panel" aria-label="Skipped">
          <h3 className="panel-title">Skipped ({skipped.length})</h3>
          <ul>{skipped.map(s => <li key={s.key}>{s.message}</li>)}</ul>
        </section>
      )}
      {failed.length > 0 && (
        <section className="panel" aria-label="Failed">
          <h3 className="panel-title">Failed ({failed.length})</h3>
          <ul>{failed.map(f => <li key={f.key}><b className="mono">{f.key}</b> {f.message}
            <button className="btn sm" disabled={busy} aria-label={`Retry ${f.key}`} onClick={() => void send([f.key])}><RotateCcw /> Retry</button></li>)}</ul>
        </section>
      )}
    </div>
  );
}
