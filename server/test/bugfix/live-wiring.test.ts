import { describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../src/start.js";

describe("first-time setup takes effect without a restart", () => {
  /**
   * I7: this used to boot with `fake: true`, which hands `wireBugFix` a `fakeTracker`
   * unconditionally (start.ts:167), so the engine was always wired at boot and
   * `before.body.wired` was always true — the transition and the "no longer 501" check sat
   * behind an `if (!before.body.wired)` that never ran. Boot for real against an empty home
   * instead: with no `tracker` in the config, `wireBugFix` returns null (start.ts:168) and the
   * server genuinely starts unwired, so the transition is actually exercised. There is no `if`
   * here on purpose — every assertion must run.
   *
   * Nothing here reaches the network: a tracker-only save leaves `makeForge(undefined)` null
   * (forge/index.ts:20), so no forge adapter is built and no `PrWatcher` is started, and
   * `mcpTracker` only spawns on the first tracker call, which this test never makes.
   */
  it("wires the engine when configuration first appears, and does not rebuild it afterwards", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-wire-"));
    const running = await startServer({ home, port: 0, fake: false });
    try {
      const before = await request(running.url).get("/api/setup").expect(200);
      expect(before.body.wired).toBe(false);
      expect(running.bugEngineForTest?.()).toBeUndefined();
      await request(running.url).get("/api/bugtasks").expect(501);   // nothing wired yet

      await request(running.url).put("/api/integrations")
        .send({ tracker: { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: {} } }).expect(200);

      const after = await request(running.url).get("/api/setup").expect(200);
      expect(after.body.wired).toBe(true);
      await request(running.url).get("/api/bugtasks").expect(200);   // no longer 501

      // A second save must not rebuild: the engine object stays identical.
      const first = running.bugEngineForTest?.();
      expect(first).toBeDefined();
      await request(running.url).put("/api/integrations")
        .send({ tracker: { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: {} } }).expect(200);
      expect(running.bugEngineForTest?.()).toBe(first);
    } finally { await running.close(); }
  });
});
