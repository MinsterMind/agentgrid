# Use Claude's Own MCP Configuration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop copying MCP server definitions into AgentGrid. Use whatever Claude Code already has — account connectors included — by storing one string, the tool prefix.

**Architecture:** `TrackerConfig` loses `mcpServers`; `mcpTracker` stops passing it and keeps `allowedTools: [toolPrefix]`, which is what actually connects the server. Discovery returns one list of everything Claude Code knows about — account, user, project and repo scope — carrying names, origins and derived prefixes but **no definitions**. Settings replaces Import with "Use this", which writes the prefix.

**Tech Stack:** Node 22 + TypeScript ESM (explicit `.js` suffixes), Express 5, vitest + supertest, React 19 + Vite, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-30-use-claudes-own-mcp-design.md`

## Global Constraints

- Node 22 + TypeScript ESM: every relative import carries an explicit `.js` suffix.
- Tests mirror `src` paths under `server/test/`; the server suite runs from `server/`. UI tests are co-located under `ui/src/`.
- **Nothing under `~/.claude` is ever written.** The scan stays read-only.
- **No definition ever leaves the scanner.** After this plan, `McpServerFound` has no `definition` field at all — the leak class is removed by construction rather than by redaction.
- **`allowedTools: [toolPrefix]` is load-bearing**: it is what flips an account connector from `pending` to `connected`. Never remove it from `mcpTracker`.
- A 0.4.0 config carrying `tracker.mcpServers` must keep working, ignored, and shed the field on the next write.
- Nothing in CI reads a real `~/.claude` or makes a model call.

## Verified facts this plan rests on (spec §2)

- With **no** `mcpServers`, an agent called `mcp__claude_ai_Claude_Docs__guide` through `realQuery`.
- Without the prefix in `allowedTools`, connectors report `status: "pending"` and expose no tools; with it, `status: "connected"`.
- `claude.ai Claude Docs` → `mcp__claude_ai_Claude_Docs`; `claude.ai Kite mcp` → `mcp__claude_ai_Kite_mcp`.

## File structure

| File | Responsibility |
|---|---|
| `server/src/bugfix/mcp-discovery.ts` | one list of every known server; names, origins, prefixes; **no definitions** |
| `server/src/bugfix/integrations.ts` | `TrackerConfig` drops `mcpServers` |
| `server/src/bugfix/tracker.ts` | stop passing `mcpServers`; keep `allowedTools` |
| `server/src/bugfix/setup.ts` | report carries the new list |
| `server/src/api/app.ts` | delete the import route; drop `mcpServers` from validation and write |
| `ui/src/components/SettingsDialog.tsx` | list every source; **Use this** writes the prefix |
| `README.md`, `desktop/package.json` | setup section; 0.5.0 |

---

### Task 1: derive prefixes, and return one list without definitions

**Files:**
- Modify: `server/src/bugfix/mcp-discovery.ts`
- Test: `server/test/bugfix/mcp-discovery.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface McpServerFound {
    name: string;
    toolPrefix: string;                                        // what allowedTools needs
    origin: "account" | "user" | "project" | "repo" | "settings";
    originDetail?: string;
  }
  export interface Discovery { servers: McpServerFound[]; problems: string[] }
  export function toolPrefixFor(name: string): string;
  export function discoverMcpServers(opts: { home?: string; repo?: string }): Promise<Discovery>;
  ```
  `definition` and `accountOnly` are **removed**. Account connectors are ordinary entries with `origin: "account"`.

- [ ] **Step 1: Write the failing tests**

Replace the `accountOnly` test and add these to `server/test/bugfix/mcp-discovery.test.ts`:

```ts
import { discoverMcpServers, toolPrefixFor } from "../../src/bugfix/mcp-discovery.js";

describe("toolPrefixFor", () => {
  // Both verified against a live session's tool list on 2026-09-30 (spec §2).
  it("derives the prefix Claude Code uses for an account connector", () => {
    expect(toolPrefixFor("claude.ai Claude Docs")).toBe("mcp__claude_ai_Claude_Docs");
    expect(toolPrefixFor("claude.ai Kite mcp")).toBe("mcp__claude_ai_Kite_mcp");
  });
  it("derives the plain prefix for a locally defined server", () => {
    expect(toolPrefixFor("atlassian")).toBe("mcp__atlassian");
  });
  it("replaces every space, not just the first", () => {
    expect(toolPrefixFor("claude.ai Google Calendar")).toBe("mcp__claude_ai_Google_Calendar");
  });
});

describe("discoverMcpServers", () => {
  it("returns account connectors as ordinary, usable entries", async () => {
    const home = await fakeHome({ claudeAiMcpEverConnected: ["claude.ai Atlassian"] });
    const d = await discoverMcpServers({ home });
    expect(d.servers).toEqual([
      { name: "claude.ai Atlassian", toolPrefix: "mcp__claude_ai_Atlassian", origin: "account" },
    ]);
  });

  it("returns one list across every source, each carrying where it came from", async () => {
    const home = await fakeHome({
      mcpServers: { local: { type: "http", url: "https://example.invalid" } },
      projects: { "/Users/x/repo": { mcpServers: { proj: { command: "npx" } } } },
      claudeAiMcpEverConnected: ["claude.ai Atlassian"],
    });
    const d = await discoverMcpServers({ home });
    expect(d.servers.map(s => [s.name, s.origin])).toEqual(
      expect.arrayContaining([["local", "user"], ["proj", "project"], ["claude.ai Atlassian", "account"]]),
    );
  });

  it("never returns a definition, so a credential cannot escape the scanner", async () => {
    const home = await fakeHome({
      mcpServers: { x: { type: "http", url: "https://e.invalid", headers: { Authorization: "Bearer hunter2" } } },
    });
    const d = await discoverMcpServers({ home });
    expect(JSON.stringify(d)).not.toContain("hunter2");
    expect(JSON.stringify(d)).not.toContain("Authorization");
    expect(d.servers[0]).toEqual({ name: "x", toolPrefix: "mcp__x", origin: "user" });
  });

  it("ignores a non-string entry in the account list", async () => {
    const home = await fakeHome({ claudeAiMcpEverConnected: ["claude.ai Atlassian", 42, null] });
    const d = await discoverMcpServers({ home });
    expect(d.servers.map(s => s.name)).toEqual(["claude.ai Atlassian"]);
  });
});
```

Keep the existing malformed-file, missing-home and scope-precedence tests; update their expectations to the `servers` shape.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/mcp-discovery.test.ts`
Expected: FAIL — `toolPrefixFor` is not exported and `d.servers` is undefined.

- [ ] **Step 3: Implement**

```ts
/**
 * The tool prefix Claude Code exposes a server's tools under. Verified 2026-09-30 against a
 * live session: `claude.ai Claude Docs` → `mcp__claude_ai_Claude_Docs`. Naming this prefix in
 * `allowedTools` is what connects an account connector — without it the session reports the
 * server `pending` and exposes none of its tools (spec §2).
 */
export function toolPrefixFor(name: string): string {
  return `mcp__${name.replace(/^claude\.ai /, "claude_ai_").replace(/ /g, "_")}`;
}
```

Change `collect` to store `{ name, toolPrefix: toolPrefixFor(name), origin, originDetail }` and drop `definition` entirely. Add account connectors to the same map **before** the local scopes, so a locally defined server of the same name wins:

```ts
  const account = Array.isArray(claudeJson?.claudeAiMcpEverConnected) ? claudeJson.claudeAiMcpEverConnected : [];
  for (const n of account) {
    if (typeof n === "string") found.set(n, { name: n, toolPrefix: toolPrefixFor(n), origin: "account" });
  }
```

Return `{ servers: [...found.values()], problems }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/bugfix/mcp-discovery.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/bugfix/mcp-discovery.ts server/test/bugfix/mcp-discovery.test.ts
git commit -m "feat(setup): one list of every MCP server Claude Code knows, no definitions"
```

---

### Task 2: stop storing and passing definitions

**Files:**
- Modify: `server/src/bugfix/integrations.ts`, `server/src/bugfix/tracker.ts`
- Test: `server/test/bugfix/integrations.test.ts`, `server/test/bugfix/tracker.test.ts`

**Interfaces:**
- Produces: `export interface TrackerConfig { preset: string; toolPrefix: string; hints?: string }`

- [ ] **Step 1: Write the failing tests**

```ts
// integrations.test.ts
it("loads a 0.4.0 config that still carries mcpServers, and drops it on the next write", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ag-migrate-"));
  await writeFile(path.join(home, "integrations.json"), JSON.stringify({
    tracker: { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: { atlassian: { headers: { Authorization: "Bearer old" } } } },
    projectRepos: {},
  }));
  const store = new IntegrationsStore(home);
  expect((await store.read()).tracker?.toolPrefix).toBe("mcp__atlassian");   // still works
  await store.write({ tracker: { preset: "jira", toolPrefix: "mcp__atlassian" } });
  const raw = await readFile(path.join(home, "integrations.json"), "utf8");
  expect(raw).not.toContain("Authorization");                                 // shed on write
  expect(raw).not.toContain("mcpServers");
});
```

```ts
// tracker.test.ts — the load-bearing assertion of this whole plan
it("passes the tool prefix in allowedTools and no mcpServers at all", async () => {
  const seen: any[] = [];
  const t = mcpTracker({ preset: "jira", toolPrefix: "mcp__claude_ai_Atlassian" }, presetsDir,
    async (opts) => { seen.push(opts); return "[]"; });
  await t.listMyIssues();
  expect(seen[0].allowedTools).toEqual(["mcp__claude_ai_Atlassian"]);
  expect(seen[0].mcpServers).toBeUndefined();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/integrations.test.ts test/bugfix/tracker.test.ts`
Expected: FAIL — `mcpServers` is still written, and `mcpTracker` still passes it.

- [ ] **Step 3: Implement**

`integrations.ts`: `export interface TrackerConfig { preset: string; toolPrefix: string; hints?: string }`.

`tracker.ts`: drop `mcpServers` from the `ask` call and from `defaultJsonRunner`'s options:

```ts
    run({ prompt: await section(presetsDir, cfg.preset, name, { hints: cfg.hints ?? "", ...vars }),
          allowedTools: [cfg.toolPrefix], cwd: process.cwd() });
```

and remove `mcpServers` from `JsonRunner`'s type and from the `realQuery` options object. **Leave `allowedTools` exactly as it is** — it is what connects the server.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, tsc clean. Type errors will point at every remaining reader of `mcpServers` — fix each by deletion, not by casting.

- [ ] **Step 5: Commit**

```bash
git add server/src/bugfix/integrations.ts server/src/bugfix/tracker.ts server/test
git commit -m "feat(setup): the tracker is a prefix, not a copy of your connection"
```

---

### Task 3: the routes

**Files:**
- Modify: `server/src/api/app.ts`, `server/src/bugfix/setup.ts`
- Test: `server/test/bugfix/setup-routes.test.ts`, `server/test/bugfix/setup.test.ts`, `server/test/bugfix/api.test.ts`

**Interfaces:**
- Consumes: `Discovery` (Task 1), `TrackerConfig` (Task 2).
- Produces: `SetupReport.discovery` becomes `{ servers: McpServerFound[]; problems: string[] }`. `POST /api/setup/import` is **deleted**.

- [ ] **Step 1: Write the failing tests**

```ts
// setup-routes.test.ts
it("no longer offers an import route", async () => {
  const { app } = await unwiredApp();
  await request(app).post("/api/setup/import").send({ name: "whatever" }).expect(404);
});

it("reports every server Claude Code knows, with its prefix, and no definitions", async () => {
  const { app, claudeHome } = await unwiredApp();
  await writeFile(path.join(claudeHome, ".claude.json"), JSON.stringify({
    mcpServers: { jira: { command: "npx", headers: { Authorization: "Bearer sk-secret" } } },
    claudeAiMcpEverConnected: ["claude.ai Atlassian"],
  }));
  const res = await request(app).get("/api/setup").expect(200);
  expect(res.body.discovery.servers).toEqual(expect.arrayContaining([
    { name: "claude.ai Atlassian", toolPrefix: "mcp__claude_ai_Atlassian", origin: "account" },
    { name: "jira", toolPrefix: "mcp__jira", origin: "user" },
  ]));
  expect(JSON.stringify(res.body)).not.toContain("sk-secret");
});

it("accepts a tracker that is only a preset and a prefix", async () => {
  const { app, integrations } = await unwiredApp();
  await request(app).put("/api/integrations")
    .send({ tracker: { preset: "jira", toolPrefix: "mcp__claude_ai_Atlassian" } }).expect(200);
  expect((await integrations.read()).tracker).toEqual({ preset: "jira", toolPrefix: "mcp__claude_ai_Atlassian" });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix`
Expected: FAIL — the import route still answers, and `discovery.servers` is undefined.

- [ ] **Step 3: Implement**

- Delete the `POST /api/setup/import` handler and its imports.
- In `setup.ts`, map `discovery` straight through — it now carries only safe fields, so the mapping that stripped definitions is deleted, not adjusted.
- In `app.ts`'s `PUT /api/integrations`, remove the two `tracker.mcpServers` lines (the shape check and `t.mcpServers = …`). Leave `redactIntegrations` in place: a pre-0.5.0 file may still contain the field.
- The `tracker` check in `setup.ts` still keys on `toolPrefix`; its `fix` becomes `{ kind: "action", value: "use:<prefix>" }` when a server is available, else the `claude mcp add` command.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/app.ts server/src/bugfix/setup.ts server/test
git commit -m "feat(setup): drop the import route; report what Claude Code already has"
```

---

### Task 4: Settings picks, rather than imports

**Files:**
- Modify: `ui/src/components/SettingsDialog.tsx`, `ui/src/api.ts`, `ui/src/types.ts`
- Test: `ui/src/components/SettingsDialog.test.tsx`

**Interfaces:**
- Consumes: `SetupReport.discovery.servers` (Task 3).

- [ ] **Step 1: Write the failing tests**

```tsx
it("lists every server Claude Code knows, with where it came from", async () => {
  vi.spyOn(api, "getSetup").mockResolvedValue(report({ discovery: { problems: [], servers: [
    { name: "claude.ai Atlassian", toolPrefix: "mcp__claude_ai_Atlassian", origin: "account" },
    { name: "jira", toolPrefix: "mcp__jira", origin: "project", originDetail: "/Users/x/repo" },
  ] } }));
  render(<SettingsDialog onClose={() => {}} />);
  expect(await screen.findByText(/claude\.ai Atlassian/)).toBeTruthy();
  expect(screen.getByText(/linked to your Claude account/i)).toBeTruthy();
  expect(screen.getByText(/\/Users\/x\/repo/)).toBeTruthy();
});

it("Use this writes only the prefix", async () => {
  vi.spyOn(api, "getSetup").mockResolvedValue(report({ discovery: { problems: [], servers: [
    { name: "claude.ai Atlassian", toolPrefix: "mcp__claude_ai_Atlassian", origin: "account" },
  ] } }));
  const put = vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
  render(<SettingsDialog onClose={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: /use this/i }));
  expect(put).toHaveBeenCalledWith(expect.objectContaining({
    tracker: expect.objectContaining({ toolPrefix: "mcp__claude_ai_Atlassian" }),
  }));
  const sent = put.mock.calls[0][0] as any;
  expect(sent.tracker.mcpServers).toBeUndefined();
});

it("still shows the add command when Claude Code has nothing", async () => {
  vi.spyOn(api, "getSetup").mockResolvedValue(report({ discovery: { servers: [], problems: [] } }));
  render(<SettingsDialog onClose={() => {}} />);
  expect(await screen.findByText(/^claude mcp add --transport http/)).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run src/components/SettingsDialog.test.tsx`
Expected: FAIL — the component renders `discovery.importable` and an Import button.

- [ ] **Step 3: Implement**

Replace the importable/accountOnly rendering with one list over `report.discovery.servers`. Each row shows the name, a plain-language origin (`account` → "linked to your Claude account", `user` → "configured in Claude Code", `project`/`repo` → "configured for `<originDetail>`"), and a **Use this** button calling `api.putIntegrations({ tracker: { preset, toolPrefix: s.toolPrefix } })` with the preset from the existing selector. Keep the empty-list branch and the `addCommand` exactly as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: PASS, tsc clean, build clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(ui): pick a tracker Claude Code already has, instead of importing one"
```

---

### Task 5: the header close, the docs and the version

**Files:**
- Modify: `ui/src/components/SettingsDialog.tsx`, `ui/src/styles.css`, `README.md`, `desktop/package.json`
- Test: `ui/src/components/SettingsDialog.test.tsx`

This task also fixes a bug reported against 0.4.0: **Settings has no visible way out.** Its only exits are a Close button below the fold, the backdrop, and Escape — while `SessionsPanel.tsx:54` and `TranscriptView.tsx:30`, the app's other scrollable panels, both put a `✕` in the header.

- [ ] **Step 1: Write the failing test**

```tsx
it("can be dismissed from the header, without scrolling to the bottom", async () => {
  vi.spyOn(api, "getSetup").mockResolvedValue(report());
  const onClose = vi.fn();
  render(<SettingsDialog onClose={onClose} />);
  await userEvent.click(await screen.findByRole("button", { name: "✕" }));
  expect(onClose).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/components/SettingsDialog.test.tsx`
Expected: FAIL — no `✕` button exists.

- [ ] **Step 3: Implement**

Wrap the heading in the same header row the other panels use, with the `✕` pushed right:

```tsx
        <div className="hd"><h3 style={{ margin: 0 }}>⚙︎ Settings — Integrations</h3>
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={onClose}>✕</button></div>
```

and make the footer row stick to the bottom of the scrolling dialog so Save stays reachable:

```css
.dialog.settings .row:last-of-type { position:sticky; bottom:0; background:var(--panel); padding-top:8px; }
```

- [ ] **Step 4: Rewrite the README's setup section**

Say what is now true: AgentGrid uses the MCP servers Claude Code already has, including account connectors — open **⚙︎ Settings**, pick one, done. Keep the `claude mcp add` command for the case where Claude Code has nothing. **Delete any instruction to copy a definition into `integrations.json`**, and state that AgentGrid stores no credential of its own.

- [ ] **Step 5: Bump** `desktop/package.json` to `0.5.0`.

- [ ] **Step 6: Run everything**

From `server/`: `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`. From `ui/`: `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `npx playwright test`.
Expected: all green. **Note:** `bugfix.spec.ts` has a known pre-existing intermittent that fails on slow runs (~45s) and passes warm (~19s). If you hit it, re-run and say so; do not modify the spec.

- [ ] **Step 7: Commit**

```bash
git add ui/src README.md desktop/package.json
git commit -m "feat(ui): a header close for Settings; document the new setup; 0.5.0"
```

---

## Notes for the executor

- **`allowedTools: [toolPrefix]` is the mechanism, not a detail.** It is what flips an account connector from `pending` to `connected`. Task 2's tracker test is the one assertion in this plan that, if it stops holding, means the feature does not work at all.
- **No definition may appear in any output.** After Task 1 the scanner has no definition to leak; Task 3's route test asserts a planted `Bearer sk-secret` never reaches the response.
- **Do not delete `redactIntegrations`.** A pre-0.5.0 `integrations.json` can still contain `tracker.mcpServers`, and the redaction is what keeps it off the wire.
- **The live check in spec §9 is not optional before calling this done**: §2 was verified against `claude.ai Claude Docs`, not against the user's `claude.ai Atlassian`. Re-run the probe against the real connector.
