# Regression tests that stick, and conflicts across ~1000 PRs — design

Date: 2026-10-07 · Target release: 0.12.0 · Builds on 0.11.0 (`feat/permissions-bugs-view`)

## 1. What the user asked for, and what we agreed

1. **The plan must include the test cases that stop the same bug from coming back.**
   - The plan names its regression tests.
   - The change step writes them first and proves they fail before the fix and pass after it.
   - When the diff adds no test, the diff gate shows a blocker the human can override with a reason.
2. **~1020 bugs in flight, ~1020 PRs, merged one by one.** Each merge can make other PRs conflict.
   - AgentGrid must notice a conflict and show it on the card.
   - It must resolve the conflict only after the human allows it: per card, or with **Resolve all**.
   - Resolution stays reviewed as today: the human approves the rebased diff before AgentGrid
     force-pushes.
   - At most **N agent runs at once** (default 4). The rest wait in a visible queue.

## 2. Findings that shape the design

- **Conflicts trigger work without asking.**
  - Today `PrWatcher.decide` turns a forge `mergeable === "CONFLICTING"` into the `conflicting`
    event.
  - `stages.ts` maps that event straight to `go("rebase", "rebase")`, which runs an agent without
    asking.
  - The rebased diff then waits at the diff gate (`reason: "rebase"`), and the push uses
    `--force-with-lease`.
- **Polling the forge cannot scale to ~1020 PRs.**
  - The watcher polls each PR one at a time, one after another, with per-PR backoff (30 s up to
    5 min).
    - GitHub: one `gh pr view` per check, against a GraphQL budget of about 5,000 points an hour.
    - Bitbucket: three REST calls per check (the PR, its statuses, `/conflicts`), against about
      1,000 calls an hour.
  - With 1020 PRs that is about 12,000 calls an hour, and a single serial sweep takes over
    10 minutes. Neither forge allows that.
- **A local, quota-free conflict check is already half-built.**
  - A conflict can only appear when the target branch moves.
  - `GitOps.wouldConflict(dir, base)` (`git merge-tree --write-tree`) exists but nothing calls it.
  - Run against `origin/<base>` and `origin/<task branch>` after a fetch, it needs no checkout, no
    forge call and no lock. It takes milliseconds per branch.
- **Regression tests are only asked for in prose.**
  - `implement.md` says "add or update tests that fail before your fix".
  - The plan template asks for a "Test strategy".
  - Nothing names concrete tests, and nothing checks that the diff contains any.

## 3. Regression tests

### 3.1 The plan names them

- **The analyze prompt** (`presets/stages/analyze.md`) requires a `## Regression tests` heading.
  It is a list where each item gives:
  - the test file;
  - the case's name;
  - what it asserts;
  - why it fails on today's code.
- **When the verdict is "no change needed"**, the section instead names the existing test that
  already covers the bug, or says none exists.
- **The server reads the section** when it verifies the analyze stage:
  `regressionTests(plan): string[]` returns the items under that heading. They are stored as
  `task.plannedTests: string[]`.
- **The plan gate:**
  - shows them as a list, "Tests that will stop this coming back";
  - if a "change needed" plan names none, adds the blocker **"The plan names no regression test"**.
    The fix is Request changes. Approving is still possible, and the blocker is recorded in the
    task history.

### 3.2 The change step proves them

`implement.md` changes:

- Step 1: write the plan's regression tests first, run them, and confirm they fail.
- Step 2: make the fix.
- Step 3: run them again, confirm they pass, and run the suite.
- The summary lists each test with **fails before → passes after**.

### 3.3 The server checks the diff

- **Detection.** When it verifies the change (and the feedback and rebase rounds), the server reads
  the diff's file list. It records `task.testsInDiff: string[]`: the files matching common test
  patterns:
  - `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.*`, `*Test.*`, `*Tests.*`;
  - any path segment `test`, `tests`, `__tests__`, `spec` or `specs`.
- **Blocker.** When `testsInDiff` is empty, the diff gate shows **"No regression test in this
  change"**.
- **Override.**
  - The gate's Approve button stays disabled until the human clicks **Approve without a test…** and
    types a reason.
  - The override goes to `POST /api/bugtasks/:id/override-tests {reason}`. It stores
    `task.testOverride = { reason, at, head }`, writes the reason into the history, and approves.
  - An override counts only for the head it was given at; a new diff needs a new decision.
- **Feedback and rebase rounds** show the same blocker when the round's diff against the base still
  contains no test file.

## 4. Conflict detection that scales

### 4.1 ConflictWatcher (server, new `src/bugfix/conflicts.ts`)

- **Per repo.** Every 60 s (with jitter), for each `sourceRepo` that has tasks resting on an open
  PR — stages `monitoring`, `approved` and `conflict`:
  1. `git ls-remote origin refs/heads/<base>` for each base in use. This is one cheap network call
     with no forge quota.
  2. If a base tip changed since the last check, or a task joined the watch set:
     `git fetch --quiet --prune origin` once for that repo.
  3. For each watched task, run `git merge-tree --write-tree --name-only origin/<base> origin/<branch>`.
     The command is always run from the task's own worktree.
     - Exit 1 means conflicting, and the output's conflicted-file lines give the files.
     - Exit 0 means clean.
     - Anything else is unknown, and nothing changes. This is the existing `wouldConflict` rule,
       extended to return the files.
- **Concurrency.** Merge-tree runs go through a small pool (4 at a time). 1000 branches take a few
  seconds.
- **Results** are reported as findings to the engine, which is the only writer. A finding can be:
  - `{ type: "conflicting", files, base, baseTip }`;
  - `{ type: "conflict-cleared" }`.
- **When a PR merges** (the engine records `pr-merged`), the ConflictWatcher is nudged to re-check
  that repo at once. Its siblings are exactly the PRs a merge can break.
- **The forge's own `CONFLICTING` flag** still produces the same event.

### 4.2 The Conflict gate

- **New gate stage** `conflict`, with GateKind `"conflict"`. It is watched, so merge and close
  events are still seen.
- `conflicting` from `monitoring` or `approved` →
  `wait("conflict", "conflict")`, recording `task.conflict = { files, base, detectedAt, returnTo }`.
  `returnTo` is `"monitoring"` or `"approved"`.
- `conflicting` while already at `conflict` updates the files and dispatches nothing.
- **approve** at `conflict` → `go("rebase", "rebase")`, through the run queue (§5). The rebase
  prompt receives the conflicted files.
- `conflict-cleared` at `conflict` → back to `returnTo`, with the gate cleared. This covers someone
  rebasing by hand, or the base moving again.
- `pr-merged` and `pr-closed` at `conflict` behave as they do at `monitoring`.
- **The rebased diff** still lands at the diff gate (`reason: "rebase"`). It now shows
  "Conflicted: <files>" next to the agent's own account of how each file was resolved.

### 4.3 On the cards

- **Bug card / Bugs screen:**
  - list status **Conflict**, which counts as waiting on you;
  - a Now line "Conflicts with develop", with the files;
  - a gate panel with **Resolve conflict** and **Cancel task**;
  - "Last checked" shows when the conflict check last ran.
- **Bugs screen header:** when at least one bug is at the Conflict gate, a
  **Resolve all N conflicts** button. It approves each one, and the queue paces them.
- **Agent tile:** a `Conflict` chip from the bug stage, which already shows (`bugStage`). It counts
  in NEEDS YOU.
- **Notification:** "PAY-42 conflicts with develop", once per conflict.

## 5. A limit on concurrent agent runs

- **Setting.** `maxConcurrentRuns` lives in `integrations.json`: default 4, minimum 1, maximum 32.
  It is edited in Settings → Bug fixes.
- **Queue** (`src/bugfix/queue.ts`, owned by the engine). Every bug-fix agent stage goes through it:
  analyze, implement, open-PR, review-feedback and rebase.
  - Dispatching when running < cap starts the run.
  - Otherwise the task records `queuedAt` and shows **Queued (n of m)**.
  - When any run finishes (or fails, or is cancelled), the oldest queued task starts.
  - Server stages (push, create-PR, merge) and gates do not count.
- **Restart.** Recovery leaves tasks with `queuedAt` alone, and re-queues them in `queuedAt` order.
  Tasks that were actually running fail as today.
- **Removing.** Cancelling a queued task removes it from the queue.
- **Scope.** Work you assign by hand on the Agents grid is never queued: you started it on purpose.

## 6. Forge polling that fits API limits

- **New adapter method:**
  `listOpenPrs(repoDir): Promise<{ prs: PrInfo[] } | { unavailable: string }>`.
  - **GitHub:** `gh pr list --state open --author @me --limit 1000 --json number,url,state,isDraft,reviewDecision,mergeable,updatedAt,statusCheckRollup,headRefOid`.
    This is one command, paged internally, 100 PRs per page.
  - **Bitbucket:** `GET /pullrequests?state=OPEN&pagelen=50&q=source.branch.name ~ "bugfix/"`.
    It fills state, `updated_on` and head commit. Checks and conflicts are not listed.
- **The PrWatcher sweeps per repo, not per PR:**
  1. one listing call;
  2. for each watched task, compare the listed view with the stored one:
     - unchanged: no further call;
     - changed `updatedAt`, head or review: one per-PR `getPr` (which on Bitbucket fills checks);
     - missing from the open list: one `getPr` to learn merged or closed.
- **Cadence.** The sweep keeps today's backoff, but per repo (30 s, doubling to 5 min) instead of
  per PR.
- **Conflicts come from §4**, so Bitbucket's `/conflicts` call is no longer made in the sweep.
- **Fallback.** An adapter without `listOpenPrs` (the fake one) falls back to per-PR polling as
  today.

## 7. API and type changes

| Change | Detail |
|---|---|
| `BugStage` | adds `"conflict"`; `GateKind` adds `"conflict"`; `WATCHED_STAGES` adds `"conflict"` |
| `BugEvent` | `conflicting` gains `files?: string[]; base?: string`; adds `conflict-cleared` |
| `BugTask` | adds `conflict: {files, base, detectedAt, returnTo} \| null`, `plannedTests: string[]`, `testsInDiff: string[] \| null`, `testOverride: {reason, at, head} \| null`, `queuedAt: string \| null` (all normalised in `BugTaskStore.init`) |
| `POST /api/bugtasks/:id/override-tests` | `{reason}` → stores the override and approves the diff gate |
| `POST /api/bugtasks/resolve-conflicts` | approves every task at the Conflict gate; returns the ids |
| `/api/bugtasks` / state | queue position is derived client-side from `queuedAt` |
| `integrations.json` | `maxConcurrentRuns` |
| `ForgeAdapter` | optional `listOpenPrs(repoDir)` |

## 8. Error handling

- **A fetch or `ls-remote` fails:** keep the last known conflict state, and show "Couldn't check
  for conflicts: <reason>" on the affected cards, as the existing unreachable-forge note does. Never
  clear a conflict on a failed check.
- **A merge-tree result is unknown:** no change.
- **The task's remote branch is missing** (never pushed, or deleted): skip that task.
- **The rebase agent can't resolve a conflict:** the stage fails as today, with Retry.
- **The queue is full when Resolve all is pressed:** every task is queued. Cards show their
  position, and nothing is lost.
- **Listing fails:** fall back to per-PR `getPr` for that sweep, at the same backoff.

## 9. Testing

Every behaviour here gets a test that would fail if the bug came back.

- **`regressionTests(plan)`:**
  - extracts the items;
  - is empty when the heading is missing;
  - ignores items in fenced code.
- **Test-file detection:** a table of paths (positive and negative).
- **Engine:**
  - a change diff with no test file sets the blocker;
  - the override stores reason and head;
  - a new head clears the override.
- **Stage machine:**
  - `conflicting` from `monitoring` and from `approved` opens the gate with the right `returnTo`;
  - `conflict-cleared` returns there;
  - approve dispatches rebase;
  - merged or closed while at `conflict`;
  - a repeat `conflicting` dispatches nothing.
- **ConflictWatcher, against real git repos** (a bare origin with two task branches; merging one
  makes the other conflict):
  - detects it with the right files;
  - is quiet when the base hasn't moved;
  - re-checks when a merge nudges it;
  - an unknown result changes nothing;
  - a missing remote branch is skipped;
  - one fetch per repo per base move.
- **Queue:**
  - the cap holds;
  - first in, first out;
  - finishing frees a slot;
  - cancel removes;
  - a restart re-queues in order;
  - manual assignments are not queued.
- **Watcher batching:**
  - one listing call for N tasks in a repo;
  - per-PR calls only for changed or missing PRs;
  - fallback without `listOpenPrs`.
- **UI:**
  - the Conflict card, Resolve, and Resolve all;
  - Queued (n of m);
  - the planned-tests list and the no-test blocker with the reason-required override;
  - the Settings cap.
- **End-to-end (fake mode):** a fake bug reaches monitoring. A scripted base move makes it conflict,
  the card shows Conflict, Resolve runs the fake rebase, and the diff gate shows the conflicted
  files.

## 10. Out of scope

- A merge train, or choosing the merge order to minimise conflicts.
- Resolving conflicts without the human's permission.
- Local conflict checks for forges other than GitHub and Bitbucket. Those keep the forge flag only.
- Queueing manual assignments from the Agents grid.
