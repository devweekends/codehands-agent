import type { RepoProfile } from "../memory/profile.js";
import { execa } from "execa";
import { DEFAULT_LIMITS, dockerArgs, dockerAvailable, hostTimeZone, installArgs, type BoxLimits } from "./docker.js";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export interface SandboxOptions {
  sessionId: string;
  worktree: string;
  profile: RepoProfile;
  command?: string;          // default: profile.testCommand
  timeoutMs?: number;        // default 60_000
  limits?: BoxLimits;        // default DEFAULT_LIMITS
  timeZone?: string;         // default hostTimeZone()
  runsRoot?: string;         // default ~/.codehands/runs. Tests pass a temp folder
  docker?: string;           // default "docker". Tests pass a missing binary
}

export type SandboxError = "sandbox.unavailable" | "sandbox.unsupported" | "sandbox.failed" | "install.failed";

export interface SandboxResult {
  command: string;
  image: string;
  passed: boolean;           // exit 0, not timed out, not killed for memory
  exitCode: number | null;   // null when the process never finished: it didn't start, or it had to be abandoned
  timedOut: boolean;
  oomKilled: boolean;
  durationMs: number;
  output: string;            // stdout + stderr, the last 64 KB
  outputTruncated: boolean;
  error?: SandboxError;      // set when the tests never ran properly
  message?: string;          // a human sentence for error
  resultFile?: string;       // where the JSON was saved
}

const MAX_OUTPUT = 64 * 1024;
const SAFE_ID = /^[\w-]+$/;  // the session id names a folder and a container

// Every short docker command has a limit, so a stuck Docker can't hang us.
const cli = (docker: string, args: string[], timeout = 30_000) =>
  execa(docker, args, { reject: false, timeout, stdin: "ignore", windowsHide: true });

export async function runInSandbox(o: SandboxOptions): Promise<SandboxResult> {
  const docker = o.docker ?? "docker";
  const command = o.command ?? o.profile.testCommand ?? "";
  const image = `node:${o.profile.nodeVersion}-slim`;
  const base = { command, image, passed: false, exitCode: null, timedOut: false, oomKilled: false, durationMs: 0, output: "", outputTruncated: false };

  if (!(await dockerAvailable(docker))) {
    return { ...base, error: "sandbox.unavailable", message: "Docker is not running. Start Docker Desktop and try again." };
  }
  if (o.profile.language !== "node" || o.profile.packageManager !== "npm" || !command) {
    return { ...base, error: "sandbox.unsupported", message: `only npm repos with a test script for now (got ${o.profile.language}/${o.profile.packageManager ?? "none"})` };
  }
  if (!SAFE_ID.test(o.sessionId)) {
    return { ...base, error: "sandbox.failed", message: `bad session id: ${o.sessionId}` };
  }
  // Docker would create a missing folder and mount it empty, which looks like broken tests.
  const worktree = resolve(o.worktree);
  if (!existsSync(worktree)) {
    return { ...base, error: "sandbox.failed", message: `worktree not found: ${worktree}` };
  }
  await ensureImage(docker, image);

  const dir = join(o.runsRoot ?? join(homedir(), ".codehands", "runs"), o.sessionId);
  const n = nextRun(dir);
  const name = `ch-${o.sessionId.slice(0, 8)}-${n}`;
  const limits = o.limits ?? DEFAULT_LIMITS;

  if (o.profile.needsInstall) {
    // git add -A takes everything that isn't ignored, so node_modules would land in the commit you approve.
    const ignored = await execa("git", ["check-ignore", "-q", "node_modules/"], { cwd: worktree, reject: false, timeout: 10_000, stdin: "ignore", windowsHide: true });
    if (ignored.exitCode === 1) {
      return { ...base, error: "sandbox.unsupported", message: "add node_modules/ to .gitignore first, or the install would land in the diff" };
    }

    const installCommand = existsSync(join(worktree, "package-lock.json")) ? "npm ci" : "npm install --no-package-lock";
    const { started: _started, ...install } = await runContainer(docker, `${name}-install`, installArgs({
      name: `${name}-install`, worktree, image, command: installCommand, limits,
    }), 5 * 60_000);
    if (install.exitCode !== 0 || install.timedOut || install.oomKilled) {
      return save(dir, n, { ...base, ...install, command: installCommand, error: "install.failed", message: "npm could not install the dependencies. The output says why." });
    }

  }
  const { started, ...ran } = await runContainer(docker, name, dockerArgs({
    name, worktree, image, command, timeZone: o.timeZone ?? hostTimeZone(), limits,
  }), o.timeoutMs ?? 60_000);

  // A container that never started is not a failing test: the engine must not try to fix the code for it.
  if (!started && !ran.timedOut) {
    return save(dir, n, { ...base, ...ran, error: "sandbox.failed", message: "the container did not start. The output says why." });
  }

  return save(dir, n, { ...base, ...ran, passed: ran.exitCode === 0 && !ran.timedOut && !ran.oomKilled });
}

// Starts a named container, keeps the last 64 KB of output, kills it at the limit,
// reads what really happened from Docker, and always removes it.
async function runContainer(docker: string, name: string, args: string[], timeoutMs: number) {
  // A crash can leave this name behind. docker run would refuse it, and inspect would read the old result.
  await cli(docker, ["rm", "-f", name]);

  const started = Date.now();
  let output = "";
  let outputTruncated = false;
  let timedOut = false;

  const child = execa(docker, args, { reject: false, all: true, buffer: false, stdin: "ignore", windowsHide: true });
  child.all!.setEncoding("utf8");
  child.all!.on("data", (chunk: string) => {
    output += chunk;
    if (output.length > MAX_OUTPUT) {
      output = output.slice(-MAX_OUTPUT);
      outputTruncated = true;
    }
  });

  // docker kill does nothing if the container doesn't exist yet or Docker is stuck, so stop waiting after 10 s.
  let giveUp: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    void cli(docker, ["kill", name]);
    giveUp = setTimeout(() => child.kill("SIGKILL"), 10_000);
  }, timeoutMs);

  try {
    await child;
    clearTimeout(timer);
    clearTimeout(giveUp);
    const state = await readState(docker, name);
    const ran = state !== undefined && !state.Error && !state.StartedAt.startsWith("0001");
    return {
      started: ran,
      exitCode: ran && !state.Running ? state.ExitCode : null,
      oomKilled: state?.OOMKilled ?? false,
      timedOut,
      durationMs: Date.now() - started,
      output,
      outputTruncated,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(giveUp);
    await cli(docker, ["rm", "-f", name]);
  }
}

// What Docker knows about a container. undefined when there is no such container.
async function readState(docker: string, name: string) {
  const r = await cli(docker, ["inspect", name, "--format", "{{json .State}}"]);
  if (r.exitCode !== 0) return undefined;
  try {
    return JSON.parse(r.stdout) as { ExitCode: number; OOMKilled: boolean; Running: boolean; Error: string; StartedAt: string };
  } catch {
    return undefined;
  }
}

// Pulls the image before the timer starts, so a slow download never counts as a test timeout.
// A failed pull needs no check here: docker run fails next, and that becomes sandbox.failed.
async function ensureImage(docker: string, image: string): Promise<void> {
  const found = await cli(docker, ["image", "inspect", image]);
  if (found.exitCode !== 0) await cli(docker, ["pull", "-q", image], 5 * 60_000);
}

// Counted from the files, not memory, so a restart can't overwrite test-1.json.
function nextRun(dir: string): number {
  try {
    return readdirSync(dir).filter((file) => /^test-\d+\.json$/.test(file)).length + 1;
  } catch {
    return 1;
  }
}

// A full disk must not turn a result into a crash, so a failed save just leaves resultFile unset.
async function save(dir: string, n: number, result: SandboxResult): Promise<SandboxResult> {
  const resultFile = join(dir, `test-${n}.json`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(resultFile, JSON.stringify({ ...result, resultFile }, null, 2));
    return { ...result, resultFile };
  } catch {
    return result;
  }
}
