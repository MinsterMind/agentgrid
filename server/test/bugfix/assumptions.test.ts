import { describe, it, expect } from "vitest";
import { parseAssumptions, ASSUMPTION_LIMITS } from "../../src/bugfix/assumptions.js";

const meta = { token: "abc123", stage: "analyzing" as const, round: 0, at: "2026-10-05T10:00:00.000Z" };

describe("parseAssumptions", () => {
  it("reads a valid list, tagging each item with stage, round, time and a stable id", () => {
    const r = parseAssumptions(JSON.stringify([
      { kind: "assumption", text: "Rounding happens only at checkout." },
      { kind: "question", text: "Round refunds up or down?" },
    ]), meta);
    expect(r.problem).toBeNull();
    expect(r.read).toBe(true);
    expect(r.items).toEqual([
      { id: "abc123:0", stage: "analyzing", round: 0, kind: "assumption", text: "Rounding happens only at checkout.", at: meta.at },
      { id: "abc123:1", stage: "analyzing", round: 0, kind: "question", text: "Round refunds up or down?", at: meta.at },
    ]);
  });

  it("an empty list is a clean read with nothing in it", () => {
    expect(parseAssumptions("[]", meta)).toEqual({ items: [], problem: null, read: true });
  });

  it("no file is not a problem, and not a read", () => {
    expect(parseAssumptions(null, meta)).toEqual({ items: [], problem: null, read: false });
  });

  // Review Focus 1: models routinely wrap a list in an object.
  it("accepts a list wrapped as { assumptions: [...] }", () => {
    const r = parseAssumptions(JSON.stringify({ assumptions: [{ kind: "assumption", text: "x" }] }), meta);
    expect(r.problem).toBeNull();
    expect(r.items.map(i => i.text)).toEqual(["x"]);
  });

  it("reports text that is not JSON, naming the stage, and keeps nothing", () => {
    const r = parseAssumptions("- I assumed things", meta);
    expect(r.items).toEqual([]);
    expect(r.problem).toMatch(/analyzing/);
    expect(r.problem).toMatch(/not valid JSON/i);
  });

  it("reports JSON that is not a list", () => {
    const r = parseAssumptions(JSON.stringify({ kind: "assumption", text: "x" }), meta);
    expect(r.items).toEqual([]);
    expect(r.problem).toMatch(/not a list/i);
  });

  it("rejects the whole file when an item has an unknown kind, naming the item", () => {
    const r = parseAssumptions(JSON.stringify([{ kind: "assumption", text: "ok" }, { kind: "guess", text: "x" }]), meta);
    expect(r.items).toEqual([]);
    expect(r.problem).toMatch(/item 2/);
  });

  it("rejects an item whose text is not a non-empty string", () => {
    expect(parseAssumptions(JSON.stringify([{ kind: "question", text: 4 }]), meta).problem).toMatch(/item 1/);
    expect(parseAssumptions(JSON.stringify([{ kind: "question", text: "   " }]), meta).problem).toMatch(/item 1/);
  });

  it("keeps the first 20 items and says what was cut", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ kind: "assumption", text: `a${i}` }));
    const r = parseAssumptions(JSON.stringify(many), meta);
    expect(r.items).toHaveLength(ASSUMPTION_LIMITS.items);
    expect(r.problem).toMatch(/21/);
  });

  it("cuts long text to 500 characters with an ellipsis and says so", () => {
    const r = parseAssumptions(JSON.stringify([{ kind: "assumption", text: "x".repeat(600) }]), meta);
    expect(r.items[0].text).toHaveLength(ASSUMPTION_LIMITS.chars);
    expect(r.items[0].text.endsWith("…")).toBe(true);
    expect(r.problem).toMatch(/shortened/i);
  });

  it("trims surrounding whitespace in text", () => {
    expect(parseAssumptions(JSON.stringify([{ kind: "assumption", text: "  x \n" }]), meta).items[0].text).toBe("x");
  });
});
