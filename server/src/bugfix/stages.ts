import { Conflict } from "../store/store.js";
import { AGENT_STAGES, GATE_STAGES, SERVER_STAGES, TERMINAL_STAGES, type BugEvent, type BugStage, type BugTask, type GateKind, type Transition } from "./types.js";

const gate = (kind: GateKind): NonNullable<Transition["gate"]> => ({ kind, openedAt: new Date().toISOString() });
const go = (stage: BugStage, run: BugStage | null, note = "", error: string | null = null): Transition => ({ stage, run, gate: null, note, error });
const wait = (stage: BugStage, kind: GateKind, reason?: "feedback" | "rebase"): Transition =>
  ({ stage, run: null, gate: { ...gate(kind), ...(reason ? { reason } : {}) }, note: "", error: null });
/** A server stage: the engine runs it, so `run` stays null — `run` means "dispatch an agent". */
const serverRun = (stage: BugStage, note = ""): Transition => ({ stage, run: null, gate: null, note, error: null });

const MONITORING_ONLY: BugEvent["type"][] = ["review-changes-requested", "checks-failed", "review-approved", "conflicting", "pr-closed", "pr-merged"];

/**
 * The whole Phase 1 workflow in one pure function: given where a task is and what
 * happened, say where it goes and which stage (if any) the engine must now run.
 * Phase 2 adds the monitoring events; `monitoring` rests here.
 */
export function nextStage(task: BugTask, event: BugEvent): Transition {
  if (TERMINAL_STAGES.includes(task.stage) && event.type !== "retry") {
    throw new Conflict(`task ${task.id} is in terminal stage ${task.stage}`);
  }
  if (MONITORING_ONLY.includes(event.type) && task.stage !== "monitoring") {
    throw new Conflict(`${event.type} is only while monitoring (task is ${task.stage})`);
  }
  switch (event.type) {
    case "cancel":
      return go("cancelled", null);

    case "review-changes-requested": return go("review-feedback", "review-feedback", event.comments);
    case "checks-failed":            return go("review-feedback", "review-feedback", event.checks);
    case "review-approved":          return wait("approved", "merge");
    case "conflicting":              return go("rebase", "rebase");
    case "pr-closed":
      return { stage: "done", run: null, gate: null, note: "", outcome: "closed",
               error: "the pull request was closed without merging" };
    case "pr-merged": return serverRun("merging");

    case "stage-failed":
      // A gate stage isn't running anything — nothing dispatched for it, so nothing can
      // legitimately report it failed. Refusing here keeps the state machine from ever
      // landing a "failed" task whose last stage is a gate, which `retry` below could
      // otherwise be asked to resume by re-dispatching a stage `runStage` has no prompt for.
      if (GATE_STAGES.includes(task.stage)) throw new Conflict(`cannot fail ${task.stage}: it is waiting on a human, not on the agent`);
      return go("failed", null, "", event.reason);

    case "retry": {
      if (task.stage !== "failed") throw new Conflict(`can only retry a failed task (is ${task.stage})`);
      const last = [...task.history].reverse().find(h => h.stage !== "failed");
      if (!last) throw new Error("nothing to retry");
      // "intake" has no agent-dispatched prompt: its work (tracker fetch, worktree,
      // agent) runs synchronously inside `BugFixEngine.intake()`, before the task even
      // exists in the store — by the time a task record can be stuck at "intake", that
      // work is already done. Resuming it means finishing the transition to "analyzing",
      // not re-dispatching an "intake" stage that `renderStagePrompt` has no template for.
      if (last.stage === "intake") return go("analyzing", "analyzing", "", null);
      // Anything else must be an agent stage or a server stage: a gate stage has no prompt
      // either, and recovery/failure paths must never hand `runStage` a stage it can't dispatch.
      if (!AGENT_STAGES.includes(last.stage) && !SERVER_STAGES.includes(last.stage)) {
        throw new Conflict(`cannot retry: ${last.stage} is not a resumable stage`);
      }
      return SERVER_STAGES.includes(last.stage) ? serverRun(last.stage) : go(last.stage, last.stage, "", null);
    }

    case "approve": {
      if (!GATE_STAGES.includes(task.stage)) throw new Conflict(`cannot approve while ${task.stage}`);
      if (task.stage === "plan-review") return go("implementing", "implementing");
      if (task.stage === "approved") return serverRun("merging");
      // diff-review: a feedback or rebase round already has a PR, so approving means push;
      // the first time through, it means open the PR.
      return task.gate?.reason ? serverRun("pushing") : go("opening-pr", "opening-pr");
    }

    case "request-changes": {
      if (!GATE_STAGES.includes(task.stage)) throw new Conflict(`cannot request changes while ${task.stage}`);
      if (task.stage === "plan-review") return go("analyzing", "analyzing", event.text);
      if (task.stage === "approved") return go("review-feedback", "review-feedback", event.text);
      const back: BugStage = task.gate?.reason === "rebase" ? "rebase"
        : task.gate?.reason === "feedback" ? "review-feedback" : "implementing";
      return go(back, back, event.text);
    }

    case "stage-done": {
      if (GATE_STAGES.includes(task.stage)) throw new Conflict(`${task.stage} is waiting on a human, not on the agent`);
      switch (task.stage) {
        case "intake": return go("analyzing", "analyzing");
        case "analyzing": return wait("plan-review", "plan");
        case "implementing": return wait("diff-review", "diff");
        case "opening-pr": return go("monitoring", null);   // Phase 2 starts the watcher here
        case "review-feedback": return wait("diff-review", "diff", "feedback");
        case "rebase": return wait("diff-review", "diff", "rebase");
        case "pushing": return go("monitoring", null);
        // The one transition that means "this really merged": `doMerge` only reports stage-done
        // after re-reading the PR and finding MERGED, so this is the moment the server knows.
        case "merging": return { ...go("done", null), outcome: "merged" };
        default: throw new Error(`no transition from ${task.stage} on stage-done`);
      }
    }
  }
}
