The diff for {{issueKey}} has been approved. Open the pull request from {{worktree}}.

1. Write the PR description to {{prBodyPath}}: what the bug was, the root cause, the fix, how it was tested, and the line `Fixes {{issueUrl}}`.
2. Push the branch: `git push -u origin {{branch}}`
3. Create the PR with exactly this command:
   {{createPrCommand}}
4. Write {{artifactsDir}}/pr.json as {"number": <number>, "url": "<url>"} using the PR the command printed.

Do not land this yourself — a human takes it from here. Do not change any code in this step.

{{note}}

Finish with one line: the PR URL.
