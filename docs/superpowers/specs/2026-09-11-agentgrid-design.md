# AgentGrid — Design Spec

**Date:** 2026-09-11
**Status:** Approved design, pre-implementation
**Working name:** AgentGrid (rename freely; nothing depends on it)

## 1. Problem

The user runs 10–15 Claude Code sessions in parallel across architecture, coding, DevOps, testing, review and demo prep. Tracking them across terminal windows is the bottleneck: it is hard to see who is working on what, who is blocked waiting for input, and what finished. The user's job is monitoring and delegation, not typing in terminals.

## 2. Goal

A local web dashboard that shows a **team roster** of persona agents on one screen, lets the user assign work to a free agent in one keystroke, surfaces "needs you" moments inline, and hands off to a full terminal session only when depth is needed.

## 3. Feasibility findings (spike, 2026-09-11)

Claude Code 2.1.268 and `@anthropic-ai/claude-agent-sdk` 0.3.268 (version-locked to the CLI) already provide the runtime. A throwaway spike confirmed:

| Need | Mechanism | Verified |
|---|---|---|
| Permission prompts as events | `canUseTool(toolName, input, {suggestions})` callback | yes — includes "always allow" rule suggestions |
| Clarifying questions as events | `AskUserQuestion` arrives via the same `canUseTool`; answered with `{behavior:'allow', updatedInput:{...input, answers}}` | yes |
| Hand-off to terminal | `system/init` message exposes `session_id`; `claude --resume <id>` in the repo continues the same conversation | yes |
| Done signal + cost | `result` message with `num_turns`, `total_cost_usd`, `duration_ms` | yes |

Caveats learned: the SDK defaults to `claude-sonnet-5` unless `model` is set; `settingSources` must be passed explicitly to inherit the user's skills/plugins/CLAUDE.md.

The built-in `claude agents` TUI covers listing/dispatch of background sessions. AgentGrid's differentiation is the workflow opinion: personas, an idle pool, fresh-session-per-task with curated memory, and inline interrupt handling.

## 4. Decisions (from brainstorming)

1. **Grid of persona tiles** — each agent is a human-like indicator (avatar, first name, role, repo, state ring), not a process row.
2. **Idle pool** — agents exist before work and are `free` until assigned.
3. **Roles are templates spawned into repos** — an agent instance is `role × repo`.
4. **Hybrid interaction** — quick answers (permissions, questions) inline; "open full session" for depth.
5. **Fresh session per assignment, with agent-curated memory** — the agent decides what to remember; the index is injected on every assignment; details are read on demand.
6. **Local web app first** (Node server + React), wrappable in Tauri/Electron later.
7. **Runtime = Agent SDK** (`query()`), not CLI wrapping.
8. **Layout B** — uniform grid (spatial memory) + right-hand detail panel.

## 5. Domain model

All state lives as plain files under `~/.agentgrid/`.

### 5.1 Role (template) — `roles/<role>.md`

Same frontmatter format as `.claude/agents/*.md`, so it is directly usable as an SDK `AgentDefinition`, plus a few AgentGrid-only keys:

```
---
name: reviewer
avatar: 🧐
model: claude-opus-5
effort: high
permissionMode: default          # default | plan | acceptEdits | bypassPermissions
settingSources: [user, project]  # which Claude Code settings the agent inherits
allowedTools: [Read, Grep, Glob, "Bash(git *)", "Bash(gh *)"]
maxTurns: 40
---
You are a senior code reviewer. ...
End every task with a 2–3 line summary: what changed, what you verified, what is left.
```

Initial roles shipped as defaults: `architect`, `coder`, `reviewer`, `tester`, `devops`, `demo-prep`. Adding a file adds a role; the server watches the directory.

### 5.2 Agent instance — `agents/<id>.json`

```json
{
  "id": "reviewer@hrns",
  "role": "reviewer",
  "repo": "/Users/manojmali/MinsterMind/hrns",
  "displayName": "Rhea",
  "createdAt": "2026-09-11T12:00:00Z",
  "state": "free",
  "currentAssignmentId": null
}
```

`id` = `<role>@<basename(repo)>`, suffixed `-2`, `-3` on collision. Deleting an instance moves its directory to `agents/_archived/` (memory is preserved).

### 5.3 Assignment — `assignments/<id>.json`

```json
{
  "id": "a41",
  "agentId": "devops@hrns",
  "prompt": "Restart the staging API after the config change and confirm /health is green.",
  "createdAt": "...", "startedAt": "...", "endedAt": null,
  "sessionId": "a9bcb149-...",
  "state": "waiting",
  "activity": "Bash: kubectl rollout restart deploy/hrns-api -n staging",
  "pending": {
    "kind": "permission",
    "toolUseId": "toolu_...",
    "toolName": "Bash",
    "input": { "command": "kubectl rollout restart deploy/hrns-api -n staging" },
    "suggestions": [ ... PermissionUpdate[] from the SDK ... ]
  },
  "outcome": null,
  "error": null,
  "turns": 0,
  "costUsd": 0
}
```

`pending.kind` is `permission` or `question`; for `question`, `input` is the `AskUserQuestionInput` (questions with options, `multiSelect`). Assignments are append-only history and double as a per-agent worklog.

### 5.4 Memory — `agents/<id>/memory/`

`MEMORY.md` (index, one line per fact) plus `*.md` fact files with `name` / `description` frontmatter. Written only by the agent. The server lists the files for display; it never parses or edits them.

### 5.5 Agent state machine

```
free ──assign──▶ working ──canUseTool──▶ waiting ──answer──▶ working
                   │
                   ├── result(success) ──▶ done   ──ack──▶ free
                   └── result(error) / abort ──▶ failed ──ack──▶ free
```

- `done` and `failed` are sticky until acknowledged.
- `waiting` is the only state that notifies the user.
- Only `free` agents accept assignments; no per-agent queue in v1.

## 6. Server / runtime

One Node + TypeScript process, `agentgrid serve`, on `localhost:4800`. No database, no auth (loopback only). Serves the built UI and the API.

### 6.1 Store

Sole owner of `~/.agentgrid/`. Reads roles (with a directory watcher), agents, assignments; writes atomically (write temp file, rename). Provides `getState()` and an event emitter for diffs.

### 6.2 Runner (one per agent instance)

- `assign(agentId, prompt)`:
  - Guard: agent must be `free`.
  - Build options: `cwd = repo`, `agent = role`, `agents = {[role]: roleDef}`, `model`, `effort`, `permissionMode`, `settingSources`, `allowedTools`, `maxTurns`, `permissionPrompts: 'host'`, `canUseTool`, and an `AbortController`.
  - Build the prompt per §8.1.
  - Call `query()`; set state `working`; create the assignment record.
- `canUseTool(toolName, input, {suggestions, toolUseID})`:
  - Write `pending`, set state `waiting`, emit event.
  - Return a Promise parked in `Map<toolUseId, resolver>`. No timeout.
- `answer(agentId, toolUseId, decision)`:
  - `{kind:'allow'}` → `{behavior:'allow'}`
  - `{kind:'always'}` → `{behavior:'allow', updatedPermissions: pending.suggestions}`
  - `{kind:'deny', message?}` → `{behavior:'deny', message}`
  - `{kind:'answers', answers, response?}` → `{behavior:'allow', updatedInput:{...input, answers, response}}`
  - Clear `pending`, state `working`.
- Stream consumption:
  - `system/init` → store `sessionId`.
  - `assistant` → last text block or `tool_use` name + summarised input becomes `activity`.
  - `result` → `done` (subtype `success`, `outcome` = final text) or `failed` (`error` = subtype/message); record `turns`, `costUsd`, `endedAt`.
- `cancel(agentId)` → abort → `failed` with `error: "cancelled"`; `sessionId` retained.
- `ack(agentId)` → `done|failed` → `free`.
- On server start: any assignment still `working`/`waiting` is marked `failed` with `error: "server restarted"`; the agent returns to `free`. No zombie recovery in v1.
- Every runner is isolated: an exception in one maps to `failed` for that agent and never takes the server down.

### 6.3 HTTP API

```
GET    /api/state                          → { roles, agents, assignments: active + last 50 }
GET    /api/events                         → SSE; each event is a JSON patch-like {type, payload}
POST   /api/agents                         { role, repo, displayName? } → agent
DELETE /api/agents/:id                     → archives
POST   /api/agents/:id/assign              { prompt } → assignment
POST   /api/agents/:id/answer              { toolUseId, decision }
POST   /api/agents/:id/cancel
POST   /api/agents/:id/ack
POST   /api/agents/:id/open-terminal       → osascript Terminal.app/iTerm: `cd <repo> && claude --resume <sessionId>`
GET    /api/assignments/:id/transcript     → parsed session JSONL from ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl
GET    /api/agents/:id/memory              → [{ file, name, description }]
```

Errors: 409 when assigning to a non-free agent or answering a non-pending toolUseId; 404 for unknown ids; 400 for validation. All responses JSON.

### 6.4 Concurrency and limits

15 concurrent SDK subprocesses are fine on a Mac (mostly idle on network). The practical limit is cost, which is why cost is on every tile. Per-role `maxTurns` is the only hard cap in v1.

## 7. UI

**Stack:** Vite + React + TypeScript, dark theme only, served by the server. State: `GET /api/state` once, then SSE patches into one `useReducer`. No polling, no state library.

### 7.1 Layout (B)

Uniform tile grid on the left (order = creation order, never re-sorted), detail panel on the right for the selected agent. Grid wraps by viewport width (3–4 columns on a laptop, 5–6 on an external monitor).

### 7.2 Components

- `TopBar` — counts by state, today's spend, `+ Spawn`. The "● N need you" count is a button that cycles selection through waiting agents.
- `SpawnDialog` — pick role, repo path (recent paths remembered), auto-suggested first name (editable).
- `AgentGrid` — the tiles.
- `AgentTile` — avatar, first name, role, repo basename; state ring colour (free grey/dimmed, working blue, waiting amber + glow + badge, done green, failed red); activity line; footer `#id · elapsed · $cost`. Free tiles carry an inline assign textarea. Click selects.
- `SidePanel` — task text, activity feed (last ~30 events), `PendingPrompt` when waiting, action row (Open in Terminal, Cancel, Ack), Delete agent (free/done/failed only) → archives, memory file list (read-only), outcome/error when done/failed.
- `PendingPrompt` — permission variant (Allow / Always allow / Deny, showing the command or edit summary) and question variant (option buttons per question, multi-select where flagged, free-text fallback). Optimistic: tile returns to `working` on submit.

### 7.3 Attention

- Tab title `(N) AgentGrid` when N agents are waiting.
- macOS notification + short sound on `working → waiting` (on by default) and on `→ done/failed` (off by default). Toggle in a small settings menu.
- Keyboard: `1–9` select tile, `a` allow, `d` deny, `⏎` submit assign/answer, `⇧⏎` newline, `o` open in terminal, `esc` deselect.

### 7.4 Assign box

Plain textarea. `/` opens the agent's recent prompts for reuse. Text is passed verbatim into the task section (§8.1).

### 7.5 Not in v1

Light theme, drag-to-reorder, mobile layout, memory editing, transcript search, per-agent queues, agent-to-agent handoff, cost-based abort.

## 8. Assignment & memory contract

### 8.1 Prompt assembly

```
<agent-memory dir="~/.agentgrid/agents/<id>/memory">
<index>
…contents of MEMORY.md, or the word "empty"…
</index>
Read a memory file with Read when its one-line hook looks relevant to the task.
Before you finish, save any durable, non-obvious fact about this repo, its
tooling, or this kind of task as a new file in the memory dir (frontmatter:
name, description) and add one line to MEMORY.md. Do not save what the repo
or git history already records.
</agent-memory>

<task>
…assign box text verbatim…
</task>
```

### 8.2 Done detection

The SDK `result` message. The final assistant text is the outcome shown on the tile; the role file instructs the agent to end with a 2–3 line summary (what changed, what was verified, what is left).

### 8.3 Cancel

Abort the query; assignment → `failed` (`cancelled`); `sessionId` kept so the session can still be resumed in a terminal.

## 9. Testing

- **Unit:** role parser; prompt assembler (snapshot); runner state machine driven by a fake `query()` that yields scripted SDK messages and invokes `canUseTool`; store atomic writes; API handlers with the fake runner.
- **Integration (opt-in, `AGENTGRID_LIVE=1`, costs cents):** real SDK against a temp repo — permission surfaced and answered, question surfaced and answered, memory file written and indexed, `claude --resume <sessionId> -p` recalls the task. This is the 2026-09-11 spike, kept as a test.
- **UI:** component tests for `AgentTile` (all five states) and `PendingPrompt` (both variants); one Playwright smoke test against the server with the fake runner: spawn → assign → answer permission → ack.

## 10. Project layout

```
agentgrid/
  package.json           # workspaces: server, ui
  server/                # Node + TS: store/, runner/, api/, prompt/, roles/ (defaults)
  ui/                    # Vite + React + TS
  docs/superpowers/specs/
```

## 11. Risks

- **SDK/CLI drift.** SDK and CLI are version-locked; upgrades must move together. Pin both.
- **Anthropic may ship a grid view for `claude agents`.** The roster workflow (personas, pool, per-agent memory, inline interrupts) remains the differentiator; if the built-in viewer improves, the runner can be swapped without touching the domain model or UI.
- **Live cost is end-of-task only** unless partial usage is exposed; tiles may show `$—` until `result`. Acceptable for v1.
- **Server restart drops in-flight work** (marked failed, resumable manually). Acceptable for a single-user local tool.
