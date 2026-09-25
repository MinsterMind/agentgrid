# Automated Bug-Fix Workflow — Design Spec

**Date:** 2026-09-25
**Status:** Approved design, pre-implementation
**Builds on:** `2026-09-11-agentgrid-design.md` (AgentGrid core)

## 1. Problem

Fixing a tracked bug is a long chain of small, interruptible steps: read the ticket, understand the code, plan, change it, prove it, open a PR, answer reviewers, merge, close the ticket. Each step is short; the waiting between them is long. Today that chain lives in the user's head across a terminal, a browser tab for the tracker, and another for the forge.

## 2. Goal

One flow inside AgentGrid: point at a bug, approve a plan, approve a diff, and let an agent carry it to a merged PR — pausing at every irreversible step for a human click, and costing nothing while it waits.

## 3. Decisions (from brainstorming)

1. **Server-owned workflow engine** (Approach A). Stages and gates are server state; each stage is one AgentGrid assignment; no agent process exists while waiting.
2. **Pluggable providers.** Trackers (Jira, Linear, Asana, GitHub Issues, …) and forges (GitHub, GitLab, …) are configuration, not hardcoded. Jira + GitHub are the first presets.
3. **Tracker access is agent-mediated over MCP**; forge access is CLI adapters in the server, because the watcher must run without an agent.
4. **Auto-pick means "show me my assigned open bugs"** — a list you click, never an unattended start.
5. **Repo is chosen by the user**, remembered per tracker project.
6. **Review feedback** → notify, agent drafts a response, user approves before anything is pushed.
7. **Merge asks by default**; `auto` is an explicit per-run choice.
8. **Work happens in a git worktree** on a dedicated branch.
9. **Two phases:** Phase 1 intake → PR; Phase 2 monitoring → merge → cleanup.

## 4. Domain model

### 4.1 BugTask — `~/.agentgrid/bugtasks/<id>.json`

```jsonc
{
  "id": "bt3",
  "issue": { "key": "PAY-482", "title": "Refresh token rotates twice on retry",
             "url": "https://…/browse/PAY-482", "status": "In Progress",
             "priority": "High", "description": "…", "acceptanceCriteria": ["…"] },
  "trackerProject": "PAY",
  "sourceRepo": "/Users/m/MinsterMind/payments",
  "worktree": "/Users/m/MinsterMind/payments/.worktrees/bugfix-PAY-482",
  "branch": "bugfix/PAY-482",
  "baseBranch": "main",
  "agentId": "bugfix@payments",
  "stage": "plan-review",
  "gate": { "kind": "plan", "openedAt": "…" },
  "mergePolicy": "ask",
  "mergeMethod": "squash",
  "pr": { "number": 482, "url": "…", "state": "OPEN", "reviewDecision": "CHANGES_REQUESTED",
          "checks": "PASSING", "mergeable": "MERGEABLE", "lastSeenEventAt": "…" },
  "costUsd": 1.42,
  "history": [{ "stage": "analyzing", "at": "…", "note": "" }],
  "error": null
}
```

Artifacts live beside it in `~/.agentgrid/bugtasks/<id>/`:

| File | Written by | Purpose |
|---|---|---|
| `issue.json` | agent (intake query) | normalised ticket |
| `plan.md` | agent (analyze) | plan card |
| `diff.patch`, `diffstat.json` | **server** (`git diff`) | diff card |
| `pr.json` | agent, **verified by server** | PR number/url |
| `review-<n>.json` | server (watcher) + agent (proposed responses) | review card |

### 4.2 Stages

```
intake → analyzing → plan-review ⟳ → implementing → diff-review ⟳ → opening-pr
       → monitoring ⟲ ─┬─ review-feedback ⟳ ─→ monitoring
                        ├─ rebase ⟳ ─────────→ monitoring
                        └─ approved ⟳ ─→ merging → done
                                    ↘ cancelled | failed (from any stage)
```

- `⟳` gate: agent is `free`, no process running, waiting on a click. *Request changes* loops back with the user's text as the next instruction.
- `⟲` watcher: server polls the forge; no agent process.
- Every transition appends to `history` and emits an SSE event; tiles, sections and notifications reuse the existing mechanisms.

**Gate kinds:** `plan`, `diff`, `review`, `merge`, `rebase`.

### 4.3 Agent

One agent per task, spawned from a bundled `bugfix` role (🐞, `permissionMode: acceptEdits`, per-stage `maxTurns`/`maxBudgetUsd`), `displayName` = issue key, working directory = the worktree. After stage 1 the server sets the agent's `resumeSessionId` to that session, so **every later stage resumes the same conversation**. Cleanup archives the agent.

## 5. Providers

### 5.1 Tracker (agent-mediated, MCP)

Config (`~/.agentgrid/integrations.json`):

```jsonc
"tracker": {
  "preset": "jira",
  "toolPrefix": "mcp__atlassian",
  "mcpServers": { "atlassian": { "type": "sse", "url": "https://mcp.atlassian.com/v1/sse" } },
  "hints": "Bugs live in project PAY"
}
```

Four calls, all implemented as short headless SDK queries with structured JSON output, restricted to the tracker's MCP tools:

| Call | Used by | Returns |
|---|---|---|
| `listMyIssues()` | launcher "My open bugs" | `[{key,title,url,status,priority}]` |
| `fetchIssue(idOrUrl)` | intake | full normalised issue |
| `comment(key, text)` | after PR open, after merge | — |
| `transition(key, state)` | after merge | — |

Prompts per preset live in `presets/tracker/<preset>.md` and are user-editable; adding a tracker is a file, not a release. Responses are validated against the schema; a malformed response fails the call with the raw text attached.

**Connect flow:** Settings → Integrations → *Connect tracker* runs `claude mcp add --scope user …`, then opens an embedded terminal on a throwaway session where the user completes `/mcp` OAuth. *Test connection* runs `listMyIssues()` and reports the result. Scope is user-level, so the user's own terminal sessions gain the same tools.

**Verified (2026-09-25 spike):** headless SDK sessions *can* call MCP tools, including a remote OAuth server authenticated interactively — a probe session executed both a local stdio tool and a remote `claude.ai` connector tool successfully. One condition: the session must pass the server definitions in `Options.mcpServers`; relying on `settingSources: ["user"]` alone surfaced zero tools in this environment. Tracker config therefore stores the MCP **server definition**, not just a name, and the tracker queries pass it explicitly. The REST-token fallback is not needed.

### 5.2 Forge (server-side CLI adapters)

```jsonc
"forge": { "preset": "github" }          // gh
"forge": { "preset": "gitlab" }          // glab
"forge": { "preset": "custom",
           "getPr": "myforge pr show {url} --json",
           "map": { "state": ".status", "reviewDecision": ".review.state",
                    "comments": ".notes[]", "checks": ".pipeline.status" },
           "merge": "myforge pr merge {url} --{method}" }
```

Interface: `createPrCommand(ctx)` (the command the *agent* runs), `getPr(url)`, `listReviewEvents(url, since)`, `merge(url, method)`, `authStatus()`. `github` and `gitlab` adapters are code with recorded-JSON fixtures; `custom` is command templates plus field paths. A forge that cannot be polled still works — `monitoring` becomes manual ("I've reviewed it, continue").

The forge preset is auto-detected from the repo's `origin` host and confirmed in Settings.

## 6. Flow, stage by stage

| Stage | Who runs | Does | Advances when |
|---|---|---|---|
| `intake` | server | create worktree + branch from a fresh `baseBranch`; spawn agent; write `issue.json` | worktree and branch exist |
| `analyzing` | agent | read ticket + code, reproduce if cheap, write `plan.md` | `plan.md` non-empty |
| `plan-review` | **user** | approve / request changes / cancel | click |
| `implementing` | agent | change code, add tests, run them, commit on the branch (never push) | ≥1 new commit on branch |
| `diff-review` | **user** | server computes `git diff baseBranch..branch`; approve / request changes / cancel | click |
| `opening-pr` | agent | push branch, run the forge's create-PR command, write `pr.json`; tracker `comment` with the PR link | server finds the PR via the forge adapter |
| `monitoring` | server watcher | poll every 60 s (configurable) | an event opens a gate |
| `review-feedback` | agent → **user** | agent fixes the code and drafts a reply per comment → review card → approving pushes the commits and posts the replies, then returns to `monitoring` | click |
| `rebase` | agent → **user** | agent rebases the branch on a moved `baseBranch`, resolves conflicts → diff card again → approving pushes, then returns to `monitoring` | click |
| `approved` | **user** (or auto) | merge card: state, checks, approvals, method | click / policy |
| `merging` | server + agent | forge `merge`; tracker `transition` + `comment` | merge confirmed by the forge |
| `done` | server | remove worktree and local branch, archive the agent, keep artifacts | — |

**Watcher event mapping:** changes requested or new comments → `review-feedback`; approved → `approved`; checks failing → notify, stay in `monitoring`; `CONFLICTING` → `rebase` gate; PR closed unmerged → `cancelled`.

## 7. UI

**Launcher** — top-bar **🐞 Fix a bug**: issue URL/key input *or* "My open bugs" list; repo picker (pre-filled from the project→repo mapping); merge policy; preflight strip (tracker connected, forge authenticated, repo has a remote).

**Tile** — 🐞, issue key as name, issue title as the task line, stage chip (`plan review`, `PR #482 monitoring`, …). Bug agents sit in the normal board sections, so an open gate lands them in **Needs you** with the existing notification.

**Details** — for bug agents: issue header → stage timeline → the current gate card.

- **Plan card**: rendered `plan.md`; *Approve & implement* / *Request changes…* / *Cancel*.
- **Diff card**: `+/−` summary, per-file collapsible hunks, test output; *Create PR* / *Request changes…* / *Cancel*.
- **Review card**: each reviewer comment (author, `file:line`, body) with the agent's proposed response/fix; *Approve & push* / *Edit* / *Skip*.
- **Merge card**: PR state, checks, approvals, merge-method selector; *Merge & close out* / *Not yet*.

"Request changes" is a text box whose contents become the next instruction to the same session. Terminal and Transcript tabs keep working throughout.

## 8. Failure handling & safety

- A stage either verifies and advances or fails with the reason on the card plus *Retry stage* / *Open terminal* / *Cancel*.
- Server restart mid-stage fails that stage (retryable); gates and `monitoring` resume from disk untouched.
- Forge rate limits back off and stay in `monitoring`; lost forge auth notifies and pauses the watcher.
- Tracker unreachable blocks intake; mid-run it fails only that stage.
- **Nothing irreversible unattended:** push, PR create and merge each sit behind a clicked gate; `auto` merge is an explicit per-run choice.
- The server refuses push/PR when the branch is the default branch or has no commits; no force-push.
- No credentials stored by AgentGrid: tracker auth lives in Claude Code's MCP store, forge auth in the CLI's keychain. Server stays loopback-only.
- Cancel leaves the worktree and branch for inspection; a *Clean up* button removes them.

## 9. Testing

- **Unit:** stage machine as a pure reducer over events (all transitions and loops); artifact verification; "new review events since `lastSeenEventAt`"; forge adapters against recorded `gh`/`glab` JSON fixtures; tracker prompt rendering and schema validation.
- **Integration:** fake tracker + fake forge + scripted agent driving a complete task through every stage and gate via the API; a real-git test (temp repo → worktree → commit) for diff computation and the branch guards.
- **Live (opt-in, read-only):** `AGENTGRID_LIVE=1` test that runs `listMyIssues()` through the real MCP — this doubles as the OAuth-reuse check.
- **UI:** gate card rendering per stage, launcher preflight states, and an e2e walking a whole bug task end to end in fake mode.

## 10. Phasing

- **Phase 1:** integrations config + connect/test, launcher, intake, `analyzing`, plan gate, `implementing`, diff gate, `opening-pr`. Ends with a PR opened from a ticket; the task then rests in `monitoring` showing "PR open — tracked manually" (no watcher yet), and the agent can be cleaned up by hand.
- **Phase 2:** watcher, `review-feedback` loop, `approved`/`merging`, tracker write-back, cleanup and agent archival.

## 11. Out of scope (v1)

Multi-repo fixes for one ticket; automatic ticket triage or assignment; writing tracker fields other than comment/transition; forge review *submission* (approving others' PRs); Windows.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Headless MCP OAuth reuse fails | Verified by task 1; REST-token tracker adapter as fallback |
| Tracker MCP responses vary by provider | One normalised schema, validated; prompts are per-preset files |
| Long-lived branches drift | `CONFLICTING` opens a rebase gate |
| Agent misreports work | Server verifies diff, branch and PR itself |
| Cost creep across stages | Per-stage caps in the `bugfix` role; cumulative spend on the card |
