import { execFile } from "node:child_process";

const escAS = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** AppleScript that shows the native folder chooser (front-most) and prints the POSIX path. */
export function buildPickerScript(startDir: string): string {
  return [
    `tell application "System Events"`,
    `activate`,
    `set f to choose folder with prompt "AgentGrid: pick a repo" default location POSIX file "${escAS(startDir)}"`,
    `end tell`,
    `POSIX path of f`,
  ].join("\n");
}

export interface ExecResult { stdout: string; stderr: string; code: number }

/** Chosen path, or null when the user cancelled. */
export function parsePickerOutput(r: ExecResult): string | null {
  if (r.code === 0) return r.stdout.trim().replace(/\/+$/, "") || null;
  if (/-128\b|User cancell?ed/i.test(r.stderr)) return null;
  throw new Error(r.stderr.trim() || `osascript exited ${r.code}`);
}

export async function pickFolder(startDir: string): Promise<string | null> {
  if (process.platform !== "darwin") throw Object.assign(new Error("native folder picker is macOS only"), { status: 501 });
  const r = await new Promise<ExecResult>(res =>
    execFile("osascript", ["-e", buildPickerScript(startDir)], (err, stdout, stderr) =>
      res({ stdout: String(stdout), stderr: String(stderr), code: err ? ((err as any).code ?? 1) : 0 })));
  return parsePickerOutput(r);
}
