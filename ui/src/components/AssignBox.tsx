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
