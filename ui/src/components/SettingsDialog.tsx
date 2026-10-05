import { useEffect, useState } from "react";
import { Check as CheckIcon, CheckCircle2, FolderGit2, GitPullRequest, PlugZap, Ticket, TriangleAlert, X } from "lucide-react";
import { api } from "../api";
import type { Check, FixAction, McpServerFound, SetupReport } from "../types";

// Populated from `GET /api/integrations` alongside the setup report; no route exists to edit
// a single entry (`PUT /api/integrations` only accepts `tracker`/`forge`), so this stays
// read-only rather than offering an action the server has nowhere to send.
type ProjectRepos = Record<string, string>;

/** The remedy for an `action` fix: the one kind whose `value` names something to do *here*
 *  rather than something to copy. The named actions are matched exhaustively (the `never`
 *  below), so a new one added to `FixAction` on the server is a compile error until it is
 *  rendered here — which is what M5 was about: `action` used to render nothing at all. */
function ActionFix({ value }: { value: FixAction }) {
  if (value.startsWith("use:")) return <div className="hint">Pick a server below and press <b>Use this</b>.</div>;
  const named = value as Exclude<FixAction, `use:${string}`>;
  switch (named) {
    case "save": return <div className="hint">Press <b>Save</b> below to create it.</div>;
    case "fix-or-remove-config": return <div className="hint">Fix or remove that file, then press <b>Detect</b>.</div>;
    case "reinstall": return <div className="hint">Reinstall AgentGrid, or put a <code>bugfix</code> role under <code>~/.agentgrid/roles</code>.</div>;
  }
  const exhaustive: never = named;
  return exhaustive;
}

/** A check's remedy, rendered by kind. The UI never authors the *diagnosis* — that is the
 *  check's `detail`, straight from the server — and for `command`/`env`/`field` it renders the
 *  server's own value too. `action` is the one kind whose value names a control rather than a
 *  string, so the mapping from action to control necessarily lives here. */
function Fix({ check }: { check: Check }) {
  if (!check.fix) return null;
  if (check.fix.kind === "action") return <ActionFix value={check.fix.value} />;
  const { kind, value } = check.fix;
  if (kind === "command") return (
    <div className="row">
      <code className="cmd">{value}</code>
      <button className="btn" onClick={() => void navigator.clipboard?.writeText(value)}>Copy</button>
    </div>
  );
  if (kind === "env") return <div className="hint">Export <code>{value}</code> in your login shell, then restart AgentGrid.</div>;
  return <div className="hint">Set <code>{value}</code> below.</div>;
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

/** Plain-language origin for a discovered server, in the user's own vocabulary rather than
 *  Claude Code's scope names — nobody configuring a bug tracker thinks in terms of "settings"
 *  vs. "user" scope.
 *
 *  I1: the two directory-scoped origins carry a caveat, because picking one is *not* enough on
 *  its own. Claude Code resolves a project- or repo-scoped server relative to the working
 *  directory, and AgentGrid's tracker calls run in the directory its server process was
 *  launched from (`tracker.ts`: `cwd: process.cwd()`) — never the ticket's repo. The rows stay
 *  listed, because someone who does launch AgentGrid from that directory can use them; what
 *  they must not do is read as "click and you're done". */
function originLabel(s: McpServerFound): string {
  switch (s.origin) {
    case "account": return "linked to your Claude account";
    case "user": return "configured in Claude Code";
    case "settings": return "configured in Claude Code";
    case "project":
    case "repo": return `configured for ${s.originDetail} — only resolves while running AgentGrid from that directory`;
  }
}

// The only tracker preset that ships a prompt file today (`presets/tracker/jira.md`). A row's
// "Use this" needs *some* preset to send — this is the one the server can actually resolve.
// A preset saved by hand that is not in this list is still offered as what is saved, the same
// way the forge select does it, so seeding from the config can never silently change it.
const TRACKER_PRESETS = ["jira"];

/** The checks that decide whether "Fix a bug" can run — shown as the banner's chips. */
const READINESS = [["tracker", "Tracker"], ["forge", "Forge"], ["role", "Bug fixer role"]] as const;

function StatusChip({ ok }: { ok: boolean }) {
  return ok ? <span className="chip green"><CheckIcon /> Ready</span> : <span className="chip amber"><TriangleAlert /> Needs attention</span>;
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trackerTest, setTrackerTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [forgeTest, setForgeTest] = useState<{ ok: boolean; message: string } | null>(null);
  // `undefined` means "the user hasn't touched the select yet". Until they do, it follows the
  // forge actually saved in `integrations.json` (`savedForge` below) — never a value parsed out
  // of a check's prose. I2: this used to regex `/^Forge: (github|bitbucket)\./` over the
  // "forge" check's sentence and fall back to "github", so a gitlab or custom forge (both are
  // valid `FORGE_PRESETS`) read as github, and any Save rewrote it — `username` included, since
  // the patch replaces the whole `forge` object. A prose string is not structured data: reword
  // the sentence, as this branch already did once to the sibling check, and it silently breaks.
  const [presetOverride, setPresetOverride] = useState<string | undefined>(undefined);
  const [username, setUsername] = useState("");
  // The saved forge, straight from `GET /api/integrations`. That route redacts to an allow-list
  // — `projectRepos`, the whole `forge`, and `tracker`'s `preset`/`toolPrefix`/`hints` — so a
  // credential a pre-0.5.0 config still holds under `tracker.mcpServers` never reaches here
  // (M6). `loaded` distinguishes "no forge is saved" from "we have not been told yet", which
  // decides whether Save may send one at all.
  const [savedForge, setSavedForge] = useState<{ preset: string; username?: string } | undefined>(undefined);
  const [forgeLoaded, setForgeLoaded] = useState(false);
  const [pasted, setPasted] = useState<string | null>(null);
  const [trackerPreset, setTrackerPreset] = useState(TRACKER_PRESETS[0]);
  // `hints` is prompt text the user can only set by editing the file. It is never shown here,
  // but it must be carried back on every tracker write: `PUT` replaces `tracker` wholesale, so
  // a "Use this" that did not re-send it destroyed it silently (I3).
  const [trackerHints, setTrackerHints] = useState<string | undefined>(undefined);
  // The prefix saved now, so the list can say which of Claude Code's servers is already in use.
  const [trackerPrefix, setTrackerPrefix] = useState<string | undefined>(undefined);
  // "Use this" cannot preserve what it has not been told, so it waits for the config to land.
  const [integrationsLoaded, setIntegrationsLoaded] = useState(false);
  const [saved, setSaved] = useState<"live" | "restart" | null>(null);
  const [projectRepos, setProjectRepos] = useState<ProjectRepos>({});

  const load = () => api.getSetup().then(r => { setReport(r); setErr(null); }).catch(e => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    api.getIntegrations().then(i => {
      setProjectRepos(i.projectRepos ?? {});
      setSavedForge(i.forge);
      // Seed the email input from what is saved, so a bitbucket user who opens Settings and
      // saves for an unrelated reason re-sends their own username rather than an empty string.
      if (i.forge?.username) setUsername(i.forge.username);
      setForgeLoaded(true);
      // Same reasoning for the tracker: a preset set by hand must not be reset to the first
      // option, and `hints` must survive a click on "Use this".
      if (i.tracker?.preset) setTrackerPreset(i.tracker.preset);
      setTrackerHints(i.tracker?.hints);
      setTrackerPrefix(i.tracker?.toolPrefix);
      // A failed read still releases the button rather than disabling it forever, and cannot
      // cost anyone their `hints`: this GET fails only when the server is down (the PUT behind
      // "Use this" fails too) or when integrations.json is unreadable or corrupt, and
      // `IntegrationsStore.write` refuses to merge onto a base it could not read. There is no
      // case where the read fails and the write then succeeds over data we could not see.
    }).catch(() => {}).finally(() => setIntegrationsLoaded(true));
  }, []);

  // A preset the select cannot offer (gitlab, custom — Phase 2) is still shown as what is
  // saved, so the dialog never displays a forge the user does not have.
  const SELECTABLE = ["github", "bitbucket"];
  const preset = presetOverride ?? savedForge?.preset ?? "github";

  // Send `forge` only when the user actually changed it: touching the select, editing the
  // username, or there being no saved forge to preserve in the first place (a fresh machine,
  // where the whole point of Save is to create one). While the saved forge is still loading we
  // send nothing — overwriting on a race is the very failure this closes.
  const forgeDirty = presetOverride !== undefined
    || (forgeLoaded && (!savedForge || username !== (savedForge.username ?? "")));

  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };

  const check = (id: string) => report?.checks.find(c => c.id === id);

  // Rendered bespoke below (Tracker/Forge sections); everything else the server reports —
  // today that's "config-file" and "role", both `blocks: true` — is rendered generically here,
  // so a check id added later, or a failure mode the sections don't have a dedicated spot for,
  // shows up on its own rather than silently making `ready: false` unexplained.
  const SHOWN = new Set(["tracker", "tracker-server", "forge", "forge-username", "forge-token"]);
  const other = report?.checks.filter(c => !SHOWN.has(c.id) && c.state !== "ok") ?? [];

  const save = () => run(async () => {
    // `wired` BEFORE the save decides the message: a first-time save wires the engine live,
    // while changing an already-running config needs a restart (nothing is rebuilt under
    // in-flight tasks). Read it before the response replaces the report.
    const wasWired = report?.wired ?? false;
    const body: Record<string, unknown> = {};
    if (forgeDirty) body.forge = { preset, ...(preset === "bitbucket" ? { username } : {}) };
    // An opened-but-empty box is "I changed my mind", not "save an empty tracker": parsing it
    // unconditionally threw out of `JSON.parse` and aborted the whole save, the forge included
    // (M7). The server refuses a tracker naming neither preset nor toolPrefix in any case.
    if (pasted !== null && pasted.trim()) body.tracker = JSON.parse(pasted);
    await api.putIntegrations(body as never);
    if (body.tracker) setTrackerPrefix((body.tracker as { toolPrefix?: string }).toolPrefix);
    await load();
    setSaved(wasWired ? "restart" : "live");
  });

  return (
    <div className="modal" onClick={onClose}>
      <section className="dialog settings" role="dialog" aria-label="Integrations" onClick={e => e.stopPropagation()}>
        <div className="dlg-hd">
          <span className="dlg-ic"><PlugZap /></span>
          <div><h2>Integrations</h2><p>What the bug-fix workflow needs, and whether it's ready. Every problem comes with its fix.</p></div>
          <button className="x" aria-label="Close settings" onClick={onClose}><X /></button>
        </div>
        <div className="dlg-body">
        {err && <div className="err">{err}</div>}
        {!report ? (err ? null : <div className="skeleton" aria-label="Loading settings"><div /><div /><div /></div>) : <>
          {(() => {
            const left = READINESS.filter(([id]) => { const c = check(id); return c && c.state !== "ok"; });
            return (
              <div className="overall" data-testid="overall" data-ready={left.length === 0}>
                {left.length === 0 ? <CheckCircle2 className="ok-ic" /> : <TriangleAlert className="warn-ic" />}
                <div className="grow"><b>{left.length === 0 ? "Ready to fix bugs" : `${left.length} thing${left.length === 1 ? "" : "s"} left before you can fix bugs`}</b>
                  <div className="help">Agents work without any of this. Only “Fix a bug” needs a tracker and a forge.</div></div>
                <div className="checks">{READINESS.map(([id, label]) => { const c = check(id); if (!c) return null; const ok = c.state === "ok";
                  return <span key={id} className={`chip ${ok ? "green" : "amber"}`}>{ok ? <CheckIcon /> : <TriangleAlert />} {label}</span>; })}</div>
              </div>
            );
          })()}
          {other.length > 0 && (
            <section className="sec">
              <div className="sec-head"><h4>Other problems</h4><p className="why">Something outside the tracker and forge is stopping bug fixes.</p></div>
              <div className="sec-body">{other.map(c => <CheckRow key={c.id} check={c} />)}</div>
            </section>
          )}

          <section className="sec">
            <div className="sec-head">
              <h4><Ticket />Tracker</h4>
              <StatusChip ok={check("tracker")?.state === "ok"} />
              <p className="why">Where your tickets live. AgentGrid uses the connection Claude Code already has; nothing is copied.</p>
            </div>
            <div className="sec-body">
            {check("tracker") && <CheckRow check={check("tracker")!} />}
            {/* Only when it is a problem: "Claude Code has <prefix>" beside a green tracker row
                says nothing the "in use" tag on the list below does not. */}
            {check("tracker-server") && check("tracker-server")!.state !== "ok" && <CheckRow check={check("tracker-server")!} />}
            {report.discovery.servers.length > 0 && (
              <div className="row">
                <label>Tracker type <select value={trackerPreset} onChange={e => setTrackerPreset(e.target.value)}>
                  {!TRACKER_PRESETS.includes(trackerPreset) && <option value={trackerPreset}>{trackerPreset} (saved)</option>}
                  {TRACKER_PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
                </select></label>
              </div>
            )}
            {report.discovery.servers.map(s => (
              <div key={s.name} className="row">
                <span>{s.name} <span className="hint">({originLabel(s)})</span>
                  {s.toolPrefix === trackerPrefix && <span className="hint"> — in use</span>}</span>
                {/* `hints` goes back exactly as it came: `PUT` replaces `tracker` wholesale
                    (deliberately — that is what sheds a 0.4.0 `mcpServers`), so anything not
                    re-sent here is destroyed. */}
                <button className="btn p" disabled={busy || !integrationsLoaded} onClick={() => void run(async () => {
                  await api.putIntegrations({ tracker: { preset: trackerPreset, toolPrefix: s.toolPrefix,
                    ...(trackerHints !== undefined ? { hints: trackerHints } : {}) } });
                  setTrackerPrefix(s.toolPrefix);
                  await load();
                })}>Use this</button>
              </div>
            ))}
            {/* No add-command row here: when nothing is discovered the "tracker" check itself
                carries `fix: { kind: "command", value: DEFAULT_ADD_COMMAND }`, and `CheckRow`
                above renders it with its own Copy button. Rendering it again put the same
                command on screen twice (M4). */}
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void run(load)}>Detect</button>
              <button className="btn" disabled={busy} onClick={() => void run(async () => setTrackerTest(await api.testTracker()))}>Test</button>
              <button className="btn" onClick={() => setPasted(pasted === null ? "" : null)}>Enter a tracker by hand</button>
            </div>
            {pasted !== null && <>
              <div className="hint">Not in the list above? Claude Code may not have connected it yet — name its preset and tool prefix directly.</div>
              <textarea className="paste" value={pasted} onChange={e => setPasted(e.target.value)}
                placeholder={'{"preset":"jira","toolPrefix":"mcp__claude_ai_Atlassian"}'} />
            </>}
            {trackerTest && <div className={trackerTest.ok ? "ok" : "err"}>{trackerTest.message}</div>}
            </div>
          </section>

          <section className="sec">
            <div className="sec-head">
              <h4><GitPullRequest />Forge</h4>
              <StatusChip ok={["forge", "forge-username", "forge-token"].every(id => { const c = check(id); return !c || c.state === "ok"; })} />
              <p className="why">Where pull requests are opened and merged. AgentGrid pushes; agents never hold your credentials.</p>
            </div>
            <div className="sec-body">
            {check("forge") && <CheckRow check={check("forge")!} />}
            <div className="seg" role="group" aria-label="Forge">
              {savedForge && !SELECTABLE.includes(savedForge.preset) && (
                <button className={preset === savedForge.preset ? "on" : ""} aria-pressed={preset === savedForge.preset} onClick={() => setPresetOverride(undefined)}>{savedForge.preset} (current)</button>
              )}
              {/* Choosing the forge that is already saved is no change: clear the override rather
                  than set one, or Save would rewrite the forge for nothing. */}
              {SELECTABLE.map(p => <button key={p} className={preset === p ? "on" : ""} aria-pressed={preset === p} onClick={() => setPresetOverride(p === savedForge?.preset ? undefined : p)}>{p === "github" ? "GitHub" : "Bitbucket"}</button>)}
            </div>
            {preset === "bitbucket" && <input className="input" value={username} onChange={e => setUsername(e.target.value)} placeholder="Atlassian account email" aria-label="Atlassian account email" />}
            {check("forge-username") && <CheckRow check={check("forge-username")!} />}
            {check("forge-token") && <CheckRow check={check("forge-token")!} />}
            {/* Bitbucket's third strategy is `fast_forward`, which is NOT a rebase — offering
                rebase here would promise an operation the adapter refuses. */}
            <div className="hint">Merge methods: squash, merge{preset === "github" ? ", rebase" : ""}.</div>
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void run(async () => setForgeTest(await api.testForge()))}>Test forge</button>
            </div>
            {forgeTest && <div className={forgeTest.ok ? "ok" : "err"}>{forgeTest.message}</div>}
            </div>
          </section>

          {Object.keys(projectRepos).length > 0 && (
            <section className="sec">
              <div className="sec-head"><h4><FolderGit2 />Repos</h4><p className="why">Which repo each Jira project's bugs are fixed in. Filled in as you use “Fix a bug”.</p></div>
              <div className="sec-body maprows">
                {Object.entries(projectRepos).map(([project, repo]) => (
                  <div key={project} className="maprow"><span className="mono">{project}</span><span className="mono">{repo}</span></div>
                ))}
              </div>
            </section>
          )}

          {report.discovery.problems.length > 0 && (
            <section className="sec">
              <div className="sec-head"><h4>Problems reading your Claude Code configuration</h4><p className="why">AgentGrid lists your MCP servers from Claude Code's own files.</p></div>
              <div className="sec-body">{report.discovery.problems.map(p => <div key={p} className="err">{p}</div>)}</div>
            </section>
          )}

          {saved === "restart" && <div className="hint">Saved. A server restart is required for this to take effect.</div>}
          {saved === "live" && <div className="ok">Saved. The bug-fix workflow is now available.</div>}
        </>}
        </div>
        <div className="dlg-ft row footer">
          <span className="help">Saved to <span className="mono">~/.agentgrid/integrations.json</span>.</span>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn p" disabled={busy || !report} onClick={() => void save()}>Save</button>
        </div>
      </section>
    </div>
  );
}
