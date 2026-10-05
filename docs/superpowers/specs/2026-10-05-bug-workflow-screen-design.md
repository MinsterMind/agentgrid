# Bug Workflow Screen — Design Spec

**Date:** 2026-10-05
**Status:** Approved 2026-10-05
**Ships in:** 0.6.0

## 1. Problem

A bug fix is visible only one gate at a time. `BugPanel` lives inside the side panel, appears
only once you select the bug's agent on the grid, and renders whichever gate is open right now
(plan, diff, monitoring, merge, failed). Nothing shows:

- where the task sits in the whole workflow, or how it got there — `task.history` is recorded
  and never rendered;
- what the agent is doing *right now* while a stage runs;
- everything that is stopping progress, in one place;
- what the agent **assumed** to get where it is. Assumptions exist only as prose under the plan's
  "Risks and anything you are unsure about" heading, from the analyze stage alone. Implement,
  review-feedback and rebase report nothing.

## 2. Goal

One full-page screen per bug that answers, without clicking anywhere else:
**where is it, what is it doing, what is blocking it, and what did the agent assume** — and lets
the human act on every gate from the same screen.

## 3. Decisions taken (from brainstorming)

| Question | Decision |
|---|---|
| What does the screen cover? | **One bug end to end**, with a list of bugs beside it to switch between. Not a board of all bugs. |
| Whose assumptions? | **The agent's, from every agent stage**, as structured items tagged with their stage. |
| How much live progress? | **Stage + a live activity line** (current tool / last message, elapsed time), from activity data the grid already streams. Not the full transcript. |
| How does the agent report assumptions? | **A JSON file per stage run**, written into the task's artifacts directory — the same contract as `plan.md`. Not parsed out of the final message, not an MCP tool. |

## 4. Assumptions: data and capture

### 4.1 The file

Each agent stage that makes decisions — `analyzing`, `implementing`, `review-feedback`,
`rebase` — gets a new final step in its preset: write `{{assumptionsPath}}`, a JSON array:

```json
[
  { "kind": "assumption", "text": "Rounding happens only at checkout, not on stored line items." },
  { "kind": "question",   "text": "Should refunds of discounted items round up or down?" }
]
```

- `assumption` — something the agent decided without being told, which the human may want to
  overturn.
- `question` — something the agent could not decide and proceeded around; the human answers it
  through the existing **Request changes** note at the next gate (§10: no inline answering).
- An empty array is the right answer when there is nothing to report. The preset says so, so
  the agent does not invent items to fill the file.

`opening-pr` does not get the step: it writes a PR body from an already-approved change and
decides nothing a human has not already seen.

### 4.2 One path per dispatch

`assumptionsPath` is `<artifactsDir>/assumptions-<token>.json`, where `<token>` is a random id the
engine generates for each dispatch *before* rendering the prompt (the assignment id does not
exist until after the prompt is handed over). The engine keeps `{ token, stage, round }` per task
in memory beside `currentDispatch`, so a later round can never re-read an earlier round's file and
a retried stage starts clean. A dispatch interrupted by a restart loses its token; that stage is
re-run by recovery anyway, under a new one.

### 4.3 Reading it

In `onAssignmentFinished`, **after** cost is recorded and **before** `verify()`, the engine reads
the dispatch's file and appends its items to the task. It reads on success *and* on failure: a
failed stage's assumptions are often the explanation for the failure.

| File state | Result |
|---|---|
| Missing | No items. Not a problem — an agent with nothing to report may skip it. |
| Valid array | Items appended, each tagged `{ stage, round, at }`. |
| An object whose only list is `{ "assumptions": [...] }` | Accepted as that array — a common way models wrap a list; refusing it would hide real content over packaging. |
| Not JSON, not an array, or an item with an unknown `kind` / non-string `text` | No items from this file; `assumptionsProblem` is set to a one-line reason naming the stage. Never fails the stage. |
| More than 20 items, or `text` over 500 chars | The first 20 kept, each `text` cut to 500 chars with `…`; `assumptionsProblem` says what was cut. |

Reading never fails or blocks a stage: assumptions are reporting, not evidence. `verify()`
remains the only thing that decides whether a stage happened.

### 4.4 Model

```ts
export interface Assumption {
  id: string;                         // "<token>:<index>" — stable across re-renders
  stage: BugStage;                    // the agent stage that reported it
  round: number;                      // task.feedbackRounds at dispatch; 0 for analyze/implement
  kind: "assumption" | "question";
  text: string;                       // agent-written; rendered as plain text, never HTML
  at: string;                         // ISO, when the engine read it
}
// on BugTask:
assumptions: Assumption[];
assumptionsProblem: string | null;    // last read problem, cleared by the next run (clean read or no file)
assumptionsToken: string | null;      // the dispatch read last, even if it reported nothing — "new" means from this run
```

Both are normalised in `BugTaskStore.init` (`[]` and `null`) for records written before 0.6.0 —
the same place every earlier field addition is normalised. They travel on the existing
`bugtask` event, so the UI needs no new route or subscription.

**Trust.** Item text is agent output that may echo ticket content. It is shown as text, never as
markdown or HTML, and never fed back into a later prompt by this feature.

## 5. The screen

### 5.1 Getting there

- A **Bugs** button in the top bar (beside "🐞 Fix a bug") switches the main area from the agent
  grid to the bug screen; a **Grid** button switches back.
- The side-panel `BugPanel` gains an **Open full view** link to that bug.
- The URL hash reflects it (`#/bugs/bt3`), so reload and back/forward keep the selection.
- Launching a new bug fix opens the screen on it.

### 5.2 Layout

```
┌ Bugs ─────────┬─ PAY-142  Refund rounding  ↗ticket ↗PR  $0.84 · round 1 ─────┐
│▶PAY-142  ●    │  ✓ Intake  ✓ Analyze  ✓ Plan  ● Implement  ○ Diff  ○ PR      │
│ PAY-150  ⚠    │  ○ Monitor  ○ Merge                                          │
│ PAY-151  ✗    ├──────────────────────────────────────────────────────────────┤
│ PAY-120  ✓    │ NOW   Implementing · 6m · Running `npm test`                 │
│               │ BLOCKING   nothing                                            │
│               │ ASSUMPTIONS & QUESTIONS (3)                                   │
│               │   ? Should refunds of discounted items round up or down?     │
│               │   • Rounding happens only at checkout …          analyze     │
│               │ [ gate card: Approve / Request changes / Cancel ]             │
│               │ TIMELINE   10:14 implementing · 10:12 plan-review · …         │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

**Bug list.** Every task, active first, then by `updatedAt`. Each row: key, title, and one status
mark — running ●, waiting on you ⚠, failed ✗, done ✓, cancelled –. Below 900px the list
stacks above the detail as a short scrolling list.

**Header.** Key and title; links to the ticket, the PR (when there is one) and the worktree path
(copyable); `costUsd`; `feedbackRounds` when non-zero.

**Pipeline strip.** Eight steps, each mapping a set of stages:

| Step | Stages |
|---|---|
| Intake | `intake` |
| Analyze | `analyzing` |
| Plan review | `plan-review` |
| Implement | `implementing` |
| Diff review | `diff-review` (the first one; one reopened by a review round or rebase — `gate.reason` set, or a PR exists — sits on Monitor) |
| Open PR | `opening-pr`, `pushing`, `creating-pr` |
| Monitor | `monitoring`, `review-feedback`, `rebase` |
| Merge | `approved`, `merging`, `done` |

Each step is **done**, **current**, **waiting on you** (current and a gate stage, or the agent is
waiting on a permission/question), **failed** or **not reached**. `failed`/`cancelled` mark the
step of the last non-terminal stage in `history`, so a failure shows where it happened. Loops do
not duplicate the strip: Monitor carries "round N" when `feedbackRounds > 0`, and a diff gate
reopened by a round says so in its own card (`gate.reason`), as it does today.

**Now.** One line answering "what is happening":

- agent stage running → stage name, elapsed since the stage's `history` entry, and the agent's
  live activity: its `pendingTool` summary, else its `lastMessage`, from the session activity the
  grid already streams (`activityFor`);
- server stage (`pushing`, `creating-pr`, `merging`) → "AgentGrid is pushing the branch" etc.;
- gate → "Waiting on you: approve the plan" (or the diff, the merge);
- monitoring → "Watching PR #12 · last checked 2m ago";
- terminal → the outcome (merged / closed / cancelled / failed).

**Blocking.** Everything stopping progress, in one list, each with what to do about it. Empty
renders "Nothing is blocking this bug."

| Source | Item |
|---|---|
| a gate is open | "Waiting on you: …" (scrolls to the gate card) |
| agent has a pending permission or question | the request, with a link to answer it in the side panel |
| stage failed | `task.error`, with Retry on the gate card |
| PR checks failing / changes requested / conflicting | from `task.pr`, as the monitoring card already labels them |
| PR could not be read | the `UNREACHABLE` error |
| setup check that blocks and is not ok | its `detail`, with a link to Settings |
| open questions at a gate | "N questions to answer before approving" |

**Assumptions & questions.** All of `task.assumptions`, questions first, then grouped by stage in
workflow order, each tagged with its stage (and round when > 0). Items from the most recent agent
dispatch are marked **new**. `assumptionsProblem`, when set, shows as a warning line above the
list. Empty: "The agent has not reported any assumptions yet."

**Gate actions.** The existing gate cards from `BugPanel`, extracted into a component both views
render — Approve, Request changes, Retry, Cancel, Merge behave identically in both places, with
one implementation.

**Timeline.** `task.history`, newest first: time, stage, note.

### 5.3 Presentation: nothing reaches the screen as raw markdown or raw text dumps

Everything an agent, the tracker or the forge writes is shown **rendered and laid out**, never
as the source it came in. Monospace is reserved for things that are literally code: commands,
paths, branch names, commit ids and diff lines.

**One markdown renderer.** A single `<Markdown>` component renders every markdown-bearing string
on the screen: the plan, the ticket description and acceptance criteria (a collapsed **Ticket**
section), stage notes, assumption text, and agent outcomes. (The PR body is not shown here: it
lives on the pull request, which the header links to.)
(inline formatting only — bold, code, links). It uses `react-markdown` with `remark-gfm` (tables,
task lists, strikethrough), with **raw HTML disabled** (no `rehype-raw`), links opened in a new
tab with `rel="noreferrer"`, and images not loaded (shown as their alt text with a link). Agent and
ticket text stays untrusted: this is rendering, never execution. It replaces the plan's
`<pre className="planmd">`.

**The plan as sections, not a document.** The analyze preset already asks for four headings. The
plan card splits on them and shows each as its own titled block — **Root cause**, **Fix**,
**Test strategy**, **Risks** — each rendered through `<Markdown>`. The Fix section's file list
links each path to that file in the diff once a diff exists. A plan that does not have the
headings (an agent ignored the preset) renders whole through `<Markdown>` with a quiet note:
"This plan doesn't follow the usual sections." The split is a pure function in `bugView.ts`.

**The diff as a diff.** Per-file collapsible rows (path, +/− counts, as today); expanding one
shows a proper diff view: old/new line-number gutters, added/removed lines tinted, hunk headers
(`@@ … @@`) shown as dividers labelled with the function context, no-newline markers
dropped. Unified view only; no syntax highlighting (no new dependency for it). Replaces
`<pre className="hunks">`.

**Errors as messages, not dumps.** A stage failure renders as a card: the first line as a plain
sentence headline; the rest, if any, under a collapsed **Details** disclosure in monospace;
paths and commands in it get a **Copy** button (the existing cleanup hint, for instance, carries a
`git worktree remove` command). Replaces `<pre className="outcome err">` in both `BugPanel` and
the side panel's agent Failed/Outcome blocks, which render through `<Markdown>` too.

**States, not blanks.** Every section has a designed loading state (skeleton lines, not
"Loading…"), empty state (a sentence saying what will appear there and when) and error state
(what failed and a Retry). Times are relative ("6 min ago") with the absolute time on hover;
money is `$0.84`; stage ids are never shown raw — `review-feedback` reads "Addressing review",
`creating-pr` reads "Opening the pull request", from one label map shared with the strip.

**Visual language.** Status uses the app's existing colour tokens plus an icon *and* a word
(never colour alone): running, waiting on you, failed, done, not reached. The strip is a
horizontal stepper that wraps at narrow widths rather than scrolling. Blocking items are the
most prominent block on the page when present (accent border, at the top of the detail column
under the header); when empty they collapse to one muted line. Keyboard: ↑/↓ moves through the
bug list, Enter opens, and every action is a real `<button>` with a visible focus ring. The app
is dark-only today (`color-scheme: dark`); the screen uses its existing tokens and adds none that
would need a light counterpart.

### 5.4 Components

| Unit | Does | Depends on |
|---|---|---|
| `bugView.ts` (pure) | `pipelineFor(task, waiting)`, `nowFor(...)`, `blockersFor(...)`, `listStatus(task)`, `planSections(md)`, `stageLabel(stage)`, `parseHunks(patch)` | types only |
| `Markdown.tsx` | the one safe markdown renderer (§5.3) | `react-markdown`, `remark-gfm` |
| `DiffView.tsx` | one file's hunks as a diff with gutters (§5.3) | `bugView.parseHunks` |
| `ErrorCard.tsx` | headline + collapsible details + copy (§5.3) | — |
| `BugGates.tsx` | the gate cards, moved out of `BugPanel`, now rendering the plan, diff and errors through the three components above | api, `Markdown`, `DiffView`, `ErrorCard` |
| `BugScreen.tsx` | the full page: list + detail, composing the above | `bugView`, `BugGates`, reducer selectors |
| `BugPanel.tsx` | compact side-panel view, now `BugGates` + "Open full view" | `BugGates` |

All derivation lives in `bugView.ts` so every stage/state combination is unit-testable without
rendering.

## 6. Dependencies

`react-markdown` and `remark-gfm`, added to `ui` only. Nothing else new: the diff view and the
plan split are hand-written against the patch and heading formats this app already produces.

## 7. Server changes

- `types.ts`: `Assumption`; `assumptions` and `assumptionsProblem` on `BugTask`.
- `store.ts`: normalise both in `init`; an `addAssumptions(id, items, problem)` patch.
- `assumptions.ts` (new, pure): `parseAssumptions(raw, meta) → { items, problem }` — the §4.3
  table.
- `engine.ts`: per-dispatch `assumptionsPath` in the stage context; read it in
  `onAssignmentFinished` on both outcomes.
- `prompts.ts` + presets `analyze.md`, `implement.md`, `review-feedback.md`, `rebase.md`: the
  `{{assumptionsPath}}` step. `analyze.md` keeps its "Risks" heading — risks are for the plan
  reader; the file is for the list.
- `fake/agent.ts`: writes one assumption and one question in fake analyze, so fake mode and e2e
  exercise the whole path.

## 8. Failure handling

- Assumptions file missing / malformed / oversized → §4.3; never fails a stage.
- Activity unavailable (no session yet, transcript not found) → "Now" falls back to stage and
  elapsed time.
- Setup report fetch fails → the setup row is omitted, never shown as "nothing blocking" on that
  basis alone: Blocking says "Could not check setup".
- A bug removed while selected → the screen falls back to the first bug, or an empty state with
  "🐞 Fix a bug".

## 9. Testing

- **`parseAssumptions`:** valid; empty array; missing; not JSON; not an array; unknown kind;
  non-string text; 21 items; 600-char text.
- **Engine:** items recorded with stage/round on stage-done; recorded on stage-failed too; a
  later round never re-reads an earlier file; a malformed file sets `assumptionsProblem` and the
  stage still advances; prompts for the four stages carry the path and `opening-pr`'s does not.
- **Store:** a pre-0.6.0 record loads with `assumptions: []`, `assumptionsProblem: null`.
- **`bugView`:** `pipelineFor` for every `BugStage`, including failed/cancelled after each step and
  a round-2 monitor; `blockersFor` for each source in §5.2's table and the empty case; `nowFor` for
  agent, server, gate, monitoring and terminal stages.
- **Presentation:** `planSections` with all four headings, with a missing heading, with none, and
  with headings at a different level; `parseHunks` line numbering across multiple hunks, a
  no-newline marker and a rename; `<Markdown>` renders a table and a task list, and renders a
  `<script>`/`<img onerror>` in agent text as inert text, with no element created; `ErrorCard`
  splits headline from details and copies a command; no raw markdown syntax (`##`, `**`, ``` ` ```
  fences) appears in the rendered plan for the fake plan fixture.
- **UI:** `BugScreen` renders list, strip, now, blockers, assumptions (questions first, new marked,
  problem line), timeline; selecting a bug switches the detail; gate actions call the same API as
  `BugPanel`; hash round-trip. `BugPanel` existing tests pass unchanged against `BugGates`.
- **E2E:** `bugfix.spec.ts` opens the bug screen, sees the fake assumption and question after
  analyze, approves the plan *from the screen*, and watches the strip advance to Diff review.

## 10. Out of scope

Syntax highlighting in the diff; a split (side-by-side) diff; answering a question inline (it is answered via Request changes); an all-bugs board; the full
transcript on this screen; assumptions from AgentGrid itself (repo, base branch, merge policy);
editing or dismissing assumptions; notifications for new questions.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Agents skip the file or pad it with noise | The preset makes an empty array the stated right answer; the list shows what came back, and a missing file is visibly "not reported yet" rather than "none" |
| Agent text renders as markup | Plain text only (§4.4) |
| Markdown rendering opens an injection path for ticket or agent text | Raw HTML disabled, images not loaded, links `noreferrer`; pinned by a test that feeds it script and event-handler markup (§9) |
| Extracting `BugGates` regresses the side panel | It is a move, not a rewrite; `BugPanel`'s existing tests run unchanged against it |
| Activity lags the stage (transcript-derived) | The stage and elapsed time come from the task itself; activity is the detail line, never the source of truth for position |
