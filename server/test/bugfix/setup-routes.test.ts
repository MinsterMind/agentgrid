import { describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp, type AppDeps } from "../../src/api/app.js";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/runner/manager.js";
import { IntegrationsStore } from "../../src/bugfix/integrations.js";

/**
 * An app with NO bug-fix engine — the case the old API could not express. `agentgrid-setup-`
 * (the `~/.agentgrid` home) and `claudeHome` (the `~/.claude` home `discoverMcpServers` scans)
 * are deliberately separate temp directories: conflating them would hide a wiring bug where
 * the wrong one leaks into the other's slot. Both are fresh per call, so this suite never reads
 * or depends on the real machine's `~/.claude` or `~/.agentgrid`.
 */
async function unwiredApp(extra?: { onConfigured?: AppDeps["onConfigured"]; tracker?: { listMyIssues: () => Promise<unknown[]> }; forge?: { authStatus: () => Promise<{ ok: boolean; message: string }> } } | undefined) {
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

  // The delay is essential: without it both requests would resolve too close together to
  // reliably race, and this test would pass even against a `maybeWire` with no memoisation.
  it("builds the bug-fix subsystem once when two saves overlap", async () => {
    let calls = 0;
    const onConfigured: AppDeps["onConfigured"] = async () => {
      calls++;
      await new Promise(r => setTimeout(r, 5));
      return null; // no real engine needed — only call count matters here
    };
    const { app } = await unwiredApp({ onConfigured });
    await Promise.all([
      request(app).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200),
      request(app).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200),
    ]);
    expect(calls).toBe(1);
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
