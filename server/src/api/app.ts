import express, { type Request, type Response, type NextFunction } from "express";
import { rereviewPrompt } from "../agentpr.js";
import { timingSafeEqual } from "node:crypto";
import type { PermissionBroker } from "../permissions/broker.js";
import type { RulesStore } from "../permissions/rules.js";
import path from "node:path";
import { Store, NotFound, Conflict, BadRequest } from "../store/store.js";
import { Manager } from "../runner/manager.js";
import { sseHandler } from "./sse.js";
import { shellQuote } from "../shell.js";
import { listDir, repoStatus } from "../fs.js";
import { pickFolder } from "../picker.js";
import { attachCommand } from "../terminal.js";
import { listAllSessions, listHistorySessions, getHistorySession, renameSession, takeOverSession, type LiveSession, type HistorySession } from "../sessions.js";
import os from "node:os";
import type { Agent, Assignment, Decision, SessionInfo } from "../types.js";
import type { BugFixEngine } from "../bugfix/engine.js";
import type { BugTaskStore } from "../bugfix/store.js";
import type { IntegrationsStore, Integrations } from "../bugfix/integrations.js";
import type { TrackerProvider } from "../bugfix/tracker.js";
import type { TrackerCache } from "../bugfix/trackerCache.js";
import { MOMENTS } from "../bugfix/trackerSync.js";
import { validateStageModels, type StageModels } from "../bugfix/models.js";
import type { BatchStarter } from "../bugfix/batch.js";
import type { ForgeAdapter } from "../bugfix/forge/types.js";
import { discoverMcpServers } from "../bugfix/mcp-discovery.js";
import { buildSetupReport } from "../bugfix/setup.js";

export interface AppDeps {
  store: Store;
  manager: Manager;
  /** Bug-fix workflow; absent when the feature is not configured (routes answer 501). */
  bugs?: { engine: BugFixEngine; store: BugTaskStore; integrations: IntegrationsStore; tracker: TrackerProvider; trackerCache?: TrackerCache; batches?: BatchStarter };
  /** The config store, needed with or without an engine: an unconfigured machine must still
   *  be able to read and write its own integrations.json. */
  integrations?: IntegrationsStore;
  /** Whether the bugfix role resolves (from the app's defaults or ~/.agentgrid/roles). */
  roleResolves?: () => boolean;
  /** Whether a tracker preset has a prompt file to resolve (`presets/tracker/<preset>.md`).
   *  Without this the "tracker" check can only see `toolPrefix` and reports ok on a preset that
   *  does not exist, which is exactly how a fresh Import used to end in a first-run ENOENT. */
  trackerPresetResolves?: (preset: string) => boolean;
  /** A repo whose `.mcp.json` is worth scanning, when one is known. */
  setupRepo?: () => string | undefined;
  /** The home directory to scan for Claude Code's MCP configuration. Defaults to the real
   *  one in production; tests pass a temporary home so the suite never depends on the
   *  machine it runs on. */
  setupHome?: () => string | undefined;
  /** Builds the bug-fix subsystem once configuration first appears. Called at most once. */
  onConfigured?: () => Promise<AppDeps["bugs"] | null>;
  /** Called after any successful write to integrations.json, wired or not. Lets the host keep
   *  config-derived helpers (setupForge, setupRepo) honest: a diagnostic must never report a
   *  configuration the user has already replaced. */
  onConfigSaved?: (cfg: Integrations) => void;
  /** The tracker to exercise from Settings' Test button, when one can be built. */
  setupTracker?: () => TrackerProvider | null;
  /** The forge to exercise from Settings' Test button, when one can be built. */
  setupForge?: () => ForgeAdapter | null;
  transcript?: (assignment: Assignment, agent: Agent) => Promise<unknown[]>;
  /** Full, untruncated transcript of a session in a repo. */
  fullTranscript?: (cwd: string, sessionId: string) => Promise<unknown[]>;
  openTerminal?: (repo: string, sessionId: string) => Promise<void>;
  /** Run an arbitrary shell command in a new terminal window (used for `claude attach`). */
  runInTerminal?: (shell: string) => Promise<void>;
  staticDir?: string;
  /** Root the repo browser may list; defaults to the home directory. */
  browseRoot?: string;
  /** Native folder chooser; resolves null on cancel. Defaults to the macOS picker. */
  pickFolder?: (startDir: string) => Promise<string | null>;
  /** Session sources (tests inject stubs). */
  sessions?: { live: () => Promise<LiveSession[]>; history: () => Promise<HistorySession[]>; lookup?: (id: string) => Promise<HistorySession | null>; rename?: (id: string, title: string) => Promise<void> };
  /** Test hook: how to close a foreign terminal session (default SIGTERM). */
  killSession?: (pid: number) => void;
  /** Send a message into the session's open embedded terminal, pressing Enter for it; false when none is open. */
  submitToTerminal?: (sessionId: string, text: string) => boolean;
  /** The always-allow rules and the broker that holds embedded terminals' permission requests. */
  permissions?: { broker: PermissionBroker; rules: RulesStore };
  /** The per-start secret the PermissionRequest hook must present; null until the server is listening. */
  hookToken?: () => string | null;
  /** Fake mode only: POST /api/fake/permission raises a terminal permission request (the real one comes from the hook). */
  fakePermissions?: boolean;
  /** The agent that owns a Claude Code session (adopted, or ran it), or null. */
  agentForSession?: (sessionId: string) => string | null;
}


function isDecision(d: unknown): d is Decision {
  if (!d || typeof d !== "object") return false;
  const k = (d as any).kind;
  if (k === "allow" || k === "always") return true;
  if (k === "deny") return true;
  if (k === "answers") return typeof (d as any).answers === "object" && (d as any).answers !== null;
  return false;
}

export function createApp(deps: AppDeps) {
  const { store, manager } = deps;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // Any web page can make a browser send a "simple" request to 127.0.0.1, and a GET still runs
  // the route even though the page cannot read the answer. The browser says where a request came
  // from; refuse anything that is not the app's own pages before a route can act on it. Clients
  // that send no header (the desktop shell, curl, tests) are unaffected.
  app.use("/api", (req, res, next) => {
    const site = req.get("sec-fetch-site");
    if (site === "cross-site" || site === "same-site") { res.status(403).json({ error: "cross-site request refused" }); return; }
    next();
  });
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
    (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

  app.get("/api/state", wrap((_req, res) => res.json(store.getState())));
  app.get("/api/events", sseHandler(store));
  app.get("/api/fs", wrap(async (req, res) => {
    const p = req.query.path;
    if (p !== undefined && typeof p !== "string") throw new BadRequest("path must be a string");
    res.json(await listDir(deps.browseRoot ?? os.homedir(), p));
  }));
  app.get("/api/repo-status", wrap(async (req, res) => {
    const p = req.query.path;
    if (typeof p !== "string" || !p) throw new BadRequest("path must be a string");
    res.json(await repoStatus(deps.browseRoot ?? os.homedir(), p));
  }));
  const sessions = () => listAllSessions(store.listAgents(), store.assignmentSessionIds(), { live: async () => store.rawLiveSessions(), history: deps.sessions?.history ?? listHistorySessions, gridPids: store.gridPids });
  const lookup = deps.sessions?.lookup ?? getHistorySession;
  /** Session by id from the merged list, else straight from Claude Code (outside the recent window). */
  const findSession = async (sid: string): Promise<SessionInfo | null> => {
    const hit = (await sessions()).find(s => s.sessionId === sid);
    if (hit) return hit;
    const h = await lookup(sid);
    if (!h) return null;
    const owned = store.listAgents().find(a => a.resumeSessionId === sid);
    return { sessionId: h.sessionId, cwd: h.cwd, title: h.title, kind: "history", status: "ended", at: h.lastActiveAt, ...(owned ? { agentId: owned.id } : {}), canAdopt: !owned };
  };
  app.get("/api/sessions", wrap(async (_req, res) => res.json(await sessions())));
  app.post("/api/sessions/:sessionId/adopt", wrap(async (req, res) => {
    const { role, displayName, takeover } = req.body ?? {};
    if (typeof role !== "string") throw new BadRequest("role is required");
    const sid = req.params.sessionId as string;
    const info = await findSession(sid);
    if (!info) throw new NotFound(`session ${sid} — not found in Claude Code's history`);
    if (!info.canAdopt) throw new Conflict(`session already on the grid as ${info.agentId}`);
    if (takeover && info.kind === "interactive") {
      // Close it in the other terminal first so the grid becomes the only writer, then push the fresh live list.
      const live = store.rawLiveSessions().find(l => l.sessionId === sid);
      if (!live) throw new Conflict("session is no longer live");
      const fetch = deps.sessions?.live ?? (() => import("../sessions.js").then(m => m.listLiveSessions()));
      store.setLiveSessions(await takeOverSession(live, { fetch, kill: deps.killSession }));
    }
    res.status(201).json(await store.createAgent({ role, repo: info.cwd, displayName, resumeSessionId: sid }));
  }));
  app.get("/api/sessions/:sessionId", wrap(async (req, res) => {
    const info = await findSession(req.params.sessionId as string);
    if (!info) throw new NotFound("session not found");
    res.json(info);
  }));
  app.post("/api/sessions/:sessionId/rename", wrap(async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!title) throw new BadRequest("title is required");
    const sid = req.params.sessionId as string;
    if (!(await findSession(sid))) throw new NotFound("session not found");
    await (deps.sessions?.rename ?? renameSession)(sid, title);
    res.status(204).end();
  }));
  app.post("/api/sessions/:sessionId/attach", wrap(async (req, res) => {
    const sid = req.params.sessionId as string;
    const info = (await sessions()).find(s => s.sessionId === sid);
    if (!info) throw new NotFound(`session ${sid}`);
    if (!info.bgId) throw new BadRequest("only background sessions can be attached");
    const command = attachCommand(info.bgId);
    if (deps.runInTerminal) await deps.runInTerminal(command);
    res.json({ command, opened: Boolean(deps.runInTerminal) });
  }));
  app.post("/api/fs/pick", wrap(async (_req, res) => {
    const pick = deps.pickFolder ?? pickFolder;
    const chosen = await pick(deps.browseRoot ?? os.homedir());
    if (chosen === null) res.status(204).end(); else res.json({ path: chosen });
  }));

  app.post("/api/agents", wrap(async (req, res) => {
    const { role, repo, displayName } = req.body ?? {};
    if (typeof role !== "string" || typeof repo !== "string" || !path.isAbsolute(repo)) throw new BadRequest("role and absolute repo are required");
    res.status(201).json(await store.createAgent({ role, repo, displayName }));
  }));
  app.delete("/api/agents/:id", wrap(async (req, res) => { await manager.archive(req.params.id as string); res.status(204).end(); }));

  app.post("/api/agents/:id/assign", wrap(async (req, res) => {
    const prompt = req.body?.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) throw new BadRequest("prompt is required");
    res.status(201).json(await manager.assign(req.params.id as string, prompt));
  }));
  /**
   * Claude Code's PermissionRequest hook, from a session AgentGrid launched in its embedded terminal. Never a
   * browser, and only with the per-start token. It waits for a human (or a rule) and answers with a decision —
   * or with none, which makes Claude Code ask in the terminal as it always did.
   */
  app.post("/api/hooks/permission", wrap(async (req, res) => {
    if (req.get("sec-fetch-site")) { res.status(403).json({ error: "not for browsers" }); return; }
    const token = deps.hookToken?.() ?? null;
    const given = (req.get("authorization") ?? "").replace(/^Bearer /, "");
    if (!token || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) { res.status(401).json({ error: "bad token" }); return; }
    const p = deps.permissions; const b = req.body ?? {};
    const toolName = typeof b.tool_name === "string" ? b.tool_name : "";
    const input = b.tool_input && typeof b.tool_input === "object" && !Array.isArray(b.tool_input) ? b.tool_input as Record<string, unknown> : {};
    // The session AgentGrid launched (the hook sends it) — Claude Code's own id can differ after a resume.
    const launched = req.get("x-agentgrid-session");
    const sessionId = launched && /^[\w-]{1,100}$/.test(launched) ? launched : typeof b.session_id === "string" ? b.session_id : "";
    const agentId = sessionId ? deps.agentForSession?.(sessionId) ?? null : null;
    if (!p || !toolName || toolName === "AskUserQuestion" || !agentId) { res.json({ decision: null }); return; }
    if (p.broker.allowed(toolName, input)) { res.json({ decision: { behavior: "allow" } }); return; }
    const { id, decision } = p.broker.ask({ agentId, source: "terminal", sessionId, toolName, input, suggestions: Array.isArray(b.permission_suggestions) ? b.permission_suggestions : [] });
    // The hook gave up (Claude Code killed it, or it was answered in the terminal and timed out): drop the request.
    res.on("close", () => { if (!res.writableEnded) p.broker.cancel(id); });
    const d = await decision;
    if (!res.writableEnded && !res.destroyed) res.json({ decision: d });
  }));
  if (deps.fakePermissions && deps.permissions) {
    const broker = deps.permissions.broker;
    app.post("/api/fake/permission", wrap(async (req, res) => {
      const agent = store.getAgent(String(req.body?.agentId ?? ""));
      const command = typeof req.body?.command === "string" ? req.body.command : "echo fake";
      const { id } = broker.ask({ agentId: agent.id, source: "terminal", sessionId: `fake-${agent.id}`, toolName: "Bash", input: { command }, suggestions: [] });
      res.status(201).json({ id });
    }));
  }
  /** The shared always-allow rules, for Settings: list them (with any problem reading the file) and remove one. */
  const rulesOrThrow = () => { if (!deps.permissions) throw Object.assign(new Error("permissions are not wired"), { status: 501 }); return deps.permissions.rules; };
  app.get("/api/permissions/rules", wrap(async (_req, res) => { const r = rulesOrThrow(); res.json({ rules: r.list(), problem: r.problem }); }));
  app.delete("/api/permissions/rules", wrap(async (req, res) => {
    const r = rulesOrThrow(); const rule = req.body?.rule;
    if (typeof rule !== "string" || !rule.trim()) throw new BadRequest("rule is required");
    res.json({ rules: await r.remove(rule), problem: r.problem });
  }));
  app.post("/api/agents/:id/answer", wrap(async (req, res) => {
    const { toolUseId, decision } = req.body ?? {};
    if (typeof toolUseId !== "string" || !isDecision(decision)) throw new BadRequest("toolUseId and decision are required");
    // An embedded terminal's request lives in the broker; an SDK run's is parked on its runner.
    const broker = deps.permissions?.broker;
    if (broker?.owns(toolUseId)) {
      const open = broker.list().find(r => r.id === toolUseId);
      if (open && open.agentId !== req.params.id) throw new NotFound(`no permission request ${toolUseId} for ${req.params.id}`);
      await broker.answer(toolUseId, decision); res.status(204).end(); return;
    }
    await manager.answer(req.params.id as string, toolUseId, decision); res.status(204).end();
  }));
  app.post("/api/agents/:id/cancel", wrap(async (req, res) => { await manager.cancel(req.params.id as string); res.status(204).end(); }));
  app.post("/api/agents/:id/ack", wrap(async (req, res) => { await manager.ack(req.params.id as string); res.status(204).end(); }));
  /** Forget an adopted session so the next task starts fresh (bug: pulled-in agent kept old context forever). */
  app.post("/api/agents/:id/reset", wrap(async (req, res) => {
    const agent = store.getAgent(req.params.id as string);
    if (agent.state !== "free" && agent.state !== "done" && agent.state !== "failed") throw new Conflict(`agent is ${agent.state}`);
    if (agent.resumeSessionId && store.isLive(agent.resumeSessionId) && store.liveSessions().find(l => l.sessionId === agent.resumeSessionId)?.owner !== "grid") throw new Conflict("session is open in a terminal — close it first");
    res.json(await store.clearResumeSession(agent.id));
  }));
  /** Reply to the agent's session: into the embedded terminal if one is open, else a grid assignment — continuing a finished run's conversation. */
  app.post("/api/agents/:id/say", wrap(async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) throw new BadRequest("text is required");
    const agent = store.getAgent(req.params.id as string);
    const sid = agent.currentAssignmentId ? store.getAssignment(agent.currentAssignmentId).sessionId : agent.resumeSessionId;
    if (sid && deps.submitToTerminal?.(sid, text.replace(/\r?\n$/, ""))) { res.json({ via: "terminal" }); return; }
    if (agent.state === "working" || agent.state === "waiting") throw new Conflict(`agent is ${agent.state} and has no open terminal`);
    res.status(201).json({ via: "assignment", assignment: await manager.reply(agent.id, text) });
  }));
  /** Second look at the PR a finished review named — in the same conversation, so it checks its own findings. */
  app.post("/api/agents/:id/rereview", wrap(async (req, res) => {
    const agent = store.getAgent(req.params.id as string);
    const last = agent.currentAssignmentId ? store.getAssignment(agent.currentAssignmentId) : null;
    if ((agent.state !== "done" && agent.state !== "failed") || !last) throw new Conflict(`agent is ${agent.state} — re-review once its review has finished`);
    if (last.pr?.state !== "OPEN") throw new Conflict("no open pull request to re-review");
    res.status(201).json(await manager.reply(agent.id, rereviewPrompt(last.pr)));
  }));
  app.get("/api/agents/:id/memory", wrap(async (req, res) => res.json(await store.listMemory(req.params.id as string))));

  app.post("/api/agents/:id/open-terminal", wrap(async (req, res) => {
    const agent = store.getAgent(req.params.id as string);
    const asg = agent.currentAssignmentId ? store.getAssignment(agent.currentAssignmentId) : null;
    if (!asg?.sessionId) throw new BadRequest("no session to open");
    const command = `cd ${shellQuote(agent.repo)} && claude --resume ${shellQuote(asg.sessionId)}`;
    if (deps.openTerminal) await deps.openTerminal(agent.repo, asg.sessionId);
    res.json({ command, opened: Boolean(deps.openTerminal) });
  }));
  app.get("/api/agents/:id/transcript", wrap(async (req, res) => {
    const agent = store.getAgent(req.params.id as string);
    const current = agent.currentAssignmentId ? store.getAssignment(agent.currentAssignmentId) : null;
    const last = store.listAssignments(Number.MAX_SAFE_INTEGER).filter(a => a.agentId === agent.id && a.sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const sessionId = current?.sessionId ?? agent.resumeSessionId ?? last?.sessionId ?? null;
    if (!sessionId) { res.json({ sessionId: null, entries: [] }); return; }
    res.json({ sessionId, entries: deps.fullTranscript ? await deps.fullTranscript(agent.repo, sessionId) : [] });
  }));
  app.get("/api/assignments/:id/transcript", wrap(async (req, res) => {
    const asg = store.getAssignment(req.params.id as string);
    const agent = store.getAgent(asg.agentId);
    res.json(deps.transcript ? await deps.transcript(asg, agent) : []);
  }));

  class NotWired extends Error { status = 501; }
  // The engine may arrive mid-process, once configuration first appears (see `maybeWire`).
  let wired = deps.bugs;
  const bugs = () => { if (!wired) throw new NotWired("the bug-fix workflow is not configured"); return wired; };
  const setBugTasksSource = () => { if (wired) store.bugTasks = () => wired!.store.list(); };
  setBugTasksSource();

  /** The config store is reachable with or without an engine; the engine's copy is the same object. */
  const integrationsStore = () => {
    const s = deps.integrations ?? wired?.integrations;
    if (!s) throw new NotWired("no configuration store");
    return s;
  };

  /**
   * One absent→present transition per process, never a re-wire: with no engine, no bug task
   * can exist, so building one disrupts nothing. An engine that already exists is left alone —
   * rebuilding it would tear down in-flight tasks whose dispatch state is in memory.
   */
  let wiring: Promise<void> | null = null;
  const maybeWire = (): Promise<void> => {
    if (wired || !deps.onConfigured) return Promise.resolve();
    // Memoised before any await: two overlapping saves must join one build, not race two.
    // Task 5's `onConfigured` starts a PrWatcher, so a discarded second build would leave
    // a timer polling for the life of the process with no reference left to stop it.
    if (!wiring) wiring = (async () => {
      wired = (await deps.onConfigured!()) ?? undefined;
      setBugTasksSource();
    })().finally(() => { wiring = null; });
    return wiring;
  };

  /**
   * `maybeWire`, made non-fatal to the response. Every route below can answer perfectly well
   * without an engine, and a failed wiring attempt is never news the caller is missing: the way
   * `onConfigured` fails in practice is a config it could not read — `read()` throws `Conflict`
   * (HTTP 409) for a corrupt or present-but-unreadable `integrations.json` — and `setupReport()`
   * independently reports exactly that cause, as a `config-file` check in state "broken" carrying
   * the parse error and the action that fixes it. Letting the rejection through would replace
   * that diagnosis with a bare 409, denying the user the one thing that tells them how to
   * recover; boot deliberately catches the same error for the same reason (see `start.ts`).
   * Nothing is hidden, and the one-shot memoisation is untouched: `wiring` and its `finally`
   * still live in `maybeWire`.
   */
  const tryWire = (): Promise<void> => maybeWire().catch(() => {});

  /** Options for `discoverMcpServers`: `home` defaults to the real one in production, but
   *  tests inject a temporary one via `setupHome` so the suite never depends on the machine
   *  it runs on. */
  const scanOptions = () => ({
    ...(deps.setupHome?.() ? { home: deps.setupHome()! } : {}),
    ...(deps.setupRepo?.() ? { repo: deps.setupRepo()! } : {}),
  });

  const setupReport = async () => {
    const store_ = integrationsStore();
    let cfg: Integrations | null = null; let cfgError: string | undefined;
    try { cfg = await store_.read(); } catch (err) { cfgError = (err as Error).message; }
    // `exists()` now throws for the same "present but unreadable" case `read()` just caught
    // above — only ask it when `read()` didn't already answer that question, so a broken file
    // doesn't turn into an unhandled rejection here.
    let cfgExists = false;
    if (!cfgError) { try { cfgExists = await store_.exists(); } catch (err) { cfgError = (err as Error).message; } }
    const discovery = await discoverMcpServers(scanOptions());
    return buildSetupReport({ cfg, ...(cfgError ? { cfgError } : {}), cfgExists, discovery,
      env: process.env, wired: !!wired, roleResolves: deps.roleResolves?.() ?? true,
      trackerPresetResolves: deps.trackerPresetResolves });
  };

  // A hand-edited config on a running-but-unwired server (the README tells people to edit the
  // file directly) must come alive the next time Settings is opened, without ever re-wiring an
  // engine that already exists — `maybeWire` is memoised and absent→present-once, so this is
  // just "try once more before answering" rather than a second wiring path.
  app.get("/api/setup", wrap(async (_req, res) => { await tryWire(); res.json(await setupReport()); }));

  // A failed test is an answer, not a server error: 200 with ok:false, carrying the
  // provider's own words. "Something went wrong" is exactly what this screen exists to end.
  app.post("/api/setup/test/tracker", wrap(async (_req, res) => {
    const tracker = deps.setupTracker?.() ?? wired?.tracker ?? null;
    if (!tracker) return res.json({ ok: false, message: "no tracker is configured yet" });
    try {
      const issues = await tracker.listMyIssues();
      return res.json({ ok: true, message: `${issues.length} issues assigned to you.` });
    } catch (err) {
      return res.json({ ok: false, message: (err as Error).message });
    }
  }));

  app.post("/api/setup/test/forge", wrap(async (_req, res) => {
    const forge = deps.setupForge?.() ?? null;
    if (!forge) return res.json({ ok: false, message: "no forge is configured yet" });
    const status = await forge.authStatus();          // adapters never throw
    return res.json(status);
  }));

  // Spec §8: "the UI sees a server's name, transport and URL, not its headers." A definition in
  // tracker.mcpServers can carry a credential (a bearer token, a header) copied verbatim from
  // Claude Code's own config — never send it to the browser. The UI's only uses of these routes are
  // projectRepos and forge (username included; forges never store a secret here, unlike a tracker
  // MCP definition), plus tracker.preset/toolPrefix for display.
  /** The one shape either integrations route may hand the browser, so the two cannot drift.
   *  `PUT`'s response needs this every bit as much as `GET`'s: `write()` returns the *merged*
   *  config, so a Save touching only `forge` would otherwise echo back a stored
   *  `tracker.mcpServers` — token and headers included — that the browser never sent and must
   *  never receive.
   *
   *  This is an allow-list: a field is named here only once it is known to carry no credential.
   *  `hints` is named because it is prompt text the user wrote (it is interpolated into the
   *  tracker preset's prompt, `tracker.ts`), and because `PUT` replaces `tracker` wholesale —
   *  a browser that cannot read `hints` back destroys it on the next save. Nothing else on
   *  `TrackerConfig` may be added without the same argument. */
  const redactIntegrations = (cfg: Integrations) => ({
    projectRepos: cfg.projectRepos,
    ...(cfg.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: cfg.maxConcurrentRuns } : {}),
    ...(cfg.statusMap !== undefined ? { statusMap: cfg.statusMap } : {}),
    ...(cfg.stageModels !== undefined ? { stageModels: cfg.stageModels } : {}),
    ...(cfg.autoResolveConflicts !== undefined ? { autoResolveConflicts: cfg.autoResolveConflicts } : {}),
    ...(cfg.commentQuietMinutes !== undefined ? { commentQuietMinutes: cfg.commentQuietMinutes } : {}),
    ...(cfg.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: cfg.dailyBudgetUsd } : {}),
    ...(cfg.forge ? { forge: cfg.forge } : {}),
    ...(cfg.tracker ? { tracker: {
      preset: cfg.tracker.preset,
      toolPrefix: cfg.tracker.toolPrefix,
      ...(cfg.tracker.hints !== undefined ? { hints: cfg.tracker.hints } : {}),
    } } : {}),
  });

  app.get("/api/integrations", wrap(async (_req, res) => {
    res.json(redactIntegrations(await integrationsStore().read()));
  }));

  const MERGE_POLICIES = ["ask", "auto"] as const;
  const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
  const FORGE_PRESETS = ["github", "gitlab", "bitbucket", "custom"] as const;

  app.get("/api/bugtasks", wrap((_req, res) => res.json(bugs().store.list())));
  app.get("/api/bugtasks/:id", wrap((req, res) => res.json(bugs().store.get(req.params.id as string))));
  app.get("/api/bugtasks/:id/plan", wrap(async (req, res) => {
    const b = bugs(); b.store.get(req.params.id as string);
    res.json({ markdown: (await b.store.readArtifact(req.params.id as string, "plan.md")) ?? "" });
  }));
  app.get("/api/bugtasks/:id/diff", wrap(async (req, res) => {
    const b = bugs(); b.store.get(req.params.id as string);
    res.json(await b.engine.diffFor(req.params.id as string));
  }));
  app.post("/api/bugtasks", wrap(async (req, res) => {
    const { issueRef, repo, mergePolicy, mergeMethod, baseBranch, startAnyway } = req.body ?? {};
    if (baseBranch !== undefined && (typeof baseBranch !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(baseBranch))) throw new BadRequest("baseBranch must be a branch name");
    if (typeof issueRef !== "string" || !issueRef.trim()) throw new BadRequest("issueRef is required");
    if (typeof repo !== "string" || !path.isAbsolute(repo)) throw new BadRequest("an absolute repo path is required");
    if (mergePolicy !== undefined && !MERGE_POLICIES.includes(mergePolicy)) throw new BadRequest(`mergePolicy must be one of ${MERGE_POLICIES.join(", ")}`);
    if (mergeMethod !== undefined && !MERGE_METHODS.includes(mergeMethod)) throw new BadRequest(`mergeMethod must be one of ${MERGE_METHODS.join(", ")}`);
    res.status(201).json(await bugs().engine.intake({ issueRef: issueRef.trim(), repo, mergePolicy, mergeMethod, ...(baseBranch ? { baseBranch } : {}), ...(startAnyway === true ? { startAnyway: true } : {}) }));
  }));
  /** Start many tickets at once (spec 2026-10-08 §5.2): 202 with a batch id; progress arrives as `batch` events. */
  app.post("/api/bugtasks/batch", wrap(async (req, res) => {
    const b = bugs();
    if (!b.batches) throw Object.assign(new Error("starting many isn't available"), { status: 501 });
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) throw new BadRequest("items must list the tickets to start");
    if (items.length > 500) throw new BadRequest("at most 500 tickets per request — send the rest in another");
    for (const it of items) {
      if (!it || typeof it.issueRef !== "string" || !it.issueRef.trim() || typeof it.repo !== "string" || !path.isAbsolute(it.repo)) throw new BadRequest("each item needs an issueRef and an absolute repo path");
      if (it.baseBranch !== undefined && (typeof it.baseBranch !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(it.baseBranch))) throw new BadRequest("baseBranch must be a branch name");
    }
    const anyway = Array.isArray(req.body?.startAnyway) ? req.body.startAnyway.filter((k: unknown) => typeof k === "string") : [];
    res.status(202).json({ batchId: b.batches.start(items.map((it: { issueRef: string; repo: string; baseBranch?: string }) => ({ issueRef: it.issueRef.trim(), repo: it.repo, ...(it.baseBranch ? { baseBranch: it.baseBranch } : {}) })), anyway) });
  }));
  app.get("/api/bugtasks/batch/:batchId", wrap(async (req, res) => {
    const st = bugs().batches?.get(req.params.batchId as string);
    if (!st) throw new NotFound(`batch ${req.params.batchId}`);
    res.json(st);
  }));
  app.get("/api/bugfix/spend", wrap(async (_req, res) => res.json(bugs().engine.spend())));
  app.post("/api/bugtasks/resolve-conflicts", wrap(async (_req, res) => res.json({ ids: await bugs().engine.resolveConflicts() })));
  app.post("/api/bugtasks/:id/override-tests", wrap(async (req, res) => {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) throw new BadRequest("say why there is no regression test");
    res.json(await bugs().engine.overrideTests(req.params.id as string, reason));
  }));
  app.post("/api/bugtasks/:id/close-no-change", wrap(async (req, res) => res.json(await bugs().engine.closeNoChange(req.params.id as string))));
  // `mergeMethod` is honoured only at the merge gate (`engine.mergeTask` checks the task is
  // actually "approved" before persisting it) — passing it anywhere else is simply ignored by
  // `mergeTask`, same as it always was. Validated here, before the engine is ever touched, so
  // a bad value 400s uniformly regardless of what stage the task happens to be in.
  app.post("/api/bugtasks/:id/approve", wrap(async (req, res) => {
    const b = bugs();
    const method = req.body?.mergeMethod;
    if (method !== undefined && !MERGE_METHODS.includes(method)) throw new BadRequest(`mergeMethod must be one of ${MERGE_METHODS.join(", ")}`);
    // The gate the click was for: refused (409) if the task has since moved to another one.
    const expect = req.body?.expect;
    if (expect !== undefined && !["plan", "diff", "merge", "conflict"].includes(expect)) throw new BadRequest("expect must be a gate: plan, diff, merge or conflict");
    res.json(method ? await b.engine.mergeTask(req.params.id as string, method) : await b.engine.approve(req.params.id as string, expect));
  }));
  app.post("/api/bugtasks/:id/cancel", wrap(async (req, res) => res.json(await bugs().engine.cancel(req.params.id as string))));
  app.post("/api/bugtasks/:id/retry", wrap(async (req, res) => res.json(await bugs().engine.retry(req.params.id as string))));
  app.post("/api/bugtasks/:id/request-changes", wrap(async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) throw new BadRequest("text is required");
    res.json(await bugs().engine.requestChanges(req.params.id as string, text));
  }));
  /** The manual feedback round from the monitoring card — bypasses the watcher's dispatch cap
   *  (see `engine.addressComments`'s own comment): a human clicking this is the opposite of
   *  the unattended dispatch that cap exists to bound. */
  app.post("/api/bugtasks/:id/address-comments", wrap(async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : undefined;
    res.json(await bugs().engine.addressComments(req.params.id as string, text));
  }));
  app.delete("/api/bugtasks/:id", wrap(async (req, res) => {
    await bugs().engine.dismiss(req.params.id as string);
    res.status(204).end();
  }));
  // My open bugs, from the tracker cache: at once, refreshed behind the scenes (spec 2026-10-08 §3.4).
  // The very first read has nothing to show yet, so it waits for it.
  app.get("/api/bugfix/issues", wrap(async (_req, res) => {
    const b = bugs();
    if (!b.trackerCache) return res.json({ issues: await b.tracker.listMyIssues(), fetchedAt: new Date().toISOString(), refreshing: false, error: null, generation: 0 });
    const now = b.trackerCache.myIssues();
    res.json(now.fetchedAt === null ? await b.trackerCache.refresh() : now);
  }));
  /** A ticket's available workflow transitions, for Settings → Ticket statuses. Cached an hour per project. */
  const transitionsByProject = new Map<string, { at: number; list: unknown }>();
  app.get("/api/bugfix/transitions", wrap(async (req, res) => {
    const key = typeof req.query.key === "string" ? req.query.key : "";
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)) throw new BadRequest("a ticket key like PAY-42 is required");
    const b = bugs();
    if (!b.tracker.listTransitions) { res.status(501).json({ error: "status sync isn't supported for this tracker (its preset has no listTransitions/transition)" }); return; }
    const project = key.split("-")[0].toUpperCase();
    const hit = transitionsByProject.get(project);
    if (hit && Date.now() - hit.at < 3_600_000) { res.json(hit.list); return; }
    const list = await b.tracker.listTransitions(key);
    transitionsByProject.set(project, { at: Date.now(), list });
    res.json(list);
  }));
  app.post("/api/bugfix/issues/refresh", wrap(async (_req, res) => {
    const b = bugs();
    if (b.trackerCache) void b.trackerCache.refresh();
    res.status(202).json({});
  }));
  /** One ticket, in full — the bugs view shows an unstarted bug before anything is created for it. */
  app.get("/api/bugfix/issues/:key", wrap(async (req, res) => {
    const key = req.params.key as string;
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)) throw new BadRequest("not a ticket key");
    const b = bugs();
    res.json(b.trackerCache ? await b.trackerCache.issue(key) : await b.tracker.fetchIssue(key));
  }));
  app.get("/api/bugfix/preflight", wrap(async (req, res) => {
    const repo = req.query.repo;
    if (typeof repo !== "string" || !path.isAbsolute(repo)) throw new BadRequest("an absolute repo path is required");
    res.json(await bugs().engine.preflight(repo));
  }));
  app.put("/api/integrations", wrap(async (req, res) => {
    const body = req.body ?? {};
    // Only the two known top-level fields are accepted; anything else in the body is
    // deliberately dropped rather than persisted (same "pick the fields you accept"
    // convention POST /api/agents already uses), not silently merged onto disk.
    const patch: { tracker?: unknown; forge?: unknown; maxConcurrentRuns?: number; statusMap?: unknown; stageModels?: StageModels; autoResolveConflicts?: boolean; commentQuietMinutes?: number; dailyBudgetUsd?: number | null } = {};
    if (body.statusMap !== undefined) {
      const m = body.statusMap;
      const bad = (why: string) => { throw new BadRequest(`statusMap: ${why}`); };
      if (!m || typeof m !== "object" || Array.isArray(m)) bad("must be an object of projects");
      for (const [project, moments] of Object.entries(m)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(project)) bad(`"${project}" is not a project key like PAY`);
        if (!moments || typeof moments !== "object" || Array.isArray(moments)) bad(`${project} must map moments to transitions`);
        for (const [moment, v] of Object.entries(moments as Record<string, unknown>)) {
          if (!(MOMENTS as string[]).includes(moment)) bad(`"${moment}" is not one of ${MOMENTS.join(", ")}`);
          const t = v as { transition?: unknown; to?: unknown };
          const okStr = (x: unknown) => typeof x === "string" && x.trim().length > 0 && x.length <= 100;
          if (!t || typeof t !== "object" || !okStr(t.transition) || !okStr(t.to)) bad(`${project}.${moment} needs a transition and the status it leads to`);
        }
      }
      patch.statusMap = m;
    }
    if (body.stageModels !== undefined) patch.stageModels = validateStageModels(body.stageModels);
    if (body.autoResolveConflicts !== undefined) {
      if (typeof body.autoResolveConflicts !== "boolean") throw new BadRequest("autoResolveConflicts must be true or false");
      patch.autoResolveConflicts = body.autoResolveConflicts;
    }
    if (body.commentQuietMinutes !== undefined) {
      const n = body.commentQuietMinutes;
      if (!Number.isInteger(n) || n < 0 || n > 240) throw new BadRequest("commentQuietMinutes must be a whole number from 0 to 240");
      patch.commentQuietMinutes = n;
    }
    if (body.dailyBudgetUsd !== undefined) {
      const n = body.dailyBudgetUsd;
      if (n !== null && (typeof n !== "number" || !(n >= 0.5 && n <= 10000))) throw new BadRequest("dailyBudgetUsd must be from 0.5 to 10000, or null for no limit");
      patch.dailyBudgetUsd = n;
    }
    if (body.maxConcurrentRuns !== undefined) {
      const n = body.maxConcurrentRuns;
      if (!Number.isInteger(n) || n < 1 || n > 32) throw new BadRequest("maxConcurrentRuns must be a whole number from 1 to 32");
      patch.maxConcurrentRuns = n;
    }
    if (body.tracker !== undefined) {
      const tracker = body.tracker;
      if (!tracker || typeof tracker !== "object" || Array.isArray(tracker)) {
        throw new BadRequest("tracker must be an object");
      }
      // `preset` is deliberately not enum-checked: it's a free-form lookup key into
      // presets/tracker/<preset>.md, not a fixed set like forge's. Every other field on
      // TrackerConfig is checked for shape when present; unknown keys (including a 0.4.0
      // client still sending `mcpServers`) are dropped, same as the rest of this body.
      if (tracker.preset !== undefined && typeof tracker.preset !== "string") throw new BadRequest("tracker.preset must be a string");
      if (tracker.toolPrefix !== undefined && typeof tracker.toolPrefix !== "string") throw new BadRequest("tracker.toolPrefix must be a string");
      if (tracker.hints !== undefined && typeof tracker.hints !== "string") throw new BadRequest("tracker.hints must be a string");
      // `tracker` is replaced wholesale on write (deliberately — that is what sheds a 0.4.0
      // `mcpServers`), so a patch naming neither field is not a partial update: it replaces a
      // working tracker with `{}`. Settings' hand-entry box makes that one empty textarea away.
      if (tracker.preset === undefined && tracker.toolPrefix === undefined) {
        throw new BadRequest("tracker must set preset or toolPrefix");
      }
      const t: Record<string, unknown> = {};
      if (tracker.preset !== undefined) t.preset = tracker.preset;
      if (tracker.toolPrefix !== undefined) t.toolPrefix = tracker.toolPrefix;
      if (tracker.hints !== undefined) t.hints = tracker.hints;
      patch.tracker = t;
    }
    if (body.forge !== undefined) {
      const forge = body.forge;
      if (!forge || typeof forge !== "object" || !FORGE_PRESETS.includes(forge.preset)) {
        throw new BadRequest(`forge.preset must be one of ${FORGE_PRESETS.join(", ")}`);
      }
      if (forge.username !== undefined && typeof forge.username !== "string") {
        throw new BadRequest("forge.username must be a string");
      }
      // Bitbucket has no other way to authenticate (Basic auth needs the Atlassian email).
      // A blank/whitespace username would otherwise sail through here, and `makeForge`
      // would then just treat the whole forge as unconfigured — leaving the user with
      // intake's generic "no forge configured", naming neither `forge.username` nor
      // integrations.json. Reject it here instead, naming the field, per spec §1.
      if (forge.preset === "bitbucket" && (typeof forge.username !== "string" || !forge.username.trim())) {
        throw new BadRequest("forge.username is required for the bitbucket preset (your Atlassian account email)");
      }
      patch.forge = forge;
    }
    const saved = await integrationsStore().write(patch as never);
    deps.onConfigSaved?.(saved);
    // A different tracker: its bugs aren't the old one's — never show those (Review Focus 4).
    if (patch.tracker !== undefined) wired?.trackerCache?.clear();
    if (patch.maxConcurrentRuns !== undefined) wired?.engine.setMaxConcurrentRuns(patch.maxConcurrentRuns);
    if (patch.dailyBudgetUsd !== undefined) wired?.engine.setDailyBudget(patch.dailyBudgetUsd ?? null);
    await tryWire();
    res.json(redactIntegrations(saved));
  }));

  app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

  if (deps.staticDir) {
    app.use(express.static(deps.staticDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(deps.staticDir!, "index.html")));
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status === 500) console.error(err);
    // `code` lets a client act on a refusal (e.g. "already-on-base" → offer Start anyway) without parsing prose.
    res.status(status).json({ error: err?.message ?? "internal error", ...(status < 500 && typeof err?.code === "string" && /^[a-z-]+$/.test(err.code) ? { code: err.code } : {}) });
  });
  return app;
}
