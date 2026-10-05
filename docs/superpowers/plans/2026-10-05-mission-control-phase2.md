# Mission Control — Phase 2 (0.8.0): the Bug screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Bug screen to the approved Mission Control draft — status-lit list, header counters, a connected pipeline stepper, glowing Blocking beside Now, panel-styled sections, plan cards in a 2×2 grid, and a dotted timeline — with behaviour and data unchanged.

**Architecture:** `BugScreen.tsx` keeps its data flow (`bugView` derivations, `BugGates`, `PlanView`, `DiffView`); only its markup and `styles.css`'s bug-screen block change. Glyph icons (⚠ ✗ ✓ ● ○) are replaced by `lucide-react` icons. Every handle the tests and e2e use is kept: `role="listbox"/"option"`, `aria-label="Pipeline"` on the stepper with `data-state` per step `<li>`, region names (Blocking, Now, Assumptions and questions, Timeline, Changes, Actions), `data-testid="bug-screen"`.

**Tech Stack:** React 19, vanilla CSS, lucide-react, vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-mission-control-ui-design.md` §6. Visual reference: Superdesign draft `de9ced35-5e7e-4a46-92ec-a04fbf1c89f0` (source HTML: `.superdesign/tmp/bug-screen.html`, built by `.superdesign/tmp/build.py`).

## Global Constraints

- Behaviour and data are unchanged: no new API calls, no change to `bugView.ts` derivations, `BugGates` actions, or URL handling.
- Use only phase 1 tokens (`--bg --surface --surface-raised --grid-line --text --text-muted --text-faint --st-* --accent --accent-text --mono --glow-*`); no new colours except rgba tints of existing status colours.
- `--text-faint` only for non-essential metadata (times, ids); essential copy uses `--text-muted` or stronger (phase 1 I2).
- Status everywhere is icon + word + colour; no ⚠ ✗ ✓ ● ○ glyphs in this screen.
- Pulse only for waiting-on-you; `prefers-reduced-motion` already disables it globally.
- Keep every test handle listed under Architecture.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019vk3Y8Lj3YYsuDjzfQ2MBB
  ```

## Review Focus

1. **A bug with a very long title** — the list row must truncate to one line with the full title on hover, and the header must wrap rather than push the counters off-screen. Pinned in Task 1 (title attribute) and Task 2 (header wraps).
2. **A cancelled or failed task** — the stepper must show the failed/cancelled step in red/grey with its word, and the connector must stop there, not glow green past it. Pinned in Task 3.
3. **No blockers** — Blocking must collapse to one calm line with no glow. Pinned in Task 4.
4. **Twenty bugs in the list** — the list scrolls on its own; the detail column keeps its scroll position independently. Pinned in Task 1 (CSS overflow) and verified in the Task 5 screenshot.
5. **A plan with only one section** (unstructured) — the 2×2 grid must not leave three empty cells; an unstructured plan spans the full width. Pinned in Task 4.

---

### Task 1: The bug list — status-lit rows with stage

**Files:**
- Modify: `ui/src/components/BugScreen.tsx` (list markup, `STATUS` map), `ui/src/styles.css` (bug-screen block: list)
- Test: `ui/test/BugScreen.test.tsx`

**Interfaces:**
- Consumes: `listStatus`, `stageLabel` from `bugView`.
- Produces: list rows `li.bugrow[data-status=<ListStatus>]` with `.k` (key), `.t` (title, `title` attr = full title), `.s` (status line `<Icon/> WORD · <stage label>`), and a header `.lh` "Bug fixes · <n>".

- [ ] **Step 1: Write the failing tests**

Add to `ui/test/BugScreen.test.tsx`:

```tsx
describe("BugScreen — the list", () => {
  it("shows each row's status in words with the stage it is at", () => {
    renderScreen([task("plan-review"), task("implementing", { id: "bt2", issue: { ...ISSUE, key: "PAY-2" } })], "bt1");
    const rows = screen.getAllByRole("option");
    expect(rows[0]).toHaveTextContent(/Waiting on you · Plan review/);
    expect(rows[1]).toHaveTextContent(/Running · Implementing/);
    expect(rows[0]).toHaveAttribute("data-status", "waiting");
  });

  it("uses icons, not glyphs, for status", () => {
    renderScreen([task("failed"), task("done", { id: "bt2" })], "bt1");
    for (const row of screen.getAllByRole("option")) expect(row.textContent).not.toMatch(/[⚠✗✓●○–]/);
    expect(screen.getAllByRole("option")[0].querySelector("svg")).not.toBeNull();
  });

  // Review Focus 1
  it("keeps the full title on hover for a long one", () => {
    const long = "A".repeat(140);
    renderScreen([task("implementing", { issue: { ...ISSUE, title: long } })]);
    expect(screen.getAllByRole("option")[0].querySelector(".t")).toHaveAttribute("title", long);
  });

  it("heads the list with its count", () => {
    renderScreen([task("implementing"), task("done", { id: "bt2" })], "bt1");
    expect(screen.getByRole("listbox").closest(".buglist")!.querySelector(".lh")).toHaveTextContent(/Bug fixes\s*2/);
  });
});
```

Update the existing test `"lists every bug with a status word, active ones first"` to expect `/Waiting on you/` and `/Done/` (unchanged words) — it should still pass.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run test/BugScreen.test.tsx`
Expected: FAIL — no `data-status`, no stage on the row, glyph icons present, no `.lh`.

- [ ] **Step 3: Implement**

In `BugScreen.tsx`, import `{ CheckCircle2, CircleDashed, Hand, Loader, MinusCircle, XCircle }` from `lucide-react` and replace `STATUS`:

```tsx
const STATUS: Record<ListStatus, { Icon: typeof Hand; word: string }> = {
  running: { Icon: Loader, word: "Running" }, waiting: { Icon: Hand, word: "Waiting on you" },
  failed: { Icon: XCircle, word: "Failed" }, done: { Icon: CheckCircle2, word: "Done" }, cancelled: { Icon: MinusCircle, word: "Cancelled" },
};
```

Replace the list markup (`<ul className="buglist" …>…</ul>`) with:

```tsx
      <aside className="buglist">
        <div className="lh"><span>Bug fixes</span><span className="mono">{tasks.length}</span></div>
        <ul role="listbox" aria-label="Bug fixes" onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
          if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        }}>
          {tasks.map(({ t, status }) => {
            const { Icon, word } = STATUS[status];
            return (
              <li key={t.id} role="option" aria-selected={t.id === shown?.id} tabIndex={t.id === shown?.id ? 0 : -1}
                className="bugrow" data-status={status} onClick={() => onSelect(t.id)} onKeyDown={e => { if (e.key === "Enter") onSelect(t.id); }}>
                <span className="k">{t.issue.key}</span>
                <span className="t" title={t.issue.title}>{t.issue.title}</span>
                <span className={`s ${status}`}><Icon /> {word} · {stageLabel(t.stage === "failed" || t.stage === "cancelled" ? lastRealStage(t) : t.stage)}</span>
              </li>
            );
          })}
        </ul>
        <div className="lfoot"><kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>⏎</kbd> open</div>
      </aside>
```

Add above `BugScreen`:

```tsx
/** For a failed or cancelled task, the stage it stopped at — "Failed · Implementing" says where. */
const lastRealStage = (t: BugTask) => [...t.history].reverse().find(h => h.stage !== "failed" && h.stage !== "cancelled")?.stage ?? t.stage;
```

(`CircleDashed` is imported for Task 3.)

In `styles.css`, replace the rules starting `.bugscreen {`, `.bugscreen.empty-screen`, `.buglist {`, `.bugrow {`, `.bugrow:hover`, `.bugrow:focus-visible…`, `.bugrow-key`, `.bugrow .status`, `.status.running` with:

```css
.bugscreen { display:grid; grid-template-columns: 290px 1fr; gap:12px; padding:12px 16px; flex:1; min-height:0; }
.bugscreen.empty-screen { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:var(--text-muted); }
.buglist { background:var(--surface); border:1px solid var(--grid-line); border-radius:8px; padding:8px; display:flex; flex-direction:column; min-height:0; }
.buglist ul { list-style:none; margin:0; padding:0; overflow:auto; display:flex; flex-direction:column; gap:4px; flex:1; min-height:0; }
.buglist .lh { font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-muted); padding:6px 8px 8px; display:flex; justify-content:space-between; }
.buglist .lfoot { padding:10px 8px 4px; font-size:11.5px; color:var(--text-muted); }
.bugrow { display:grid; grid-template-columns:auto 1fr; gap:3px 10px; padding:9px 10px; border-radius:6px; border:1px solid transparent; cursor:pointer; }
.bugrow:hover { background:var(--surface-raised); }
.bugrow[aria-selected="true"] { background:var(--surface-raised); border-color:var(--grid-line); }
.bugrow[aria-selected="true"][data-status="waiting"] { border-color:#FBBF2455; box-shadow:0 0 14px #FBBF2418; }
.bugrow[aria-selected="true"][data-status="running"] { border-color:#22D3EE55; box-shadow:0 0 14px #22D3EE18; }
.bugrow[aria-selected="true"][data-status="failed"] { border-color:#F8717155; }
.bugrow .k { font-family:var(--mono); font-size:12px; font-weight:600; }
.bugrow .t { color:var(--text-muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.bugrow .s { grid-column:1/-1; font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.5px; display:flex; align-items:center; gap:5px; }
.s.running { color:var(--st-working); } .s.waiting { color:var(--st-needs-you); } .s.failed { color:var(--st-failed); } .s.done { color:var(--st-done); } .s.cancelled { color:var(--text-muted); }
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/BugScreen.tsx ui/src/styles.css ui/test/BugScreen.test.tsx
git commit -m "feat(ui): bug list rows lit by status, saying where each fix is"
```

---

### Task 2: The header — key, links, agent, and counters

**Files:**
- Modify: `ui/src/components/BugScreen.tsx` (header markup), `ui/src/styles.css`
- Test: `ui/test/BugScreen.test.tsx`

**Interfaces:**
- Produces: `header.dhead` containing `h2` (`.key` mono + title), `.meta` (Ticket link, PR link, worktree `.mono` + Copy, agent chip, Transcript), and `.dcounters` with two `.counter`s labelled COST and REVIEW ROUNDS.

- [ ] **Step 1: Write the failing tests**

```tsx
describe("BugScreen — header", () => {
  it("shows cost and review rounds as counters, and the agent by name", () => {
    const state = { ...stateWith([task("monitoring", { costUsd: 0.84, feedbackRounds: 2 })]),
      agents: [{ id: "bugfix@r", role: "bugfix", repo: "/r", displayName: "Kai", createdAt: "", state: "free", currentAssignmentId: null }] };
    render(<BugScreen state={state as never} selectedId="bt1" onSelect={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} />);
    const head = document.querySelector(".dhead")!;
    expect(within(head as HTMLElement).getByText("Cost").closest(".counter")).toHaveTextContent("$0.84");
    expect(within(head as HTMLElement).getByText("Review rounds").closest(".counter")).toHaveTextContent("2");
    expect(head).toHaveTextContent("Bug fixer · Kai");
    expect(within(head as HTMLElement).getByRole("link", { name: /ticket/i })).toHaveAttribute("href", "https://x/PAY-42");
  });
});
```

(Use the file's `ISSUE` url; if it is not `https://x/PAY-42`, assert against `ISSUE.url`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run test/BugScreen.test.tsx -t header`
Expected: FAIL — no `.dhead`, no counters.

- [ ] **Step 3: Implement**

Replace `<header className="bugdetail-head">…</header>` with:

```tsx
      <header className="dhead">
        <div className="dtitle">
          <h2><span className="key">{task.issue.key}</span>{task.issue.title}</h2>
          <div className="meta">
            <a href={task.issue.url} target="_blank" rel="noreferrer"><ExternalLink /> Ticket</a>
            {task.pr && <a href={task.pr.url} target="_blank" rel="noreferrer"><GitPullRequest /> Pull request #{task.pr.number}</a>}
            <span className="mono path" title="Worktree">{task.worktree}</span>
            <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(task.worktree)}><Copy /> Copy path</button>
            {agent && <span className="chip">Bug fixer · {agent.displayName}</span>}
            {agent && <button className="btn sm" onClick={() => onTranscript(agent.id)}><ScrollText /> Transcript</button>}
          </div>
        </div>
        <div className="dcounters">
          <div className="counter"><span className="num">{usd(task.costUsd)}</span><span className="lbl">Cost</span></div>
          <div className={`counter ${task.feedbackRounds ? "" : "zero"}`}><span className="num">{task.feedbackRounds}</span><span className="lbl">Review rounds</span></div>
        </div>
      </header>
```

Import `{ Copy, ExternalLink, GitPullRequest, ScrollText }` from `lucide-react`.

CSS (replace `.bugdetail h2`, `.bugdetail h2 a`, and add):

```css
.dhead { display:flex; align-items:flex-start; gap:16px; flex-wrap:wrap; }
.dtitle { flex:1; min-width:320px; }
.dhead h2 { margin:0; font-size:18px; font-weight:600; overflow-wrap:anywhere; }
.dhead h2 .key { font-family:var(--mono); color:var(--accent); margin-right:8px; }
.dhead .meta { display:flex; gap:12px; align-items:center; margin-top:6px; font-size:12px; color:var(--text-muted); flex-wrap:wrap; }
.dhead .meta a { color:var(--text-muted); text-decoration:none; display:inline-flex; gap:4px; align-items:center; } .dhead .meta a:hover { color:var(--accent); }
.dhead .path { color:var(--text-muted); font-size:11.5px; max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dcounters { display:flex; gap:20px; }
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS. If the existing test asserting `getByRole("heading", { level: 2 })` toHaveTextContent("PAY-42") still passes, nothing else is needed.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/BugScreen.tsx ui/src/styles.css ui/test/BugScreen.test.tsx
git commit -m "feat(ui): bug header with key, links, agent and live counters"
```

---

### Task 3: The pipeline as a connected stepper

**Files:**
- Modify: `ui/src/components/BugScreen.tsx` (pipeline markup, `STEP` map), `ui/src/styles.css`
- Test: `ui/test/BugScreen.test.tsx`

**Interfaces:**
- Produces: `ol.pipe[aria-label="Pipeline"]` of `li.pstep[data-state]` each with `.pdot` (lucide icon), `.pname` (label), `.pword` (state word), optional `.chip` badge. A step's connector (its `::before`) is lit when its own state is `done`, `current` or `waiting` (i.e. the line runs green into the step reached).

- [ ] **Step 1: Write the failing tests**

```tsx
describe("BugScreen — pipeline", () => {
  it("is a connected stepper: dot, name and word per step", () => {
    renderScreen([task("plan-review")]);
    const strip = screen.getByRole("list", { name: "Pipeline" });
    const step = within(strip).getByText("Plan review").closest("li")!;
    expect(step).toHaveAttribute("data-state", "waiting");
    expect(step.querySelector(".pdot svg")).not.toBeNull();
    expect(step.querySelector(".pword")).toHaveTextContent("waiting on you");
    expect(strip.textContent).not.toMatch(/[⚠✗✓●○]/);
  });

  // Review Focus 2
  it("stops at a failed step: red word there, nothing reached after it", () => {
    renderScreen([task("failed", { history: [{ stage: "intake", at: "a", note: "" }, { stage: "implementing", at: "b", note: "" }, { stage: "failed", at: "c", note: "" }] })]);
    const strip = screen.getByRole("list", { name: "Pipeline" });
    expect(within(strip).getByText("Implement").closest("li")).toHaveAttribute("data-state", "failed");
    expect(within(strip).getByText("Diff review").closest("li")).toHaveAttribute("data-state", "todo");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run test/BugScreen.test.tsx -t pipeline`
Expected: FAIL — no `.pdot`/`.pword`, glyphs present.

- [ ] **Step 3: Implement**

Replace `STEP` and the `<ol className="pipeline" …>` block:

```tsx
const STEP_ICON: Record<string, typeof Hand> = {
  intake: Inbox, analyze: Search, plan: ClipboardList, implement: Code2, diff: FileDiff, pr: GitPullRequest, monitor: Radar, merge: GitMerge,
};
const STEP_WORD: Record<StepState, string> = {
  done: "done", current: "in progress", waiting: "waiting on you", failed: "failed", cancelled: "cancelled", todo: "not reached",
};
function stepIcon(id: string, state: StepState) {
  const I = state === "done" ? Check : state === "waiting" ? Hand : state === "failed" ? X : state === "cancelled" ? Minus : STEP_ICON[id] ?? CircleDashed;
  return <I />;
}
```

```tsx
      <ol className="pipe" aria-label="Pipeline">
        {steps.map(s => (
          <li key={s.id} data-state={s.state} className={`pstep ${s.state}`}>
            <span className="pdot" aria-hidden>{stepIcon(s.id, s.state)}</span>
            <span className="pname">{s.label}</span>
            <span className="pword">{STEP_WORD[s.state]}</span>
            {s.badge && <span className="chip">{s.badge}</span>}
          </li>
        ))}
      </ol>
```

Import `{ Check, ClipboardList, Code2, FileDiff, GitMerge, Inbox, Minus, Radar, Search, X }` from `lucide-react` (plus the earlier ones).

CSS — replace the `.pipeline`, `.step`, `.step-word`, `.step.*` rules with:

```css
.pipe { list-style:none; margin:0; display:grid; grid-template-columns:repeat(8, minmax(0,1fr)); background:var(--surface); border:1px solid var(--grid-line); border-radius:8px; padding:14px 10px 12px; }
.pstep { display:flex; flex-direction:column; align-items:center; gap:6px; position:relative; text-align:center; }
.pstep::before { content:''; position:absolute; top:13px; left:-50%; right:50%; height:2px; background:var(--grid-line); }
.pstep:first-child::before { display:none; }
.pstep.done::before, .pstep.current::before, .pstep.waiting::before { background:var(--st-done); box-shadow:0 0 6px #34D39966; }
.pdot { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; border:1px solid var(--grid-line); background:var(--bg); color:var(--text-muted); position:relative; z-index:1; }
.pstep.done .pdot { border-color:var(--st-done); color:var(--st-done); background:rgba(52,211,153,.08); }
.pstep.current .pdot { border-color:var(--st-working); color:var(--st-working); background:rgba(34,211,238,.08); box-shadow:var(--glow-working); }
.pstep.waiting .pdot { border-color:var(--st-needs-you); color:var(--st-needs-you); background:rgba(251,191,36,.1); animation:pulse-glow 1.6s infinite; }
.pstep.failed .pdot { border-color:var(--st-failed); color:var(--st-failed); background:rgba(248,113,113,.08); }
.pname { font-size:12px; font-weight:500; } .pstep.todo .pname { color:var(--text-muted); }
.pword { font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-muted); }
.pstep.done .pword { color:var(--st-done); } .pstep.current .pword { color:var(--st-working); } .pstep.waiting .pword { color:var(--st-needs-you); } .pstep.failed .pword { color:var(--st-failed); }
@media (max-width: 1100px) { .pipe { grid-template-columns:repeat(4, minmax(0,1fr)); row-gap:14px; } .pstep:nth-child(5)::before { display:none; } }
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (the existing `"shows the pipeline with the current step marked in words"` test uses `getByText("Implement").closest("li")` and `data-state` — still valid).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/BugScreen.tsx ui/src/styles.css ui/test/BugScreen.test.tsx
git commit -m "feat(ui): the bug pipeline as a connected stepper"
```

---

### Task 4: Panels — Blocking beside Now, assumptions, plan cards, timeline

**Files:**
- Modify: `ui/src/components/BugScreen.tsx` (section markup), `ui/src/components/BugGates.tsx` (plan-gate explanation line), `ui/src/components/PlanView.tsx` (grid only when structured), `ui/src/styles.css`
- Test: `ui/test/BugScreen.test.tsx`, `ui/test/BugPanel.test.tsx`, `ui/test/PlanView.test.tsx`

**Interfaces:**
- Produces: sections carry `className="panel …"` with `.panel-title` (mono uppercase + lucide icon); `.row2` grid holds Blocking and Now; `section.blocking.has` only when blockers exist; timeline items `li[data-tone="waiting"|"done"|"failed"|"neutral"]`; plan gate has `.gate-explain` text; `PlanView` root has class `plan structured` or `plan whole`.

- [ ] **Step 1: Write the failing tests**

BugScreen:

```tsx
describe("BugScreen — panels", () => {
  it("puts Blocking beside Now, and only glows Blocking when something blocks", () => {
    const { unmount } = renderScreen([task("plan-review")]);
    const blocking = screen.getByRole("region", { name: /blocking/i });
    expect(blocking).toHaveClass("panel"); expect(blocking).toHaveClass("has");
    expect(blocking.parentElement).toBe(screen.getByRole("region", { name: /now/i }).parentElement);
    expect(blocking.parentElement).toHaveClass("row2");
    unmount();
    // Review Focus 3
    renderScreen([task("implementing")]);
    expect(screen.getByRole("region", { name: /blocking/i })).not.toHaveClass("has");
  });

  it("colours timeline dots by what each entry was", () => {
    renderScreen([task("plan-review", { history: [{ stage: "intake", at: "a", note: "" }, { stage: "analyzing", at: "b", note: "" }, { stage: "plan-review", at: "c", note: "" }] })]);
    const items = within(screen.getByRole("region", { name: /timeline/i })).getAllByRole("listitem");
    expect(items[0]).toHaveAttribute("data-tone", "waiting");
    expect(items[1]).toHaveAttribute("data-tone", "done");
  });
});
```

BugPanel (plan gate):

```tsx
  it("says what approving the plan does", async () => {
    render(<BugPanel task={task("plan-review")} onChanged={vi.fn()} />);
    expect(await screen.findByText(/You review the diff before anything is pushed/)).toBeInTheDocument();
  });
```

PlanView:

```tsx
  // Review Focus 5
  it("lays sections in a grid only when the plan is structured", () => {
    const { container, rerender } = render(<PlanView markdown={PLAN} />);
    expect(container.querySelector(".plan")).toHaveClass("structured");
    rerender(<PlanView markdown={"just some notes"} />);
    expect(container.querySelector(".plan")).toHaveClass("whole");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run test/BugScreen.test.tsx test/BugPanel.test.tsx test/PlanView.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`BugScreen.tsx`, in `BugDetail`, wrap Blocking and Now and restyle every section as a panel:

```tsx
      <div className="row2">
        <section className={`panel blocking ${blockers.length ? "has" : "none"}`} aria-label="Blocking">
          <h3 className="panel-title"><OctagonAlert /> Blocking{blockers.length ? ` · ${blockers.length}` : ""}</h3>
          {blockers.length === 0 ? <p className="calm">Nothing is blocking this bug.</p> : (
            <ul>{blockers.map((b, i) => <BlockerRow key={i} b={b} onOpenSettings={onOpenSettings} />)}</ul>
          )}
        </section>
        <section className="panel now" aria-label="Now">
          <h3 className="panel-title"><Radio /> Now</h3>
          <div className="now-line"><b>{nowLine.headline}</b>{nowLine.since && <> · <Since iso={nowLine.since} kind={nowLine.sinceKind} now={now} /></>}</div>
          {nowLine.detail && <div className="now-detail">{nowLine.detail}</div>}
        </section>
      </div>
```

Change the other sections' opening tags and headings:
- Actions: `<section className="panel gates" aria-label="Actions">` (no heading).
- Assumptions: `<section className="panel assumptions" …><h3 className="panel-title"><Lightbulb /> Assumptions &amp; questions{items.length ? ` · ${items.length}` : ""}</h3><p className="panel-desc">What the agent decided on its own, or couldn't decide. Overturn any of them with “Request changes”.</p>`; in each item replace `{a.kind === "question" ? "? Question" : "• Assumed"}` with `{a.kind === "question" ? <><MessageCircleQuestion /> Question</> : <><CircleDot /> Assumed</>}` and `{task.assumptionsProblem && <div className="warnline">⚠ …` with `<div className="warnline"><TriangleAlert /> {task.assumptionsProblem}</div>`.
- Changes: `<section id="bug-changes" className="panel" aria-label="Changes"><h3 className="panel-title"><FileDiff /> Changes</h3>`.
- Ticket / Plan `<details>`: add `panel` to `className="section-collapse panel"`.
- Timeline: `<section className="panel timeline" aria-label="Timeline"><h3 className="panel-title"><History /> Timeline</h3>` and each item:

```tsx
          <li key={i} data-tone={i === 0 && (task.gate || pending) ? "waiting" : h.stage === "failed" ? "failed" : h.stage === "cancelled" ? "neutral" : i === 0 && !TERMINAL.includes(h.stage) ? "current" : "done"}>
            <When iso={h.at} now={now} /><span className="d" aria-hidden /><span><b>{stageLabel(h.stage)}</b>{h.note && <> — <Markdown inline text={h.note} /></>}</span>
          </li>
```

with `const TERMINAL = ["done", "failed", "cancelled"];` at module level. Import `{ CircleDot, History, Lightbulb, MessageCircleQuestion, OctagonAlert, Radio, TriangleAlert }`.

`BugGates.tsx`, in the plan gate's button row, after "Request changes…":

```tsx
            <span className="hint gate-explain">Approving lets the agent write the fix. You review the diff before anything is pushed.</span>
```

`PlanView.tsx`: root becomes `<div className={`plan ${structured ? "structured" : "whole"}`}>`.

CSS — replace `.bugdetail …`, `.bugdetail section`, `.bugdetail h3`, `.blocking.has`, `.blocking ul…`, `.blocker`, `.now-line`, `.assumption…`, `.akind`, `.atag`, `.chip.new`, `.warnline`, `.section-collapse…`, `.timeline time`, `.plan`, `.plansec…` rules with:

```css
.bugdetail { overflow:auto; display:flex; flex-direction:column; gap:12px; padding-right:4px; min-height:0; }
.row2 { display:grid; grid-template-columns: 1.15fr 1fr; gap:12px; }
@media (max-width: 1100px) { .row2 { grid-template-columns:1fr; } }
.blocking.has { border-color:transparent; box-shadow:0 0 0 1px #FBBF2477, 0 0 18px #FBBF2422; background:linear-gradient(180deg, rgba(251,191,36,.05), var(--surface) 70%); }
.blocking.has .panel-title { color:var(--st-needs-you); }
.blocking ul, .assumptions ul, .timeline ol { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
.blocker { display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px dashed var(--grid-line); flex-wrap:wrap; } .blocker:first-child { border-top:0; }
.calm { margin:0; color:var(--text-muted); }
.now-line { font-size:14px; } .now-line b { color:var(--text); } .now-detail { color:var(--text-muted); margin-top:8px; font-size:12px; }
.assumptions ul { gap:6px; }
.assumption { display:flex; gap:10px; align-items:flex-start; padding:9px 10px; border-radius:6px; background:var(--bg); border:1px solid var(--grid-line); }
.assumption.question { border-color:#FBBF2444; }
.akind { display:inline-flex; gap:4px; align-items:center; font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-muted); width:82px; flex:none; padding-top:2px; }
.assumption.question .akind { color:var(--st-needs-you); }
.atag { margin-left:auto; font-family:var(--mono); font-size:10px; color:var(--text-muted); white-space:nowrap; }
.chip.new { color:var(--st-working); border-color:#22D3EE55; background:rgba(34,211,238,.06); }
.warnline { display:flex; gap:6px; align-items:center; color:var(--st-needs-you); margin-bottom:8px; }
.section-collapse summary { cursor:pointer; font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-muted); }
.section-collapse[open] summary { margin-bottom:10px; }
.timeline li { display:grid; grid-template-columns:78px 14px 1fr; gap:10px; align-items:start; padding:5px 0; font-size:12.5px; }
.timeline time { font-family:var(--mono); font-size:11px; color:var(--text-faint); text-align:right; padding-top:1px; }
.timeline .d { width:8px; height:8px; border-radius:50%; margin-top:5px; background:var(--grid-line); }
.timeline li[data-tone="done"] .d { background:var(--st-done); }
.timeline li[data-tone="current"] .d { background:var(--st-working); box-shadow:0 0 8px var(--st-working); }
.timeline li[data-tone="waiting"] .d { background:var(--st-needs-you); box-shadow:0 0 8px var(--st-needs-you); }
.timeline li[data-tone="failed"] .d { background:var(--st-failed); }
.plan.structured { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.plan.whole { display:flex; flex-direction:column; gap:10px; }
.plansec { background:var(--bg); border:1px solid var(--grid-line); border-radius:6px; padding:10px 12px; }
.plansec h5 { margin:0 0 6px; font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-muted); }
.filelink { font-family:var(--mono); font-size:11px; color:var(--accent); background:rgba(34,211,238,.06); border:1px solid #22D3EE44; border-radius:3px; padding:0 5px; cursor:pointer; }
.gate-explain { margin-left:6px; font-style:normal; color:var(--text-muted); }
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS. Existing tests that read `screen.getByText("Nothing is blocking this bug.")`, the timeline listitems' text, and the assumptions region keep passing (same text, same regions).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/BugScreen.tsx ui/src/components/BugGates.tsx ui/src/components/PlanView.tsx ui/src/styles.css ui/test/BugScreen.test.tsx ui/test/BugPanel.test.tsx ui/test/PlanView.test.tsx
git commit -m "feat(ui): bug screen panels — Blocking beside Now, plan cards, a dotted timeline"
```

---

### Task 5: Empty state, e2e, screenshot, 0.8.0

**Files:**
- Modify: `ui/src/components/BugScreen.tsx` (empty state), `desktop/package.json` (`0.8.0`), `README.md`
- Test: `ui/test/BugScreen.test.tsx`

- [ ] **Step 1: Write the failing test**

Replace the existing empty-state test's button assertion with:

```tsx
  it("has an empty state that explains the screen and starts a fix", () => {
    const onFixBug = vi.fn();
    render(<BugScreen state={stateWith([]) as never} selectedId={null} onSelect={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={onFixBug} />);
    expect(screen.getByText(/No bug fixes yet/)).toBeInTheDocument();
    expect(screen.getByText(/You approve the plan, the diff and the merge/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fix a bug" })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run test/BugScreen.test.tsx -t "empty state"`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
  if (!tasks.length) {
    return (
      <div className="bugscreen empty-screen" data-testid="bug-screen">
        <span className="dlg-ic"><Bug /></span>
        <h2>No bug fixes yet</h2>
        <p>Turn a ticket into a merged pull request. You approve the plan, the diff and the merge — each fix appears here, step by step.</p>
        <button className="btn p" onClick={onFixBug}><Bug /> Fix a bug</button>
      </div>
    );
  }
```

CSS: `.bugscreen.empty-screen h2 { margin:0; font-size:18px; } .bugscreen.empty-screen p { margin:0; max-width:460px; text-align:center; line-height:1.55; } .empty-screen .dlg-ic { width:40px; height:40px; border-radius:8px; display:flex; align-items:center; justify-content:center; color:var(--st-needs-you); background:rgba(251,191,36,.08); border:1px solid #FBBF2444; }`

Version `desktop/package.json` → `0.8.0`; README bug-screen paragraph: append "In 0.8 it shows a connected pipeline, a glowing Blocking panel beside Now, and the plan as four cards."

- [ ] **Step 4: Run everything**

Run: `npm test && (cd ui && npx tsc -p tsconfig.json --noEmit) && (cd ui && npx playwright test)`
Expected: all pass; e2e 7/7 (the bugfix spec reads `getByRole("list", { name: "Pipeline" })` and `[data-state="waiting"]`, both kept).

- [ ] **Step 5: Screenshot**

Start fake mode (as in phase 1 Task 6), launch a bug fix through `POST /api/bugtasks` with the fake ticket and a scratch git repo with a remote (see `ui/playwright.config.ts` for how e2e prepares one), wait for plan review, and capture `#/bugs/<id>` at 1440×900 to `.superdesign/tmp/phase2-bug-screen.png`. Compare against draft `de9ced35-…`; note differences in the report.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/BugScreen.tsx ui/src/styles.css ui/test/BugScreen.test.tsx desktop/package.json README.md
git commit -m "feat(ui): bug screen empty state that teaches; 0.8.0"
```
