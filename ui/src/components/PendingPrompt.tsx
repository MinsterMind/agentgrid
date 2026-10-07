import { useState } from "react";
import type { Decision, Pending, PermissionRequest } from "../types";

interface Q { question: string; header: string; multiSelect?: boolean; options: Array<{ label: string; description: string }> }

export function summarise(input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.url ?? input.pattern;
  return typeof v === "string" ? v : JSON.stringify(input, null, 1).slice(0, 600);
}

/** A pending tool request in plain words — what the agent wants to do, not which API it calls. */
export function describeRequest(toolName: string): string {
  if (toolName === "Bash") return "wants to run a shell command";
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName)) return "wants to change a file";
  if (toolName === "WebFetch" || toolName === "WebSearch") return "wants to look something up online";
  return `wants to use ${toolName}`;
}

/** A terminal permission request, as the card's Pending — one card for both kinds of request. */
export const asPending = (r: PermissionRequest): Pending =>
  ({ kind: "permission", toolUseId: r.id, toolName: r.toolName, input: r.input, suggestions: [], suggestedRule: r.suggestedRule, ruleIsBroad: r.ruleIsBroad });

/**
 * "Always allow <rule>": saves the rule on the server for every agent. A broad rule (every shell command,
 * every file change) takes a second, inline click — never a browser dialog, which would block the app.
 * `armed`/`setArmed` live with the card, so a click anywhere else on it backs out.
 */
export function AlwaysAllow({ pending, onDecide, armed, setArmed, small }: { pending: Pending; onDecide: (d: Decision) => void; armed: boolean; setArmed: (v: boolean) => void; small?: boolean }) {
  const what = pending.toolName === "Bash" ? "shell command" : "file change";
  return (
    <button className={`btn always ${small ? "sm" : ""} ${armed ? "d" : ""}`} title={`Saved for every agent — remove it in Settings → Always allowed`}
      onClick={e => { e.stopPropagation(); if (pending.ruleIsBroad && !armed) { setArmed(true); return; } setArmed(false); onDecide({ kind: "always" }); }}>
      {armed ? `Confirm: always allow every ${what}` : `Always allow ${pending.suggestedRule}`}
    </button>
  );
}

export function PendingPrompt({ pending, onDecide, who }: { pending: Pending; onDecide: (d: Decision) => void; who?: string }) {
  const [armed, setArmed] = useState(false);
  if (pending.kind === "permission") {
    return (
      <div className="qbox" data-testid="pending-permission" onClick={() => setArmed(false)}>
        <div className="qtitle">{who ? `${who} ${describeRequest(pending.toolName)}` : describeRequest(pending.toolName).replace(/^wants/, "Wants")}</div>
        <pre className="cmd">{summarise(pending.input)}</pre>
        <div className="row">
          <button className="btn p" onClick={() => onDecide({ kind: "allow" })}>Allow</button>
          {pending.suggestedRule && <AlwaysAllow pending={pending} onDecide={onDecide} armed={armed} setArmed={setArmed} />}
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
