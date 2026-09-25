import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../../src/start.js";

describe("startServer with the bug-fix workflow", () => {
  it("exposes the bug routes in fake mode and seeds the bugfix role", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-bug-"));
    const running = await startServer({ home, port: 0, fake: true, log: () => {} });
    try {
      const state = await (await fetch(`${running.url}/api/state`)).json();
      expect(state.roles.map((r: { name: string }) => r.name)).toContain("bugfix");
      expect(state.bugTasks).toEqual([]);
      const issues = await (await fetch(`${running.url}/api/bugfix/issues`)).json();
      expect(issues[0]).toMatchObject({ key: "FAKE-1" });                 // fake tracker
      const pre = await (await fetch(`${running.url}/api/bugfix/preflight?repo=${encodeURIComponent(home)}`)).json();
      expect(pre).toHaveProperty("ok");
    } finally { await running.close(); }
  });
});
