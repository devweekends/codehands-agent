// Week 2: the locked box. Every flag here is checked in test/docker-args.test.ts.
// Spike results (Nov 2): no --rm (OOMKilled must be read first), no pipes (they hide the exit code).
import { execa } from "execa";

// Week 2: the locked box. Every flag here is checked in test/docker-args.test.ts.
// Spike results (Nov 2): no --rm (OOMKilled must be read first), no pipes (they hide the exit code).

export interface BoxLimits {
  memoryMb: number;   // 1024. Swap is set to the same, so there is no swap
  cpus: number;       // 1
  pids: number;       // 256
}

export const DEFAULT_LIMITS: BoxLimits = { memoryMb: 1024, cpus: 1, pids: 256 };

// The test container: no network, read-only repo and system, non-root, no capabilities.
export function dockerArgs(o: {
  name: string; worktree: string; image: string; command: string; timeZone: string; limits?: BoxLimits;
}): string[] {
  const l = o.limits ?? DEFAULT_LIMITS;
  return [
    "run", "--name", o.name,
    "--network", "none",
    "--memory", `${l.memoryMb}m`, "--memory-swap", `${l.memoryMb}m`,
    "--cpus", String(l.cpus), "--pids-limit", String(l.pids),
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "node",
    "--read-only", "--tmpfs", "/tmp:exec", "--tmpfs", "/home/node:uid=1000,gid=1000",
    "-e", `TZ=${o.timeZone}`, "-e", "CI=1",
    "-v", `${o.worktree}:/work:ro`, "-w", "/work",
    o.image, "sh", "-c", o.command,
  ];
}

// Installs dependencies before the test: network ON, repo writable, so the repo's own scripts must not run.
export function installArgs(o: { name: string; worktree: string; image: string; command: string; limits?: BoxLimits }): string[] {
  const l = o.limits ?? DEFAULT_LIMITS;
  return [
    "run", "--name", o.name,
    "--memory", `${l.memoryMb}m`, "--memory-swap", `${l.memoryMb}m`,
    "--cpus", String(l.cpus), "--pids-limit", String(l.pids),
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "node",
    "-e", "CI=1", "-e", "npm_config_cache=/tmp/.npm", "-e", "npm_config_ignore_scripts=true",
    "-v", `${o.worktree}:/work`, "-w", "/work",
    o.image, "sh", "-c", o.command,
  ];
}

// True when the Docker engine answers within 5 s. Docker Desktop not running -> false, never a hang.
export async function dockerAvailable(docker = "docker"): Promise<boolean> {
  const r = await execa(docker, ["version", "--format", "{{.Server.Version}}"], { reject: false, timeout: 5_000, stdin: "ignore", windowsHide: true });
  return r.exitCode === 0 && r.stdout.trim() !== "";
}

// The host's IANA zone, e.g. "Asia/Karachi". Windows' own name ("Pakistan Standard Time") means nothing to Linux.
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
