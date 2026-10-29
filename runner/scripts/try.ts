// pnpm try [repoPath] [prompt] [--approve | --reject] [--stop]: one real run through the runner, one event per line.
// Without a flag it asks approve / reject / keep at the end (or keeps, when not in a terminal).
// --stop stops the run at its first command (npm test), then resumes it. Check Task Manager while it is stopped.
// Costs real money (capped by budgetUsd below). Run scripts/reset-fixture.sh afterwards.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { RunnerEvent } from "@codehands/contracts";
import { createRunner } from "../src/index.js";

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const [repoPath = join(homedir(), "codehands-fixtures", "date-bug"), prompt = "Fix the failing test. Run npm test to check."] =
  process.argv.slice(2).filter((a) => !a.startsWith("--"));

const runner = createRunner();
const sessionId = randomUUID();
let finished = false;
let stopping: Promise<void> | undefined;
async function print(run: AsyncIterable<RunnerEvent>, stopAtCommand = false) {
  for await (const e of run) {
    const p = e.payload;
    const detail = p.reason ?? p.command ?? p.path ?? (typeof p.text === "string" ? p.text.slice(0, 80) : "") ?? "";
    const extra = e.type === "test.result" ? ` passed=${p.passed}` : e.type === "task.finished" ? ` $${p.total_cost_usd}` : "";
    console.log(`${String(e.seq).padStart(3)}  ${e.type.padEnd(17)} ${String(detail).replace(/\s+/g, " ")}${extra}`);
    if (e.type === "task.finished") finished = true;
    if (stopAtCommand && e.type === "command.started" && !stopping) stopping = runner.stop(sessionId);
  }
}

await print(runner.start({ sessionId, repoPath, prompt, agent: "claude-code", model: "sonnet", budgetUsd: 0.5 }), flags.includes("--stop"));
if (stopping) {
  await stopping;
  console.log("\nstopped. Check Task Manager for claude, node or npm left over. Resuming in 10 s...\n");
  await new Promise((r) => setTimeout(r, 10_000));
  await print(runner.resume(sessionId));
}
if (!finished) process.exit(1);

console.log(`\n${(await runner.diff(sessionId)).stat}\n`);

let choice = flags.includes("--approve") ? "a" : flags.includes("--reject") ? "r" : "k";
if (!flags.length && process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  choice = (await rl.question("approve, reject or keep? [a/r/k] ")).trim().toLowerCase()[0] ?? "k";
  rl.close();
}

if (choice === "a") {
  const { branch, commit } = await runner.approve(sessionId, prompt);
  console.log(`approved: ${branch} @ ${commit.slice(0, 7)}  (git log ${branch} --oneline -1)`);
} else if (choice === "r") {
  await runner.reject(sessionId);
  console.log("rejected: worktree and branch deleted");
} else {
  console.log("kept: the worktree is still there, see `git worktree list` in the repo");
}
