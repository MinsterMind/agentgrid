import { stageLabel } from "../bugView";
import type { BugTask } from "../types";
import { BugGates } from "./BugGates";

/** The compact view in the side panel: the ticket, where it is, and the gate actions. The whole
 *  workflow lives on the bug screen (`#/bugs/<id>`). */
export function BugPanel({ task, onChanged, onTranscript }: { task: BugTask; onChanged: (t: BugTask) => void; onTranscript?: (agentId: string) => void }) {
  return (
    <div className="bugpanel" data-testid="bug-panel">
      <div className="bughead">
        <a className="bugkey" href={task.issue.url} target="_blank" rel="noreferrer">{task.issue.key}</a>
        <span className="bugtitle">{task.issue.title}</span>
      </div>
      <div className="row dim">
        <span data-testid="bug-stage" data-stage={task.stage} className={`chip ${task.stage}`}>{stageLabel(task.stage)}</span>
        <span>{task.issue.priority}</span>
        <code>{task.branch}</code>
        {task.pr && <a href={task.pr.url} target="_blank" rel="noreferrer">PR #{task.pr.number}</a>}
        <span style={{ marginLeft: "auto" }}>${task.costUsd.toFixed(2)}</span>
      </div>
      <a className="fullview" href={`#/bugs/${task.id}`}>Open full view →</a>
      <BugGates task={task} onChanged={onChanged} onTranscript={onTranscript} />
    </div>
  );
}
