# AgentGrid

A local dashboard for running a **team of Claude Code agents in parallel** — and actually keeping track of them.

Each tile on the grid is a persona: a *role* (reviewer, coder, devops…) spawned into a *repo*. You assign work with one keystroke, watch what everyone is doing at a glance, answer permission prompts and questions inline, and drop into the full terminal session only when you need depth. When an agent finishes, it goes back to *free* and waits for the next task — remembering what it learned about that repo.

```
┌ ⬢ AgentGrid ─ 12 agents ─ ● 5 working  ● 2 need you  ● 2 done  ○ 3 free ─ $4.12 today ─ [+ Spawn] ┐
│                                                                                                   │
│  🛠️ Dev — devops     🧐 Rhea — reviewer   👩‍💻 Cody — coder    🧪 Tess — tester      │ Dev — devops │
│  hrns  [needs you]   payments [question]  hrns              hrns                 │ #a41 · 6m    │
│  Wants to run        Which base branch?   ● Editing         ● playwright e2e     │              │
│  kubectl rollout…                          src/auth/…         (3/9)               │ Permission:  │
│  #a41 · 6m   $0.31   #a39 · 2m   $0.08    #a42 · 14m $1.04  #a40 · 9m   $0.44    │ Bash         │
│                                                                                   │ kubectl …    │
│  🎤 Demi — demo-prep  🏛️ Archie — architect  🧐 Ravi — reviewer  🛠️ Ops — devops   │ [Allow]      │
│  ✅ Demo script ready  ● Drafting ADR-014   ❌ Max turns        ● terraform plan  │ [Always]     │
│  …                                                                                │ [Deny]       │
└───────────────────────────────────────────────────────────────────────────────────┴──────────────┘
```

## Why

If you run 10–15 Claude Code sessions at once (architecture, coding, DevOps, testing, reviews, demo prep…), terminal windows stop scaling. You lose track of who is working on what, who is blocked waiting for a `y/n`, and what finished an hour ago. AgentGrid turns that into a roster you can monitor and delegate to.

Under the hood it is a thin layer over the official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk): every assignment is a real Claude Code session, with your skills, plugins, MCP servers and `CLAUDE.md` files applied.

## Requirements

- **Node.js 22+**
- **Claude Code CLI** installed and logged in (`claude` on your PATH). AgentGrid pins `@anthropic-ai/claude-agent-sdk` to the CLI version it was built against (`2.1.268` / SDK `0.3.268`); upgrade both together.
- macOS or Linux. "Open in Terminal" uses AppleScript and is macOS-only (on other platforms the command is copied to your clipboard instead).

## Quick start

```bash
git clone https://github.com/MinsterMind/agentgrid.git
cd agentgrid
npm install
npm run build
npm run serve            # → http://127.0.0.1:4800
```

1. Click **+ Spawn**, pick a role and browse to a repo (git repos are badged; one click selects). The agent appears on the grid as *free*.
2. Type a task into its tile and press **⏎**. The tile turns blue (*working*) and shows what the agent is doing.
3. When it needs you, the tile glows amber (*needs you*). Click it: the side panel shows the permission or question — **Allow / Always allow / Deny**, or pick an answer. Or press `a` / `d`.
4. When it finishes the tile turns green (*done*) with a summary; failed tasks turn red. Press **Ack → free** to put the agent back in the pool.
5. **Open in Terminal** at any point opens `claude --resume <session>` in Terminal/iTerm for the full conversation.
6. **Terminal** tab (side panel) embeds the real Claude Code TUI for that agent's session — type, answer prompts, use slash commands — exactly as in a terminal. ⤢ widens it. Available whenever the agent isn't mid-task.
7. **Transcript** (side panel) shows the agent's full session — every prompt, reply, tool call and result, live while it works — the same conversation you'd see in the terminal.
8. **Sessions** (top bar) lists every Claude Code session on the machine — live terminal and background sessions with their status, plus recent history. **Adopt** a past session to put it on the grid: that agent then *continues that conversation* with every prompt you assign (🔗 on the tile). Background sessions get **Attach in Terminal**.

Everything lives in `~/.agentgrid/` as plain files — roles, agents, assignments, and each agent's memory.

## Concepts

| Thing | What it is |
|---|---|
| **Role** | A template: persona prompt, model, effort, permission mode, allowed tools, turn/budget caps. `~/.agentgrid/roles/<role>.md`. Six ship by default: `architect`, `coder`, `reviewer`, `tester`, `devops`, `demo-prep`. |
| **Agent** | A role spawned into a repo, e.g. `reviewer@payments`. Has a name, an avatar, a state, and its own memory. |
| **Assignment** | One task = one fresh Claude Code session. Kept as history (prompt, session id, outcome, turns, cost). |
| **Memory** | `~/.agentgrid/agents/<id>/memory/` — a `MEMORY.md` index plus one file per fact. The **agent** decides what to remember; the index is injected into every new session, details are read on demand. |

Agent states: `free → working → waiting → working → done | failed → (ack) → free`. Only *free* agents accept work; *done*/*failed* stay on screen until you acknowledge them.

### Role files

```md
---
name: reviewer
avatar: 🧐
model: claude-opus-5
effort: high
permissionMode: default          # default | plan | acceptEdits | bypassPermissions
settingSources: [user, project]  # inherit your ~/.claude and repo settings/skills
allowedTools: [Read, Grep, Glob, "Bash(git *)", "Bash(gh *)"]
maxTurns: 40
maxBudgetUsd: 3
---
You are a meticulous code reviewer. Review only; do not edit files. ...
End every task with a 2–3 line summary: what changed, what you verified, what is left.
```

Add a file to add a role; the server watches the directory. `model` is required (the SDK would otherwise silently default to Sonnet).

## Keyboard

| Key | Action |
|---|---|
| `1`–`9` | Select tile |
| `a` / `d` | Allow / Deny the selected agent's pending permission |
| `o` | Open the selected agent's session in a terminal |
| `⏎` / `⇧⏎` | Submit / newline in the assign box or answer field |
| `/` | (in an empty assign box) recent prompts for that agent |
| `esc` | Close dialog, then deselect |

The tab title shows `(N) AgentGrid` while N agents need you; the "● N need you" pill cycles through them. Desktop notifications are on by default for *needs you* and off for *done/failed* — toggle in the footer.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGENTGRID_PORT` | `4800` | Listen port (always bound to `127.0.0.1`) |
| `AGENTGRID_HOME` | `~/.agentgrid` | Data directory |
| `AGENTGRID_BROWSE_ROOT` | `~` | Top of the folder tree the Spawn dialog can browse (e.g. your projects directory) |
| `AGENTGRID_FAKE` | unset | `1` → scripted runner that never calls the API (for demos/tests) |

There is no authentication: the server listens on loopback only. Don't expose it.

## Development

```bash
npm test                          # unit + integration tests (server + ui), no API calls
npm run test:live -w server       # opt-in: one real SDK session end to end (costs a few cents)
npm run e2e -w ui                 # Playwright smoke test against the fake runner
AGENTGRID_FAKE=1 npm run serve    # server with a scripted agent
npm run dev -w ui                 # Vite dev server, proxies /api to :4800
```

Layout: `server/` (Node + TypeScript: file store, one `Runner` per agent around SDK `query()`, Express REST + SSE), `ui/` (Vite + React). The design spec and the implementation plan are in `docs/superpowers/`.

## Limitations (v1)

- One task per agent at a time; no queues, no agent-to-agent handoff.
- Prompts can't be injected into a session that is currently open in a terminal — close it, then adopt it.
- Restarting the server marks in-flight tasks as failed (their sessions can still be resumed in a terminal).
- Cost is known only when a task finishes.
- Dark theme only; desktop-width layout.

## License

[MIT](LICENSE)
