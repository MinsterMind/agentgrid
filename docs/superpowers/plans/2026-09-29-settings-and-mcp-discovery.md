# Settings Screen and MCP Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bug-fix workflow's setup state visible and self-explaining from inside the app — import an MCP server definition where one exists on disk, say plainly what is missing where it does not, and let first-time setup take effect without a restart.

**Architecture:** Two new server modules — a read-only scanner of Claude Code's on-disk MCP configuration, and a pure readiness reporter that turns the config, the environment and the scan into a list of structured checks. The integrations routes move out from behind the engine guard (they are currently unreachable on exactly the machines that need them), a new `GET /api/setup` answers unconditionally, and a `SettingsDialog` renders guidance derived from the checks rather than authored as prose.

**Tech Stack:** Node 22 + TypeScript ESM (explicit `.js` import suffixes), Express 5, vitest + supertest, React 19 + Vite, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-29-settings-and-mcp-discovery-design.md`

## Global Constraints

- Node 22 + TypeScript ESM: every relative import carries an explicit `.js` suffix.
- Tests mirror `src` paths under `server/test/`; the server suite runs from `server/`. UI tests live beside the components under `ui/src/`.
- **Nothing under `~/.claude` is ever written.** The scan is read-only and confined to MCP server definitions — never transcripts, history or project data.
- **The scan never throws.** Every file is optional and parsed independently; one malformed file becomes a reported problem naming the file, never a thrown error and never a blank result.
- **A missing `~/.claude` is "nothing found", not an error.** AgentGrid must work for someone who has never configured an MCP server.
- **`GET /api/setup` answers even when every subsystem is null.** That is its entire reason for existing; it must never sit behind the engine guard.
- **No secret is ever returned to the UI or logged.** `BITBUCKET_API_TOKEN` is reported as a boolean presence test on `process.env`. An imported MCP definition may itself contain credentials: it is stored in `integrations.json` as-is, never logged, and only its `name`, transport `type` and `url` are sent to the UI.
- **Live wiring is one absent→present transition per process.** Never a re-wire; an existing engine and watcher are never rebuilt under running tasks.
- `rebase` is omitted from the merge-method choices when the forge is Bitbucket.

## File structure

| File | Responsibility |
|---|---|
| `server/src/bugfix/mcp-discovery.ts` | **new** — read-only scan of Claude Code's MCP configuration |
| `server/src/bugfix/setup.ts` | **new** — pure readiness reporter: config + env + scan → `Check[]` |
| `server/src/api/app.ts` | `integrations` becomes top-level; integrations routes leave the guard; `/api/setup` routes; mutable bugs reference |
| `server/src/start.ts` | `wireBugFix(cfg)` extracted; passed to `createApp` as `onConfigured` |
| `server/src/bugfix/engine.ts` | `preflight`'s misleading role message corrected |
| `ui/src/api.ts` | client calls for the setup routes |
| `ui/src/types.ts` | `Check`, `SetupReport`, `Discovery` types re-exported from the server |
| `ui/src/components/SettingsDialog.tsx` | **new** — the three sections |
| `ui/src/components/TopBar.tsx` | ⚙︎ Settings button |
| `ui/src/components/BugLauncher.tsx` | the adaptive "what's missing" summary |
| `README.md` | setup section rewritten around the screen |

---

### Task 1: the MCP scan

**Files:**
- Create: `server/src/bugfix/mcp-discovery.ts`
- Test: `server/test/bugfix/mcp-discovery.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface McpServerFound {
    name: string;
    definition: Record<string, unknown>;   // copied verbatim; may contain credentials
    origin: "user" | "project" | "repo" | "settings";
    originDetail?: string;                 // e.g. the repo path a project/repo entry came from
  }
  export interface Discovery {
    importable: McpServerFound[];
    accountOnly: string[];                 // names only; no definition exists on disk
    problems: string[];                    // one per unreadable/malformed file, naming it
  }
  export function discoverMcpServers(opts: { home?: string; repo?: string }): Promise<Discovery>;
  ```
  `home` defaults to `os.homedir()`. `discoverMcpServers` never throws and never writes.

- [ ] **Step 1: Write the failing tests**

`server/test/bugfix/mcp-discovery.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverMcpServers } from "../../src/bugfix/mcp-discovery.js";

/** A fake home: `~/.claude.json` plus `~/.claude/settings.json`, both optional. */
async function fakeHome(claudeJson?: unknown, settings?: unknown): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-mcp-"));
  if (claudeJson !== undefined) await writeFile(path.join(home, ".claude.json"), typeof claudeJson === "string" ? claudeJson : JSON.stringify(claudeJson));
  if (settings !== undefined) {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  return home;
}

describe("discoverMcpServers", () => {
  it("finds user-scoped servers with their definitions", async () => {
    const home = await fakeHome({ mcpServers: { atlassian: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" } } });
    const d = await discoverMcpServers({ home });
    expect(d.importable).toEqual([{ name: "atlassian", definition: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" }, origin: "user" }]);
    expect(d.accountOnly).toEqual([]);
    expect(d.problems).toEqual([]);
  });

  it("finds project-scoped servers and records which project they came from", async () => {
    const home = await fakeHome({ projects: { "/Users/x/repo": { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app" } } } } });
    const d = await discoverMcpServers({ home });
    expect(d.importable).toEqual([{ name: "linear", definition: { type: "http", url: "https://mcp.linear.app" }, origin: "project", originDetail: "/Users/x/repo" }]);
  });

  it("finds a repo's .mcp.json when a repo is given", async () => {
    const home = await fakeHome({});
    const repo = await mkdtemp(path.join(os.tmpdir(), "agentgrid-repo-"));
    await writeFile(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { jira: { command: "npx", args: ["-y", "jira-mcp"] } } }));
    const d = await discoverMcpServers({ home, repo });
    expect(d.importable).toEqual([{ name: "jira", definition: { command: "npx", args: ["-y", "jira-mcp"] }, origin: "repo", originDetail: repo }]);
  });

  it("reports account-level connectors by name, never as importable", async () => {
    const home = await fakeHome({ claudeAiMcpEverConnected: ["claude.ai Claude Docs", "claude.ai Kite mcp"] });
    const d = await discoverMcpServers({ home });
    expect(d.importable).toEqual([]);
    expect(d.accountOnly).toEqual(["claude.ai Claude Docs", "claude.ai Kite mcp"]);
  });

  it("a malformed file is reported by name and does not blank the good ones", async () => {
    const home = await fakeHome("{ this is not json", { mcpServers: { ok: { type: "http", url: "https://example.invalid" } } });
    const d = await discoverMcpServers({ home });
    expect(d.importable.map(s => s.name)).toEqual(["ok"]);
    expect(d.problems).toHaveLength(1);
    expect(d.problems[0]).toMatch(/\.claude\.json/);
  });

  it("a missing ~/.claude is nothing found, not an error", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-empty-"));
    await expect(discoverMcpServers({ home })).resolves.toEqual({ importable: [], accountOnly: [], problems: [] });
  });

  it("prefers the more specific scope when the same name appears twice", async () => {
    const home = await fakeHome({
      mcpServers: { atlassian: { type: "http", url: "https://user-scope" } },
      projects: { "/Users/x/repo": { mcpServers: { atlassian: { type: "http", url: "https://project-scope" } } } },
    });
    const d = await discoverMcpServers({ home });
    expect(d.importable).toHaveLength(1);
    expect(d.importable[0]!.definition).toEqual({ type: "http", url: "https://project-scope" });
    expect(d.importable[0]!.origin).toBe("project");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/mcp-discovery.test.ts`
Expected: FAIL — `Cannot find module '../../src/bugfix/mcp-discovery.js'`.

- [ ] **Step 3: Implement the scan**

`server/src/bugfix/mcp-discovery.ts`:

```ts
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface McpServerFound {
  name: string;
  /** Copied verbatim from Claude Code's own config. May contain credentials — never log it. */
  definition: Record<string, unknown>;
  origin: "user" | "project" | "repo" | "settings";
  originDetail?: string;
}
export interface Discovery { importable: McpServerFound[]; accountOnly: string[]; problems: string[] }

/** Reads one JSON file. A missing file is `undefined`; an unreadable one is a reported problem. */
async function readJson(file: string, problems: string[]): Promise<any | undefined> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch { return undefined; }                       // absent is normal, not a problem
  try { return JSON.parse(raw); }
  catch (err) { problems.push(`${file} could not be parsed: ${(err as Error).message}`); return undefined; }
}

function collect(into: Map<string, McpServerFound>, servers: unknown, origin: McpServerFound["origin"], originDetail?: string): void {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
  for (const [name, definition] of Object.entries(servers as Record<string, unknown>)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
    into.set(name, { name, definition: definition as Record<string, unknown>, origin, ...(originDetail ? { originDetail } : {}) });
  }
}

/**
 * Everything Claude Code stores about MCP servers that is readable from disk.
 *
 * Account-level (claude.ai) connectors keep their definitions server-side: `~/.claude.json`
 * records only that they were connected, by name, so they can be reported but never imported.
 * Verified 2026-09-29 — see the spec's §3.
 *
 * Never throws, never writes. Later scopes overwrite earlier ones for the same name, so the
 * order below is least-specific first.
 */
export async function discoverMcpServers(opts: { home?: string; repo?: string }): Promise<Discovery> {
  const home = opts.home ?? os.homedir();
  const problems: string[] = [];
  const found = new Map<string, McpServerFound>();

  const settings = await readJson(path.join(home, ".claude", "settings.json"), problems);
  collect(found, settings?.mcpServers, "settings");

  const claudeJson = await readJson(path.join(home, ".claude.json"), problems);
  collect(found, claudeJson?.mcpServers, "user");

  const projects = claudeJson?.projects;
  if (projects && typeof projects === "object") {
    for (const [dir, entry] of Object.entries(projects as Record<string, any>)) {
      collect(found, entry?.mcpServers, "project", dir);
    }
  }

  if (opts.repo) {
    const repoConfig = await readJson(path.join(opts.repo, ".mcp.json"), problems);
    collect(found, repoConfig?.mcpServers, "repo", opts.repo);
  }

  const accountOnly = Array.isArray(claudeJson?.claudeAiMcpEverConnected)
    ? claudeJson.claudeAiMcpEverConnected.filter((n: unknown): n is string => typeof n === "string" && !found.has(n))
    : [];

  return { importable: [...found.values()], accountOnly, problems };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/bugfix/mcp-discovery.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 7 passed, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/bugfix/mcp-discovery.ts server/test/bugfix/mcp-discovery.test.ts
git commit -m "feat(setup): read Claude Code's MCP configuration, without writing to it"
```

---

### Task 2: the readiness report

**Files:**
- Create: `server/src/bugfix/setup.ts`
- Test: `server/test/bugfix/setup.test.ts`

**Interfaces:**
- Consumes: `Discovery` and `discoverMcpServers` (Task 1); `Integrations` and `ForgeConfig` from `server/src/bugfix/integrations.js`.
- Produces:
  ```ts
  export type CheckId = "config-file" | "tracker" | "forge" | "forge-username" | "forge-token" | "role";
  // NOTE, deliberate divergence from the spec's §5 listing: `tracker-reachable` and
  // `forge-auth` are NOT checks. The spec says they are "on demand only (the Test button),
  // never computed when the page opens" — a check computed on open would make every render
  // of Settings call the tracker and the forge. They are Task 4's two routes instead.
  export interface Check {
    id: CheckId;
    state: "ok" | "missing" | "broken";
    detail: string;
    fix?: { kind: "command" | "env" | "field" | "action"; value: string };
    blocks: boolean;
  }
  export interface SetupReport {
    ready: boolean;                       // no blocking check is non-ok
    wired: boolean;                       // the engine exists in this process right now
    checks: Check[];
    discovery: { importable: Array<{ name: string; type?: string; url?: string; origin: string; originDetail?: string }>;
                 accountOnly: string[]; problems: string[] };
    addCommand: string;                   // the editable default `claude mcp add ...`
  }
  export function buildSetupReport(input: {
    cfg: Integrations | null;             // null when integrations.json could not be read
    cfgError?: string;                    // the parse error, when there was one
    cfgExists: boolean;
    discovery: Discovery;
    env: NodeJS.ProcessEnv;
    wired: boolean;
    roleResolves: boolean;
  }): SetupReport;
  ```
  `buildSetupReport` is pure — no I/O, no clock, no `process.env` read of its own. **The `discovery.importable` it returns carries only `name`, `type`, `url`, `origin` and `originDetail`; the definition itself never leaves the server.**

- [ ] **Step 1: Write the failing tests**

`server/test/bugfix/setup.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSetupReport } from "../../src/bugfix/setup.js";
import type { Integrations } from "../../src/bugfix/integrations.js";

const noDiscovery = { importable: [], accountOnly: [], problems: [] };
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
    const cfg: Integrations = { tracker: { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: { atlassian: {} } }, forge: { preset: "github" }, projectRepos: {} };
    const r = buildSetupReport({ ...base, cfg });
    expect(r.ready).toBe(true);
    expect(r.checks.filter(c => c.blocks && c.state !== "ok")).toEqual([]);
  });

  it("a bitbucket forge with no token reports the variable, and does not block", () => {
    const cfg: Integrations = { tracker: { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: {} }, forge: { preset: "bitbucket", username: "me@example.com" }, projectRepos: {} };
    const r = buildSetupReport({ ...base, cfg });
    const token = find(r, "forge-token");
    expect(token.state).toBe("missing");
    expect(token.detail).toMatch(/BITBUCKET_API_TOKEN/);
    expect(token.fix).toEqual({ kind: "env", value: "BITBUCKET_API_TOKEN" });
    expect(token.blocks).toBe(false);   // the workflow can start; the forge call is what fails
  });

  it("sees the token when it is in the environment", () => {
    const cfg: Integrations = { tracker: { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: {} }, forge: { preset: "bitbucket", username: "me@example.com" }, projectRepos: {} };
    const r = buildSetupReport({ ...base, cfg, env: { BITBUCKET_API_TOKEN: "secret" } as NodeJS.ProcessEnv });
    expect(find(r, "forge-token").state).toBe("ok");
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("a bitbucket forge with a blank username names the field and blocks", () => {
    const cfg: Integrations = { tracker: { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: {} }, forge: { preset: "bitbucket", username: "   " }, projectRepos: {} };
    const r = buildSetupReport({ ...base, cfg });
    expect(find(r, "forge-username").state).toBe("missing");
    expect(find(r, "forge-username").fix).toEqual({ kind: "field", value: "forge.username" });
    expect(find(r, "forge-username").blocks).toBe(true);
  });

  it("offers an import when a server was discovered, and the add command when only an account connector was", () => {
    const withLocal = buildSetupReport({ ...base, cfg: { projectRepos: {} }, discovery: { importable: [{ name: "atlassian", definition: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" }, origin: "user" }], accountOnly: [], problems: [] } });
    expect(find(withLocal, "tracker").fix).toEqual({ kind: "action", value: "import:atlassian" });
    expect(withLocal.discovery.importable[0]).toEqual({ name: "atlassian", type: "http", url: "https://mcp.atlassian.com/v1/mcp", origin: "user" });

    const accountOnly = buildSetupReport({ ...base, cfg: { projectRepos: {} }, discovery: { importable: [], accountOnly: ["claude.ai Claude Docs"], problems: [] } });
    expect(find(accountOnly, "tracker").fix!.kind).toBe("command");
    expect(find(accountOnly, "tracker").fix!.value).toMatch(/^claude mcp add --transport http /);
  });

  it("never returns an imported definition's contents", () => {
    const r = buildSetupReport({ ...base, cfg: { projectRepos: {} }, discovery: { importable: [{ name: "x", definition: { type: "http", url: "https://e.invalid", headers: { Authorization: "Bearer hunter2" } }, origin: "user" }], accountOnly: [], problems: [] } });
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(JSON.stringify(r)).not.toContain("Authorization");
  });

  it("reports a role that does not resolve", () => {
    const r = buildSetupReport({ ...base, cfg: { projectRepos: {} }, roleResolves: false });
    expect(find(r, "role").state).toBe("missing");
    expect(find(r, "role").blocks).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/setup.test.ts`
Expected: FAIL — `Cannot find module '../../src/bugfix/setup.js'`.

- [ ] **Step 3: Implement the reporter**

`server/src/bugfix/setup.ts`:

```ts
import type { Integrations } from "./integrations.js";
import type { Discovery } from "./mcp-discovery.js";

export type CheckId = "config-file" | "tracker" | "forge" | "forge-username" | "forge-token" | "role";
export interface Check {
  id: CheckId;
  state: "ok" | "missing" | "broken";
  detail: string;
  fix?: { kind: "command" | "env" | "field" | "action"; value: string };
  /** Does this stop a bug fix from being started at all? Drives the launcher's summary. */
  blocks: boolean;
}
export interface SetupReport {
  ready: boolean;
  wired: boolean;
  checks: Check[];
  discovery: { importable: Array<{ name: string; type?: string; url?: string; origin: string; originDetail?: string }>;
               accountOnly: string[]; problems: string[] };
  addCommand: string;
}

/**
 * The default `claude mcp add` line. An editable default, not a constant to be trusted
 * forever: the previous `…/v1/sse` endpoint stopped being supported after 30 June 2026.
 */
export const DEFAULT_ADD_COMMAND = "claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp";

/**
 * Config + environment + scan → what is wrong and what to do about it.
 *
 * Pure: no I/O, no clock, no `process.env` of its own — everything arrives in `input`, so
 * every state is reachable from a test. The UI renders whatever comes back non-`ok`, which
 * is why the remedies live on the checks rather than in the UI: there is no second list to
 * keep in sync.
 */
export function buildSetupReport(input: {
  cfg: Integrations | null;
  cfgError?: string;
  cfgExists: boolean;
  discovery: Discovery;
  env: NodeJS.ProcessEnv;
  wired: boolean;
  roleResolves: boolean;
}): SetupReport {
  const { cfg, cfgError, cfgExists, discovery, env, wired, roleResolves } = input;
  const checks: Check[] = [];

  if (cfgError) {
    checks.push({ id: "config-file", state: "broken", blocks: true,
      detail: `~/.agentgrid/integrations.json could not be read: ${cfgError}`,
      fix: { kind: "action", value: "fix-or-remove-config" } });
  } else if (!cfgExists) {
    checks.push({ id: "config-file", state: "missing", blocks: true,
      detail: "~/.agentgrid/integrations.json does not exist yet. Saving here creates it.",
      fix: { kind: "action", value: "save" } });
  } else {
    checks.push({ id: "config-file", state: "ok", blocks: true, detail: "~/.agentgrid/integrations.json is readable." });
  }

  const tracker = cfg?.tracker;
  if (tracker?.toolPrefix) {
    checks.push({ id: "tracker", state: "ok", blocks: true, detail: `Tracker configured (${tracker.preset}, tools ${tracker.toolPrefix}).` });
  } else {
    const first = discovery.importable[0];
    checks.push({ id: "tracker", state: "missing", blocks: true,
      detail: first
        ? `No tracker configured. ${discovery.importable.length} MCP server(s) found in your Claude Code configuration.`
        : discovery.accountOnly.length
          ? `No tracker configured. ${discovery.accountOnly.length} connector(s) are linked to your Claude account, but account connectors keep their definition server-side — there is nothing to import. Add a local one, then press Detect.`
          : "No tracker configured, and no MCP server was found in your Claude Code configuration.",
      fix: first ? { kind: "action", value: `import:${first.name}` } : { kind: "command", value: DEFAULT_ADD_COMMAND } });
  }

  const forge = cfg?.forge;
  if (!forge?.preset) {
    checks.push({ id: "forge", state: "missing", blocks: true, detail: "No forge configured.", fix: { kind: "field", value: "forge.preset" } });
  } else {
    checks.push({ id: "forge", state: "ok", blocks: true, detail: `Forge: ${forge.preset}.` });
    if (forge.preset === "bitbucket") {
      const named = typeof forge.username === "string" && forge.username.trim().length > 0;
      checks.push(named
        ? { id: "forge-username", state: "ok", blocks: true, detail: `Bitbucket account: ${forge.username!.trim()}.` }
        : { id: "forge-username", state: "missing", blocks: true,
            detail: "Bitbucket needs your Atlassian account email to authenticate.",
            fix: { kind: "field", value: "forge.username" } });
      // Presence only — the value is never read into the report.
      checks.push(env.BITBUCKET_API_TOKEN?.trim()
        ? { id: "forge-token", state: "ok", blocks: false, detail: "BITBUCKET_API_TOKEN is visible to the server." }
        : { id: "forge-token", state: "missing", blocks: false,
            detail: "BITBUCKET_API_TOKEN is not visible to the server process. Export it in your login shell, then restart AgentGrid — the app reads that environment when it launches.",
            fix: { kind: "env", value: "BITBUCKET_API_TOKEN" } });
    }
  }

  checks.push(roleResolves
    ? { id: "role", state: "ok", blocks: true, detail: "The bugfix role resolves." }
    : { id: "role", state: "missing", blocks: true,
        detail: "The bugfix role could not be resolved from the app's defaults or ~/.agentgrid/roles.",
        fix: { kind: "action", value: "reinstall" } });

  return {
    ready: checks.every(c => !c.blocks || c.state === "ok"),
    wired,
    checks,
    // Only the shape the UI needs: a definition can carry credentials and never leaves the server.
    discovery: {
      importable: discovery.importable.map(s => ({
        name: s.name,
        ...(typeof s.definition.type === "string" ? { type: s.definition.type } : {}),
        ...(typeof s.definition.url === "string" ? { url: s.definition.url } : {}),
        origin: s.origin,
        ...(s.originDetail ? { originDetail: s.originDetail } : {}),
      })),
      accountOnly: discovery.accountOnly,
      problems: discovery.problems,
    },
    addCommand: DEFAULT_ADD_COMMAND,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/bugfix/setup.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 9 passed, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/bugfix/setup.ts server/test/bugfix/setup.test.ts
git commit -m "feat(setup): derive setup guidance from config, environment and scan"
```

---

### Task 3: the setup routes, and freeing integrations from the engine guard

**Files:**
- Modify: `server/src/api/app.ts`
- Test: `server/test/bugfix/api.test.ts` (append), `server/test/bugfix/setup-routes.test.ts` (create)

**Interfaces:**
- Consumes: `buildSetupReport`, `SetupReport` (Task 2); `discoverMcpServers` (Task 1).
- Produces:
  ```ts
  // AppDeps gains, alongside the existing optional `bugs`:
  integrations?: IntegrationsStore;                     // top-level: needed with or without an engine
  roleResolves?: () => boolean;                         // defaults to () => true
  setupRepo?: () => string | undefined;                 // a repo whose .mcp.json is worth scanning
  onConfigured?: () => Promise<AppDeps["bugs"] | null>; // Task 5 supplies this; called at most once
  ```
  Routes: `GET /api/setup`, `POST /api/setup/import` (`{ name: string }`), and `GET`/`PUT /api/integrations` — **all four outside the engine guard**.

**The point of this task:** today `GET` and `PUT /api/integrations` both call `bugs()`, so a machine with no tracker cannot read or write its own configuration through the API — it answers 501. That is the structural cause of the reported dead end.

- [ ] **Step 1: Write the failing tests**

`server/test/bugfix/setup-routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../src/api/app.js";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/manager.js";
import { IntegrationsStore } from "../../src/bugfix/integrations.js";

/** An app with NO bug-fix engine — the case the old API could not express. */
async function unwiredApp() {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-setup-"));
  const store = new Store(home, path.resolve("roles"));
  await store.load();
  const integrations = new IntegrationsStore(home);
  const app = createApp({ store, manager: new Manager({ store } as never), integrations, roleResolves: () => true });
  return { app, home, integrations };
}

describe("the setup routes answer without an engine", () => {
  it("GET /api/setup reports what is missing instead of 501", async () => {
    const { app } = await unwiredApp();
    const res = await request(app).get("/api/setup").expect(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.wired).toBe(false);
    const ids = res.body.checks.map((c: { id: string }) => c.id);
    expect(ids).toContain("config-file");
    expect(ids).toContain("tracker");
  });

  it("GET /api/integrations answers rather than 501", async () => {
    const { app } = await unwiredApp();
    const res = await request(app).get("/api/integrations").expect(200);
    expect(res.body).toEqual({ projectRepos: {} });
  });

  it("PUT /api/integrations creates the file on a machine that has none", async () => {
    const { app, integrations } = await unwiredApp();
    await request(app).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
    expect((await integrations.read()).forge).toEqual({ preset: "github" });
  });

  it("the bug-fix routes still 501 without an engine", async () => {
    const { app } = await unwiredApp();
    await request(app).get("/api/bugtasks").expect(501);
  });

  it("POST /api/setup/import refuses a name that was not discovered", async () => {
    const { app } = await unwiredApp();
    const res = await request(app).post("/api/setup/import").send({ name: "nope" }).expect(400);
    expect(res.body.error).toMatch(/nope/);
  });
});
```

Append to `server/test/bugfix/api.test.ts`:

```ts
it("GET /api/setup reports ready once tracker, forge and role are in place", async () => {
  const m = await appAtMergeGate();            // the existing fully-wired harness
  const res = await request(m.app).get("/api/setup").expect(200);
  expect(res.body.wired).toBe(true);
  expect(res.body.checks.find((c: { id: string }) => c.id === "tracker").state).toBe("ok");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/setup-routes.test.ts`
Expected: FAIL — `createApp` rejects the `integrations`/`roleResolves` options, and `/api/setup` 404s.

- [ ] **Step 3: Wire the routes**

In `server/src/api/app.ts`, extend `AppDeps`:

```ts
  /** The config store, needed with or without an engine: an unconfigured machine must still
   *  be able to read and write its own integrations.json. */
  integrations?: IntegrationsStore;
  /** Whether the bugfix role resolves (from the app's defaults or ~/.agentgrid/roles). */
  roleResolves?: () => boolean;
  /** A repo whose `.mcp.json` is worth scanning, when one is known. */
  setupRepo?: () => string | undefined;
  /** Builds the bug-fix subsystem once configuration first appears. Called at most once. */
  onConfigured?: () => Promise<AppDeps["bugs"] | null>;
```

Replace the guard and the integrations routes:

```ts
  class NotWired extends Error { status = 501; }
  // The engine may arrive mid-process, once configuration first appears (see `maybeWire`).
  let wired = deps.bugs;
  const bugs = () => { if (!wired) throw new NotWired("the bug-fix workflow is not configured"); return wired; };
  const setBugTasksSource = () => { if (wired) store.bugTasks = () => wired!.store.list(); };
  setBugTasksSource();

  /** The config store is reachable with or without an engine; the engine's copy is the same object. */
  const integrationsStore = () => {
    const s = deps.integrations ?? wired?.integrations;
    if (!s) throw new NotWired("no configuration store");
    return s;
  };

  /**
   * One absent→present transition per process, never a re-wire: with no engine, no bug task
   * can exist, so building one disrupts nothing. An engine that already exists is left alone —
   * rebuilding it would tear down in-flight tasks whose dispatch state is in memory.
   */
  const maybeWire = async () => {
    if (wired || !deps.onConfigured) return;
    wired = (await deps.onConfigured()) ?? undefined;
    setBugTasksSource();
  };

  const setupReport = async () => {
    const store_ = integrationsStore();
    let cfg: Integrations | null = null; let cfgError: string | undefined;
    try { cfg = await store_.read(); } catch (err) { cfgError = (err as Error).message; }
    const cfgExists = await store_.exists();
    const discovery = await discoverMcpServers({ ...(deps.setupRepo?.() ? { repo: deps.setupRepo()! } : {}) });
    return buildSetupReport({ cfg, ...(cfgError ? { cfgError } : {}), cfgExists, discovery,
      env: process.env, wired: !!wired, roleResolves: deps.roleResolves?.() ?? true });
  };

  app.get("/api/setup", wrap(async (_req, res) => res.json(await setupReport())));

  app.post("/api/setup/import", wrap(async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const discovery = await discoverMcpServers({ ...(deps.setupRepo?.() ? { repo: deps.setupRepo()! } : {}) });
    const server = discovery.importable.find(s => s.name === name);
    if (!server) throw new BadRequest(`no importable MCP server named "${name}" was found in your Claude Code configuration`);
    await integrationsStore().write(cur => ({
      tracker: { preset: cur.tracker?.preset ?? "mcp", toolPrefix: `mcp__${server.name}`,
                 mcpServers: { [server.name]: server.definition } },
    }));
    await maybeWire();
    res.json(await setupReport());
  }));

  app.get("/api/integrations", wrap(async (_req, res) => res.json(await integrationsStore().read())));
```

and in `PUT /api/integrations`, replace the final line `res.json(await bugs().integrations.write(patch as never));` with:

```ts
    const saved = await integrationsStore().write(patch as never);
    await maybeWire();
    res.json(saved);
```

Add the imports at the top of the file:

```ts
import { discoverMcpServers } from "../bugfix/mcp-discovery.js";
import { buildSetupReport } from "../bugfix/setup.js";
import type { Integrations } from "../bugfix/integrations.js";
```

- [ ] **Step 4: Add `exists()` to the config store**

In `server/src/bugfix/integrations.ts`, add to `IntegrationsStore`:

```ts
  /** Whether the file is actually there — distinct from `read()`'s empty-on-missing result,
   *  which cannot tell "no file yet" from "a file with nothing in it". */
  async exists(): Promise<boolean> {
    return readFile(this.file, "utf8").then(() => true, () => false);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/api/app.ts server/src/bugfix/integrations.ts server/test/bugfix
git commit -m "feat(setup): answer what is missing, and let an unconfigured machine save its config"
```

---

### Task 4: the Test buttons

**Files:**
- Modify: `server/src/api/app.ts`
- Test: `server/test/bugfix/setup-routes.test.ts` (append)

**Interfaces:**
- Produces: `POST /api/setup/test/tracker` and `POST /api/setup/test/forge`, both returning `{ ok: boolean; message: string }` and **never throwing** on a provider failure — a failed test is a 200 with `ok: false`, because "the forge refused your token" is an answer, not a server error.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/bugfix/setup-routes.test.ts`:

```ts
describe("the setup test buttons", () => {
  it("a tracker test with nothing configured answers ok:false, not 501", async () => {
    const { app } = await unwiredApp();
    const res = await request(app).post("/api/setup/test/tracker").expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/no tracker/i);
  });

  it("a forge test with nothing configured answers ok:false", async () => {
    const { app } = await unwiredApp();
    const res = await request(app).post("/api/setup/test/forge").expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/no forge/i);
  });

  it("a tracker test reports the provider's own error rather than a generic one", async () => {
    const { app } = await unwiredApp({ tracker: { listMyIssues: async () => { throw new Error("MCP server atlassian is not connected"); } } });
    const res = await request(app).post("/api/setup/test/tracker").expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/not connected/);
  });

  it("a passing tracker test names the issue count", async () => {
    const { app } = await unwiredApp({ tracker: { listMyIssues: async () => [{ key: "A-1" }, { key: "A-2" }] } });
    const res = await request(app).post("/api/setup/test/tracker").expect(200);
    expect(res.body).toEqual({ ok: true, message: "2 issues assigned to you." });
  });
});
```

Extend the harness at the top of the file so a tracker can be injected:

```ts
async function unwiredApp(extra?: { tracker?: { listMyIssues: () => Promise<unknown[]> }; forge?: { authStatus: () => Promise<{ ok: boolean; message: string }> } }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-setup-"));
  const store = new Store(home, path.resolve("roles"));
  await store.load();
  const integrations = new IntegrationsStore(home);
  const app = createApp({ store, manager: new Manager({ store } as never), integrations, roleResolves: () => true,
    ...(extra?.tracker ? { setupTracker: () => extra.tracker as never } : {}),
    ...(extra?.forge ? { setupForge: () => extra.forge as never } : {}) });
  return { app, home, integrations };
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/setup-routes.test.ts`
Expected: FAIL — the two routes 404.

- [ ] **Step 3: Implement the routes**

Extend `AppDeps`:

```ts
  /** The tracker to exercise from Settings' Test button, when one can be built. */
  setupTracker?: () => TrackerProvider | null;
  /** The forge to exercise from Settings' Test button, when one can be built. */
  setupForge?: () => ForgeAdapter | null;
```

and add, beside the other setup routes:

```ts
  // A failed test is an answer, not a server error: 200 with ok:false, carrying the
  // provider's own words. "Something went wrong" is exactly what this screen exists to end.
  app.post("/api/setup/test/tracker", wrap(async (_req, res) => {
    const tracker = deps.setupTracker?.() ?? wired?.tracker ?? null;
    if (!tracker) return res.json({ ok: false, message: "no tracker is configured yet" });
    try {
      const issues = await tracker.listMyIssues();
      return res.json({ ok: true, message: `${issues.length} issues assigned to you.` });
    } catch (err) {
      return res.json({ ok: false, message: (err as Error).message });
    }
  }));

  app.post("/api/setup/test/forge", wrap(async (_req, res) => {
    const forge = deps.setupForge?.() ?? null;
    if (!forge) return res.json({ ok: false, message: "no forge is configured yet" });
    const status = await forge.authStatus();          // adapters never throw
    return res.json(status);
  }));
```

with the type imports:

```ts
import type { ForgeAdapter } from "../bugfix/forge/types.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/app.ts server/test/bugfix/setup-routes.test.ts
git commit -m "feat(setup): Test buttons that report the provider's own error"
```

---

### Task 5: live wiring, once

**Files:**
- Modify: `server/src/start.ts`
- Test: `server/test/bugfix/live-wiring.test.ts` (create)

**Interfaces:**
- Consumes: `AppDeps.onConfigured`, `AppDeps.integrations`, `AppDeps.roleResolves`, `AppDeps.setupForge` (Tasks 3-4).
- Produces: `wireBugFix(cfg: Integrations)` inside `start()`, returning the same shape as `AppDeps["bugs"]` or `null`, and passed to `createApp` as `onConfigured`.

- [ ] **Step 1: Write the failing test**

`server/test/bugfix/live-wiring.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { start } from "../../src/start.js";

describe("first-time setup takes effect without a restart", () => {
  it("wires the engine when configuration first appears, and does not rebuild it afterwards", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-wire-"));
    const running = await start({ home, port: 0, fake: true });
    try {
      // Fake mode always has a tracker, so drive the real transition through the flag the
      // route uses: an app that reports unwired must become wired on the first save.
      const before = await request(running.url).get("/api/setup").expect(200);
      if (!before.body.wired) {
        await request(running.url).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
        const after = await request(running.url).get("/api/setup").expect(200);
        expect(after.body.wired).toBe(true);
        await request(running.url).get("/api/bugtasks").expect(200);   // no longer 501
      }
      // A second save must not rebuild: the engine object stays identical.
      const first = running.bugEngineForTest?.();
      await request(running.url).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
      expect(running.bugEngineForTest?.()).toBe(first);
    } finally { await running.close(); }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run test/bugfix/live-wiring.test.ts`
Expected: FAIL — `bugEngineForTest` does not exist and `onConfigured` is not passed.

- [ ] **Step 3: Extract `wireBugFix` in `start.ts`**

Replace the inline construction (the `tracker` / `forge` / `engine` / `prWatcher` block) with a function that can run again, and hold the result in a mutable local:

```ts
  let wiredBugFix: { engine: BugFixEngine; store: BugTaskStore; integrations: IntegrationsStore; tracker: TrackerProvider } | undefined;
  let wiredWatcher: PrWatcher | null = null;

  /**
   * Builds the bug-fix subsystem from a configuration. Returns `null` when there is still no
   * tracker — the one thing the workflow cannot run without. Safe to call again only while
   * nothing is wired: `createApp` enforces the absent→present-once rule.
   */
  let lastCfg: Integrations = cfg;
  const wireBugFix = async (cfg: Integrations) => {
    lastCfg = cfg;
    const tracker = fake ? fakeTracker : (cfg.tracker ? mcpTracker(cfg.tracker, presetsDir) : null);
    if (!tracker) return null;
    const forge = fakeForgeHandle ?? makeForge(cfg.forge);
    const engine = new BugFixEngine({ store, bugs: bugStore, manager, git: new GitOps(), integrations, tracker, forge, presetsDir });
    engine.attach();
    wiredWatcher?.stop();
    wiredWatcher = forge
      ? new PrWatcher({ bugs: bugStore, forge, onFinding: f => engine.onPrFinding(f).catch(err => log(`bugfix: watcher finding failed: ${(err as Error).message}`)),
          onChecked: (id, at) => engine.onPrChecked(id, at).catch(err => log(`bugfix: recording the poll failed: ${(err as Error).message}`)),
          ...(fake ? { baseMs: 200, ceilingMs: 1_000 } : {}) })
      : null;
    wiredWatcher?.start(fake ? 100 : 1_000);
    wiredBugFix = { engine, store: bugStore, integrations, tracker };
    return wiredBugFix;
  };

  await wireBugFix(cfg);
```

then pass the new options to `createApp`:

```ts
    integrations,
    roleResolves: () => { try { store.getRole("bugfix"); return true; } catch { return false; } },
    // Built fresh per call so a forge configured after boot is testable immediately, and so
    // the token getter is re-read rather than captured. `lastCfg` is updated by `wireBugFix`.
    setupForge: () => fakeForgeHandle ?? makeForge(lastCfg.forge),
    onConfigured: async () => (await wireBugFix(await integrations.read())) ?? null,
    ...(wiredBugFix ? { bugs: wiredBugFix } : {}),
```

and expose the engine for the test on the returned handle:

```ts
    bugEngineForTest: () => wiredBugFix?.engine,
```

Add `bugEngineForTest?: () => BugFixEngine | undefined;` to `RunningServer`.

- [ ] **Step 4: Stop the watcher on close**

In the server's `close()`, add `wiredWatcher?.stop();` beside the existing teardown, so a live-wired watcher does not outlive the process in tests.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/start.ts server/test/bugfix/live-wiring.test.ts
git commit -m "feat(setup): first-time configuration takes effect without a restart"
```

---

### Task 6: the Settings dialog

**Files:**
- Create: `ui/src/components/SettingsDialog.tsx`, `ui/src/components/SettingsDialog.test.tsx`
- Modify: `ui/src/api.ts`, `ui/src/types.ts`

**Interfaces:**
- Consumes: `GET /api/setup`, `POST /api/setup/import`, `POST /api/setup/test/tracker`, `POST /api/setup/test/forge`, `PUT /api/integrations`.
- Produces: `<SettingsDialog onClose={() => void} />`.

- [ ] **Step 1: Add the client calls and types**

In `ui/src/types.ts`:

```ts
export type CheckId = "config-file" | "tracker" | "forge" | "forge-username" | "forge-token" | "role";
export interface Check { id: CheckId; state: "ok" | "missing" | "broken"; detail: string; fix?: { kind: "command" | "env" | "field" | "action"; value: string }; blocks: boolean }
export interface DiscoveredServer { name: string; type?: string; url?: string; origin: string; originDetail?: string }
export interface SetupReport {
  ready: boolean; wired: boolean; checks: Check[];
  discovery: { importable: DiscoveredServer[]; accountOnly: string[]; problems: string[] };
  addCommand: string;
}
```

In `ui/src/api.ts` — these go **inside the existing exported `api` object** (around line 28),
following the same one-line-per-call style as `getState`, `createAgent` and the rest. They are
not bare exports; every component and every test reaches them as `api.getSetup()`:

```ts
  getSetup: () => call<SetupReport>("GET", "/api/setup"),
  importMcpServer: (name: string) => call<SetupReport>("POST", "/api/setup/import", { name }),
  testTracker: () => call<{ ok: boolean; message: string }>("POST", "/api/setup/test/tracker"),
  testForge: () => call<{ ok: boolean; message: string }>("POST", "/api/setup/test/forge"),
  saveIntegrations: (patch: Partial<Integrations>) => call<Integrations>("PUT", "/api/integrations", patch),
```

Add `SetupReport` to the type import at the top of the file (`Integrations` is already imported).

- [ ] **Step 2: Write the failing tests**

`ui/src/components/SettingsDialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsDialog } from "./SettingsDialog";
import { api } from "../api";

const report = (over: Partial<import("../types").SetupReport> = {}): import("../types").SetupReport => ({
  ready: false, wired: false, addCommand: "claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp",
  checks: [{ id: "tracker", state: "missing", detail: "No tracker configured.", blocks: true }],
  discovery: { importable: [], accountOnly: [], problems: [] }, ...over,
});

beforeEach(() => vi.restoreAllMocks());

describe("SettingsDialog", () => {
  it("shows the add command when only an account connector exists, and explains why", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({
      checks: [{ id: "tracker", state: "missing", blocks: true,
        detail: "No tracker configured. 1 connector(s) are linked to your Claude account, but account connectors keep their definition server-side — there is nothing to import. Add a local one, then press Detect.",
        fix: { kind: "command", value: "claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp" } }],
      discovery: { importable: [], accountOnly: ["claude.ai Claude Docs"], problems: [] },
    }));
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByText(/keep their definition server-side/)).toBeTruthy();
    expect(screen.getByText(/^claude mcp add --transport http/)).toBeTruthy();
  });

  it("offers Import for a discovered server and re-renders from the response", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({
      discovery: { importable: [{ name: "atlassian", type: "http", url: "https://mcp.atlassian.com/v1/mcp", origin: "user" }], accountOnly: [], problems: [] },
    }));
    const imported = vi.spyOn(api, "importMcpServer").mockResolvedValue(report({
      ready: true, wired: true, checks: [{ id: "tracker", state: "ok", detail: "Tracker configured (mcp, tools mcp__atlassian).", blocks: true }],
    }));
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /import/i }));
    expect(imported).toHaveBeenCalledWith("atlassian");
    await waitFor(() => expect(screen.getByText(/Tracker configured/)).toBeTruthy());
  });

  it("reports a failed test with the provider's own words", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report());
    vi.spyOn(api, "testTracker").mockResolvedValue({ ok: false, message: "MCP server atlassian is not connected" });
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText(/not connected/)).toBeTruthy());
  });

  it("says a restart is needed only when an engine is already running", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ wired: true, ready: true, checks: [] }));
    vi.spyOn(api, "saveIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/restart/i)).toBeTruthy());
  });

  it("omits rebase from the merge methods for bitbucket", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ checks: [{ id: "forge", state: "ok", detail: "Forge: bitbucket.", blocks: true }] }));
    render(<SettingsDialog onClose={() => {}} />);
    await screen.findByText(/Forge: bitbucket/);
    expect(screen.queryByText(/rebase/i)).toBeNull();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd ui && npx vitest run src/components/SettingsDialog.test.tsx`
Expected: FAIL — `Cannot find module './SettingsDialog'`.

- [ ] **Step 4: Implement the dialog**

`ui/src/components/SettingsDialog.tsx` — same `modal`/`dialog` overlay markup and `btn` classes
as `SpawnDialog.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Check, SetupReport } from "../types";

/** A check's remedy, rendered by kind. The UI never authors advice — it renders what the
 *  server derived, so there is no second list of instructions to keep in sync. */
function Fix({ check }: { check: Check }) {
  if (!check.fix) return null;
  const { kind, value } = check.fix;
  if (kind === "command") return (
    <div className="row">
      <code className="cmd">{value}</code>
      <button className="btn" onClick={() => void navigator.clipboard?.writeText(value)}>Copy</button>
    </div>
  );
  if (kind === "env") return <div className="hint">Export <code>{value}</code> in your login shell, then restart AgentGrid.</div>;
  if (kind === "field") return <div className="hint">Set <code>{value}</code> below.</div>;
  return null;
}

function CheckRow({ check }: { check: Check }) {
  const mark = check.state === "ok" ? "●" : "✗";
  return (
    <div className={`checkrow ${check.state}`}>
      <span className="mark">{mark}</span>
      <span className="detail">{check.detail}</span>
      <Fix check={check} />
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trackerTest, setTrackerTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [forgeTest, setForgeTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [preset, setPreset] = useState<"github" | "bitbucket">("github");
  const [username, setUsername] = useState("");
  const [pasted, setPasted] = useState<string | null>(null);
  const [saved, setSaved] = useState<"live" | "restart" | null>(null);

  const load = () => api.getSetup().then(r => { setReport(r); setErr(null); }).catch(e => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);

  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };

  const check = (id: string) => report?.checks.find(c => c.id === id);

  const save = () => run(async () => {
    // `wired` BEFORE the save decides the message: a first-time save wires the engine live,
    // while changing an already-running config needs a restart (nothing is rebuilt under
    // in-flight tasks). Read it before the response replaces the report.
    const wasWired = report?.wired ?? false;
    const body: Record<string, unknown> = { forge: { preset, ...(preset === "bitbucket" ? { username } : {}) } };
    if (pasted !== null) body.tracker = JSON.parse(pasted);
    await api.saveIntegrations(body as never);
    await load();
    setSaved(wasWired ? "restart" : "live");
  });

  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog settings" onClick={e => e.stopPropagation()}>
        <h3>⚙︎ Settings — Integrations</h3>
        {err && <div className="err">{err}</div>}
        {!report ? <div className="hint">Loading…</div> : <>
          <section>
            <h4>Tracker</h4>
            {check("tracker") && <CheckRow check={check("tracker")!} />}
            {report.discovery.importable.map(s => (
              <div key={s.name} className="row">
                <span>{s.name} <span className="hint">({s.type ?? "?"}{s.url ? ` · ${s.url}` : ""} · {s.origin}{s.originDetail ? ` · ${s.originDetail}` : ""})</span></span>
                <button className="btn" disabled={busy} onClick={() => void run(async () => setReport(await api.importMcpServer(s.name)))}>Import</button>
              </div>
            ))}
            {report.discovery.accountOnly.length > 0 && (
              <div className="hint">Linked to your Claude account: {report.discovery.accountOnly.join(", ")}.</div>
            )}
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void run(load)}>Detect</button>
              <button className="btn" disabled={busy} onClick={() => void run(async () => setTrackerTest(await api.testTracker()))}>Test</button>
              <button className="btn" onClick={() => setPasted(pasted === null ? "" : null)}>Paste a definition</button>
            </div>
            {pasted !== null && <textarea className="paste" value={pasted} onChange={e => setPasted(e.target.value)}
              placeholder={'{"preset":"jira","toolPrefix":"mcp__atlassian","mcpServers":{"atlassian":{"type":"http","url":"…"}}}'} />}
            {trackerTest && <div className={trackerTest.ok ? "ok" : "err"}>{trackerTest.message}</div>}
          </section>

          <section>
            <h4>Forge</h4>
            {check("forge") && <CheckRow check={check("forge")!} />}
            <div className="row">
              <select value={preset} onChange={e => setPreset(e.target.value as "github" | "bitbucket")}>
                <option value="github">github</option>
                <option value="bitbucket">bitbucket</option>
              </select>
              {preset === "bitbucket" && <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Atlassian account email" />}
            </div>
            {check("forge-username") && <CheckRow check={check("forge-username")!} />}
            {check("forge-token") && <CheckRow check={check("forge-token")!} />}
            {/* Bitbucket's third strategy is `fast_forward`, which is NOT a rebase — offering
                rebase here would promise an operation the adapter refuses. */}
            <div className="hint">Merge methods: squash, merge{preset === "github" ? ", rebase" : ""}.</div>
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void run(async () => setForgeTest(await api.testForge()))}>Test</button>
            </div>
            {forgeTest && <div className={forgeTest.ok ? "ok" : "err"}>{forgeTest.message}</div>}
          </section>

          {report.discovery.problems.length > 0 && (
            <section>
              <h4>Problems reading your Claude Code configuration</h4>
              {report.discovery.problems.map(p => <div key={p} className="err">{p}</div>)}
            </section>
          )}

          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => void save()}>Save</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
          {saved === "restart" && <div className="hint">Saved. A server restart is required for this to take effect.</div>}
          {saved === "live" && <div className="ok">Saved. The bug-fix workflow is now available.</div>}
        </>}
      </div>
    </div>
  );
}
```

The **Repos** section (the project→repo map, read-only with a clear action per row) renders
from `GET /api/integrations`'s `projectRepos`; add it as a third `<section>` following the same
row markup once the two above are green.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/SettingsDialog.tsx ui/src/components/SettingsDialog.test.tsx ui/src/api.ts ui/src/types.ts
git commit -m "feat(ui): a Settings dialog that says what is missing and how to fix it"
```

---

### Task 7: the two entry points

**Files:**
- Modify: `ui/src/components/TopBar.tsx`, `ui/src/components/BugLauncher.tsx`, `ui/src/components/AgentGrid.tsx`
- Test: `ui/src/components/BugLauncher.test.tsx` (create or append)

**Interfaces:**
- Consumes: `<SettingsDialog>` (Task 6), `getSetup` (Task 6).

- [ ] **Step 1: Write the failing test**

`ui/src/components/BugLauncher.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BugLauncher } from "./BugLauncher";
import { api } from "../api";

beforeEach(() => vi.restoreAllMocks());

describe("BugLauncher when setup is incomplete", () => {
  it("names the blocking checks and offers Settings instead of a bare 501", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue({
      ready: false, wired: false, addCommand: "",
      checks: [
        { id: "tracker", state: "missing", detail: "No tracker configured.", blocks: true },
        { id: "forge-token", state: "missing", detail: "BITBUCKET_API_TOKEN is not visible to the server process.", blocks: false },
      ],
      discovery: { importable: [], accountOnly: [], problems: [] },
    });
    render(<BugLauncher onClose={() => {}} onOpenSettings={() => {}} />);
    expect(await screen.findByText(/No tracker configured/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /settings/i })).toBeTruthy();
    // A non-blocking check must not nag while something else is still blocking.
    expect(screen.queryByText(/BITBUCKET_API_TOKEN/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/components/BugLauncher.test.tsx`
Expected: FAIL — `BugLauncher` takes no `onOpenSettings` and renders no setup summary.

- [ ] **Step 3: Wire the entry points**

- `TopBar.tsx`: add `<button className="btn" onClick={onOpenSettings}>⚙︎ Settings</button>` beside the Fix-a-bug button, with `onOpenSettings: () => void` on its props.
- `AgentGrid.tsx`: hold `settingsOpen` state, render `<SettingsDialog onClose={...} />` when true, and pass `onOpenSettings` to both `TopBar` and `BugLauncher`.
- `BugLauncher.tsx`: call `getSetup()` on mount. When `ready` is false, replace the issue list and the form's error with a short block listing only `checks.filter(c => c.blocks && c.state !== "ok")` details, plus an **Open Settings** button. Keep the existing behaviour untouched when `ready` is true.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: PASS, tsc clean, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components
git commit -m "feat(ui): reach setup from the top bar, and from the dead end itself"
```

---

### Task 8: the role message, the docs and the version

**Files:**
- Modify: `server/src/bugfix/engine.ts`, `README.md`, `desktop/package.json`
- Test: the existing server suite and e2e

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Correct the role message**

`server/src/bugfix/engine.ts`'s `preflight` says the role is "missing from `~/.agentgrid/roles`", which is misleading: the role ships as `server/roles/bugfix.md` and loads from the app's defaults, so it normally resolves even when that directory has no `bugfix.md`. Change the message to name resolution rather than the directory:

```ts
    try { this.deps.store.getRole(this.role); } catch { problems.push(`the "${this.role}" role could not be resolved — it ships with AgentGrid, so this usually means a broken install`); }
```

Update the assertion in the test that covers it.

- [ ] **Step 2: Run the server suite**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Prove the e2e still passes**

Run, from `ui/`: `npx playwright test`
Expected: 7 passed. **This is a gate**: Task 3 moved live routes and Task 5 changed how the server boots. If it fails, stop and report rather than adjusting the test.

- [ ] **Step 4: Rewrite the README's setup section**

Replace the hand-edited-JSON instructions with the screen: open **⚙︎ Settings**, which shows what is missing and what to do about it. Keep the file's shape documented for people who prefer editing it, and keep both Bitbucket facts — `BITBUCKET_API_TOKEN` is exported in the login shell and never written to a config file, and `rebase` is not an available merge method. State that first-time setup takes effect immediately, and that changing an existing configuration needs a restart.

- [ ] **Step 5: Bump**

`desktop/package.json` to `0.4.0`.

- [ ] **Step 6: Run everything**

From `server/`: `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`. From `ui/`: `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `npx playwright test`.
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add server/src/bugfix/engine.ts server/test README.md desktop/package.json
git commit -m "docs(setup): document the Settings screen; correct the role message; 0.4.0"
```

---

## Notes for the executor

- **The scan is read-only, always.** No task in this plan writes anything under `~/.claude`. If an implementation seems to need that, it is wrong — stop and say so.
- **A definition may carry a credential.** `discovery.importable` entries keep their definitions server-side; only `name`, `type`, `url` and origin reach the UI. Task 2's test asserts this with a fixture containing an `Authorization` header — do not weaken it.
- **`GET /api/setup` must answer with every subsystem null.** That is the whole point; a version of it behind the engine guard is the bug this plan exists to fix.
- **Live wiring is absent→present once.** Never re-wire. Task 5's test asserts a second save returns the same engine object.
- **Blocking vs non-blocking matters.** A missing `BITBUCKET_API_TOKEN` does not block starting a bug fix — the forge call fails later with a clear message. Do not make it block; the launcher would then nag about a token while the real problem is a missing tracker.
