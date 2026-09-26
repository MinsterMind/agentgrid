#!/bin/sh
# Print the path of a throwaway git repo the bug-fix e2e can work in: one commit and an
# `origin` remote, because intake refuses a repo with no remote. The remote is a real local
# bare repo (no network), not an unreachable ssh URL — Task 12's e2e walks a feedback round
# through to approval, and the server pushes for real (`engine.doPush` runs a real `git push`
# even in fake mode), so the remote has to actually be reachable or that push — and the
# e2e — would fail.
set -e
BARE=$(mktemp -d)
git init -q --bare -b main "$BARE"
R=$(mktemp -d)
git init -q -b main "$R"
git -C "$R" config user.email e2e@agentgrid.invalid
git -C "$R" config user.name "AgentGrid e2e"
echo "# e2e fixture" > "$R/README.md"
git -C "$R" add -A
git -C "$R" commit -qm "init"
git -C "$R" remote add origin "$BARE"
git -C "$R" push -q -u origin main
printf %s "$R"
