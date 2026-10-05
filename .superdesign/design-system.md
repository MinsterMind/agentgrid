# AgentGrid — Design System

## Product context
AgentGrid is a desktop app (Electron + React) that runs a roster of Claude Code agents in parallel from one dashboard. Users are engineers who run several agents a day.

Jobs to be done:
- See at a glance which agents are working, which need me, which finished or failed.
- Answer an agent's permission request or question fast, without hunting.
- Give an agent work (assign a prompt), open its terminal, read its transcript.
- Turn a tracked ticket into a merged PR through gated steps (plan → diff → PR → merge) on the Bug screen.
- Pull in Claude Code sessions already running elsewhere.

Key surfaces: Top bar (brand, live counts, Bugs/Grid toggle, Fix a bug, Sessions, Settings, + Spawn) · Agent grid (sections of agent tiles + live-session tiles) · Side panel (selected agent: task, live transcript, pending prompt, memory, actions, terminal) · Bug screen (pipeline, now, blocking, assumptions, actions, timeline) · Dialogs (Spawn, Fix a bug, Settings, Sessions).

## UX principles (apply in every direction)
1. **Self-descriptive.** Every control says what it does; every state says what happens next. No unexplained jargon (role, gate, adopt) without a one-line inline explanation.
2. **The thing that needs you is the loudest thing on screen.** Waiting-on-you states outrank everything else.
3. **Status = icon + word + colour,** never colour alone.
4. **Dense but calm.** Engineers want many agents visible; whitespace is earned, not padded.
5. **Keyboard-first, mouse-friendly.** Visible shortcuts on hover/focus; visible focus rings.
6. **Empty states teach.** An empty area says what will appear and offers the one action that fills it.
7. **Motion explains state change** (an agent starts, finishes, asks) and never decorates idly.
8. Desktop app, 1280–1600px wide typical; dark theme primary.

## Current visual baseline (what exists today)
Dark only. Tokens: `--bg #0f1115` page, `--panel #161a21`, `--line #262a33`, `--fg #e6e8ee`, `--dim #9aa3b2`, `--dim2 #6b7484`, `--blue #3b82f6` working, `--amber #f59e0b` waiting, `--green #22c55e` done, `--red #ef4444` failed, `--grey #4a5262` free. Font 13px system-ui; mono ui-monospace. Radius 6/10/99. Primary button #2563eb.

## Chosen direction: B — Mission Control (selected 2026-10-05)
Direction A is kept below for reference only; all new designs use Direction B.

## Direction A — Calm Graphite (not chosen)
- Mood: Linear / Raycast. Quiet, crafted, precise. Colour only carries status and the single accent.
- Font: **Inter** (400/500/600), tabular numbers; mono **JetBrains Mono** for paths, branches, commands.
- Type scale: 11 / 12 / 13 (body) / 15 / 18 / 24.
- Colours: bg `#0B0C0E`, surface `#121316`, surface-raised `#18191D`, hairline `#232429`, hairline-strong `#2E3036`, text `#EDEEF0`, text-muted `#9A9CA5`, text-faint `#62646C`. Accent **indigo `#6E79F2`** (primary actions, selection, focus ring). Status: working `#5B9BF5`, needs-you `#F2B54A`, done `#4CC38A`, failed `#EF5F5F`, idle `#62646C`.
- Spacing: 4px base, 8px grid. Radius: 6 controls, 10 cards, 14 dialogs, 999 pills.
- Depth: hairline borders + very soft shadow `0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 24px rgba(0,0,0,0.35)` on raised surfaces only.
- Buttons: primary = solid indigo, white text; secondary = surface-raised with hairline; ghost = text only; danger = red text with red-tinted hover. 28px height (compact), 32px default.
- Motion: 150–200ms ease-out; status changes cross-fade; no idle animation except a subtle 2s breathing dot on working agents.

## Direction B — Mission Control
- Mood: watching a fleet at work. Alive, data-forward, status colour carries the layout.
- Font: **Inter** for UI; **JetBrains Mono** for counts, timers, costs, ids, paths and section labels (uppercase, letter-spaced).
- Type scale: 11 / 12 / 13 (body) / 14 / 20 / 28 (big live counters).
- Colours: bg `#07090C`, surface `#0E1217`, surface-raised `#141A21`, grid-line `#1C242E`, text `#E6EDF3`, text-muted `#8B98A5`, text-faint `#56616D`. Status (also used as glows): working **cyan `#22D3EE`**, needs-you **amber `#FBBF24`**, done **green `#34D399`**, failed **red `#F87171`**, idle `#56616D`. Accent for primary actions: cyan `#22D3EE` on dark text `#04121A`.
- Glow: status ring/edge glows `0 0 0 1px <status>66, 0 0 16px <status>33`; needs-you tiles pulse their glow at 1.6s.
- Spacing: 4px base, tight 6/8/12 rhythm; radius 4 controls, 8 tiles, 10 dialogs.
- Live elements: working agents show a thin animated progress shimmer along the tile edge; counters in the top bar are large mono numbers with labels beneath; elapsed timers tick.
- Buttons: primary = cyan solid; secondary = outline grid-line; danger = red outline. 28px compact.
- Motion: 120–180ms; pulse only for needs-you; shimmer only for working.
