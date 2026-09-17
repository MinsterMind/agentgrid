import { describe, it, expect } from "vitest";
import { sectionize, visualOrder } from "../src/state/sections";
import type { Agent } from "../src/types";

const ag = (id: string, state: Agent["state"], createdAt: string): Agent => ({ id, role: "coder", repo: "/r", displayName: id, createdAt, state, currentAssignmentId: null });

describe("sectionize", () => {
  it("groups by attention, keeps creation order inside, drops empty sections", () => {
    const agents = [ag("a", "free", "1"), ag("b", "waiting", "2"), ag("c", "done", "3"), ag("d", "working", "4"), ag("e", "waiting", "5"), ag("f", "failed", "6")];
    const s = sectionize(agents);
    expect(s.map(x => [x.title, x.agents.map(a => a.id)])).toEqual([
      ["Needs you", ["b", "e"]], ["Working", ["d"]], ["Done · Failed", ["c", "f"]], ["Free", ["a"]],
    ]);
    expect(visualOrder(agents).map(a => a.id)).toEqual(["b", "e", "d", "c", "f", "a"]);
    expect(sectionize([])).toEqual([]);
  });
});
