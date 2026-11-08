// pnpm sandbox [repoPath] [--tz <zone>]: runs the repo's tests in the locked box once. No model calls, no cost.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectRepoProfile, runInSandbox } from "../src/index.js";

const args = process.argv.slice(2);
const tzAt = args.indexOf("--tz");
const timeZone = tzAt >= 0 ? args[tzAt + 1] : undefined;
const repoPath = args.find((a, i) => !a.startsWith("--") && (tzAt < 0 || i !== tzAt + 1)) ?? join(homedir(), "codehands-fixtures", "date-bug");

const profile = await detectRepoProfile(repoPath);
console.log("profile:", profile);
const r = await runInSandbox({ sessionId: randomUUID(), worktree: repoPath, profile, timeZone });
console.log(r.output.trim().split("\n").slice(-30).join("\n"));
console.log({ passed: r.passed, exitCode: r.exitCode, timedOut: r.timedOut, oomKilled: r.oomKilled, durationMs: r.durationMs, error: r.error, message: r.message, resultFile: r.resultFile });
process.exitCode = r.passed ? 0 : 1;
