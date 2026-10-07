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

describe("buildOptions overrides (spec 2026-10-09 §6.2)", () => {
  it("applies per-run overrides over the role, and still resumes when asked", () => {
    const canUseTool = async () => ({ behavior: "allow" as const });
    const o = buildOptions(role, { ...agent, resumeSessionId: "s1" }, { canUseTool, abortController: new AbortController(),
      overrides: { model: "claude-sonnet-5-5", effort: "medium", maxTurns: 60, maxBudgetUsd: 2 } });
    expect(o).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", maxTurns: 60, maxBudgetUsd: 2, resume: "s1" });
    expect((o.agents as Record<string, { model?: string }>).reviewer.model).toBe("claude-sonnet-5-5");
  });
});

describe("buildOptions env", () => {
  it("strips forge credentials from the env handed to the agent process", () => {
    const ac = new AbortController(); const canUseTool = async () => ({ behavior: "allow" as const });
    const savedEnv = { ...process.env };
    process.env.BITBUCKET_API_TOKEN = "secret-bb";
    process.env.GH_TOKEN = "secret-gh";
    process.env.GITHUB_TOKEN = "secret-ghlegacy";
    process.env.HOME = process.env.HOME ?? "/home/x";
    try {
      const o = buildOptions(role, agent, { canUseTool, abortController: ac });
      expect(o.env).toBeDefined();
      expect(o.env).not.toHaveProperty("BITBUCKET_API_TOKEN");
      expect(o.env).not.toHaveProperty("GH_TOKEN");
      expect(o.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(o.env?.HOME).toBe(process.env.HOME);
    } finally {
      process.env = savedEnv;
    }
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
