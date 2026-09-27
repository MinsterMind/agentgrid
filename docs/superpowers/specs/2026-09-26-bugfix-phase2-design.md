# Automated Bug-Fix Workflow, Phase 2 — Design Spec

**Date:** 2026-09-26
**Status:** Approved design, pre-implementation
**Builds on:** `2026-09-25-bugfix-workflow-design.md` (Phase 1, shipped in AgentGrid 0.1.5)

## 1. Problem

Phase 1 ends with a pull request open and the task resting in `monitoring`. From there the user is back where they started: watching a browser tab for a review, re-reading the diff to remember what the change was, pasting comments into a fresh agent session, merging by hand, and cleaning up a worktree they have to remember exists. The long, interruptible half of fixing a bug is the half after the PR.

## 2. Goal

Carry a task from an open PR to a merged one without the user watching: notice review activity, ask an agent to address it, let the user approve each fix, merge on their word, and leave nothing behind.

## 3. Decisions (from brainstorming, 2026-09-26)

1. **Actionable events are changes-requested and failing checks** (B). Loose comments surface on the card with a button; they never start work on their own. Bot-authored comments never start work at all.
2. **Adaptive polling** (B). Per-task backoff, 30s while active doubling to a 5-minute ceiling, snapping back on change, jittered.
3. **Teardown keeps the record** (B). A confirmed merge removes the git side automatically; the card stays in `done` with the merged PR and the transcript until the user dismisses it.
4. **GitHub only** (A). No GitLab adapter, and no hand-driven flow for forges that cannot be polled — §5.2 of the Phase 1 spec is amended accordingly (see §10).
5. **A dedicated `review-feedback` stage** (approach 2), not a re-run of `implementing`. A feedback round is a different instruction from "follow the approved plan", and the card needs somewhere to show which comments are being addressed.
6. **The server pushes, not the agent.** For a feedback round the push is the whole outward action and is entirely deterministic; it happens after the diff gate, never before.
7. **A cap on feedback rounds** (default 5), after which the watcher notifies instead of dispatching.
8. **Tracker write-back is a comment on merge.** Status transitions are deferred.

## 4. The watcher

`PrWatcher` — `server/src/bugfix/watcher.ts`, alongside `LiveSessionWatcher` and `SessionStatusWatcher` and following their shape: constructed with the forge adapter and the bug task store, an injectable clock, `start()`/`stop()`, and a callback per finding. **It never mutates a task.** The engine remains the only writer, so the Phase 1 serialisation and gate guarantees continue to hold.

### 4.1 What it watches

Tasks in a resting stage only — `monitoring`, `approved`, `rebase` — never a task mid-agent-stage. The watch list is rebuilt from the store on `start()`, so a restart resumes watching with nothing needing to have survived in memory. A task leaving a resting stage or reaching a terminal stage is dropped from the list.

### 4.2 Cadence

Per-task backoff state: 30s base, doubling on each no-change tick to a 300s ceiling, reset to base on any change, with jitter so concurrent tasks do not tick in lockstep. One `getPr` call per tick, plus one `listReviewEvents` call when the PR's `updatedAt` has moved.

Ten quiet PRs cost roughly 120 calls/hour against GitHub's authenticated 5,000/hour; ten under active review, roughly 1,200. The ceiling is the knob if that ever changes.

### 4.3 What is new

`PrInfo.lastSeenEventAt` (already persisted in Phase 1) is the high-water mark: events at or before it are old. The watcher advances it after handling a tick, so a restart mid-review cannot replay a feedback round the user already saw.

### 4.4 Findings and responses

| Finding | Response |
|---|---|
| `reviewDecision === "CHANGES_REQUESTED"` | Notify; emit `review-changes-requested` with the comment bodies |
| Check rollup `FAILURE` | Notify; emit `checks-failed` with the failing check names |
| `APPROVED`, not conflicting, checks not failing | Notify; emit `review-approved` |
| `mergeable === "CONFLICTING"` | Notify; emit `conflicting` |
| PR `CLOSED` without merge | Emit `pr-closed`; the task reaches `done` with `error` set to "the pull request was closed without merging", so the card reads as an outcome rather than a success. Teardown does **not** run — the branch may still be wanted |
| Comments, non-completing reviews, checks pending | Update the card only — no agent, no gate |
| Forge unavailable | Nothing. Keep the last known view, keep backing off; after 3 consecutive failures the card says it has not been able to check |

Bot-authored events are marked by the adapter and never produce `review-changes-requested`. Failing checks still wake the agent, but through the check rollup — a state the server reads — rather than through a bot's comment.

## 5. Stages and transitions

The `BugStage` union already carries `review-feedback`, `rebase`, `approved` and `merging`. `nextStage` remains a pure reducer; each arrow below is one case in it, driven by an event the watcher emitted or a gate the user clicked.

```
monitoring ──changes-requested / checks-failed──▶ review-feedback ─verified─▶ diff-review (reason: feedback)
monitoring ──conflicting───────────────────────▶ rebase          ─verified─▶ diff-review (reason: rebase)
monitoring ──review-approved───────────────────▶ approved (gate: merge)
monitoring ──pr-closed─────────────────────────▶ done (not merged)

diff-review (feedback|rebase) ──approve──▶ [server pushes] ──▶ monitoring
approved ──approve──▶ merging ──▶ [server merges, confirms MERGED, tears down] ──▶ done
done ──dismiss──▶ (tile and task record removed; transcript stays on disk)
```

Every new gate keeps the Phase 1 exits: **Request changes** returns to the agent with a note, **Cancel** ends the task. Every new agent stage inherits the approved-commit pin.

### 5.1 `review-feedback`

An ordinary agent stage: its own preset at `server/presets/stages/review-feedback.md`, dispatched like any other, resuming the same session. The prompt carries the reviewer comments (or failing check names) as untrusted, nonce-delimited text, exactly as ticket content is. Verified by: the worktree still on the task's branch, and new commits beyond the PR's current head. It does not push.

`GateKind` gains `"merge"`. The feedback and rebase gates reuse `"diff"` with a `reason` field, because the user is approving a diff in both cases; the card renders the reason above the usual diff.

`BugTask` gains `feedbackRounds: number`, incremented when a `review-feedback` stage is dispatched. It is the cap's state and it is durable, so a restart cannot reset a task's budget.

### 5.2 `rebase`

An agent stage with its own preset: fetch the base, rebase the task branch onto it, resolve conflicts, leave no conflict markers. Verified by: the branch on the task, a clean rebase state, no conflict markers in the tree, and commits still ahead of the base. Lands at the diff gate so the user sees the rebased change before anything is force-pushed.

### 5.3 The push

On approving a feedback or rebase diff, **the server pushes** — a new `GitOps.push(worktree, branch, { force? })`, `--force-with-lease` for the rebase path only. Immediately before pushing, the approved-commit pin is re-checked; a branch that moved since approval fails the stage rather than pushing. After the push the server confirms the PR's head has moved, then returns the task to `monitoring` and re-arms the watcher at its base interval.

This is a stronger gate than Phase 1's agent-run push behind a permission prompt: the user approves a reviewed diff, not a command, and no agent can improvise a different push. It also spends no tokens on a step containing no judgement.

### 5.4 Merge and teardown

`merging` is server work, not an agent stage:

1. `forge.merge(repoDir, number, mergeMethod)` — the method recorded at intake, changeable at the gate. The call does **not** ask the forge to delete the branch: `gh pr merge --delete-branch` deletes the local branch too, which git refuses while the task branch is checked out in the worktree, so a merge that had already happened came back as a failure. The remote branch is deleted after the merge is confirmed (step 3), as a best-effort teardown step whose failure lands in the cleanup message.
2. Re-read the PR. `MERGED` or the stage fails with the forge's message.
3. Only then: delete the remote branch, remove the worktree and the local branch, free the agent, comment the PR link on the ticket.
4. `done`. The card shows the merged PR and the transcript until dismissed.

If teardown fails after a confirmed merge, the task still reaches `done` and the card names what is left behind and the commands to clear it. A merge is a fact; a cleanup problem must not hide it.

## 6. Forge adapter

```ts
getPr(repoDir: string, number: number): Promise<PrLookup>
listReviewEvents(repoDir: string, number: number, since: string): Promise<ReviewEvent[]>
merge(repoDir: string, number: number, method: MergeMethod): Promise<MergeResult>

type PrLookup = { found: PrInfo } | { found: null } | { unavailable: string };
interface ReviewEvent { kind: "review" | "comment" | "check"; state: string; author: string; isBot: boolean; body: string; at: string }
```

`PrLookup`'s three states pay a Phase 1 debt: `findPr` returned `null` both for "no PR" and for "`gh` failed", which was tolerable only because the PR stage was human-gated. A watcher cannot live with that — a flaky CLI would read as "the PR vanished".

`ReviewEvent` is normalised across forges the way `TrackerIssue` is, and carries `isBot` so the engine never has to guess from an author name.

Phase 1's `findPr` (by branch) stays for intake-time verification.

## 7. UI

- **`monitoring` card** — PR link and number; chips for review decision, checks, mergeable; when it last managed to check; a "couldn't reach the forge" note after repeated failures. Non-actionable comments listed with **Ask the agent to address these**, which is the user's manual route into a feedback round.
- **Feedback / rebase gate** — the existing diff card with a reason block above it: the reviewer comments, or "this branch conflicts with `main`".
- **Merge gate** — PR summary, checks, merge method (defaulting to the recorded one), with **Merge**, **Request changes**, **Cancel**.
- **`done` card** — merged PR, transcript link, **Dismiss**.
- **Notifications** through the existing "an agent needs you" path: changes requested, checks failed, ready to merge, merged.

Tiles need no change; they already render the stage.

## 8. Safety

- The server pushes only the task's own branch, never the base; `--force-with-lease` only on the rebase path.
- The approved-commit pin is re-checked immediately before every push.
- No stage changes on a CLI failure.
- Merge is gated, confirmed by re-reading the PR, and is the only irreversible step; teardown follows confirmation.
- Feedback rounds are capped (default 5) before the watcher stops dispatching and only notifies.
- Reviewer comments reach the agent as untrusted, nonce-delimited text, like ticket content.
- Dismiss removes the tile and the task record; the transcript stays on disk.

## 9. Testing

- **Unit:** watcher backoff and dedupe against an injected clock; bot filtering; the new `nextStage` arrows as pure-reducer cases; `PrLookup` handling of each of its three states.
- **Adapter:** recorded `gh` JSON fixtures — changes requested, a bot comment, conflicting, checks failing, a `gh` failure.
- **Integration (offline):** the fake forge gains a scripted event sequence, so a test drives changes-requested → feedback round → approve → push → approved → merge → teardown → `done` in seconds. This extends the Phase 1 harness in `server/test/bugfix/flow.test.ts`.
- **Real git:** push and `--force-with-lease` against a local bare remote; a genuine rebase conflict.
- **UI:** the new cards; the e2e extended through one feedback round and a merge.

## 10. Amendment to the Phase 1 spec

Phase 1 §5.2 said a forge that cannot be polled still works, with `monitoring` becoming manual. That is withdrawn: `intake` refuses a repo whose forge adapter is null, and Phase 2 does not add a hand-driven path. A forge needs an adapter to be usable at all. GitLab remains a clean standalone piece of work because the adapter seam exists.

## 11. Phasing

Six slices, each shippable:

1. Adapter surface — `getPr`, `listReviewEvents`, `merge`, `PrLookup`, fixtures
2. Watcher — backoff, dedupe, failure tolerance, notifications
3. `review-feedback` stage + server-side push
4. `rebase` stage
5. Merge gate, merge, teardown, `done`/Dismiss, ticket comment
6. UI cards and the extended e2e

Slices 1–2 are useful alone: review activity gets noticed and surfaced with no agent involved.

## 12. Out of scope

GitLab and other forges; webhooks; multi-repo fixes for one ticket; tracker status transitions; submitting reviews on other people's PRs; Windows.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Polling cost or rate limits | Adaptive backoff with a 5-minute ceiling; one call per tick; the ceiling is configurable |
| A bot comment loop | `isBot` on every event; only the check rollup wakes the agent for CI |
| Endless feedback rounds | Per-task cap, then notify-only; cumulative cost on the card |
| Force-push loses work | `--force-with-lease`, rebase path only, behind the diff gate, pin re-checked before pushing |
| Merge succeeds, teardown fails | Task still reaches `done`; the card names the leftovers and the commands |
| A flaky `gh` reads as "PR gone" | `PrLookup`'s third state; no stage change without information |
