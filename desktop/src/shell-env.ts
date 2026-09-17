import { execFileSync } from "node:child_process";

/**
 * Apps launched from Finder/Dock get a minimal environment — no nvm PATH, no `claude`,
 * none of the user's exported tokens. Ask the login shell for its environment once and
 * adopt it (VS Code does the same). Claude Code session markers are never carried over.
 */
export function loginShellEnv(shell = process.env.SHELL || "/bin/zsh"): Record<string, string> {
  const marker = "__AGENTGRID_ENV__";
  let out = "";
  try {
    out = execFileSync(shell, ["-ilc", `echo ${marker}; env; echo ${marker}`], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return {};
  }
  const parts = out.split(marker);
  if (parts.length < 3) return {};
  const env: Record<string, string> = {};
  for (const line of parts[1].split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i);
    if (/^CLAUDE/i.test(k) || k === "_" || k === "SHLVL" || k === "PWD" || k === "OLDPWD") continue;
    env[k] = line.slice(i + 1);
  }
  return env;
}

export function applyLoginShellEnv(): void {
  if (process.env.AGENTGRID_SKIP_SHELL_ENV) return;
  Object.assign(process.env, loginShellEnv());
  for (const k of Object.keys(process.env)) if (/^CLAUDE/i.test(k)) delete process.env[k];
}
