# Permissions from anywhere, shared always-allow rules, and a combined Bugs view — design

Date: 2026-10-06 · Target release: 0.11.0

## 1. What the user asked for, and what we agreed

1. **Answer permission requests from a details view.** Applies to embedded Terminal tab sessions, to the
   bug-fix screen, and to agents spawned in AgentGrid. It does not apply to sessions still running in an
   outside terminal app (iTerm/Terminal).
2. **No "needs permission" alert when auto mode approved the request itself.**
3. **Tell the server "always allow".** These are shared rules kept by AgentGrid, applied to every agent,
   every bug-fix run and every embedded session, and listed and removable in Settings.
4. **A combined Bugs view.** The left side lists every open bug assigned to me. Clicking one shows its
   details on the right: the workflow for a started bug, or the ticket with an inline Start for one not
   yet started.

## 2. Findings that shape the design

- **Two kinds of run.** Agents AgentGrid runs itself go through the Agent SDK. Their permission requests
  arrive in `canUseTool` (`server/src/runner/runner.ts`), which pauses the run and records a `Pending` on
  the assignment. The tile and the side panel already answer these with Allow / Deny, and with Always
  allow only when the SDK offered suggestions. The Bugs screen shows "waiting on you" but has no controls.
- **Terminal sessions are seen only through their session log.** `deriveStatus`
  (`server/src/sessionStatus.ts`) marks a session `waiting` whenever a `tool_use` has no `tool_result`
  yet. That is every running tool, not only one awaiting approval. In auto mode, tools run without
  asking, so a 30-second test run reads as "Needs approval", and `App.tsx` notifies. This is defect #2.
  The log alone cannot tell "running" from "awaiting approval".
- **The hook we need exists.** Claude Code 2.1.289 (installed) supports a `PermissionRequest` hook: it
  runs when a permission dialog is about to be shown, and its output can allow or deny on the user's
  behalf. AgentGrid launches embedded sessions itself (`PtyManager.attach` with `--resume <id>`), so it
  can pass the hook with `--settings <json>` without touching the user's own settings.
- **The tracker already provides what the Bugs view needs.** `GET /api/bugfix/issues` lists my open
  issues. `tracker.fetchIssue` returns the full ticket but has no route yet.

## 3. Permissions: one broker for every run AgentGrid owns

### 3.1 PermissionBroker (server)

A new `server/src/permissions/broker.ts` holds every open permission request from either source and
settles each one exactly once.

```ts
interface PermissionRequest {
  id: string;                    // "pr<n>"; for SDK runs, also carries the SDK toolUseId
  agentId: string;               // the agent whose run or session asked
  source: "sdk" | "terminal";
  sessionId: string | null;
  toolName: string;
  input: Record<string, unknown>;
  suggestedRule: string;         // the rule "Always allow" would save, shown on the button
  createdAt: string;
}
```

- `ask(req) → Promise<Decision>`:
  - It consults the rules first (§4). A match settles the request immediately as allow, and nothing is
    shown.
  - Otherwise it records the request, emits a `permission` grid event, and waits.
- `answer(id, decision)` settles a request.
  - It returns 409 if the request is already settled.
  - `always` saves `suggestedRule` and then allows.
  - Settling emits `permission-settled`.
- **What lives where.**
  - SDK runs keep their `Pending` on the assignment, because the existing UI and tests rely on it. The
    runner's `canUseTool` calls the broker's rule check first, and `answer` routes through the broker so
    that `always` saves a rule the same way for both sources.
  - Terminal requests live only in the broker. They are in `/api/state` as `permissions`, and they are
    dropped when their session's pty exits.

### 3.2 Embedded terminal sessions: the hook

- **Launch.** `PtyManager` starts `claude --resume <id>` with this argument:
  `--settings {"hooks":{"PermissionRequest":[{"matcher":"*","hooks":[{"type":"command","command":"<node> <hook.mjs>","timeout":86400}]}]}}`.
  - It is not added to `claude attach <bgId>`: attaching to a background session cannot change that
    session's hooks. Attached sessions keep log-only status, as today, and §5.1 still applies to them.
- **The hook script** is `server/bin/permission-hook.mjs`, with no dependencies.
  - It reads the hook input from stdin: `session_id`, `tool_name`, `tool_input` and
    `permission_suggestions`.
  - It POSTs them to `AGENTGRID_URL/api/hooks/permission` with the header
    `Authorization: Bearer $AGENTGRID_HOOK_TOKEN`, and waits for the response.
  - It prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{…}}}` — allow
    (with `updatedPermissions` when the human chose always), or deny with a message.
- **The token.** It is random per server start, set only in the pty's environment (`cleanEnv` keeps it,
  because it does not start with `CLAUDE`), and compared in constant time. Without it, the route
  returns 401. The route also refuses any request carrying `Sec-Fetch-Site` (it is never a browser).
- **Fallback.** If the server is unreachable, returns an error, or the request is cancelled, the hook
  exits 0 with no output. Claude Code then shows its own dialog in the terminal as before. The hook
  never denies on its own.
- **Packaged desktop app.** `process.execPath` is Electron, so the command is
  `ELECTRON_RUN_AS_NODE=1 "<execPath>" "<hook.mjs>"` there, and `"<execPath>" "<hook.mjs>"` under
  plain Node. The hook file ships in the server bundle next to `presets/`.
- **Spike, the plan's first task.** Against the installed `claude`, confirm:
  1. The hook does not fire for requests auto mode approves.
  2. What the terminal shows while the hook waits, and whether answering in the terminal settles it.
  3. That `updatedPermissions` from the hook is accepted.

  If (1) fails, or the hook cannot block for a human, switch to the fallback mechanism: a
  `Notification` hook with matcher `permission_prompt` marks the request, and the answer is typed into
  the pty (the option's digit). The broker interface does not change. Record which mechanism shipped.

### 3.3 Answering from anywhere

- `PendingPrompt` gains one permission card used everywhere: the tile, the side panel, and the Bugs
  screen's "Now" panel. It offers Allow, Always allow (with the rule, e.g. *Always allow
  `Bash(npm test:*)`*), and Deny. Questions (`AskUserQuestion`) render as today.
- The side panel shows terminal-session requests for the selected agent with that same card, above the
  log-derived status. The reply box stays for free text.
- The Bugs screen shows the card for the task's agent, whether the request came from the SDK or the
  terminal, inside the "Now"/Blocking area.
- `POST /api/agents/:id/answer` keeps its body (`toolUseId` or request `id`, plus `decision`) and routes
  to the broker.

## 4. Always-allow rules

- **Storage.** `~/.agentgrid/permissions.json` holds `{ "allow": ["Bash(npm test:*)", "Edit", …] }`,
  written atomically. It is shared across every agent, repo and session.
- **Grammar** (a subset of Claude Code's):
  - `Tool` — any use of that tool;
  - `Bash(<prefix>:*)` — commands starting with the prefix;
  - `Bash(<exact>)` — that command only;
  - `WebFetch(domain:<host>)`;
  - for other tools, `Tool(<anything>)` is treated as an exact match on the tool name plus that argument
    string when one is present (`file_path`, `url`, `pattern`).
- **Compound shell commands** (`&&`, `||`, `;`, `|`, `$(`, backticks, newlines) are auto-allowed only if
  every part matches a rule. `npm test && rm -rf /` must never ride on `Bash(npm test:*)`.
- **What "Always allow" saves:**
  - Claude Code's suggestion, when one is offered (SDK `suggestions` / hook `permission_suggestions`)
    and translates to the grammar;
  - otherwise, for Bash, the command's first word plus `:*` (two words for `npm`/`git`/`yarn`/`pnpm`/
    `docker`/`kubectl`/`gh`, e.g. `Bash(git status:*)`);
  - for anything else, the tool name.
- **Dangerous rules.** A bare `Bash` or a bare `Write`/`Edit` would allow every command or every file
  write. Saving one needs a second confirmation that names the risk.
- **Settings.** An **Always allowed** section lists the rules with their creation time and a Remove
  button. It uses `GET`/`DELETE /api/permissions/rules`.
- **The `bugfix` role's protections still hold.** The workflow's prohibitions (no push, no PR creation)
  live in the prompts and the server, not in the permission prompt. Rules do not change what the server
  itself does.

## 5. Notifications (defect #2)

### 5.1 Log-derived status stops guessing

- An open, non-question `tool_use` in the log becomes phase `working`, with `runningTool: {name,
  summary}`, instead of `waiting` with `pendingTool`.
- `AskUserQuestion` still reads as `waiting`, because auto mode never answers questions.

### 5.2 What counts as needing you

- "Needs you" for a terminal session comes from one of two places:
  - a broker request for that session, which fires only when Claude Code was about to ask;
  - a question.
- The "needs you" rule (`ui/src/state/attention.ts`) uses broker requests in place of
  `activity.pendingTool`.
- Notifications fire when a request opens, not when the log shows a running tool.
- **Accepted cost:** a session in an outside terminal (iTerm) that is waiting for approval no longer
  alerts. The user did not ask for that case, and its alert could not be told apart from a running tool.

## 6. Combined Bugs view

- **Left list.** It merges `tracker.listMyIssues()` with AgentGrid's bug tasks by ticket key.
  - Each row shows the key, the title and a priority chip.
  - A started bug also shows its status chip (Running / Waiting on you / Failed / Done / Cancelled /
    No change needed) and its stage, as today.
  - Ordering: started-and-active first (Waiting on you, Running, Failed), then not started (tracker
    order), then finished.
  - Tasks whose ticket is no longer in my list sit in a collapsed group, "Not assigned to you or closed".
  - The list loads on opening the view, refreshes with a Refresh button and every 5 minutes, and keeps
    the last good list (marked stale) on a tracker error. The error is shown inline.
- **Right, for a started bug:** the existing workflow view, unchanged except for the §3.3 card.
- **Right, for an unstarted bug** (`GET /api/bugfix/issues/:key` → `tracker.fetchIssue`):
  - the ticket header: key, title, priority, status and a link;
  - the description and acceptance criteria, rendered with the existing `Markdown` component (no raw
    markup);
  - a **Start** panel: the repo (remembered per project, with Browse), **Branch from** (from preflight),
    the merge policy, and **Start fixing**;
  - the preflight problems and the "may already be fixed — Start anyway" refusal, shown inline;
  - on start, the row becomes the task, and the right side switches to the workflow view.
- **Routing.** `#/bugs/<taskId>` stays. Unstarted tickets use `#/bugs/ticket/<KEY>`.
- **Fix a bug.** The dialog stays, for pasting a URL or a key that isn't assigned to me.

## 7. API changes

| Route | Change |
|---|---|
| `POST /api/hooks/permission` | New. Bearer token, never a browser. Body = hook input; long-polls until a decision. |
| `POST /api/agents/:id/answer` | Accepts broker request ids as well as SDK `toolUseId`s; `always` saves a rule. |
| `GET /api/permissions/rules`, `DELETE /api/permissions/rules` (`{rule}`) | New. |
| `GET /api/bugfix/issues/:key` | New. Full ticket via `tracker.fetchIssue`. |
| `/api/state` | Gains `permissions: PermissionRequest[]`. Session status gains `runningTool`; `pendingTool` is dropped. |
| Grid events | `permission`, `permission-settled`. |

## 8. Error handling

- **The hook fails** (server down, bad token, timeout): no output, exit 0. Claude Code asks in the
  terminal as before.
- **The pty exits while a request is open:** the request is cancelled and drops from the UI. The hook
  process dies with its parent.
- **Answered twice** (two tabs, or tile and panel): the first wins, the second gets 409, and the UI
  refreshes.
- **The rules file is corrupt:** log it, behave as if there are no rules (everything asks), and show it
  in Settings. Never fail open.
- **Tracker unavailable in the Bugs view:** the last good list, marked stale, plus the error. Started
  tasks still show, because they come from AgentGrid's own store.

## 9. Testing

- **Broker:**
  - rules settle immediately;
  - one settle per request, and a second answer gets 409;
  - `always` saves the suggested rule;
  - a pty exit cancels the request.
- **Rule matcher:**
  - prefix, exact, domain and tool forms;
  - compound commands, where every part must match;
  - dangerous-rule detection;
  - suggestion translation.
- **Hook route:** 401 without the token, refused with `Sec-Fetch-Site`, long-poll answered by `answer`,
  and immediately answered by a rule.
- **Hook script:** it is run against a stub server and prints the exact `hookSpecificOutput` for allow,
  always and deny. With the server down, it prints nothing and exits 0.
- **`deriveStatus`:** an open Bash call is `working` with `runningTool`; a question is `waiting`.
- **UI:**
  - the permission card with the rule shown, the second confirmation for dangerous rules, and the card
    on the Bugs screen;
  - the attention rule uses broker requests and no longer flags a running tool;
  - Settings shows and removes rules;
  - the Bugs view merges, orders and groups the list, shows an unstarted ticket with inline Start
    (including Start anyway), and shows a stale list with an error.
- **Spike:** a scripted check against the real `claude`, kept out of CI like the earlier PTY spike, with
  its result recorded in the plan ledger.
- **End-to-end (fake mode):** an embedded-session permission is answered from Details, and a bug is
  started from the combined view.

## 10. Out of scope

- Hooking sessions in outside terminals: it would mean editing the user's `~/.claude/settings.json`.
- Deny rules, and per-agent or per-repo scoping of rules.
- Changing the Jira ticket from AgentGrid.
