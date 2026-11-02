import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectRepoProfile } from "../src/memory/profile.js";

// Each test makes a tiny fake repo in a temp folder. Only files, no git, no API cost.
const tmp = mkdtempSync(join(tmpdir(), "codehands-profile-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmp, "repo-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const pkg = (body: object) => JSON.stringify(body);

describe("detectRepoProfile", () => {
  it("reads a plain npm repo like the fixture", async () => {
    const dir = repoWith({ "package.json": pkg({ scripts: { test: "node --test" } }) });
    expect(await detectRepoProfile(dir)).toEqual({
      language: "node", packageManager: "npm", testCommand: "npm test", nodeVersion: "22", needsInstall: false,
    });
  });

  it("picks pnpm from its lockfile", async () => {
    const dir = repoWith({ "package.json": pkg({ scripts: { test: "vitest run" } }), "pnpm-lock.yaml": "" });
    expect(await detectRepoProfile(dir)).toMatchObject({ packageManager: "pnpm", testCommand: "pnpm test" });
  });

  it("ignores npm's placeholder test script", async () => {
    const dir = repoWith({ "package.json": pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    expect((await detectRepoProfile(dir)).testCommand).toBeUndefined();
  });

  it("reads the Node version from .nvmrc", async () => {
    const dir = repoWith({ "package.json": pkg({}), ".nvmrc": "v20.11.0\n" });
    expect((await detectRepoProfile(dir)).nodeVersion).toBe("20");
  });

  it("falls back to engines.node", async () => {
    const dir = repoWith({ "package.json": pkg({ engines: { node: ">=18" } }) });
    expect((await detectRepoProfile(dir)).nodeVersion).toBe("18");
  });

  it("needs install when there are dependencies and no node_modules", async () => {
    const dir = repoWith({ "package.json": pkg({ dependencies: { x: "1" } }) });
    expect((await detectRepoProfile(dir)).needsInstall).toBe(true);

    writeFileSync(join(mkdirSync(join(dir, "node_modules"), { recursive: true })!, ".keep"), "");
    expect((await detectRepoProfile(dir)).needsInstall).toBe(false);
  });

  it("treats a broken package.json as unknown instead of throwing", async () => {
    const dir = repoWith({ "package.json": "{oops" });
    expect(await detectRepoProfile(dir)).toMatchObject({ language: "unknown", nodeVersion: "22", needsInstall: false });
  });

  it("spots a python repo", async () => {
    const dir = repoWith({ "pyproject.toml": "[project]\nname = \"x\"\n" });
    expect((await detectRepoProfile(dir)).language).toBe("python");
  });

  it("gives unknown for an empty folder", async () => {
    expect(await detectRepoProfile(repoWith({}))).toEqual({ language: "unknown", nodeVersion: "22", needsInstall: false });
  });
});
