import type { RunnerEvent, StartOptions } from "@codehands/contracts";
import type { EventSequence } from "../events.js";

// Week 1 guide, section 4. Flags checked against Claude Code 2.1.280.

const ALLOWED_TOOLS = "Read,Edit,Write,Glob,Grep,Bash(npm test:*)";

export function claudeArgs(o: StartOptions, notes?: string): string[] {
  const args = [
    "-p", o.prompt,
    "--session-id", o.sessionId,
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", ALLOWED_TOOLS,
    "--max-budget-usd", String(o.budgetUsd ?? 0.5),
  ];
  if (o.model) args.push("--model", o.model);
  if (notes) args.push("--append-system-prompt", notes);
  return args;
}

export function claudeResumeArgs(sessionId: string, prompt: string, budgetUsd = 0.5): string[] {
  return [
    "-p", prompt,
    "--resume", sessionId,
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", ALLOWED_TOOLS,
    "--max-budget-usd", String(budgetUsd),
  ];
}

// TODO(Tue): read every line of test/fixtures/spike-1.jsonl first, then map:
//   system/init               -> task.started
//   assistant text            -> message
//   assistant tool_use Read   -> file.read
//   assistant tool_use Edit/Write -> file.changed
//   assistant tool_use Bash   -> command.started
//   user tool_result          -> command.finished (+ test.result for the test command)
//   result                    -> task.finished with total_cost_usd and usage exactly as given
// A line that is not JSON becomes a `message` with the raw text. Always keep `raw`.
// One line can hold several content blocks, so this returns a list.
export function parseClaudeLine(_line: string, _seq: EventSequence): RunnerEvent[] {
  throw new Error("not implemented: parseClaudeLine (Tue)");
}
