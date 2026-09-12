import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { BuildOptions, QueryFn } from "./runner.js";

export const realQuery: QueryFn = ({ prompt, options }) => query({ prompt, options });

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
  return o;
};
