import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent, RunnerEventType, StartOptions, StepName } from "@codehands/contracts";
import { EventSequence } from "../events.js";
import { baseCommit, git } from "../git/worktree.js";
import { createFileMemory, repoKey } from "../memory/notes.js";
import { detectRepoProfile } from "../memory/profile.js";
import { notesForPrompt, type MemoryStore } from "../memory/store.js";
import { createRunner, type RecoverableRunner } from "../runner.js";
import { runInSandbox, type SandboxOptions, type SandboxResult } from "../runtime/sandbox.js";
import { createClaudeModel, type ModelClient } from "./model.js";
import { analyzePrompt, implementPrompt, parseVerdict, planPrompt, reviewPrompt, type Prompt } from "./prompts.js";

// Engine v1: analyze → plan → implement → test → review → awaiting approval.
// The same Runner interface as the runner, so the daemon picks it for agent "codehands".
// One rule: once the change exists, nothing after it throws it away. Tests that can't run
// and a review that fails still end in awaiting approval, with the reason in the events.

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const SAFE_ID = /^[\w-]+$/;  // the session id names a folder

export interface EngineOptions {
    runner?: RecoverableRunner;  // does implement, diff, approve and reject. Default createRunner()
    model?: ModelClient;         // answers analyze, plan and review. Default createClaudeModel()
    sandbox?: (o: SandboxOptions) => Promise<SandboxResult>;  // the test step. Default runInSandbox
    memory?: MemoryStore;        // what earlier runs learned. Default createFileMemory()
    runsRoot?: string;           // step files. Default ~/.codehands/runs
}

interface EngineRun {
    options: StartOptions;
    seq: EventSequence;
    step?: StepName;    // the step running now
    stopped: boolean;   // stopped during implement, waiting for resume()
    done: boolean;      // approval.requested went out
    plan: string;
    files: number;      // step files written so far: 1-analyze.json, 2-plan.json …
    costUsd: number;
}

type Outcome = { ok: true; text: string } | { ok: false; reason: string };

// Which model a step uses: its own, then the run's, then the default.
export const modelFor = (o: StartOptions, step: StepName) => o.models?.[step] ?? o.model ?? DEFAULT_MODEL;

export function createEngine({
    runner = createRunner(),
    model = createClaudeModel(),
    sandbox = runInSandbox,
    memory = createFileMemory(),
    runsRoot = join(homedir(), ".codehands", "runs"),
}: EngineOptions = {}): RecoverableRunner {
    const runs = new Map<string, EngineRun>();

    function get(sessionId: string): EngineRun {
        const run = runs.get(sessionId);
        if (!run) throw new Error(`unknown engine session ${sessionId}`);
        return run;
    }

    const emit = (run: EngineRun, type: RunnerEventType, payload: Record<string, unknown> = {}, raw?: unknown) =>
        run.seq.next(type, payload, raw);

    // Every step leaves a file: what went in, what came out, cost and time. Week 4 resumes from these.
    // A step file must never fail a run, so errors are swallowed.
    async function saveStep(run: EngineRun, step: StepName, record: Record<string, unknown>): Promise<void> {
        run.files += 1;
        const dir = join(runsRoot, run.options.sessionId);
        try {
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, `${run.files}-${step}.json`), JSON.stringify({ step, ...record }, null, 2));
        } catch { }
    }

    // analyze, plan and review: one model call each, with no tools.
    async function* think(run: EngineRun, step: StepName, p: Prompt): AsyncGenerator<RunnerEvent, Outcome> {
        run.step = step;
        const m = modelFor(run.options, step);
        yield emit(run, "step.started", { step, model: m });
        const started = Date.now();
        try {
            const reply = await model.complete({ step, model: m, ...p });
            run.costUsd += reply.costUsd;
            await saveStep(run, step, { ok: true, model: m, durationMs: Date.now() - started, costUsd: reply.costUsd, input: p, output: reply.text });
            yield emit(run, "message", { step, text: reply.text });
            yield emit(run, "step.finished", { step, ok: true, costUsd: reply.costUsd });
            return { ok: true, text: reply.text };
        } catch (err) {
            const reason = (err as Error).message;
            await saveStep(run, step, { ok: false, model: m, durationMs: Date.now() - started, input: p, error: reason });
            yield emit(run, "step.finished", { step, ok: false });
            return { ok: false, reason };
        }
    }

    // Claude Code does the work in the runner's worktree. Its events go out as they arrive, renumbered
    // and tagged with the step. The runner's own task.started, task.finished and approval.requested
    // stay inside: the engine sends its own when the whole run is done.
    async function* implement(run: EngineRun, inner: AsyncIterable<RunnerEvent>, prompt: string): AsyncGenerator<RunnerEvent, "done" | "stopped" | "failed"> {
        run.step = "implement";
        run.stopped = false;
        const m = modelFor(run.options, "implement");
        yield emit(run, "step.started", { step: "implement", model: m });
        const started = Date.now();
        for await (const e of inner) {
            if (e.type === "approval.requested") continue;
            if (e.type === "task.started") {
                yield emit(run, "message", { step: "implement", text: "Claude Code started" }, e.raw);
            } else if (e.type === "task.finished") {
                const costUsd = Number(e.payload.total_cost_usd ?? 0);
                run.costUsd += costUsd;
                await saveStep(run, "implement", { ok: true, model: m, durationMs: Date.now() - started, costUsd, input: prompt, output: e.payload.result, diffStat: e.payload.diffStat });
                yield emit(run, "step.finished", { step: "implement", ok: true, costUsd });
                return "done";
            } else if (e.type === "task.stopped") {
                run.stopped = true;
                yield emit(run, "step.finished", { step: "implement", ok: false });
                yield emit(run, "task.stopped", { step: "implement" });
                return "stopped";
            } else if (e.type === "task.failed") {
                await saveStep(run, "implement", { ok: false, model: m, durationMs: Date.now() - started, input: prompt, error: e.payload.reason });
                yield emit(run, "step.finished", { step: "implement", ok: false });
                yield emit(run, "task.failed", { ...e.payload, step: "implement" });
                return "failed";
            } else {
                yield emit(run, e.type, { ...e.payload, step: "implement" }, e.raw);
            }
        }
        yield emit(run, "task.failed", { reason: "implement ended without a result", step: "implement" });
        return "failed";
    }

    // test and review, then the end of the run. Shared by start() and resume().
    async function* finish(run: EngineRun): AsyncGenerator<RunnerEvent> {
        const { sessionId } = run.options;

        run.step = "test";
        yield emit(run, "step.started", { step: "test" });
        const started = Date.now();
        const worktree = runner.worktree(sessionId);
        let result: SandboxResult;
        try {
            if (!worktree) throw new Error("the runner has no worktree for this session");
            result = await sandbox({ sessionId, worktree, profile: await detectRepoProfile(worktree), runsRoot });
        } catch (err) {
            // runInSandbox never throws, but a stand-in might.
            result = { command: "", image: "", passed: false, exitCode: null, timedOut: false, oomKilled: false, durationMs: 0, output: "", outputTruncated: false, error: "sandbox.failed", message: (err as Error).message };
        }
        const ran = !result.error;
        const { output: _output, ...summary } = result;  // the output itself is in result.resultFile
        await saveStep(run, "test", { ok: ran, durationMs: Date.now() - started, result: summary });
        yield emit(run, "test.result", { step: "test", ran, ...summary });
        yield emit(run, "step.finished", { step: "test", ok: ran });

        const { patch, stat } = await runner.diff(sessionId);
        const review = yield* think(run, "review", reviewPrompt(run.options.prompt, run.plan, patch, result));
        const verdict = review.ok ? parseVerdict(review.text) : "unknown";

        run.step = undefined;
        run.done = true;
        yield emit(run, "task.finished", {
            diffStat: stat,
            verdict,
            review: review.ok ? review.text : `review failed: ${review.reason}`,
            tests: { ran, passed: result.passed },
            total_cost_usd: run.costUsd,
        });
        yield emit(run, "approval.requested", { diffStat: stat, verdict });
    }

    const fail = (run: EngineRun, step: StepName | undefined, reason: string) =>
        emit(run, "task.failed", { reason: step ? `${step}: ${reason}` : reason, step });

    return {
        async *start(o) {
            if (runs.has(o.sessionId)) throw new Error(`session ${o.sessionId} already exists`);
            const run: EngineRun = { options: o, seq: new EventSequence(o.sessionId), stopped: false, done: false, plan: "", files: 0, costUsd: 0 };
            runs.set(o.sessionId, run);

            if (o.agent !== "codehands") {
                yield fail(run, undefined, `the engine runs agent "codehands", not "${o.agent}"`);
                return;
            }
            if (!SAFE_ID.test(o.sessionId)) {
                yield fail(run, undefined, `bad session id: ${o.sessionId}`);
                return;
            }
            yield emit(run, "task.started", { agent: "codehands", prompt: o.prompt });

            try {
                // Check the repo before paying for any model call: implement needs a commit to branch from.
                await baseCommit(o.repoPath);
                const profile = await detectRepoProfile(o.repoPath);
                const files = (await git(o.repoPath, ["ls-files"]).catch(() => "")).split("\n").filter(Boolean);
                const notes = await memory.notes(await repoKey(o.repoPath)).then(notesForPrompt).catch(() => undefined);

                const analysis = yield* think(run, "analyze", analyzePrompt(o.prompt, profile, files, notes));
                if (!analysis.ok) return void (yield fail(run, "analyze", analysis.reason));

                const plan = yield* think(run, "plan", planPrompt(o.prompt, analysis.text));
                if (!plan.ok) return void (yield fail(run, "plan", plan.reason));
                run.plan = plan.text;

                const prompt = implementPrompt(o.prompt, plan.text);
                const outcome = yield* implement(run, runner.start({ ...o, agent: "claude-code", prompt, model: modelFor(o, "implement") }), prompt);
                if (outcome === "done") yield* finish(run);
            } catch (err) {
                yield fail(run, run.step, (err as Error).message);
            }
        },

        // v1 can only stop while Claude Code works. analyze, plan and review are single short calls.
        async stop(sessionId) {
            const run = get(sessionId);
            if (run.step !== "implement" || run.stopped) {
                throw new Error(`the engine can only stop during implement (now: ${run.stopped ? "stopped" : run.step ?? "not running"})`);
            }
            await runner.stop(sessionId);
        },

        async *resume(sessionId, prompt) {
            const run = get(sessionId);
            if (!run.stopped) throw new Error(`session ${sessionId} is not stopped`);
            try {
                const outcome = yield* implement(run, runner.resume(sessionId, prompt), prompt ?? "Continue.");
                if (outcome === "done") yield* finish(run);
            } catch (err) {
                yield fail(run, run.step, (err as Error).message);
            }
        },

        diff: (sessionId) => runner.diff(sessionId),

        // The runner already allows approve after implement. The engine waits for test and review.
        async approve(sessionId, message) {
            const run = runs.get(sessionId);
            if (run && !run.done) throw new Error(`the engine hasn't finished ${sessionId} yet (now: ${run.stopped ? "stopped" : run.step ?? "not running"})`);
            return runner.approve(sessionId, message);
        },

        reject: (sessionId) => runner.reject(sessionId),
        recover: () => runner.recover(),
        worktree: (sessionId) => runner.worktree(sessionId),
    };
}