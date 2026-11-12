// pnpm engine [repoPath] [prompt] [--free | --canned] [--wrong-fix] [--slow] [--approve | --reject]: one run, one event per line.
// pnpm engine --recover [--free | --canned] [--approve | --reject]: what the daemon does after a restart.
//   It finds the runs a crash cut off and finishes them.
// --canned answers analyze, plan and review from canned text, so only the implement step costs money.
// --free costs nothing: canned thinking, your recorded Claude run as implement (it also makes the real
//   one-line fix), and the real Docker box. Add --wrong-fix to see what failing tests look like.
// --slow waits 10 seconds in every thinking step and before Claude Code answers, so you can kill it halfway.
// Without --approve or --reject it keeps the worktree. Run scripts/reset-fixture.sh afterwards.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { RunnerEvent } from "@codehands/contracts";
import { createCannedModel, createEngine, createRunner, type ModelClient } from "../src/index.js";

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const [repoPath = join(homedir(), "codehands-fixtures", "date-bug"), prompt = "Fix the failing test. Run npm test to check."] =
    process.argv.slice(2).filter((a) => !a.startsWith("--"));
const free = flags.includes("--free");
const slow = flags.includes("--slow");

const canned = createCannedModel({
    analyze: "The test expects the day of the month in UTC. src/date.js probably reads it in local time.",
    plan: "1. Read src/date.js and test/date.test.js\n2. Read the day in UTC\n3. Run npm test",
    review: `VERDICT: ${flags.includes("--wrong-fix") ? "concerns" : "approve"}\n(canned review: no model was asked)`,
});
const thinking: ModelClient = slow ? { complete: async (r) => (await sleep(10_000), canned.complete(r)) } : canned;

// --free: instead of Claude Code, node prints your recorded run. First it makes the change the
// recorded run made: getDate() becomes getUTCDate() in src/date.js. --wrong-fix only adds a comment.
// It prints task.started at once and the rest after --slow's 10 seconds: the window to kill it in implement.
// The same stand-in answers a resume, so a run cut off during implement also finishes for free.
const recording = fileURLToPath(new URL("../test/fixtures/spike-1.jsonl", import.meta.url));
const [from, to] = flags.includes("--wrong-fix") ? ["getDate();", "getDate(); // the day"] : ["getDate()", "getUTCDate()"];
const replay = `const fs=require("fs"),f="src/date.js",lines=fs.readFileSync(process.argv[1],"utf8").split("\\n");
process.stdout.write(lines.slice(0,2).join("\\n")+"\\n");
setTimeout(()=>{
  if(fs.existsSync(f))fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(${JSON.stringify(from)},${JSON.stringify(to)}));
  process.stdout.write(lines.slice(2).join("\\n"));
},${slow ? 10_000 : 0});`;
const standIn = () => ({ file: process.execPath, args: ["-e", replay, recording] });
const runner = free ? createRunner({ agentCommand: standIn, resumeCommand: standIn }) : undefined;

const engine = createEngine({ runner, model: free || flags.includes("--canned") ? thinking : undefined });

function print(e: RunnerEvent) {
    const p = e.payload;
    const step = typeof p.step === "string" ? `[${p.step}]` : "";
    const detail = p.reason ?? p.command ?? p.path ?? p.model ?? (typeof p.text === "string" ? p.text.slice(0, 70) : "");
    const extra = e.type === "step.finished" ? ` ok=${p.ok}${p.costUsd ? ` $${Number(p.costUsd).toFixed(4)}` : ""}`
        : e.type === "test.result" && p.step === "test" ? ` ran=${p.ran} passed=${p.passed}${p.error ? ` ${p.error}` : ""}`
            : e.type === "task.finished" ? ` verdict=${p.verdict} $${Number(p.total_cost_usd).toFixed(4)}` : "";
    console.log(`${String(e.seq).padStart(3)}  ${e.type.padEnd(17)} ${step.padEnd(12)} ${String(detail).replace(/\s+/g, " ")}${extra}`);
}

// Prints a run's events, then approves, rejects or keeps it. false when it didn't finish.
async function watch(sessionId: string, events: AsyncIterable<RunnerEvent>): Promise<boolean> {
    let finished = false;
    for await (const e of events) {
        print(e);
        if (e.type === "task.finished") finished = true;
    }
    if (!finished) return false;
    console.log(`\nsession:    ${sessionId}`);
    console.log(`step files: ${join(homedir(), ".codehands", "runs", sessionId)}`);
    if (free) console.log("cost:       $0. The cost above is the recorded run's, replayed");
    if (flags.includes("--approve")) {
        const { branch, commit } = await engine.approve(sessionId, prompt);
        console.log(`approved:   ${branch} @ ${commit.slice(0, 7)}`);
    } else if (flags.includes("--reject")) {
        await engine.reject(sessionId);
        console.log("rejected:   worktree and branch deleted");
    } else {
        console.log("kept:       the worktree is still there, see `git worktree list` in the repo");
    }
    return true;
}

if (flags.includes("--recover")) {
    if (slow) console.log(`pid ${process.pid} · slow: kill me halfway too, then run --recover again\n`);
    const report = await engine.recover();
    console.log(`recover: ${report.resumable.length} to resume, ${report.failed.length} failed, ${report.cleanupErrors.length} cleanup errors`);
    let ok = true;
    for (const sessionId of report.resumable) {
        console.log(`\nresuming ${sessionId}`);
        ok = (await watch(sessionId, engine.resume(sessionId))) && ok;
    }
    if (!ok) process.exit(1);
} else {
    const sessionId = randomUUID();
    console.log(`pid ${process.pid} · session ${sessionId}${slow ? " · slow: kill me halfway, then run with --recover" : ""}\n`);
    if (!(await watch(sessionId, engine.start({ sessionId, repoPath, prompt, agent: "codehands", model: "sonnet", budgetUsd: 0.5 })))) process.exit(1);
}