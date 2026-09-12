import { describe, it, expect } from "vitest";
import { shellQuote } from "../src/shell.js";

describe("shellQuote", () => {
  it("quotes a plain string", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("neutralises $ and backticks", () => {
    expect(shellQuote("$(rm -rf /) `whoami`")).toBe("'$(rm -rf /) `whoami`'");
  });
});
