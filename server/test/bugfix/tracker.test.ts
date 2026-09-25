import { describe, it, expect } from "vitest";
import path from "node:path";
import { mcpTracker, parseIssue, parseIssueList } from "../../src/bugfix/tracker.js";
import type { TrackerConfig } from "../../src/bugfix/integrations.js";

const cfg: TrackerConfig = { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: { atlassian: { type: "sse", url: "https://x" } }, hints: "Bugs live in PAY" };
const presets = path.resolve("presets");

const runner = (reply: string) => {
  const seen: Array<{ prompt: string; allowedTools: string[]; mcpServers: Record<string, unknown> }> = [];
  return { seen, run: async (a: { prompt: string; allowedTools: string[]; mcpServers: Record<string, unknown>; cwd: string }) => { seen.push(a); return reply; } };
};

describe("parsers", () => {
  it("accepts a well-formed issue and fills optional fields", () => {
    const i = parseIssue(`{"key":"PAY-42","title":"Boom","url":"https://x/PAY-42","status":"Open","priority":"High","description":"d","acceptanceCriteria":["a","b"]}`);
    expect(i).toEqual({ key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High", description: "d", acceptanceCriteria: ["a", "b"] });
    expect(parseIssue(`{"key":"P-1","title":"t","url":"u"}`)).toMatchObject({ status: "", priority: "", description: "", acceptanceCriteria: [] });
  });
  it("tolerates a fenced code block around the JSON", () => {
    expect(parseIssue("```json\n{\"key\":\"P-1\",\"title\":\"t\",\"url\":\"u\"}\n```").key).toBe("P-1");
  });
  it("throws with the raw text when the reply is not an issue", () => {
    expect(() => parseIssue("I could not find that ticket")).toThrow(/tracker returned no usable JSON/i);
    expect(() => parseIssue(`{"title":"no key"}`)).toThrow(/key/);
  });
  it("parses a list and drops malformed rows", () => {
    expect(parseIssueList(`[{"key":"A-1","title":"t","url":"u","status":"Open","priority":"Low"},{"title":"junk"}]`))
      .toEqual([{ key: "A-1", title: "t", url: "u", status: "Open", priority: "Low" }]);
    expect(parseIssueList("[]")).toEqual([]);
  });
});

describe("mcpTracker", () => {
  it("asks for my open bugs, restricted to the tracker's tools, and returns the list", async () => {
    const r = runner(`[{"key":"PAY-42","title":"Boom","url":"https://x/PAY-42","status":"Open","priority":"High"}]`);
    const t = mcpTracker(cfg, presets, r.run);
    expect(await t.listMyIssues()).toEqual([{ key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High" }]);
    expect(r.seen[0].allowedTools).toEqual(["mcp__atlassian"]);
    expect(r.seen[0].mcpServers).toEqual({ atlassian: { type: "sse", url: "https://x" } });   // passed explicitly — inheritance is not enough
    expect(r.seen[0].prompt).toContain("assigned to me");
    expect(r.seen[0].prompt).toContain("Bugs live in PAY");   // hints are injected
  });

  it("fetches one issue by key or URL", async () => {
    const r = runner(`{"key":"PAY-42","title":"Boom","url":"https://x/PAY-42","status":"Open","priority":"High","description":"d","acceptanceCriteria":[]}`);
    const t = mcpTracker(cfg, presets, r.run);
    expect((await t.fetchIssue("https://x/browse/PAY-42")).key).toBe("PAY-42");
    expect(r.seen[0].prompt).toContain("https://x/browse/PAY-42");
  });

  it("posts a comment and does not care about the reply", async () => {
    const r = runner("done");
    await mcpTracker(cfg, presets, r.run).comment("PAY-42", "PR is up: https://gh/pr/1");
    expect(r.seen[0].prompt).toContain("PAY-42");
    expect(r.seen[0].prompt).toContain("PR is up: https://gh/pr/1");
  });
});
