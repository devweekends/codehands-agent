import { describe, it } from "vitest";

// Tuesday: replay test/fixtures/spike-1.jsonl through parseClaudeLine with no API cost.
describe("parseClaudeLine", () => {
  it.todo("maps system/init to task.started");
  it.todo("maps assistant text, Read, Edit/Write and Bash blocks");
  it.todo("maps the result line to task.finished with total_cost_usd and usage untouched");
  it.todo("turns a malformed line into a message with the raw text");
  it.todo("keeps raw on every event");
});
