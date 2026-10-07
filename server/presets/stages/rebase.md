The pull request for {{issueKey}} conflicts with {{baseBranch}} and cannot be merged.

{{conflictFiles}}

{{note}}

Your job in this step, in {{worktree}}:

1. Fetch the latest: `git fetch origin {{baseBranch}}`.
2. Rebase {{branch}} onto {{baseRef}} (origin's copy — never a local {{baseBranch}}, which may be stale).
3. Resolve every conflict. Keep the intent of both sides: the fix this branch makes, and
   whatever changed on {{baseBranch}} underneath it.
4. Leave no conflict markers, and finish the rebase — `git status` must be clean.
5. Run whatever tests cover the areas you touched.
6. Summarise what conflicted and how you resolved it.

## Before you finish: what you assumed

Write {{assumptionsPath}} — a JSON list of anything in this step you decided without being told, or could not decide and worked around:

[{ "kind": "assumption", "text": "One sentence: what you assumed and why." },
 { "kind": "question", "text": "One sentence: what the human should decide." }]

Only real decisions a reviewer might want to overturn. If there are none, write an empty list: []

Do not push. Do not merge. A human reviews the rebased diff before anything reaches the
pull request, and the server force-pushes with a lease only after that approval.
