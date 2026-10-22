import { setTimeout as sleep } from "node:timers/promises";
import type { Runner, RunnerEvent, StartOptions } from "@codehands/contracts";
import { EventSequence } from "./events.js";
import { SessionStore } from "./session-store.js";

// A stand-in for the real runner. Midhat's daemon plugs this in today and gets
// events in the agreed shape. Also the demo backup if a live run fails.

export interface FakeRunnerOptions {
  delayMs?: number;
}

type Step = [RunnerEvent["type"], Record<string, unknown>];

function script(prompt: string): Step[] {
  return [
    ["task.started", { agent: "claude-code", model: "fake", prompt }],
    ["message", { text: "I'll look at the failing test first." }],
    ["file.read", { path: "test/date.test.js" }],
    ["file.read", { path: "src/date.js" }],
    ["command.started", { command: "npm test" }],
    ["command.finished", { command: "npm test", exitCode: 1 }],
    ["test.result", { command: "npm test", passed: false }],
    ["file.changed", { path: "src/date.js", tool: "Edit" }],
    ["command.started", { command: "npm test" }],
    ["command.finished", { command: "npm test", exitCode: 0 }],
    ["test.result", { command: "npm test", passed: true }],
    ["task.finished", { total_cost_usd: 0, duration_ms: 0, num_turns: 4, usage: {}, result: "Fixed the date bug." }],
  ];
}

export function createFakeRunner({ delayMs = 300 }: FakeRunnerOptions = {}): Runner {
  const store = new SessionStore();
  const stopped = new Set<string>();

  async function* play(sessionId: string, steps: Step[], seq: EventSequence): AsyncIterable<RunnerEvent> {
    for (const [type, payload] of steps) {
      if (stopped.has(sessionId)) {
        const event = seq.next("task.stopped", {});
        store.get(sessionId).lastSeq = seq.last;
        yield event;
        return;
      }
      await sleep(delayMs);
      const event = seq.next(type, payload);
      store.get(sessionId).lastSeq = seq.last;
      yield event;
    }
    if (!stopped.has(sessionId)) store.transition(sessionId, "awaiting_approval");
  }

  return {
    start(o: StartOptions) {
      store.create(o);
      store.transition(o.sessionId, "running");
      return play(o.sessionId, script(o.prompt), new EventSequence(o.sessionId));
    },

    async stop(sessionId) {
      stopped.add(sessionId);
      store.transition(sessionId, "stopped");
    },

    resume(sessionId, prompt) {
      const record = store.transition(sessionId, "running");
      stopped.delete(sessionId);
      const steps = script(prompt ?? record.options.prompt).slice(-4);
      return play(sessionId, steps, new EventSequence(sessionId, record.lastSeq));
    },

    async diff(sessionId) {
      store.get(sessionId);
      return {
        patch: "--- a/src/date.js\n+++ b/src/date.js\n@@ -1 +1 @@\n-  return d.getDate();\n+  return d.getUTCDate();\n",
        stat: " src/date.js | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n",
      };
    },

    async approve(sessionId) {
      store.transition(sessionId, "approved");
      return { branch: `codehands/fake-${sessionId.slice(0, 8)}`, commit: "0000000" };
    },

    async reject(sessionId) {
      store.transition(sessionId, "rejected");
    },
  };
}
