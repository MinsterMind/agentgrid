import { describe, it, expect } from "vitest";
import { buildTerminalScript } from "../src/terminal.js";

describe("buildTerminalScript", () => {
  const repo = "/tmp/it's here";
  const sessionId = "abc";
  const expectedCmd = "cd '/tmp/it'\\\\''s here' && claude --resume 'abc'";

  it("builds the iTerm script with the command escaped for AppleScript", () => {
    const script = buildTerminalScript(repo, sessionId, true);
    expect(script).toContain('tell application "iTerm"');
    expect(script).toContain(expectedCmd);
    expect(script).toContain(`write text "${expectedCmd}"`);
  });

  it("builds the Terminal.app script with the command escaped for AppleScript", () => {
    const script = buildTerminalScript(repo, sessionId, false);
    expect(script).toContain('tell application "Terminal"');
    expect(script).toContain(expectedCmd);
    expect(script).toContain(`do script "${expectedCmd}"`);
  });
});
