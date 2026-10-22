import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@codehands/contracts";
import { createFakeRunner } from "../src/index.js";

const opts = { sessionId: "3f2a9c1e-0000-4000-8000-000000000000", repoPath: ".", prompt: "Fix the failing test", agent: "claude-code" as const };

async function collect(events: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("fake runner", () => {
  it("emits started ... finished with seq 1, 2, 3 …", async () => {
    const runner = createFakeRunner({ delayMs: 0 });
    const events = await collect(runner.start(opts));
    expect(events[0]!.type).toBe("task.started");
    expect(events.at(-1)!.type).toBe("task.finished");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("approves only after the run finished", async () => {
    const runner = createFakeRunner({ delayMs: 0 });
    const events = runner.start(opts)[Symbol.asyncIterator]();
    await events.next();
    await expect(runner.approve(opts.sessionId, "msg")).rejects.toThrow(/illegal move/);
    while (!(await events.next()).done);
    await expect(runner.approve(opts.sessionId, "msg")).resolves.toMatchObject({ branch: expect.stringMatching(/^codehands\//) });
  });

  it("stops, then resumes with seq continuing", async () => {
    const runner = createFakeRunner({ delayMs: 0 });
    const it1 = runner.start(opts)[Symbol.asyncIterator]();
    await it1.next();
    await it1.next();
    await runner.stop(opts.sessionId);
    const last = (await it1.next()).value as RunnerEvent;
    expect(last.type).toBe("task.stopped");
    const resumed = await collect(runner.resume(opts.sessionId));
    expect(resumed[0]!.seq).toBe(last.seq + 1);
    expect(resumed.at(-1)!.type).toBe("task.finished");
  });
});
