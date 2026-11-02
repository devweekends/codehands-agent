import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// What the runner knows about a repo without asking a model. Read from files only.
export interface RepoProfile {
  language: "node" | "python" | "unknown";
  packageManager?: "npm" | "pnpm" | "yarn";
  testCommand?: string;     // "npm test", "pnpm test" … undefined when the repo has none
  nodeVersion: string;      // major only, "22". Picks the sandbox image node:<v>-slim
  needsInstall: boolean;    // has dependencies and no node_modules
}

const NPM_DEFAULT_TEST = /no test specified/;

// Never throws: a broken or unknown repo gives "unknown", not an error.
export async function detectRepoProfile(dir: string): Promise<RepoProfile> {
  const has = (name: string) => existsSync(join(dir, name));
  const pkg = readJson(join(dir, "package.json"));
  if (!pkg) return { language: has("pyproject.toml") ? "python" : "unknown", nodeVersion: "22", needsInstall: false };

  const packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
  const test = pkg.scripts?.test;
  const testCommand = typeof test === "string" && !NPM_DEFAULT_TEST.test(test) ? `${packageManager} test` : undefined;
  const nodeVersion = majorVersion(readText(join(dir, ".nvmrc"))) ?? majorVersion(pkg.engines?.node) ?? "22";
  const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
  return { language: "node", packageManager, testCommand, nodeVersion, needsInstall: hasDeps && !has("node_modules") };
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function readText(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

// "v22.18.0", ">=22", "22" -> "22". Anything without a number -> undefined.
export function majorVersion(text: string | undefined): string | undefined {
  return text?.match(/\d+/)?.[0];
}
