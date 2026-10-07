import { describe, it, expect } from "vitest";
import { RunQueue } from "../../src/bugfix/queue.js";

describe("RunQueue", () => {
  it("starts up to the cap, then queues in order; a release starts the oldest waiting", () => {
    let cap = 2; const q = new RunQueue(() => cap);
    expect([q.tryStart("a"), q.tryStart("b"), q.tryStart("c"), q.tryStart("d")]).toEqual([true, true, false, false]);
    expect(q.tryStart("a")).toBe(true);                       // already running: still its slot
    expect(q.tryStart("c")).toBe(false); expect(q.waiting()).toEqual(["c", "d"]);   // no double-queueing
    expect(q.release("a")).toEqual(["c"]); expect(q.running()).toEqual(["b", "c"]);
    q.remove("d"); expect(q.waiting()).toEqual([]);
    expect(q.release("nope")).toEqual([]);
    cap = 1; q.tryStart("e");
    expect(q.release("b")).toEqual([]);                        // 1 running (c) = the new cap
    expect(q.release("c")).toEqual(["e"]);
  });
  it("raising the cap starts as many waiting as now fit", () => {
    let cap = 1; const q = new RunQueue(() => cap);
    q.tryStart("a"); q.tryStart("b"); q.tryStart("c");
    cap = 3; expect(q.drain()).toEqual(["b", "c"]);
  });
});
