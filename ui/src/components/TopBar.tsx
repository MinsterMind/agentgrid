import type { AgentState } from "../types";
import { usd } from "../format";

export function TopBar({ counts, spend, connected, waitingCount, onCycleWaiting, onSpawn }: {
  counts: Record<AgentState, number>; spend: number; connected: boolean; waitingCount: number; onCycleWaiting: () => void; onSpawn: () => void;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <header className="topbar">
      <span className="brand">⬢ AgentGrid</span>
      <span className="pill">{total} agents</span>
      <div className="sum">
        <span className="pill">● {counts.working} working</span>
        <button className={`pill w ${waitingCount ? "hot" : ""}`} onClick={onCycleWaiting} disabled={!waitingCount}>● {waitingCount} need you</button>
        <span className="pill">● {counts.done} done</span>
        {counts.failed > 0 && <span className="pill f">● {counts.failed} failed</span>}
        <span className="pill">○ {counts.free} free</span>
        <span className="pill">{usd(spend)} today</span>
        {!connected && <span className="pill f">disconnected</span>}
      </div>
      <button className="btn p" onClick={onSpawn}>+ Spawn</button>
    </header>
  );
}
