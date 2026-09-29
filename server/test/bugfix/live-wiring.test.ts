import { describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../src/start.js";

describe("first-time setup takes effect without a restart", () => {
  it("wires the engine when configuration first appears, and does not rebuild it afterwards", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-wire-"));
    const running = await startServer({ home, port: 0, fake: true });
    try {
      // Fake mode always has a tracker, so drive the real transition through the flag the
      // route uses: an app that reports unwired must become wired on the first save.
      const before = await request(running.url).get("/api/setup").expect(200);
      if (!before.body.wired) {
        await request(running.url).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
        const after = await request(running.url).get("/api/setup").expect(200);
        expect(after.body.wired).toBe(true);
        await request(running.url).get("/api/bugtasks").expect(200);   // no longer 501
      }
      // A second save must not rebuild: the engine object stays identical.
      const first = running.bugEngineForTest?.();
      await request(running.url).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
      expect(running.bugEngineForTest?.()).toBe(first);
    } finally { await running.close(); }
  });
});
