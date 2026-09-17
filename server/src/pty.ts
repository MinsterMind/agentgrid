import * as nodePty from "node-pty";

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

interface Entry { pty: PtyLike; viewer: { onData: (d: string) => void; onEnd: (reason: string) => void; sub: { dispose(): void } } | null }

/** The server may itself have been started from inside a Claude Code session; never leak that context into the embedded one. */
export function cleanEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!/^(CLAUDE_CODE_|CLAUDECODE)/.test(k)) env[k] = v;
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

const realSpawn: SpawnFn = (file, args, opts) => nodePty.spawn(file, args, opts);

/**
 * One interactive `claude` process per session id, viewed by at most one client at a time.
 * The process outlives a detached viewer (so a page reload reconnects) and dies on kill() or closeAll().
 */
export class PtyManager {
  private entries = new Map<string, Entry>();
  constructor(private spawn: SpawnFn = realSpawn) {}

  isOpen(sessionId: string): boolean { return this.entries.has(sessionId); }

  attach(sessionId: string, opts: OpenOptions, onData: (d: string) => void, onEnd: (reason: string) => void): Handle {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      const pty = this.spawn("claude", opts.argv, { name: "xterm-256color", cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: cleanEnv() });
      entry = { pty, viewer: null };
      this.entries.set(sessionId, entry);
      pty.onExit(({ exitCode }) => {
        this.entries.delete(sessionId);
        entry!.viewer?.onEnd(`claude exited (${exitCode})`);
        entry!.viewer = null;
      });
    } else {
      entry.pty.resize(opts.cols, opts.rows);
      if (entry.viewer) { entry.viewer.sub.dispose(); entry.viewer.onEnd("taken over by another viewer"); }
    }
    const e = entry;
    e.viewer = { onData, onEnd, sub: e.pty.onData(onData) };
    const mine = e.viewer;
    return {
      write: d => e.pty.write(d),
      resize: (c, r) => e.pty.resize(c, r),
      detach: () => { if (e.viewer === mine) { mine.sub.dispose(); e.viewer = null; } },
      kill: () => { e.pty.kill(); },
    };
  }

  closeAll(): void { for (const e of this.entries.values()) e.pty.kill(); this.entries.clear(); }
}
