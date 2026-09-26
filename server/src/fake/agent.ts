import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { QueryFn } from "../runner/runner.js";

const run = promisify(execFile);

/**
 * What a fake agent should do for the stage prompt it was handed. The markers are the
 * instructions the stage presets actually give ("Write your plan to …"), because the fake
 * has no other channel to learn its stage — the server hands agents a prompt, not a verb.
 * `detectStage` is exported and unit-tested against the real preset files so that rewording
 * a preset fails loudly here instead of silently making fake mode do nothing again.
 */
export type FakeStage = "analyze" | "implement" | "open-pr" | "other";

const PLAN_PATH = /write your plan to (\S+)/i;
const PR_BODY_PATH = /write the pr description to (\S+?)[:\s]/i;
const APPROVED_PLAN = /the approved plan is at (\S+)/i;

export function detectStage(prompt: string): { stage: FakeStage; planPath?: string; prBodyPath?: string } {
  const plan = PLAN_PATH.exec(prompt);
  if (plan) return { stage: "analyze", planPath: plan[1] };
  const prBody = PR_BODY_PATH.exec(prompt);
  if (prBody) return { stage: "open-pr", prBodyPath: prBody[1] };
  const approved = APPROVED_PLAN.exec(prompt);
  if (approved) return { stage: "implement", planPath: approved[1] };
  return { stage: "other" };
}

const PLAN = `## Root cause

The fake tracker's ticket describes a fault this fixture reproduces on demand.

## Fix

Add a line to a file so the stage has something real to commit and diff.

## Files to touch

- \`fake-fix.txt\`

## Tests

None — this is a fake agent used to exercise the workflow offline.

## Risks

Nothing: the change is confined to the task's own worktree.
`;

/** Commit inside the worktree. `-c` rather than `config` so a machine with no git identity still works. */
async function commitSomething(cwd: string): Promise<void> {
  await writeFile(path.join(cwd, "fake-fix.txt"), `fixed by the fake agent at ${new Date().toISOString()}\n`);
  await run("git", ["add", "-A"], { cwd });
  await run("git", ["-c", "user.email=fake@agentgrid.invalid", "-c", "user.name=AgentGrid fake agent",
    "commit", "-m", "fix: the fake agent's change"], { cwd });
}

/**
 * The fake mode agent. For a bug-fix stage it does the minimum the *server* verifies —
 * writes the plan, makes a real commit, writes the PR body — so the whole flow can run
 * without Jira, without gh and without a model. For anything else it keeps the original
 * canned behaviour, including parking once on a permission request, which is what the
 * plain fake-mode demo and the terminal smoke test rely on.
 *
 * Deliberately: it never commits during open-pr. The server pins the commit the human
 * approved at the diff gate, and a fake that moved HEAD there would trip that guard —
 * which is exactly the behaviour the guard exists for, and not what this fixture is for.
 */
export const fakeAgentQuery: QueryFn = ({ prompt, options }) => (async function* () {
  const { stage, planPath, prBodyPath } = detectStage(prompt);
  const cwd = (options.cwd as string | undefined) ?? process.cwd();
  yield { type: "system", subtype: "init", session_id: `fake-${Date.now()}` } as any;

  if (stage === "other") {
    yield { type: "assistant", message: { content: [{ type: "text", text: "Thinking about it…" }] } } as any;
    const r = await options.canUseTool!("Bash", { command: "echo hi" }, { signal: options.abortController!.signal, toolUseID: `tu-${Date.now()}` } as any);
    if (r!.behavior === "deny") { yield { type: "result", subtype: "error_during_execution", num_turns: 1, total_cost_usd: 0.01, duration_ms: 1, is_error: true } as any; return; }
    yield { type: "result", subtype: "success", result: "All done (fake).", num_turns: 2, total_cost_usd: 0.02, duration_ms: 1, is_error: false } as any;
    return;
  }

  let summary = "";
  try {
    if (stage === "analyze" && planPath) {
      await writeFile(planPath, PLAN);
      summary = `Wrote the plan to ${planPath} (fake).`;
    } else if (stage === "implement") {
      await commitSomething(cwd);
      summary = "Committed the fix (fake).";
    } else if (stage === "open-pr" && prBodyPath) {
      await writeFile(prBodyPath, "Fake PR body: what broke, why, and how this fixture fixed it.\n");
      await writeFile(path.join(path.dirname(prBodyPath), "pr.json"), JSON.stringify({ number: 1, url: "https://example.invalid/pr/1" }));
      summary = "Wrote the PR description (fake); the forge reports the pull request.";
    }
  } catch (err) {
    // Report it the way a real agent would: a failed run the server can verify and fail on,
    // rather than a silent success that leaves the stage looking mysteriously unverifiable.
    yield { type: "assistant", message: { content: [{ type: "text", text: `Fake agent failed: ${(err as Error).message}` }] } } as any;
    yield { type: "result", subtype: "error_during_execution", num_turns: 1, total_cost_usd: 0.01, duration_ms: 1, is_error: true } as any;
    return;
  }

  yield { type: "assistant", message: { content: [{ type: "text", text: summary }] } } as any;
  yield { type: "result", subtype: "success", result: summary, num_turns: 2, total_cost_usd: 0.02, duration_ms: 1, is_error: false } as any;
})();
