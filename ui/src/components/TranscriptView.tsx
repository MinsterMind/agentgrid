import { useEffect, useRef, useState } from "react";
import type { Agent } from "../types";
import { api, type TranscriptEntry } from "../api";

const time = (ts: string) => { const d = new Date(ts); return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };

/** Full session transcript for an agent — the same conversation you'd see in the terminal. */
export function TranscriptView({ agent, activity, onClose }: { agent: Agent; activity: string; onClose: () => void }) {
  const [data, setData] = useState<{ sessionId: string | null; entries: TranscriptEntry[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const live = agent.state === "working" || agent.state === "waiting";

  useEffect(() => {
    let alive = true;
    api.agentTranscript(agent.id).then(d => { if (alive) { setData(d); setErr(null); } }).catch(e => alive && setErr((e as Error).message));
    return () => { alive = false; };
  }, [agent.id, activity, agent.state]);

  useEffect(() => { if (follow && typeof bottom.current?.scrollIntoView === "function") bottom.current.scrollIntoView({ block: "end" }); }, [data, follow]);

  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog wide tx" onClick={e => e.stopPropagation()}>
        <div className="hd">
          <h3 style={{ margin: 0 }}>{agent.displayName} — transcript</h3>
          <span className="dim" style={{ marginLeft: 8 }}>{data?.sessionId ? `session ${data.sessionId.slice(0, 8)}…` : ""}{live ? " · live" : ""}</span>
          <label className="dim" style={{ marginLeft: "auto", fontSize: 11 }}><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} /> follow</label>
          <button className="btn sm" onClick={onClose}>✕</button>
        </div>
        {err && <div className="err">{err}</div>}
        <div className="tx-body">
          {!data && !err && <p className="hint">Loading…</p>}
          {data && !data.sessionId && <p className="hint">No session yet — assign a task to start one.</p>}
          {data?.entries.map((e, i) => (
            <div key={i} className={`tx-entry ${e.role} ${e.kind}`} data-testid="tx-entry" data-role={e.role} data-kind={e.kind}>
              <span className="tx-ts">{time(e.ts)}</span>
              {e.kind === "text" && <div className="tx-text"><span className="tx-who">{e.role === "user" ? "you" : "claude"}</span>{e.text}</div>}
              {e.kind === "tool_use" && (
                <details className="tx-tool"><summary>🛠 {e.tool ?? e.text.split(":")[0]} <span className="dim">{e.text.slice((e.tool ?? "").length + 2, 140)}</span></summary>
                  <pre>{typeof e.input === "object" && e.input !== null && Object.keys(e.input as object).length ? JSON.stringify(e.input, null, 2) : e.text}</pre></details>
              )}
              {e.kind === "tool_result" && (
                <details className="tx-result"><summary>↳ result <span className="dim">{e.text.split("\n")[0].slice(0, 120)}</span></summary><pre>{e.text}</pre></details>
              )}
            </div>
          ))}
          <div ref={bottom} />
        </div>
      </div>
    </div>
  );
}
