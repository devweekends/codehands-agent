import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent, RunnerEventType, StartOptions, StepName } from "@codehands/contracts";
import { EventSequence } from "../events.js";
import { baseCommit, git } from "../git/worktree.js";
import { createFileMemory, repoKey } from "../memory/notes.js";
import { detectRepoProfile } from "../memory/profile.js";
import { notesForPrompt, type MemoryStore } from "../memory/store.js";
import { createRunner, type RecoverableRunner, type RecoveryReport } from "../runner.js";
import { runInSandbox, type SandboxOptions, type SandboxResult } from "../runtime/sandbox.js";
import { createClaudeModel, type ModelClient } from "./model.js";
import { analyzePrompt, implementPrompt, MAX_TEST_OUTPUT, parseVerdict, planPrompt, reviewPrompt, type Prompt } from "./prompts.js";
import { RunStore, type RunState } from "./run-store.js";

// Engine v1: analyze → plan → implement → test → review → awaiting approval.
// The same Runner interface as the runner, so the daemon picks it for agent "codehands".
// One rule: once the change exists, nothing after it throws it away. Tests that can't run
// and a review that fails still end in awaiting approval, with the reason in the events.
// Task 5: every event saves run.json first, so after a crash recover() + resume() carry on
// from the first step that didn't finish.

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const SAFE_ID = /^[\w-]+$/;  // the session id names a folder

export interface EngineOptions {
    runner?: RecoverableRunner;  // does implement, diff, approve and reject. Default createRunner()
    model?: ModelClient;         // answers analyze, plan and review. Default createClaudeModel()
    sandbox?: (o: SandboxOptions) => Promise<SandboxResult>;  // the test step. Default runInSandbox
    memory?: MemoryStore;        // what earlier runs learned. Default createFileMemory()
    runsRoot?: string;           // step files and run.json. Default ~/.codehands/runs
}

// A run this process is driving: its saved state, plus the event counter.
interface Run {
    state: RunState;
    seq: EventSequence;
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
    const store = new RunStore(runsRoot);
    // Runs whose events are flowing in this process. Saved as running but not in here = cut off by a crash.
    const live = new Map<string, Run>();

    function stateOf(sessionId: string): RunState {
        const state = live.get(sessionId)?.state ?? store.load(sessionId);
        if (!state) throw new Error(`unknown engine session ${sessionId}`);
        return state;
    }

    // For error messages: what the run is doing now.
    function now(sessionId: string, s: RunState): string {
        if (s.status === "stopped") return "stopped";
        if (s.status !== "running") return "not running";
        return live.has(sessionId) ? s.step ?? "starting" : "cut off by a restart, resume it";
    }

    // Saves the state before the event goes out. After a crash, seq carries on from here,
    // and every step whose result is in the state is never paid for twice.
    function emit(run: Run, type: RunnerEventType, payload: Record<string, unknown> = {}, raw?: unknown): RunnerEvent {
        const event = run.seq.next(type, payload, raw);
        run.state.lastSeq = run.seq.last;
        store.save(run.state);
        return event;
    }

    function fail(run: Run, step: StepName | undefined, reason: string): RunnerEvent {
        run.state.status = "failed";
        return emit(run, "task.failed", { reason: step ? `${step}: ${reason}` : reason, step });
    }

    // Every step leaves a file: what went in, what came out, cost and time.
    // A step file must never fail a run, so errors are swallowed.
    async function saveStep(run: Run, step: StepName, record: Record<string, unknown>): Promise<void> {
        run.state.files += 1;
        const dir = join(runsRoot, run.state.options.sessionId);
        try {
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, `${run.state.files}-${step}.json`), JSON.stringify({ step, ...record }, null, 2));
        } catch { }
    }

    // analyze, plan and review: one model call each, with no tools.
    // keep() puts the answer in the state before step.finished goes out, so it's saved with it.
    async function* think(run: Run, step: StepName, p: Prompt, keep: (text: string) => void): AsyncGenerator<RunnerEvent, Outcome> {
        run.state.step = step;
        const m = modelFor(run.state.options, step);
        yield emit(run, "step.started", { step, model: m });
        const started = Date.now();
        try {
            const reply = await model.complete({ step, model: m, ...p });
            run.state.costUsd += reply.costUsd;
            await saveStep(run, step, { ok: true, model: m, durationMs: Date.now() - started, costUsd: reply.costUsd, input: p, output: reply.text });
            keep(reply.text);
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
    async function* implement(run: Run, inner: AsyncIterable<RunnerEvent>, prompt: string): AsyncGenerator<RunnerEvent, "done" | "stopped" | "failed"> {
        run.state.step = "implement";
        const m = modelFor(run.state.options, "implement");
        yield emit(run, "step.started", { step: "implement", model: m });
        const started = Date.now();
        for await (const e of inner) {
            if (e.type === "approval.requested") continue;
            if (e.type === "task.started") {
                yield emit(run, "message", { step: "implement", text: "Claude Code started" }, e.raw);
            } else if (e.type === "task.finished") {
                const costUsd = Number(e.payload.total_cost_usd ?? 0);
                run.state.costUsd += costUsd;
                run.state.implemented = true;
                await saveStep(run, "implement", { ok: true, model: m, durationMs: Date.now() - started, costUsd, input: prompt, output: e.payload.result, diffStat: e.payload.diffStat });
                yield emit(run, "step.finished", { step: "implement", ok: true, costUsd });
                return "done";
            } else if (e.type === "task.stopped") {
                run.state.status = "stopped";
                yield emit(run, "step.finished", { step: "implement", ok: false });
                yield emit(run, "task.stopped", { step: "implement" });
                return "stopped";
            } else if (e.type === "task.failed") {
                // The runner's own failures have a reason. Claude Code's (an error result) have only result and subtype.
                const reason = String(e.payload.reason ?? e.payload.result ?? e.payload.subtype ?? "Claude Code failed");
                await saveStep(run, "implement", { ok: false, model: m, durationMs: Date.now() - started, input: prompt, error: reason });
                yield emit(run, "step.finished", { step: "implement", ok: false });
                run.state.status = "failed";
                yield emit(run, "task.failed", { ...e.payload, reason: `implement: ${reason}`, step: "implement" });
                return "failed";
            } else {
                yield emit(run, e.type, { ...e.payload, step: "implement" }, e.raw);
            }
        }
        yield fail(run, "implement", "Claude Code ended without a result");
        return "failed";
    }

    // Where Claude Code's part comes from: a new session, the stopped one, or none at all
    // when it finished just before a restart. undefined means implement is already done.
    function implementStream(run: Run, prompt: string, resumePrompt?: string): AsyncIterable<RunnerEvent> | undefined {
        const o = run.state.options;
        const status = runner.status(o.sessionId);
        if (status === undefined) return runner.start({ ...o, agent: "claude-code", prompt, model: modelFor(o, "implement") });
        if (status === "stopped") return runner.resume(o.sessionId, resumePrompt);
        if (status === "awaiting_approval") return undefined;
        throw new Error(`can't continue: Claude Code's session is ${status}`);
    }

    // The tests, in the Task 3 box, in the worktree with the change.
    async function* test(run: Run): AsyncGenerator<RunnerEvent> {
        const { sessionId } = run.state.options;
        run.state.step = "test";
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
        const { output, ...summary } = result;  // the whole output is in result.resultFile
        run.state.tests = { ...result, output: output.slice(-MAX_TEST_OUTPUT) };  // what review needs, if it runs after a restart
        await saveStep(run, "test", { ok: ran, durationMs: Date.now() - started, result: summary });
        yield emit(run, "test.result", { step: "test", ran, ...summary });
        yield emit(run, "step.finished", { step: "test", ok: ran });
    }

    // Review, then the end of the run.
    async function* finish(run: Run): AsyncGenerator<RunnerEvent> {
        const s = run.state;
        const tests = s.tests!;
        const { patch, stat } = await runner.diff(s.options.sessionId);
        if (!s.review) {
            const review = yield* think(run, "review", reviewPrompt(s.options.prompt, s.plan!, patch, tests), (text) => {
                s.review = { verdict: parseVerdict(text), text };
            });
            if (!review.ok) s.review = { verdict: "unknown", text: `review failed: ${review.reason}` };
        }
        const { verdict, text } = s.review!;
        s.step = undefined;
        yield emit(run, "task.finished", {
            diffStat: stat,
            verdict,
            review: text,
            tests: { ran: !tests.error, passed: tests.passed },
            total_cost_usd: s.costUsd,
        });
        s.status = "awaiting_approval";
        yield emit(run, "approval.requested", { diffStat: stat, verdict });
    }

    // The five steps, skipping every step whose result is already in the state.
    // start(), resume() after a stop, and resume() after a crash all come through here.
    async function* drive(run: Run, resumePrompt?: string): AsyncGenerator<RunnerEvent> {
        const s = run.state;
        const o = s.options;
        live.set(o.sessionId, run);
        try {
            if (s.analysis === undefined) {
                // Check the repo before paying for any model call: implement needs a commit to branch from.
                await baseCommit(o.repoPath);
                const profile = await detectRepoProfile(o.repoPath);
                const files = (await git(o.repoPath, ["ls-files"]).catch(() => "")).split("\n").filter(Boolean);
                const notes = await memory.notes(await repoKey(o.repoPath)).then(notesForPrompt).catch(() => undefined);
                const r = yield* think(run, "analyze", analyzePrompt(o.prompt, profile, files, notes), (t) => { s.analysis = t; });
                if (!r.ok) return void (yield fail(run, "analyze", r.reason));
            }
            if (s.plan === undefined) {
                const r = yield* think(run, "plan", planPrompt(o.prompt, s.analysis!), (t) => { s.plan = t; });
                if (!r.ok) return void (yield fail(run, "plan", r.reason));
            }
            if (!s.implemented) {
                s.step = "implement";
                const prompt = implementPrompt(o.prompt, s.plan!);
                const inner = implementStream(run, prompt, resumePrompt);
                if (inner) {
                    const outcome = yield* implement(run, inner, prompt);
                    if (outcome !== "done") return;
                } else {
                    s.implemented = true;  // Claude Code finished just before the restart
                    yield emit(run, "step.finished", { step: "implement", ok: true });
                }
            }
            if (!s.tests) yield* test(run);
            yield* finish(run);
        } catch (err) {
            yield fail(run, s.step, (err as Error).message);
        } finally {
            live.delete(o.sessionId);
        }
    }

    return {
        async *start(o) {
            // Checked before anything is saved: a bad id must never name a folder.
            if (o.agent !== "codehands" || !SAFE_ID.test(o.sessionId)) {
                const reason = o.agent !== "codehands" ? `the engine runs agent "codehands", not "${o.agent}"` : `bad session id: ${o.sessionId}`;
                yield new EventSequence(o.sessionId).next("task.failed", { reason });
                return;
            }
            if (live.has(o.sessionId) || store.load(o.sessionId)) throw new Error(`session ${o.sessionId} already exists`);
            const run: Run = { state: { options: o, status: "running", lastSeq: 0, files: 0, costUsd: 0 }, seq: new EventSequence(o.sessionId) };
            live.set(o.sessionId, run);
            yield emit(run, "task.started", { agent: "codehands", prompt: o.prompt });
            yield* drive(run);
        },

        // v1 can only stop while Claude Code works. analyze, plan and review are single short calls.
        async stop(sessionId) {
            const s = stateOf(sessionId);
            if (!live.has(sessionId) || s.status !== "running" || s.step !== "implement") {
                throw new Error(`the engine can only stop during implement (now: ${now(sessionId, s)})`);
            }
            await runner.stop(sessionId);
        },

        // Carries on a run that was stopped, or one a crash cut off (recover() lists those).
        // Steps that finished are skipped. seq carries on from the last event sent.
        async *resume(sessionId, prompt) {
            const s = stateOf(sessionId);
            if (live.has(sessionId)) throw new Error(`session ${sessionId} is already running`);
            const cutOff = s.status === "running";
            if (s.status !== "stopped" && !cutOff) throw new Error(`session ${sessionId} is not stopped`);
            const run: Run = { state: s, seq: new EventSequence(sessionId, s.lastSeq) };
            live.set(sessionId, run);  // now, so a second resume() is refused
            s.status = "running";
            if (cutOff) yield emit(run, "message", { step: s.step, text: `Picked up after a restart, from ${s.step ?? "the start"}` });
            yield* drive(run, prompt);
        },

        diff: (sessionId) => runner.diff(sessionId),

        // The runner already allows approve after implement. The engine waits for test and review,
        // even after a restart: run.json says whether review finished.
        async approve(sessionId, message) {
            const s = live.get(sessionId)?.state ?? store.load(sessionId);
            if (s && s.status !== "awaiting_approval") throw new Error(`the engine hasn't finished ${sessionId} yet (now: ${now(sessionId, s)})`);
            return runner.approve(sessionId, message);
        },

        reject: (sessionId) => runner.reject(sessionId),

        // Call once when the daemon starts, instead of runner.recover(): it calls that itself.
        // resumable: engine runs a crash cut off, for the daemon to resume(). Their Claude Code
        // session, if implement was running, is kept as stopped instead of failed.
        async recover() {
            const resumable: string[] = [];
            const unreadable: RecoveryReport["cleanupErrors"] = [];
            for (const sessionId of store.ids()) {
                try {
                    if (!live.has(sessionId) && store.load(sessionId)?.status === "running") resumable.push(sessionId);
                } catch (err) {
                    unreadable.push({ sessionId, reason: (err as Error).message });
                }
            }
            const report = await runner.recover({ keep: (id) => resumable.includes(id) });
            return { failed: report.failed, cleanupErrors: [...unreadable, ...report.cleanupErrors], resumable };
        },

        worktree: (sessionId) => runner.worktree(sessionId),

        // The run's own status until it's waiting for approval. After that the runner's, which knows approved and rejected.
        status(sessionId) {
            try {
                const s = live.get(sessionId)?.state ?? store.load(sessionId);
                return s && s.status !== "awaiting_approval" ? s.status : runner.status(sessionId);
            } catch {
                return undefined;
            }
        },
    };
}