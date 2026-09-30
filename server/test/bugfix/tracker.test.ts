import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mcpTracker, parseIssue, parseIssueList, defaultJsonRunner } from "../../src/bugfix/tracker.js";
import type { TrackerConfig } from "../../src/bugfix/integrations.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
import { query } from "@anthropic-ai/claude-agent-sdk";

const cfg: TrackerConfig = { preset: "jira", toolPrefix: "mcp__atlassian", hints: "Bugs live in PAY" };
const presets = path.resolve("presets");

const runner = (reply: string) => {
  const seen: Array<{ prompt: string; allowedTools: string[] }> = [];
  return { seen, run: async (a: { prompt: string; allowedTools: string[]; cwd: string }) => { seen.push(a); return reply; } };
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
  it("rejects a key that isn't a real issue key (e.g. the preset's own placeholder)", () => {
    expect(() => parseIssue(`{"key":"…","title":"t","url":"u"}`)).toThrow(/…/);
    expect(() => parseIssue(`{"key":"PAY 42","title":"t","url":"u"}`)).toThrow(/PAY 42/);
  });
  it("drops list rows with an invalid key instead of throwing", () => {
    expect(parseIssueList(`[{"key":"A-1","title":"t","url":"u","status":"Open","priority":"Low"},{"key":"…","title":"junk","url":"u","status":"","priority":""}]`))
      .toEqual([{ key: "A-1", title: "t", url: "u", status: "Open", priority: "Low" }]);
  });
});

describe("mcpTracker", () => {
  it("asks for my open bugs, restricted to the tracker's tools, and returns the list", async () => {
    const r = runner(`[{"key":"PAY-42","title":"Boom","url":"https://x/PAY-42","status":"Open","priority":"High"}]`);
    const t = mcpTracker(cfg, presets, r.run);
    expect(await t.listMyIssues()).toEqual([{ key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High" }]);
    expect(r.seen[0].allowedTools).toEqual(["mcp__atlassian"]);
    expect(r.seen[0].prompt).toContain("assigned to me");
    expect(r.seen[0].prompt).toContain("Bugs live in PAY");   // hints are injected
  });

  // The load-bearing assertion of this whole plan: no definition is ever copied or passed.
  // `allowedTools` naming the prefix is what connects the server — see tracker.ts's `ask`.
  it("passes the tool prefix in allowedTools and no mcpServers at all", async () => {
    const seen: any[] = [];
    const t = mcpTracker({ preset: "jira", toolPrefix: "mcp__claude_ai_Atlassian" }, presets,
      async (opts) => { seen.push(opts); return "[]"; });
    await t.listMyIssues();
    expect(seen[0].allowedTools).toEqual(["mcp__claude_ai_Atlassian"]);
    expect(seen[0].mcpServers).toBeUndefined();
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

  it("throws a clear error for an unknown preset name", async () => {
    const bad = mcpTracker({ ...cfg, preset: "no-such-tracker" }, presets, runner("[]").run);
    await expect(bad.listMyIssues()).rejects.toThrow();
  });

  it("throws a clear error when presetsDir doesn't exist", async () => {
    const bad = mcpTracker(cfg, path.resolve("no-such-presets-dir"), runner("[]").run);
    await expect(bad.listMyIssues()).rejects.toThrow();
  });
});

describe("defaultJsonRunner", () => {
  const savedOverride = process.env.AGENTGRID_CLAUDE_PATH;
  afterEach(() => {
    if (savedOverride === undefined) delete process.env.AGENTGRID_CLAUDE_PATH;
    else process.env.AGENTGRID_CLAUDE_PATH = savedOverride;
    vi.mocked(query).mockReset();
  });

  it("resolves the on-PATH claude executable and injects it into the SDK query options, instead of silently falling back to the bundled binary", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "claude-bin-"));
    const exe = path.join(dir, "claude");
    await writeFile(exe, "#!/bin/sh\n", { mode: 0o755 });
    process.env.AGENTGRID_CLAUDE_PATH = exe;

    vi.mocked(query).mockReturnValue((async function* () {
      yield { type: "result", subtype: "success" } as never;
    })() as never);

    await defaultJsonRunner({ prompt: "p", allowedTools: ["mcp__atlassian"], cwd: "/tmp" });

    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(query).mock.calls[0][0] as { options: { pathToClaudeCodeExecutable?: string; mcpServers?: unknown; allowedTools?: string[]; settingSources?: string[] } };
    expect(call.options.pathToClaudeCodeExecutable).toBe(exe);
    expect(call.options.mcpServers).toBeUndefined();
    expect(call.options.allowedTools).toEqual(["mcp__atlassian"]);
    // The critical finding this plan acts on: a project-scoped .mcp.json server loads only when
    // "project" is in settingSources — mcpTracker must pass both "user" and "project".
    expect(call.options.settingSources).toContain("project");
  });
});
