import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeProjectDir, transcriptPath, readTranscript } from "../src/transcript.js";

describe("transcript", () => {
  it("encodes cwd like Claude Code", () => {
    expect(encodeProjectDir("/Users/m/MinsterMind/hrns")).toBe("-Users-m-MinsterMind-hrns");
    expect(encodeProjectDir("/a/b.c_d e")).toBe("-a-b-c-d-e");
  });
  it("builds the path under claude home", () => {
    expect(transcriptPath("/x/y", "s1", "/home/u/.claude")).toBe("/home/u/.claude/projects/-x-y/s1.jsonl");
  });
  it("parses text, tool_use and tool_result lines and ignores others", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ch-"));
    const dir = path.join(home, "projects", "-x-y"); await mkdir(dir, { recursive: true });
    const lines = [
      { type: "user", timestamp: "t1", message: { role: "user", content: "do it" } },
      { type: "assistant", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", timestamp: "t3", message: { role: "user", content: [{ type: "tool_result", content: "a.txt" }] } },
      { type: "summary", summary: "x" },
    ].map(l => JSON.stringify(l)).join("\n");
    await writeFile(path.join(dir, "s1.jsonl"), lines);
    expect(await readTranscript("/x/y", "s1", home)).toEqual([
      { ts: "t1", role: "user", kind: "text", text: "do it" },
      { ts: "t2", role: "assistant", kind: "text", text: "ok" },
      { ts: "t2", role: "assistant", kind: "tool_use", text: "Bash: ls" },
      { ts: "t3", role: "user", kind: "tool_result", text: "a.txt" },
    ]);
  });
  it("returns [] when the file is missing", async () => {
    expect(await readTranscript("/nope", "s", "/nope")).toEqual([]);
  });
});
