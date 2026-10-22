import type { RunnerEvent } from "@codehands/contracts";
import type { EventSequence } from "../events.js";

// Week 1 guide, section 5. After the Thursday demo.
// codex exec --json -C <worktree> -s workspace-write -m <model> "<prompt>"
// codex exec resume <thread_id> --json "<prompt>"
// Save thread_id from `thread.started` for resume. Codex reports tokens, not dollars.

// TODO(Thu pm): capture test/fixtures/codex-spike.jsonl first, then map its items to RunnerEvents.
export function parseCodexLine(_line: string, _seq: EventSequence): RunnerEvent[] {
  throw new Error("not implemented: parseCodexLine (Thu)");
}
