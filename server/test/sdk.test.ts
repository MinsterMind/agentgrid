import { describe, it, expect } from "vitest";
import { buildOptions, findClaudeExecutable } from "../src/runner/sdk.js";
import { mkdtemp, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

describe("buildOptions resume", () => {
  it("adds resume for adopted sessions only", () => {
    const extra = { canUseTool: async () => ({ behavior: "allow" as const }), abortController: new AbortController() };
    expect(buildOptions(role, agent, extra).resume).toBeUndefined();
    expect(buildOptions(role, { ...agent, resumeSessionId: "sess-42" }, extra).resume).toBe("sess-42");
  });
});

describe("findClaudeExecutable", () => {
  it("resolves `claude` on PATH through symlinks; env override wins; undefined when absent", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "bin-")));
    await writeFile(path.join(dir, "claude-real"), "#!/bin/sh\n", { mode: 0o755 });
    await symlink(path.join(dir, "claude-real"), path.join(dir, "claude"));
    expect(findClaudeExecutable({ PATH: `/nonexistent:${dir}` })).toBe(path.join(dir, "claude-real"));
    expect(findClaudeExecutable({ PATH: dir, AGENTGRID_CLAUDE_PATH: path.join(dir, "claude-real") })).toBe(path.join(dir, "claude-real"));
    expect(findClaudeExecutable({ PATH: "/nonexistent" })).toBeUndefined();
  });
});
