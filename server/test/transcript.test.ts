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
      { type: "assistant", timestamp: "t4", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "eod-journal" } }] } },
      { type: "summary", summary: "x" },
    ].map(l => JSON.stringify(l)).join("\n");
    await writeFile(path.join(dir, "s1.jsonl"), lines);
    expect(await readTranscript("/x/y", "s1", home)).toEqual([
      { ts: "t1", role: "user", kind: "text", text: "do it" },
      { ts: "t2", role: "assistant", kind: "text", text: "ok" },
      { ts: "t2", role: "assistant", kind: "tool_use", text: "Bash: ls" },
      { ts: "t3", role: "user", kind: "tool_result", text: "a.txt" },
      { ts: "t4", role: "assistant", kind: "tool_use", text: "Skill: eod-journal" },
    ]);
  });
  it("returns [] when the file is missing", async () => {
    expect(await readTranscript("/nope", "s", "/nope")).toEqual([]);
  });
});

describe("readTranscript full mode", () => {
  it("returns everything untruncated with tool name/input, and honours the string claudeHome form", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ch-"));
    const dir = path.join(home, "projects", "-x-y"); await mkdir(dir, { recursive: true });
    const big = "y".repeat(700);
    const lines = [
      ...Array.from({ length: 250 }, (_, i) => ({ type: "user", timestamp: `t${i}`, message: { role: "user", content: `m${i}` } })),
      { type: "assistant", timestamp: "tt", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "x".repeat(300) } }] } },
      { type: "user", timestamp: "tr", message: { role: "user", content: [{ type: "tool_result", content: big }] } },
    ].map(l => JSON.stringify(l)).join("\n");
    await writeFile(path.join(dir, "s1.jsonl"), lines);
    const full = await readTranscript("/x/y", "s1", { claudeHome: home, full: true });
    expect(full).toHaveLength(252);
    expect(full[250]).toMatchObject({ kind: "tool_use", tool: "Bash", input: { command: "x".repeat(300) } });
    expect(full[250].text).toBe(`Bash: ${"x".repeat(300)}`);
    expect(full[251].text).toBe(big);
    const brief = await readTranscript("/x/y", "s1", home);
    expect(brief).toHaveLength(200);
    expect(brief[198].text).toHaveLength("Bash: ".length + 200);
    expect(brief[199].text).toHaveLength(500);
  });
});
