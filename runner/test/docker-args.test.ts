import { describe, expect, it } from "vitest";
import { dockerArgs, hostTimeZone, installArgs } from "../src/runtime/docker.js";

const box = (extra = {}) => dockerArgs({ name: "ch-test-1", worktree: "C:\\Users\\My Name\\repo", image: "node:22-slim", command: "npm test", timeZone: "Asia/Karachi", ...extra });
const pair = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("dockerArgs (the test box)", () => {
  it("locks the box down", () => {
    const a = box();
    expect(pair(a, "--network")).toBe("none");
    expect(pair(a, "--memory")).toBe("1024m");
    expect(pair(a, "--memory-swap")).toBe("1024m");      // same as memory: no swap
    expect(pair(a, "--cpus")).toBe("1");
    expect(pair(a, "--pids-limit")).toBe("256");
    expect(pair(a, "--cap-drop")).toBe("ALL");
    expect(pair(a, "--security-opt")).toBe("no-new-privileges");
    expect(pair(a, "--user")).toBe("node");
    expect(pair(a, "-w")).toBe("/work");
  });

  it("makes the system read-only, with memory-backed folders for scratch space", () => {
    const a = box();
    expect(a).toContain("--read-only");
    expect(a).toContain("/tmp:exec");
    expect(a).toContain("/home/node:uid=1000,gid=1000");
  });

  it("mounts the worktree read-only, as one argument even with spaces", () => {
    expect(pair(box(), "-v")).toBe("C:\\Users\\My Name\\repo:/work:ro");
  });

  it("keeps the container after it exits, so OOMKilled can be read", () => {
    expect(box()).not.toContain("--rm");
  });

  it("passes the timezone and CI, and runs the command last", () => {
    const a = box();
    expect(a).toContain("TZ=Asia/Karachi");
    expect(a).toContain("CI=1");
    expect(a.slice(-4)).toEqual(["node:22-slim", "sh", "-c", "npm test"]);
  });

  it("uses the limits it is given", () => {
    const a = box({ limits: { memoryMb: 64, cpus: 2, pids: 50 } });
    expect(pair(a, "--memory")).toBe("64m");
    expect(pair(a, "--memory-swap")).toBe("64m");
    expect(pair(a, "--cpus")).toBe("2");
    expect(pair(a, "--pids-limit")).toBe("50");
  });
});

describe("installArgs (the install box)", () => {
  const a = installArgs({ name: "ch-test-1-install", worktree: "/w", image: "node:22-slim", command: "npm ci" });

  it("has the network and a writable repo, but stays non-root and limited", () => {
    expect(a).not.toContain("--network");
    expect(pair(a, "-v")).toBe("/w:/work");
    expect(pair(a, "--user")).toBe("node");
    expect(pair(a, "--cap-drop")).toBe("ALL");
    expect(pair(a, "--memory")).toBe("1024m");
  });

  it("never runs the repo's own install scripts", () => {
    expect(a).toContain("npm_config_ignore_scripts=true");
  });
});

describe("hostTimeZone", () => {
  it("gives an IANA name, not a Windows one", () => {
    expect(hostTimeZone()).toMatch(/^(UTC|[A-Za-z_]+\/[A-Za-z_\/+-]+)$/);
  });
});
