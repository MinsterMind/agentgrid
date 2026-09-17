import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { shellQuote } from "./shell.js";

const run = (cmd: string, args: string[]) => new Promise<void>((res, rej) => execFile(cmd, args, err => (err ? rej(err) : res())));

export const resumeCommand = (repo: string, sessionId: string) => `cd ${shellQuote(repo)} && claude --resume ${shellQuote(sessionId)}`;
export const attachCommand = (bgId: string) => `claude attach ${shellQuote(bgId)}`;

export function buildTerminalScript(repo: string, sessionId: string, hasITerm: boolean): string {
  return buildTerminalScriptFor(resumeCommand(repo, sessionId), hasITerm);
}

export function buildTerminalScriptFor(shell: string, hasITerm: boolean): string {
  const esc = shell.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return hasITerm
    ? `tell application "iTerm"\nactivate\nset w to (create window with default profile)\ntell current session of w to write text "${esc}"\nend tell`
    : `tell application "Terminal"\nactivate\ndo script "${esc}"\nend tell`;
}

export async function runInTerminal(shell: string): Promise<void> {
  if (process.platform !== "darwin") throw Object.assign(new Error("open-terminal is macOS only"), { status: 501 });
  const hasITerm = await access("/Applications/iTerm.app").then(() => true, () => false);
  await run("osascript", ["-e", buildTerminalScriptFor(shell, hasITerm)]);
}

export const openTerminal = (repo: string, sessionId: string) => runInTerminal(resumeCommand(repo, sessionId));
