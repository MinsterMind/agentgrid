# Components

Framework: React 19 + Vite (SPA), TypeScript. No component library — all components are custom. CSS: one hand-written vanilla stylesheet (`ui/src/styles.css`), class-based, no Tailwind/CSS modules. Routing: hash-based (`ui/src/hooks/useHashRoute.ts`). Dark-only theme. Desktop app wraps it in Electron.

Shared UI primitives and reusable tiles. Buttons, chips, pills, dialogs are plain elements styled by classes in styles.css (`.btn`, `.btn.p` primary, `.btn.d` danger, `.btn.sm`, `.pill`, `.chip`, `.dialog`, `.modal`, `.row`, `.hint`, `.err`).

### `ui/src/components/Markdown.tsx`

```tsx
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The one way agent, ticket and forge text reaches the screen. Rendering, never execution:
 * raw HTML is skipped (no rehype-raw), images are not fetched (a tracking pixel in a ticket
 * would otherwise phone home from the operator's machine), and react-markdown's default URL
 * transform already neutralises `javascript:` links.
 */
const INLINE_ELEMENTS = ["strong", "em", "code", "a", "del", "br"];

export function Markdown({ text, inline, fileLinks }: {
  text: string; inline?: boolean; fileLinks?: { files: string[]; onOpen: (path: string) => void };
}) {
  const components: Components = {
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
    img: ({ src, alt }) => <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer">{alt || src}</a>,
    code: ({ children, className }) => {
      const s = String(children);
      if (!className && fileLinks?.files.includes(s)) {
        return <button type="button" className="filelink" onClick={() => fileLinks.onOpen(s)}>{s}</button>;
      }
      return <code className={className}>{children}</code>;
    },
    ...(inline ? { p: ({ children }) => <>{children}</> } : {}),
  };
  const Tag = inline ? "span" : "div";
  // Inline runs sit inside a sentence or a list item: block markup there (headings, lists,
  // fences) would nest invalidly, so it is unwrapped to its text.
  const inlineOnly = inline ? { allowedElements: INLINE_ELEMENTS, unwrapDisallowed: true } : {};
  return <Tag className={inline ? "md md-inline" : "md"}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components} {...inlineOnly}>{text}</ReactMarkdown></Tag>;
}
```

### `ui/src/components/ErrorCard.tsx`

```tsx
/** Commands the server's messages carry for the human to run (cleanup hints, mostly): a known
 *  tool at the start of a line or right after a colon, carrying at least one flag. Prose that
 *  merely mentions a tool ("not a git repository", "claude exited with code 1") is not one. */
const COMMAND = /(?:^|:[ \t]+)[ \t]*((?:git|gh|claude|npm) [^\n]*?[ \t]-\S[^\n]*)/gm;

export function splitError(text: string): { headline: string; details: string; commands: string[] } {
  const t = text.trim();
  const [first, ...more] = t.split("\n");
  const cut = first.search(/\.\s/);
  const headline = cut > 0 ? first.slice(0, cut + 1) : first;
  const details = [cut > 0 ? first.slice(cut + 1).trim() : "", ...more].filter(Boolean).join("\n").trim();
  return { headline, details, commands: [...t.matchAll(COMMAND)].map(m => m[1].trim()) };
}

/** A failure as a message: one readable headline, the rest on request, commands one click away. */
export function ErrorCard({ text, title, testId }: { text: string; title?: string; testId?: string }) {
  const { headline, details, commands } = splitError(text);
  return (
    <div className="errcard" role="alert" data-testid={testId}>
      {title && <div className="errcard-title">{title}</div>}
      <div className="errcard-head">{headline}</div>
      {details && <details><summary>Details</summary><pre className="errcard-details">{details}</pre></details>}
      {commands.map(c => (
        <div key={c} className="row">
          <code className="cmd">{c}</code>
          <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(c)}>Copy</button>
        </div>
      ))}
    </div>
  );
}
```

### `ui/src/components/DiffView.tsx`

```tsx
import { parseHunks } from "../bugView";

/**
 * Per-file slice of a unified diff, so each file can be expanded on its own. (Moved here from
 * BugPanel unchanged.) When the split can't isolate this file (a rename, or a header format that
 * doesn't literally name every path in `files[]`), fall back to the whole patch — flagged as
 * unisolated so the card never presents unrelated content as this file's diff.
 */
export function hunksFor(patch: string, file: string): { text: string; isolated: boolean } {
  const parts = patch.split(/^diff --git /m).slice(1);
  const hit = parts.find(p => p.split("\n")[0].trimEnd() === `a/${file} b/${file}`);
  return hit ? { text: `diff --git ${hit}`.trimEnd(), isolated: true } : { text: patch, isolated: false };
}

/** A patch as a diff: gutters, tinted rows, hunk dividers. No syntax highlighting (spec §10). */
export function DiffView({ patch }: { patch: string }) {
  const rows = parseHunks(patch);
  const multiFile = rows.filter(r => r.kind === "file").length > 1;
  return (
    <table className="diffview"><tbody>
      {rows.map((r, i) => {
        if (r.kind === "file") return multiFile ? <tr key={i} className="file"><td colSpan={3}>{r.text}</td></tr> : null;
        if (r.kind === "hunk") return <tr key={i} className="hunk"><td colSpan={3}>{r.context || " "}</td></tr>;
        if (r.kind === "note") return <tr key={i} className="note"><td colSpan={3}>{r.text}</td></tr>;
        return (
          <tr key={i} className={r.kind}>
            <td className="ln old">{r.oldNo ?? ""}</td>
            <td className="ln new">{r.newNo ?? ""}</td>
            <td className="code">{r.text}</td>
          </tr>
        );
      })}
    </tbody></table>
  );
}
```

### `ui/src/components/PlanView.tsx`

```tsx
import { planSections } from "../bugView";
import { Markdown } from "./Markdown";

/** The analyze stage's plan as the four blocks it is asked to have, rather than one document. */
export function PlanView({ markdown, files, onOpenFile }: { markdown: string; files?: string[]; onOpenFile?: (path: string) => void }) {
  const { sections, structured } = planSections(markdown);
  const fileLinks = files && onOpenFile ? { files, onOpen: onOpenFile } : undefined;
  return (
    <div className="plan">
      {!structured && <p className="hint">This plan doesn't follow the usual sections.</p>}
      {sections.map((s, i) => (
        <section key={i} className="plansec">
          {s.title && <h5>{s.title}</h5>}
          <Markdown text={s.body} fileLinks={fileLinks} />
        </section>
      ))}
    </div>
  );
}
```

### `ui/src/components/AgentTile.tsx`

```tsx
import type { Agent, Assignment, RoleDef, SessionInfo, SessionActivity } from "../types";
import { AssignBox } from "./AssignBox";
import { basename, elapsed, usd } from "../format";

export interface AgentTileProps {
  agent: Agent; role: RoleDef | undefined; assignment: Assignment | null; selected: boolean; index: number; recent?: string[];
  onSelect: (id: string) => void; onAssign: (id: string, prompt: string) => void;
  /** Set when the adopted session's process is currently running outside the grid. */ live?: SessionInfo | null;
  /** Transcript-derived activity (embedded terminal work shows up here). */ activity?: SessionActivity | null;
  /** Stage of this agent's in-flight bug-fix task, if any. */ bugStage?: string;
}

export function AgentTile({ agent, role, assignment, selected, index, recent, onSelect, onAssign, live, activity, bugStage }: AgentTileProps) {
  const a = assignment;
  const line = agent.state === "free" ? null
    : agent.state === "done" ? `✅ ${a?.outcome?.split("\n").filter(Boolean).at(-1) ?? "done"}`
    : agent.state === "failed" ? `❌ ${a?.error ?? "failed"}`
    : a?.activity ?? "";
  return (
    <div className={`tile ${selected ? "selected" : ""}`} data-state={agent.state} data-testid={`tile-${agent.id}`} onClick={() => onSelect(agent.id)}>
      {agent.state === "waiting" && <span className="badge">{a?.pending?.kind === "question" ? "question" : "needs you"}</span>}
      <span className="idx">{index < 9 ? index + 1 : ""}</span>
      <div className="hd">
        <div className="av">{role?.avatar ?? "🤖"}</div>
        <div><div className="name">{agent.displayName} — {agent.role}{agent.resumeSessionId && <span title="Continues an adopted Claude Code session"> 🔗</span>}</div><div className="repo">{basename(agent.repo)}</div></div>
        {bugStage && <span className="chip" data-testid="tile-bug-stage">{bugStage}</span>}
      </div>
      {a && <div className="tasktitle" title={a.prompt}>{a.prompt.split("\n")[0].slice(0, 90)}</div>}
      {!a && activity?.lastPrompt && <div className="tasktitle" title={activity.lastPrompt}>{activity.lastPrompt.split("\n")[0].slice(0, 90)}</div>}
      {line !== null && <div className="act">{agent.state === "working" && <span className="dot" />}{line}</div>}
      {agent.state === "free" && activity && activity.phase !== "unknown" && (
        <div className={`act phase ${activity.phase}`} data-testid="tile-phase">
          {activity.phase === "waiting" ? (activity.question ? "❓ asking you" : `⏸ needs approval: ${activity.pendingTool?.name ?? ""}`) : activity.phase === "working" ? "● working in terminal" : "○ idle — your turn"}
        </div>
      )}
      {agent.state === "free" && live && <div className="act dim" data-testid="live-note">🟢 live in {live.kind === "background" ? "background" : "terminal"} ({live.status}) — close it to assign, or use the Terminal tab</div>}
      {agent.state === "free" && !live && <AssignBox agentId={agent.id} recent={recent} onSubmit={onAssign} />}
      {a && <div className="ft"><span>#{a.id} · {elapsed(a.startedAt ?? a.createdAt)}{a.turns ? ` · ${a.turns} turns` : ""}</span><span>{usd(a.costUsd)}</span></div>}
    </div>
  );
}
```

### `ui/src/components/SessionTile.tsx`

```tsx
import { useState } from "react";
import type { RoleDef, SessionInfo } from "../types";
import { basename, elapsed } from "../format";

/** A live Claude Code session that isn't on the grid yet — shown so nothing running is invisible. */
export function SessionTile({ session, roles, onPullIn }: { session: SessionInfo; roles: RoleDef[]; onPullIn: (sessionId: string, role: string, takeover: boolean) => Promise<void> }) {
  const [role, setRole] = useState(roles[0]?.name ?? "coder");
  const [busy, setBusy] = useState(false);
  const bg = session.kind === "background";
  return (
    <div className="livecard" data-state={session.status} data-testid={`session-${session.sessionId}`}>
      <span className={`dot ${session.status}`} title={session.status} />
      <span className="kind">{bg ? "bg" : "tty"}</span>
      <span className="ltitle" title={session.sessionId}>{session.title}</span>
      <span className="lrepo" title={session.cwd}>{basename(session.cwd)}</span>
      <span className="lmeta">{session.status} · {elapsed(new Date(session.at).toISOString())}</span>
      <span className="lactions" onClick={e => e.stopPropagation()}>
        <select value={role} onChange={e => setRole(e.target.value)} aria-label="Role">{roles.map(r => <option key={r.name} value={r.name}>{r.avatar} {r.name}</option>)}</select>
        <button className="btn p sm" disabled={busy} title={bg ? "Put this background session on the grid (attach in the Terminal tab)" : "Close it in its terminal and continue it here"}
          onClick={async () => {
            if (!bg && !window.confirm(`Pull in "${session.title}"?\n\nThis closes the session in its terminal (Claude Code saves the conversation) and opens it in the grid's Terminal tab.`)) return;
            setBusy(true); try { await onPullIn(session.sessionId, role, !bg); } finally { setBusy(false); }
          }}>{busy ? "Pulling in…" : bg ? "Pull in" : "Pull in ↩"}</button>
      </span>
    </div>
  );
}
```

### `ui/src/components/PendingPrompt.tsx`

```tsx
import { useState } from "react";
import type { Decision, Pending } from "../types";

interface Q { question: string; header: string; multiSelect?: boolean; options: Array<{ label: string; description: string }> }

function summarise(input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.url ?? input.pattern;
  return typeof v === "string" ? v : JSON.stringify(input, null, 1).slice(0, 600);
}

export function PendingPrompt({ pending, onDecide }: { pending: Pending; onDecide: (d: Decision) => void }) {
  if (pending.kind === "permission") {
    return (
      <div className="qbox" data-testid="pending-permission">
        <div className="qtitle">Permission: {pending.toolName}</div>
        <pre className="cmd">{summarise(pending.input)}</pre>
        <div className="row">
          <button className="btn g" onClick={() => onDecide({ kind: "allow" })}>Allow</button>
          {pending.suggestions.length > 0 && <button className="btn" onClick={() => onDecide({ kind: "always" })}>Always allow</button>}
          <button className="btn d" onClick={() => onDecide({ kind: "deny" })}>Deny</button>
        </div>
      </div>
    );
  }
  return <QuestionPrompt questions={(pending.input.questions as Q[]) ?? []} onDecide={onDecide} />;
}

function QuestionPrompt({ questions, onDecide }: { questions: Q[]; onDecide: (d: Decision) => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState("");
  const single = questions.length === 1 && !questions[0].multiSelect;
  const answers = () => Object.fromEntries(Object.entries(picked).filter(([, v]) => v.length).map(([k, v]) => [k, v.join(", ")]));
  const complete = questions.every(q => (picked[q.question] ?? []).length > 0);
  const toggle = (q: Q, label: string) => {
    if (single) { onDecide({ kind: "answers", answers: { [q.question]: label } }); return; }
    setPicked(p => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });
  };
  const sendFree = () => { const t = free.trim(); if (!t) return; onDecide({ kind: "answers", answers: answers(), response: t }); };
  return (
    <div className="qbox" data-testid="pending-question">
      {questions.map(q => (
        <div key={q.question} className="q">
          <div className="qtitle"><span>{q.header}: </span><span>{q.question}</span></div>
          <div className="row">
            {q.options.map(o => (
              <button key={o.label} className={`btn ${(picked[q.question] ?? []).includes(o.label) ? "on" : ""}`} title={o.description} onClick={() => toggle(q, o.label)}>{o.label}</button>
            ))}
          </div>
        </div>
      ))}
      <div className="row">
        <input value={free} placeholder="or type an answer…" onChange={e => setFree(e.target.value)} onKeyDown={e => { if (e.key === "Enter") sendFree(); }} />
        {!single && <button className="btn p" disabled={!complete} onClick={() => onDecide({ kind: "answers", answers: answers() })}>Send</button>}
      </div>
    </div>
  );
}
```

### `ui/src/components/AssignBox.tsx`

```tsx
import { useState, type KeyboardEvent } from "react";

export function AssignBox({ agentId, recent = [], onSubmit }: { agentId: string; recent?: string[]; onSubmit: (agentId: string, prompt: string) => void }) {
  const [text, setText] = useState(""); const [showRecent, setShowRecent] = useState(false);
  const submit = () => { const t = text.trim(); if (!t) return; onSubmit(agentId, t); setText(""); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === "/" && text === "" && recent.length) { e.preventDefault(); setShowRecent(true); }
    else if (e.key === "Escape") setShowRecent(false);
  };
  return (
    <div className="assign" onClick={e => e.stopPropagation()}>
      <textarea rows={2} value={text} placeholder="Assign work… (⏎ to send, / for recent)" onChange={e => setText(e.target.value)} onKeyDown={onKey} />
      {showRecent && (
        <ul className="recent">{recent.map((r, i) => <li key={i} onClick={() => { setText(r); setShowRecent(false); }}>{r.slice(0, 80)}</li>)}</ul>
      )}
    </div>
  );
}
```
