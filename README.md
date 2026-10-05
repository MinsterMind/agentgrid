# AgentGrid

A local dashboard for running a **team of Claude Code agents in parallel** — and actually keeping track of them.

Each tile on the grid is a persona: a *role* (reviewer, coder, devops…) spawned into a *repo*. You assign work with one keystroke, watch what everyone is doing at a glance, answer permission prompts and questions inline, and drop into the full terminal session only when you need depth. When an agent finishes, it goes back to *free* and waits for the next task — remembering what it learned about that repo.

```
┌ ⬢ AgentGrid ─ 12 agents ─ ● 5 working  ● 2 need you  ● 2 done  ○ 3 free ─ $4.12 today ─ [+ New agent] ┐
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

- **Node.js 22+** (only when running from source — the desktop app bundles its own)
- **Claude Code CLI** installed and logged in (`claude` on your PATH). AgentGrid pins `@anthropic-ai/claude-agent-sdk` to the CLI version it was built against (`2.1.268` / SDK `0.3.268`); upgrade both together.
- macOS or Linux. "Open in Terminal" uses AppleScript and is macOS-only (on other platforms the command is copied to your clipboard instead).

## Install the desktop app (recommended)

Download the latest **AgentGrid-<version>-arm64.dmg** (Apple Silicon) or **-x64.dmg** (Intel) from [Releases](https://github.com/MinsterMind/agentgrid/releases), open it and drag AgentGrid to Applications. Linux: the `.AppImage` (`chmod +x`, then run).

The app is not signed with an Apple Developer ID yet, so macOS will refuse the first launch ("cannot be opened" / "unidentified developer"). Run this once after copying it to Applications:

```bash
xattr -d com.apple.quarantine /Applications/AgentGrid.app
```

(Right-click → Open → Open also works on most macOS versions.) If you ever see **"AgentGrid is damaged"**, that's a broken signature from a pre-0.1.1 build — download the current release.

AgentGrid starts its own local server inside the app and picks up your login shell's environment (PATH, tokens) so `claude` and your project hooks work exactly as in a terminal. **Settings** menu: browse root for Spawn, data directory, restart server.

Requirements: the [Claude Code CLI](https://claude.com/claude-code) installed and signed in (`claude` on your PATH). Node.js is **not** required for the app.

## Run from source

```bash
git clone https://github.com/MinsterMind/agentgrid.git
cd agentgrid
npm install
npm run build
npm run serve            # → http://127.0.0.1:4800
```

1. Click **+ New agent**, pick a role and browse to a repo (git repos are badged; one click selects). The agent appears on the grid as *free*.
2. Type a task into its tile and press **⏎**. The tile turns blue (*working*) and shows what the agent is doing.
3. When it needs you, the tile glows amber (*needs you*). Click it: the side panel shows the permission or question — **Allow / Always allow / Deny**, or pick an answer. Or press `a` / `d`.
4. When it finishes the tile turns green (*done*) with a summary; failed tasks turn red. Press **Ack → free** to put the agent back in the pool.
5. **Open in Terminal** at any point opens `claude --resume <session>` in Terminal/iTerm for the full conversation.
6. **Details** tab shows the agent's live status (working / waiting for approval / asking you / idle) with its latest message, and lets you **reply right there** — even while the session runs in the embedded terminal. Adopted agents can **Start fresh** to drop the old conversation.
7. **Terminal** tab (side panel) embeds the real Claude Code TUI for that agent's session — type, answer prompts, use slash commands — exactly as in a terminal. ⤢ widens it. Available whenever the agent isn't mid-task.
8. **Transcript** (side panel) shows the agent's full session — every prompt, reply, tool call and result, live while it works — the same conversation you'd see in the terminal.
9. **Live sessions are on the grid by default.** Any Claude Code session running on the machine (terminal or background) shows up as a dashed *ghost tile* with its status; **Pull in** turns it into an agent bound to that session: for a session open in a terminal it closes it there (Claude Code saves the conversation) and opens it in the grid's Terminal tab; background sessions are attached.
10. **Sessions** (top bar) lists every Claude Code session on the machine — filter by name/repo/id, **rename** (✎, stored in Claude Code itself), or **pull in by session id** for anything older than the list — live terminal and background sessions with their status, plus recent history. **Adopt** a past session to put it on the grid: that agent then *continues that conversation* with every prompt you assign (🔗 on the tile). Background sessions get **Attach in Terminal**.
11. **🐞 Fix a bug** (top bar) turns a tracked ticket into a merged PR, gated at every step: AgentGrid pulls the issue from your tracker, an agent analyses it and writes a plan you approve, and implements the fix in a private git worktree, showing you the diff. Approving the diff hands off to the server, which pushes exactly the commit you reviewed and opens the pull request itself — no agent ever holds a forge credential. From there it keeps watching: if a reviewer asks for changes, or your branch conflicts with the base, AgentGrid opens a new diff-review gate with the agent's fix — approving it pushes exactly the commit you reviewed, no more, no less. Once the PR is approved, a merge gate lets you pick the merge method and click Merge; AgentGrid confirms the merge really landed, tears down the worktree, and frees the agent for its next task. The finished card (merged, or closed without merging) stays up until you dismiss it. The first time you click it on an unconfigured machine, it explains exactly what's missing and gets out of your way — see **Set up the bug-fix workflow** below.
12. **Bugs** (top bar) shows one bug fix end to end, on one page: where it is in the pipeline, what the agent is doing right now, everything blocking it (an approval waiting on you, a failed stage, failing checks, a conflict, a setup problem), and every assumption or open question the agent reported along the way — questions first, newest marked. The approve / request-changes / merge actions are on the same page. Plans, diffs and errors are rendered — sections, a real diff, readable error cards — never shown as raw markdown. Each bug has its own link (`#/bugs/bt3`); starting a fix opens it there, and a bug's card in the side panel has an **Open full view** link. In 0.8 it shows a connected pipeline, a glowing Blocking panel beside Now, and the plan as four cards.
13. **The look.** AgentGrid 0.7 shows live counters in the top bar, glows each agent by state (cyan working, amber needs you, green done, red failed), and lets you Allow or Deny a request right on the agent's card.

Everything lives in `~/.agentgrid/` as plain files — roles, agents, assignments, and each agent's memory.

### Set up the bug-fix workflow

The bug-fix workflow needs a **tracker** (where the ticket lives) and a **forge** (where the pull request gets opened). On a fresh machine, neither is configured — click **🐞 Fix a bug** or **⚙︎ Settings** in the top bar and AgentGrid tells you exactly what's missing and how to fix it, right there in the dialog. There is no separate setup wizard and nothing to find in the dark; every check on the Settings screen names the specific problem (a missing tracker, a missing forge, a role that failed to load) and carries its own remedy — a command to run, a field to fill in, or a button to press.

**Tracker.** AgentGrid talks to your tracker through an MCP server (Jira, Linear, … anything MCP-based) — the same server Claude Code itself already uses. It stores no definition and no credential of its own: it reaches the server through Claude Code's own configuration, wherever that server is defined — locally, or as a connector linked to your Claude account. Open **⚙︎ Settings**, and every MCP server Claude Code **has connected or has configured** shows up in the **Tracker** section, labeled with where it came from ("configured in Claude Code", "linked to your Claude account", or the directory it's scoped to). Pick the one that's your tracker, press **Use this**, and you're done — AgentGrid remembers only its preset and its name (the "tool prefix"), nothing else.

Two things that list does not promise:

- **A connector you have never used may not be there.** The account half of the list is read from Claude Code's record of what has *ever* connected, so a connector you linked but never actually called in Claude Code can be missing. Use it once in Claude Code and it appears. In the meantime, **Enter a tracker by hand** in the same section takes its preset and tool prefix directly — that is the interim remedy, and **Test** tells you straight away whether the prefix resolves.
- **A server scoped to a directory resolves only from that directory.** Rows labeled "configured for `<dir>`" come from Claude Code's per-directory configuration or a repo's own `.mcp.json`, and Claude Code resolves those relative to the working directory AgentGrid's server was launched from — not the repo a ticket happens to belong to. Such a row is still listed and still usable, but only while you run AgentGrid from that directory. A connector linked to your Claude account, or a server in Claude Code's own global configuration, has no such condition.

If Claude Code has nothing configured yet, Settings gives you the exact `claude mcp add` command to run, then click **Detect** to pick it up.

**Forge.** Pick **github** or **bitbucket** in Settings' Forge section and press Save.

- **GitHub** uses the `gh` CLI's own auth (`gh auth login`) — nothing else to configure.
- **Bitbucket Cloud** additionally needs your Atlassian account email (the **Forge** section asks for it) and an API token, which is a special case: **it is never entered into Settings or written to any config file.** Export it in the shell AgentGrid is launched from:

  ```bash
  export BITBUCKET_API_TOKEN="<an API token for that Atlassian account>"
  ```

  Create the token from your Atlassian account's API token settings (not a Bitbucket app password — this is the newer, account-level API token). AgentGrid reads it straight from `process.env.BITBUCKET_API_TOKEN` on every call — never logged, never stored, never put in a prompt or an agent's own environment — so rotating it is just exporting a new value.

  The desktop app inherits your **login shell's** environment at the moment it launches, not whatever shell happens to be open in a terminal later. If you export the token after the app is already running (or in a shell the app wasn't launched from), it won't see it — **quit and restart the desktop app** after exporting it, and put the export in a profile file your login shell actually loads (`.zprofile`, `.bash_profile`, etc.), not a one-off `export` in an interactive terminal. Settings' forge-token check tells you plainly whether the server process can currently see it.

  **Bitbucket has no `rebase` merge method.** The merge gate's "rebase" option is a GitHub-only strategy; against Bitbucket it is refused rather than silently substituted with something else (Bitbucket's `fast_forward` strategy moves the base pointer without rewriting commits, which is not the same operation as a rebase merge). Pick squash or merge instead.

**First save vs. later changes.** The very first time you save a working tracker + forge on a machine, the bug-fix workflow comes alive immediately — no restart. Once it's running, changing the configuration (switching forge, re-pointing the tracker) needs a restart to take effect, because the running engine isn't torn down and rebuilt under work that might be in flight; Settings tells you which case you're in right after you save.

**Editing the file directly.** Everything Settings writes lives in one file, `~/.agentgrid/integrations.json`, alongside the project→repo memory the workflow builds up on its own. AgentGrid never writes an MCP server definition or credential into this file — only which one it's using (its name and preset). A file written by 0.4.0 could hold a copied definition under `tracker.mcpServers`; that field is no longer read, is never sent to the browser, and is dropped from the file the next time the tracker itself is saved (a save that touches only the forge leaves it sitting there untouched — delete it by hand if you want it gone sooner). If you prefer to edit it by hand instead of using the dialog, its shape is:

```json
{
  "tracker": { "preset": "jira", "toolPrefix": "mcp__atlassian" },
  "forge": { "preset": "bitbucket", "username": "<your Atlassian account email>" },
  "projectRepos": {}
}
```

For a GitHub forge, `forge` is just `{ "preset": "github" }`. `projectRepos` is AgentGrid's own memory of which repo a project's tickets map to — it fills in as you use the workflow and Settings shows it read-only. **Never put `BITBUCKET_API_TOKEN` or any other secret in this file** — see above.

## Concepts

| Thing | What it is |
|---|---|
| **Role** | A template: persona prompt, model, effort, permission mode, allowed tools, turn/budget caps. `~/.agentgrid/roles/<role>.md`. Seven ship by default: `architect`, `coder`, `reviewer`, `tester`, `devops`, `demo-prep`, `bugfix`. |
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
| `esc` | Close dialog, then deselect (on the bug screen: back to the grid) |
| `↑` / `↓`, `⏎` | Move through / open bugs in the bug screen's list |

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
npm run desktop                   # run the Electron app from source
npm run dist                      # build DMG / AppImage into desktop/release/
npm test                          # unit + integration tests (server + ui + desktop), no API calls
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
