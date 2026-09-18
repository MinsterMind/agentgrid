import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveStatus, SessionStatusWatcher } from "../src/sessionStatus.js";

const user = (text: string, ts = "t") => ({ type: "user", timestamp: ts, message: { role: "user", content: text } });
const asst = (content: any[], stop: string | null = "end_turn", ts = "t") => ({ type: "assistant", timestamp: ts, message: { role: "assistant", content, stop_reason: stop } });
const result = (id: string) => ({ type: "user", timestamp: "t", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

describe("deriveStatus", () => {
  it("user prompt with no reply yet → working", () => {
    expect(deriveStatus("s", [user("fix it")])).toMatchObject({ phase: "working", lastPrompt: "fix it", lastMessage: "" });
  });
  it("assistant end_turn → idle with last message", () => {
    expect(deriveStatus("s", [user("hi"), asst([{ type: "text", text: "Done: PR #4 opened." }])])).toMatchObject({ phase: "idle", lastMessage: "Done: PR #4 opened." });
  });
  it("tool_use without result → waiting with pendingTool; result clears it", () => {
    const rows = [user("run tests"), asst([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }], "tool_use")];
    expect(deriveStatus("s", rows)).toMatchObject({ phase: "waiting", pendingTool: { name: "Bash", summary: "npm test" } });
    rows.push(result("t1"));
    expect(deriveStatus("s", rows).phase).toBe("working");
    expect(deriveStatus("s", rows).pendingTool).toBeUndefined();
  });
  it("AskUserQuestion without result → question", () => {
    const rows = [user("go"), asst([{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which branch?", options: [{ label: "main" }, { label: "dev" }], multiSelect: false }] } }], "tool_use")];
    expect(deriveStatus("s", rows).question).toEqual({ text: "Which branch?", options: ["main", "dev"], multiSelect: false });
    expect(deriveStatus("s", rows).phase).toBe("waiting");
  });
  it("ignores sidechain (subagent) rows and non-turn rows", () => {
    expect(deriveStatus("s", [{ type: "cost-state" }, { ...user("x"), isSidechain: true }])).toMatchObject({ phase: "unknown" });
  });
});

describe("SessionStatusWatcher", () => {
  it("emits on transcript changes only", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ch-"));
    const dir = path.join(home, "projects", "-w-r"); await mkdir(dir, { recursive: true });
    const f = path.join(dir, "s1.jsonl");
    await writeFile(f, JSON.stringify(user("hello")) + "\n");
    const seen: string[] = [];
    const w = new SessionStatusWatcher(s => seen.push(s.phase), 1000, home);
    w.watch("s1", "/w/r");
    await w.poll(); await w.poll();
    expect(seen).toEqual(["working"]);
    await new Promise(r => setTimeout(r, 15));
    await appendFile(f, JSON.stringify(asst([{ type: "text", text: "hi there" }])) + "\n");
    await w.poll();
    expect(seen).toEqual(["working", "idle"]);
    expect(w.get("s1")?.lastMessage).toBe("hi there");
    w.unwatch("s1"); await w.poll();
    expect(w.list()).toEqual([]);
  });
});
