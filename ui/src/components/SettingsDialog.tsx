import { useEffect, useState } from "react";
import { api } from "../api";
import type { Check, SetupReport } from "../types";

// Populated from `GET /api/integrations` alongside the setup report; no route exists to edit
// a single entry (`PUT /api/integrations` only accepts `tracker`/`forge`), so this stays
// read-only rather than offering an action the server has nowhere to send.
type ProjectRepos = Record<string, string>;

/** A check's remedy, rendered by kind. The UI never authors advice — it renders what the
 *  server derived, so there is no second list of instructions to keep in sync. */
function Fix({ check }: { check: Check }) {
  if (!check.fix) return null;
  const { kind, value } = check.fix;
  if (kind === "command") return (
    <div className="row">
      <code className="cmd">{value}</code>
      <button className="btn" onClick={() => void navigator.clipboard?.writeText(value)}>Copy</button>
    </div>
  );
  if (kind === "env") return <div className="hint">Export <code>{value}</code> in your login shell, then restart AgentGrid.</div>;
  if (kind === "field") return <div className="hint">Set <code>{value}</code> below.</div>;
  return null;
}

function CheckRow({ check }: { check: Check }) {
  const mark = check.state === "ok" ? "●" : "✗";
  return (
    <div className={`checkrow ${check.state}`}>
      <span className="mark">{mark}</span>
      <span className="detail">{check.detail}</span>
      <Fix check={check} />
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trackerTest, setTrackerTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [forgeTest, setForgeTest] = useState<{ ok: boolean; message: string } | null>(null);
  // `undefined` means "the user hasn't touched the select yet" — until they do, it follows
  // whatever the "forge" check says is currently saved (see `preset` below), computed on every
  // render rather than seeded via an effect, so there is no frame where a just-loaded bitbucket
  // report still shows github's merge methods.
  const [presetOverride, setPresetOverride] = useState<"github" | "bitbucket" | undefined>(undefined);
  const [username, setUsername] = useState("");
  const [pasted, setPasted] = useState<string | null>(null);
  const [saved, setSaved] = useState<"live" | "restart" | null>(null);
  const [projectRepos, setProjectRepos] = useState<ProjectRepos>({});

  const load = () => api.getSetup().then(r => { setReport(r); setErr(null); }).catch(e => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);
  useEffect(() => { api.getIntegrations().then(i => setProjectRepos(i.projectRepos ?? {})).catch(() => {}); }, []);

  const forgeCheck = report?.checks.find(c => c.id === "forge");
  const detectedPreset = forgeCheck?.state === "ok" ? /^Forge: (github|bitbucket)\./.exec(forgeCheck.detail)?.[1] as "github" | "bitbucket" | undefined : undefined;
  const preset = presetOverride ?? detectedPreset ?? "github";

  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };

  const check = (id: string) => report?.checks.find(c => c.id === id);

  // Rendered bespoke below (Tracker/Forge sections); everything else the server reports —
  // today that's "config-file" and "role", both `blocks: true` — is rendered generically here,
  // so a check id added later, or a failure mode the sections don't have a dedicated spot for,
  // shows up on its own rather than silently making `ready: false` unexplained.
  const SHOWN = new Set(["tracker", "forge", "forge-username", "forge-token"]);
  const other = report?.checks.filter(c => !SHOWN.has(c.id) && c.state !== "ok") ?? [];

  const save = () => run(async () => {
    // `wired` BEFORE the save decides the message: a first-time save wires the engine live,
    // while changing an already-running config needs a restart (nothing is rebuilt under
    // in-flight tasks). Read it before the response replaces the report.
    const wasWired = report?.wired ?? false;
    const body: Record<string, unknown> = { forge: { preset, ...(preset === "bitbucket" ? { username } : {}) } };
    if (pasted !== null) body.tracker = JSON.parse(pasted);
    await api.putIntegrations(body as never);
    await load();
    setSaved(wasWired ? "restart" : "live");
  });

  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog settings" onClick={e => e.stopPropagation()}>
        <h3>⚙︎ Settings — Integrations</h3>
        {err && <div className="err">{err}</div>}
        {!report ? (err ? null : <div className="hint">Loading…</div>) : <>
          {other.length > 0 && (
            <section>
              <h4>Other problems</h4>
              {other.map(c => <CheckRow key={c.id} check={c} />)}
            </section>
          )}

          <section>
            <h4>Tracker</h4>
            {check("tracker") && <CheckRow check={check("tracker")!} />}
            {report.discovery.importable.map(s => (
              <div key={s.name} className="row">
                <span>{s.name} <span className="hint">({s.type ?? "?"}{s.url ? ` · ${s.url}` : ""} · {s.origin}{s.originDetail ? ` · ${s.originDetail}` : ""})</span></span>
                <button className="btn" disabled={busy} onClick={() => void run(async () => setReport(await api.importMcpServer(s.name)))}>Import</button>
              </div>
            ))}
            {report.discovery.accountOnly.length > 0 && (
              <div className="hint">Linked to your Claude account: {report.discovery.accountOnly.join(", ")}.</div>
            )}
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void run(load)}>Detect</button>
              <button className="btn" disabled={busy} onClick={() => void run(async () => setTrackerTest(await api.testTracker()))}>Test</button>
              <button className="btn" onClick={() => setPasted(pasted === null ? "" : null)}>Paste a definition</button>
            </div>
            {pasted !== null && <textarea className="paste" value={pasted} onChange={e => setPasted(e.target.value)}
              placeholder={'{"preset":"jira","toolPrefix":"mcp__atlassian","mcpServers":{"atlassian":{"type":"http","url":"…"}}}'} />}
            {trackerTest && <div className={trackerTest.ok ? "ok" : "err"}>{trackerTest.message}</div>}
          </section>

          <section>
            <h4>Forge</h4>
            {check("forge") && <CheckRow check={check("forge")!} />}
            <div className="row">
              <select value={preset} onChange={e => setPresetOverride(e.target.value as "github" | "bitbucket")}>
                <option value="github">github</option>
                <option value="bitbucket">bitbucket</option>
              </select>
              {preset === "bitbucket" && <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Atlassian account email" />}
            </div>
            {check("forge-username") && <CheckRow check={check("forge-username")!} />}
            {check("forge-token") && <CheckRow check={check("forge-token")!} />}
            {/* Bitbucket's third strategy is `fast_forward`, which is NOT a rebase — offering
                rebase here would promise an operation the adapter refuses. */}
            <div className="hint">Merge methods: squash, merge{preset === "github" ? ", rebase" : ""}.</div>
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void run(async () => setForgeTest(await api.testForge()))}>Test forge</button>
            </div>
            {forgeTest && <div className={forgeTest.ok ? "ok" : "err"}>{forgeTest.message}</div>}
          </section>

          {Object.keys(projectRepos).length > 0 && (
            <section>
              <h4>Repos</h4>
              {Object.entries(projectRepos).map(([project, repo]) => (
                <div key={project} className="row"><span>{project}</span><span className="hint">{repo}</span></div>
              ))}
            </section>
          )}

          {report.discovery.problems.length > 0 && (
            <section>
              <h4>Problems reading your Claude Code configuration</h4>
              {report.discovery.problems.map(p => <div key={p} className="err">{p}</div>)}
            </section>
          )}

          <div className="row">
            <button className="btn p" disabled={busy} onClick={() => void save()}>Save</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
          {saved === "restart" && <div className="hint">Saved. A server restart is required for this to take effect.</div>}
          {saved === "live" && <div className="ok">Saved. The bug-fix workflow is now available.</div>}
        </>}
      </div>
    </div>
  );
}
