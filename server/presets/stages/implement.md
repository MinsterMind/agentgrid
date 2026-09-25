Continue the fix for {{issueKey}} in {{worktree}}, on branch {{branch}}.

The approved plan is at {{planPath}} — follow it; if reality contradicts it, say so in your summary.

1. Make the change.
2. Add or update tests that fail before your fix and pass after it.
3. Run the project's tests and make sure they pass.
4. Commit on {{branch}} with a message starting "{{issueKey}}: ".

**Do not push. Do not create a pull request.** The human reviews the diff first.

{{note}}

Finish with a 2–3 line summary: what changed, what you verified, what is left.
