# Import in-progress tickets, auto-resolve conflicts, act on PR comments, token economy — design

Date: 2026-10-09 · Target release: 0.14.0

## 1. What the user asked for, and what we agreed

1. **Import tickets already in progress.**
   - The user enters several ticket keys and a repo. For each ticket, AgentGrid finds its existing work
     and **picks up from where it is**:
     - an open PR → watch it;
     - a pushed branch with no PR → diff review, then open the PR;
     - merged → record as done;
     - nothing → a normal fix.
   - A PR is found by the key in its **branch name or title**. When several match, the user picks.
2. **Conflicts resolve themselves.** A detected conflict starts the rebase on its own; the rebased diff is
   still reviewed before it is pushed. A setting restores "ask first".
3. **Any reviewer's comment starts the work.** New PR comments or review comments, by anyone except the
   user and bots, start a feedback round. The diff is still reviewed before it is pushed, and the round
   limit still applies.
4. **Protect token consumption:**
   - short sessions (each stage starts fresh, with files as hand-off);
   - a model, effort and turn limit per stage (with defaults);
   - stepping up one model only when a stage fails its check;
   - per-stage cost caps and an optional daily limit;
   - comments batched into one round after a quiet period;
   - cost shown per stage.

## 2. Findings that shape the design

- **One long conversation per bug.** After the first stage, `engine.onAssignmentFinished` writes the
  stage's session into `agent.resumeSessionId` (engine.ts ~905), so every later stage *resumes* it.
  Implement, the PR description, every feedback round and every rebase carry the whole history of the
  stages before them.
- **Top model everywhere.** The `bugfix` role runs every stage on `claude-opus-5` at effort `xhigh`, with
  `maxTurns: 120` and `maxBudgetUsd: 8` per stage.
- **Comments are mostly ignored.** `PrWatcher.decide` starts a round only for
  `reviewDecision === "CHANGES_REQUESTED"` with new human events, or for failing checks.
  `listReviewEvents(since)` already returns comments and reviews with `isBot`, but nothing marks "is me".
- **Adoption covers only one case.** `adoptExternalPrLocked` adopts a PR opened outside AgentGrid only
  for a task that failed on the way to a PR, and only by its own `bugfix/<KEY>` branch.
- **Conflicts wait for the human.** `stages.ts` takes `conflicting` → `conflict` gate (0.12.0).
- **Per-run overrides are already half there.** `Runner.assign(prompt, { continueSession })` exists, and
  `buildOptions(role, agent, extra)` builds the SDK options from the role.

## 3. Import

### 3.1 Entering tickets

- **Where.** The Bugs screen gains **Import tickets…**, a dialog with:
  - a textarea of keys (comma, space or newline separated, with duplicates removed);
  - a repo field (remembered per project, Browse, preflight);
  - **Import N tickets**.
- **The route.** `POST /api/bugtasks/import` takes `{ keys: string[], repo }`, 1–500 keys. It runs in the
  background like a batch (§3.3), reports `import` progress events, and has
  `GET /api/bugtasks/import/:id`.

### 3.2 Finding each ticket's work (server, new `src/bugfix/importer.ts`)

**Per repo, once:**
1. `git fetch`.
2. `forge.listOpenPrs(repo)`, now carrying `headBranch`, `baseBranch` and `title` (§3.4).
3. `git for-each-ref refs/remotes/origin`.

**Tickets** are read with `TrackerCache.issues(keys)`.

**Per key, the first match wins:**
1. **Already in AgentGrid** (a task with that key that isn't finished): skipped, with its task id.
2. **Open PRs** whose `headBranch` or `title` contains the key as a whole word
   (`(^|[^A-Za-z0-9])KEY([^0-9]|$)`, case-insensitive):
   - one → import at **monitoring**;
   - several → **needs a choice**, listing number, title and branch for each.

   `POST /api/bugtasks/import/:id/choose` with `{ key, prNumber }` imports that one.
3. **A remote branch** whose name contains the key → import at **diff review**.
4. **A merged PR**, through `forge.findMergedPr(repo, key)` (§3.4) → record as **done**, outcome
   `merged`.
5. **Nothing** → a normal start through `intake` (with its "may already be fixed" check).

### 3.3 Creating an imported task (engine `importTask`)

- **Worktree.** `git worktree add -B <headBranch> <worktree> origin/<headBranch>` checks out the PR's own
  branch.
  - The task's `branch` is that branch; `baseBranch` and `baseRef` come from the PR's base (or, for a
    branch with no PR, the integration branch).
  - The worktree path keeps `.worktrees/bugfix-<KEY>`.
  - The agent is created as in `intake`.
- **Where it lands:**
  - **monitoring:**
    - `pr` comes from `forge.getPr`;
    - `approvedHead` is the PR head (what is on the PR is what was "approved" — it was reviewed outside);
    - `prCheckedAt` is now;
    - history says "Imported: PR #N on <branch>, already open";
    - the watcher and ConflictWatcher take it from there.
  - **diff-review:**
    - `approvedHead` is the branch tip;
    - the diff is written with `testsInDiff`;
    - the gate is `{ kind: "diff" }`;
    - approving runs the normal opening-pr → creating-pr.
  - **done:**
    - outcome `merged`, with `pr` set;
    - no worktree or agent is created;
    - history says "Imported: already merged in PR #N".
- **The moment.** An imported task fires the TrackerSync moment for where it lands: `started`,
  `prOpened` or `merged`.
- **Branch safety.** Pushing for an imported task goes to its own `branch` (the PR's head), as every push
  does. The existing guard `branch !== baseBranch` stays.
- **Results.** The import state reports, for each key: `imported: {key, taskId, stage}`,
  `choose: {key, candidates}`, `skipped: {key, message}`, `failed: {key, message}`.

### 3.4 Forge additions

- **PR listing fields.** `PrInfo` gains optional `headBranch`, `baseBranch` and `title`, filled by
  `listOpenPrs`:
  - GitHub adds `headRefName,baseRefName,title` to the listing's `--json`;
  - Bitbucket uses `source.branch.name`, `destination.branch.name` and `title`.
- **Repo-wide listing.** `listOpenPrs` lists every open PR in the repo (not just `--author @me` or
  `bugfix/`) **when called by the importer** (`listOpenPrs(repo, { all: true })`). The watcher's sweep
  keeps its narrower listing.
- **`findMergedPr(repo, key)`:**
  - GitHub: `gh pr list --state merged --search "<KEY> in:title,head" --limit 5`;
  - Bitbucket: `state="MERGED" AND (title ~ "<KEY>" OR source.branch.name ~ "<KEY>")`.

  It returns the newest match or null.
- **`whoami(repo)`:** GitHub `gh api user --jq .login`; Bitbucket `GET /user` → `nickname`/`account_id`.
  Cached for the server's life. This is what makes a comment count as "mine".

## 4. Conflicts resolve themselves

- **New setting.** `integrations.autoResolveConflicts` (default **true**), shown in Settings → Bug fixes
  as "Resolve conflicts automatically — you still review the result before it's pushed".
- **The stage machine.** `nextStage` reads it through a new event field: the engine passes
  `{ type: "conflicting", files, base, auto: true }` when the setting is on.
  - With `auto` from `monitoring` or `approved`, it goes straight to `go("rebase", "rebase")`, recording
    `task.conflict` (with `returnTo`) as today, so the rebase prompt and the diff gate still show the
    files.
  - Without `auto`, it uses the 0.12.0 conflict gate.
- **The queue paces rebases.** A rebase that can't get a slot waits in line ("Queued").
- **Finding conflicts doesn't change.** The ConflictWatcher, the forge flag and the
  merge-nudges-siblings check stay as they are.

## 5. Reviewer comments start the work

- **What starts a round.** In `PrWatcher.decide` (tasks at `monitoring`), new events since
  `pr.lastSeenEventAt` with all of:
  - `kind` `review` or `comment`;
  - `!isBot`;
  - `!isSelf` (the forge's `whoami`);
  - a non-empty body.

  A review decision of `CHANGES_REQUESTED` with no new human text still triggers, as today.
- **A quiet period.** The first qualifying event sets `task.commentsPendingSince`. The round starts once
  `quietMs` (default 10 min, setting `commentQuietMinutes`, 0 means "at once") has passed with no newer
  qualifying event. Then all comments since the last round are passed as the round's note (forge data,
  fenced, as today).
- **Self.** Each `ReviewEvent` gains `isSelf: boolean`, set by the adapter from `whoami`.
- **The round limit.** `FEEDBACK_ROUND_CAP` stays. When reached, a card note says "Round limit reached —
  address comments yourself or raise the limit". The existing manual **Address comments** button
  bypasses the limit, as today.
- **During a conflict or another round.** Events are kept (`lastSeenEventAt` is not advanced past
  unhandled events) and considered when the task is back at `monitoring`.

## 6. Token economy

### 6.1 Short sessions

- **No resumed sessions.** Bug-fix stages no longer resume a session: `onAssignmentFinished` stops
  writing `resumeSessionId` for bug-fix agents, and each stage's `manager.assign` starts fresh.
- **Hand-off by files.** Everything a stage needs is in files the prompt names:
  - the ticket (`ticket.md`: title, description, acceptance criteria — written at intake or import);
  - `plan.md`;
  - the PR body;
  - per-round `feedback-<n>.md`;
  - `conflict.md` (files and base);
  - `diffstat.json`.
- **Prompt edits.** The stage presets (`implement.md`, `open-pr.md`, `review-feedback.md`, `rebase.md`)
  gain one line: "You start fresh: read <the files> first — don't rely on memory of earlier steps."

### 6.2 A model per stage

- **Setting.** `integrations.stageModels` (all optional):
  `{ analyzing, implementing, "opening-pr", "review-feedback", rebase }: { model, effort, maxTurns, maxBudgetUsd }`.
- **Defaults:**

  | Stage | Model | Effort | Max turns | Cap (USD) |
  |---|---|---|---|---|
  | analyzing | claude-opus-5 | high | 40 | 3 |
  | implementing | claude-sonnet-5-5 | medium | 60 | 2 |
  | opening-pr | claude-haiku-4-5-20251001 | low | 10 | 0.25 |
  | review-feedback | claude-sonnet-5-5 | medium | 40 | 1.5 |
  | rebase | claude-sonnet-5-5 | medium | 40 | 1.5 |

- **Model names.** Opus stays `claude-opus-5` (what the role uses today); Sonnet is `claude-sonnet-5-5`;
  Haiku is `claude-haiku-4-5-20251001` (what the tracker uses). The Settings select stores these ids.

- **Applying it.**
  - `Runner.assign(prompt, { continueSession?, overrides? })` passes `overrides` to `buildOptions`,
    which applies them over the role's values.
  - The engine's `runStage` passes the stage's settings.
- **Settings UI.** Settings → Bug fixes shows a table of the five stages, with a model select (Opus,
  Sonnet, Haiku), an effort select, max turns and a cap.

### 6.3 Step up only when needed

- **When.** A stage that fails its server check — `verify` throws, or the run ends `error_max_turns` or
  `error_max_budget_usd` — retries on the next model up, Haiku → Sonnet → Opus. The retry is either the
  user's Retry or the automatic one below.
- **Recording it.** The bump is recorded as `task.stageModel[stage]`, and later rounds of that stage use
  it.
- **Automatic retry.** A failed verification of `opening-pr`, `review-feedback` or `rebase` retries once
  automatically on the stepped-up model before failing the task. `analyzing` and `implementing` fail as
  today, and Retry steps up.

### 6.4 Spending caps

- **Per stage.** `maxBudgetUsd` per stage (§6.2) replaces the role's single $8.
- **Daily limit.** `integrations.dailyBudgetUsd` (unset by default):
  - when today's bug-fix cost (sum of `costUsd` over assignments of bug-fix agents started today, local
    day) reaches it, new bug-fix runs are not started;
  - they wait in the queue with the reason "Daily limit reached ($X of $Y)", and running stages finish;
  - the next local day releases them, and raising the limit releases them at once.
- **Header.** The Bugs screen header shows "Today $4.20 of $20".

### 6.5 Cost on the card

- **Storage.** `task.costByStage: Record<string, number>`, accumulated in `onAssignmentFinished` per stage
  (feedback and rebase rounds summed).
- **Display.** The Bugs screen shows it next to the cost counter (a small breakdown on hover or click),
  and the stage history lines carry the model used ("Implementing · Sonnet · $1.10").

## 7. Error handling

- **Import:**
  - a repo whose fetch or listing fails fails that repo's keys with the reason;
  - a key the tracker can't read fails with the reason;
  - a worktree add failure (a leftover) fails that key with the remediation message;
  - nothing aborts the whole import.
- **`whoami` failure.** The user's own comments can't be told apart, so they count as reviewers' comments.
  A card note says "Couldn't tell which comments are yours: <reason>".
- **A stepped-up retry that still fails.** It fails as today, with both errors in the message.
- **A missing model setting.** The default is used; an unknown model name is refused on save (400).

## 8. Testing

- **Importer** (stub forge, real git where branches matter):
  - each case lands right: an open PR by branch, an open PR by title, a branch only, merged, nothing,
    several candidates, and already in AgentGrid;
  - key matching is whole-word (PAY-41 doesn't match PAY-410);
  - one fetch and one listing per repo;
  - choose with a PR number imports it;
  - a worktree is checked out on the PR's branch (real git);
  - the moment fires for where it landed.
- **Engine:**
  - an imported monitoring task is watched; an imported diff-review task opens its PR through the
    normal path;
  - pushes go to the PR's branch.
- **Conflicts:**
  - with auto on, `conflicting` → rebase directly (queued when full) and keeps the files;
  - with it off, the conflict gate as in 0.12.0.
- **Comments:**
  - a reviewer comment starts a round after the quiet period;
  - mine and bots' don't;
  - several comments in the quiet period make one round with all of them;
  - a newer comment during the period restarts the wait;
  - the round limit gives a card note;
  - quiet 0 means at once.
- **Token economy:**
  - stage N+1 doesn't resume stage N's session (no `resume` option);
  - each stage gets its model, effort, turns and cap (from defaults and from settings);
  - a failed verify steps up on retry and the bump sticks;
  - the automatic retry for opening-pr, review-feedback and rebase;
  - the daily limit queues new runs with the reason and releases them on raise or a new day;
  - `costByStage` accumulates;
  - the presets name the hand-off files.
- **UI:**
  - the Import dialog (keys parsing, results including choose);
  - Settings → Bug fixes (auto-resolve toggle, quiet minutes, the stage model table, daily limit);
  - the header's today's cost; the per-stage cost breakdown.
- **End-to-end (fake mode, own server):**
  - import FAKE-1 whose PR was opened by the fake forge on a non-`bugfix/` branch; the task lands at
    "Watching PR";
  - a scripted reviewer comment starts a feedback round after a 0 quiet period.

## 9. Out of scope

- Importing from trackers' PR links (development panel) or across several repos in one dialog.
- Rewriting history or renaming branches of imported PRs.
- Token accounting for the user's own manual agents (only the bug-fix workflow).
