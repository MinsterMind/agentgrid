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
          <GitPullRequestArrow /> Bugs{bugsWaiting > 0 && <span className="chip amber badge-n">{bugsWaiting}<span className="sr-only"> waiting</span></span>}
        </button>
      </nav>
      <div className="counters">
        <Counter n={counts.working} label="Working" cls="c-working" />
        <button className={`counter c-needs-you ${waitingCount ? "hot" : "zero"}`} disabled={!waitingCount} onClick={onCycleWaiting}
          aria-label={`${waitingCount} Needs you`} title={waitingCount ? "Jump to the next agent that needs you" : "Nothing needs you"}>
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
