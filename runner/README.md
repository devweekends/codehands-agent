# codehands-runner

Given a repo and a prompt, the runner makes a private copy of the repo (a git worktree on a new branch). It runs Claude Code or Codex there with no screen and turns their output into events. Someone can then stop, resume, approve or reject the change.

Owner: Tahira · Consumed by: the daemon in `codehands-cli` (Midhat) · Contract: [`codehands-contracts`](../codehands-contracts)

## Layout

| Path | What | When |
| --- | --- | --- |
| `src/fake-runner.ts` | Stand-in that emits 12 events, 300 ms apart. Midhat plugs it in today. Also the demo backup | Mon, done |
| `src/session-store.ts` | Session records and the legal state moves | Mon, done |
| `src/events.ts` | `seq` 1, 2, 3 … per session | Mon, done |
| `src/agents/claude-code.ts` | `claude -p` arguments, done. Stream-json line → events, to do | Tue |
| `src/git/worktree.ts` | Branch names, done. Worktree add, remove and prune, to do | Tue, Wed |
| `src/runner.ts` | `start`, then `diff`, `approve`, `reject`, `stop`, then `resume` | Tue to Thu |
| `src/git/diff.ts` | `git add -A`, `diff --cached --binary`, commit | Wed |
| `src/process/kill-tree.ts` | Stop politely, then kill the whole process tree | Wed |
| `src/agents/codex.ts` | `codex exec --json` → events | Thu pm, Fri |
| `src/memory/notes.ts` | Per-repo notes in, a summary appended after each run | Fri |
| `scripts/spike.sh` | Monday's hand spike, saves `test/fixtures/spike-1.jsonl` | Mon |
| `scripts/reset-fixture.sh` | Puts the fixture repo back to its starting state before a rehearsal | Wed night |

## Run it

Clone `codehands-contracts` next to this repo and build it first:

```bash
cd ../codehands-contracts && pnpm install && pnpm build
cd ../codehands-runner && pnpm install
pnpm test        # parser tests replay recorded JSONL, no API cost
pnpm fake        # print the fake runner's events
```

Add the runtime dependencies when you start on Tuesday: `pnpm add execa tree-kill`.

## Rules this week

- Only run on our own repos. There is no sandbox until week 2.
- `acceptEdits` plus a short `--allowedTools` list. Never use `--dangerously-skip-permissions`. Always pass `--max-budget-usd`.
- API keys never go into events, logs or the diff.

The full week is in `codehands-docs/weeks/week-1/tahira.md`.
