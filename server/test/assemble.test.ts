import { describe, it, expect } from "vitest";
import { assemblePrompt } from "../src/prompt/assemble.js";

describe("assemblePrompt", () => {
  it("matches the spec §8.1 format with an index", () => {
    const out = assemblePrompt({ memoryDir: "/home/u/.agentgrid/agents/reviewer@hrns/memory",
      index: "- [Staging ns](staging-namespace.md) — namespace is hrns-stg\n", task: "Review PR #12" });
    expect(out).toMatchSnapshot();
    expect(out).toContain('<agent-memory dir="/home/u/.agentgrid/agents/reviewer@hrns/memory">');
    expect(out).toContain("<task>\nReview PR #12\n</task>");
  });
  it('uses "empty" when there is no index', () => {
    const out = assemblePrompt({ memoryDir: "/m", index: "   ", task: "t" });
    expect(out).toContain("<index>\nempty\n</index>");
  });
});
