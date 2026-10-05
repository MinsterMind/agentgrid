# Mission Control UI Revamp — Design Spec

**Date:** 2026-10-05
**Status:** Draft — awaiting review
**Ships in:** 0.7.0 (phase 1), 0.8.0 (phase 2), 0.9.0 (phase 3) — each phase is released on its own
**Approved designs (Superdesign canvas):** https://superdesign.dev/teams/f31ee3f6-79d2-4afd-b37b-e9f3e1af5d0d/projects/eeff6cda-2ff1-4007-b03f-2c0226fcd2dd

| Screen | Draft |
|---|---|
| Grid + side panel | `e3e73031-5d4c-4c39-b2c2-63f2e827deda` (Mission Control) |
| Bug screen | `de9ced35-5e7e-4a46-92ec-a04fbf1c89f0` |
| First run / empty grid | `450ec38d-b47a-4ecb-9ac2-865fa985acaa` |
| New agent + Fix a bug dialogs | `e3c62078-4dd0-42fc-8277-b680d5740ff4` |
| Settings | `11a05789-6598-4c70-b172-ef98db5d68d5` |

The design tokens and direction live in `.superdesign/design-system.md` (Direction B). This spec is
what the code must do; the drafts are what it must look like.

## 1. Problem

The UI grew screen by screen: one flat dark stylesheet, a 13px system font, no type scale,
spacing system or motion, and sixteen surfaces that each styled themselves. It works, but it
does not draw anyone in, and much of "what do I do now" is left to hint text and to knowing the
product's vocabulary (role, gate, adopt).

## 2. Goal

The person running AgentGrid — an engineer with several agents going — should feel the app is
alive and on their side, and never need help: every screen says what it is, what state things are
in, and what happens if they press the obvious button.

## 3. Decisions taken

| Question | Decision |
|---|---|
| Who is it for? | Engineers running several agents a day: dense, fast, keyboard-friendly, but crafted and warm. |
| Visual direction | **Mission Control** (chosen over Calm Graphite): deep blue-black surfaces, status colour carries the layout as glows, large mono live counters, shimmer on working agents, amber pulse on whatever needs you. |
| Theme | Dark only, as today. |
| Delivery | Three phases, each a release: foundation + the main screen; the bug screen; first run, dialogs and Settings. |

## 4. UX principles (every screen)

1. **Self-descriptive.** Every section has a title and a one-line plain explanation; every primary
   button says what happens next (in its label or a line beside it). Product terms are explained
   where they appear.
2. **What needs you is the loudest thing.** Needs-you is the only thing that pulses; it is counted
   in the top bar, sorted first, and answerable where it is shown.
3. **Status = icon + word + colour,** never colour alone.
4. **Dense but calm.** Glow and motion belong to state, never to decoration.
5. **Keyboard-first.** Shortcuts shown as `kbd` chips where they apply; visible focus ring (2px cyan)
   on every interactive element.
6. **Empty states teach** and offer the one action that fills them.
7. **Reduced motion is respected:** under `prefers-reduced-motion: reduce`, pulse and shimmer are
   replaced by a static glow.

## 5. Foundation (phase 1)

### 5.1 Tokens

Replace `:root` in `ui/src/styles.css` with Direction B's tokens, exactly as in
`design-system.md`: `--bg #07090C`, `--surface #0E1217`, `--surface-raised #141A21`,
`--grid-line #1C242E`, `--text #E6EDF3`, `--text-muted #8B98A5`, `--text-faint #56616D`,
status `--st-working #22D3EE`, `--st-needs-you #FBBF24`, `--st-done #34D399`,
`--st-failed #F87171`, `--st-idle #56616D`, `--accent #22D3EE`, `--accent-text #04121A`.
Glows are `0 0 0 1px <status>66, 0 0 16px <status>33`. Type scale 11/12/13/14/20/28. Radius 4
controls, 6 inner cards, 8 tiles/panels, 10 dialogs. Motion 120–180ms ease-out; pulse 1.6s
(needs-you only), shimmer 2s (working only).

The old token names (`--panel`, `--line`, `--fg`, `--dim`, `--blue`…) are removed, not aliased: every
rule is moved to the new names in the same change, so nothing keeps the old look by accident.

### 5.2 Fonts and icons — bundled, never fetched

The desktop app runs offline and must not phone a CDN. **Inter** and **JetBrains Mono** come from
`@fontsource/inter` and `@fontsource/jetbrains-mono` (400/500/600), imported once in `main.tsx`.
Icons come from `lucide-react` (the drafts' `lucide:*` names map one to one). No Google Fonts
`@import`, no iconify script.

### 5.3 Core component classes

One set, used everywhere, matching the drafts: `.btn` (28px; `.p` cyan solid, `.d` red outline,
`.g` green outline, `.sm` 22–24px), `.chip` (+ `.cyan .amber .green .red`), `.panel` +
`.panel-title` + `.panel-desc`, `.dialog` + `.dlg-hd/.dlg-body/.dlg-ft` + `.dlg-ic`, `.field`
`.label` `.help` `.input` (`.err` state, with `.errtext/.oktext/.warntext`), `.seg` segmented
control, `kbd`. Emoji-free UI chrome (role avatars stay emoji — they are content).

### 5.4 Top bar

`AGENTGRID` brand · **Agents | Bugs** view switch (replaces the single Bugs/Grid toggle; Bugs
carries an amber count of bugs waiting on you, hidden at 0) · live counters (big mono number, mono
label underneath): WORKING, NEEDS YOU, DONE, FAILED, TODAY ($). NEEDS YOU glows and pulses when
non-zero and cycles to the next agent that needs you on click (today's "need you" pill behaviour).
Zero counters render faint. Actions: Fix a bug, Sessions, Settings (icon + label), primary
**+ New agent**.

### 5.5 Grid

Sections, in this order, each with an icon, an uppercase mono title with count, and a one-line
explanation; empty sections are hidden:

| Section | Explanation |
|---|---|
| NEEDS YOU | Agents waiting for your answer before they can continue. |
| WORKING | Running now. You don't need to watch them. |
| DONE / FAILED | Finished. Read the outcome, then assign more work or dismiss. |
| IDLE | Ready for a new task. |
| RUNNING ELSEWHERE | Claude Code sessions open outside AgentGrid. Pull one in to manage it here. |

`sections.ts` keeps its order and keys; only titles change (`free` → IDLE).

Tile: avatar, name — role, repo (mono), task title (first line of the current assignment's prompt,
2-line clamp), activity line with a status icon, footer with `#index · elapsed` and cost. States:
working = cyan glow + shimmer along the top edge; waiting = amber pulse + **inline request card**
("Wants to run:" + the command in mono, or "Has a question:" + the question) with **Allow** /
**Deny** (or the question's options) answered right on the tile through the same `api.answer` the
side panel uses; done/failed = green/red hairline glow; free = 70% opacity with the assign box.

Running-elsewhere rows keep today's controls (role select + Pull in).

### 5.6 Side panel

Instrument-panel layout from the draft: header (avatar, name, `#index`, role @ repo, Terminal
button), TASK, LIVE TRANSCRIPT (mono), the pending request explained in a sentence above the
mono command, MEMORY, a dashed-top stats row (ELAPSED · TURNS · COST), and actions. Bug card
(`BugPanel`) and terminal tab keep their behaviour, restyled with the new classes.

### 5.7 Footer

Notification toggles as today; key hints as `kbd` chips, per view (grid: 1–9 select, A allow, D
deny, O terminal, Esc; bug screen: ↑↓ move, ⏎ open, Esc back to agents).

## 6. Bug screen (phase 2)

Restyle the existing `BugScreen` to the draft; behaviour and data are unchanged.

- **List:** rows with mono key, title, and status line (icon + WORD · stage label); the selected
  row glows in its status colour.
- **Header:** mono cyan key + title, ticket link, worktree path (mono) with Copy, agent chip, and
  COST / REVIEW ROUNDS as mono counters.
- **Pipeline:** a connected stepper — dots on a line that turns green up to the current step;
  current step pulses amber when waiting on you, cyan when running; each step shows its label and
  state word.
- **Blocking** (amber-edged panel, only glowing when non-empty) and **Now** side by side.
- **Assumptions & questions**, **Plan** (four section cards in a 2×2 grid, file chips, actions with
  the "what approving does" line), **Changes**, **Ticket**, **Timeline** (dot per entry, coloured by
  the stage's outcome) — as panels with mono titles.

## 7. First run, dialogs and Settings (phase 3)

### 7.1 First run (no agents)

Shown on the grid when there are no agents and no bug tasks. Faint 32px grid backdrop with four
ghost tiles demonstrating the state language (shimmer, pulse, done, idle); headline "Run several
Claude Code agents side by side."; one-line lead; three start cards — **New agent**, **Pull in a
running session** (with the live-session count; disabled with "none open right now" at 0), **Fix a
bug** — each with one sentence on what happens. A "Before you start" row shows the existing setup
checks as chips (Tracker, Forge, Bug fixer role) with "Fix it" opening Settings, noting they are
only needed for bug fixes. The side panel shows "How AgentGrid works" in three steps.

Keyboard: `N` new agent, `B` fix a bug, `S` sessions — added globally (not only on first run), and
inert while typing, like today's keys.

### 7.2 New agent dialog

Replaces SpawnDialog's layout; same submit behaviour.
- **Role cards** (3 columns): avatar + name, a one-line description, and `model · effort` in mono.
  Descriptions come from a new optional `description` field in role frontmatter; the seven shipped
  roles get one; a role without it shows the first sentence of its prompt.
- **Repo** field with Browse and recent-repo chips, plus a live status line from a new
  `GET /api/repo-status?path=` → `{ exists, isRepo, branch, clean }`: "Git repo on main · clean",
  "Not a git repo — the agent can still work here", or "Folder not found".
- **First task** (optional): when filled, the agent is created and assigned in one go.
- Footer: "It starts as soon as you create it, and asks you before any risky command."; Create
  agent (⏎).

### 7.3 Fix a bug dialog

Same data and preflight as `BugLauncher`, laid out as three numbered steps (Ticket, Repo, When the
PR is approved) plus a "What happens next" strip (plan → you approve → fix → you review the diff →
PR). Ticket list rows: mono key, title, priority chip; a key input validates format inline
("PAY-123") using the error pattern from the draft. Repo step shows the preflight result in plain
words; preflight additionally returns the redacted `remote` it found, shown as "remote
bitbucket.org/<ws>/<repo>". **"Merge automatically" stays visible but disabled, labelled
"coming later"** — auto-merge is not implemented, and the dialog must not promise it. Start fixing
is disabled until every step is valid, with a tooltip naming what's missing.

### 7.4 Settings

"Integrations" dialog per the draft: an overall banner ("Ready to fix bugs" in green, or "N things
left before you can fix bugs" in amber, with check chips) and a note that agents work without any
of this; then sections Tracker, Forge, Repos, each a two-column row (title + status chip + why on
the left; controls on the right). Behaviour, checks, Test buttons and saved data are unchanged; the
missing-token fix shows its command with Copy.

## 8. Accessibility

All text meets WCAG AA contrast on its surface (the faint `#56616D` only for non-essential
metadata); focus ring on every interactive element; status never by colour alone; reduced-motion
honoured (§4.7); dialogs trap focus and close on Esc as today.

## 9. Testing

- Existing unit and e2e tests keep passing; `data-testid`s and roles are preserved. Tests that
  assert on old class names or old copy are updated to the new copy in the same change.
- New unit tests: section titles/explanations; tile inline request answers via `api.answer` (allow,
  deny, question option); NEEDS YOU counter cycles; Bugs badge counts bugs waiting on you; first
  run shows when empty and its buttons open the right dialogs; `N/B/S` keys; role card description
  fallback; repo-status line for each result; disabled auto-merge; Start fixing tooltip; Settings
  banner states; reduced-motion rule present.
- Server: `GET /api/repo-status` (exists/repo/branch/clean, path outside browse root refused as
  today's browse is); role `description` parsed; preflight returns a redacted `remote`.
- E2E: the bug-fix flow and smoke specs run unchanged in behaviour; one new spec walks first run →
  New agent → the tile appears in WORKING.

## 10. Out of scope

Light theme; redesigning the terminal/transcript views beyond restyling; implementing auto-merge;
new product features beyond the small server additions named above; the Sessions panel layout
(restyled by the foundation only).

## 11. Risks

| Risk | Mitigation |
|---|---|
| Glow and motion become noise with many agents | Only needs-you pulses; working shimmer is a 2px edge; reduced-motion honoured |
| Restyle silently breaks tests that key on classes | Phase 1 updates selectors in the same change; testids and roles preserved |
| Bundled fonts grow the app | Three weights of two families, latin subset only (~300 KB) |
| Inline Allow on a tile is a click away from a risky command | The tile shows the exact command before the button; same `api.answer` path and permission semantics as the side panel; no "always allow" on the tile |
