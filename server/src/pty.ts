import * as nodePty from "node-pty";
import { stripForgeSecrets } from "./env.js";
import { shellQuote } from "./shell.js";

/** The shell command Claude Code runs for AgentGrid's permission hook. In the packaged app the
 *  executable is Electron, which only behaves as plain Node with ELECTRON_RUN_AS_NODE. */
export function hookCommand(execPath: string, hookFile: string, electron: boolean): string {
  return `${electron ? "ELECTRON_RUN_AS_NODE=1 " : ""}${shellQuote(execPath)} ${shellQuote(hookFile)}`;
}
/** The `--settings` JSON that installs the hook for one embedded session only — the user's own settings are untouched. */
export function hookSettings(command: string): string {
  return JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 86400 }] }] } });
}

/** The slice of node-pty's IPty we use — lets tests substitute a fake. */
export interface PtyLike {
  pid: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type SpawnFn = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => PtyLike;

export interface OpenOptions { cwd: string; argv: string[]; cols: number; rows: number }
export interface Handle { write(d: string): void; resize(c: number, r: number): void; detach(): void; kill(): void }

interface Entry { pty: PtyLike; viewer: { onData: (d: string) => void; onEnd: (reason: string) => void; sub: { dispose(): void } } | null; /** Recent output, replayed to a reconnecting viewer. */ tail: string }
const TAIL_MAX = 256 * 1024;
/** Long enough for Claude Code to finish reading the pasted text before Enter arrives. */
const SUBMIT_DELAY_MS = 300;

/**
 * The server may itself have been started from inside a Claude Code session; never leak
 * that context into the embedded one. Also strips forge credentials (see env.ts) — the
 * embedded Terminal is a real shell an agent can type into, so it must not see
 * BITBUCKET_API_TOKEN/GH_TOKEN/GITHUB_TOKEN either.
 */
export function cleanEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(stripForgeSecrets(base))) if (!/^CLAUDE/i.test(k)) env[k] = v;
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

const realSpawn: SpawnFn = (file, args, opts) => nodePty.spawn(file, args, opts);

/**
 * One interactive `claude` process per session id, viewed by at most one client at a time.
 * The process outlives a detached viewer (so a page reload reconnects) and dies on kill() or closeAll().
 */
export class PtyManager {
  private entries = new Map<string, Entry>();
  private hook: { settings: string; env: Record<string, string> } | null = null;
  private exitCbs: Array<(sessionId: string) => void> = [];
  constructor(private spawn: SpawnFn = realSpawn) {}

  /** From now on, `claude --resume` launches ask AgentGrid for permission through the hook (see permissions/).
   *  `claude attach` is left alone: attaching cannot change a running background session's hooks. */
  configureHook(h: { settings: string; env: Record<string, string> } | null): void { this.hook = h; }
  /** Called with the session id whenever a session's claude process ends. */
  onSessionExit(cb: (sessionId: string) => void): void { this.exitCbs.push(cb); }

  isOpen(sessionId: string): boolean { return this.entries.has(sessionId); }
  /** Pids of the claude processes this manager is running (so they can be told apart from foreign terminals). */
  pids(): Set<number> { return new Set([...this.entries.values()].map(e => e.pty.pid)); }

  attach(sessionId: string, opts: OpenOptions, onData: (d: string) => void, onEnd: (reason: string) => void): Handle {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      const hook = opts.argv[0] === "--resume" ? this.hook : null;
      const pty = this.spawn("claude", hook ? [...opts.argv, "--settings", hook.settings] : opts.argv,
        { name: "xterm-256color", cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: hook ? { ...cleanEnv(), ...hook.env, AGENTGRID_SESSION_ID: sessionId } : cleanEnv() });
      entry = { pty, viewer: null, tail: "" };
      this.entries.set(sessionId, entry);
      const e0 = entry;
      pty.onData(d => { e0.tail = (e0.tail + d).slice(-TAIL_MAX); });
      pty.onExit(({ exitCode }) => {
        this.entries.delete(sessionId);
        entry!.viewer?.onEnd(`claude exited (${exitCode})`);
        entry!.viewer = null;
        for (const cb of this.exitCbs) { try { cb(sessionId); } catch { /* a listener must not break the others */ } }
      });
    } else {
      entry.pty.resize(opts.cols, opts.rows);
      if (entry.viewer) { entry.viewer.sub.dispose(); entry.viewer.onEnd("taken over by another viewer"); }
    }
    const e = entry;
    const reconnect = e.tail.length > 0;
    e.viewer = { onData, onEnd, sub: e.pty.onData(onData) };
    if (reconnect) {
      // Replay what the previous viewer saw, then nudge the TUI to repaint at the new size.
      onData(e.tail);
      e.pty.resize(opts.cols, opts.rows);
    }
    const mine = e.viewer;
    return {
      write: d => e.pty.write(d),
      resize: (c, r) => e.pty.resize(c, r),
      detach: () => { if (e.viewer === mine) { mine.sub.dispose(); e.viewer = null; } },
      kill: () => { e.pty.kill(); },
    };
  }

  /**
   * Send a message to a running session's terminal (no viewer needed). Returns false if no pty is open for it.
   * Claude Code reads input that arrives in one chunk as a paste, and Enter inside a paste is a newline in the
   * draft — so the text goes first and Enter follows as its own keypress, or a long reply sits unsent.
   */
  submit(sessionId: string, text: string): boolean {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    e.pty.write(text);
    setTimeout(() => { if (this.entries.get(sessionId) === e) e.pty.write("\r"); }, SUBMIT_DELAY_MS);
    return true;
  }

  closeAll(): void { for (const e of this.entries.values()) e.pty.kill(); this.entries.clear(); }
}
