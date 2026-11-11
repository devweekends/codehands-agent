import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerEvent, StartOptions } from "@codehands/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
    createCannedModel, createEngine, createMemoryStub, createRunner, dockerAvailable, runInSandbox,
    type ModelClient, type RunnerOptions, type SandboxOptions, type SandboxResult,
} from "../src/index.js";

// The whole engine with no cost: canned model answers, the recorded Claude run as the implement
// step, and a stand-in sandbox. One test at the end uses the real Docker box.
const replay = fileURLToPath(new URL("./helpers/replay-agent.mjs", import.meta.url));
const spike = fileURLToPath(new URL("./fixtures/spike-1.jsonl", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "codehands-engine-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const hasDocker = await dockerAvailable();

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();

function makeRepo(withCommit = true): string {
    const repo = mkdtempSync(join(tmp, "repo-"));
    git(repo, "init", "-q", "-b", "main");
    if (withCommit) {
        writeFileSync(join(repo, "a.txt"), "hello\n");
        // The test passes only once the agent has added "world" to a.txt.
        writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "r", private: true, scripts: { test: `node -e "process.exit(require('fs').readFileSync('a.txt','utf8').includes('world') ? 0 : 1)"` } }));
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "first");
    }
    return repo;
}

const options = (repoPath: string, extra: Partial<StartOptions> = {}): StartOptions =>
    ({ sessionId: randomUUID(), repoPath, prompt: "Fix the failing test", agent: "codehands", ...extra });

const passing = (o: SandboxOptions): SandboxResult => ({
    command: "npm test", image: "node:22-slim", passed: true, exitCode: 0, timedOut: false, oomKilled: false,
    durationMs: 900, output: `# pass 1 in ${o.worktree}`, outputTruncated: false,
});

interface Setup {
    model?: ModelClient;
    sandbox?: (o: SandboxOptions) => Promise<SandboxResult>;
    runner?: RunnerOptions;
}

// seen keeps what the implement step was given, so a test can check the prompt and model.
function setup({ model = createCannedModel({ analyze: "ANALYSIS", plan: "1. PLAN", review: "VERDICT: approve\nGood." }), sandbox = async (o) => passing(o), runner = {} }: Setup = {}) {
    const seen: StartOptions[] = [];
    const runsRoot = mkdtempSync(join(tmp, "runs-"));
    const inner = createRunner({
        worktreeRoot: join(tmp, "worktrees"),
        sessionRoot: join(tmp, "sessions"),
        memory: createMemoryStub(),
        agentCommand: (o) => {
            seen.push(o);
            return { file: process.execPath, args: [replay, spike, "0", "edit"] };
        },
        ...runner,
    });
    const engine = createEngine({ runner: inner, model, sandbox, memory: createMemoryStub(), runsRoot });
    return { engine, seen, runsRoot };
}

async function drain(run: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
    const events: RunnerEvent[] = [];
    for await (const e of run) events.push(e);
    return events;
}

// The engine's own test.result. Claude Code's run sends some too, tagged step "implement".
const testResult = (events: RunnerEvent[]) => events.find((e) => e.type === "test.result" && e.payload.step === "test")!.payload;

const steps = (events: RunnerEvent[]) =>
    events.filter((e) => e.type === "step.started" || e.type === "step.finished").map((e) => `${e.type === "step.started" ? ">" : "<"}${e.payload.step}${e.payload.ok === false ? " x" : ""}`);

describe("engine.start", () => {
    it("walks the five steps in order and ends awaiting approval", async () => {
        const { engine } = setup();
        const o = options(makeRepo());
        const events = await drain(engine.start(o));

        expect(steps(events)).toEqual([">analyze", "<analyze", ">plan", "<plan", ">implement", "<implement", ">test", "<test", ">review", "<review"]);
        expect(events[0]).toMatchObject({ type: "task.started", payload: { agent: "codehands" } });
        expect(events.map((e) => e.type).slice(-2)).toEqual(["task.finished", "approval.requested"]);
        expect(events.at(-1)!.payload).toMatchObject({ verdict: "approve", diffStat: expect.stringMatching(/2 files changed/) });
        expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
        expect(events.every((e) => e.sessionId === o.sessionId)).toBe(true);
    });

    it("passes Claude Code's own events through, tagged with the step", async () => {
        const { engine } = setup();
        const events = await drain(engine.start(options(makeRepo())));
        const fromClaude = events.filter((e) => e.payload.step === "implement" && !e.type.startsWith("step."));
        expect(fromClaude.map((e) => e.type)).toContain("file.changed");
        expect(fromClaude.every((e) => e.raw !== undefined)).toBe(true);
        expect(events.filter((e) => e.type === "task.finished")).toHaveLength(1); // the runner's own stays inside
    });

    it("hands each step the one before it: analysis to plan, plan to implement, the change to review", async () => {
        const model = createCannedModel({ analyze: "ANALYSIS", plan: "1. PLAN", review: "VERDICT: approve" });
        const { engine, seen } = setup({ model });
        await drain(engine.start(options(makeRepo())));
        const [analyze, plan, review] = model.calls;
        expect(analyze!.prompt).toContain("Fix the failing test");
        expect(analyze!.prompt).toContain("package.json");
        expect(plan!.prompt).toContain("ANALYSIS");
        expect(seen[0]!.prompt).toContain("1. PLAN");
        expect(seen[0]!.agent).toBe("claude-code");
        expect(review!.prompt).toContain("+world");
        expect(review!.prompt).toContain("The tests passed");
    });

    it("uses each step's own model, then the run's, then the default", async () => {
        const model = createCannedModel({});
        const { engine, seen } = setup({ model });
        await drain(engine.start(options(makeRepo(), { model: "run-model", models: { plan: "plan-model", implement: "impl-model" } })));
        expect(model.calls.map((c) => [c.step, c.model])).toEqual([["analyze", "run-model"], ["plan", "plan-model"], ["review", "run-model"]]);
        expect(seen[0]!.model).toBe("impl-model");

        const plain = createCannedModel({});
        await drain(setup({ model: plain }).engine.start(options(makeRepo())));
        expect(plain.calls[0]!.model).toBe("claude-sonnet-5-5");
    });

    it("saves a file for every step", async () => {
        const { engine, runsRoot } = setup();
        const o = options(makeRepo());
        await drain(engine.start(o));
        const dir = join(runsRoot, o.sessionId);
        expect(readdirSync(dir).sort()).toEqual(["1-analyze.json", "2-plan.json", "3-implement.json", "4-test.json", "5-review.json"]);
        expect(JSON.parse(readFileSync(join(dir, "2-plan.json"), "utf8"))).toMatchObject({ step: "plan", ok: true, output: "1. PLAN" });
        expect(JSON.parse(readFileSync(join(dir, "3-implement.json"), "utf8")).diffStat).toMatch(/2 files changed/);
    });

    it("refuses an agent that isn't codehands", async () => {
        const events = await drain(setup().engine.start(options(makeRepo(), { agent: "claude-code" })));
        expect(events.map((e) => [e.type, e.payload.reason])).toEqual([["task.failed", 'the engine runs agent "codehands", not "claude-code"']]);
    });

    it("fails before any model call when the repo has no commits", async () => {
        const model = createCannedModel({});
        const events = await drain(setup({ model }).engine.start(options(makeRepo(false))));
        expect(events.at(-1)).toMatchObject({ type: "task.failed", payload: { reason: expect.stringMatching(/no commits/) } });
        expect(model.calls).toHaveLength(0);
    });
});

describe("engine when something goes wrong", () => {
    it("analyze fails: the run fails, and no worktree is made", async () => {
        const { engine } = setup({ model: createCannedModel({ analyze: new Error("model down") }) });
        const o = options(makeRepo());
        const events = await drain(engine.start(o));
        expect(steps(events)).toEqual([">analyze", "<analyze x"]);
        expect(events.at(-1)).toMatchObject({ type: "task.failed", payload: { reason: "analyze: model down", step: "analyze" } });
        expect(engine.worktree(o.sessionId)).toBeUndefined();
    });

    it("implement fails: the run fails at implement", async () => {
        const empty = join(tmp, "empty.jsonl");
        writeFileSync(empty, "");
        const { engine } = setup({ runner: { agentCommand: () => ({ file: process.execPath, args: [replay, empty, "1"] }) } });
        const events = await drain(engine.start(options(makeRepo())));
        expect(steps(events).at(-1)).toBe("<implement x");
        expect(events.at(-1)).toMatchObject({ type: "task.failed", payload: { step: "implement", reason: "the agent exited without a result" } });
    });

    it("tests fail: that's a result, and the run still ends awaiting approval", async () => {
        const sandbox = async (o: SandboxOptions) => ({ ...passing(o), passed: false, exitCode: 1, output: "# fail 1" });
        const model = createCannedModel({ review: "VERDICT: concerns\nThe test still fails." });
        const events = await drain(setup({ model, sandbox }).engine.start(options(makeRepo())));
        expect(testResult(events)).toMatchObject({ ran: true, passed: false, exitCode: 1 });
        expect(model.calls.at(-1)!.prompt).toContain("The tests failed (exit 1)");
        expect(events.at(-1)).toMatchObject({ type: "approval.requested", payload: { verdict: "concerns" } });
    });

    it("tests can't run: the change is kept, and review is told why", async () => {
        const sandbox = async (o: SandboxOptions) => ({ ...passing(o), passed: false, exitCode: null, error: "sandbox.unavailable" as const, message: "Docker is not running." });
        const model = createCannedModel({ review: "VERDICT: concerns\nUntested." });
        const events = await drain(setup({ model, sandbox }).engine.start(options(makeRepo())));
        expect(steps(events)).toContain("<test x");
        expect(testResult(events)).toMatchObject({ ran: false, error: "sandbox.unavailable" });
        expect(model.calls.at(-1)!.prompt).toContain("The tests did not run: sandbox.unavailable");
        expect(events.at(-1)!.type).toBe("approval.requested");
    });

    it("a sandbox that throws counts as tests that couldn't run", async () => {
        const sandbox = async () => { throw new Error("boom"); };
        const events = await drain(setup({ sandbox }).engine.start(options(makeRepo())));
        expect(testResult(events)).toMatchObject({ ran: false, error: "sandbox.failed", message: "boom" });
        expect(events.at(-1)!.type).toBe("approval.requested");
    });

    it("review fails: the change is kept, with verdict unknown", async () => {
        const { engine } = setup({ model: createCannedModel({ review: new Error("model down") }) });
        const events = await drain(engine.start(options(makeRepo())));
        expect(steps(events).at(-1)).toBe("<review x");
        expect(events.find((e) => e.type === "task.finished")!.payload).toMatchObject({ verdict: "unknown", review: "review failed: model down" });
        expect(events.at(-1)).toMatchObject({ type: "approval.requested", payload: { verdict: "unknown" } });
    });
});

describe("engine approve, reject, stop and resume", () => {
    it("approve waits for the whole run, then commits on the task branch", async () => {
        const { engine } = setup();
        const repo = makeRepo();
        const o = options(repo);
        const run = engine.start(o)[Symbol.asyncIterator]();
        let e = await run.next();
        while (!e.done && e.value.type !== "step.started") e = await run.next();
        await expect(engine.approve(o.sessionId, "too early")).rejects.toThrow(/hasn't finished/);

        for (e = await run.next(); !e.done; e = await run.next());
        const { branch, commit } = await engine.approve(o.sessionId, "Fix the failing test");
        expect(git(repo, "rev-parse", branch)).toBe(commit);
    });

    it("reject removes the worktree and the branch", async () => {
        const { engine } = setup();
        const repo = makeRepo();
        const o = options(repo);
        await drain(engine.start(o));
        const worktree = engine.worktree(o.sessionId)!;
        await engine.reject(o.sessionId);
        expect(existsSync(worktree)).toBe(false);
        expect(git(repo, "branch", "--list", "codehands/*")).toBe("");
    });

    it("stops during implement, then resume carries on through test and review", async () => {
        const pidFile = join(tmp, `engine-child-${randomUUID()}.pid`);
        const { engine } = setup({
            runner: {
                agentCommand: () => ({ file: process.execPath, args: [replay, spike, "0", "hang", pidFile] }),
                resumeCommand: () => ({ file: process.execPath, args: [replay, spike, "0", "edit"] }),
            },
        });
        const o = options(makeRepo());
        const first: RunnerEvent[] = [];
        let stopping: Promise<void> | undefined;
        for await (const e of engine.start(o)) {
            first.push(e);
            if (e.type === "message" && e.payload.text === "Claude Code started") stopping = engine.stop(o.sessionId);
        }
        await stopping;
        expect(first.map((e) => e.type).slice(-2)).toEqual(["step.finished", "task.stopped"]);
        await expect(engine.stop(o.sessionId)).rejects.toThrow(/only stop during implement/);

        const rest = await drain(engine.resume(o.sessionId));
        expect(steps(rest)).toEqual([">implement", "<implement", ">test", "<test", ">review", "<review"]);
        expect(rest.at(-1)!.type).toBe("approval.requested");
        const all = [...first, ...rest];
        expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    });

    it("refuses to stop outside implement, and to resume what isn't stopped", async () => {
        const { engine } = setup();
        const o = options(makeRepo());
        await drain(engine.start(o));
        await expect(engine.stop(o.sessionId)).rejects.toThrow(/only stop during implement \(now: not running\)/);
        await expect(drain(engine.resume(o.sessionId))).rejects.toThrow(/is not stopped/);
        await expect(engine.stop(randomUUID())).rejects.toThrow(/unknown engine session/);
    });
});

describe.skipIf(!hasDocker)("engine with the real Docker box", { timeout: 60_000 }, () => {
    it("runs the tests in the box, in the worktree with the agent's change", async () => {
        const { engine } = setup({ sandbox: runInSandbox });
        const events = await drain(engine.start(options(makeRepo())));
        expect(testResult(events)).toMatchObject({ ran: true, passed: true, exitCode: 0 });
        expect(events.at(-1)!.type).toBe("approval.requested");
    });
});