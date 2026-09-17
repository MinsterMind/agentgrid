import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/start.js";

describe("startServer", () => {
  it("boots in fake mode on a free port, serves the API, and closes cleanly", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-start-"));
    const running = await startServer({ home, port: 0, fake: true, log: () => {} });
    expect(running.port).toBeGreaterThan(0);
    const state = await (await fetch(`${running.url}/api/state`)).json();
    expect(state.roles.map((r: any) => r.name)).toContain("coder");
    expect(state.liveSessions.map((l: any) => l.sessionId)).toEqual(["fake-live-bg"]);
    await running.close();
    await expect(fetch(`${running.url}/api/state`)).rejects.toThrow();
  });
});
