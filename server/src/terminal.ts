import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { shellQuote } from "./shell.js";

const run = (cmd: string, args: string[]) => new Promise<void>((res, rej) => execFile(cmd, args, err => (err ? rej(err) : res())));

export function buildTerminalScript(repo: string, sessionId: string, hasITerm: boolean): string {
  const shell = `cd ${shellQuote(repo)} && claude --resume ${shellQuote(sessionId)}`;
  const esc = shell.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return hasITerm
    ? `tell application "iTerm"\nactivate\nset w to (create window with default profile)\ntell current session of w to write text "${esc}"\nend tell`
    : `tell application "Terminal"\nactivate\ndo script "${esc}"\nend tell`;
}

export async function openTerminal(repo: string, sessionId: string): Promise<void> {
  if (process.platform !== "darwin") throw Object.assign(new Error("open-terminal is macOS only"), { status: 501 });
  const hasITerm = await access("/Applications/iTerm.app").then(() => true, () => false);
  const script = buildTerminalScript(repo, sessionId, hasITerm);
  await run("osascript", ["-e", script]);
}
