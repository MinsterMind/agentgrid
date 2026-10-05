import { describe, it, expect } from "vitest";
import { sectionize, visualOrder } from "../src/state/sections";
import type { Agent } from "../src/types";

const ag = (id: string, state: Agent["state"], createdAt: string): Agent => ({ id, role: "coder", repo: "/r", displayName: id, createdAt, state, currentAssignmentId: null });

describe("sectionize", () => {
  it("groups by attention, keeps creation order inside, drops empty sections", () => {
    const agents = [ag("a", "free", "1"), ag("b", "waiting", "2"), ag("c", "done", "3"), ag("d", "working", "4"), ag("e", "waiting", "5"), ag("f", "failed", "6")];
    const s = sectionize(agents);
    expect(s.map(x => [x.title, x.agents.map(a => a.id)])).toEqual([
      ["Needs you", ["b", "e"]], ["Working", ["d"]], ["Done / Failed", ["c", "f"]], ["Idle", ["a"]],
    ]);
    expect(visualOrder(agents).map(a => a.id)).toEqual(["b", "e", "d", "c", "f", "a"]);
    expect(sectionize([])).toEqual([]);
  });
  it("explains every section in one plain line", () => {
    const s = sectionize([ag("a", "free", "1"), ag("b", "waiting", "2"), ag("c", "done", "3"), ag("d", "working", "4")]);
    expect(Object.fromEntries(s.map(x => [x.key, x.hint]))).toEqual({
      waiting: "Agents waiting for your answer before they can continue.",
      working: "Running now. You don't need to watch them.",
      finished: "Finished. Read the outcome, then assign more work or dismiss.",
      free: "Ready for a new task.",
    });
  });
});
