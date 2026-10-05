# Mission Control — Phase 1 (0.7.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Mission Control foundation (tokens, bundled fonts/icons, core classes) and the main screen — top bar, grid, tiles, side panel, footer — as 0.7.0.

**Architecture:** One stylesheet keeps being the whole design system: its `:root` is replaced by Direction B's tokens and every rule is moved to them (a test forbids the old names and the old hard-coded palette). Fonts and icons come from npm packages (`@fontsource/*`, `lucide-react`), never a CDN. Component changes are local: `TopBar` gains live counters and an Agents|Bugs switch, `sections.ts` gains plain explanations, `AgentTile` answers a pending request inline through the same `api.answer` path the side panel uses, `PendingPrompt` describes the request in a sentence.

**Tech Stack:** React 19 + Vite, vanilla CSS, vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-mission-control-ui-design.md` (§4, §5). Visual reference: Superdesign draft `e3e73031-5d4c-4c39-b2c2-63f2e827deda`; tokens in `.superdesign/design-system.md` (Direction B).

## Global Constraints

- Tokens, verbatim: `--bg #07090C`, `--surface #0E1217`, `--surface-raised #141A21`, `--grid-line #1C242E`, `--text #E6EDF3`, `--text-muted #8B98A5`, `--text-faint #56616D`, `--st-working #22D3EE`, `--st-needs-you #FBBF24`, `--st-done #34D399`, `--st-failed #F87171`, `--st-idle #56616D`, `--accent #22D3EE`, `--accent-text #04121A`.
- Glow: `0 0 0 1px <status>66, 0 0 16px <status>33`. Pulse 1.6s for needs-you only; shimmer 2s for working only. Radius 4 controls · 6 inner cards · 8 tiles/panels · 10 dialogs.
- Fonts: Inter 400/500/600 UI; JetBrains Mono 400/500/600 for numbers, labels, ids, paths. Bundled via `@fontsource/inter` and `@fontsource/jetbrains-mono`. No Google Fonts, no iconify.
- Icons: `lucide-react` only.
- Under `prefers-reduced-motion: reduce`, no pulse and no shimmer (static glow).
- Status is always icon + word + colour.
- Old token names `--panel --line --fg --dim --dim2 --blue --amber --green --red --grey` are removed, not aliased.
- Keep every existing `data-testid`. `.tile.selected` stays (e2e uses it).
- The tile never offers "Always allow"; it shows the exact command before Allow.
- New dependencies allowed: `@fontsource/inter`, `@fontsource/jetbrains-mono`, `lucide-react`. Nothing else.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019vk3Y8Lj3YYsuDjzfQ2MBB
  ```

## Review Focus

1. **A pending request arrives while the user is typing in another tile's assign box** — answering inline must not steal focus or submit the box; clicks on the inline card must not select the tile underneath. Pinned in Task 4 (stopPropagation test).
2. **A waiting agent whose assignment has no `pending` yet** (activity-derived waiting from an embedded terminal) — the tile must not render empty Allow/Deny buttons; it says the agent is waiting and points to the side panel. Pinned in Task 4.
3. **A multi-question or multi-select AskUserQuestion** — buttons on a small tile cannot express it; the tile must route to the side panel instead of answering partially. Pinned in Task 4.
4. **The NEEDS YOU counter at zero** — must not pulse or be clickable. Pinned in Task 2.
5. **The server disconnects** — the top bar must say so in words, not only by colour. Pinned in Task 2.

---

### Task 1: Foundation — tokens, fonts, icons, core classes

**Files:**
- Modify: `ui/package.json` (deps), `ui/src/main.tsx` (font imports), `ui/src/styles.css` (tokens, rename, core classes, motion)
- Create: `ui/test/styles.test.ts`

**Interfaces:**
- Produces: CSS custom properties per Global Constraints; classes `.btn` (+`.p .d .g .sm .on`), `.chip` (+`.cyan .amber .green .red`), `.panel .panel-title .panel-desc`, `kbd`, `.mono`, keyframes `pulse-amber`, `pulse-glow`, `shimmer`; reduced-motion block.

- [ ] **Step 1: Write the failing test**

`ui/test/styles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const css = readFileSync(path.resolve(__dirname, "../src/styles.css"), "utf8");
const main = readFileSync(path.resolve(__dirname, "../src/main.tsx"), "utf8");

describe("Mission Control tokens", () => {
  it.each([
    ["--bg", "#07090C"], ["--surface", "#0E1217"], ["--surface-raised", "#141A21"], ["--grid-line", "#1C242E"],
    ["--text", "#E6EDF3"], ["--text-muted", "#8B98A5"], ["--text-faint", "#56616D"],
    ["--st-working", "#22D3EE"], ["--st-needs-you", "#FBBF24"], ["--st-done", "#34D399"], ["--st-failed", "#F87171"],
    ["--st-idle", "#56616D"], ["--accent", "#22D3EE"], ["--accent-text", "#04121A"],
  ])("defines %s as %s", (name, value) => {
    expect(css).toMatch(new RegExp(`${name}:\\s*${value}`, "i"));
  });

  it("removes every old token name, with no aliases", () => {
    for (const old of ["--panel", "--line", "--fg", "--dim2", "--dim", "--blue", "--amber", "--green", "--red", "--grey"]) {
      expect(css).not.toMatch(new RegExp(`var\\(${old}\\)|${old}:`));
    }
  });

  it("no longer hard-codes the old palette", () => {
    for (const hex of ["#0f1115", "#161a21", "#1b1f27", "#2b3140", "#262a33", "#6b8cff", "#2563eb", "#12151b"]) {
      expect(css.toLowerCase()).not.toContain(hex);
    }
  });

  it("uses bundled fonts, never a CDN", () => {
    expect(main).toContain('@fontsource/inter');
    expect(main).toContain('@fontsource/jetbrains-mono');
    expect(css).not.toMatch(/fonts\.googleapis|iconify/);
    expect(css).toMatch(/font-family:\s*["']?Inter/);
  });

  it("turns off pulse and shimmer for reduced motion", () => {
    const block = css.slice(css.indexOf("prefers-reduced-motion"));
    expect(block).toMatch(/animation:\s*none/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run test/styles.test.ts`
Expected: FAIL — tokens missing, old names present, fonts not imported.

- [ ] **Step 3: Install packages**

Run: `npm install -w ui @fontsource/inter@^5 @fontsource/jetbrains-mono@^5 lucide-react@latest`
Expected: three entries added to `ui/package.json` dependencies.

- [ ] **Step 4: Import fonts**

`ui/src/main.tsx` becomes:

```tsx
import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 5: Replace the tokens and move every rule to them**

Replace lines 1–4 of `ui/src/styles.css` (`:root`, `*`, `body`) with:

```css
:root { color-scheme: dark;
  --bg:#07090C; --surface:#0E1217; --surface-raised:#141A21; --grid-line:#1C242E;
  --text:#E6EDF3; --text-muted:#8B98A5; --text-faint:#56616D;
  --st-working:#22D3EE; --st-needs-you:#FBBF24; --st-done:#34D399; --st-failed:#F87171; --st-idle:#56616D;
  --accent:#22D3EE; --accent-text:#04121A;
  --mono: "JetBrains Mono", ui-monospace, monospace;
  --glow-working: 0 0 0 1px #22D3EE66, 0 0 16px #22D3EE33;
  --glow-needs-you: 0 0 0 1px #FBBF2466, 0 0 16px #FBBF2433;
  --glow-done: 0 0 0 1px #34D39966; --glow-failed: 0 0 0 1px #F8717166; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font: 13px/1.4 "Inter", -apple-system, system-ui, sans-serif; }
```

Then run this rename over the rest of the file (script, so nothing is missed):

```bash
cd ui && python3 - <<'EOF'
import re
p='src/styles.css'; s=open(p).read()
head, rest = s.split("body {",1)[0], "body {"+s.split("body {",1)[1]
names = [("--dim2","--text-faint"),("--panel","--surface"),("--line","--grid-line"),("--fg","--text"),("--dim","--text-muted"),
         ("--blue","--st-working"),("--amber","--st-needs-you"),("--green","--st-done"),("--red","--st-failed"),("--grey","--st-idle")]
for old,new in names: rest = re.sub(r"var\("+re.escape(old)+r"\)", f"var({new})", rest)
hexes = {"#0f1115":"var(--bg)","#0b0d11":"var(--bg)","#161a21":"var(--surface)","#12151b":"var(--surface)","#1b1f27":"var(--surface-raised)",
         "#232833":"var(--surface-raised)","#2b3140":"var(--grid-line)","#262a33":"var(--grid-line)","#1f2937":"var(--grid-line)",
         "#6b8cff":"var(--accent)","#2563eb":"var(--accent)","#93b4ff":"var(--accent)","#9ab4ff":"var(--accent)","#7dd3fc":"var(--accent)"}
for h,v in hexes.items(): rest = re.sub(re.escape(h), v, rest, flags=re.I)
rest = rest.replace("ui-monospace, SFMono-Regular, Menlo, monospace", "var(--mono)").replace("ui-monospace, monospace", "var(--mono)")
open(p,'w').write(head + rest)
EOF
```

(`--dim2` is replaced before `--dim` so it isn't half-matched.)

- [ ] **Step 6: Core classes and motion**

Replace the `.btn` rules (the three lines starting `.btn {`, `.btn.p`, `.btn.on`) and the `.btn.sm` and `.chip` lines with, and append the motion block at the end of the file:

```css
.btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; font:inherit; font-size:12px; font-weight:500; height:28px; padding:0 12px; border-radius:4px; border:1px solid var(--grid-line); background:transparent; color:var(--text); cursor:pointer; transition:background 150ms ease-out, border-color 150ms ease-out; }
.btn:hover { background:var(--surface-raised); }
.btn.p { background:var(--accent); border-color:var(--accent); color:var(--accent-text); font-weight:600; } .btn.p:hover { background:#67E8F9; border-color:#67E8F9; }
.btn.d { border-color:var(--st-failed); color:var(--st-failed); } .btn.d:hover { background:rgba(248,113,113,.1); }
.btn.g { border-color:var(--st-done); color:var(--st-done); } .btn.g:hover { background:rgba(52,211,153,.1); }
.btn.on { background:var(--surface-raised); border-color:var(--accent); color:var(--accent); }
.btn:disabled { opacity:.45; cursor:default; } .btn.sm { height:24px; padding:0 8px; font-size:11px; }
.chip { display:inline-flex; align-items:center; gap:4px; font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.5px; padding:2px 7px; border-radius:4px; border:1px solid var(--grid-line); color:var(--text-muted); white-space:nowrap; }
.chip.cyan { color:var(--st-working); border-color:#22D3EE55; background:rgba(34,211,238,.06); }
.chip.amber { color:var(--st-needs-you); border-color:#FBBF2455; background:rgba(251,191,36,.06); }
.chip.green { color:var(--st-done); border-color:#34D39955; background:rgba(52,211,153,.06); }
.chip.red { color:var(--st-failed); border-color:#F8717155; background:rgba(248,113,113,.06); }
.mono { font-family:var(--mono); }
.panel { background:var(--surface); border:1px solid var(--grid-line); border-radius:8px; padding:14px 16px; }
.panel-title { font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-muted); display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.panel-desc { font-size:12px; color:var(--text-faint); margin:-4px 0 12px; }
kbd { font-family:var(--mono); font-size:10px; background:var(--surface-raised); border:1px solid var(--grid-line); border-radius:3px; padding:1px 5px; color:var(--text); }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
svg.lucide { width:14px; height:14px; flex:none; }
```

Append:

```css
@keyframes pulse-amber { 0%,100% { box-shadow:0 0 0 1px #FBBF2466, 0 0 8px #FBBF2422; } 50% { box-shadow:0 0 0 1px #FBBF24aa, 0 0 20px #FBBF2466; } }
@keyframes pulse-glow { 0%,100% { box-shadow:0 0 0 1px #FBBF2466, 0 0 12px #FBBF2433; } 50% { box-shadow:0 0 0 1px #FBBF24aa, 0 0 24px #FBBF2466; } }
@keyframes shimmer { 0% { transform:translateX(-100%); } 100% { transform:translateX(100%); } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation:none !important; transition:none !important; }
}
```

- [ ] **Step 7: Run tests**

Run: `cd ui && npx vitest run test/styles.test.ts && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: styles test PASS; whole suite PASS (no component changed yet). If the hex test still finds an old colour, map it in Step 5's table to the nearest token and re-run.

- [ ] **Step 8: Commit**

```bash
git add ui/package.json package-lock.json ui/src/main.tsx ui/src/styles.css ui/test/styles.test.ts
git commit -m "feat(ui): Mission Control foundation — tokens, bundled Inter/JetBrains Mono, lucide, core classes"
```

---

### Task 2: Top bar — live counters and the Agents | Bugs switch

**Files:**
- Modify: `ui/src/components/TopBar.tsx`, `ui/src/App.tsx` (props), `ui/src/styles.css` (top bar block)
- Create: `ui/test/TopBar.test.tsx`
- Modify: `ui/test/App.test.tsx`, `ui/e2e/smoke.spec.ts`, `ui/e2e/bugfix.spec.ts` (labels)

**Interfaces:**
- Consumes: `counts(s)`, `todaySpend(s)`, `waitingIds(s)` from `state/reducer`; `listStatus` from `bugView`; `usd` from `format`.
- Produces: `TopBar({ counts, spend, connected, waitingCount, bugsWaiting, view, onView, onCycleWaiting, onSpawn, onSessions, onFixBug, onOpenSettings })` with `view: "grid" | "bugs"`, `onView: (v: "grid" | "bugs") => void`, `bugsWaiting: number`. Buttons' accessible names: `Agents`, `Bugs` (badge carries `aria-label="<n> waiting"`), `Fix a bug`, `Sessions`, `Settings`, `New agent`; NEEDS YOU counter is a button named `<n> need you`.

- [ ] **Step 1: Write the failing tests**

`ui/test/TopBar.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopBar } from "../src/components/TopBar";

const counts = { free: 1, working: 2, waiting: 1, done: 1, failed: 1 };
const props = (over = {}) => ({ counts, spend: 4.12, connected: true, waitingCount: 1, bugsWaiting: 1, view: "grid" as const,
  onView: vi.fn(), onCycleWaiting: vi.fn(), onSpawn: vi.fn(), onSessions: vi.fn(), onFixBug: vi.fn(), onOpenSettings: vi.fn(), ...over });

describe("TopBar", () => {
  it("shows live counters as numbers with labels", () => {
    render(<TopBar {...props()} />);
    for (const [label, n] of [["Working", "2"], ["Done", "1"], ["Failed", "1"], ["Today", "$4.12"]]) {
      expect(screen.getByText(label).closest(".counter")).toHaveTextContent(n);
    }
  });

  it("NEEDS YOU is a glowing button that cycles to the next agent", async () => {
    const p = props();
    render(<TopBar {...p} />);
    const needs = screen.getByRole("button", { name: /1 need you/i });
    expect(needs).toHaveClass("hot");
    await userEvent.click(needs);
    expect(p.onCycleWaiting).toHaveBeenCalled();
  });

  // Review Focus 4
  it("NEEDS YOU at zero neither glows nor clicks", () => {
    render(<TopBar {...props({ waitingCount: 0 })} />);
    const needs = screen.getByRole("button", { name: /0 need you/i });
    expect(needs).not.toHaveClass("hot");
    expect(needs).toBeDisabled();
  });

  it("switches views with Agents | Bugs, marking the current one", async () => {
    const p = props();
    render(<TopBar {...p} />);
    expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /^Bugs/ }));
    expect(p.onView).toHaveBeenCalledWith("bugs");
  });

  it("badges Bugs with how many wait on you, and hides the badge at zero", () => {
    const { rerender } = render(<TopBar {...props()} />);
    expect(screen.getByLabelText("1 waiting")).toBeInTheDocument();
    rerender(<TopBar {...props({ bugsWaiting: 0 })} />);
    expect(screen.queryByLabelText(/waiting/)).toBeNull();
  });

  it("names every action in words", () => {
    render(<TopBar {...props()} />);
    for (const name of ["Fix a bug", "Sessions", "Settings", "New agent"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });

  // Review Focus 5
  it("says when the server is disconnected", () => {
    render(<TopBar {...props({ connected: false })} />);
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });
});
```

In `ui/test/App.test.tsx`: replace `name: /\+ Spawn/i` with `name: "New agent"`; replace every `name: "Grid"` with `name: "Agents"`; replace `name: "Bugs"` with `name: /^Bugs/`.

In `ui/e2e/smoke.spec.ts`: replace `{ name: "+ Spawn" }` with `{ name: "New agent" }` (both places). In `ui/e2e/bugfix.spec.ts`: replace `{ name: "🐞 Fix a bug" }` with `{ name: "Fix a bug" }` and `{ name: "Grid" }` with `{ name: "Agents" }`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run test/TopBar.test.tsx test/App.test.tsx`
Expected: FAIL — no counters, no Agents button, no "New agent".

- [ ] **Step 3: Implement `TopBar`**

`ui/src/components/TopBar.tsx`:

```tsx
import { Bug, GitPullRequestArrow, LayoutGrid, Plus, Settings, TerminalSquare, WifiOff } from "lucide-react";
import type { AgentState } from "../types";
import { usd } from "../format";

function Counter({ n, label, cls }: { n: string | number; label: string; cls: string }) {
  return <div className={`counter ${cls} ${n === 0 ? "zero" : ""}`}><span className="num">{n}</span><span className="lbl">{label}</span></div>;
}

/** The live header: what is happening across every agent, in numbers that read at a glance, and
 *  the one control that matters most — NEEDS YOU — glowing only while something actually waits. */
export function TopBar({ counts, spend, connected, waitingCount, bugsWaiting, view, onView, onCycleWaiting, onSpawn, onSessions, onFixBug, onOpenSettings }: {
  counts: Record<AgentState, number>; spend: number; connected: boolean; waitingCount: number; bugsWaiting: number;
  view: "grid" | "bugs"; onView: (v: "grid" | "bugs") => void;
  onCycleWaiting: () => void; onSpawn: () => void; onSessions: () => void; onFixBug: () => void; onOpenSettings: () => void;
}) {
  return (
    <header className="topbar">
      <span className="brand">AGENTGRID</span>
      <nav className="views" aria-label="Views">
        <button className={`btn ${view === "grid" ? "on" : ""}`} aria-pressed={view === "grid"} onClick={() => onView("grid")}><LayoutGrid /> Agents</button>
        <button className={`btn ${view === "bugs" ? "on" : ""}`} aria-pressed={view === "bugs"} onClick={() => onView("bugs")}>
          <GitPullRequestArrow /> Bugs{bugsWaiting > 0 && <span className="chip amber badge-n" aria-label={`${bugsWaiting} waiting`}>{bugsWaiting}</span>}
        </button>
      </nav>
      <div className="counters">
        <Counter n={counts.working} label="Working" cls="c-working" />
        <button className={`counter c-needs-you ${waitingCount ? "hot" : "zero"}`} disabled={!waitingCount} onClick={onCycleWaiting}
          aria-label={`${waitingCount} need you`} title={waitingCount ? "Jump to the next agent that needs you" : "Nothing needs you"}>
          <span className="num">{waitingCount}</span><span className="lbl">Needs you</span>
        </button>
        <Counter n={counts.done} label="Done" cls="c-done" />
        <Counter n={counts.failed} label="Failed" cls="c-failed" />
        <Counter n={usd(spend)} label="Today" cls="c-cost" />
        {!connected && <span className="chip red"><WifiOff /> Disconnected</span>}
      </div>
      <div className="actions">
        <button className="btn" onClick={onFixBug}><Bug /> Fix a bug</button>
        <button className="btn" onClick={onSessions}><TerminalSquare /> Sessions</button>
        <button className="btn" onClick={onOpenSettings}><Settings /> Settings</button>
        <button className="btn p" onClick={onSpawn}><Plus /> New agent</button>
      </div>
    </header>
  );
}
```

In `App.tsx`, import `listStatus` from `./bugView` and replace the `<TopBar … />` element with:

```tsx
      <TopBar counts={counts(s)} spend={todaySpend(s)} connected={s.connected} waitingCount={waitingIds(s).length}
        bugsWaiting={Object.values(s.bugTasks).filter(t => listStatus(t, false) === "waiting").length}
        view={route.view} onView={v => route.go(v === "bugs" ? { view: "bugs" } : { view: "grid" })}
        onCycleWaiting={cycleWaiting} onSpawn={() => setSpawnOpen(true)} onSessions={() => setSessionsOpen(true)}
        onFixBug={() => setBugOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
```

In `styles.css`, replace the `.topbar`, `.brand`, `.sum`, `.pill…` and `button.pill:disabled` rules with:

```css
.topbar { display:flex; align-items:center; gap:20px; padding:10px 16px; border-bottom:1px solid var(--grid-line); background:var(--surface); flex-shrink:0; }
.brand { font-weight:600; font-size:14px; letter-spacing:.5px; }
.views { display:flex; gap:6px; } .badge-n { padding:0 5px; margin-left:2px; }
.counters { display:flex; gap:14px; margin-left:auto; align-items:center; }
.counter { display:flex; flex-direction:column; align-items:center; min-width:58px; background:none; border:0; color:inherit; font:inherit; padding:4px 8px; border-radius:6px; }
.counter .num { font-family:var(--mono); font-size:20px; font-weight:600; line-height:1; }
.counter .lbl { font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.5px; margin-top:4px; color:var(--text-muted); }
.counter.zero .num { color:var(--text-faint); }
.c-working .num { color:var(--st-working); } .c-done .num { color:var(--st-done); } .c-failed .num { color:var(--st-failed); }
.counter.c-needs-you.hot { cursor:pointer; background:rgba(251,191,36,.05); box-shadow:var(--glow-needs-you); animation:pulse-amber 1.6s infinite; }
.counter.c-needs-you.hot .num, .counter.c-needs-you.hot .lbl { color:var(--st-needs-you); }
.counter.c-needs-you:disabled { cursor:default; }
.topbar .actions { display:flex; gap:8px; }
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/TopBar.tsx ui/src/App.tsx ui/src/styles.css ui/test/TopBar.test.tsx ui/test/App.test.tsx ui/e2e/smoke.spec.ts ui/e2e/bugfix.spec.ts
git commit -m "feat(ui): a live top bar — counters, NEEDS YOU that glows only when it means it, Agents | Bugs"
```

---

### Task 3: Grid sections that explain themselves

**Files:**
- Modify: `ui/src/state/sections.ts`, `ui/src/components/AgentGrid.tsx`, `ui/src/styles.css` (section + grid block)
- Modify: `ui/test/sections.test.ts`
- Create: `ui/test/AgentGrid.test.tsx`

**Interfaces:**
- Produces: `Section { key; title; hint; agents }`; titles `Needs you | Working | Done / Failed | Idle`; live section title `Running elsewhere`.

- [ ] **Step 1: Write the failing tests**

In `ui/test/sections.test.ts`, replace the expected titles with `["Needs you", …], ["Working", …], ["Done / Failed", …], ["Idle", …]` and add:

```ts
  it("explains every section in one plain line", () => {
    const s = sectionize([ag("a", "free", "1"), ag("b", "waiting", "2"), ag("c", "done", "3"), ag("d", "working", "4")]);
    expect(Object.fromEntries(s.map(x => [x.key, x.hint]))).toEqual({
      waiting: "Agents waiting for your answer before they can continue.",
      working: "Running now. You don't need to watch them.",
      finished: "Finished. Read the outcome, then assign more work or dismiss.",
      free: "Ready for a new task.",
    });
  });
```

`ui/test/AgentGrid.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AgentGrid } from "../src/components/AgentGrid";
import type { Agent, SessionInfo } from "../src/types";

const ag = (id: string, state: Agent["state"]): Agent => ({ id, role: "coder", repo: "/r/x", displayName: id, createdAt: id, state, currentAssignmentId: null });
const base = { roles: [], assignments: {}, selectedId: null, recentFor: () => [], onSelect: vi.fn(), onAssign: vi.fn() };

describe("AgentGrid", () => {
  it("titles each section with its count and explanation", () => {
    render(<AgentGrid {...base} agents={[ag("a", "working"), ag("b", "working")]} />);
    const sec = screen.getByTestId("section-working");
    expect(within(sec).getByRole("heading")).toHaveTextContent(/Working\s*2/);
    expect(sec).toHaveTextContent("Running now. You don't need to watch them.");
  });

  it("explains running-elsewhere sessions", () => {
    const live: SessionInfo = { sessionId: "s1", cwd: "/w/api", title: "zsh", kind: "interactive", status: "busy", at: Date.now() } as SessionInfo;
    render(<AgentGrid {...base} agents={[]} liveSessions={[live]} />);
    const sec = screen.getByTestId("section-live");
    expect(within(sec).getByRole("heading")).toHaveTextContent(/Running elsewhere\s*1/);
    expect(sec).toHaveTextContent("Claude Code sessions open outside AgentGrid. Pull one in to manage it here.");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run test/sections.test.ts test/AgentGrid.test.tsx`
Expected: FAIL — old titles, no hint.

- [ ] **Step 3: Implement**

`ui/src/state/sections.ts`:

```ts
import type { Agent } from "../types";

export type SectionKey = "waiting" | "working" | "finished" | "free";
export interface Section { key: SectionKey; title: string; hint: string; agents: Agent[] }

const TITLES: Record<SectionKey, string> = { waiting: "Needs you", working: "Working", finished: "Done / Failed", free: "Idle" };
/** One plain line per section, so a first-time user knows what they are looking at and what to do. */
const HINTS: Record<SectionKey, string> = {
  waiting: "Agents waiting for your answer before they can continue.",
  working: "Running now. You don't need to watch them.",
  finished: "Finished. Read the outcome, then assign more work or dismiss.",
  free: "Ready for a new task.",
};
const keyOf = (a: Agent): SectionKey => a.state === "waiting" ? "waiting" : a.state === "working" ? "working" : a.state === "free" ? "free" : "finished";

/** Partition agents by attention priority; order inside a section is creation order. Empty sections are dropped. */
export function sectionize(agents: Agent[]): Section[] {
  const order: SectionKey[] = ["waiting", "working", "finished", "free"];
  return order.map(key => ({ key, title: TITLES[key], hint: HINTS[key], agents: agents.filter(a => keyOf(a) === key) })).filter(s => s.agents.length > 0);
}

/** Agents in on-screen order (section by section) — what the 1–9 keys index. */
export const visualOrder = (agents: Agent[]): Agent[] => sectionize(agents).flatMap(s => s.agents);
```

In `AgentGrid.tsx`: import `{ Activity, CheckCircle2, Hand, Moon, RadioReceiver }` from `lucide-react`; add `const ICON = { waiting: Hand, working: Activity, finished: CheckCircle2, free: Moon };`; replace each section's `<h3 className="sect">…</h3>` with

```tsx
          <div className="sect-head">
            <h3 className={`sect ${sec.key}`}>{(() => { const I = ICON[sec.key]; return <I />; })()} {sec.title} <span className="count">{sec.agents.length}</span></h3>
            <p className="sect-desc">{sec.hint}</p>
          </div>
```

and the live section's heading with

```tsx
          <div className="sect-head">
            <h3 className="sect live"><RadioReceiver /> Running elsewhere <span className="count">{liveSessions.length}</span></h3>
            <p className="sect-desc">Claude Code sessions open outside AgentGrid. Pull one in to manage it here.</p>
          </div>
```

In `styles.css`, replace the `.section`, `.section.waiting…`, `.sect`, `.sect .count`, `.sect .sub`, `.grid` and `.board` rules with:

```css
.board { overflow:auto; display:flex; flex-direction:column; gap:18px; padding-right:4px; }
.grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:12px; align-content:start; }
.section { display:flex; flex-direction:column; gap:8px; }
.sect-head { display:flex; flex-direction:column; gap:2px; }
.sect { margin:0; font-family:var(--mono); font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:.6px; color:var(--text-muted); display:flex; align-items:center; gap:8px; }
.sect.waiting { color:var(--st-needs-you); } .sect.working { color:var(--st-working); }
.sect .count { font-family:var(--mono); color:var(--text-faint); } .sect .count::before { content:"["; } .sect .count::after { content:"]"; }
.sect-desc { margin:0; font-size:12px; color:var(--text-faint); }
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/state/sections.ts ui/src/components/AgentGrid.tsx ui/src/styles.css ui/test/sections.test.ts ui/test/AgentGrid.test.tsx
git commit -m "feat(ui): grid sections say what they hold and what to do"
```

---

### Task 4: Tiles — status in words, glow, and answering right on the tile

**Files:**
- Modify: `ui/src/components/AgentTile.tsx`, `ui/src/components/AgentGrid.tsx` (pass `onDecide`), `ui/src/App.tsx` (pass `decide`), `ui/src/components/PendingPrompt.tsx` (export `summarise`, add `describeRequest`), `ui/src/styles.css` (tile block)
- Modify: `ui/test/AgentTile.test.tsx`

**Interfaces:**
- Consumes: `Decision`, `Pending` types; App's existing `decide(agentId, toolUseId, d)`.
- Produces: `AgentTile` prop `onDecide?: (agentId: string, toolUseId: string, d: Decision) => void`; `AgentGrid` prop `onDecide?` (same); `PendingPrompt.tsx` exports `summarise(input): string` and `describeRequest(toolName: string): string` (`Bash` → `"wants to run a shell command"`, `Edit|Write|MultiEdit|NotebookEdit` → `"wants to change a file"`, `WebFetch|WebSearch` → `"wants to look something up online"`, else `` `wants to use ${toolName}` ``).

- [ ] **Step 1: Write the failing tests**

In `ui/test/AgentTile.test.tsx`, replace the test `"waiting shows a badge with the pending kind"` with the block below, and in `"done shows outcome; failed shows error"` drop any assertion on the ✅/❌ emoji (keep the text assertions):

```tsx
  const permission = { kind: "permission" as const, toolUseId: "tu1", toolName: "Bash", input: { command: "kubectl rollout restart deploy/api" }, suggestions: [{}] };
  const oneQuestion = { kind: "question" as const, toolUseId: "tu2", toolName: "AskUserQuestion" as const, suggestions: [],
    input: { questions: [{ question: "Which env?", header: "Env", options: [{ label: "staging", description: "" }, { label: "prod", description: "" }] }] } };

  it("names every state in words", () => {
    for (const [state, word] of [["working", "Working"], ["waiting", "Needs you"], ["done", "Done"], ["failed", "Failed"], ["free", "Idle"]] as const) {
      const { unmount } = render(<AgentTile {...base} agent={agent(state, state === "free" ? null : "a41")} assignment={state === "free" ? null : asg({ state: state === "waiting" ? "waiting" : state })} />);
      expect(screen.getByTestId("tile-state")).toHaveTextContent(word);
      unmount();
    }
  });

  it("shows the exact command and answers Allow / Deny right on the tile", async () => {
    const onDecide = vi.fn(); const onSelect = vi.fn();
    render(<AgentTile {...base} onSelect={onSelect} onDecide={onDecide} agent={agent("waiting")} assignment={asg({ state: "waiting", pending: permission })} />);
    const card = screen.getByTestId("tile-request");
    expect(card).toHaveTextContent("Wants to run a shell command");
    expect(card).toHaveTextContent("kubectl rollout restart deploy/api");
    await userEvent.click(within(card).getByRole("button", { name: "Allow" }));
    expect(onDecide).toHaveBeenCalledWith("devops@hrns", "tu1", { kind: "allow" });
    await userEvent.click(within(card).getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("devops@hrns", "tu1", { kind: "deny" });
    expect(onSelect).not.toHaveBeenCalled();                          // Review Focus 1: the tile underneath is not selected
    expect(within(card).queryByRole("button", { name: /always/i })).toBeNull();
  });

  it("answers a single one-choice question with its options", async () => {
    const onDecide = vi.fn();
    render(<AgentTile {...base} onDecide={onDecide} agent={agent("waiting")} assignment={asg({ state: "waiting", pending: oneQuestion })} />);
    const card = screen.getByTestId("tile-request");
    expect(card).toHaveTextContent("Which env?");
    await userEvent.click(within(card).getByRole("button", { name: "staging" }));
    expect(onDecide).toHaveBeenCalledWith("devops@hrns", "tu2", { kind: "answers", answers: { "Which env?": "staging" } });
  });

  // Review Focus 3
  it("sends a multi-part question to the side panel instead of answering half of it", async () => {
    const onSelect = vi.fn();
    const multi = { ...oneQuestion, input: { questions: [oneQuestion.input.questions[0], { question: "Region?", header: "Region", options: [{ label: "eu", description: "" }] }] } };
    render(<AgentTile {...base} onSelect={onSelect} onDecide={vi.fn()} agent={agent("waiting")} assignment={asg({ state: "waiting", pending: multi })} />);
    const card = screen.getByTestId("tile-request");
    expect(within(card).queryByRole("button", { name: "staging" })).toBeNull();
    await userEvent.click(within(card).getByRole("button", { name: /answer in the side panel/i }));
    expect(onSelect).toHaveBeenCalledWith("devops@hrns");
  });

  // Review Focus 2
  it("waiting with nothing pending yet says so, with no empty buttons", () => {
    render(<AgentTile {...base} onDecide={vi.fn()} agent={agent("waiting")} assignment={asg({ state: "waiting", pending: null })} />);
    expect(screen.getByTestId("tile-request")).toHaveTextContent(/waiting for you/i);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
```

(Add `within` to the Testing Library import.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run test/AgentTile.test.tsx`
Expected: FAIL — no `tile-state`, no `tile-request`.

- [ ] **Step 3: Implement**

In `PendingPrompt.tsx`, change `function summarise` to `export function summarise` and add:

```tsx
/** A pending tool request in plain words — what the agent wants to do, not which API it calls. */
export function describeRequest(toolName: string): string {
  if (toolName === "Bash") return "wants to run a shell command";
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName)) return "wants to change a file";
  if (toolName === "WebFetch" || toolName === "WebSearch") return "wants to look something up online";
  return `wants to use ${toolName}`;
}
```

`AgentTile.tsx` — replace the component with:

```tsx
import { Activity, CheckCircle2, Hand, Moon, XCircle } from "lucide-react";
import type { Agent, Assignment, Decision, RoleDef, SessionInfo, SessionActivity } from "../types";
import { AssignBox } from "./AssignBox";
import { describeRequest, summarise } from "./PendingPrompt";
import { basename, elapsed, usd } from "../format";

export interface AgentTileProps {
  agent: Agent; role: RoleDef | undefined; assignment: Assignment | null; selected: boolean; index: number; recent?: string[];
  onSelect: (id: string) => void; onAssign: (id: string, prompt: string) => void;
  /** Answer the agent's pending request from the tile — the same path the side panel uses. */
  onDecide?: (agentId: string, toolUseId: string, d: Decision) => void;
  /** Set when the adopted session's process is currently running outside the grid. */ live?: SessionInfo | null;
  /** Transcript-derived activity (embedded terminal work shows up here). */ activity?: SessionActivity | null;
  /** Stage of this agent's in-flight bug-fix task, if any. */ bugStage?: string;
}

const STATE = {
  working: { Icon: Activity, word: "Working" }, waiting: { Icon: Hand, word: "Needs you" },
  done: { Icon: CheckCircle2, word: "Done" }, failed: { Icon: XCircle, word: "Failed" }, free: { Icon: Moon, word: "Idle" },
} as const;

interface Q { question: string; multiSelect?: boolean; options: Array<{ label: string }> }

/** The request card on a waiting tile. It answers only what fits on a card: one permission, or
 *  one single-choice question. Anything bigger goes to the side panel rather than half-answered. */
function TileRequest({ agent, a, onDecide, onSelect }: { agent: Agent; a: Assignment | null; onDecide?: AgentTileProps["onDecide"]; onSelect: (id: string) => void }) {
  const p = a?.pending;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  if (!p || !onDecide) {
    return <div className="tile-req" data-testid="tile-request" onClick={stop}>Waiting for you — open it to see what it needs.</div>;
  }
  if (p.kind === "permission") {
    const say = describeRequest(p.toolName);
    return (
      <div className="tile-req" data-testid="tile-request" onClick={stop}>
        <div className="msg">{say[0].toUpperCase() + say.slice(1)}</div>
        <div className="cmd">{summarise(p.input)}</div>
        <div className="acts">
          <button className="btn p sm" onClick={() => onDecide(agent.id, p.toolUseId, { kind: "allow" })}>Allow</button>
          <button className="btn d sm" onClick={() => onDecide(agent.id, p.toolUseId, { kind: "deny" })}>Deny</button>
        </div>
      </div>
    );
  }
  const qs = (p.input.questions as Q[] | undefined) ?? [];
  if (qs.length === 1 && !qs[0].multiSelect) {
    const q = qs[0];
    return (
      <div className="tile-req" data-testid="tile-request" onClick={stop}>
        <div className="msg">{q.question}</div>
        <div className="acts">{q.options.map(o => <button key={o.label} className="btn sm" onClick={() => onDecide(agent.id, p.toolUseId, { kind: "answers", answers: { [q.question]: o.label } })}>{o.label}</button>)}</div>
      </div>
    );
  }
  return (
    <div className="tile-req" data-testid="tile-request" onClick={stop}>
      <div className="msg">Has {qs.length > 1 ? `${qs.length} questions` : "a question"} for you.</div>
      <div className="acts"><button className="btn sm" onClick={() => onSelect(agent.id)}>Answer in the side panel</button></div>
    </div>
  );
}

export function AgentTile({ agent, role, assignment, selected, index, recent, onSelect, onAssign, onDecide, live, activity, bugStage }: AgentTileProps) {
  const a = assignment;
  const { Icon, word } = STATE[agent.state];
  const line = agent.state === "free" || agent.state === "waiting" ? null
    : agent.state === "done" ? a?.outcome?.split("\n").filter(Boolean).at(-1) ?? "Finished"
    : agent.state === "failed" ? a?.error ?? "The run failed"
    : a?.activity ?? "";
  return (
    <div className={`tile ${selected ? "selected" : ""}`} data-state={agent.state} data-testid={`tile-${agent.id}`} onClick={() => onSelect(agent.id)}>
      <span className="idx">{index < 9 ? index + 1 : ""}</span>
      <div className="hd">
        <div className="av">{role?.avatar ?? "🤖"}</div>
        <div><div className="name">{agent.displayName} <span className="role">— {agent.role}</span>{agent.resumeSessionId && <span title="Continues an adopted Claude Code session"> 🔗</span>}</div><div className="repo">{basename(agent.repo)}</div></div>
        {bugStage && <span className="chip" data-testid="tile-bug-stage">{bugStage}</span>}
      </div>
      <div className={`tile-state ${agent.state}`} data-testid="tile-state"><Icon /> {word}</div>
      {a && <div className="tasktitle" title={a.prompt}>{a.prompt.split("\n")[0].slice(0, 90)}</div>}
      {!a && activity?.lastPrompt && <div className="tasktitle" title={activity.lastPrompt}>{activity.lastPrompt.split("\n")[0].slice(0, 90)}</div>}
      {agent.state === "waiting" && <TileRequest agent={agent} a={a} onDecide={onDecide} onSelect={onSelect} />}
      {line !== null && <div className="act">{line}</div>}
      {agent.state === "free" && activity && activity.phase !== "unknown" && (
        <div className={`act phase ${activity.phase}`} data-testid="tile-phase">
          {activity.phase === "waiting" ? (activity.question ? "Asking you a question in the terminal" : `Needs approval in the terminal: ${activity.pendingTool?.name ?? ""}`) : activity.phase === "working" ? "Working in the terminal" : "Idle — your turn"}
        </div>
      )}
      {agent.state === "free" && live && <div className="act dim" data-testid="live-note">Live in {live.kind === "background" ? "the background" : "a terminal"} ({live.status}) — close it to assign, or use the Terminal tab</div>}
      {agent.state === "free" && !live && <AssignBox agentId={agent.id} recent={recent} onSubmit={onAssign} />}
      {a && <div className="ft"><span>#{a.id} · {elapsed(a.startedAt ?? a.createdAt)}{a.turns ? ` · ${a.turns} turns` : ""}</span><span>{usd(a.costUsd)}</span></div>}
    </div>
  );
}
```

`AgentGrid.tsx`: add `onDecide?: (agentId: string, toolUseId: string, d: Decision) => void` to its props (import `Decision`), and pass `onDecide={onDecide}` to each `AgentTile`. `App.tsx`: pass `onDecide={decide}` to `AgentGrid`.

In `styles.css`, replace all `.tile…` rules (lines starting `.tile`, `.av`, `.side .av[data-state…`, `.name`, `.repo`, `.act`, `.dot`, `.ft`, `.badge`, `.idx`, `.tasktitle`) with:

```css
.tile { position:relative; background:var(--surface); border:1px solid var(--grid-line); border-radius:8px; padding:12px; min-height:120px; cursor:pointer; display:flex; flex-direction:column; overflow:hidden; transition:border-color 150ms ease-out; }
.tile:hover { border-color:#2A3542; } .tile.selected { border-color:var(--accent); background:var(--surface-raised); }
.tile[data-state="working"] { border-color:transparent; box-shadow:var(--glow-working); }
.tile[data-state="working"]::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; background:linear-gradient(90deg, transparent, var(--st-working), transparent); animation:shimmer 2s infinite linear; }
.tile[data-state="waiting"] { border-color:transparent; background:rgba(251,191,36,.05); box-shadow:var(--glow-needs-you); animation:pulse-glow 1.6s infinite; }
.tile[data-state="done"] { border-color:transparent; box-shadow:var(--glow-done); }
.tile[data-state="failed"] { border-color:transparent; box-shadow:var(--glow-failed); }
.tile[data-state="free"] { opacity:.75; } .tile[data-state="free"]:hover { opacity:1; }
.tile.selected[data-state] { box-shadow:0 0 0 1px var(--accent), 0 0 16px #22D3EE33; }
.hd { display:flex; align-items:center; gap:10px; }
.av { width:32px; height:32px; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:16px; background:var(--surface-raised); border:1px solid var(--grid-line); flex:none; }
.name { font-weight:500; } .name .role { color:var(--text-faint); font-weight:400; }
.repo { font-size:11px; color:var(--text-muted); font-family:var(--mono); }
.tile-state { display:inline-flex; align-items:center; gap:5px; margin-top:10px; font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.5px; }
.tile-state.working { color:var(--st-working); } .tile-state.waiting { color:var(--st-needs-you); } .tile-state.done { color:var(--st-done); } .tile-state.failed { color:var(--st-failed); } .tile-state.free { color:var(--st-idle); }
.tasktitle { font-size:13px; color:var(--text); margin-top:6px; font-weight:500; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.act { font-size:12px; color:var(--text-muted); margin-top:6px; white-space:pre-wrap; word-break:break-word; }
.tile-req { margin-top:10px; background:var(--surface-raised); border:1px solid #FBBF2444; border-radius:6px; padding:8px; cursor:default; }
.tile-req .msg { font-size:12px; color:var(--st-needs-you); font-weight:500; margin-bottom:6px; }
.tile-req .cmd { font-family:var(--mono); font-size:11px; color:var(--text); background:var(--bg); padding:4px 6px; border-radius:4px; margin:0 0 8px; overflow-x:auto; white-space:nowrap; }
.tile-req .acts { display:flex; gap:6px; flex-wrap:wrap; } .tile-req .acts .btn { flex:1; }
.ft { display:flex; justify-content:space-between; font-size:11px; color:var(--text-faint); margin-top:auto; padding-top:10px; font-family:var(--mono); }
.idx { position:absolute; top:8px; right:10px; font-size:10px; color:var(--text-faint); font-family:var(--mono); }
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS. If an existing `AgentTile` test asserted the removed `badge` text (`"needs you"`/`"question"`), it is the test replaced in Step 1; any other reference to `.badge` on agent tiles is updated to `tile-state`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/AgentTile.tsx ui/src/components/AgentGrid.tsx ui/src/components/PendingPrompt.tsx ui/src/App.tsx ui/src/styles.css ui/test/AgentTile.test.tsx
git commit -m "feat(ui): tiles say their state in words, glow by state, and take Allow/Deny right where you see them"
```

---

### Task 5: Side panel as an instrument panel; requests in plain words

**Files:**
- Modify: `ui/src/components/SidePanel.tsx`, `ui/src/components/PendingPrompt.tsx`, `ui/src/styles.css` (side block)
- Modify: `ui/test/SidePanel.test.tsx`, `ui/test/PendingPrompt.test.tsx`

**Interfaces:**
- Consumes: `describeRequest` (Task 4).
- Produces: `PendingPrompt({ pending, onDecide, who? })` — `who` names the agent in the sentence; `SidePanel` passes `agent.displayName`.

- [ ] **Step 1: Write the failing tests**

Add to `ui/test/PendingPrompt.test.tsx` (reuse its existing render helpers/fixtures):

```tsx
  it("describes a permission request in a sentence above the exact command", () => {
    render(<PendingPrompt who="Cody" pending={{ kind: "permission", toolUseId: "t", toolName: "Bash", input: { command: "kubectl rollout restart deploy/api" }, suggestions: [] }} onDecide={vi.fn()} />);
    const box = screen.getByTestId("pending-permission");
    expect(box).toHaveTextContent("Cody wants to run a shell command");
    expect(box.querySelector(".cmd")).toHaveTextContent("kubectl rollout restart deploy/api");
  });
```

Add to `ui/test/SidePanel.test.tsx` (reuse its `agent`, `role`, `asg`, `fns`):

```tsx
  it("labels its sections as an instrument panel and shows elapsed · turns · cost", () => {
    render(<SidePanel agent={agent} role={role} assignment={asg} {...fns} />);
    const stats = screen.getByTestId("side-stats");
    expect(stats).toHaveTextContent(/ELAPSED/); expect(stats).toHaveTextContent(/TURNS\s*2/); expect(stats).toHaveTextContent(/COST\s*\$0\.30/);
    expect(screen.getByTestId("pending-permission")).toHaveTextContent(/wants to run a shell command/);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run test/PendingPrompt.test.tsx test/SidePanel.test.tsx`
Expected: FAIL — title still "Permission: Bash", no `side-stats`.

- [ ] **Step 3: Implement**

`PendingPrompt.tsx`: change the signature to `PendingPrompt({ pending, onDecide, who }: { pending: Pending; onDecide: (d: Decision) => void; who?: string })` and the permission title line to:

```tsx
        <div className="qtitle">{who ? `${who} ${describeRequest(pending.toolName)}` : describeRequest(pending.toolName).replace(/^wants/, "Wants")}</div>
```

`SidePanel.tsx`:
- Pass `who={agent.displayName}` to `<PendingPrompt … />`.
- Replace the assignment footer `<div className="ft">…</div>` with:

```tsx
        <div className="side-stats" data-testid="side-stats">
          <span>ELAPSED {elapsed(a.startedAt ?? a.createdAt)}</span><span>TURNS {a.turns}</span><span>COST {usd(a.costUsd)}</span>
        </div>
```

- Rename the visible `<h4>Recent activity</h4>` to `<h4>Live transcript</h4>`.

In `styles.css`, replace the `.side`, `.side h4`, `.task`, `.transcript…`, `.qbox`, `.qtitle`/`.cmd` rules with:

```css
.side { background:var(--surface); border:1px solid var(--grid-line); border-radius:8px; padding:16px; overflow:auto; font-size:12.5px; display:flex; flex-direction:column; gap:4px; }
.side > .hd { padding-bottom:12px; border-bottom:1px solid var(--grid-line); } .side > .hd .av { width:40px; height:40px; font-size:20px; }
.side h4 { margin:14px 0 6px; font-family:var(--mono); font-size:11px; font-weight:500; color:var(--text-faint); text-transform:uppercase; letter-spacing:.5px; }
.task { white-space:pre-wrap; color:var(--text); }
.transcript { font-family:var(--mono); font-size:11px; color:var(--text-muted); line-height:1.5; background:var(--bg); border:1px solid var(--grid-line); border-radius:6px; padding:10px; max-height:220px; overflow:auto; }
.transcript .tool_use { color:var(--st-needs-you); } .transcript .tool_result { color:var(--text-faint); }
.qbox { background:rgba(251,191,36,.05); border:1px solid #FBBF2444; border-radius:6px; padding:12px; margin-top:10px; }
.qtitle { font-size:13px; color:var(--st-needs-you); font-weight:500; margin-bottom:8px; }
.cmd { font-family:var(--mono); white-space:pre-wrap; word-break:break-all; color:var(--text); background:var(--bg); padding:8px; border-radius:4px; margin:0 0 10px; font-size:11px; }
.side-stats { display:flex; justify-content:space-between; font-family:var(--mono); font-size:11px; color:var(--text-faint); padding-top:12px; margin-top:12px; border-top:1px dashed var(--grid-line); }
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS. Any existing test asserting the old `"Permission: Bash"` title or `"Recent activity"` is updated to the new copy.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/SidePanel.tsx ui/src/components/PendingPrompt.tsx ui/src/styles.css ui/test/SidePanel.test.tsx ui/test/PendingPrompt.test.tsx
git commit -m "feat(ui): side panel as an instrument panel; requests read as sentences"
```

---

### Task 6: Footer key chips, session rows, end to end, 0.7.0

**Files:**
- Modify: `ui/src/App.tsx` (footer), `ui/src/styles.css` (`.foot`, `.livecard`, `.split`)
- Create: `ui/test/Footer.test.tsx`
- Modify: `desktop/package.json` (`0.7.0`), `README.md`

**Interfaces:**
- Produces: footer key hints rendered as `<kbd>` elements per view.

- [ ] **Step 1: Write the failing test**

`ui/test/Footer.test.tsx` — render `<App />` the way `App.test.tsx` does (copy its `vi.mock("../src/api"…)` and `vi.mock("../src/notify"…)` blocks and `subscribe` setup), then:

```tsx
  it("shows the grid's keys as kbd chips, and the bug screen's on the bug screen", async () => {
    render(<App />);
    const foot = document.querySelector(".foot")!;
    expect([...foot.querySelectorAll("kbd")].map(k => k.textContent)).toEqual(["1", "9", "A", "D", "O", "Esc"]);
    await userEvent.click(screen.getByRole("button", { name: /^Bugs/ }));
    expect([...document.querySelector(".foot")!.querySelectorAll("kbd")].map(k => k.textContent)).toEqual(["↑", "↓", "⏎", "Esc"]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run test/Footer.test.tsx`
Expected: FAIL — hints are plain text.

- [ ] **Step 3: Implement**

In `App.tsx`, replace the footer's key-hint `<span className="dim">…</span>` with:

```tsx
        <span className="keys">{route.view === "bugs"
          ? <><kbd>↑</kbd><kbd>↓</kbd> move <kbd>⏎</kbd> open <kbd>Esc</kbd> back to agents</>
          : <><kbd>1</kbd>–<kbd>9</kbd> select <kbd>A</kbd> allow <kbd>D</kbd> deny <kbd>O</kbd> terminal <kbd>Esc</kbd> clear</>}</span>
```

In `styles.css`, replace `.foot` and the `.livecard…` rules with:

```css
.foot { display:flex; gap:18px; align-items:center; padding:8px 16px; border-top:1px solid var(--grid-line); font-size:12px; color:var(--text-muted); background:var(--bg); flex-shrink:0; }
.foot .keys { margin-left:auto; display:flex; gap:6px; align-items:center; }
.livecard { display:flex; align-items:center; gap:12px; padding:10px 12px; background:var(--surface); border:1px dashed var(--grid-line); border-radius:6px; font-family:var(--mono); font-size:12px; color:var(--text-muted); }
.livecard .dot { width:8px; height:8px; border-radius:50%; background:var(--st-idle); flex:none; }
.livecard .dot.busy { background:var(--st-working); box-shadow:0 0 8px var(--st-working); }
.livecard .dot.idle { background:var(--st-done); } .livecard .dot.blocked { background:var(--st-needs-you); box-shadow:0 0 8px var(--st-needs-you); }
.livecard .kind { font-size:10px; color:var(--text-muted); border:1px solid var(--grid-line); border-radius:3px; padding:0 5px; flex:none; }
.livecard .ltitle { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text); }
.livecard .lrepo { color:var(--accent); flex:none; } .livecard .lmeta { color:var(--text-faint); flex:none; font-size:11px; }
.livecard .lactions { display:flex; gap:6px; align-items:center; flex:none; }
.livecard select { background:var(--bg); border:1px solid var(--grid-line); color:var(--text); border-radius:4px; padding:0 8px; height:24px; font:inherit; font-size:11px; }
```

- [ ] **Step 4: Version and README**

Set `desktop/package.json` `"version"` to `"0.7.0"`. In `README.md` replace the `+ Spawn` mentions with `+ New agent` and add one line under the feature list: `**The look.** AgentGrid 0.7 shows live counters in the top bar, glows each agent by state (cyan working, amber needs you, green done, red failed), and lets you Allow or Deny a request right on the agent's card.`

- [ ] **Step 5: Run everything**

Run: `npm test && (cd ui && npx tsc -p tsconfig.json --noEmit) && (cd server && npx tsc -p tsconfig.json --noEmit) && (cd ui && npx playwright test)`
Expected: all pass; e2e 7/7.

- [ ] **Step 6: Visual check against the approved draft**

Run the fake-mode server and capture the grid for side-by-side review with draft `e3e73031-…`:

```bash
cd server && (AGENTGRID_FAKE=1 npm run serve > /tmp/ag-fake.log 2>&1 &) && sleep 6 && cd ../ui && npx playwright screenshot --viewport-size=1440,900 http://localhost:4800/ ../.superdesign/tmp/phase1-grid.png
```

(If fake mode uses a different env var or port, read `server/src/start.ts` / `ui/playwright.config.ts` for the ones the e2e uses and use those.) Attach the screenshot path in the final report; do not claim visual parity without it.

- [ ] **Step 7: Commit**

```bash
git add ui/src/App.tsx ui/src/styles.css ui/test/Footer.test.tsx desktop/package.json README.md
git commit -m "feat(ui): footer key chips, session rows in the new style; 0.7.0"
```
