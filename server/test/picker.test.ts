import { describe, it, expect } from "vitest";
import { buildPickerScript, parsePickerOutput } from "../src/picker.js";

describe("picker", () => {
  it("builds a choose-folder script that activates and starts at the root", () => {
    const s = buildPickerScript('/Users/u/it"s here');
    expect(s).toContain("activate");
    expect(s).toContain("choose folder");
    expect(s).toContain('default location POSIX file "/Users/u/it\\"s here"');
    expect(s).toContain("POSIX path of");
  });
  it("parses a chosen path (trailing newline/slash trimmed) and detects cancel", () => {
    expect(parsePickerOutput({ stdout: "/Users/u/proj/\n", stderr: "", code: 0 })).toBe("/Users/u/proj");
    expect(parsePickerOutput({ stdout: "", stderr: "execution error: User cancelled. (-128)", code: 1 })).toBeNull();
  });
  it("throws on other failures", () => {
    expect(() => parsePickerOutput({ stdout: "", stderr: "boom", code: 1 })).toThrow(/boom/);
  });
});
