import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Runner, RunnerEvent, StartOptions } from "@codehands/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createRunner, type RunnerOptions } from "../src/index.js";

// start() against a throwaway git repo. The agent is a script that replays spike-1.jsonl, so no API cost.
const replay = fileURLToPath(new URL("./helpers/replay-agent.mjs", import.meta.url));
const spike = fileURLToPath(new URL("./fixtures/spike-1.jsonl", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "codehands-runner-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();

function makeRepo(withCommit = true): string {
  const repo = mkdtempSync(join(tmp, "repo-"));
  git(repo, "init", "-q", "-b", "main");
  if (withCommit) {
    writeFileSync(join(repo, "a.txt"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");
  }
  return repo;
}

function options(repoPath: string, extra: Partial<StartOptions> = {}): StartOptions {
  return { sessionId: randomUUID(), repoPath, prompt: "Fix the failing test", agent: "claude-code", ...extra };
}

async function collect(o: StartOptions, runnerOptions: RunnerOptions = {}, runner = newRunner(runnerOptions)): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  for await (const e of runner.start(o)) events.push(e);
  return events;
}

const newRunner = (runnerOptions: RunnerOptions = {}) => createRunner({ worktreeRoot: join(tmp, "worktrees"), ...runnerOptions });

const replayAgent = (file: string, exitCode = 0, mode = "", pidFile = ""): RunnerOptions["agentCommand"] =>
  () => ({ file: process.execPath, args: [replay, file, String(exitCode), mode, pidFile] });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("runner.start", () => {
  it("makes a worktree on a new branch, runs the agent there and streams its events", async () => {
    const repo = makeRepo();
    const o = options(repo);
    const events = await collect(o, { agentCommand: replayAgent(spike) });

    expect(events[0]!.type).toBe("task.started");
    expect(events.at(-1)!.type).toBe("task.finished");
    expect(events).toHaveLength(17);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.sessionId === o.sessionId)).toBe(true);

    const branch = `codehands/fix-the-failing-test-${o.sessionId.slice(0, 8)}`;
    expect(git(repo, "branch", "--list", branch)).toContain(branch);
    const worktree = join(tmp, "worktrees");
    expect(git(repo, "worktree", "list")).toContain(o.sessionId.slice(0, 8));
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, "status", "--porcelain")).toBe(""); // the real repo is untouched
  });

  it("fails clearly when the repo has no commits", async () => {
    const events = await collect(options(makeRepo(false)), { agentCommand: replayAgent(spike) });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("task.failed");
    expect(events[0]!.payload.reason).toMatch(/no commits/);
  });

  it("fails when the agent exits without a result line", async () => {
    const empty = join(tmp, "empty.jsonl");
    writeFileSync(empty, "");
    const events = await collect(options(makeRepo()), { agentCommand: replayAgent(empty, 1) });
    expect(events.map((e) => e.type)).toEqual(["task.failed"]);
    expect(events[0]!.payload).toMatchObject({ reason: "the agent exited without a result", exitCode: 1 });
  });

  it("fails instead of crashing when the agent binary is missing", async () => {
    const events = await collect(options(makeRepo()), {
      agentCommand: () => ({ file: "codehands-no-such-binary", args: [] }),
    });
    expect(events.map((e) => e.type)).toEqual(["task.failed"]);
    expect(String(events[0]!.payload.error)).toMatch(/ENOENT|not found|codehands-no-such-binary/i);
  });

  it("refuses agents that are not supported yet", async () => {
    const events = await collect(options(makeRepo(), { agent: "codex" }));
    expect(events.map((e) => [e.type, e.payload.reason])).toEqual([["task.failed", "agent codex is not supported yet"]]);
  });
});

describe("runner diff, approve and reject", () => {
  // A finished run whose agent changed a.txt and added new.txt.
  async function finishedRun() {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const o = options(repo);
    const runner = newRunner({ agentCommand: replayAgent(spike, 0, "edit") });
    const events = await collect(o, {}, runner);
    const worktree = git(repo, "worktree", "list", "--porcelain").split("\n")
      .filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).find((p) => p.includes(o.sessionId.slice(0, 8)))!;
    return { repo, base, o, runner, events, worktree, branch: `codehands/fix-the-failing-test-${o.sessionId.slice(0, 8)}` };
  }

  it("puts the diff summary on task.finished and returns the full patch, new files included", async () => {
    const { runner, o, events } = await finishedRun();
    expect(events.at(-1)!.type).toBe("task.finished");
    expect(events.at(-1)!.payload.diffStat).toMatch(/2 files changed/);
    const { patch, stat } = await runner.diff(o.sessionId);
    expect(patch).toContain("+world");
    expect(patch).toContain("new.txt");
    expect(patch.endsWith("\n")).toBe(true);
    expect(stat).toMatch(/a\.txt/);
  });

  it("approve commits on the task branch, removes the worktree and keeps the branch", async () => {
    const { repo, base, runner, o, worktree, branch } = await finishedRun();
    const result = await runner.approve(o.sessionId, "Fix the failing test");

    expect(result.branch).toBe(branch);
    expect(git(repo, "rev-parse", branch)).toBe(result.commit);
    expect(git(repo, "rev-parse", `${branch}~1`)).toBe(base);
    expect(git(repo, "log", "-1", "--format=%s", branch)).toBe("Fix the failing test");
    expect(git(repo, "show", "--name-only", "--format=", branch).split("\n").sort()).toEqual(["a.txt", "new.txt"]);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, "rev-parse", "HEAD")).toBe(base); // main didn't move
    expect(git(repo, "status", "--porcelain")).toBe("");
    await expect(runner.approve(o.sessionId, "again")).rejects.toThrow(/illegal move/);
  });

  it("reject removes the worktree and deletes the branch", async () => {
    const { repo, runner, o, worktree, branch } = await finishedRun();
    await runner.reject(o.sessionId);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, "branch", "--list", branch)).toBe("");
    await expect(runner.approve(o.sessionId, "too late")).rejects.toThrow(/illegal move/);
  });

  it("refuses to approve when the agent changed nothing, and reject still works after", async () => {
    const repo = makeRepo();
    const o = options(repo);
    const runner = newRunner({ agentCommand: replayAgent(spike) });
    await collect(o, {}, runner);
    await expect(runner.approve(o.sessionId, "msg")).rejects.toThrow(/nothing to approve/);
    await expect(runner.reject(o.sessionId)).resolves.toBeUndefined();
  });

  it("refuses approve and reject on a session that failed before it had a worktree", async () => {
    const o = options(makeRepo(false));
    const runner = newRunner({ agentCommand: replayAgent(spike) });
    await collect(o, {}, runner);
    await expect(runner.approve(o.sessionId, "msg")).rejects.toThrow(/no worktree/);
    await expect(runner.reject(o.sessionId)).rejects.toThrow(/no worktree/);
  });
});

// Reads a run to the end and calls stop() as soon as the agent has started.
async function readAndStop(runner: Runner, sessionId: string, run: AsyncIterable<RunnerEvent>) {
  const events: RunnerEvent[] = [];
  let stopping: Promise<void> | undefined;
  for await (const e of run) {
    events.push(e);
    if (e.type === "task.started") stopping = runner.stop(sessionId);
  }
  await stopping;
  return events;
}

// A run whose agent hangs after task.started, with a child of its own, like claude -> npm test.
async function stoppedRun(runnerOptions: RunnerOptions = {}) {
  const repo = makeRepo();
  const o = options(repo);
  const pidFile = join(tmp, `child-${o.sessionId}.pid`);
  const runner = newRunner({ agentCommand: replayAgent(spike, 0, "hang", pidFile), ...runnerOptions });
  const events = await readAndStop(runner, o.sessionId, runner.start(o));
  return { repo, o, runner, events, childPid: Number(readFileSync(pidFile, "utf8")) };
}

async function drain(run: AsyncIterable<RunnerEvent>) {
  const events: RunnerEvent[] = [];
  for await (const e of run) events.push(e);
  return events;
}

describe("runner.stop", () => {
  it("kills the agent and its children, and the stream ends with task.stopped", async () => {
    const { events, childPid } = await stoppedRun();
    expect(events.map((e) => e.type)).toEqual(["task.started", "task.stopped"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    await vi.waitFor(() => expect(alive(childPid)).toBe(false), { timeout: 3000 });
  });

  it("keeps the worktree and the branch, so the session can resume", async () => {
    const { repo, o } = await stoppedRun();
    const short = o.sessionId.slice(0, 8);
    expect(git(repo, "worktree", "list")).toContain(short);
    expect(git(repo, "branch", "--list", `codehands/fix-the-failing-test-${short}`)).not.toBe("");
  });

  it("refuses to stop a session that is not running", async () => {
    const { runner, o } = await stoppedRun();
    await expect(runner.stop(o.sessionId)).rejects.toThrow(/illegal move/); // already stopped

    const finished = options(makeRepo());
    const other = newRunner({ agentCommand: replayAgent(spike) });
    await collect(finished, {}, other);
    await expect(other.stop(finished.sessionId)).rejects.toThrow(/illegal move/); // awaiting approval
    await expect(other.stop(randomUUID())).rejects.toThrow(/unknown session/);
  });
});

describe("runner.resume", () => {
  const resumeWith = (mode = "", pidFile = ""): RunnerOptions["resumeCommand"] =>
    () => ({ file: process.execPath, args: [replay, spike, "0", mode, pidFile] });

  it("continues in the same worktree, seq carries on, and it ends awaiting approval", async () => {
    const { repo, o, runner, events } = await stoppedRun({ resumeCommand: resumeWith("edit") });
    const resumed = await drain(runner.resume(o.sessionId));

    expect(resumed.at(-1)!.type).toBe("task.finished");
    expect(resumed.at(-1)!.payload.diffStat).toMatch(/2 files changed/);
    expect([...events, ...resumed].map((e) => e.seq)).toEqual([...events, ...resumed].map((_, i) => i + 1));

    const { branch } = await runner.approve(o.sessionId, "Fix the failing test");
    expect(git(repo, "show", "--name-only", "--format=", branch).split("\n").sort()).toEqual(["a.txt", "new.txt"]);
  });

  it("passes the prompt to the agent", async () => {
    let seen = "";
    const { o, runner } = await stoppedRun({
      resumeCommand: (_o, prompt) => {
        seen = prompt;
        return { file: process.execPath, args: [replay, spike] };
      },
    });
    await drain(runner.resume(o.sessionId, "Only fix the date test."));
    expect(seen).toBe("Only fix the date test.");
  });

  it("can be stopped again, and numbering still carries on", async () => {
    const pidFile = join(tmp, `resume-child-${randomUUID()}.pid`);
    const { o, runner, events } = await stoppedRun({ resumeCommand: resumeWith("hang", pidFile) });
    const resumed = await readAndStop(runner, o.sessionId, runner.resume(o.sessionId));

    expect(resumed.map((e) => e.type)).toEqual(["task.started", "task.stopped"]);
    expect(resumed.map((e) => e.seq)).toEqual([events.length + 1, events.length + 2]);
    await vi.waitFor(() => expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false), { timeout: 3000 });
  });

  it("refuses a session that is not stopped", async () => {
    const o = options(makeRepo());
    const runner = newRunner({ agentCommand: replayAgent(spike) });
    await collect(o, {}, runner);
    await expect(drain(runner.resume(o.sessionId))).rejects.toThrow(/illegal move/); // awaiting approval
    await expect(drain(runner.resume(randomUUID()))).rejects.toThrow(/unknown session/);
  });
});
