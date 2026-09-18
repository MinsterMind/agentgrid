import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PtyManager, cleanEnv, type PtyLike, type SpawnFn } from "../src/pty.js";

/** Fake pty: records writes/resizes, lets tests emit output and exit. */
class FakePty extends EventEmitter implements PtyLike {
  writes: string[] = []; sizes: Array<[number, number]> = []; killed = false; pid = 4242;
  onData(cb: (d: string) => void) { this.on("data", cb); return { dispose: () => this.off("data", cb) }; }
  onExit(cb: (e: { exitCode: number }) => void) { this.on("exit", cb); return { dispose: () => this.off("exit", cb) }; }
  write(d: string) { this.writes.push(d); }
  resize(c: number, r: number) { this.sizes.push([c, r]); }
  kill() { this.killed = true; this.emit("exit", { exitCode: 0 }); }
}

const setup = () => {
  const spawned: Array<{ file: string; args: string[]; opts: any; pty: FakePty }> = [];
  const spawn: SpawnFn = (file, args, opts) => { const pty = new FakePty(); spawned.push({ file, args, opts, pty }); return pty; };
  return { spawned, mgr: new PtyManager(spawn) };
};

describe("PtyManager", () => {
  it("spawns claude --resume in the repo with the requested size and streams output", () => {
    const { spawned, mgr } = setup();
    const out: string[] = [];
    const h = mgr.attach("sess-1", { cwd: "/repo", argv: ["--resume", "sess-1"], cols: 120, rows: 40 }, d => out.push(d), () => {});
    expect(spawned).toHaveLength(1);
    expect(spawned[0].file).toBe("claude");
    expect(spawned[0].args).toEqual(["--resume", "sess-1"]);
    expect(spawned[0].opts).toMatchObject({ cwd: "/repo", cols: 120, rows: 40, name: "xterm-256color" });
    spawned[0].pty.emit("data", "hello");
    expect(out).toEqual(["hello"]);
    h.write("ls\r"); h.resize(80, 24);
    expect(spawned[0].pty.writes).toEqual(["ls\r"]);
    expect(spawned[0].pty.sizes).toEqual([[80, 24]]);
  });

  it("reuses one pty per session; a second viewer takes over output and the first is detached", () => {
    const { spawned, mgr } = setup();
    const a: string[] = [], b: string[] = [];
    const onDetachA = vi.fn();
    mgr.attach("s", { cwd: "/r", argv: [], cols: 80, rows: 24 }, d => a.push(d), onDetachA);
    mgr.attach("s", { cwd: "/r", argv: [], cols: 80, rows: 24 }, d => b.push(d), () => {});
    expect(spawned).toHaveLength(1);
    expect(onDetachA).toHaveBeenCalledWith("taken over by another viewer");
    spawned[0].pty.emit("data", "x");
    expect(a).toEqual([]); expect(b).toEqual(["x"]);
  });

  it("detach without kill keeps the pty; kill ends it and notifies; exit notifies the viewer", () => {
    const { spawned, mgr } = setup();
    const onExit = vi.fn();
    const h = mgr.attach("s", { cwd: "/r", argv: [], cols: 80, rows: 24 }, () => {}, onExit);
    h.detach();
    expect(spawned[0].pty.killed).toBe(false);
    expect(mgr.isOpen("s")).toBe(true);
    const h2 = mgr.attach("s", { cwd: "/r", argv: [], cols: 80, rows: 24 }, () => {}, onExit);
    h2.kill();
    expect(spawned[0].pty.killed).toBe(true);
    expect(mgr.isOpen("s")).toBe(false);
    expect(onExit).toHaveBeenCalledWith(expect.stringMatching(/exited/));
  });

  it("replays recent output to a reconnecting viewer", () => {
    const { spawned, mgr } = setup();
    const first: string[] = [], second: string[] = [];
    const h = mgr.attach("s", { cwd: "/r", argv: [], cols: 80, rows: 24 }, d => first.push(d), () => {});
    spawned[0].pty.emit("data", "screen-1"); spawned[0].pty.emit("data", " more");
    h.detach();
    mgr.attach("s", { cwd: "/r", argv: [], cols: 100, rows: 30 }, d => second.push(d), () => {});
    expect(first).toEqual(["screen-1", " more"]);
    expect(second).toEqual(["screen-1 more"]);            // replayed tail
    expect(spawned[0].pty.sizes.at(-1)).toEqual([100, 30]); // repaint nudge
  });
  it("closeAll kills every pty", () => {
    const { spawned, mgr } = setup();
    mgr.attach("a", { cwd: "/r", argv: [], cols: 80, rows: 24 }, () => {}, () => {});
    mgr.attach("b", { cwd: "/r", argv: [], cols: 80, rows: 24 }, () => {}, () => {});
    mgr.closeAll();
    expect(spawned.every(s => s.pty.killed)).toBe(true);
  });
});

describe("cleanEnv", () => {
  it("drops Claude Code session markers and forces a colour terminal", () => {
    const env = cleanEnv({ PATH: "/bin", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: "1", CLAUDE_EFFORT: "low", CLAUDE_CODE_BRIDGE_SESSION_ID: "x", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", TERM: "xterm-256color", COLORTERM: "truecolor" });
  });
});
