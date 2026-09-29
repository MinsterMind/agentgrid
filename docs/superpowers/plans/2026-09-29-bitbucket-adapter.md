# Bitbucket Cloud Adapter and Server-Side PR Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the whole bug-fix workflow against Bitbucket Cloud, and move pull-request creation from the agent to the server so no forge credential is ever handed to a model.

**Architecture:** A second `ForgeAdapter` implementation speaking Bitbucket Cloud's REST API over `fetch` with HTTP Basic auth, the token read from the environment and never stored. `createPrCommand` (a shell string for the agent) becomes `createPr` (server work), which splits `opening-pr` into an agent stage that writes the PR body and a new `creating-pr` server stage that pushes, creates and confirms.

**Tech Stack:** Node 22 + TypeScript ESM (explicit `.js` import suffixes), vitest, Bitbucket Cloud REST API 2.0, `gh` for the GitHub adapter, real git in temp repos for the git-level tests.

**Spec:** `docs/superpowers/specs/2026-09-29-bitbucket-and-settings-design.md`

**Scope:** this plan implements §4, §5 and §7-§9 of that spec. **§6, the Settings screen, is a separate plan** — the two subsystems each produce working software alone, and this one is what unblocks a Bitbucket user today. Nothing here depends on the Settings work; configuration is by file until it lands.

## Global Constraints

- Node 22 + TypeScript ESM: every relative import carries an explicit `.js` suffix.
- Tests mirror `src` paths under `server/test/`; the server suite runs from `server/`.
- **The server verifies rather than trusts.** An agent's or a CLI's claim is not evidence; confirm through git or the forge before advancing a stage.
- **Human gates are the point.** No path advances past a gate without that gate's explicit call, and the merge stays gated.
- **No stage changes because a CLI or API call failed.** An unreachable forge is *no information*: `PrLookup`'s third state, no stage change.
- **`BITBUCKET_API_TOKEN` is read from the environment at call time.** Never stored by AgentGrid, never logged, never placed in a prompt, a command string, or an agent's environment.
- **No agent performs an authenticated forge call after this plan.** Push, PR creation and merge are all server work.
- Adapter methods never throw: `getPr` returns `PrLookup`, `listReviewEvents` returns `[]`, `merge` returns `MergeResult`.
- Anything unrecognised in a check rollup reads as pending, never as success.
- `rebase` as a Bitbucket merge method is **rejected**, never silently mapped to `fast_forward`.

## File structure

| File | Responsibility |
|---|---|
| `server/src/bugfix/forge/types.ts` | `createPrCommand` → `createPr`; `CreatePrContext` unchanged |
| `server/src/bugfix/forge/github.ts` | `createPr` via `gh pr create`, returning a verified `PrLookup` |
| `server/src/bugfix/forge/bitbucket.ts` | **new** — the Bitbucket Cloud adapter, auth, the three foldings |
| `server/src/bugfix/forge/index.ts` | `makeForge` gains `"bitbucket"` |
| `server/src/bugfix/integrations.ts` | `ForgeConfig` gains `"bitbucket"` and `username` |
| `server/src/bugfix/types.ts` | `BugStage` gains `"creating-pr"`; `SERVER_STAGES` |
| `server/src/bugfix/stages.ts` | `opening-pr` → `creating-pr` → `monitoring` |
| `server/src/bugfix/engine.ts` | `verify("opening-pr")` becomes a body check; `doCreatePr`; `runServerStage` |
| `server/src/bugfix/prompts.ts` | drop `createPrCommand` and its guard |
| `server/presets/stages/open-pr.md` | rewritten: write the body, run nothing |
| `server/src/api/app.ts` | `forge.preset` validation gains `"bitbucket"` |
| `server/src/fake/forge.ts` | `createPr` on the scripted fake |
| `server/test/bugfix/forge/contract.test.ts` | **new** — one contract both adapters satisfy |

---

### Task 1: `createPr` replaces `createPrCommand`

**Files:**
- Modify: `server/src/bugfix/forge/types.ts`, `server/src/bugfix/forge/github.ts`, `server/src/fake/forge.ts`, `server/test/bugfix/realEngineApp.ts`, `server/test/bugfix/engine.test.ts` (fake forges)
- Test: `server/test/bugfix/forge.test.ts` (append)

**Interfaces:**
- Consumes: `CreatePrContext { title; bodyFile; base; head }`, `PrLookup`, `Runner`.
- Produces:
  ```ts
  // ForgeAdapter — createPrCommand is REMOVED, replaced by:
  createPr(repoDir: string, ctx: CreatePrContext): Promise<PrLookup>;
  ```
  `createPr` never throws. It returns `{ found: PrInfo }` on success, `{ unavailable: string }` when the forge could not be reached or the call failed, and `{ found: null }` only when the forge reports the PR was not created for a reason that is not an error (in practice: never for GitHub — prefer `unavailable` with the message).

- [ ] **Step 1: Write the failing tests**

Append to `server/test/bugfix/forge.test.ts`:

```ts
describe("createPr", () => {
  const ctx = { title: "PAY-42: Boom", bodyFile: "/a/bt1/pr-body.md", base: "main", head: "bugfix/PAY-42" };

  it("creates the PR and returns the created PR, verified by a read", async () => {
    const calls: string[][] = [];
    const f = githubAdapter(async (_c, args) => {
      calls.push(args);
      if (args[1] === "create") return { stdout: "https://github.com/acme/app/pull/7\n", code: 0 };
      // findPr goes through `gh pr list`, which returns an ARRAY — wrap the fixture.
      return { stdout: `[${await readFile(path.resolve("test/bugfix/fixtures/gh/pr-changes-requested.json"), "utf8")}]`, code: 0 };
    });
    const r = await f.createPr("/r", ctx);
    expect(calls[0]).toEqual(["pr", "create", "--base", "main", "--head", "bugfix/PAY-42",
      "--title", "PAY-42: Boom", "--body-file", "/a/bt1/pr-body.md"]);
    expect(r).toMatchObject({ found: { number: 7, state: "OPEN" } });
  });

  it("reports why it could not create, and never throws", async () => {
    const f = githubAdapter(async () => ({ stdout: "", code: 1, stderr: "a pull request for branch already exists" }));
    const r = await f.createPr("/r", ctx);
    expect(r).toMatchObject({ unavailable: expect.stringMatching(/already exists/i) as unknown as string });
  });

  it("adopts an existing PR rather than failing, when one is already open for the branch", async () => {
    // gh refuses a duplicate; the server should then find the PR that already exists.
    let call = 0;
    const f = githubAdapter(async (_c, args) => {
      call += 1;
      if (args[1] === "create") return { stdout: "", code: 1, stderr: "a pull request for branch \"bugfix/PAY-42\" already exists" };
      return { stdout: `[${await readFile(path.resolve("test/bugfix/fixtures/gh/pr-changes-requested.json"), "utf8")}]`, code: 0 };
    });
    const r = await f.createPr("/r", ctx);
    expect(r).toMatchObject({ found: { number: 7 } });
    expect(call).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/bugfix/forge.test.ts`
Expected: FAIL — `f.createPr is not a function`.

- [ ] **Step 3: Change the interface**

In `server/src/bugfix/forge/types.ts`, delete `createPrCommand` and add:

```ts
  /**
   * Create the pull request. Server work: no agent ever holds a forge credential.
   * Never throws — `{unavailable}` carries the forge's own message. When the forge
   * refuses because a PR already exists for this branch, adopt that PR rather than
   * failing: a retried `creating-pr` must be idempotent.
   */
  createPr(repoDir: string, ctx: CreatePrContext): Promise<PrLookup>;
```

- [ ] **Step 4: Implement it for GitHub**

In `server/src/bugfix/forge/github.ts`, replace `createPrCommand` with:

```ts
    async createPr(repoDir, ctx) {
      const r = await run("gh", ["pr", "create", "--base", ctx.base, "--head", ctx.head,
        "--title", ctx.title, "--body-file", ctx.bodyFile], repoDir);
      // A duplicate is not a failure: a retry after a crash mid-creation must converge.
      if (r.code !== 0 && !/already exists/i.test(r.stderr ?? r.stdout ?? "")) {
        return { unavailable: ((r.stderr ?? r.stdout) ?? "").trim() || `gh exited ${r.code}` };
      }
      // Verify rather than trust the exit code: read the PR back by branch.
      const pr = await this.findPr(repoDir, ctx.head);
      return pr ? { found: pr } : { unavailable: "the pull request was not found after creating it" };
    },
```

Note `this.findPr` requires the returned object to be a method-bearing object literal; if the adapter is built as a plain object, capture `findPr` in a local const first and call that — do not duplicate the lookup logic.

- [ ] **Step 5: Update every other implementation**

`server/src/fake/forge.ts`, `server/test/bugfix/realEngineApp.ts` and the local fakes in `server/test/bugfix/engine.test.ts` each need `createPr` and must drop `createPrCommand`. The scripted fake creates the PR from its `BASE` state and returns `{ found: pr }`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/bugfix/forge.test.ts`
Expected: PASS. The full suite will still fail — `engine.ts` and `prompts.ts` reference `createPrCommand`; Task 3 removes those. Leave them for now only if the tree still compiles; if it does not, stub the engine call site to `throw new Error("wired in Task 3")` and say so in your report.

- [ ] **Step 7: Commit**

```bash
git add server/src/bugfix/forge server/src/fake/forge.ts server/test
git commit -m "feat(bugfix): the forge creates pull requests, instead of handing the agent a command"
```

---

### Task 2: the `creating-pr` stage

**Files:**
- Modify: `server/src/bugfix/types.ts`, `server/src/bugfix/stages.ts`
- Test: `server/test/bugfix/stages.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  export type BugStage = … | "creating-pr";           // added to the union
  export const SERVER_STAGES: BugStage[] = ["pushing", "creating-pr", "merging"];
  ```
  Transitions: `opening-pr` + `stage-done` → `creating-pr` (a server stage, `run: null`); `creating-pr` + `stage-done` → `monitoring`.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/bugfix/stages.test.ts`:

```ts
describe("server-side PR creation", () => {
  it("a verified opening-pr hands off to the creating-pr server stage", () => {
    expect(nextStage(task("opening-pr"), { type: "stage-done" }))
      .toMatchObject({ stage: "creating-pr", run: null });
  });

  it("a created PR rests in monitoring", () => {
    expect(nextStage(task("creating-pr"), { type: "stage-done" }))
      .toMatchObject({ stage: "monitoring", run: null });
  });

  it("a failed creation is retryable as a server stage", () => {
    const failed = task("failed", { history: [
      { stage: "creating-pr", at: "t", note: "" }, { stage: "failed", at: "t", note: "" }] });
    expect(nextStage(failed, { type: "retry" })).toMatchObject({ stage: "creating-pr", run: null });
  });

  it("still refuses stage-failed at a gate, and creating-pr is not a gate", () => {
    expect(() => nextStage(task("diff-review"), { type: "stage-failed", reason: "x" })).toThrow(/waiting on a human/i);
    expect(nextStage(task("creating-pr"), { type: "stage-failed", reason: "boom" }))
      .toMatchObject({ stage: "failed", error: "boom" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/stages.test.ts`
Expected: FAIL — `opening-pr` still returns `go("monitoring", null)`.

- [ ] **Step 3: Add the stage**

In `server/src/bugfix/types.ts`: add `"creating-pr"` to the `BugStage` union, and to `SERVER_STAGES` between `"pushing"` and `"merging"`. Leave `AGENT_STAGES` alone — `opening-pr` is still an agent stage, it just writes a file now. `RECOVERABLE_STAGES` already spreads `SERVER_STAGES`, so a crash mid-creation recovers for free.

- [ ] **Step 4: Rewire the transition**

In `server/src/bugfix/stages.ts`'s `stage-done` switch:

```ts
        case "opening-pr": return serverRun("creating-pr");
        case "creating-pr": return go("monitoring", null);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/bugfix/stages.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, tsc clean. Existing Phase 1/2 stage tests must be untouched; a failure there means the new arrow changed an existing one.

- [ ] **Step 6: Commit**

```bash
git add server/src/bugfix/types.ts server/src/bugfix/stages.ts server/test/bugfix/stages.test.ts
git commit -m "feat(bugfix): creating-pr, a server stage between the PR body and monitoring"
```

---

### Task 3: the engine creates the PR

**Files:**
- Modify: `server/src/bugfix/engine.ts`, `server/src/bugfix/prompts.ts`, `server/presets/stages/open-pr.md`
- Test: `server/test/bugfix/engine.test.ts` (append), `server/test/bugfix/prompts.test.ts` (modify)

**Interfaces:**
- Consumes: `ForgeAdapter.createPr` (Task 1), the `creating-pr` stage (Task 2), `GitOps.push`, `git.revParse`.
- Produces: `doCreatePr(task)` as a `runServerStage` branch; `verify("opening-pr")` reduced to a body check.

- [ ] **Step 1: Write the failing tests**

```ts
describe("creating the pull request", () => {
  it("pushes the approved commit, creates the PR, and rests in monitoring", async () => {
    const h = await atDiffGateFirstRound();          // helper: implementing verified, gate open, no reason
    h.gitState.head = "aaa";                          // equals approvedHead
    await h.engine.approve("bt1");
    await until(() => h.bugs.get("bt1").stage === "monitoring", 2000);
    const t = h.bugs.get("bt1");
    expect(h.gitState.pushes).toEqual([{ dir: t.worktree, branch: t.branch, force: false }]);
    expect(h.forge.created).toHaveLength(1);
    expect(t.pr).toMatchObject({ state: "OPEN" });
    expect(t.error).toBeNull();
  });

  it("refuses to create when the branch moved after approval", async () => {
    const h = await atDiffGateFirstRound();
    h.gitState.head = "zzz";                          // moved since the gate opened
    await h.engine.approve("bt1");
    await until(() => h.bugs.get("bt1").stage === "failed", 2000);
    expect(h.gitState.pushes).toEqual([]);
    expect(h.forge.created).toEqual([]);
    expect(h.bugs.get("bt1").error).toMatch(/moved since the diff was approved/i);
  });

  it("fails the stage with the forge's message when creation is unavailable", async () => {
    const h = await atDiffGateFirstRound();
    h.gitState.head = "aaa";
    h.forge.createResult = { unavailable: "bitbucket: 503 service unavailable" };
    await h.engine.approve("bt1");
    await until(() => h.bugs.get("bt1").stage === "failed", 2000);
    expect(h.bugs.get("bt1").error).toMatch(/503 service unavailable/);
  });

  it("is idempotent on retry: a PR that already exists is adopted, not duplicated", async () => {
    const h = await atDiffGateFirstRound();
    h.gitState.head = "aaa";
    h.forge.createResult = { unavailable: "network blip" };
    await h.engine.approve("bt1");
    await until(() => h.bugs.get("bt1").stage === "failed", 2000);
    h.forge.createResult = null;                      // the adapter now adopts the existing PR
    await h.engine.retry("bt1");
    await until(() => h.bugs.get("bt1").stage === "monitoring", 2000);
    expect(h.bugs.get("bt1").pr).toMatchObject({ state: "OPEN" });
  });

  it("verifies opening-pr by the PR body alone — no forge call", async () => {
    const h = await atDiffGateFirstRound();
    h.gitState.head = "aaa";
    h.bugs.writeArtifact("bt1", "pr-body.md", "");     // agent wrote nothing
    await h.engine.approve("bt1");
    await until(() => h.bugs.get("bt1").stage === "failed", 2000);
    expect(h.bugs.get("bt1").error).toMatch(/pr-body\.md/i);
    expect(h.forge.created).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/engine.test.ts`
Expected: FAIL — `opening-pr` still expects the agent to have created the PR.

- [ ] **Step 3: Reduce `verify("opening-pr")`**

Replace the whole `opening-pr` branch in `verify` with a body check. The pin re-check and the `findPr` confirmation move into `doCreatePr`, where the work now happens:

```ts
    if (task.stage === "opening-pr") {
      // The agent's only job here is the PR description — the server creates the PR
      // itself (see doCreatePr), so there is nothing outward to verify yet.
      const body = await bugs.readArtifact(task.id, "pr-body.md");
      if (!body?.trim()) throw new Error("the agent did not write pr-body.md");
      return;
    }
```

- [ ] **Step 4: Add `doCreatePr` and wire it**

In `runServerStage`, beside the `pushing` and `merging` branches:

```ts
    else if (task.stage === "creating-pr") await this.doCreatePr(task);
```

```ts
  /**
   * Push the approved commit and create the pull request. Server work for the same reason
   * `doPush` and `doMerge` are: it is deterministic, it is outward-facing, and doing it here
   * keeps every forge credential away from an agent. The pin is re-checked immediately
   * before the push — the diff gate may have been open for a long time.
   */
  private async doCreatePr(task: BugTask): Promise<void> {
    const { git, forge, bugs, tracker } = this.deps;
    if (!forge) throw new Error("no forge adapter: cannot create a pull request");
    const head = await git.revParse(task.worktree);
    if (head !== task.approvedHead) {
      throw new Error(`the branch moved since the diff was approved: approved ${task.approvedHead}, HEAD is now ${head}. Review the new diff (request changes, then approve again) before opening a pull request.`);
    }
    await git.push(task.worktree, task.branch);
    const body = path.join(bugs.dir(task.id), "pr-body.md");
    const created = await forge.createPr(task.sourceRepo, {
      title: `${task.issue.key}: ${task.issue.title}`, bodyFile: body,
      base: task.baseBranch, head: task.branch });
    if (!("found" in created) || !created.found) {
      throw new Error("unavailable" in created ? created.unavailable : "the forge did not return a pull request");
    }
    if (created.found.state !== "OPEN") throw new Error(`pull request #${created.found.number} is ${created.found.state.toLowerCase()}, not open`);
    await bugs.patchPr(task.id, created.found, new Date().toISOString());
    await tracker.comment(task.issue.key, `Fix in progress — pull request: ${created.found.url}`).catch(() => {});
  }
```

Use `patchPr`, not `patch` — it is the guarded writer Phase 2 added so a stale view cannot overwrite a newer one.

- [ ] **Step 5: Strip `createPrCommand` from the prompt layer**

In `server/src/bugfix/prompts.ts`: delete the `createPrCommand` field from `StageContext`, the `opening-pr` guard that throws when it is missing, and its entry in the substitution map. In `server/src/bugfix/engine.ts`'s `runStage` context, delete the `createPrCommand:` line.

- [ ] **Step 6: Rewrite the preset**

`server/presets/stages/open-pr.md` — the agent no longer runs anything:

```md
The fix for {{issueKey}} has been approved and is ready to go up as a pull request.

Your job in this step:

1. Read the plan at {{planPath}} and the approved diff (`git diff {{baseBranch}}...HEAD` in {{worktree}}).
2. Write the pull request description to {{prBodyPath}}: what the bug was, the root cause, the
   fix, how it was tested, and the line `Fixes {{issueUrl}}`.
3. Summarise what you wrote.

Do not push. Do not create the pull request. Do not merge. Do not change any code in this step.
The server pushes the exact commit that was approved and opens the pull request itself.
```

Update `server/test/bugfix/prompts.test.ts`: the `opening-pr` tests must no longer pass `createPrCommand` or expect the guard, and the negative assertions gain `gh pr create` — the preset must contain no instruction to create a PR.

- [ ] **Step 7: Run everything**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit`, then from `ui/`: `npx tsc -p tsconfig.json --noEmit`.
Expected: PASS, tsc clean in both.

- [ ] **Step 8: Commit**

```bash
git add server/src/bugfix server/presets/stages/open-pr.md server/test
git commit -m "feat(bugfix): the server pushes and opens the pull request"
```

---

### Task 4: the Bitbucket adapter — auth, identity and reads

**Files:**
- Create: `server/src/bugfix/forge/bitbucket.ts`, `server/test/bugfix/fixtures/bb/pr-open.json`, `server/test/bugfix/fixtures/bb/pr-merged.json`, `server/test/bugfix/fixtures/bb/user.json`
- Test: `server/test/bugfix/forge/bitbucket.test.ts`

**Interfaces:**
- Consumes: `ForgeAdapter`, `PrLookup`, `PrInfo`, `CreatePrContext`.
- Produces:
  ```ts
  export interface BitbucketDeps {
    username: string;                       // the Atlassian email, from ForgeConfig
    token?: () => string | undefined;       // defaults to () => process.env.BITBUCKET_API_TOKEN
    fetchFn?: typeof fetch;                 // injected in tests
  }
  export function bitbucketAdapter(deps: BitbucketDeps): ForgeAdapter;
  export function parseRepoSlug(remoteUrl: string): { workspace: string; slug: string } | null;
  ```

- [ ] **Step 1: Write the failing tests**

`server/test/bugfix/forge/bitbucket.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { bitbucketAdapter, parseRepoSlug } from "../../../src/bugfix/forge/bitbucket.js";

const fx = (n: string) => readFile(path.resolve("test/bugfix/fixtures/bb", n), "utf8");
const json = async (n: string, status = 200) => new Response(await fx(n), { status, headers: { "content-type": "application/json" } });

/** Records every request so a test can assert the URL, method and auth header. */
function recorder(reply: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; method: string; auth: string | null; body: string | null }> = [];
  const fetchFn = (async (url: any, init?: any) => {
    calls.push({ url: String(url), method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"), body: init?.body ? String(init.body) : null });
    return reply(String(url), init);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const deps = (fetchFn: typeof fetch, token: string | undefined = "tok") =>
  ({ username: "me@example.com", token: () => token, fetchFn });

describe("parseRepoSlug", () => {
  it("reads workspace and slug from SSH and HTTPS remotes", () => {
    expect(parseRepoSlug("git@bitbucket.org:acme/payments.git")).toEqual({ workspace: "acme", slug: "payments" });
    expect(parseRepoSlug("https://me@bitbucket.org/acme/payments.git")).toEqual({ workspace: "acme", slug: "payments" });
    expect(parseRepoSlug("ssh://git@bitbucket.org/acme/payments")).toEqual({ workspace: "acme", slug: "payments" });
    expect(parseRepoSlug("git@github.com:acme/payments.git")).toBeNull();
  });
});

describe("authStatus", () => {
  it("names the missing environment variable when there is no token", async () => {
    const { fetchFn } = recorder(async () => json("user.json"));
    const r = await bitbucketAdapter(deps(fetchFn, undefined)).authStatus();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/BITBUCKET_API_TOKEN/);
  });

  it("says the token was refused, not that the forge is down", async () => {
    const { fetchFn } = recorder(async () => new Response("", { status: 401 }));
    const r = await bitbucketAdapter(deps(fetchFn)).authStatus();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/refused|not accepted|401/i);
    expect(r.message).not.toMatch(/unreachable/i);
  });

  it("names the authenticated account, and sends Basic auth", async () => {
    const { calls, fetchFn } = recorder(async () => json("user.json"));
    const r = await bitbucketAdapter(deps(fetchFn)).authStatus();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/me@example\.com|Manoj/);
    expect(calls[0].url).toBe("https://api.bitbucket.org/2.0/user");
    expect(calls[0].auth).toBe(`Basic ${Buffer.from("me@example.com:tok").toString("base64")}`);
  });
});

describe("getPr", () => {
  it("normalises an open PR", async () => {
    const { fetchFn } = recorder(async url =>
      url.includes("/statuses") ? new Response(JSON.stringify({ values: [{ state: "SUCCESSFUL" }] }), { status: 200 })
      : url.includes("/conflicts") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : json("pr-open.json"));
    const r = await bitbucketAdapter(deps(fetchFn)).getPr("/r", 7);
    expect(r).toMatchObject({ found: { number: 7, state: "OPEN", checks: "SUCCESS", headSha: "abc123" } });
  });

  it("maps MERGED and DECLINED, and treats a 404 as no PR", async () => {
    const merged = recorder(async url => url.includes("/statuses") || url.includes("/conflicts")
      ? new Response(JSON.stringify({ values: [] }), { status: 200 }) : json("pr-merged.json"));
    expect(await bitbucketAdapter(deps(merged.fetchFn)).getPr("/r", 7)).toMatchObject({ found: { state: "MERGED" } });

    const gone = recorder(async () => new Response("", { status: 404 }));
    expect(await bitbucketAdapter(deps(gone.fetchFn)).getPr("/r", 7)).toEqual({ found: null });
  });

  it("treats a 429 and a network failure as unavailable, never as a missing PR", async () => {
    const limited = recorder(async () => new Response("", { status: 429 }));
    expect(await bitbucketAdapter(deps(limited.fetchFn)).getPr("/r", 7)).toMatchObject({ unavailable: expect.stringMatching(/rate|429/i) as unknown as string });

    const down = recorder(async () => { throw new TypeError("network down"); });
    expect(await bitbucketAdapter(deps(down.fetchFn)).getPr("/r", 7)).toMatchObject({ unavailable: expect.stringMatching(/network down/) as unknown as string });
  });

  it("never throws, whatever the body is", async () => {
    const junk = recorder(async () => new Response("not json", { status: 200 }));
    expect(await bitbucketAdapter(deps(junk.fetchFn)).getPr("/r", 7)).toHaveProperty("unavailable");
  });
});

describe("findPr", () => {
  it("queries by source branch, open first", async () => {
    const { calls, fetchFn } = recorder(async url =>
      url.includes("/statuses") || url.includes("/conflicts") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : new Response(JSON.stringify({ values: [JSON.parse(await fx("pr-open.json"))] }), { status: 200 }));
    const pr = await bitbucketAdapter(deps(fetchFn)).findPr("/r", "bugfix/PAY-42");
    expect(pr).toMatchObject({ number: 7 });
    expect(decodeURIComponent(calls[0].url)).toContain('source.branch.name="bugfix/PAY-42"');
    expect(decodeURIComponent(calls[0].url)).toContain('state="OPEN"');
  });
});
```

- [ ] **Step 2: Write the fixtures**

`server/test/bugfix/fixtures/bb/user.json`:

```json
{"account_id":"557058:abc","nickname":"manoj","display_name":"Manoj Mali","links":{"self":{"href":"https://api.bitbucket.org/2.0/user"}}}
```

`server/test/bugfix/fixtures/bb/pr-open.json`:

```json
{"id":7,"state":"OPEN","title":"PAY-42: Boom","updated_on":"2026-09-29T09:00:00.000000+00:00",
 "links":{"html":{"href":"https://bitbucket.org/acme/payments/pull-requests/7"}},
 "source":{"branch":{"name":"bugfix/PAY-42"},"commit":{"hash":"abc123"}},
 "destination":{"branch":{"name":"main"}},
 "participants":[{"user":{"nickname":"alice","account_id":"557058:alice"},"role":"REVIEWER","approved":true,"state":"approved"}]}
```

`server/test/bugfix/fixtures/bb/pr-merged.json`: the same shape with `"state":"MERGED"`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/bugfix/forge/bitbucket.test.ts`
Expected: FAIL — cannot find `../../../src/bugfix/forge/bitbucket.js`.

- [ ] **Step 4: Implement auth, identity and the reads**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CreatePrContext, ForgeAdapter, MergeMethod, MergeResult, PrLookup, ReviewEvent } from "./types.js";
import type { PrInfo } from "../types.js";

const run = promisify(execFile);
const API = "https://api.bitbucket.org/2.0";

export interface BitbucketDeps { username: string; token?: () => string | undefined; fetchFn?: typeof fetch }

/** `git@bitbucket.org:ws/slug.git`, `https://user@bitbucket.org/ws/slug.git`, `ssh://git@bitbucket.org/ws/slug`. */
export function parseRepoSlug(remoteUrl: string): { workspace: string; slug: string } | null {
  const m = /bitbucket\.org[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl.trim());
  return m ? { workspace: m[1], slug: m[2] } : null;
}
```

The adapter resolves the workspace/slug from the repo's `origin` remote once per call via `git -C <repoDir> remote get-url origin`, and caches nothing — a task's repo does not change mid-run, but caching across tasks would be a bug waiting for a second repo.

A single `api()` helper does every request: it builds Basic auth from `username` and the token getter, returns a discriminated result rather than throwing, and maps status codes once so every method agrees:

- no token → `{ kind: "no-token" }`
- 401/403 → `{ kind: "refused" }`
- 404 → `{ kind: "missing" }`
- 429 or any 5xx → `{ kind: "unavailable", message }`
- a thrown fetch (network) → `{ kind: "unavailable", message }`
- 2xx with unparseable JSON → `{ kind: "unavailable", message }`
- 2xx → `{ kind: "ok", body }`

`toPrInfo(pr, checks, conflicting)` maps Bitbucket's shape onto `PrInfo`: `id` → `number`, `links.html.href` → `url`, `state` → `OPEN`/`MERGED` with `DECLINED` and `SUPERSEDED` both mapping to `CLOSED`, `source.commit.hash` → `headSha`, `updated_on` → `lastSeenEventAt`. `reviewDecision`, `checks` and `mergeable` come from Task 5 and Task 6; until those land, pass `null` for `reviewDecision`/`mergeable` and wire `checks` from the statuses call in this task.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/bugfix/forge/bitbucket.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/bugfix/forge/bitbucket.ts server/test/bugfix/forge server/test/bugfix/fixtures/bb
git commit -m "feat(bugfix): Bitbucket adapter — auth, repo identity and PR reads"
```

---

### Task 5: the review-state folding

**Files:**
- Modify: `server/src/bugfix/forge/bitbucket.ts`
- Create: `server/test/bugfix/fixtures/bb/activity.json`
- Test: `server/test/bugfix/forge/bitbucket.test.ts` (append)

**Interfaces:**
- Produces: `listReviewEvents` on the Bitbucket adapter, and `reviewDecision` on the `PrInfo` it returns.

**The rule this task exists to enforce:** *any outstanding "changes requested" wins over any number of approvals.* The alternative merges over an unresolved objection.

- [ ] **Step 1: Write the failing tests**

```ts
describe("review state", () => {
  it("an outstanding changes-requested beats any number of approvals", async () => {
    const pr = { ...JSON.parse(await fx("pr-open.json")), participants: [
      { user: { nickname: "alice" }, approved: true,  state: "approved" },
      { user: { nickname: "bob" },   approved: true,  state: "approved" },
      { user: { nickname: "carol" }, approved: false, state: "changes_requested" }] };
    const { fetchFn } = recorder(async url =>
      url.includes("/statuses") || url.includes("/conflicts") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : new Response(JSON.stringify(pr), { status: 200 }));
    expect(await bitbucketAdapter(deps(fetchFn)).getPr("/r", 7))
      .toMatchObject({ found: { reviewDecision: "CHANGES_REQUESTED" } });
  });

  it("reports APPROVED only when someone approved and nobody is objecting", async () => {
    const approved = { ...JSON.parse(await fx("pr-open.json")), participants: [
      { user: { nickname: "alice" }, approved: true, state: "approved" }] };
    const none = { ...JSON.parse(await fx("pr-open.json")), participants: [
      { user: { nickname: "alice" }, approved: false, state: null }] };
    const mk = (body: unknown) => recorder(async url =>
      url.includes("/statuses") || url.includes("/conflicts") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : new Response(JSON.stringify(body), { status: 200 })).fetchFn;
    expect(await bitbucketAdapter(deps(mk(approved))).getPr("/r", 7)).toMatchObject({ found: { reviewDecision: "APPROVED" } });
    expect(await bitbucketAdapter(deps(mk(none))).getPr("/r", 7)).toMatchObject({ found: { reviewDecision: null } });
  });

  it("normalises activity into review and comment events, oldest first, strictly after `since`", async () => {
    const { fetchFn } = recorder(async () => json("activity.json"));
    const events = await bitbucketAdapter(deps(fetchFn)).listReviewEvents("/r", 7, "2026-09-29T09:00:00Z");
    expect(events.map(e => [e.kind, e.state, e.author, e.isBot])).toEqual([
      ["comment", "", "alice", false],
      ["review", "CHANGES_REQUESTED", "carol", false],
    ]);
    expect(events[0].body).toMatch(/leaks a handle/);
  });

  it("returns [] rather than throwing when the activity feed cannot be read", async () => {
    const { fetchFn } = recorder(async () => new Response("", { status: 500 }));
    expect(await bitbucketAdapter(deps(fetchFn)).listReviewEvents("/r", 7, "2026-09-29T09:00:00Z")).toEqual([]);
  });
});
```

`server/test/bugfix/fixtures/bb/activity.json` holds four entries: one comment before `since` (dropped), one comment after, one `changes_requested` approval entry after, and one `update` entry (not a review event, dropped).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/forge/bitbucket.test.ts`
Expected: FAIL — `reviewDecision` is `null` and `listReviewEvents` is not implemented.

- [ ] **Step 3: Implement the folding**

```ts
/**
 * Bitbucket has no `reviewDecision`: it has per-reviewer state on `participants`. Fold it
 * with one rule — ANY outstanding "changes requested" outranks ANY number of approvals.
 * The alternative is merging over an unresolved objection, which is the one direction that
 * cannot be walked back.
 */
function reviewDecision(pr: any): string | null {
  const parts: any[] = pr.participants ?? [];
  if (parts.some(p => String(p?.state ?? "").toLowerCase() === "changes_requested")) return "CHANGES_REQUESTED";
  if (parts.some(p => p?.approved === true)) return "APPROVED";
  return null;
}
```

`listReviewEvents` reads `GET /pullrequests/{id}/activity`, maps each entry: an `approval`/`changes_requested` entry becomes `kind: "review"` with the state uppercased; a `comment` entry becomes `kind: "comment"` with `state: ""`; anything else (`update`, `merge`) is dropped. `at` comes from the entry's own timestamp, filtered `> since` and sorted ascending. `isBot` uses the account type where Bitbucket reports one; where it does not, `false` — and the engine's rule still holds, because a bot cannot set a review decision.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/bugfix/forge/bitbucket.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/bugfix/forge/bitbucket.ts server/test/bugfix
git commit -m "feat(bugfix): fold Bitbucket's per-reviewer states into one review decision"
```

---

### Task 6: conflicts, merge and create

**Files:**
- Modify: `server/src/bugfix/forge/bitbucket.ts`, `server/src/bugfix/git.ts`
- Test: `server/test/bugfix/forge/bitbucket.test.ts` (append), `server/test/bugfix/git.test.ts` (append)

**Interfaces:**
- Produces: `mergeable` on the Bitbucket `PrInfo`; `merge`; `createPr`; and `GitOps.wouldConflict(dir, baseBranch): Promise<boolean>` as the forge-independent fallback.

- [ ] **Step 1: Write the failing tests**

```ts
describe("conflicts", () => {
  it("reports CONFLICTING when the conflicts endpoint lists any", async () => {
    const { fetchFn } = recorder(async url =>
      url.includes("/conflicts") ? new Response(JSON.stringify({ values: [{ path: "src/a.ts" }] }), { status: 200 })
      : url.includes("/statuses") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : json("pr-open.json"));
    expect(await bitbucketAdapter(deps(fetchFn)).getPr("/r", 7)).toMatchObject({ found: { mergeable: "CONFLICTING" } });
  });

  it("leaves mergeable null when the conflicts endpoint is unavailable — never guesses MERGEABLE", async () => {
    const { fetchFn } = recorder(async url =>
      url.includes("/conflicts") ? new Response("", { status: 503 })
      : url.includes("/statuses") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : json("pr-open.json"));
    expect(await bitbucketAdapter(deps(fetchFn)).getPr("/r", 7)).toMatchObject({ found: { mergeable: null } });
  });
});

describe("merge", () => {
  it("maps squash and merge, and posts close_source_branch", async () => {
    const { calls, fetchFn } = recorder(async () => json("pr-merged.json"));
    const f = bitbucketAdapter(deps(fetchFn));
    expect(await f.merge("/r", 7, "squash")).toMatchObject({ ok: true });
    expect(JSON.parse(calls[0].body!)).toMatchObject({ merge_strategy: "squash", close_source_branch: true });
    await f.merge("/r", 7, "merge");
    expect(JSON.parse(calls[1].body!)).toMatchObject({ merge_strategy: "merge_commit" });
  });

  it("REFUSES rebase rather than silently fast-forwarding", async () => {
    const { calls, fetchFn } = recorder(async () => json("pr-merged.json"));
    const r = await bitbucketAdapter(deps(fetchFn)).merge("/r", 7, "rebase");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rebase/i);
    expect(calls).toEqual([]);            // nothing was sent
  });

  it("reports the forge's reason when a merge is refused", async () => {
    const { fetchFn } = recorder(async () => new Response(JSON.stringify({ error: { message: "pull request has conflicts" } }), { status: 400 }));
    expect(await bitbucketAdapter(deps(fetchFn)).merge("/r", 7, "squash"))
      .toMatchObject({ ok: false, message: expect.stringMatching(/conflicts/i) as unknown as string });
  });
});

describe("createPr", () => {
  it("posts the title, branches and the body read from the file", async () => {
    const { calls, fetchFn } = recorder(async url =>
      url.includes("/statuses") || url.includes("/conflicts") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : json("pr-open.json"));
    const body = path.join(await mkdtemp(path.join(tmpdir(), "bb-")), "pr-body.md");
    await writeFile(body, "## What broke\nA handle leak.\n");
    const r = await bitbucketAdapter(deps(fetchFn)).createPr("/r", { title: "PAY-42: Boom", bodyFile: body, base: "main", head: "bugfix/PAY-42" });
    const sent = JSON.parse(calls[0].body!);
    expect(sent).toMatchObject({ title: "PAY-42: Boom", source: { branch: { name: "bugfix/PAY-42" } }, destination: { branch: { name: "main" } } });
    expect(sent.description).toMatch(/handle leak/);
    expect(r).toMatchObject({ found: { number: 7 } });
  });

  it("adopts an existing PR when the forge refuses a duplicate", async () => {
    let post = 0;
    const { fetchFn } = recorder(async (url, init) => {
      if (init?.method === "POST") { post += 1; return new Response(JSON.stringify({ error: { message: "branch already has an open pull request" } }), { status: 400 }); }
      if (url.includes("/statuses") || url.includes("/conflicts")) return new Response(JSON.stringify({ values: [] }), { status: 200 });
      return new Response(JSON.stringify({ values: [JSON.parse(await fx("pr-open.json"))] }), { status: 200 });
    });
    const body = path.join(await mkdtemp(path.join(tmpdir(), "bb-")), "pr-body.md");
    await writeFile(body, "b");
    expect(await bitbucketAdapter(deps(fetchFn)).createPr("/r", { title: "t", bodyFile: body, base: "main", head: "bugfix/PAY-42" }))
      .toMatchObject({ found: { number: 7 } });
    expect(post).toBe(1);
  });
});
```

Append to `server/test/bugfix/git.test.ts`:

```ts
describe("wouldConflict", () => {
  it("is true for a real conflict against the base and false for a clean merge", async () => {
    const repo = await makeRepo();
    await writeFile(path.join(repo, "c.txt"), "base\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"], { cwd: repo });
    await run("git", ["checkout", "-b", "side"], { cwd: repo });
    await writeFile(path.join(repo, "c.txt"), "side\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "side"], { cwd: repo });
    await run("git", ["checkout", "main"], { cwd: repo });
    await writeFile(path.join(repo, "c.txt"), "main\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "main"], { cwd: repo });
    await run("git", ["checkout", "side"], { cwd: repo });

    const git = new GitOps();
    expect(await git.wouldConflict(repo, "main")).toBe(true);

    const clean = await makeRepo();
    await run("git", ["checkout", "-b", "feature"], { cwd: clean });
    await writeFile(path.join(clean, "new.txt"), "only here\n");
    await run("git", ["add", "-A"], { cwd: clean });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "feature"], { cwd: clean });
    expect(await git.wouldConflict(clean, "main")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/forge/bitbucket.test.ts test/bugfix/git.test.ts`
Expected: FAIL — `merge`/`createPr` unimplemented, `git.wouldConflict is not a function`.

- [ ] **Step 3: Implement conflicts, with the fallback**

```ts
/**
 * Bitbucket's PR object carries no `mergeable`. `/conflicts` answers it, but Atlassian has
 * said this area is changing (the diffstat "merge conflict" status is documented as going
 * away, with a new public API to follow), so the caller can pass a local fallback: the
 * server has the worktree and can answer with `git merge-tree` without any forge at all.
 * Unknown is `null` — never guess MERGEABLE, because that is the answer that skips a rebase.
 */
```

`mergeable` is `"CONFLICTING"` when `/conflicts` returns any entries, `"MERGEABLE"` when it returns an empty list, and `null` for every other outcome (unavailable, refused, unparseable).

In `server/src/bugfix/git.ts`:

```ts
/** Would merging the base into HEAD conflict? `merge-tree` answers without touching the worktree. */
async wouldConflict(dir: string, baseBranch: string): Promise<boolean> {
  const r = await this.run(dir, ["merge-tree", "--write-tree", "--name-only", baseBranch, "HEAD"]);
  return r.code !== 0;   // git exits non-zero when the merge would conflict
}
```

Check the real runner's shape before writing this — `this.run` in `git.ts` takes `(cwd, args)` and returns a string, and the existing methods that need an exit code handle it their own way; follow whichever the file actually does and say so in your report.

- [ ] **Step 4: Implement merge and createPr**

`merge` maps `squash` → `squash`, `merge` → `merge_commit`, and **returns `{ ok: false }` for `rebase` without sending anything**, with a message naming the reason. It posts `{ merge_strategy, close_source_branch: true }` and returns `{ ok: true, message }` on 2xx, otherwise `{ ok: false }` with the forge's `error.message` when present.

`createPr` reads `ctx.bodyFile` from disk into `description`, posts `{ title, source: { branch: { name: head } }, destination: { branch: { name: base } }, description }`, and on a duplicate-rejection falls back to `findPr(repoDir, ctx.head)` so a retry adopts rather than duplicates.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/bugfix/forge/bitbucket.ts server/src/bugfix/git.ts server/test
git commit -m "feat(bugfix): Bitbucket conflicts, merge and PR creation"
```

---

### Task 7: wiring, config and the adapter contract

**Files:**
- Modify: `server/src/bugfix/forge/index.ts`, `server/src/bugfix/integrations.ts`, `server/src/api/app.ts`, `server/src/start.ts`
- Create: `server/test/bugfix/forge/contract.test.ts`
- Test: `server/test/bugfix/integrations.test.ts` (append), `server/test/bugfix/api.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  export interface ForgeConfig { preset: "github" | "gitlab" | "bitbucket" | "custom"; username?: string; … }
  export function makeForge(cfg: ForgeConfig | undefined, run?: Runner): ForgeAdapter | null;  // "bitbucket" → bitbucketAdapter
  ```
  `detectForge` gains a `"bitbucket"` case for `bitbucket.org`.

- [ ] **Step 1: Write the failing tests**

`server/test/bugfix/forge/contract.test.ts` — one contract both adapters satisfy, so the next forge has a checklist rather than a reading exercise:

```ts
import { describe, it, expect } from "vitest";
import { githubAdapter } from "../../../src/bugfix/forge/github.js";
import { bitbucketAdapter } from "../../../src/bugfix/forge/bitbucket.js";
import type { ForgeAdapter } from "../../../src/bugfix/forge/types.js";

/** Every adapter must satisfy these, whatever it talks to. */
const adapters: Array<[string, () => ForgeAdapter]> = [
  ["github", () => githubAdapter(async () => ({ stdout: "", code: 1, stderr: "boom" }))],
  ["bitbucket", () => bitbucketAdapter({ username: "me@example.com", token: () => "t",
    fetchFn: (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch })],
];

describe.each(adapters)("the %s adapter satisfies the forge contract", (_name, make) => {
  it("getPr never throws and reports unavailability rather than absence", async () => {
    const r = await make().getPr("/r", 7);
    expect(r).toHaveProperty("unavailable");
  });
  it("listReviewEvents never throws and degrades to []", async () => {
    await expect(make().listReviewEvents("/r", 7, "2026-01-01T00:00:00Z")).resolves.toEqual([]);
  });
  it("merge never throws and reports ok:false", async () => {
    await expect(make().merge("/r", 7, "squash")).resolves.toMatchObject({ ok: false });
  });
  it("findPr never throws and returns null when it cannot answer", async () => {
    await expect(make().findPr("/r", "b")).resolves.toBeNull();
  });
  it("authStatus never throws and reports ok:false", async () => {
    await expect(make().authStatus()).resolves.toMatchObject({ ok: false });
  });
});
```

Append to `server/test/bugfix/integrations.test.ts`:

```ts
it("detects bitbucket.org, and keeps github and gitlab as they were", () => {
  expect(detectForge("git@bitbucket.org:acme/payments.git")).toBe("bitbucket");
  expect(detectForge("https://bitbucket.org/acme/payments")).toBe("bitbucket");
  expect(detectForge("git@github.com:acme/app.git")).toBe("github");
  expect(detectForge("https://gitlab.com/acme/app")).toBe("gitlab");
  expect(detectForge("git@example.com:acme/app.git")).toBeNull();
});
```

Append to `server/test/bugfix/api.test.ts`: `PUT /api/integrations` accepts `forge.preset: "bitbucket"` with a `username`, and still 400s on an out-of-enum preset.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix`
Expected: FAIL — `makeForge` has no bitbucket case, `detectForge` returns null for bitbucket.org, the route rejects the preset.

- [ ] **Step 3: Wire it**

`makeForge` gains:

```ts
  if (cfg?.preset === "bitbucket") {
    if (!cfg.username?.trim()) return null;   // no email, no Basic auth — preflight reports it
    return bitbucketAdapter({ username: cfg.username });
  }
```

`detectForge` gains the `bitbucket.org` case beside the existing host checks. `ForgeConfig` gains `"bitbucket"` and `username?: string`. `app.ts`'s `FORGE_PRESETS` gains `"bitbucket"`, and the route validates `username` is a string when present.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit`; from `ui/`: `npx tsc -p tsconfig.json --noEmit`.
Expected: PASS, tsc clean in both.

- [ ] **Step 5: Commit**

```bash
git add server/src/bugfix server/src/api/app.ts server/test
git commit -m "feat(bugfix): wire the Bitbucket preset, and one contract both adapters satisfy"
```

---

### Task 8: the offline loop, the docs and the version

**Files:**
- Modify: `server/test/bugfix/flow.test.ts`, `server/src/fake/forge.ts`, `README.md`, `desktop/package.json`
- Test: the offline flow test and the existing e2e

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Extend the offline loop for the new stage**

`flow.test.ts`'s walk currently goes `diff-review` → approve → `monitoring`. It now passes through `creating-pr`. Assert that stage is reached and that the fake forge recorded exactly one creation — the loop must prove the server created the PR, not the agent.

- [ ] **Step 2: Run it**

Run: `cd server && npx vitest run test/bugfix/flow.test.ts`
Expected: PASS, in seconds.

- [ ] **Step 3: Prove the e2e still passes on GitHub**

Run, from `ui/`: `npx playwright test`
Expected: 7 passed. **This is the gate the spec's §5.4 names**: the GitHub path must be green before anything is pointed at Bitbucket, so a later failure is unambiguous about which forge broke. If it fails, stop and report rather than adjusting the test.

- [ ] **Step 4: Document the setup**

Extend `README.md`'s bug-fix section with the Bitbucket prerequisites: `forge: { "preset": "bitbucket", "username": "<atlassian email>" }` in `integrations.json`, and `BITBUCKET_API_TOKEN` exported in the shell the app inherits (noting the desktop app reads the login shell's environment, so a restart is needed after exporting). State plainly that `rebase` is not an available merge method on Bitbucket.

- [ ] **Step 5: Bump**

`desktop/package.json` to `0.3.0` — a new forge and a changed PR-creation path is a feature release.

- [ ] **Step 6: Run everything**

From `server/`: `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`. From `ui/`: `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `npx playwright test`.
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add server/test/bugfix/flow.test.ts server/src/fake/forge.ts README.md desktop/package.json
git commit -m "test(bugfix): drive creating-pr offline; document Bitbucket setup; 0.3.0"
```

---

## Notes for the executor

- **`PrInfo` is the contract, not Bitbucket's shape.** Every field the stage machine reads — `state`, `reviewDecision`, `checks`, `mergeable`, `headSha`, `lastSeenEventAt` — must be normalised in the adapter. Nothing downstream may learn which forge it is talking to.
- **`null` means "unknown" and must never be "fine".** `mergeable: null` skips a rebase round; `checks: null` is not success. The fail-closed rule from Phase 2 applies to this adapter too.
- **The token getter is a function**, not a captured string, so a token exported after the server started is picked up on the next call rather than at construction.
- **Task 1 leaves the tree briefly inconsistent** (the engine still references `createPrCommand` until Task 3). If it does not compile at the end of Task 1, stub the call site and say so; do not reach forward into Task 3's work.
- **The spec's §4.3 foldings are the risky part.** If real Bitbucket responses contradict a fixture, trust the real response, fix the fixture, and say so in the report — the fixtures were written from documentation, not from live traffic.
