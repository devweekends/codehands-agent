import { describe, expect, it } from "vitest";
import type { RepoProfile, SandboxResult } from "../src/index.js";
import { analyzePrompt, implementPrompt, parseVerdict, planPrompt, reviewPrompt } from "../src/index.js";
import { MAX_FILES, MAX_PATCH } from "../src/engine/prompts.js";

const profile: RepoProfile = { language: "node", packageManager: "npm", testCommand: "npm test", nodeVersion: "22", needsInstall: false };
const tests = (extra: Partial<SandboxResult> = {}): SandboxResult => ({
    command: "npm test", image: "node:22-slim", passed: true, exitCode: 0, timedOut: false, oomKilled: false,
    durationMs: 900, output: "# pass 1", outputTruncated: false, ...extra,
});

describe("prompts", () => {
    it("analyze sees the task, the repo, its files and its notes", () => {
        const { prompt } = analyzePrompt("Fix the date bug", profile, ["src/date.js", "test/date.test.js"], "- Last time: use UTC");
        expect(prompt).toContain("Fix the date bug");
        expect(prompt).toContain("tests: npm test");
        expect(prompt).toContain("src/date.js");
        expect(prompt).toContain("use UTC");
    });

    it("analyze lists at most 200 files and says how many it left out", () => {
        const files = Array.from({ length: 250 }, (_, i) => `f${i}.js`);
        const { prompt } = analyzePrompt("t", profile, files);
        expect(prompt).toContain(`f${MAX_FILES - 1}.js`);
        expect(prompt).not.toContain(`f${MAX_FILES}.js`);
        expect(prompt).toContain("…and 50 more");
    });

    it("plan builds on the analysis, and implement on the plan", () => {
        expect(planPrompt("t", "ANALYSIS-TEXT").prompt).toContain("ANALYSIS-TEXT");
        expect(implementPrompt("Fix it", "1. PLAN-STEP")).toMatch(/^Fix it[\s\S]*1\. PLAN-STEP/);
    });

    it("review sees the change and the test result, and cuts a huge patch", () => {
        const patch = "+line\n".repeat(5_000);
        const { prompt } = reviewPrompt("t", "plan", patch, tests({ passed: false, exitCode: 1, output: "# fail 1" }));
        expect(prompt).toContain("The tests failed (exit 1)");
        expect(prompt).toContain("# fail 1");
        expect(prompt).toContain(`cut at ${MAX_PATCH} characters`);
        expect(prompt.length).toBeLessThan(20_000);
    });

    it("review says plainly when the tests never ran", () => {
        const { prompt } = reviewPrompt("t", "plan", "+x", tests({ passed: false, exitCode: null, error: "sandbox.unavailable", message: "Docker is not running." }));
        expect(prompt).toContain("The tests did not run: sandbox.unavailable. Docker is not running.");
    });
});

describe("parseVerdict", () => {
    it("reads the verdict line, however the model dresses it up", () => {
        expect(parseVerdict("VERDICT: approve\nLooks fine.")).toBe("approve");
        expect(parseVerdict("**Verdict:** concerns\nNo test for it.")).toBe("concerns");
        expect(parseVerdict("verdict: Approve")).toBe("approve");
    });

    it("says unknown when there is no verdict line", () => {
        expect(parseVerdict("Looks fine to me.")).toBe("unknown");
        expect(parseVerdict("")).toBe("unknown");
    });
});