import { describe, it, expect } from "vitest";
import { buildSetupReport } from "../../src/bugfix/setup.js";
import type { Integrations } from "../../src/bugfix/integrations.js";

const noDiscovery = { servers: [], problems: [] };
const base = { discovery: noDiscovery, env: {} as NodeJS.ProcessEnv, wired: false, roleResolves: true, cfgExists: true };
const find = (r: ReturnType<typeof buildSetupReport>, id: string) => r.checks.find(c => c.id === id)!;

describe("buildSetupReport", () => {
  it("reports a missing config file as the first blocking problem", () => {
    const r = buildSetupReport({ ...base, cfg: null, cfgExists: false });
    expect(find(r, "config-file").state).toBe("missing");
    expect(find(r, "config-file").detail).toMatch(/integrations\.json/);
    expect(find(r, "config-file").blocks).toBe(true);
    expect(r.ready).toBe(false);
  });

  it("reports a corrupt config file as broken, carrying the parse error", () => {
    const r = buildSetupReport({ ...base, cfg: null, cfgError: "Unexpected token }" });
    expect(find(r, "config-file").state).toBe("broken");
    expect(find(r, "config-file").detail).toMatch(/Unexpected token \}/);
  });

  it("a configured tracker and github forge with a resolving role is ready", () => {
    const cfg: Integrations = { tracker: { preset: "jira", toolPrefix: "mcp__atlassian" }, forge: { preset: "github" }, projectRepos: {} };
    const r = buildSetupReport({ ...base, cfg });
    expect(r.ready).toBe(true);
    expect(r.checks.filter(c => c.blocks && c.state !== "ok")).toEqual([]);
  });

  it("a bitbucket forge with no token reports the variable, and does not block", () => {
    const cfg: Integrations = { tracker: { preset: "jira", toolPrefix: "mcp__atlassian" }, forge: { preset: "bitbucket", username: "me@example.com" }, projectRepos: {} };
    const r = buildSetupReport({ ...base, cfg });
    const token = find(r, "forge-token");
    expect(token.state).toBe("missing");
    expect(token.detail).toMatch(/BITBUCKET_API_TOKEN/);
    expect(token.fix).toEqual({ kind: "env", value: "BITBUCKET_API_TOKEN" });
    expect(token.blocks).toBe(false);   // the workflow can start; the forge call is what fails
  });

  it("sees the token when it is in the environment", () => {
    const cfg: Integrations = { tracker: { preset: "jira", toolPrefix: "mcp__atlassian" }, forge: { preset: "bitbucket", username: "me@example.com" }, projectRepos: {} };
    const r = buildSetupReport({ ...base, cfg, env: { BITBUCKET_API_TOKEN: "secret" } as NodeJS.ProcessEnv });
    expect(find(r, "forge-token").state).toBe("ok");
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("a bitbucket forge with a blank username names the field and blocks", () => {
    const cfg: Integrations = { tracker: { preset: "jira", toolPrefix: "mcp__atlassian" }, forge: { preset: "bitbucket", username: "   " }, projectRepos: {} };
    const r = buildSetupReport({ ...base, cfg });
    expect(find(r, "forge-username").state).toBe("missing");
    expect(find(r, "forge-username").fix).toEqual({ kind: "field", value: "forge.username" });
    expect(find(r, "forge-username").blocks).toBe(true);
  });

  // An account connector is exactly as usable as a local one — naming its tool prefix is what
  // connects it (spec §2) — so the fix offered is the same "use:<prefix>" action regardless of
  // origin. Only with nothing discovered at all does the fix fall back to `claude mcp add`.
  it("offers to use a discovered server as the fix, whatever its origin", () => {
    const withLocal = buildSetupReport({ ...base, cfg: { projectRepos: {} }, discovery: { servers: [{ name: "atlassian", toolPrefix: "mcp__atlassian", origin: "user" }], problems: [] } });
    expect(find(withLocal, "tracker").fix).toEqual({ kind: "action", value: "use:mcp__atlassian" });
    expect(withLocal.discovery.servers).toEqual([{ name: "atlassian", toolPrefix: "mcp__atlassian", origin: "user" }]);

    const accountConnector = buildSetupReport({ ...base, cfg: { projectRepos: {} }, discovery: { servers: [{ name: "claude.ai Claude Docs", toolPrefix: "mcp__claude_ai_Claude_Docs", origin: "account" }], problems: [] } });
    expect(find(accountConnector, "tracker").fix).toEqual({ kind: "action", value: "use:mcp__claude_ai_Claude_Docs" });

    const none = buildSetupReport({ ...base, cfg: { projectRepos: {} }, discovery: { servers: [], problems: [] } });
    expect(find(none, "tracker").fix!.kind).toBe("command");
    expect(find(none, "tracker").fix!.value).toMatch(/^claude mcp add --transport http /);
  });

  // A definition can no longer even be constructed here — McpServerFound carries no such field
  // (task 1) — so this now guards that the report never invents one, rather than that it redacts one.
  it("never returns a definition's contents", () => {
    const r = buildSetupReport({ ...base, cfg: { projectRepos: {} }, discovery: { servers: [{ name: "x", toolPrefix: "mcp__x", origin: "user" }], problems: [] } });
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(JSON.stringify(r)).not.toContain("Authorization");
  });

  it("names the field and the valid presets when no forge is configured", () => {
    const r = buildSetupReport({ ...base, cfg: { projectRepos: {} } });
    const forge = find(r, "forge");
    expect(forge.state).toBe("missing");
    expect(forge.blocks).toBe(true);
    expect(forge.detail).toMatch(/forge\.preset/);
    expect(forge.detail).toMatch(/github/);
    expect(forge.detail).toMatch(/bitbucket/);
    expect(forge.fix).toEqual({ kind: "field", value: "forge.preset" });
  });

  // C1: `toolPrefix` alone used to be enough for the "tracker" check to report ok, so a preset
  // with no prompt file (the old default, "mcp", among them) sailed through Settings green and
  // only surfaced as an ENOENT the moment a bug fix actually asked the tracker something.
  it("reports a tracker preset that has no prompt file as broken, not ok, and is not ready", () => {
    const cfg: Integrations = { tracker: { preset: "mcp", toolPrefix: "mcp__atlassian" }, forge: { preset: "github" }, projectRepos: {} };
    const r = buildSetupReport({ ...base, cfg, trackerPresetResolves: (preset: string) => preset === "jira" });
    const tracker = find(r, "tracker");
    expect(tracker.state).toBe("broken");
    expect(tracker.detail).toMatch(/"mcp"/);
    expect(tracker.detail).toMatch(/presets\/tracker/);
    expect(tracker.fix).toEqual({ kind: "field", value: "tracker.preset" });
    expect(r.ready).toBe(false);
  });

  it("a tracker preset that does resolve still reports ok", () => {
    const cfg: Integrations = { tracker: { preset: "jira", toolPrefix: "mcp__atlassian" }, forge: { preset: "github" }, projectRepos: {} };
    const r = buildSetupReport({ ...base, cfg, trackerPresetResolves: (preset: string) => preset === "jira" });
    expect(find(r, "tracker").state).toBe("ok");
    expect(r.ready).toBe(true);
  });

  it("without a resolver, the tracker check falls back to what it always tested (toolPrefix alone)", () => {
    const cfg: Integrations = { tracker: { preset: "mcp", toolPrefix: "mcp__atlassian" }, forge: { preset: "github" }, projectRepos: {} };
    const r = buildSetupReport({ ...base, cfg });
    expect(find(r, "tracker").state).toBe("ok");
  });

  it("reports a role that does not resolve", () => {
    const r = buildSetupReport({ ...base, cfg: { projectRepos: {} }, roleResolves: false });
    expect(find(r, "role").state).toBe("missing");
    expect(find(r, "role").blocks).toBe(true);
  });

  // Fake mode reaches exactly this: the engine is wired from a canned tracker/forge, not from
  // config, so `cfg` is empty even though a bug fix can genuinely start. The same combination
  // also covers a config deleted or corrupted out from under a running server — the engine it
  // already built keeps working. Capability (`ready`) and configuration (the checks) are
  // reported separately: `ready` must not be masked by the missing config, and the checks must
  // not be masked by `ready` — an operator editing the file still needs to see what's missing.
  it("is ready once wired, even with no config on disk — but still reports what is missing", () => {
    const r = buildSetupReport({ ...base, cfg: null, cfgExists: false, wired: true });
    expect(r.ready).toBe(true);
    expect(find(r, "config-file").state).toBe("missing");
    expect(find(r, "tracker").state).toBe("missing");
    expect(find(r, "forge").state).toBe("missing");
  });
});
