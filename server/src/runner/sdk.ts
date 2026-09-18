import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { BuildOptions, QueryFn } from "./runner.js";

/**
 * The `claude` CLI on PATH, resolved through symlinks. Preferring it over the SDK's bundled
 * binary keeps agents on the same Claude Code build as the user's terminal, and is the only
 * option inside the packaged desktop app, where the platform-specific SDK binary isn't shipped.
 */
export function findClaudeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AGENTGRID_CLAUDE_PATH && existsSync(env.AGENTGRID_CLAUDE_PATH)) return env.AGENTGRID_CLAUDE_PATH;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "claude");
    if (existsSync(candidate)) { try { return realpathSync(candidate); } catch { return candidate; } }
  }
  return undefined;
}

export const realQuery: QueryFn = ({ prompt, options }) => {
  const exe = findClaudeExecutable();
  return query({ prompt, options: exe && !options.pathToClaudeCodeExecutable ? { ...options, pathToClaudeCodeExecutable: exe } : options });
};

export const buildOptions: BuildOptions = (role, agent, extra) => {
  const o: Options = {
    cwd: agent.repo,
    model: role.model,
    effort: role.effort,
    permissionMode: role.permissionMode,
    settingSources: role.settingSources,
    allowedTools: role.allowedTools,
    maxTurns: role.maxTurns,
    permissionPrompts: "host",
    agent: role.name,
    agents: { [role.name]: { description: `AgentGrid role ${role.name}`, prompt: role.prompt, model: role.model } },
    canUseTool: extra.canUseTool,
    abortController: extra.abortController,
  };
  if (role.maxBudgetUsd !== undefined) o.maxBudgetUsd = role.maxBudgetUsd;
  if (agent.resumeSessionId) o.resume = agent.resumeSessionId;
  return o;
};
