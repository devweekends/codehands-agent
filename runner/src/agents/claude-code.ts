import type { RunnerEvent, StartOptions } from "@codehands/contracts";
import type { EventSequence } from "../events.js";

// Week 1 guide, section 4. Flags checked against Claude Code 2.1.280.

// Claude picks PowerShell on Windows, so both shells get the same one command.
// --strict-mcp-config keeps the user's own connectors (Gmail, GitHub …) out of agent runs.
const ALLOWED_TOOLS = "Read,Edit,Write,Glob,Grep,Bash(npm test:*),PowerShell(npm test:*)";

export function claudeArgs(o: StartOptions, notes?: string): string[] {
  const args = [
    "-p", o.prompt,
    "--session-id", o.sessionId,
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", ALLOWED_TOOLS,
    "--strict-mcp-config",
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
    "--strict-mcp-config",
    "--max-budget-usd", String(budgetUsd),
  ];
}

// Mapping, checked against test/fixtures/spike-1.jsonl (recorded Oct 22):
//   system/init                     -> task.started
//   system/permission_denied        -> message with denied: true (no contract event for it yet)
//   assistant text                  -> message
//   assistant tool_use Read/Glob/Grep -> file.read
//   assistant tool_use Edit/Write   -> file.changed
//   assistant tool_use Bash/PowerShell -> command.started (Claude uses PowerShell on Windows)
//   user tool_result for a command  -> command.finished (+ test.result for a test command)
//   result                          -> task.finished, or task.failed when it is an error.
//                                      total_cost_usd and usage exactly as given
// Skipped: rate_limit_event (can come before init), thinking, other system lines.
// A line that is not JSON becomes a `message` with the raw text. Always keep `raw`.
// One line can hold several content blocks, so this returns a list.

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const CHANGE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);
const TEST_COMMAND = /\b(npm|pnpm|yarn)( run)? test\b|\bnode --test\b|\b(vitest|jest|pytest)\b/;
// Exit codes can hide behind a pipe (`npm test | tail`), so the output is checked too.
const TEST_FAILED = /^# fail [1-9]|\b[1-9]\d* (failed|failing)\b|^FAIL\b/m;

// Results can arrive out of order, so a tool_result is matched to its tool_use by id.
export interface ClaudeParseState {
  tools: Map<string, { name: string; command?: string }>;
  denied: Set<string>;      // tool_use ids that were blocked and never ran
}

export function newClaudeParseState(): ClaudeParseState {
  return { tools: new Map(), denied: new Set() };
}

type Json = Record<string, any>;

export function parseClaudeLine(line: string, seq: EventSequence, state = newClaudeParseState()): RunnerEvent[] {
  if (!line.trim()) return [];
  let o: Json;
  try {
    o = JSON.parse(line);
  } catch {
    return [seq.next("message", { text: line }, line)];
  }

  if (o.type === "system" && o.subtype === "init") {
    return [seq.next("task.started", {
      agent: "claude-code", model: o.model, cwd: o.cwd, agentSessionId: o.session_id, permissionMode: o.permissionMode,
    }, o)];
  }

  if (o.type === "system" && o.subtype === "permission_denied") {
    if (o.tool_use_id) state.denied.add(o.tool_use_id);
    return [seq.next("message", { text: `Blocked: ${o.message}`, denied: true, tool: o.tool_name }, o)];
  }

  if (o.type === "assistant") {
    return blocks(o).flatMap((b): RunnerEvent[] => {
      if (b.type === "text" && b.text) return [seq.next("message", { text: b.text }, o)];
      if (b.type !== "tool_use") return [];
      const input: Json = b.input ?? {};
      state.tools.set(b.id, { name: b.name, command: input.command });
      if (READ_TOOLS.has(b.name)) {
        return [seq.next("file.read", { path: input.file_path ?? input.path ?? ".", pattern: input.pattern, tool: b.name }, o)];
      }
      if (CHANGE_TOOLS.has(b.name)) {
        return [seq.next("file.changed", { path: input.file_path ?? input.notebook_path, tool: b.name }, o)];
      }
      if (COMMAND_TOOLS.has(b.name)) {
        return [seq.next("command.started", { command: input.command, tool: b.name }, o)];
      }
      return [seq.next("message", { text: `Used ${b.name}`, tool: b.name }, o)];
    });
  }

  if (o.type === "user") {
    return blocks(o).flatMap((b): RunnerEvent[] => {
      if (b.type !== "tool_result") return [];
      const tool = state.tools.get(b.tool_use_id);
      if (!tool || !COMMAND_TOOLS.has(tool.name)) return [];
      const output = resultText(b.content);
      const isError = b.is_error === true;
      const denied = state.denied.has(b.tool_use_id);
      const events = [seq.next("command.finished", { command: tool.command, isError, denied, output }, o)];
      if (!denied && tool.command && TEST_COMMAND.test(tool.command)) {
        events.push(seq.next("test.result", { command: tool.command, passed: !isError && !TEST_FAILED.test(output) }, o));
      }
      return events;
    });
  }

  if (o.type === "result") {
    const failed = o.is_error === true || o.subtype !== "success";
    return [seq.next(failed ? "task.failed" : "task.finished", {
      subtype: o.subtype,
      total_cost_usd: o.total_cost_usd,
      duration_ms: o.duration_ms,
      num_turns: o.num_turns,
      usage: o.usage,
      result: o.result,
      agentSessionId: o.session_id,
    }, o)];
  }

  return [];
}

function blocks(o: Json): Json[] {
  return Array.isArray(o.message?.content) ? o.message.content : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}
