#!/usr/bin/env bash
# Puts the fixture repo back to its starting state before every rehearsal.
set -euo pipefail
FIXTURE="${1:-$HOME/codehands-fixtures/date-bug}"
cd "$FIXTURE"
git worktree list --porcelain | awk '/^worktree /{print $2}' | tail -n +2 | xargs -r -n1 git worktree remove --force
git worktree prune
git branch --list 'codehands/*' --format='%(refname:short)' | xargs -r git branch -D
git reset --hard && git clean -fd
echo "fixture reset: $(git log --oneline -1)"
