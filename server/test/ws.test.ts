import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { Store } from "../src/store/store.js";
import { PtyManager, type PtyLike, type SpawnFn } from "../src/pty.js";
import { attachPtyWebSocket, resolveLaunch } from "../src/api/ws.js";
import type { SessionInfo } from "../src/types.js";

class FakePty extends EventEmitter implements PtyLike {
  writes: string[] = []; sizes: Array<[number, number]> = []; pid = 1;
  onData(cb: (d: string) => void) { this.on("data", cb); return { dispose: () => this.off("data", cb) }; }
  onExit(cb: (e: { exitCode: number }) => void) { this.on("exit", cb); return { dispose: () => this.off("exit", cb) }; }
  write(d: string) { this.writes.push(d); } resize(c: number, r: number) { this.sizes.push([c, r]); } kill() { this.emit("exit", { exitCode: 0 }); }
}

let store: Store; let server: http.Server; let port: number; let spawned: Array<{ args: string[]; opts: any; pty: FakePty }>;
const sessions: SessionInfo[] = [
  { sessionId: "s-hist", cwd: "/w/past", title: "past", kind: "history", status: "ended", at: 1, canAdopt: true },
  { sessionId: "s-bg", cwd: "/w/bg", title: "bg", kind: "background", status: "blocked", at: 1, bgId: "d85e", canAdopt: false },
  { sessionId: "s-term", cwd: "/w/t", title: "term", kind: "interactive", status: "idle", at: 1, canAdopt: false },
];
const deps = () => ({ store, ptys: new PtyManager(((_f, args, opts) => { const pty = new FakePty(); spawned.push({ args, opts, pty }); return pty; }) as SpawnFn), sessions: async () => sessions });

beforeEach(async () => {
  store = new Store(await mkdtemp(path.join(tmpdir(), "ag-")), path.resolve("roles")); await store.init();
  spawned = [];
  server = http.createServer((_req, res) => res.end("ok"));
  attachPtyWebSocket(server, deps());
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;
});
afterEach(() => new Promise<void>(r => server.close(() => r())));

const connect = (sid: string, q = "cols=100&rows=30") => new Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }>((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pty/${sid}?${q}`);
  const closed = new Promise<{ code: number; reason: string }>(r => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })));
  ws.once("open", () => res({ ws, closed })); ws.once("error", rej);
});
const tick = () => new Promise(r => setTimeout(r, 30));

describe("resolveLaunch", () => {
  it("history → resume in its cwd; background → attach; interactive → refused", async () => {
    const d = deps();
    expect(await resolveLaunch("s-hist", d)).toEqual({ cwd: "/w/past", argv: ["--resume", "s-hist"] });
    expect(await resolveLaunch("s-bg", d)).toEqual({ cwd: "/w/bg", argv: ["attach", "d85e"] });
    expect(await resolveLaunch("s-term", d)).toMatchObject({ code: 4409 });
    expect(await resolveLaunch("nope", d)).toMatchObject({ code: 4404 });
  });
  it("grid agents: a session from a finished assignment resumes in the agent's repo", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/repo" });
    const asg = await store.createAssignment({ agentId: a.id, prompt: "p" });
    await store.updateAssignment(asg.id, { sessionId: "s-done", state: "done" });
    expect(await resolveLaunch("s-done", deps())).toEqual({ cwd: "/repo", argv: ["--resume", "s-done"] });
  });
  it("adopted live sessions: background → attach in the agent's repo; interactive → refused", async () => {
    await store.createAgent({ role: "coder", repo: "/repo", resumeSessionId: "s-bg" });
    await store.createAgent({ role: "coder", repo: "/repo2", resumeSessionId: "s-term" });
    store.setLiveSessions([{ sessionId: "s-bg", cwd: "/w/bg", name: "bg", kind: "background", status: "blocked", startedAt: 1, bgId: "d85e" }, { sessionId: "s-term", cwd: "/w/t", name: "t", kind: "interactive", status: "idle", startedAt: 1 }]);
    expect(await resolveLaunch("s-bg", deps())).toEqual({ cwd: "/repo", argv: ["attach", "d85e"] });
    expect(await resolveLaunch("s-term", deps())).toMatchObject({ code: 4409 });
  });
  it("adopted session whose live process is our own pty is reconnectable (not 'open elsewhere')", async () => {
    await store.createAgent({ role: "coder", repo: "/repo", resumeSessionId: "s-ours" });
    store.gridPids = () => new Set([100]);
    store.setLiveSessions([{ sessionId: "s-ours", cwd: "/repo", name: "x", kind: "interactive", status: "idle", startedAt: 1, pid: 100 }]);
    expect(await resolveLaunch("s-ours", deps())).toEqual({ cwd: "/repo", argv: ["--resume", "s-ours"] });
  });
  it("grid agents: idle adopted → resume in repo; working → refused", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/repo", resumeSessionId: "s-adopt" });
    expect(await resolveLaunch("s-adopt", deps())).toEqual({ cwd: "/repo", argv: ["--resume", "s-adopt"] });
    await store.updateAgent(a.id, { state: "working" });
    expect(await resolveLaunch("s-adopt", deps())).toMatchObject({ code: 4409 });
  });
});

describe("pty websocket", () => {
  it("streams pty output as binary, forwards input, resizes, and detaches on close", async () => {
    const { ws } = await connect("s-hist");
    await tick();
    expect(spawned[0].args).toEqual(["--resume", "s-hist"]);
    expect(spawned[0].opts).toMatchObject({ cwd: "/w/past", cols: 100, rows: 30 });
    const got = new Promise<string>(r => ws.once("message", d => r(d.toString())));
    spawned[0].pty.emit("data", "\x1b[32mhi\x1b[0m");
    expect(await got).toBe("\x1b[32mhi\x1b[0m");
    ws.send(Buffer.from("ls\r"), { binary: true });
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await tick();
    expect(spawned[0].pty.writes).toEqual(["ls\r"]);
    expect(spawned[0].pty.sizes).toEqual([[120, 40]]);
    ws.close(); await tick();
    expect(spawned[0].pty.listenerCount("data")).toBe(0); // detached, not killed
  });
  it("closes with the launch error code when refused", async () => {
    const { closed } = await connect("s-term");
    expect(await closed).toMatchObject({ code: 4409 });
  });
  it("pty exit closes the socket", async () => {
    const { closed } = await connect("s-hist");
    await tick(); spawned[0].pty.kill();
    expect((await closed).reason).toMatch(/exited/);
  });
});
