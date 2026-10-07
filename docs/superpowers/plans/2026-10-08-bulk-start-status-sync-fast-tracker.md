# Bulk Start, Tracker Status Sync, Fast Tracker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Start fixes for many tickets at once.
- Move tickets through the tracker's statuses as the work goes on.
- Make tracker reads fast.

**Architecture:**
- **Fast reads.** Tracker calls run on Haiku. A server `TrackerCache` (disk-backed, stale-while-revalidate,
  batched prefetch) answers the list and ticket routes, and pushes changes over SSE.
- **Status sync.** New preset sections (`fetchIssues`, `listTransitions`, `transition`) back a batched
  read and a `TrackerSync` that applies a per-project `statusMap` at workflow moments.
- **Bulk start.** A `BatchStarter` fetches each repo once and reads tickets 20 at a time, then calls
  `intake` with prefetched data, reporting progress over SSE.
- **UI.** Checkboxes on the Bugs list drive a Start N panel.

**Tech Stack:** Node/Express + TypeScript (server), React 19 (ui), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-bulk-start-status-sync-fast-tracker-design.md`

## Global Constraints

- **Model.** Tracker calls use `claude-haiku-4-5-20251001` with `effort: "low"`.
- **Cache timings.** The list goes stale after **2 min**, details after **15 min**. Prefetch batches
  hold **20** keys, one batch at a time. Disk writes happen at most every **5 s**. The cache file is
  `~/.agentgrid/tracker-cache.json`.
- **Batches.** At most **500** items per request, and one batch at a time per repo.
- **Status moves.** Best effort, one retry after **30 s**. They never fail a stage. Results go into
  task history; the last failure is kept in `task.trackerSyncError`.
- **Release.** Version **0.13.0**.
- **Commits** end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019vk3Y8Lj3YYsuDjzfQ2MBB
  ```

## Review Focus

1. **Two refreshes at once.** A list refresh racing a forced Refresh, or two ticket reads of the same
   key, must cost one tracker call, and the newer result must win. Pinned in Task 2.
2. **A batch that partly fails.** A tracker read that misses some keys, or one repo's preflight
   failing, must fail only those items, and every other item must start. Pinned in Task 6.
3. **A status move racing the next moment.** "PR opened" and "Merged" landing close together must
   apply in moment order, never "In Review" after "Done". Pinned in Task 4.
4. **A stale cache after a tracker config change.** It must not show the old tracker's bugs. Pinned
   in Task 3.
5. **Bulk start with tickets already started or leftover worktrees.** These must be per-item
   failures with the existing remediation message, not a batch abort. Pinned in Task 6.

---

### Task 1: Tracker — Haiku, batched reads, transitions

**Files:**
- Modify: `server/src/bugfix/tracker.ts`, `server/presets/tracker/jira.md`, `server/src/start.ts` (fake tracker)
- Test: `server/test/bugfix/tracker.test.ts`

**Interfaces:**
- Produces, in `TrackerProvider`:
  ```ts
  fetchIssues?(keys: string[]): Promise<{ issues: TrackerIssue[]; missing: string[] }>;
  listTransitions?(key: string): Promise<Array<{ id: string; name: string; to: string }>>;
  transition?(key: string, name: string): Promise<{ ok: true; status: string } | { ok: false; error: string }>;
  ```
  - `mcpTracker` implements all three when the preset has the section; otherwise the method is
    absent. A `hasSection(preset, name)` check runs at construction.
  - `fetchIssuesVia(tracker, keys)` (exported helper): uses `fetchIssues` when present, otherwise
    `fetchIssue` per key with at most 3 at a time, collecting failures into `missing`.
  - `parseIssues(raw, keys)`, `parseTransitions(raw)`, `parseTransitionResult(raw)`.
  - `defaultJsonRunner` uses Haiku.
  - The jira preset gains the three sections. `listMyIssues` raises its cap to "At most 200".

- [ ] **Step 1: Failing tests**

```ts
it("the tracker runs on Haiku", async () => {
  const seen: unknown[] = []; vi.spyOn(sdk, "realQuery").mockImplementation(((a: any) => { seen.push(a.options.model); return (async function* () { yield { type: "result", subtype: "success" } as any; })(); }) as any);
  await defaultJsonRunner({ prompt: "x", allowedTools: [], cwd: "/" });
  expect(seen).toEqual(["claude-haiku-4-5-20251001"]);
});
it("fetchIssues reads a batch and reports keys it didn't get", async () => {
  const run: JsonRunner = async ({ prompt }) => { expect(prompt).toContain("PAY-1, PAY-2, PAY-3"); return JSON.stringify([{ key: "PAY-1", title: "a" }, { key: "PAY-3", title: "c" }]); };
  const t = mcpTracker({ preset: "jira", toolPrefix: "mcp__jira" }, path.resolve("presets"), run);
  expect(await t.fetchIssues!(["PAY-1", "PAY-2", "PAY-3"])).toMatchObject({ issues: [{ key: "PAY-1" }, { key: "PAY-3" }], missing: ["PAY-2"] });
});
it("without fetchIssues, reads one by one, at most 3 at a time", async () => { /* stub provider with fetchIssue counting concurrency; fetchIssuesVia over 7 keys → max concurrent 3; a throwing key lands in missing */ });
it("transitions: lists what the ticket can do; a move reports ok or why not", async () => {
  expect(parseTransitions('[{"id":"31","name":"Start Progress","to":"In Progress"}]')).toEqual([{ id: "31", name: "Start Progress", to: "In Progress" }]);
  expect(parseTransitionResult('{"ok":true,"status":"In Review"}')).toEqual({ ok: true, status: "In Review" });
  expect(parseTransitionResult('{"ok":false,"error":"not allowed"}')).toEqual({ ok: false, error: "not allowed" });
  expect(parseTransitionResult("I could not do that")).toMatchObject({ ok: false });
});
it("a preset without the sections offers no such methods", async () => { /* temp presets dir with only listMyIssues/fetchIssue/comment → t.fetchIssues undefined, t.transition undefined */ });
```

  Write the two `/* … */` bodies in full, in the test file.

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`jira.md` sections:**
    ```
    ## fetchIssues
    Look up each of these issues: {{keys}}
    {{hints}}

    Return ONLY a JSON array, no prose, one object per issue found, each:
    {"key":"…","title":"…","url":"…","status":"…","priority":"…",
     "description":"the full description as plain text","acceptanceCriteria":["…"]}

    ## listTransitions
    For issue {{key}}, list the workflow transitions available right now.
    Return ONLY a JSON array, no prose: [{"id":"…","name":"…","to":"the status it moves to"}]

    ## transition
    Move issue {{key}} using the transition named "{{transition}}". Do nothing else.
    Return ONLY JSON, no prose: {"ok":true,"status":"<the issue's status now>"} or {"ok":false,"error":"<why>"}
    ```
  - **Parsers:**
    - `parseIssues`: map the array through the same normalisation as `parseIssue`, skipping invalid
      entries; `missing` is the requested keys that aren't in the result.
    - `parseTransitionResult`: anything unparseable becomes `{ ok: false, error: "the tracker gave no clear answer: <first 120 chars>" }`.
  - **The fake tracker** (`start.ts`):
    - `fetchIssues` maps keys through the existing `fetchIssue`;
    - `listTransitions` returns three transitions: → In Progress, → In Review, → Done;
    - `transition` records calls in `fakeTrackerMoves` (exported for tests) and returns
      `{ ok: true, status }`.
- [ ] **Step 4: Run the server suite.** Expected: PASS.
- [ ] **Step 5: Commit** with the message
  `feat(tracker): Haiku, batched reads, workflow transitions in the preset`.

### Task 2: TrackerCache

**Files:**
- Create: `server/src/bugfix/trackerCache.ts`, `server/test/bugfix/trackerCache.test.ts`
- Modify: `server/src/types.ts` (GridEvent `tracker-issues`, `tracker-issue`)

**Interfaces:**
- Produces:
  ```ts
  export interface IssueList { issues: IssueSummary[]; fetchedAt: string | null; refreshing: boolean; error: string | null }
  export class TrackerCache extends EventEmitter {          // emits "event": { type: "tracker-issues", list } | { type: "tracker-issue", issue }
    constructor(deps: { tracker: TrackerProvider; file: string; now?: () => number; listTtlMs?: number; issueTtlMs?: number; writeEveryMs?: number });
    load(): Promise<void>;                                    // read the disk file; corrupt → empty
    myIssues(): IssueList;                                    // immediate; triggers a background refresh when stale or empty
    refresh(): Promise<IssueList>;                            // one in flight at a time; error keeps the list
    issue(key: string): Promise<TrackerIssue>;                // TTL; one fetch per key in flight
    issues(keys: string[]): Promise<{ issues: TrackerIssue[]; missing: string[] }>;  // batches of 20 via fetchIssuesVia
    invalidate(key: string): void;
    clear(): void;
    flush(): Promise<void>;                                   // write now (tests, shutdown)
  }
  ```
  - After a successful `refresh`, it prefetches stale or missing details of listed keys, 20 at a time,
    sequentially, without awaiting the caller.
  - Disk shape: `{ list: {issues, fetchedAt}, issues: { [key]: { issue, fetchedAt } } }`.

- [ ] **Step 1: Failing tests** (a stub tracker counting calls, with deferred promises to control
  timing):
  - **Stale-while-revalidate:**
    - the first `myIssues()` returns `{ issues: [], refreshing: true }` and starts one refresh;
    - a second call meanwhile starts no other;
    - after it resolves, `myIssues()` returns the list with no new call;
    - after 2 min, the next call returns the old list and starts one refresh.
  - **Review Focus 1:**
    - `refresh()` called twice concurrently → one `listMyIssues` call;
    - `issue("A")` twice concurrently → one `fetchIssue`.
  - **A failed refresh** keeps the list and sets `error`; the next success clears it.
  - **The detail TTL:** within 15 min, no refetch; after it, refetch. `invalidate` forces a refetch.
  - **Prefetch:**
    - a list of 45 keys leads to `fetchIssues` calls of 20, 20 and 5, one at a time;
    - cached-fresh keys are skipped.
  - **Persistence:**
    - `flush()`, then a new cache `load()`s the list and issues, and `myIssues()` answers at once
      with `fetchedAt` preserved;
    - a corrupt file means an empty cache, with no throw.
  - **Events:** `tracker-issues` fires after a refresh; `tracker-issue` fires after each detail fetch.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use the store's exported `writeAtomic`, with writes debounced by
  `writeEveryMs`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** with the message
  `feat(tracker): a cache that answers at once and refreshes behind the scenes`.

### Task 3: Routes and UI on the cache

**Files:**
- Modify:
  - `server/src/api/app.ts`: `GET /api/bugfix/issues` returns an `IssueList`; add
    `POST /api/bugfix/issues/refresh` (202); `GET /api/bugfix/issues/:key` goes through the cache;
  - `server/src/start.ts`: build the cache in `wireBugFix`, forward its events, `clear()` it on
    `onConfigSaved` when the tracker changed, `flush()` on close;
  - `server/src/bugfix/engine.ts`: `intake` calls `cache.invalidate(key)` after creating the task,
    when it has a cache.
  - `ui/src/api.ts` (`myIssues(): IssueList`, `refreshIssues()`), `ui/src/state/reducer.ts` (a
    `tracker: IssueList | null` slice fed by the events; `issue` cache of
    `Record<string, TrackerIssue>`), `ui/src/components/BugScreen.tsx` (use `state.tracker` when
    present; "updated 40s ago" and a Refreshing spinner; Refresh calls `refreshIssues`),
    `ui/src/components/BugLauncher.tsx` (read `.issues`), `ui/src/components/TicketDetail.tsx`
    (prefer `state.issues[key]` when given, then fetch).
- Test: `server/test/bugfix/api.test.ts`, `ui/test/BugScreen.test.tsx`, `ui/test/BugLauncher.test.tsx`,
  `ui/test/reducer.test.ts`.

**Interfaces:**
- `AppDeps.bugs` gains `trackerCache?: TrackerCache`. When absent (tests with a fake engine), the
  routes fall back to calling the tracker directly and wrap the result as `IssueList`.

- [ ] **Step 1: Failing tests.**
  - **API:**
    - `GET /api/bugfix/issues` → `{ issues: [...], fetchedAt: <iso>, refreshing: false, error: null }`;
    - `POST /api/bugfix/issues/refresh` → 202;
    - **Review Focus 4:** after a `PUT /api/integrations` changing the tracker, the list is empty and
      refreshing (the cache was cleared).
  - **UI:**
    - BugScreen shows "updated 2 min ago" from `fetchedAt`, and while `refreshing` the Refresh button
      shows "Refreshing…";
    - a `tracker-issues` event updates the list without a refetch;
    - BugLauncher still lists issues (from `.issues`).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both suites and the e2e tests.** Expected: PASS. Update the fake-mode e2e if it
  read the array shape.
- [ ] **Step 5: Commit** with the message
  `feat: the bug list and tickets come from the cache — instant, refreshed in the background`.

### Task 4: TrackerSync — statuses follow the work

**Files:**
- Create: `server/src/bugfix/trackerSync.ts`, `server/test/bugfix/trackerSync.test.ts`
- Modify:
  - `server/src/bugfix/integrations.ts`
    (`statusMap?: Record<string, Partial<Record<Moment, string>>>`);
  - `server/src/bugfix/types.ts` (`trackerSyncError: string | null`), `server/src/bugfix/store.ts`;
  - `server/src/bugfix/engine.ts` (emit moments).

**Interfaces:**
- Produces:
  ```ts
  export type Moment = "started" | "prOpened" | "merged" | "closed" | "noChange";
  export class TrackerSync {
    constructor(deps: { tracker: TrackerProvider; bugs: BugTaskStore; statusMap: () => Promise<Integrations["statusMap"]>; retryMs?: number; now?: () => number });
    /** Queue the move for this moment, if mapped. Per-ticket FIFO; never throws. */ moment(taskId: string, m: Moment): void;
    /** Resolves when everything queued so far has settled (tests). */ idle(): Promise<void>;
  }
  ```
  - **A move:**
    1. Find the transition name from `statusMap[task.trackerProject]?.[m]`. If there is none, or the
       tracker has no `transition`, do nothing.
    2. Call `tracker.transition(key, name)`.
       - **ok:** history "Moved <KEY> to <status>"; clear `trackerSyncError`.
       - **not ok:** if `listTransitions` shows the ticket is already in the target status, it's a
         no-op (history "<KEY> is already <status>"). Otherwise, retry once after `retryMs`
         (default 30 000). Then history "Couldn't move <KEY> to <target>: <error>" and set
         `trackerSyncError`.
  - **Engine hooks** call `this.sync?.moment(id, m)`:
    - after intake;
    - after a PR is created or adopted, next to the existing comments;
    - on transitions to `done` with outcome `merged`, `closed` or `no-change`.
  - `engine.setTrackerSync(sync)`.

- [ ] **Step 1: Failing tests:**
  - an unmapped moment makes no tracker call;
  - a mapped one calls `transition("PAY-42", "Start Progress")` and history gets
    "Moved PAY-42 to In Progress";
  - a failure retries once, then records history and `trackerSyncError`, and a later success clears
    it;
  - "already there" is a no-op;
  - **Review Focus 3:** `moment(prOpened)` then `moment(merged)` while the first is still pending
    (deferred) → the calls happen in that order;
  - the engine queues `started` after intake, and `noChange` when closed as no change, using a
    recording sync stub;
  - a tracker without `transition` is a no-op.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Wire it in `start.ts`:
  `new TrackerSync({ tracker, bugs: bugStore, statusMap: async () => (await integrations.read()).statusMap })`.
- [ ] **Step 4: Run the server suite.** Expected: PASS.
- [ ] **Step 5: Commit** with the message
  `feat(tracker): tickets move through your workflow as the fix goes on`.

### Task 5: Settings → Ticket statuses

**Files:**
- Modify:
  - `server/src/api/app.ts`:
    - `GET /api/bugfix/transitions?key=PAY-42` → the transitions (cached for 1 h per project
      prefix), or 501 when unsupported;
    - `PUT /api/integrations` accepts `statusMap`, validated: project keys `/^[A-Z][A-Z0-9_]*$/`,
      moments from the five, values non-empty strings up to 100 characters;
    - redact passes `statusMap` through.
  - `ui/src/api.ts`, `ui/src/components/SettingsDialog.tsx` (a `TicketStatuses` section);
  - `ui/src/components/BugGates.tsx` or `BugScreen.tsx` (show `trackerSyncError` as a blocker via
    `blockersFor`).
- Test: `server/test/bugfix/api.test.ts`, `ui/src/components/SettingsDialog.test.tsx`, `ui/test/bugView.test.ts`.

- [ ] **Step 1: Failing tests.**
  - **Server:**
    - transitions route: the fake engine's tracker has `listTransitions` → 200 with its list;
    - no method → 501 "status sync isn't supported for this tracker";
    - a bad key → 400;
    - `statusMap` validation: 400 on a bad project or moment, 200 and stored otherwise.
  - **UI:**
    - the section lists the projects from `projectRepos` and a sample-key input prefilled from the
      latest task of that project;
    - "Load transitions" fills five selects offering "→ In Progress" and so on, plus "Don't change
      the status";
    - Save sends `statusMap: { PAY: { started: "Start Progress", prOpened: "Submit for Review" } }`;
    - unsupported shows the 501 message.
  - **blockersFor** shows `trackerSyncError`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both suites.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: Settings → Ticket statuses, from your workflow's real transitions`.

### Task 6: Batch start (server)

**Files:**
- Create: `server/src/bugfix/batch.ts`, `server/test/bugfix/batch.test.ts`
- Modify:
  - `server/src/bugfix/engine.ts`: `intake(input & { issue?: TrackerIssue; fetched?: boolean })`
    skips the tracker read when `issue` is given, and the fetch when `fetched`;
  - `server/src/types.ts` (GridEvent `batch`), `server/src/api/app.ts` (routes),
    `server/src/start.ts` (wire it).

**Interfaces:**
- Produces:
  ```ts
  export interface BatchState { batchId: string; total: number; done: number; started: Array<{ key: string; taskId: string }>;
    skipped: Array<{ key: string; message: string }>; failed: Array<{ key: string; message: string }>; finished: boolean }
  export class BatchStarter extends EventEmitter {    // emits "event": { type: "batch", state }
    constructor(deps: { engine: BugFixEngine; git: GitOps; cache: TrackerCache | null; tracker: TrackerProvider });
    start(items: Array<{ issueRef: string; repo: string; baseBranch?: string }>, startAnyway: string[]): string;   // batchId; runs in background
    get(id: string): BatchState | null;               // last 10 kept
  }
  ```
  - **Runs, in order:**
    1. Group the items by repo.
    2. Per repo, under a per-repo lock: `git.fetch(repo)`; a failure fails all that repo's items
       with "could not fetch from origin: …".
    3. Read all the keys: `cache.issues(keys)` if there is a cache, else `fetchIssuesVia`. Missing
       keys fail with "couldn't read <KEY> from the tracker".
    4. For each item, `engine.intake({ issueRef, repo, baseBranch, issue, fetched: true, startAnyway: startAnyway.includes(key) })`:
       - success → started;
       - a Conflict with `code === "already-on-base"` → skipped, with its message (it includes the
         commits);
       - any other error → failed, with its message (the leftover-worktree remediation included).
    5. An event after each item, and at the end.
  - **Routes:**
    - `POST /api/bugtasks/batch` takes `{ items, startAnyway? }`:
      - 400 on an empty list, more than 500 items, or an item that isn't
        `{ issueRef: string, repo: absolute path }`;
      - otherwise 202 `{ batchId }`.
    - `GET /api/bugtasks/batch/:id` returns the `BatchState`, or 404.

- [ ] **Step 1: Failing tests** (the engine's fake-git harness pattern: a real `BugFixEngine` with
  fake git, a fake tracker and fake queries; cap 4):
  - **Review Focus 2:**
    - three items in one repo, plus one item in a repo whose fetch throws: one fetch per repo;
    - the tracker read covers the three keys in one call;
    - the three start, and the fourth fails with "could not fetch".
  - **Review Focus 2:** the tracker omits one key → that item fails with "couldn't read", and the
    others start.
  - an `already-on-base` item is skipped with its commit lines; the same key in `startAnyway` starts.
  - **Review Focus 5:** a leftover worktree for one key gives a per-item failure with the "To clear
    it … run" text, and the others start.
  - progress events: `done` counts up, and `finished` is true at the end; `get(id)` returns the state.
  - **Routes:** 400 for an empty list, 501 items, or a relative repo path; 202 with a `batchId`.
  - a second batch on the same repo starts its fetch only after the first's items are done
    (deferred fetch).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the server suite.** Expected: PASS.
- [ ] **Step 5: Commit** with the message
  `feat(bugfix): start many tickets at once — one fetch per repo, tickets read 20 at a time`.

### Task 7: Bulk start UI

**Files:**
- Modify:
  - `ui/src/components/BugScreen.tsx`: checkboxes on not-started rows, **Select all not started (N)**
    and **Clear**, and the selection set kept across refreshes;
  - `ui/src/components/BulkStart.tsx` (new): the Start N panel and the progress/results view;
  - `ui/src/api.ts` (`startBatch`, `getBatch`), `ui/src/state/reducer.ts` (`batches` slice from
    `batch` events), `ui/src/styles.css`.
- Test: `ui/test/BugScreen.test.tsx`, `ui/test/BulkStart.test.tsx`

**Interfaces:**
- `BulkStart({ selected: IssueSummary[]; onDone?(): void })`:
  - groups by project;
  - per project, a repo input prefilled from `projectRepos`, with Browse, preflight
    (`api.bugPreflight`), and Branch from;
  - **Start N fixes** calls `api.startBatch(items)`. With more than 500 items it sends several
    requests;
  - then it shows the batch state from `state.batches[batchId]`:
    - "Started X of N", with a progress bar;
    - **Skipped — may already be fixed (k)**, with each message and **Start anyway**, plus
      **Start all anyway** (a new batch with `startAnyway`);
    - **Failed (k)**, with reasons and **Retry** (a new batch for those).

- [ ] **Step 1: Failing tests.**
  - **BugScreen:**
    - not-started rows have checkboxes (`aria-label="Select PAY-1"`), and started rows have none;
    - **Select all not started (2)** ticks both;
    - with a selection, the right side shows the BulkStart panel (`data-testid="bulk-start"`);
    - **Clear** empties the selection.
  - **BulkStart:**
    - two projects make two repo groups, with remembered repos prefilled;
    - Start stays disabled until both preflights are ok;
    - clicking sends `startBatch({ items: [{ issueRef: "PAY-1", repo: "/r/pay", baseBranch: "develop" }, …] })`;
    - a batch state with skipped and failed entries renders both lists;
    - **Start all anyway** sends `startAnyway` with the skipped keys;
    - **Retry** sends the failed items again.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the UI suite and a typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(ui): pick several bugs and start them together`.

### Task 8: End-to-end and version

**Files:**
- Create: `ui/e2e/bulk.spec.ts` (with its own fake server, as `conflicts.spec.ts` does)
- Modify: `desktop/package.json` (0.13.0)

- [ ] **Step 1: Write the e2e test.**
  1. Set a status map via `PUT /api/integrations` (`{ statusMap: { FAKE: { started: "Start Progress" } } }`).
  2. Open the Bugs screen, tick FAKE-1 and FAKE-2, fill the repo with a fresh fixture, and click
     Start 2 fixes.
  3. Both tasks appear in the list.
  4. Open one task: its history shows "Moved FAKE-… to In Progress".
- [ ] **Step 2: Run it**, then run the whole e2e suite. Expected: PASS.
- [ ] **Step 3: Bump the version** to 0.13.0, then run `npm test` and the e2e suite. Expected: PASS.
- [ ] **Step 4: Commit** with the message `test(e2e): start two bugs together; their tickets move; 0.13.0`.
