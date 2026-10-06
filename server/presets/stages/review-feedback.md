Reviewers have asked for changes on the pull request for {{issueKey}}.

{{noteFraming}}

{{note}}

Your job in this step:

1. Read the feedback and the current diff (`git diff {{baseRef}}...HEAD`, after `git fetch origin {{baseBranch}}`).
2. Make the changes it asks for, in {{worktree}}, on the branch {{branch}}.
3. Run whatever tests cover what you changed.
4. Commit, with a message saying what the feedback was and what you did about it.
5. Summarise, point by point, how each piece of feedback was addressed — or why it was not.

## Before you finish: what you assumed

Write {{assumptionsPath}} — a JSON list of anything in this step you decided without being told, or could not decide and worked around:

[{ "kind": "assumption", "text": "One sentence: what you assumed and why." },
 { "kind": "question", "text": "One sentence: what the human should decide." }]

Only real decisions a reviewer might want to overturn. If there are none, write an empty list: []

Do not push. Do not merge. Do not change the branch you are on. A human reviews your diff
before anything reaches the pull request.
