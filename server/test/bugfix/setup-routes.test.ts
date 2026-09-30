import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp, type AppDeps } from "../../src/api/app.js";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/runner/manager.js";
import { IntegrationsStore } from "../../src/bugfix/integrations.js";
import { Conflict } from "../../src/store/store.js";

/**
 * A minimal wired bugs object for testing live-wiring behavior. Returns null to pass the type
 * check — the tests that use this never call into the engine/store/integrations/tracker.
 */
function fakeWiredBugs(): AppDeps["bugs"] {
  return { engine: null as never, store: null as never, integrations: null as never, tracker: null as never };
}

/** Like `fakeWiredBugs`, but with a working `store.list()` so a route that touches it (rather
 *  than just the `wired` flag) can be asserted against without throwing on a null dereference. */
function fakeWiredBugsWithStore(): AppDeps["bugs"] {
  return { engine: null as never, store: { list: () => [] } as never, integrations: null as never, tracker: null as never };
}

/**
 * An app with NO bug-fix engine — the case the old API could not express. `agentgrid-setup-`
 * (the `~/.agentgrid` home) and `claudeHome` (the `~/.claude` home `discoverMcpServers` scans)
 * are deliberately separate temp directories: conflating them would hide a wiring bug where
 * the wrong one leaks into the other's slot. Both are fresh per call, so this suite never reads
 * or depends on the real machine's `~/.claude` or `~/.agentgrid`.
 */
async function unwiredApp(extra?: { onConfigured?: AppDeps["onConfigured"]; onConfigSaved?: AppDeps["onConfigSaved"]; tracker?: { listMyIssues: () => Promise<unknown[]> }; forge?: { authStatus: () => Promise<{ ok: boolean; message: string }> }; trackerPresetResolves?: AppDeps["trackerPresetResolves"] } | undefined) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-setup-"));
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), "agentgrid-setup-claude-"));
  const store = new Store(home, path.resolve("roles"));
  await store.init();
  const integrations = new IntegrationsStore(home);
  const app = createApp({
    store,
    manager: new Manager({ store } as never),
    integrations,
    roleResolves: () => true,
    setupHome: () => claudeHome,
    onConfigured: extra?.onConfigured,
    onConfigSaved: extra?.onConfigSaved,
    trackerPresetResolves: extra?.trackerPresetResolves,
    ...(extra?.tracker ? { setupTracker: () => extra.tracker as never } : {}),
    ...(extra?.forge ? { setupForge: () => extra.forge as never } : {}),
  });
  return { app, home, claudeHome, integrations };
}

describe("the setup routes answer without an engine", () => {
  it("GET /api/setup reports what is missing instead of 501", async () => {
    const { app } = await unwiredApp();
    const res = await request(app).get("/api/setup").expect(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.wired).toBe(false);
    const ids = res.body.checks.map((c: { id: string }) => c.id);
    expect(ids).toContain("config-file");
    expect(ids).toContain("tracker");
  });

  it("GET /api/integrations answers rather than 501", async () => {
    const { app } = await unwiredApp();
    const res = await request(app).get("/api/integrations").expect(200);
    expect(res.body).toEqual({ projectRepos: {} });
  });

  it("PUT /api/integrations creates the file on a machine that has none", async () => {
    const { app, integrations } = await unwiredApp();
    await request(app).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
    expect((await integrations.read()).forge).toEqual({ preset: "github" });
  });

  it("the bug-fix routes still 501 without an engine", async () => {
    const { app } = await unwiredApp();
    await request(app).get("/api/bugtasks").expect(501);
  });

  it("POST /api/setup/import refuses a name that was not discovered", async () => {
    const { app } = await unwiredApp();
    const res = await request(app).post("/api/setup/import").send({ name: "nope" }).expect(400);
    expect(res.body.error).toMatch(/nope/);
  });

  // C1: the headline journey (Detect → Import → start a bug fix) writes a tracker preset that
  // has to actually resolve to a prompt file, or the very next tracker call is a bare ENOENT
  // while Settings reports green. This is the missing success-path test for the import route,
  // and it also closes the deferred item about that route's untested `onConfigSaved` call.
  it("importing a discovered server writes a tracker preset that resolves, reports it ok, and tells the host", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const { app, claudeHome, integrations } = await unwiredApp({
      onConfigSaved: cfg => { saved.push(cfg as never); },
      // Only "jira" has a prompt file in this stand-in for `presets/tracker/`, same as the real
      // shipped directory — proving the written preset is the one that actually resolves.
      trackerPresetResolves: (preset: string) => preset === "jira",
    });
    await writeFile(path.join(claudeHome, ".claude.json"), JSON.stringify({
      mcpServers: { atlassian: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" } },
    }));

    const res = await request(app).post("/api/setup/import").send({ name: "atlassian" }).expect(200);

    const written = await integrations.read();
    expect(written.tracker).toEqual({
      preset: "jira", toolPrefix: "mcp__atlassian",
      mcpServers: { atlassian: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" } },
    });
    const trackerCheck = res.body.checks.find((c: { id: string }) => c.id === "tracker");
    expect(trackerCheck).toMatchObject({ state: "ok" });
    expect(saved).toHaveLength(1);
    expect((saved[0] as any).tracker.preset).toBe("jira");
  });

  // Pins `setupHome`'s wiring: without it, `discoverMcpServers` silently falls back to
  // `os.homedir()`, and this test would instead report on whatever the real machine running
  // the suite happens to have in its real `~/.claude` — passing or failing for reasons nobody
  // could reproduce. Regressing that fallback would make this test flicker with the real home's
  // actual MCP configuration instead of failing outright, so it also documents why the
  // injection exists.
  it("GET /api/setup scans the injected home, not the real one", async () => {
    const { app, claudeHome } = await unwiredApp();
    await writeFile(path.join(claudeHome, ".claude.json"), JSON.stringify({
      mcpServers: { jira: { command: "npx", args: ["jira-mcp"] } },
    }));
    const res = await request(app).get("/api/setup").expect(200);
    expect(res.body.discovery.importable).toContainEqual(
      expect.objectContaining({ name: "jira", origin: "user" }),
    );
  });

  // Memoisation works when two saves genuinely overlap. Without the gate, timing variations under
  // load can cause serialisation, and the second save will legitimately call onConfigured again
  // (because the first returned null, never setting wired). This test forces genuine overlap to
  // verify the memo works.
  it("joins one build when two saves genuinely overlap", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    // onConfigured parks on a gate the test controls, so the window is not a guess:
    // the second save cannot serialise behind the first, whatever the machine is doing.
    const onConfigured: AppDeps["onConfigured"] = async () => { calls++; await gate; return null; };
    const { app } = await unwiredApp({ onConfigured });

    let firstResolve: any, secondResolve: any;
    const firstDone = new Promise(r => { firstResolve = r; });
    const secondDone = new Promise(r => { secondResolve = r; });

    // Start both requests in quick succession using .end() to queue them concurrently
    request(app).put("/api/integrations").send({ forge: { preset: "github" } })
      .end((err, res) => { if (err) throw err; firstResolve(res); });
    request(app).put("/api/integrations").send({ forge: { preset: "github" } })
      .end((err, res) => { if (err) throw err; secondResolve(res); });

    // Wait until at least one has entered onConfigured
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(1));
    release();

    const [firstRes, secondRes] = await Promise.all([firstDone, secondDone]);
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(calls).toBe(1);
  });

  // Once the subsystem is wired (onConfigured returns non-null), the wired short-circuit
  // guarantees no later save can trigger a rebuild. This holds regardless of timing.
  it("never rebuilds once the subsystem is wired", async () => {
    let calls = 0;
    const onConfigured: AppDeps["onConfigured"] = async () => { calls++; return fakeWiredBugs(); };
    const { app } = await unwiredApp({ onConfigured });
    await request(app).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
    await request(app).put("/api/integrations").send({ forge: { preset: "bitbucket", username: "me@example.com" } }).expect(200);
    expect(calls).toBe(1);
  });

  // onConfigSaved must be called after every write, even on a wired server when maybeWire
  // short-circuits. This is the only state where the bug appears: the host needs to know the
  // config changed so config-derived helpers like setupForge report the current state, not stale.
  it("reports every saved config to the host, even once the engine is wired", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const { app } = await unwiredApp({
      onConfigured: async () => fakeWiredBugs(),          // becomes wired on the first save
      onConfigSaved: cfg => { saved.push(cfg as never); },
    });

    await request(app).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
    await request(app).put("/api/integrations").send({ forge: { preset: "bitbucket", username: "me@example.com" } }).expect(200);

    // The second save is the one that matters: `maybeWire` short-circuits there, so before the
    // fix nothing told the host the config had changed and `setupForge` kept building github.
    expect(saved).toHaveLength(2);
    expect((saved[1] as any).forge).toEqual({ preset: "bitbucket", username: "me@example.com" });
  });

  // I3: the new README tells people editing is fine ("Editing the file directly"). A valid
  // config hand-written onto a running-but-unwired server must not sit there reporting green
  // while the bug-fix routes still 501 — the original two-session failure, reproduced. Writing
  // straight through `integrations` (not the PUT route) is the point: nothing told the running
  // process about this write, so only `GET /api/setup` calling `maybeWire()` itself can notice.
  it("wires a hand-edited config the next time GET /api/setup is called, without going through the route", async () => {
    let calls = 0;
    // Mirrors production's `onConfigured` (start.ts:197 -> wireBugFix): it re-reads the config
    // and returns null when there is no tracker to build one from. A stub that wires
    // unconditionally would report `wired: true` on the very first GET against an empty home,
    // which is what made this test assert against a state the server can never be in.
    let integrationsRef!: { read: () => Promise<{ tracker?: unknown }> };
    const onConfigured: AppDeps["onConfigured"] = async () => {
      if (!(await integrationsRef.read()).tracker) return null;
      calls++; return fakeWiredBugsWithStore();
    };
    const { app, integrations } = await unwiredApp({ onConfigured });
    integrationsRef = integrations;

    const before = await request(app).get("/api/setup").expect(200);
    expect(before.body.wired).toBe(false);
    expect(calls).toBe(0);
    await request(app).get("/api/bugtasks").expect(501);   // nothing wired yet

    await integrations.write({ tracker: { preset: "jira", toolPrefix: "mcp__x", mcpServers: {} }, forge: { preset: "github" } });

    const after = await request(app).get("/api/setup").expect(200);
    expect(after.body.wired).toBe(true);
    await request(app).get("/api/bugtasks").expect(200);   // no longer 501
    expect(calls).toBe(1);

    // Still never a re-wire: a second GET must not build again.
    await request(app).get("/api/setup").expect(200);
    expect(calls).toBe(1);
  });

  // I1: `maybeWire()` on GET /api/setup was uncaught, and a previous finding in this wave made
  // `integrations.read()` throw `Conflict` (409) for a corrupt file. Production's `onConfigured`
  // re-reads the config, so an unwired server with a bad `integrations.json` answered 409 —
  // losing the very report (`config-file` in state "broken", naming the parse error, carrying
  // the fix-or-remove-config action) that this screen exists to show. Note the `onConfigured`:
  // the default harness passes none, so `maybeWire` was a no-op in every other corrupt-config
  // test and none of them could have caught this.
  it("GET /api/setup still reports a corrupt config when wiring throws on it", async () => {
    let integrationsRef!: IntegrationsStore;
    // Mirrors production (start.ts: `wireBugFix(await integrations.read())`): the read is what
    // throws, and it throws out of `onConfigured`, not out of `setupReport`.
    const onConfigured: AppDeps["onConfigured"] = async () => { await integrationsRef.read(); return null; };
    const { app, home, integrations } = await unwiredApp({ onConfigured });
    integrationsRef = integrations;
    await writeFile(path.join(home, "integrations.json"), "{ not json");

    const res = await request(app).get("/api/setup").expect(200);

    const cfg = res.body.checks.find((c: { id: string }) => c.id === "config-file");
    expect(cfg).toMatchObject({ state: "broken" });
    expect(cfg.fix).toEqual({ kind: "action", value: "fix-or-remove-config" });
    expect(res.body.wired).toBe(false);
    // The whole report survived, not just the error: Settings still has its checks list.
    expect(res.body.checks.map((c: { id: string }) => c.id)).toContain("tracker");
  });

  // Same reason, the two writing routes: a save must not 409 because the config that was on
  // disk *before* it was corrupt — the write itself replaces the corrupt base.
  it("PUT /api/integrations still answers when wiring throws on a previously-corrupt config", async () => {
    let integrationsRef!: IntegrationsStore;
    let reads = 0;
    const onConfigured: AppDeps["onConfigured"] = async () => {
      reads++;
      if (reads === 1) throw new Conflict("integrations.json is corrupt (unexpected token)");
      await integrationsRef.read(); return null;
    };
    const { app, integrations } = await unwiredApp({ onConfigured });
    integrationsRef = integrations;

    const saved = await request(app).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
    expect(saved.body.forge).toEqual({ preset: "github" });
    expect(reads).toBe(1);
  });
});

describe("the setup test buttons", () => {
  it("a tracker test with nothing configured answers ok:false, not 501", async () => {
    const { app } = await unwiredApp();
    const res = await request(app).post("/api/setup/test/tracker").expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/no tracker/i);
  });

  it("a forge test with nothing configured answers ok:false", async () => {
    const { app } = await unwiredApp();
    const res = await request(app).post("/api/setup/test/forge").expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/no forge/i);
  });

  it("a tracker test reports the provider's own error rather than a generic one", async () => {
    const { app } = await unwiredApp({ tracker: { listMyIssues: async () => { throw new Error("MCP server atlassian is not connected"); } } });
    const res = await request(app).post("/api/setup/test/tracker").expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/not connected/);
  });

  it("a passing tracker test names the issue count", async () => {
    const { app } = await unwiredApp({ tracker: { listMyIssues: async () => [{ key: "A-1" }, { key: "A-2" }] } });
    const res = await request(app).post("/api/setup/test/tracker").expect(200);
    expect(res.body).toEqual({ ok: true, message: "2 issues assigned to you." });
  });
});
