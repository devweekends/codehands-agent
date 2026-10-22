#!/usr/bin/env bash
# Monday spike (week 1 guide, section 3). Run by hand, then read every line of the output.
set -euo pipefail
FIXTURE="${1:-$HOME/codehands-fixtures/date-bug}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/test/fixtures/spike-1.jsonl"

cd "$FIXTURE"
git worktree add -b codehands/spike-1 ../wt-spike-1 HEAD
cd ../wt-spike-1
claude -p "Fix the failing test. Run npm test to check." \
  --output-format stream-json --verbose \
  --permission-mode acceptEdits --allowedTools "Bash(npm test:*)" \
  --max-budget-usd 0.50 > "$OUT"
echo "saved $OUT ($(wc -l < "$OUT") lines)"
