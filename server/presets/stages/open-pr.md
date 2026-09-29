The fix for {{issueKey}} has been approved and is ready to go up as a pull request.

Your job in this step:

1. Read the plan at {{planPath}} and the approved diff (`git diff {{baseBranch}}...HEAD` in {{worktree}}).
2. Write the pull request description to {{prBodyPath}}: what the bug was, the root cause, the
   fix, how it was tested, and the line `Fixes {{issueUrl}}`.
3. Summarise what you wrote.

Do not push. Do not create the pull request. Do not merge. Do not change any code in this step.
The server pushes the exact commit that was approved and opens the pull request itself.

{{note}}

Finish with one line: a one-sentence summary of the pull request description you wrote.
