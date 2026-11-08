import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, describe, expect, it } from "vitest";
import type { RepoProfile } from "../src/memory/profile.js";
import { dockerAvailable } from "../src/runtime/docker.js";
import { runInSandbox } from "../src/runtime/sandbox.js";

// Real containers. Skipped when Docker isn't running, so `pnpm test` never fails just because Docker Desktop is closed.
const hasDocker = await dockerAvailable();
const tmp = mkdtempSync(join(tmpdir(), "codehands-sandbox-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const npm: RepoProfile = { language: "node", packageManager: "npm", testCommand: "npm test", nodeVersion: "22", needsInstall: false };
const needsInstall: RepoProfile = { ...npm, needsInstall: true };

// A tiny repo whose `npm test` runs the given script.
function repoWithTest(script: string, pkg: object = {}): string {
  const dir = mkdtempSync(join(tmp, "repo-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", private: true, scripts: { test: script }, ...pkg }));
  return dir;
}

// A dependency that needs no registry, so the install tests work offline.
function repoWithLocalDep(script: string, pkg: object = {}): string {
  const dir = repoWithTest(script, { dependencies: { local: "file:./local" }, ...pkg });
  mkdirSync(join(dir, "local"));
  writeFileSync(join(dir, "local", "package.json"), JSON.stringify({ name: "local", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(dir, "local", "index.js"), "module.exports = 1;\n");
  // A copy, not a link: Node on Windows can't delete a symlink a Linux container made (EPERM), and afterAll has to.
  writeFileSync(join(dir, ".npmrc"), "install-links=true\n");
  return dir;
}

const run = (script: string, extra = {}) =>
  runInSandbox({ sessionId: randomUUID(), worktree: repoWithTest(script), profile: npm, runsRoot: join(tmp, "runs"), ...extra });

const leftOver = async (sessionId: string) =>
  (await execa("docker", ["ps", "-a", "--filter", `name=ch-${sessionId.slice(0, 8)}`, "--format", "{{.Names}}"])).stdout.trim();

describe.skipIf(!hasDocker)("runInSandbox (needs Docker)", { timeout: 60_000 }, () => {
  it("passes when the tests pass", async () => {
    const r = await run(`node -e "process.exit(0)"`);
    expect(r).toMatchObject({ passed: true, exitCode: 0, timedOut: false, oomKilled: false });
    expect(r.error).toBeUndefined();
  });

  it("fails, as a result, when the tests fail", async () => {
    const r = await run(`node -e "console.log('boom'); process.exit(3)"`);
    expect(r).toMatchObject({ passed: false, exitCode: 3 });
    expect(r.error).toBeUndefined();
    expect(r.output).toContain("boom");
  });

  it("kills a test that never ends and leaves no container behind", async () => {
    const sessionId = randomUUID();
    const r = await runInSandbox({ sessionId, worktree: repoWithTest(`node -e "setInterval(() => {}, 1000)"`), profile: npm, runsRoot: join(tmp, "runs"), timeoutMs: 3_000 });
    expect(r).toMatchObject({ passed: false, timedOut: true, exitCode: 137 });
    expect(r.durationMs).toBeLessThan(15_000);
    expect(await leftOver(sessionId)).toBe("");
  });

  it("still returns when the limit passes before the container exists", async () => {
    const sessionId = randomUUID();
    const r = await runInSandbox({ sessionId, worktree: repoWithTest(`node -e "setInterval(() => {}, 1000)"`), profile: npm, runsRoot: join(tmp, "runs"), timeoutMs: 1 });
    expect(r).toMatchObject({ passed: false, timedOut: true });
    expect(await leftOver(sessionId)).toBe("");
  });

  it("reports a test that runs out of memory", async () => {
    const r = await run(`node -e "const a = []; for (;;) a.push(Buffer.alloc(1e6, 1))"`, { limits: { memoryMb: 64, cpus: 1, pids: 256 } });
    expect(r).toMatchObject({ passed: false, oomKilled: true, timedOut: false });
  });

  it("has no network", async () => {
    const r = await run(`node -e "fetch('https://example.com').then(() => process.exit(0), () => process.exit(7))"`);
    expect(r).toMatchObject({ passed: false, exitCode: 7 });
  });

  it("can't change the repo", async () => {
    const r = await run(`touch /work/written-by-test`);
    expect(r.passed).toBe(false);
    expect(r.output).toMatch(/Read-only file system/);
  });

  it("can only write to its scratch folders, and can run programs from /tmp", async () => {
    const r = await run(`touch /tmp/a && touch ~/a && cp /bin/true /tmp/t && /tmp/t && touch /opt/a`);
    expect(r.passed).toBe(false);
    expect(r.output).toMatch(/\/opt\/a.*Read-only file system/);
  });

  it("keeps only the last 64 KB of a huge output", async () => {
    const r = await run(`node -e "for (let i = 0; i < 3000; i++) console.log('x'.repeat(1000)); console.log('THE END')"`);
    expect(r.outputTruncated).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(64 * 1024);
    expect(r.output.trim().endsWith("THE END")).toBe(true);
  });

  it("runs in the timezone it is given", async () => {
    const check = `node -e "process.exit(Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Karachi' ? 0 : 1)"`;
    expect((await run(check, { timeZone: "Asia/Karachi" })).passed).toBe(true);
    expect((await run(check, { timeZone: "UTC" })).passed).toBe(false);
  });

  it("saves the result as test-1.json, then test-2.json", async () => {
    const sessionId = randomUUID();
    const worktree = repoWithTest(`node -e "process.exit(0)"`);
    const runsRoot = join(tmp, "runs-saved");
    await runInSandbox({ sessionId, worktree, profile: npm, runsRoot });
    const second = await runInSandbox({ sessionId, worktree, profile: npm, runsRoot });
    expect(readdirSync(join(runsRoot, sessionId)).sort()).toEqual(["test-1.json", "test-2.json"]);
    expect(JSON.parse(readFileSync(second.resultFile!, "utf8"))).toMatchObject({ passed: true });
  });

  it("carries on numbering after a restart, so it never overwrites a result", async () => {
    const sessionId = randomUUID();
    const runsRoot = join(tmp, "runs-restart");
    mkdirSync(join(runsRoot, sessionId), { recursive: true });
    writeFileSync(join(runsRoot, sessionId, "test-1.json"), "{}");
    const r = await runInSandbox({ sessionId, worktree: repoWithTest(`node -e "process.exit(0)"`), profile: npm, runsRoot });
    expect(r.resultFile).toMatch(/test-2\.json$/);
    expect(readFileSync(join(runsRoot, sessionId, "test-1.json"), "utf8")).toBe("{}");
  });

  it("never reads the result of a container left behind by a crash", async () => {
    const sessionId = randomUUID();
    const stale = `ch-${sessionId.slice(0, 8)}-1`;
    await execa("docker", ["run", "--name", stale, "node:22-slim", "sh", "-c", "exit 0"]);
    const r = await runInSandbox({ sessionId, worktree: repoWithTest(`node -e "process.exit(3)"`), profile: npm, runsRoot: join(tmp, "runs") });
    expect(r).toMatchObject({ passed: false, exitCode: 3 });
    expect(await leftOver(sessionId)).toBe("");
  });

  it("says so when the container can't start, instead of blaming the tests", async () => {
    const r = await runInSandbox({ sessionId: randomUUID(), worktree: repoWithTest(`node -e "0"`), profile: { ...npm, nodeVersion: "99.99.99" }, runsRoot: join(tmp, "runs") });
    expect(r).toMatchObject({ passed: false, exitCode: null, error: "sandbox.failed" });
    expect(r.output).toMatch(/99\.99\.99/);
  });

  it("refuses a worktree that doesn't exist, and doesn't create it", async () => {
    const worktree = join(tmp, "not-there");
    const r = await runInSandbox({ sessionId: randomUUID(), worktree, profile: npm, runsRoot: join(tmp, "runs") });
    expect(r).toMatchObject({ passed: false, error: "sandbox.failed" });
    expect(existsSync(worktree)).toBe(false);
  });

  it("refuses a session id that isn't a plain name", async () => {
    const r = await runInSandbox({ sessionId: "../../x", worktree: tmp, profile: npm, runsRoot: join(tmp, "runs") });
    expect(r).toMatchObject({ passed: false, error: "sandbox.failed" });
  });

  it("refuses repos it can't handle yet", async () => {
    const r = await runInSandbox({ sessionId: randomUUID(), worktree: tmp, profile: { ...npm, packageManager: "pnpm" }, runsRoot: join(tmp, "runs") });
    expect(r.error).toBe("sandbox.unsupported");
  });

  it("installs first when the repo needs it, then tests", async () => {
    const worktree = repoWithLocalDep(`node -e "process.exit(require('local') === 1 ? 0 : 1)"`);
    const r = await runInSandbox({ sessionId: randomUUID(), worktree, profile: needsInstall, runsRoot: join(tmp, "runs") });
    expect(r).toMatchObject({ passed: true, exitCode: 0 });
    expect(existsSync(join(worktree, "node_modules"))).toBe(true);
    expect(existsSync(join(worktree, "package-lock.json"))).toBe(false); // it would land in the diff
  });

  it("doesn't run the repo's install scripts", async () => {
    const worktree = repoWithLocalDep(`node -e "0"`);
    const pkg = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8"));
    pkg.scripts.postinstall = `node -e "require('fs').writeFileSync('planted.txt', 'x')"`;
    writeFileSync(join(worktree, "package.json"), JSON.stringify(pkg));
    const r = await runInSandbox({ sessionId: randomUUID(), worktree, profile: needsInstall, runsRoot: join(tmp, "runs") });
    expect(r.passed).toBe(true);
    expect(existsSync(join(worktree, "planted.txt"))).toBe(false);
  });

  it("reports a failed install, and doesn't run the tests", async () => {
    const worktree = repoWithLocalDep(`node -e "console.log('TESTS RAN')"`);
    writeFileSync(join(worktree, "package-lock.json"), "{ not json");
    const r = await runInSandbox({ sessionId: randomUUID(), worktree, profile: needsInstall, runsRoot: join(tmp, "runs") });
    expect(r).toMatchObject({ passed: false, error: "install.failed", command: "npm ci" });
    expect(r.output).not.toContain("TESTS RAN");
    expect(r.resultFile).toBeDefined();
  });

  it("refuses to install when node_modules isn't git-ignored", async () => {
    const worktree = repoWithLocalDep(`node -e "0"`);
    execFileSync("git", ["init", "-q"], { cwd: worktree });
    const r = await runInSandbox({ sessionId: randomUUID(), worktree, profile: needsInstall, runsRoot: join(tmp, "runs") });
    expect(r).toMatchObject({ passed: false, error: "sandbox.unsupported" });
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  });
});

describe("runInSandbox without Docker", () => {
  it("says the box is unavailable, quickly", async () => {
    const started = Date.now();
    const r = await runInSandbox({ sessionId: randomUUID(), worktree: tmp, profile: npm, runsRoot: join(tmp, "runs"), docker: "docker-does-not-exist" });
    expect(r).toMatchObject({ passed: false, error: "sandbox.unavailable" });
    expect(Date.now() - started).toBeLessThan(6_000);
  });
});
