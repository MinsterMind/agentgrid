# Bulk start, tracker status sync, and a fast tracker — design

Date: 2026-10-08 · Target release: 0.13.0

## 1. What the user asked for, and what we agreed

1. **Start fixing several tickets at once.**
   - Not-started bugs on the Bugs list get checkboxes, plus a **Select all not started** option.
   - A **Start N fixes** panel takes one repo and one "Branch from" per project.
   - The run limit (0.12.0) paces the agents.
   - Tickets whose fix may already be on the base are skipped and listed, each with **Start anyway** (one, or all).
2. **The tracker shows the work's status.**
   - In Settings, per tracker project, the user maps moments of the workflow to that project's real
     transitions.
   - The moments are: fix started, PR opened, merged, closed without merging, no change needed.
   - Unmapped moments do nothing.
3. **Tracker reads are fast.**
   - Haiku replaces Opus for tracker calls.
   - The bug list and ticket details are cached on the server, on disk, and refreshed in the background.
   - Details are prefetched in batches.

## 2. Findings that shape the design

- **Why tracker reads are slow.** Every tracker call (`mcpTracker` in `server/src/bugfix/tracker.ts`)
  is a headless Claude SDK query:
  - it runs on `model: "claude-opus-5"`, with up to 12 turns;
  - it loads user and project settings;
  - it goes through the user's tracker MCP server.

  `GET /api/bugfix/issues` (the bug list) and `GET /api/bugfix/issues/:key` (the ticket view) each
  pay that cost on every request, because nothing is cached. That is the slowness the user sees.
- **The preset already supports new tracker operations.**
  - `presets/tracker/jira.md` has three sections: `listMyIssues`, `fetchIssue` and `comment`.
  - The runner renders a section and returns the model's final text.
  - The parsers (`parseIssueList`, `parseIssue`) take JSON out of that text.

  New operations are new sections plus a parser.
- **The engine already posts comments to the ticket** (best effort):
  - "Fix in progress — pull request: <url>" when the PR is created or adopted;
  - "Fixed by <url> (merged)." on merge.

  Status changes belong at the same moments.
- **`intake(input)` does three things per ticket:**
  - fetches origin;
  - reads the ticket through the tracker;
  - searches the base for commits naming it.

  Starting 120 tickets one by one would mean 120 fetches and 120 tracker sessions.

## 3. A fast tracker

### 3.1 Model

`defaultJsonRunner` uses `claude-haiku-4-5-20251001` with `effort: "low"`. It is also used for status
changes. Nothing else changes: same tools, same settings sources, so the user's MCP configuration still
applies.

### 3.2 Batched reads

- **A new preset section, `fetchIssues`** (input `{{keys}}`, comma-separated). It returns a JSON array
  of full issues (the shape `parseIssue` expects).
- **`TrackerProvider.fetchIssues(keys)`.** Presets without the section fall back to calling
  `fetchIssue` once per key, at most 3 at a time.
- **Batch size.** Batches have at most 20 keys. A key missing from the answer is reported as missing
  for that key only; the batch as a whole does not fail.

### 3.3 TrackerCache (server, new `src/bugfix/trackerCache.ts`)

- **The bug list:**
  - `myIssues()` returns `{ issues, fetchedAt, refreshing, error }` straight away from the cache;
  - when the list is older than 2 minutes, or there is none yet, it starts a background refresh
    (only one at a time);
  - `refresh()` forces one, which is what the UI's Refresh uses;
  - a failed refresh keeps the last list and records the `error`.
- **Ticket details:**
  - `issue(key)` returns the cached ticket when younger than 15 minutes, otherwise it fetches (one
    fetch per key in flight at a time);
  - `issues(keys)` fills the cache through `fetchIssues` in batches.
- **Prefetch.** After each successful list refresh, details for listed tickets that aren't cached
  (or are stale) are fetched in the background, in batches of 20, one batch at a time.
- **Disk.** The cache lives at `~/.agentgrid/tracker-cache.json`, written atomically, at most once
  every 5 s. It is loaded at start, so the list and opened tickets show at once after a restart and
  refresh behind the scenes.
- **Invalidation.** Starting a ticket refetches its details. Changing the tracker configuration
  clears the cache.
- **Events.** `tracker-issues` (the list changed) and `tracker-issue` (one ticket changed) go over
  SSE, so open screens update without polling.

### 3.4 Routes

| Route | Behaviour |
|---|---|
| `GET /api/bugfix/issues` | Returns `{ issues, fetchedAt, refreshing, error }`. **Shape change:** it was an array. The UI and the launcher are updated together. |
| `POST /api/bugfix/issues/refresh` | Forces a list refresh; returns at once (`202`). |
| `GET /api/bugfix/issues/:key` | Answers from the cache (stale ones refresh); same shape as today. |

## 4. Ticket statuses follow the work

### 4.1 Preset sections

- **`listTransitions`** (`{{key}}`) returns a JSON array `[{ "id": "31", "name": "Start Progress", "to": "In Progress" }]`
  — the transitions the ticket can make now.
- **`transition`** (`{{key}}`, `{{transition}}`, the transition's *name*) makes the move and returns
  `{ "ok": true, "status": "<new status>" }` or `{ "ok": false, "error": "…" }`.
- **Unsupported presets.** A preset without these sections means "status sync is not supported for
  this tracker", and Settings says so.

### 4.2 Settings → Ticket statuses

- **Layout.** One block per tracker project the user has fixed bugs in (the keys of `projectRepos`),
  plus any project typed in.
- **The transitions.** Each block shows the available transitions, read through `listTransitions` on
  a sample ticket. The sample is the most recent task or assigned bug of that project; the user can
  name a different one. The list is cached for 1 hour.
- **Choosing.** For each moment, a select offers the transitions by *target status* ("→ In Review")
  plus "Don't change the status".
- **Storage.** `integrations.json` gains
  `statusMap: { [project]: { started?, prOpened?, merged?, closed?, noChange? } }`, where each value is
  a transition name.

### 4.3 When moments happen (engine)

| Moment | Where |
|---|---|
| `started` | after intake creates the task |
| `prOpened` | PR created (`doCreatePr` success) or adopted |
| `merged` | transition to `done` with outcome `merged` |
| `closed` | `done` with outcome `closed` |
| `noChange` | `done` with outcome `no-change` |

- **How a move runs.** A mapped moment queues `tracker.transition(key, name)`. Moves run one at a
  time per ticket, in moment order, and are best effort: one retry after 30 s.
- **What is recorded.** Each result goes into the task's history:
  - "Moved PAY-42 to In Review";
  - "Couldn't move PAY-42 to In Review: <reason>".

  The last failure is also stored as `task.trackerSyncError` and shown as a blocker-style note on the
  card. A later success clears it.
- **Never blocks the fix.** A failed move never fails a stage.
- **No-op moves.** A transition that isn't available (for example the ticket is already there) is
  treated as a no-op when the ticket's current status equals the target. Otherwise it is a failure,
  with the available names listed.

## 5. Starting many tickets

### 5.1 Bugs list

- **Checkboxes.** Each not-started assigned row gets a checkbox. Clicking the row still opens the
  ticket; the checkbox only selects.
- **Select all.** The header gains **Select all not started (N)** / **Clear**.
- **Persistence.** The selection is kept while the list refreshes; keys that leave the list drop out.
- **The panel.** With one or more ticked, the right side shows the **Start N fixes** panel:
  - the selection grouped by project (key, title, priority);
  - per project, the repo (remembered via `projectRepos`, editable, Browse) with its preflight
    result and **Branch from**;
  - **Start N fixes**, disabled until every project has a repo whose preflight passes.

### 5.2 Server: batch intake

- **`POST /api/bugtasks/batch`** takes
  `{ items: [{ issueRef, repo, baseBranch? }], startAnyway?: string[] }` (keys to start despite
  commits on the base). It returns `202 { batchId }` at once and runs in the background.
- **What the run does:**
  1. For each distinct `repo`, `git fetch` once and resolve the base.
  2. Read every ticket through `TrackerCache.issues(keys)`: one batched tracker call per 20 tickets.
  3. For each item, in order, call `engine.intake` with the prefetched issue and the already-fetched
     repo. `intake` gains `{ issue?, fetched?: true }` so neither step repeats.

     Per item, the result is one of:
     - started → task id;
     - `already-on-base` → skipped, with its commits (unless the key is in `startAnyway`);
     - any other error → failed, with its message.

     The run limit queues the agents.
- **Progress.** `batch` SSE events carry
  `{ batchId, total, done, started, skipped: [{key, commits, message}], failed: [{key, message}], finished }`.
  `GET /api/bugtasks/batch/:id` returns the same state, kept for the last 10 batches in memory.
- **Limits.** At most 500 items per request; the UI splits larger selections.
- **Concurrency.** One batch at a time per repo; a second waits.

### 5.3 The result

The panel turns into the batch's progress: "Started 37 of 120", a progress bar, and new rows
appearing in the list as tasks are created. When it finishes it shows:

- the started count;
- **Skipped — may already be fixed (N)**, each with the commits and **Start anyway**, plus
  **Start all anyway**. These re-run a batch for those keys with `startAnyway`;
- **Failed (N)**, each with its reason and **Retry**.

## 6. Error handling

- **The tracker is unreachable:**
  - the list shows the cached one with "Couldn't refresh: <reason> · updated 12m ago";
  - the ticket view shows the cached ticket, or the error with Retry when none is cached;
  - a batch fails only the tickets that couldn't be read.
- **A batch item's repo fails preflight or fetch:** that project's items fail with the reason; the
  rest continue.
- **A status move fails:** history plus a card note; the fix goes on.
- **A corrupt cache file:** ignore it and rebuild. It is never an error the user sees.

## 7. Testing

- **TrackerCache:**
  - stale-while-revalidate (an immediate answer, one background refresh);
  - a failed refresh keeps the list and records the error;
  - details respect the TTL, and concurrent requests for one key make one fetch;
  - prefetch batches of 20, one at a time;
  - persistence round-trip;
  - invalidation on start and on a configuration change.
- **Tracker:**
  - `fetchIssues` parses a batch and reports missing keys;
  - the fallback without the section;
  - the runner uses Haiku;
  - `listTransitions` and `transition` parsing, including failures.
- **Engine:**
  - each moment queues the mapped transition, and unmapped ones do nothing;
  - results land in history;
  - a failure sets `trackerSyncError` and a later success clears it;
  - a failed move never fails a stage;
  - "already there" is a no-op.
- **Batch:**
  - one fetch per repo and one tracker read per 20 tickets;
  - per-item results (started, skipped with commits, failed);
  - `startAnyway` overrides;
  - progress events;
  - the 500 limit;
  - one batch per repo at a time.
- **UI:**
  - checkboxes, Select all, and the Start N panel;
  - per-project repo and branch with preflight;
  - progress, skipped with Start anyway, failed with Retry;
  - "updated 40s ago" and the refreshing state;
  - Settings → Ticket statuses: loads transitions, saves `statusMap`, unsupported-preset message.
- **End-to-end (fake mode):** the fake tracker gains `fetchIssues`, `listTransitions` and
  `transition`. A test selects 2 not-started bugs, starts both, sees both tasks appear, and sees
  "Moved … to In Progress" in a task's history after a status map is set.

## 8. Out of scope

- Talking to the tracker's REST API directly (it stays through the user's MCP).
- Moving tickets *back* when a fix is cancelled.
- Bulk actions other than start: bulk cancel, bulk approve.
