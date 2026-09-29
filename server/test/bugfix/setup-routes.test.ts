import { describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../src/api/app.js";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/runner/manager.js";
import { IntegrationsStore } from "../../src/bugfix/integrations.js";

/** An app with NO bug-fix engine — the case the old API could not express. */
async function unwiredApp() {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-setup-"));
  const store = new Store(home, path.resolve("roles"));
  await store.init();
  const integrations = new IntegrationsStore(home);
  const app = createApp({ store, manager: new Manager({ store } as never), integrations, roleResolves: () => true });
  return { app, home, integrations };
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
});
