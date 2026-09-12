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
