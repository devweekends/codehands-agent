import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { newClaudeParseState, parseClaudeLine } from "../src/agents/claude-code.js";
import { EventSequence } from "../src/events.js";

// Replays test/fixtures/spike-1.jsonl (a real Claude Code 2.1.280 run, Oct 22) with no API cost.
const lines = readFileSync(new URL("./fixtures/spike-1.jsonl", import.meta.url), "utf8").split("\n");

function replay(input: string[]) {
  const seq = new EventSequence("s1");
  const state = newClaudeParseState();
  return input.flatMap((line) => parseClaudeLine(line, seq, state));
}

describe("parseClaudeLine", () => {
  const events = replay(lines);

  it("replays the whole spike in order", () => {
    expect(events.map((e) => e.type)).toEqual([
      "task.started",
      "command.started", "message", "command.finished",   // PowerShell, blocked
      "command.started", "file.read", "message", "command.finished", // PowerShell blocked, Glob
      "file.read", "file.read", "file.read",
      "file.changed",
      "command.started", "command.finished", "test.result",
      "message",
      "task.finished",
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("maps system/init to task.started, even when a rate_limit_event comes first", () => {
    expect(JSON.parse(lines[0]!).type).toBe("rate_limit_event");
    expect(events[0]!.type).toBe("task.started");
    expect(events[0]!.payload).toMatchObject({ agent: "claude-code", permissionMode: "acceptEdits" });
  });

  it("maps assistant text, Read, Edit/Write and Bash/PowerShell blocks", () => {
    expect(events.filter((e) => e.type === "file.read" && e.payload.tool === "Read").map((e) => e.payload.path))
      .toEqual([expect.stringMatching(/date\.js$/), expect.stringMatching(/date\.test\.js$/), expect.stringMatching(/package\.json$/)]);
    expect(events.find((e) => e.type === "file.changed")!.payload).toMatchObject({ tool: "Edit", path: expect.stringMatching(/src[\\/]date\.js$/) });
    expect(events.filter((e) => e.type === "command.started").map((e) => e.payload.tool)).toEqual(["PowerShell", "PowerShell", "Bash"]);
    expect(events.at(-2)!.payload.text).toMatch(/^I fixed the failing test/);
  });

  it("marks blocked commands and gives no test result for a test that never ran", () => {
    const finished = events.filter((e) => e.type === "command.finished");
    expect(finished.map((e) => e.payload.denied)).toEqual([true, true, false]);
    expect(events.filter((e) => e.type === "message" && e.payload.denied)).toHaveLength(2);
    expect(events.filter((e) => e.type === "test.result").map((e) => e.payload.passed)).toEqual([true]);
  });

  it("fails a test command whose output shows failures even when the exit code hides it", () => {
    const use = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test 2>&1 | tail -5" } }] } };
    const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "# pass 0\n# fail 1" }] } };
    const out = replay([JSON.stringify(use), JSON.stringify(result)]);
    expect(out.find((e) => e.type === "test.result")!.payload.passed).toBe(false);
  });

  it("maps the result line to task.finished with total_cost_usd and usage untouched", () => {
    const raw = JSON.parse(lines.filter(Boolean).at(-1)!);
    const last = events.at(-1)!;
    expect(last.type).toBe("task.finished");
    expect(last.payload.total_cost_usd).toBe(raw.total_cost_usd);
    expect(last.payload.usage).toEqual(raw.usage);
  });

  it("maps an error result to task.failed", () => {
    const [e] = replay([JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.5 })]);
    expect(e!.type).toBe("task.failed");
    expect(e!.payload.total_cost_usd).toBe(0.5);
  });

  it("turns a malformed or half-finished line into a message with the raw text, and skips blank lines", () => {
    const half = lines[1]!.slice(0, 40);
    const out = replay(["not json", half, "", "   "]);
    expect(out.map((e) => [e.type, e.payload.text, e.raw])).toEqual([
      ["message", "not json", "not json"],
      ["message", half, half],
    ]);
  });

  it("keeps raw on every event", () => {
    expect(events.every((e) => e.raw !== undefined)).toBe(true);
  });
});
