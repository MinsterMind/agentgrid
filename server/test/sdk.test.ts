import { describe, it, expect } from "vitest";
import { buildOptions } from "../src/runner/sdk.js";
import type { RoleDef, Agent } from "../src/types.js";

const role: RoleDef = { name: "reviewer", avatar: "x", model: "claude-opus-5", effort: "high", permissionMode: "default",
  settingSources: ["user"], allowedTools: ["Read"], maxTurns: 40, maxBudgetUsd: 3, prompt: "You review." };
const agent: Agent = { id: "reviewer@r", role: "reviewer", repo: "/r", displayName: "R", createdAt: "", state: "free", currentAssignmentId: null };

describe("buildOptions", () => {
  it("maps role + agent to SDK options", () => {
    const ac = new AbortController(); const canUseTool = async () => ({ behavior: "allow" as const });
    const o = buildOptions(role, agent, { canUseTool, abortController: ac });
    expect(o).toMatchObject({
      cwd: "/r", model: "claude-opus-5", effort: "high", permissionMode: "default", settingSources: ["user"],
      allowedTools: ["Read"], maxTurns: 40, maxBudgetUsd: 3, permissionPrompts: "host", agent: "reviewer",
      agents: { reviewer: { description: "AgentGrid role reviewer", prompt: "You review.", model: "claude-opus-5" } },
    });
    expect(o.abortController).toBe(ac);
    expect(o.canUseTool).toBe(canUseTool);
  });
});
