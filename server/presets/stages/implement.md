Continue the fix for {{issueKey}} in {{worktree}}, on branch {{branch}}.

The approved plan is at {{planPath}} — follow it; if reality contradicts it, say so in your summary.

Your branch was cut from {{baseRef}}. See what you have done with `git log --oneline {{baseRef}}..HEAD`
and `git diff {{baseRef}}...HEAD` — never against a local branch.

1. Write the plan's regression tests first, and run them: they must fail, for the reason the plan gives.
2. Make the change.
3. Run the regression tests again — they must pass — then the project's whole test suite.
4. Commit on {{branch}} with a message starting "{{issueKey}}: ".

**Do not push. Do not create a pull request.** The human reviews the diff first.

If you find there is nothing to change — the fix is already on {{baseRef}}, say — do not make an empty
or cosmetic commit. Leave the branch as it is, with nothing uncommitted, and give the evidence in your
summary. The task then closes as "no change needed" instead of opening a pull request.

{{note}}

## Before you finish: what you assumed

Write {{assumptionsPath}} — a JSON list of anything in this step you decided without being told, or could not decide and worked around:

[{ "kind": "assumption", "text": "One sentence: what you assumed and why." },
 { "kind": "question", "text": "One sentence: what the human should decide." }]

Only real decisions a reviewer might want to overturn. If there are none, write an empty list: []

Finish with a 2–3 line summary: what changed, what you verified, what is left — and list each regression
test as "<test> — failed before, passes after".
