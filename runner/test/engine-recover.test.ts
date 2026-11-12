import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerEvent, StartOptions } from "@codehands/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
  createCannedModel, createEngine, createMemoryStub, createRunner, RunStore,
  type SandboxOptions, type SandboxResult,
} from "../src/index.js";

// Crash tests. A "crash" here: we stop reading a run's events and leave it hanging, the way a
// killed daemon leaves its files. Then a new engine and runner on the same folders, like the
// restarted daemon, call recover() and resume(). Nothing in the first engine runs again.
const replay = fileURLToPath(new URL("./helpers/replay-agent.mjs", import.meta.url));
const spike = fileURLToPath(new URL("./fixtures/spike-1.jsonl", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "codehands-recover-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Claude Code that dies early: prints task.started, then exits with no result.
const dies = join(tmp, "dies.jsonl");
writeFileSync(dies, readFileSync(spike, "utf8").split("\n").slice(0, 2).join("\n") + "\n");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();

function makeRepo(): string {
  const repo = mkdtempSync(join(tmp, "repo-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "r", private: true, scripts: { test: "node -e 0" } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  return repo;
}

const options = (repoPath: string): StartOptions =>
  ({ sessionId: randomUUID(), repoPath, prompt: "Fix the failing test", agent: "codehands" });

// The folders a daemon keeps between restarts.
const folders = () => ({
  sessionRoot: mkdtempSync(join(tmp, "sessions-")),
  worktreeRoot: join(tmp, "worktrees"),
  runsRoot: mkdtempSync(join(tmp, "runs-")),
});
type Folders = ReturnType<typeof folders>;

// One daemon's engine. calls counts what it paid for: model steps, Claude Code starts and resumes, test runs.
function daemon(f: Folders, agent: "edit" | "dies" = "edit") {
  const calls = { claudeStart: 0, claudeResume: 0, tests: 0 };
  const model = createCannedModel({ analyze: "ANALYSIS", plan: "1. PLAN", review: "VERDICT: approve" });
  const runner = createRunner({
    sessionRoot: f.sessionRoot,
    worktreeRoot: f.worktreeRoot,
    memory: createMemoryStub(),
    agentCommand: () => {
      calls.claudeStart += 1;
      return { file: process.execPath, args: agent === "dies" ? [replay, dies] : [replay, spike, "0", "edit"] };
    },
    resumeCommand: () => {
      calls.claudeResume += 1;
      return { file: process.execPath, args: [replay, spike, "0", "edit"] };
    },
  });
  const sandbox = async (o: SandboxOptions): Promise<SandboxResult> => {
    calls.tests += 1;
    return { command: "npm test", image: "node:22-slim", passed: true, exitCode: 0, timedOut: false, oomKilled: false, durationMs: 900, output: `# pass 1 in ${o.worktree}`, outputTruncated: false };
  };
  const engine = createEngine({ runner, model, sandbox, memory: createMemoryStub(), runsRoot: f.runsRoot });
  return { engine, model, calls };
}

// Reads events until crashAt says so, then never asks for another: the process "died" there.
async function crashAfter(run: AsyncIterable<RunnerEvent>, crashAt: (e: RunnerEvent) => boolean): Promise<RunnerEvent[]> {
  const it = run[Symbol.asyncIterator]();
  const events: RunnerEvent[] = [];
  for (let r = await it.next(); !r.done; r = await it.next()) {
    events.push(r.value);
    if (crashAt(r.value)) break;
  }
  return events;
}

async function drain(run: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  for await (const e of run) events.push(e);
  return events;
}

const is = (type: string, step?: string) => (e: RunnerEvent) => e.type === type && (step === undefined || e.payload.step === step);
const steps = (events: RunnerEvent[]) => events.filter((e) => e.type.startsWith("step.")).map((e) => `${e.type === "step.started" ? ">" : "<"}${e.payload.step}`);

// Crash a run at crashAt, restart, recover, resume. Returns both halves.
async function crashAndResume(crashAt: (e: RunnerEvent) => boolean, agent: "edit" | "dies" = "edit") {
  const f = folders();
  const o = options(makeRepo());
  const first = daemon(f, agent);
  const before = await crashAfter(first.engine.start(o), crashAt);

  const second = daemon(f);
  const report = await second.engine.recover();
  const after = await drain(second.engine.resume(o.sessionId));
  return { f, o, first, second, report, before, after, all: [...before, ...after] };
}

describe("engine after a crash", () => {
  it("recover lists the cut-off run, and resume finishes it with seq carrying on", async () => {
    const { o, report, after, all } = await crashAndResume(is("step.started", "plan"));
    expect(report).toEqual({ failed: [], cleanupErrors: [], resumable: [o.sessionId] });
    expect(after[0]).toMatchObject({ type: "message", payload: { text: "Picked up after a restart, from plan" } });
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect(after.at(-1)).toMatchObject({ type: "approval.requested", payload: { verdict: "approve" } });
  });

  it("crash during analyze: analyze runs again", async () => {
    const { second, after } = await crashAndResume(is("step.started", "analyze"));
    expect(second.model.calls.map((c) => c.step)).toEqual(["analyze", "plan", "review"]);
    expect(steps(after)[0]).toBe(">analyze");
  });

  it("crash after plan: analyze and plan aren't paid for twice, and implement gets the saved plan", async () => {
    const { second, after } = await crashAndResume(is("step.finished", "plan"));
    expect(second.model.calls.map((c) => c.step)).toEqual(["review"]);
    expect(steps(after)[0]).toBe(">implement");
    expect(second.calls.claudeStart).toBe(1);
  });

  it("crash during implement: Claude Code's session is continued, not started over", async () => {
    const { o, second, report, after } = await crashAndResume((e) => e.type === "message" && e.payload.text === "Claude Code started", "dies");
    expect(report.resumable).toEqual([o.sessionId]);
    expect(second.calls).toMatchObject({ claudeStart: 0, claudeResume: 1 });
    expect(steps(after)).toEqual([">implement", "<implement", ">test", "<test", ">review", "<review"]);
    expect(after.at(-1)!.type).toBe("approval.requested");
    const { patch } = await second.engine.diff(o.sessionId);
    expect(patch).toContain("+world");
  });

  it("crash right after Claude Code finished: no Claude Code at all, straight to test", async () => {
    const f = folders();
    const o = options(makeRepo());
    await crashAfter(daemon(f).engine.start(o), is("step.finished", "implement"));
    // The runner had finished, but the engine died before it saved that.
    const store = new RunStore(f.runsRoot);
    store.save({ ...store.load(o.sessionId)!, implemented: undefined });

    const second = daemon(f);
    await second.engine.recover();
    const after = await drain(second.engine.resume(o.sessionId));
    expect(second.calls).toMatchObject({ claudeStart: 0, claudeResume: 0, tests: 1 });
    expect(steps(after)).toEqual(["<implement", ">test", "<test", ">review", "<review"]);
  });

  it("crash during review: the tests don't run again, and review still sees their result", async () => {
    const { second, after } = await crashAndResume(is("step.started", "review"));
    expect(second.calls.tests).toBe(0);
    expect(second.model.calls.map((c) => c.step)).toEqual(["review"]);
    expect(second.model.calls[0]!.prompt).toContain("The tests passed");
    expect(after.at(-1)!.type).toBe("approval.requested");
  });

  it("crash between task.finished and approval.requested: resume sends both again", async () => {
    const { second, after } = await crashAndResume(is("task.finished"));
    expect(second.model.calls).toHaveLength(0);
    expect(after.map((e) => e.type)).toEqual(["message", "task.finished", "approval.requested"]);
  });
});

describe("engine recover and approve after a restart", () => {
  it("approve is refused until the cut-off run finishes", async () => {
    const f = folders();
    const o = options(makeRepo());
    await crashAfter(daemon(f).engine.start(o), is("step.started", "test"));

    const second = daemon(f);
    await second.engine.recover();
    await expect(second.engine.approve(o.sessionId, "too early")).rejects.toThrow(/hasn't finished .* cut off by a restart/);
    expect(second.engine.status(o.sessionId)).toBe("running");
    await drain(second.engine.resume(o.sessionId));
    expect(second.engine.status(o.sessionId)).toBe("awaiting_approval");
    const { branch, commit } = await second.engine.approve(o.sessionId, "Fix the failing test");
    expect(git(o.repoPath, "rev-parse", branch)).toBe(commit);
    expect(second.engine.status(o.sessionId)).toBe("approved");
  });

  it("recover leaves finished and failed runs alone, and a second recover finds nothing", async () => {
    const f = folders();
    const first = daemon(f);
    const done = options(makeRepo());
    await drain(first.engine.start(done));
    const failed = options(join(tmp, "not-a-repo"));
    await drain(first.engine.start(failed));
    const cut = options(makeRepo());
    await crashAfter(first.engine.start(cut), is("step.started", "implement"));

    const second = daemon(f);
    expect((await second.engine.recover()).resumable).toEqual([cut.sessionId]);
    await drain(second.engine.resume(cut.sessionId));
    expect((await second.engine.recover()).resumable).toEqual([]);
  });

  it("a run stopped before the restart resumes like any stopped run", async () => {
    const f = folders();
    const o = options(makeRepo());
    const pidFile = join(tmp, `child-${o.sessionId}.pid`);
    const runner = createRunner({
      sessionRoot: f.sessionRoot, worktreeRoot: f.worktreeRoot, memory: createMemoryStub(),
      agentCommand: () => ({ file: process.execPath, args: [replay, spike, "0", "hang", pidFile] }),
    });
    const engine = createEngine({ runner, model: createCannedModel({}), memory: createMemoryStub(), runsRoot: f.runsRoot, sandbox: async () => { throw new Error("never reached: stopped during implement"); } });
    let stopping: Promise<void> | undefined;
    for await (const e of engine.start(o)) {
      if (e.type === "message" && e.payload.text === "Claude Code started") stopping = engine.stop(o.sessionId);
    }
    await stopping;

    const second = daemon(f);
    expect((await second.engine.recover()).resumable).toEqual([]);  // stopped is not cut off
    const after = await drain(second.engine.resume(o.sessionId, "Carry on."));
    expect(second.calls.claudeResume).toBe(1);
    expect(after.at(-1)!.type).toBe("approval.requested");
  });

  it("refuses a second resume of the same run, and a resume of a run nobody knows", async () => {
    const f = folders();
    const o = options(makeRepo());
    await crashAfter(daemon(f).engine.start(o), is("step.started", "analyze"));
    const second = daemon(f);
    await second.engine.recover();
    const it1 = second.engine.resume(o.sessionId)[Symbol.asyncIterator]();
    await it1.next();
    await expect(drain(second.engine.resume(o.sessionId))).rejects.toThrow(/already running/);
    await expect(drain(second.engine.resume(randomUUID()))).rejects.toThrow(/unknown engine session/);
    for (let r = await it1.next(); !r.done; r = await it1.next());
  });
});

describe("RunStore", () => {
  it("saves and loads a run, and lists only folders with a run.json", () => {
    const root = mkdtempSync(join(tmp, "store-"));
    const store = new RunStore(root);
    const o = options("x");
    store.save({ options: o, status: "running", lastSeq: 3, files: 1, costUsd: 0, analysis: "A" });
    expect(store.load(o.sessionId)).toMatchObject({ status: "running", lastSeq: 3, analysis: "A" });
    writeFileSync(join(root, "stray.txt"), "");
    expect(store.ids()).toEqual([o.sessionId]);
  });

  it("says undefined for an unknown id, and never reads outside its folder", () => {
    const store = new RunStore(mkdtempSync(join(tmp, "store-")));
    expect(store.load(randomUUID())).toBeUndefined();
    expect(store.load("../../etc")).toBeUndefined();
    expect(new RunStore(join(tmp, "nothing-here")).ids()).toEqual([]);
  });
});