import { GATE_STAGES, TERMINAL_STAGES, type BugEvent, type BugStage, type BugTask, type GateKind, type Transition } from "./types.js";

const gate = (kind: GateKind): Transition["gate"] => ({ kind, openedAt: new Date().toISOString() });
const go = (stage: BugStage, run: BugStage | null, note = "", error: string | null = null): Transition => ({ stage, run, gate: null, note, error });
const wait = (stage: BugStage, kind: GateKind): Transition => ({ stage, run: null, gate: gate(kind), note: "", error: null });

/**
 * The whole Phase 1 workflow in one pure function: given where a task is and what
 * happened, say where it goes and which stage (if any) the engine must now run.
 * Phase 2 adds the monitoring events; `monitoring` rests here.
 */
export function nextStage(task: BugTask, event: BugEvent): Transition {
  if (TERMINAL_STAGES.includes(task.stage) && event.type !== "retry") {
    throw new Error(`task ${task.id} is in terminal stage ${task.stage}`);
  }
  switch (event.type) {
    case "cancel":
      return go("cancelled", null);

    case "stage-failed":
      return go("failed", null, "", event.reason);

    case "retry": {
      if (task.stage !== "failed") throw new Error(`can only retry a failed task (is ${task.stage})`);
      const last = [...task.history].reverse().find(h => h.stage !== "failed");
      if (!last) throw new Error("nothing to retry");
      return go(last.stage, last.stage, "", null);
    }

    case "approve": {
      if (!GATE_STAGES.includes(task.stage)) throw new Error(`cannot approve while ${task.stage}`);
      return task.stage === "plan-review" ? go("implementing", "implementing") : go("opening-pr", "opening-pr");
    }

    case "request-changes": {
      if (!GATE_STAGES.includes(task.stage)) throw new Error(`cannot request changes while ${task.stage}`);
      const back: BugStage = task.stage === "plan-review" ? "analyzing" : "implementing";
      return go(back, back, event.text);
    }

    case "stage-done": {
      if (GATE_STAGES.includes(task.stage)) throw new Error(`${task.stage} is waiting on a human, not on the agent`);
      switch (task.stage) {
        case "intake": return go("analyzing", "analyzing");
        case "analyzing": return wait("plan-review", "plan");
        case "implementing": return wait("diff-review", "diff");
        case "opening-pr": return go("monitoring", null);   // Phase 2 starts the watcher here
        default: throw new Error(`no transition from ${task.stage} on stage-done`);
      }
    }
  }
}
