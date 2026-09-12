import { describe, it, expect } from "vitest";
import type { Agent } from "../src/types.js";
describe("types", () => {
  it("compiles and vitest runs", () => {
    const a: Agent = { id: "coder@x", role: "coder", repo: "/x", displayName: "Cody",
      createdAt: new Date().toISOString(), state: "free", currentAssignmentId: null };
    expect(a.state).toBe("free");
  });
});
