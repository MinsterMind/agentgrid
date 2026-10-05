# Mission Control — Phase 3 (0.9.0): first run, dialogs, Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-run screen that teaches the app by doing, a New agent dialog with role cards and a live repo check, a Fix a bug dialog laid out as numbered steps with "what happens next", and Settings as a readiness checklist — all in Mission Control style.

**Architecture:** Three small server additions (role `description`, `GET /api/repo-status`, a redacted `remote` in bug-fix preflight) feed the UI. Dialog primitives (`.dialog .dlg-* .field .label .help .input .errtext/.oktext/.warntext .seg .step-n`) join the stylesheet once and are used by all three dialogs. `SpawnDialog`, `BugLauncher` and `SettingsDialog` keep their logic and tests' behaviours; their markup is rebuilt around the primitives. `FirstRun` replaces the grid+side panel while there are no agents and no bug tasks.

**Tech Stack:** Node/Express server (vitest), React 19 + vanilla CSS + lucide-react (vitest + Testing Library), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-mission-control-ui-design.md` §7 (and §4, §8). Visual references: drafts `450ec38d-…` (first run), `e3c62078-…` (dialogs), `11a05789-…` (Settings); source HTML in `.superdesign/tmp/first-run.html`, `dialogs.html`, `settings.html`.

## Global Constraints

- Phase 1 tokens only; `--text-faint` never for essential copy.
- Status = icon + word + colour. No emoji in UI chrome (role avatars are content and stay).
- **Auto-merge stays disabled**, labelled "coming later". Nothing implements it.
- No branch-name field (branches are generated as `bugfix/<KEY>`); inline validation goes on the ticket-key input.
- `GET /api/repo-status` refuses a path outside the browse root exactly as `/api/fs` does (same `listDir` root rule); the dialog then shows no status line rather than an error.
- Preflight's `remote` never carries a password (`https://user:pass@…` → `https://user@…`).
- First-run start buttons must not share accessible names with top-bar buttons (`New agent`, `Fix a bug`, `Sessions`) — e2e clicks those by name. Use `Create an agent`, `Show sessions`, `Start a bug fix`.
- Keys `n` / `b` / `s` open New agent / Fix a bug / Sessions everywhere, inert while typing (same guard as today's keys).
- Keep every existing test behaviour; update only assertions on copy or layout that the spec deliberately changes, and ledger each.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019vk3Y8Lj3YYsuDjzfQ2MBB
  ```

## Review Focus

1. **A role file written before descriptions existed** (an existing install's `~/.agentgrid/roles/*.md`) — the card shows the prompt's first sentence, never "undefined" or an empty line. Pinned in Task 1.
2. **Typing a repo path character by character** — the repo-status request must be debounced and a stale answer for an earlier path must never show for the current one. Pinned in Task 3.
3. **The first task is filled but creating the agent fails** (e.g. duplicate id) — no assign is attempted and the error is shown in the dialog. Pinned in Task 3.
4. **A pasted ticket URL in Fix a bug** — must be accepted as valid, not flagged by the key-format check. Pinned in Task 4.
5. **First run while live Claude sessions exist but no agents** — the first-run screen shows, with the session count on its card; the running sessions are one click away. Pinned in Task 6.

---

### Task 1: Server — role descriptions, repo status, preflight remote

**Files:**
- Modify: `server/src/types.ts` (`RoleDef.description`), `server/src/store/roles.ts` (`parseRole`), `server/roles/*.md` (7 files), `server/src/fs.ts` (`repoStatus`), `server/src/api/app.ts` (route), `server/src/bugfix/engine.ts` (preflight `remote`), `server/src/bugfix/forge/bitbucket.ts` (export `redactRemote`)
- Test: `server/test/roles.test.ts`, `server/test/fs.test.ts` (create if absent), `server/test/bugfix/engine.test.ts`, `server/test/api.test.ts` (or the file that tests `/api/fs`)

**Interfaces:**
- Produces: `RoleDef.description: string`; `repoStatus(root: string, target: string, run?: Runner): Promise<{ exists: boolean; isRepo: boolean; branch: string | null; clean: boolean | null }>` (throws `OutsideRoot` like `listDir`); `GET /api/repo-status?path=` → that shape (400 outside root); `engine.preflight(repo)` → `{ ok, problems, remote: string | null }`; `export const redactRemote` in `bitbucket.ts`.

- [ ] **Step 1: Write the failing tests**

`server/test/roles.test.ts` — add:

```ts
describe("role description", () => {
  it("reads description from frontmatter", () => {
    expect(parseRole("---\nmodel: m\ndescription: Writes code.\n---\nYou are…", "x").description).toBe("Writes code.");
  });
  // Review Focus 1
  it("falls back to the prompt's first sentence for a role written before descriptions existed", () => {
    expect(parseRole("---\nmodel: m\n---\nYou review diffs carefully. You never edit.", "x").description).toBe("You review diffs carefully.");
    expect(parseRole("---\nmodel: m\n---\n", "x").description).toBe("");
  });
  it("every shipped role has its own description", async () => {
    for (const r of await loadRoles(path.resolve("roles"))) expect(r.description.length).toBeGreaterThan(10);
  });
});
```

`server/test/fs.test.ts` — add (create the file with the imports if absent):

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repoStatus } from "../src/fs.js";

describe("repoStatus", () => {
  it("reports branch and cleanliness of a git repo", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rs-")); const repo = path.join(root, "r"); await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
    expect(await repoStatus(root, repo)).toEqual({ exists: true, isRepo: true, branch: "main", clean: true });
    await writeFile(path.join(repo, "f"), "x");
    expect((await repoStatus(root, repo)).clean).toBe(false);
  });
  it("says a plain folder is not a repo, and a missing one does not exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rs-")); await mkdir(path.join(root, "plain"));
    expect(await repoStatus(root, path.join(root, "plain"))).toEqual({ exists: true, isRepo: false, branch: null, clean: null });
    expect(await repoStatus(root, path.join(root, "nope"))).toEqual({ exists: false, isRepo: false, branch: null, clean: null });
  });
  it("refuses a path outside the root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rs-"));
    await expect(repoStatus(root, "/etc")).rejects.toThrow(/inside/);
  });
});
```

`server/test/bugfix/engine.test.ts` — add:

```ts
describe("preflight", () => {
  it("names the remote it found, without a password", async () => {
    const g = fakeGit(gitState).git; g.hasRemote = async () => "https://me:s3cret@bitbucket.org/acme/pay.git";
    const e = new BugFixEngine({ store, bugs, manager: new Manager(store, { queryFn: fake.queryFn, buildOptions: (_r, a, x) => ({ cwd: a.repo, abortController: x.abortController, canUseTool: x.canUseTool } as Options) }),
      git: g, integrations: new IntegrationsStore(home), tracker: { listMyIssues: async () => [], fetchIssue: async () => ISSUE, comment: async () => {} }, forge, presetsDir: path.resolve("presets") });
    const p = await e.preflight(repo);
    expect(p.remote).toBe("https://me@bitbucket.org/acme/pay.git");
    expect(JSON.stringify(p)).not.toContain("s3cret");
  });
  it("remote is null when there is none", async () => {
    const g = fakeGit(gitState).git; g.hasRemote = async () => null;
    const e = new BugFixEngine({ store, bugs, manager: new Manager(store, { queryFn: fake.queryFn, buildOptions: (_r, a, x) => ({ cwd: a.repo, abortController: x.abortController, canUseTool: x.canUseTool } as Options) }),
      git: g, integrations: new IntegrationsStore(home), tracker: { listMyIssues: async () => [], fetchIssue: async () => ISSUE, comment: async () => {} }, forge, presetsDir: path.resolve("presets") });
    expect((await e.preflight(repo)).remote).toBeNull();
  });
});
```

API route — in the test file that covers `GET /api/fs` (find with `grep -rln "api/fs" server/test`), add next to it:

```ts
  it("GET /api/repo-status reports a folder under the browse root and refuses one outside", async () => {
    // build the app the way the neighbouring /api/fs test does, with browseRoot = a temp dir containing "plain/"
    const ok = await request(app).get(`/api/repo-status?path=${encodeURIComponent(path.join(root, "plain"))}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ exists: true, isRepo: false, branch: null, clean: null });
    expect((await request(app).get("/api/repo-status?path=/etc")).status).toBe(400);
  });
```

(Use exactly the app construction, `root` creation and `request` helper of the neighbouring `/api/fs` test.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/roles.test.ts test/fs.test.ts test/bugfix/engine.test.ts -t "description|repoStatus|preflight"` and the API test file.
Expected: FAIL — no description, no `repoStatus`, no `remote`, 404 route.

- [ ] **Step 3: Implement**

`types.ts` `RoleDef`: add `description: string;`.

`roles.ts` `parseRole` return object: add

```ts
    description: typeof data.description === "string" && data.description.trim()
      ? data.description.trim()
      : (content.trim().match(/^[^.!?\n]*[.!?]/)?.[0] ?? "").trim(),
```

Shipped roles — add a `description:` line to each frontmatter:
- `coder.md`: `Writes and changes code, runs the tests, commits small.`
- `reviewer.md`: `Reads diffs and points out problems. Doesn't edit code.`
- `tester.md`: `Writes and runs tests for a change, and reports what fails.`
- `devops.md`: `Infra, builds and deploys. Asks before every command.`
- `architect.md`: `Designs before building. Writes plans, not code.`
- `demo-prep.md`: `Prepares demos: scripts, data and a clean walkthrough.`
- `bugfix.md`: `Used by "Fix a bug": works in its own worktree, gated at every step.`

`fs.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
type Runner = (cmd: string, args: string[], cwd: string) => Promise<string>;
const defaultRun: Runner = async (cmd, args, cwd) => (await exec(cmd, args, { cwd, timeout: 5_000 })).stdout;

/** What the New agent dialog says about a folder: there, a git repo, which branch, clean or not.
 *  Confined to the browse root exactly as `listDir` is. */
export async function repoStatus(root: string, target: string, run: Runner = defaultRun):
  Promise<{ exists: boolean; isRepo: boolean; branch: string | null; clean: boolean | null }> {
  const base = path.resolve(root); const dir = path.resolve(target);
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new OutsideRoot(`path must be inside ${base}`);
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return { exists: false, isRepo: false, branch: null, clean: null };
  try {
    const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir)).trim();
    const dirty = (await run("git", ["status", "--porcelain"], dir)).trim().length > 0;
    return { exists: true, isRepo: true, branch, clean: !dirty };
  } catch {
    return { exists: true, isRepo: false, branch: null, clean: null };
  }
}
```

`app.ts`, after the `/api/fs` route:

```ts
  app.get("/api/repo-status", wrap(async (req, res) => {
    const p = req.query.path;
    if (typeof p !== "string" || !p) throw new BadRequest("path must be a string");
    res.json(await repoStatus(deps.browseRoot ?? os.homedir(), p));
  }));
```

(import `repoStatus` from `../fs.js`; `OutsideRoot` is already mapped to 400 for `/api/fs` — confirm in the error handler and reuse.)

`bitbucket.ts`: change `const redactRemote` to `export const redactRemote`.

`engine.ts` `preflight`: 

```ts
    const remote = await this.deps.git.hasRemote(repo);
    if (!remote) problems.push("this repo has no `origin` remote");
    …
    return { ok: problems.length === 0, problems, remote: remote ? redactRemote(remote) : null };
```

(import `redactRemote` from `./forge/bitbucket.js`; update the method's return type.)

`ui/src/api.ts`: add `repoStatus: (path: string) => call<{ exists: boolean; isRepo: boolean; branch: string | null; clean: boolean | null }>("GET", `/api/repo-status?path=${encodeURIComponent(path)}`)`, and change `bugPreflight`'s type to `{ ok: boolean; problems: string[]; remote?: string | null }`.

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit && cd ../ui && npx tsc -p tsconfig.json --noEmit`
Expected: PASS. UI fixtures building a `RoleDef` without `description` fail typecheck — add `description: ""` to them.

- [ ] **Step 5: Commit**

```bash
git add server ui/src/api.ts ui/test
git commit -m "feat(server): role descriptions, a repo status check, and the remote preflight found"
```

---

### Task 2: Dialog primitives

**Files:**
- Modify: `ui/src/styles.css` (replace `.modal`, `.dialog`, `.dialog label`, `.dialog input, .dialog select`, `.dialog.wide`, `.dialog h4`, `.dialog.settings*` rules; add primitives)
- Test: `ui/test/styles.test.ts`

**Interfaces:**
- Produces: `.modal` (scrim + centring), `.dialog` (+ `.wide` 720px, `.settings` 880px), `.dlg-hd` (+ `h2`, `p`), `.dlg-ic` (+ `.amber`), `.dlg-body`, `.dlg-ft`, `.x` (close button), `.field`, `.label`, `.help`, `.input` (+ `.err`), `.errtext .oktext .warntext`, `.seg` (+ `button.on`), `.step-n` (+ `.done .on`), `.opt` (+ `.sel`, `.disabled`), `.radio`, `.next` (+ `.dot.c .dot.a`).

- [ ] **Step 1: Write the failing test**

```ts
  it("defines the dialog primitives every dialog shares", () => {
    for (const sel of [".dlg-hd", ".dlg-body", ".dlg-ft", ".dlg-ic", ".field", ".label", ".help", ".input", ".errtext", ".oktext", ".warntext", ".seg", ".step-n", ".opt", ".radio", ".next"]) {
      expect(css).toMatch(new RegExp(`(^|[}\\s])${sel.replace(".", "\\.")}\\s*[{.:\\s,]`, "m"));
    }
    expect(css).toMatch(/\.modal\s*\{[^}]*backdrop-filter/);
  });
```

- [ ] **Step 2: Run to verify it fails** — `cd ui && npx vitest run test/styles.test.ts` → FAIL.

- [ ] **Step 3: Implement** — replace the listed dialog rules with:

```css
.modal { position:fixed; inset:0; background:rgba(3,5,8,.74); backdrop-filter:blur(2px); display:flex; align-items:center; justify-content:center; padding:20px; z-index:20; }
.dialog { position:relative; background:var(--surface); border:1px solid var(--grid-line); border-radius:10px; box-shadow:0 0 0 1px #22D3EE1a, 0 24px 60px rgba(0,0,0,.6); width:520px; max-width:100%; max-height:100%; display:flex; flex-direction:column; overflow:hidden; }
.dialog.wide { width:720px; } .dialog.settings { width:880px; }
.dlg-hd { display:flex; align-items:flex-start; gap:12px; padding:16px 18px 12px; border-bottom:1px solid var(--grid-line); }
.dlg-hd h2 { margin:0; font-size:15px; font-weight:600; } .dlg-hd p { margin:3px 0 0; font-size:12px; color:var(--text-muted); }
.dlg-ic { width:32px; height:32px; border-radius:6px; display:flex; align-items:center; justify-content:center; background:rgba(34,211,238,.08); color:var(--accent); border:1px solid #22D3EE44; flex:none; }
.dlg-ic.amber { color:var(--st-needs-you); background:rgba(251,191,36,.08); border-color:#FBBF2444; }
.dlg-body { padding:16px 18px; display:flex; flex-direction:column; gap:18px; overflow:auto; }
.dlg-ft { padding:12px 18px; border-top:1px solid var(--grid-line); display:flex; align-items:center; gap:10px; }
.dlg-ft .help { flex:1; }
.x { margin-left:auto; color:var(--text-muted); width:28px; height:28px; display:inline-flex; align-items:center; justify-content:center; border-radius:4px; border:1px solid transparent; background:transparent; cursor:pointer; }
.x:hover { border-color:var(--grid-line); color:var(--text); }
.field { display:flex; flex-direction:column; gap:6px; }
.label { font-size:12px; font-weight:500; color:var(--text); display:flex; align-items:center; gap:6px; }
.help { font-size:11.5px; color:var(--text-muted); }
.input { min-height:32px; background:var(--bg); border:1px solid var(--grid-line); border-radius:4px; color:var(--text); padding:6px 10px; font:inherit; font-size:12.5px; outline:none; width:100%; }
.input:focus { border-color:var(--accent); box-shadow:0 0 0 3px #22D3EE22; }
.input.err { border-color:var(--st-failed); box-shadow:0 0 0 3px #F8717122; }
textarea.input { resize:none; }
.errtext, .oktext, .warntext { font-size:11.5px; display:flex; gap:6px; align-items:center; }
.errtext { color:var(--st-failed); } .oktext { color:var(--st-done); } .warntext { color:var(--st-needs-you); }
.seg { display:inline-flex; border:1px solid var(--grid-line); border-radius:4px; overflow:hidden; }
.seg button { min-height:28px; padding:0 14px; background:transparent; border:0; color:var(--text-muted); font:inherit; font-size:12px; cursor:pointer; display:inline-flex; gap:6px; align-items:center; }
.seg button.on { background:var(--surface-raised); color:var(--accent); box-shadow:inset 0 -2px 0 var(--accent); }
.step-n { width:20px; height:20px; border-radius:50%; border:1px solid var(--grid-line); display:inline-flex; align-items:center; justify-content:center; font-family:var(--mono); font-size:10.5px; color:var(--text-muted); flex:none; }
.step-n.done { border-color:var(--st-done); color:var(--st-done); background:rgba(52,211,153,.08); }
.step-n.on { border-color:var(--accent); color:var(--accent); box-shadow:0 0 10px #22D3EE44; }
.opt { display:flex; gap:10px; padding:10px; border-radius:6px; border:1px solid var(--grid-line); background:var(--bg); cursor:pointer; text-align:left; color:inherit; font:inherit; }
.opt.sel { border-color:var(--accent); background:rgba(34,211,238,.04); }
.opt.disabled { cursor:not-allowed; opacity:.6; }
.radio { width:14px; height:14px; border-radius:50%; border:1px solid var(--text-muted); margin-top:2px; flex:none; }
.opt.sel .radio { border:4px solid var(--accent); box-shadow:0 0 8px #22D3EE66; }
.next { display:flex; align-items:center; gap:6px; padding:10px 12px; border-radius:6px; background:var(--bg); border:1px dashed var(--grid-line); font-size:11.5px; color:var(--text-muted); flex-wrap:wrap; }
.next .dot { width:8px; height:8px; border-radius:50%; background:var(--grid-line); }
.next .dot.c { background:var(--st-working); box-shadow:0 0 6px var(--st-working); } .next .dot.a { background:var(--st-needs-you); box-shadow:0 0 6px var(--st-needs-you); }
```

- [ ] **Step 4: Run tests** — `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit` → PASS. (Dialogs still use `<label>` markup until Tasks 3–5; their look will be plainer in between — expected.)

- [ ] **Step 5: Commit** — `git commit -m "feat(ui): dialog primitives shared by every dialog"`

---

### Task 3: New agent dialog — role cards, live repo check, first task

**Files:**
- Modify: `ui/src/components/SpawnDialog.tsx`, `ui/src/App.tsx` (`onSpawn` creates then assigns)
- Test: `ui/test/SpawnDialog.test.tsx`, `ui/test/App.test.tsx`, `ui/e2e/smoke.spec.ts` (submit label)

**Interfaces:**
- Consumes: `RoleDef.description`, `api.repoStatus`.
- Produces: `SpawnDialog` `onSpawn(input: { role: string; repo: string; displayName?: string; task?: string })`; role cards are `button[role="radio"][aria-checked]` inside `div[role="radiogroup"][aria-label="Role"]`; repo status line `data-testid="repo-status"`; submit button `Create agent`.

- [ ] **Step 1: Write the failing tests**

Add to `ui/test/SpawnDialog.test.tsx` (extend its `api` mock with `repoStatus: vi.fn()`; give its role fixtures `description`):

```tsx
describe("New agent dialog", () => {
  it("offers roles as cards that say what each does and which model it uses", async () => {
    render(<SpawnDialog roles={[{ ...role("coder"), description: "Writes and changes code." }]} recentRepos={[]} onSpawn={vi.fn()} onClose={vi.fn()} />);
    const card = screen.getByRole("radio", { name: /coder/i });
    expect(card).toHaveTextContent("Writes and changes code.");
    expect(card).toHaveTextContent(/claude-opus-5/);
    expect(card).toHaveAttribute("aria-checked", "true");
  });

  it("says what the chosen folder is, debounced, ignoring answers for an older path", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const repoStatus = vi.mocked(api.repoStatus);
    let resolveOld!: (v: unknown) => void;
    repoStatus.mockImplementationOnce(() => new Promise(r => { resolveOld = r; }) as never)
      .mockResolvedValueOnce({ exists: true, isRepo: true, branch: "main", clean: true });
    render(<SpawnDialog roles={[role("coder")]} recentRepos={[]} onSpawn={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText("/Users/you/project");
    await userEvent.type(input, "/r/old"); await vi.advanceTimersByTimeAsync(300);
    await userEvent.clear(input); await userEvent.type(input, "/r/new"); await vi.advanceTimersByTimeAsync(300);
    resolveOld({ exists: false, isRepo: false, branch: null, clean: null });                 // late answer for the old path
    expect(await screen.findByTestId("repo-status")).toHaveTextContent("Git repo on main · clean");
    expect(repoStatus).toHaveBeenCalledTimes(2);                                              // Review Focus 2: debounced
    vi.useRealTimers();
  });

  it.each([
    [{ exists: true, isRepo: false, branch: null, clean: null }, "Not a git repo — the agent can still work here"],
    [{ exists: false, isRepo: false, branch: null, clean: null }, "Folder not found"],
    [{ exists: true, isRepo: true, branch: "dev", clean: false }, "Git repo on dev · uncommitted changes"],
  ])("describes %o", async (st, text) => {
    vi.mocked(api.repoStatus).mockResolvedValueOnce(st as never);
    render(<SpawnDialog roles={[role("coder")]} recentRepos={["/r/x"]} onSpawn={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByTestId("repo-status")).toHaveTextContent(text);
  });

  it("creates the agent with an optional first task", async () => {
    const onSpawn = vi.fn(async () => {});
    render(<SpawnDialog roles={[role("coder")]} recentRepos={["/r/x"]} onSpawn={onSpawn} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/first task/i), "Add tests");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(onSpawn).toHaveBeenCalledWith({ role: "coder", repo: "/r/x", displayName: undefined, task: "Add tests" });
  });
});
```

(`role(name)` is the file's existing RoleDef fixture helper; if it builds roles inline, add a helper `const role = (name: string): RoleDef => ({ name, avatar: "🤖", model: "claude-opus-5", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "", description: "" })`.)

In `ui/test/App.test.tsx` add (extend its `api` mock with `assign` already present and `createAgent`):

```tsx
  // Review Focus 3
  it("creates an agent and assigns its first task; if creating fails, nothing is assigned", async () => {
    render(<App />);
    act(() => onSnapshot(snapshot([agent("X", "free")])));
    await userEvent.click(screen.getByRole("button", { name: "New agent" }));
    (api.createAgent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("agent coder@x already exists"));
    await userEvent.type(screen.getByPlaceholderText("/Users/you/project"), "/r/x");
    await userEvent.type(screen.getByLabelText(/first task/i), "go");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(api.assign).not.toHaveBeenCalled();
  });
```

In `ui/e2e/smoke.spec.ts` replace both `{ name: "Spawn", exact: true }` with `{ name: "Create agent" }`.

- [ ] **Step 2: Run them to verify they fail** — `cd ui && npx vitest run test/SpawnDialog.test.tsx test/App.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`SpawnDialog.tsx`: keep the existing state, `browse`, `pick`, folder panel and breadcrumbs as they are; add

```tsx
  const [task, setTask] = useState("");
  const [status, setStatus] = useState<{ exists: boolean; isRepo: boolean; branch: string | null; clean: boolean | null } | null>(null);
  // Debounced, and each request only lands if the path is still the one it was asked about (Review Focus 2).
  useEffect(() => {
    setStatus(null);
    const p = repo.trim();
    if (!p.startsWith("/")) return;
    let live = true;
    const t = setTimeout(() => { api.repoStatus(p).then(s => { if (live) setStatus(s); }).catch(() => { /* outside the browse root: say nothing */ }); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [repo]);
  const statusLine = !status ? null
    : !status.exists ? <span className="errtext" data-testid="repo-status"><FolderX /> Folder not found</span>
    : !status.isRepo ? <span className="warntext" data-testid="repo-status"><Folder /> Not a git repo — the agent can still work here</span>
    : <span className="oktext" data-testid="repo-status"><GitBranch /> Git repo on {status.branch} · {status.clean ? "clean" : "uncommitted changes"}</span>;
```

Submit becomes `await onSpawn({ role, repo: repo.trim(), displayName: name.trim() || undefined, task: task.trim() || undefined })`.

Render (replacing the old `<div className="dialog">…</div>`; keep the inline folder `browser` panel markup unchanged, placed under the repo field):

```tsx
    <div className="modal" onClick={onClose}>
      <section className="dialog" role="dialog" aria-label="New agent" onClick={e => e.stopPropagation()}>
        <div className="dlg-hd">
          <span className="dlg-ic"><Plus /></span>
          <div><h2>New agent</h2><p>An agent is one Claude Code worker with a role, in one repo.</p></div>
          <button className="x" aria-label="Close" onClick={onClose}><X /></button>
        </div>
        <div className="dlg-body">
          <div className="field">
            <span className="label"><span className="step-n done">1</span> Role — how it works and which model it uses</span>
            <div className="roles" role="radiogroup" aria-label="Role">
              {roles.map(r => (
                <button key={r.name} type="button" role="radio" aria-checked={role === r.name} className={`role ${role === r.name ? "sel" : ""}`} onClick={() => setRole(r.name)}>
                  <span className="rn">{r.avatar} {r.name}</span>
                  <span className="rd">{r.description}</span>
                  <span className="rm mono">{r.model} · {r.effort}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="label"><span className="step-n done">2</span> Repo — the folder it works in</span>
            <div className="row pathrow">
              <input className="input mono" list="recent-repos" value={repo} placeholder="/Users/you/project" aria-label="Repo folder" onChange={e => setRepo(e.target.value)} />
              <button className="btn" onClick={pick} disabled={picking}><FolderOpen /> {picking ? "Choosing…" : "Browse…"}</button>
              <button className="btn sm" title={panelOpen ? "Hide folder list" : "Show folder list"} aria-label={panelOpen ? "Hide folder list" : "Show folder list"} onClick={() => setPanelOpen(o => !o)}>{panelOpen ? <ChevronUp /> : <ChevronDown />}</button>
            </div>
            <datalist id="recent-repos">{recentRepos.map(r => <option key={r} value={r} />)}</datalist>
            {statusLine}
            {recentRepos.length > 0 && <div className="recent-chips"><span className="help">Recent:</span>{recentRepos.map(r => <button key={r} className={`chipbtn ${repo === r ? "on" : ""}`} onClick={() => setRepo(r)} title={r}>{r.split("/").pop()}</button>)}</div>}
            {/* folder browser panel: unchanged from before */}
          </div>
          <div className="field">
            <label className="label" htmlFor="first-task"><span className="step-n on">3</span> First task <span className="help">— optional</span></label>
            <textarea id="first-task" className="input" rows={3} value={task} onChange={e => setTask(e.target.value)} placeholder="e.g. Add idempotency keys to the Stripe webhook handler, with tests" />
            <span className="help">Leave it empty to start the agent idle; you can assign work from its card any time.</span>
          </div>
          <div className="field">
            <label className="label" htmlFor="agent-name">Name <span className="help">— optional</span></label>
            <input id="agent-name" className="input" value={name} placeholder="auto" onChange={e => setName(e.target.value)} />
          </div>
          {err && <div className="errtext"><CircleAlert /> {err}</div>}
        </div>
        <div className="dlg-ft">
          <span className="help"><ShieldCheck /> It starts as soon as you create it, and asks you before any risky command.</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn p" onClick={submit}>Create agent</button>
        </div>
      </section>
    </div>
```

Icons from `lucide-react`: `ChevronDown, ChevronUp, CircleAlert, Folder, FolderOpen, FolderX, GitBranch, Plus, ShieldCheck, X`. Replace the folder list's `📁/📂` with `<Folder />`/`<FolderGit2 />` and `⬆ up` with `<ArrowUp /> up` (keep the accessible name "⬆ up"? — no: tests look for `name: "⬆ up"`; set `aria-label="⬆ up"` on that button to keep the e2e/test name stable, and ledger it).

CSS (append):

```css
.roles { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
.role { display:flex; flex-direction:column; gap:4px; padding:10px; border-radius:6px; border:1px solid var(--grid-line); background:var(--bg); cursor:pointer; text-align:left; color:inherit; font:inherit; }
.role:hover { border-color:#22D3EE55; } .role.sel { border-color:var(--accent); box-shadow:0 0 0 1px #22D3EE55, 0 0 14px #22D3EE22; background:rgba(34,211,238,.04); }
.role .rn { font-size:12.5px; font-weight:600; } .role .rd { font-size:11px; color:var(--text-muted); line-height:1.4; } .role .rm { font-size:10px; color:var(--text-muted); }
.recent-chips { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.chipbtn { font-family:var(--mono); font-size:11px; min-height:22px; padding:0 8px; border-radius:4px; border:1px solid var(--grid-line); background:transparent; color:var(--text-muted); cursor:pointer; }
.chipbtn:hover, .chipbtn.on { color:var(--accent); border-color:#22D3EE55; }
```

`App.tsx` `SpawnDialog onSpawn`:

```tsx
onSpawn={async i => { const a = await api.createAgent(i); dispatch({ type: "select", id: a.id }); if (i.task) await api.assign(a.id, i.task); }}
```

(`createAgent` ignores the extra `task` field server-side? — strip it: `const { task, ...input } = i; const a = await api.createAgent(input);`.)

- [ ] **Step 4: Run tests** — `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit` → PASS; existing SpawnDialog tests (browse, picker, crumbs, "Use this folder") keep passing; any asserting the old `Spawn` button name switch to `Create agent` (ledger).

- [ ] **Step 5: Commit** — `git commit -m "feat(ui): New agent dialog — role cards, a live repo check, an optional first task"`

---

### Task 4: Fix a bug dialog — numbered steps and what happens next

**Files:**
- Modify: `ui/src/components/BugLauncher.tsx`
- Test: `ui/test/BugLauncher.test.tsx`

**Interfaces:**
- Consumes: preflight `remote`.
- Produces: steps `Ticket`, `Repo`, `When the PR is approved`; merge options `button.opt[role="radio"]` with the auto one `aria-disabled="true"` labelled "coming later"; key input validation message `data-testid="key-error"`; `.next[aria-label="What happens next"]`; Start button `title` naming what is missing when disabled.

- [ ] **Step 1: Write the failing tests** (reuse the file's mocks)

```tsx
describe("Fix a bug — layout and guidance", () => {
  it("flags a malformed ticket key inline, and accepts a pasted URL", async () => {
    render(<BugLauncher onClose={vi.fn()} onOpenSettings={vi.fn()} />);
    const key = await screen.findByLabelText(/issue url or key/i);
    await userEvent.type(key, "pay 42");
    expect(screen.getByTestId("key-error")).toHaveTextContent(/PAY-123/);
    await userEvent.clear(key); await userEvent.type(key, "https://acme.atlassian.net/browse/PAY-42");   // Review Focus 4
    expect(screen.queryByTestId("key-error")).toBeNull();
  });

  it("names the remote it found for the repo", async () => {
    bugPreflight.mockResolvedValueOnce({ ok: true, problems: [], remote: "git@bitbucket.org:gruve-team/pay.git" });
    render(<BugLauncher onClose={vi.fn()} onOpenSettings={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText(/^repo/i), "/r/pay");
    expect(await screen.findByText(/Remote found: git@bitbucket.org:gruve-team\/pay.git/)).toBeInTheDocument();
  });

  it("shows auto-merge as coming later and never selectable", async () => {
    render(<BugLauncher onClose={vi.fn()} onOpenSettings={vi.fn()} />);
    const auto = await screen.findByRole("radio", { name: /merge automatically/i });
    expect(auto).toHaveAttribute("aria-disabled", "true");
    expect(auto).toHaveTextContent(/coming later/i);
    await userEvent.click(auto);
    expect(screen.getByRole("radio", { name: /ask me before merging/i })).toHaveAttribute("aria-checked", "true");
  });

  it("explains what happens next and why Start is disabled", async () => {
    render(<BugLauncher onClose={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(await screen.findByLabelText("What happens next")).toHaveTextContent(/you approve.*you review the diff/i);
    expect(screen.getByRole("button", { name: "Start fixing" })).toHaveAttribute("title", expect.stringMatching(/ticket/i));
  });
});
```

(Use the file's `bugPreflight` mock name; if it is named differently, use that.) The existing test `"does not offer auto-merge as a usable choice…"` asserted a disabled `<option>`; rewrite its assertion to the radio above (ledger).

- [ ] **Step 2: Run to verify they fail** — FAIL.

- [ ] **Step 3: Implement** — keep every state, effect and handler in `BugLauncher`; rebuild the render around `.dialog.wide` with `.dlg-hd` (amber `dlg-ic` with `<Bug />`, h2 "Fix a bug", p "From ticket to merged pull request. You approve each step.", close `.x`), `.dlg-body` and `.dlg-ft`:

- **Ticket field** (`step-n done`, label "Ticket"): the issue list as rows (`.tk` buttons: mono key, title, priority `.chip` — `amber` for High, `red` for Highest/Critical/Blocker, plain otherwise), the existing loading/empty/error copy, then the existing input with `id="issue-ref"` and `<label htmlFor="issue-ref">Issue URL or key</label>`, then:

```tsx
const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const keyBad = issueRef.trim() !== "" && !/^https?:\/\//i.test(issueRef.trim()) && !KEY.test(issueRef.trim());
…
{keyBad && <span className="errtext" data-testid="key-error"><CircleAlert /> A ticket key looks like PAY-123 — or paste the ticket's URL.</span>}
```

- **Repo field** (`step-n`, `<label htmlFor="bug-repo">Repo</label>`, input `id="bug-repo"` + Browse): existing `checking` / problems rendering moved to `.help`/`.errtext`, plus `{preflight?.ok && preflight.remote && <span className="oktext"><CheckCircle2 /> Remote found: <span className="mono">{preflight.remote}</span></span>}`.
- **Merge field** (`step-n`, label "When the PR is approved"): `div[role="radiogroup"]` with two `button.opt[role="radio"]`: "Ask me before merging" (`aria-checked={mergePolicy === "ask"}`, help "You pick the merge method and press Merge.") and "Merge automatically" (`aria-checked="false" aria-disabled="true" className="opt disabled"`, help "Coming later — not available yet.", `onClick` no-op). Remove the `<select>`; keep the long comment explaining why auto is disabled.
- **Next strip**: `<div className="next" aria-label="What happens next"><b>What happens next:</b> <span className="dot c" /> agent writes a plan → <span className="dot a" /> you approve → <span className="dot c" /> it fixes → <span className="dot a" /> you review the diff → <span className="dot c" /> PR opened</div>`
- **Footer**: help "Nothing is pushed until you approve the diff."; Cancel; Start fixing with `disabled={blocked || keyBad}` and `title={!issueRef.trim() ? "Pick or paste a ticket first" : keyBad ? "Fix the ticket key first" : !repoValid ? "Enter the repo's absolute path" : checking ? "Checking the repo…" : preflight && !preflight.ok ? "Fix the repo problems above" : ""}`.
- The not-ready branch keeps its copy and buttons, inside `.dlg-body`, with each blocking check as `.errtext`.

CSS (append):

```css
.tickets { display:flex; flex-direction:column; border:1px solid var(--grid-line); border-radius:6px; overflow:hidden; }
.tk { display:grid; grid-template-columns:76px 1fr auto; gap:10px; align-items:center; padding:8px 10px; border:0; border-top:1px solid var(--grid-line); background:var(--bg); cursor:pointer; font:inherit; font-size:12.5px; color:inherit; text-align:left; }
.tk:first-child { border-top:0; } .tk:hover { background:var(--surface-raised); } .tk.sel { background:rgba(34,211,238,.06); box-shadow:inset 2px 0 0 var(--accent); }
.tk .k { font-family:var(--mono); font-size:11.5px; font-weight:600; }
.opts { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
```

- [ ] **Step 4: Run tests** — `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit` → PASS (existing launcher tests: list/remembered repo, URL paste, preflight blocking, relative path, failed lookup, multi-line intake error, tracker-not-connected — unchanged behaviour).

- [ ] **Step 5: Commit** — `git commit -m "feat(ui): Fix a bug as numbered steps, honest about auto-merge, saying what happens next"`

---

### Task 5: Settings — a readiness checklist

**Files:**
- Modify: `ui/src/components/SettingsDialog.tsx`
- Test: `ui/src/components/SettingsDialog.test.tsx`

**Interfaces:**
- Produces: `.overall[data-ready]` banner ("Ready to fix bugs" or "N thing(s) left before you can fix bugs") with check chips for Tracker, Forge, Bug fixer role; each section `section.sec` with left `.sec-head` (`h4` title, status chip, `.why`) and right `.sec-body`; forge picker as `.seg` with `button[aria-pressed]`; the token fix's command with Copy.

- [ ] **Step 1: Write the failing tests** (reuse the file's `report()` fixture and mocks)

```tsx
describe("Settings — readiness checklist", () => {
  it("opens with what is left before bug fixes work", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ ready: false, checks: [
      { id: "tracker", state: "ok", blocks: true, detail: "Tracker configured (jira, tools mcp__x)." },
      { id: "forge", state: "missing", blocks: true, detail: "No forge configured." },
      { id: "role", state: "ok", blocks: true, detail: "The bugfix role resolves." },
    ] }));
    render(<SettingsDialog onClose={() => {}} />);
    const banner = await screen.findByTestId("overall");
    expect(banner).toHaveTextContent("1 thing left before you can fix bugs");
    expect(banner).toHaveTextContent(/Agents work without any of this/);
    expect(within(banner).getByText("Forge").closest(".chip")).toHaveClass("amber");
  });

  it("says ready when everything blocking is ok", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ ready: true, checks: [{ id: "tracker", state: "ok", blocks: true, detail: "ok" }] }));
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByTestId("overall")).toHaveTextContent("Ready to fix bugs");
  });

  it("explains why each section exists", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({}));
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByText(/Where your tickets live/)).toBeInTheDocument();
    expect(screen.getByText(/Where pull requests are opened and merged/)).toBeInTheDocument();
  });

  it("picks the forge with a segmented control", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({}));
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {}, forge: { preset: "github" } } as never);
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /bitbucket/i }));
    expect(screen.getByRole("button", { name: /bitbucket/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByPlaceholderText("Atlassian account email")).toBeInTheDocument();
  });
});
```

Existing tests that drive the forge `<select>` via `userEvent.selectOptions` are switched to clicking the segment button (ledger each); tests asserting `section … h4` text ("Tracker") keep working because each section keeps its `h4`.

- [ ] **Step 2: Run to verify they fail** — FAIL.

- [ ] **Step 3: Implement** — keep every hook, effect, `save`, `run`, `forgeDirty`, `SELECTABLE` and test-visible text; restructure render:

- `.dialog.settings` with `.dlg-hd` (icon `<PlugZap />`, h2 "Integrations", p "What the bug-fix workflow needs, and whether it's ready. Every problem comes with its fix.", close `.x`).
- `.dlg-body` starts with the banner:

```tsx
const blockingIds = ["tracker", "forge", "role"] as const;
const LABEL = { tracker: "Tracker", forge: "Forge", role: "Bug fixer role" } as const;
const left = blockingIds.filter(id => { const c = check(id); return c && c.state !== "ok"; });
…
<div className="overall" data-testid="overall" data-ready={left.length === 0}>
  {left.length === 0 ? <CheckCircle2 className="ok-ic" /> : <TriangleAlert className="warn-ic" />}
  <div className="grow"><b>{left.length === 0 ? "Ready to fix bugs" : `${left.length} thing${left.length === 1 ? "" : "s"} left before you can fix bugs`}</b>
    <div className="help">Agents work without any of this. Only “Fix a bug” needs a tracker and a forge.</div></div>
  <div className="checks">{blockingIds.map(id => { const c = check(id); if (!c) return null; const ok = c.state === "ok";
    return <span key={id} className={`chip ${ok ? "green" : "amber"}`}>{ok ? <Check /> : <TriangleAlert />} {LABEL[id]}</span>; })}</div>
</div>
```

- "Other problems" section unchanged in content, as a `.sec`.
- Tracker `section.sec`: `.sec-head` = `<h4><Ticket /> Tracker</h4>` + chip (`green` "Ready" when tracker ok, else `amber` "Needs attention") + `<p className="why">Where your tickets live. AgentGrid uses the connection Claude Code already has; nothing is copied.</p>`; `.sec-body` = everything the Tracker section rendered before, unchanged.
- Forge `section.sec`: head `<h4><GitPullRequest /> Forge</h4>` + chip + `why` "Where pull requests are opened and merged. AgentGrid pushes; agents never hold your credentials."; body: replace the `<select>` with

```tsx
<div className="seg" role="group" aria-label="Forge">
  {!SELECTABLE.includes(preset) && <button className="on" aria-pressed="true">{preset} (saved)</button>}
  {SELECTABLE.map(p => <button key={p} className={preset === p ? "on" : ""} aria-pressed={preset === p} onClick={() => setPresetOverride(p)}>{p === "github" ? "GitHub" : "Bitbucket"}</button>)}
</div>
```

then the rest unchanged (username input with `className="input"`, check rows, merge-methods hint, Test forge).
- Repos and discovery-problem sections as `.sec` with `why` "Which repo each Jira project's bugs are fixed in. Filled in as you use “Fix a bug”."
- Footer row (`row footer`) moved into `.dlg-ft` with help "Saved to ~/.agentgrid/integrations.json." — keep the `footer` class on the row element (a test checks `.row.footer`).

CSS (append):

```css
.overall { display:flex; align-items:center; gap:14px; padding:12px 14px; border-radius:8px; }
.overall[data-ready="false"] { background:rgba(251,191,36,.05); box-shadow:0 0 0 1px #FBBF2466, 0 0 16px #FBBF241f; }
.overall[data-ready="true"] { background:rgba(52,211,153,.05); box-shadow:0 0 0 1px #34D39955; }
.overall .grow { flex:1; } .overall .checks { display:flex; gap:6px; flex-wrap:wrap; }
.warn-ic { color:var(--st-needs-you); width:20px; height:20px; } .ok-ic { color:var(--st-done); width:20px; height:20px; }
.sec { display:grid; grid-template-columns:210px 1fr; gap:20px; padding-top:16px; border-top:1px solid var(--grid-line); }
.sec h4 { margin:0; font-size:13px; font-weight:600; color:var(--text); text-transform:none; letter-spacing:0; display:flex; align-items:center; gap:8px; }
.sec .why { font-size:12px; color:var(--text-muted); line-height:1.5; margin:6px 0 0; }
.sec-body { display:flex; flex-direction:column; gap:10px; min-width:0; }
@media (max-width: 760px) { .sec { grid-template-columns:1fr; } }
```

- [ ] **Step 4: Run tests** — `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit` → PASS (all existing Settings behaviours: use-this keeps hints, forge not rewritten untouched, restart/live messages, in-use tag, tracker-server warning in the Tracker section, sticky footer class).

- [ ] **Step 5: Commit** — `git commit -m "feat(ui): Settings as a readiness checklist — what's left, why each part exists"`

---

### Task 6: First run, N/B/S keys, e2e, 0.9.0

**Files:**
- Create: `ui/src/components/FirstRun.tsx`
- Modify: `ui/src/App.tsx`, `ui/src/hooks/useKeyboard.ts`, `ui/src/styles.css`, `desktop/package.json` (`0.9.0`), `README.md`
- Create: `ui/test/FirstRun.test.tsx`, `ui/e2e/firstrun.spec.ts`
- Modify: `ui/test/App.test.tsx`

**Interfaces:**
- Produces: `FirstRun({ liveSessions: number, setup: SetupReport | null, onNewAgent, onSessions, onFixBug, onOpenSettings })`; `useKeyboard` handlers gain `newAgent, fixBug, sessions` bound to `n`, `b`, `s`.

- [ ] **Step 1: Write the failing tests**

`ui/test/FirstRun.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FirstRun } from "../src/components/FirstRun";
import type { SetupReport } from "../src/types";

const setup = { ready: false, wired: false, addCommand: "", discovery: { servers: [], problems: [] }, checks: [
  { id: "tracker", state: "ok", blocks: true, detail: "" }, { id: "forge", state: "missing", blocks: true, detail: "" }, { id: "role", state: "ok", blocks: true, detail: "" },
] } as SetupReport;
const props = (over = {}) => ({ liveSessions: 2, setup, onNewAgent: vi.fn(), onSessions: vi.fn(), onFixBug: vi.fn(), onOpenSettings: vi.fn(), ...over });

describe("FirstRun", () => {
  it("explains the app in one line and offers three ways to start, each saying what happens", async () => {
    const p = props(); render(<FirstRun {...p} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Run several Claude Code agents side by side.");
    await userEvent.click(screen.getByRole("button", { name: "Create an agent" })); expect(p.onNewAgent).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Show sessions" })); expect(p.onSessions).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Start a bug fix" })); expect(p.onFixBug).toHaveBeenCalled();
  });
  // Review Focus 5
  it("counts the Claude Code sessions already running, and says when there are none", () => {
    const { rerender } = render(<FirstRun {...props()} />);
    expect(screen.getByText(/already open in 2 terminals/)).toBeInTheDocument();
    rerender(<FirstRun {...props({ liveSessions: 0 })} />);
    expect(screen.getByRole("button", { name: "Show sessions" })).toBeDisabled();
    expect(screen.getByText(/none open right now/)).toBeInTheDocument();
  });
  it("shows readiness as chips, only needed for bug fixes, with a way to fix it", async () => {
    const p = props(); render(<FirstRun {...p} />);
    expect(screen.getByText("Forge").closest(".chip")).toHaveClass("amber");
    expect(screen.getByText(/only needed for bug fixes/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fix it" })); expect(p.onOpenSettings).toHaveBeenCalled();
  });
  it("teaches the colour language in three steps", () => {
    render(<FirstRun {...props()} />);
    const how = screen.getByRole("complementary", { name: "How AgentGrid works" });
    expect(how.querySelectorAll("li")).toHaveLength(3);
  });
});
```

`ui/test/App.test.tsx` — add:

```tsx
  it("shows first run with no agents and no bug fixes, and the grid once there is an agent", () => {
    render(<App />);
    act(() => onSnapshot(snapshot([])));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/side by side/);
    act(() => onSnapshot(snapshot([agent("A", "free")])));
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByTestId("tile-A")).toBeInTheDocument();
  });

  it("n, b and s open New agent, Fix a bug and Sessions — but not while typing", async () => {
    render(<App />);
    act(() => onSnapshot(snapshot([agent("A", "free")])));
    await userEvent.keyboard("n");
    expect(screen.getByRole("dialog", { name: "New agent" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/first task/i), "s");                  // typing "s" doesn't open Sessions
    expect(screen.queryByText(/Sessions/i, { selector: ".dialog h2, .dialog h3" })).toBeNull();
  });
```

(Extend the file's `api` mock with `getSetup: vi.fn(() => Promise.resolve({ ready: true, wired: true, addCommand: "", discovery: { servers: [], problems: [] }, checks: [] }))` and `repoStatus: vi.fn(() => Promise.resolve(null))`.)

`ui/e2e/firstrun.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

// Runs first so the server has no agents yet (Playwright runs files alphabetically within a worker).
test("first run → create an agent → it appears on the grid", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("side by side");
  await page.getByRole("button", { name: "Create an agent" }).click();
  await page.getByPlaceholder("/Users/you/project").fill("/tmp");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByTestId(/^tile-/).first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
});
```

If e2e files share one server and order makes `smoke.spec.ts`'s first assertion (`tile count 0`) fail, move this spec's flow into the start of `smoke.spec.ts`'s first test instead (ledger it).

- [ ] **Step 2: Run them to verify they fail** — FAIL.

- [ ] **Step 3: Implement**

`useKeyboard.ts`: extend the handler type with `newAgent: () => void; fixBug: () => void; sessions: () => void;` and add `else if (e.key === "n") h.newAgent(); else if (e.key === "b") h.fixBug(); else if (e.key === "s") h.sessions();`.

`App.tsx`: pass `newAgent: () => setSpawnOpen(true), fixBug: () => setBugOpen(true), sessions: () => setSessionsOpen(true)` in the `useKeyboard` memo; fetch setup once for first run (`const [setup, setSetup] = useState<SetupReport | null>(null); useEffect(() => { api.getSetup().then(setSetup).catch(() => {}); }, [settingsOpen]);`); render:

```tsx
const firstRun = s.agents.length === 0 && Object.keys(s.bugTasks).length === 0;
…
{route.view === "bugs" ? <BugScreen … /> : firstRun
  ? <FirstRun liveSessions={unclaimedLiveSessions(s).length} setup={setup} onNewAgent={() => setSpawnOpen(true)}
      onSessions={() => setSessionsOpen(true)} onFixBug={() => setBugOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
  : <div className="split">…</div>}
```

Footer key hints in grid view gain `<kbd>N</kbd> new <kbd>B</kbd> bug <kbd>S</kbd> sessions` — update the phase 1 Footer test's expected list to `["1","9","A","D","O","N","B","S","Esc"]` (ledger).

`FirstRun.tsx`:

```tsx
import { ArrowDownToLine, Bug, Check, Plus, TerminalSquare, TriangleAlert } from "lucide-react";
import type { SetupReport } from "../types";

const CHECKS = [["tracker", "Tracker"], ["forge", "Forge"], ["role", "Bug fixer role"]] as const;

/** What a new user sees: the app in one line, three ways to start, and the colour language. */
export function FirstRun({ liveSessions, setup, onNewAgent, onSessions, onFixBug, onOpenSettings }: {
  liveSessions: number; setup: SetupReport | null; onNewAgent: () => void; onSessions: () => void; onFixBug: () => void; onOpenSettings: () => void;
}) {
  const checks = CHECKS.map(([id, label]) => ({ id, label, c: setup?.checks.find(x => x.id === id) })).filter(x => x.c);
  const missing = checks.some(x => x.c!.state !== "ok");
  return (
    <div className="first">
      <main className="hero">
        <div className="ghosts" aria-hidden><div className="ghost w" /><div className="ghost n" /><div className="ghost d" /><div className="ghost" /></div>
        <h1>Run several Claude Code agents side by side.</h1>
        <p className="lead">Each agent works in its own repo. AgentGrid shows them all at once, and pulls you in only when one needs a decision.</p>
        <div className="starts">
          <div className="start">
            <span className="ic c-working"><Plus /></span><h3>Start a new agent</h3>
            <p>Pick a role and a repo. It starts on whatever you assign and asks before any risky command.</p>
            <button className="btn p" onClick={onNewAgent}><Plus /> Create an agent</button>
          </div>
          <div className="start">
            <span className="ic c-accent"><ArrowDownToLine /></span><h3>Pull in a running session</h3>
            <p>{liveSessions > 0 ? <>Claude Code is already open in {liveSessions} terminal{liveSessions === 1 ? "" : "s"} on this Mac. Bring one here to watch and answer it.</>
              : <>Claude Code sessions you start in a terminal appear here — none open right now.</>}</p>
            <button className="btn" disabled={liveSessions === 0} onClick={onSessions}><TerminalSquare /> Show sessions</button>
          </div>
          <div className="start">
            <span className="ic c-waiting"><Bug /></span><h3>Fix a bug from a ticket</h3>
            <p>Turn a Jira ticket into a merged pull request. You approve the plan, the diff and the merge.</p>
            <button className="btn" onClick={onFixBug}><Bug /> Start a bug fix</button>
          </div>
        </div>
        {checks.length > 0 && (
          <div className="ready">
            <span className="ready-lbl">Before you start</span>
            {checks.map(({ id, label, c }) => (
              <span key={id} className={`chip ${c!.state === "ok" ? "green" : "amber"}`}>{c!.state === "ok" ? <Check /> : <TriangleAlert />} {label}</span>
            ))}
            {missing && <button className="btn sm" onClick={onOpenSettings}>Fix it</button>}
            <span className="help">— only needed for bug fixes</span>
          </div>
        )}
      </main>
      <aside className="side how" aria-label="How AgentGrid works">
        <h4>How AgentGrid works</h4>
        <ol>
          <li><span className="n c">1</span><div><b>Agents work on their own</b><p>Working agents glow cyan with a moving edge. You don't need to watch them.</p></div></li>
          <li><span className="n a">2</span><div><b>One needs you, it glows amber</b><p>A permission or a question. The NEEDS YOU counter lights up and you get a notification.</p></div></li>
          <li><span className="n g">3</span><div><b>You answer, it carries on</b><p>Allow, deny or reply right on its card. Press <kbd>A</kbd> or <kbd>D</kbd> without leaving the keyboard.</p></div></li>
        </ol>
      </aside>
    </div>
  );
}
```

CSS: port the `FIRST_CSS` block from `.superdesign/tmp/build.py` (classes `.first .hero .ghosts .ghost(.w .n .d) .hero h1 .lead .starts .start .start .ic .ready .how ol/li/.n(.c .a .g)`) verbatim, replacing any `--text-faint` on essential copy with `--text-muted`, and add `.c-accent { color:var(--accent); } .ready-lbl { font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-muted); }`.

Version → `0.9.0`; README feature list: replace "+ New agent" spawn wording if needed and add: "A first-run screen explains AgentGrid and offers the three ways to start; New agent, Fix a bug and Settings say what each choice does. Keys: N new agent, B fix a bug, S sessions."

- [ ] **Step 4: Run everything** — `npm test && (cd ui && npx tsc -p tsconfig.json --noEmit) && (cd server && npx tsc -p tsconfig.json --noEmit) && (cd ui && npx playwright test)` → all pass.

- [ ] **Step 5: Screenshots** — fake mode with an empty `AGENTGRID_HOME`: capture first run (`.superdesign/tmp/phase3-first-run.png`), then open New agent and Fix a bug (`phase3-dialogs-*.png`) and Settings (`phase3-settings.png`) at 1440×900; compare with the drafts and fix mismatches test-first (ledger).

- [ ] **Step 6: Commit** — `git commit -m "feat(ui): a first run that teaches by doing; N/B/S keys; 0.9.0"`
