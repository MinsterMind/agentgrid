import { ArrowDownToLine, Bug, Check, Plus, TerminalSquare, TriangleAlert } from "lucide-react";
import type { SetupReport } from "../types";

const CHECKS = [["tracker", "Tracker"], ["forge", "Forge"], ["role", "Bug fixer role"]] as const;

/** What a new user sees: the app in one line, three ways to start, and the colour language. */
export function FirstRun({ liveSessions, setup, onNewAgent, onSessions, onFixBug, onOpenSettings }: {
  liveSessions: number; setup: SetupReport | null; onNewAgent: () => void; onSessions: () => void; onFixBug: () => void; onOpenSettings: () => void;
}) {
  const checks = CHECKS.map(([id, label]) => ({ id, label, c: setup?.checks.find(x => x.id === id) })).filter(x => x.c);
  const missing = checks.some(x => x.c!.state !== "ok");
  return (
    <div className="first">
      <main className="hero">
        <div className="ghosts" aria-hidden><div className="ghost w" /><div className="ghost n" /><div className="ghost d" /><div className="ghost" /></div>
        <h1>Run several Claude Code agents side by side.</h1>
        <p className="lead">Each agent works in its own repo. AgentGrid shows them all at once, and pulls you in only when one needs a decision.</p>
        <div className="starts">
          <div className="start">
            <span className="ic c-working"><Plus /></span><h3>Start a new agent</h3>
            <p>Pick a role and a repo. It starts on whatever you assign and asks before any risky command.</p>
            <button className="btn p" onClick={onNewAgent}><Plus /> Create an agent</button>
          </div>
          <div className="start">
            <span className="ic c-accent"><ArrowDownToLine /></span><h3>Pull in a running session</h3>
            <p>{liveSessions > 0 ? <>Claude Code is already open in {liveSessions} terminal{liveSessions === 1 ? "" : "s"} on this Mac. Bring one here to watch and answer it.</>
              : <>Claude Code sessions you start in a terminal appear here — none open right now.</>}</p>
            <button className="btn" disabled={liveSessions === 0} onClick={onSessions}><TerminalSquare /> Show sessions</button>
          </div>
          <div className="start">
            <span className="ic c-waiting"><Bug /></span><h3>Fix a bug from a ticket</h3>
            <p>Turn a Jira ticket into a merged pull request. You approve the plan, the diff and the merge.</p>
            <button className="btn" onClick={onFixBug}><Bug /> Start a bug fix</button>
          </div>
        </div>
        {checks.length > 0 && (
          <div className="ready">
            <span className="ready-lbl">Before you start</span>
            {checks.map(({ id, label, c }) => (
              <span key={id} className={`chip ${c!.state === "ok" ? "green" : "amber"}`}>{c!.state === "ok" ? <Check /> : <TriangleAlert />} {label}</span>
            ))}
            {missing && <button className="btn sm" onClick={onOpenSettings}>Fix it</button>}
            <span className="help">— only needed for bug fixes</span>
          </div>
        )}
      </main>
      <aside className="side how" aria-label="How AgentGrid works">
        <h4>How AgentGrid works</h4>
        <ol>
          <li><span className="n c">1</span><div><b>Agents work on their own</b><p>Working agents glow cyan with a moving edge. You don't need to watch them.</p></div></li>
          <li><span className="n a">2</span><div><b>One needs you, it glows amber</b><p>A permission or a question. The NEEDS YOU counter lights up and you get a notification.</p></div></li>
          <li><span className="n g">3</span><div><b>You answer, it carries on</b><p>Allow, deny or reply right on its card. Press <kbd>A</kbd> or <kbd>D</kbd> without leaving the keyboard.</p></div></li>
        </ol>
      </aside>
    </div>
  );
}
