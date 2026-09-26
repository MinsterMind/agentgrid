#!/bin/sh
# Print the path of a throwaway git repo the bug-fix e2e can work in: one commit and an
# `origin` remote, because intake refuses a repo with no remote. The remote is unreachable
# on purpose — nothing in fake mode pushes to it.
set -e
R=$(mktemp -d)
git init -q -b main "$R"
git -C "$R" config user.email e2e@agentgrid.invalid
git -C "$R" config user.name "AgentGrid e2e"
echo "# e2e fixture" > "$R/README.md"
git -C "$R" add -A
git -C "$R" commit -qm "init"
git -C "$R" remote add origin git@example.invalid:acme/fixture.git
printf %s "$R"
