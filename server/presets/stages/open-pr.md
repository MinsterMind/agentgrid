The fix for {{issueKey}} has been approved and is ready to go up as a pull request.

{{freshStart}}

Your job in this step:

1. Read the plan at {{planPath}}, the commits going up (`git log --oneline {{baseRef}}..HEAD` in {{worktree}})
   and the approved diff (`git diff {{baseRef}}...HEAD`). Compare against {{baseRef}} only — a local branch
   can be stale and make the diff look like the whole repository.
2. Write the pull request description to {{prBodyPath}}: what the bug was, the root cause, the
   fix, how it was tested, and the line `Fixes {{issueUrl}}`.
3. Summarise what you wrote.

Do not push. Do not create the pull request. Do not merge. Do not change any code in this step.
The server pushes the exact commit that was approved and opens the pull request itself.

{{note}}

Finish with one line: a one-sentence summary of the pull request description you wrote.
