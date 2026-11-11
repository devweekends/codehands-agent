import type { RepoProfile } from "../memory/profile.js";
import type { SandboxResult } from "../runtime/sandbox.js";

// What each step asks. Pure functions, so a test can read every prompt without a model.
// Caps keep each prompt well under Windows' 32,767-character command line.

export const MAX_FILES = 200;
export const MAX_PATCH = 12_000;
export const MAX_TEST_OUTPUT = 3_000;

export interface Prompt {
    system: string;
    prompt: string;
}

const tail = (text: string, max: number) => (text.length > max ? `…(cut, last ${max} characters)\n${text.slice(-max)}` : text);
const head = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…(cut at ${max} characters)` : text);

export function analyzePrompt(task: string, profile: RepoProfile, files: string[], notes?: string): Prompt {
    const list = files.slice(0, MAX_FILES).join("\n") + (files.length > MAX_FILES ? `\n…and ${files.length - MAX_FILES} more` : "");
    return {
        system: "You analyze a coding task before anyone changes code. Be short and concrete. Don't write code.",
        prompt: [
            `Task: ${task}`,
            `Repo: ${profile.language}, package manager ${profile.packageManager ?? "none"}, tests: ${profile.testCommand ?? "none"}, Node ${profile.nodeVersion}`,
            `Files:\n${list || "(none)"}`,
            notes ? `What earlier runs learned about this repo:\n${notes}` : "",
            "Say in at most 8 lines: what the task really asks, which files probably matter, and what could go wrong.",
        ].filter(Boolean).join("\n\n"),
    };
}

export function planPrompt(task: string, analysis: string): Prompt {
    return {
        system: "You plan a small code change for another agent to carry out. Number the steps. Don't write code.",
        prompt: `Task: ${task}\n\nAnalysis:\n${analysis}\n\nWrite a plan of at most 6 numbered steps. The last step is always running the tests.`,
    };
}

// The implement step's prompt goes to Claude Code, which has tools and does the work.
export function implementPrompt(task: string, plan: string): string {
    return `${task}\n\nFollow this plan:\n${plan}\n\nKeep the change as small as the task allows.`;
}

export function reviewPrompt(task: string, plan: string, patch: string, test: SandboxResult): Prompt {
    const tests = test.error
        ? `The tests did not run: ${test.error}. ${test.message ?? ""}`
        : `The tests ${test.passed ? "passed" : "failed"} (exit ${test.exitCode}${test.timedOut ? ", timed out" : ""}${test.oomKilled ? ", out of memory" : ""}). Output:\n${tail(test.output, MAX_TEST_OUTPUT)}`;
    return {
        system: "You review a code change for a person who will approve or reject it. Be short and honest.",
        prompt: [
            `Task: ${task}`,
            `Plan:\n${plan}`,
            `The change:\n${head(patch, MAX_PATCH) || "(no change)"}`,
            tests,
            'Start with exactly "VERDICT: approve" or "VERDICT: concerns", then at most 6 lines on why.',
        ].join("\n\n"),
    };
}

export type Verdict = "approve" | "concerns" | "unknown";

// "unknown" when the model didn't follow the format, or the review step couldn't run.
export function parseVerdict(text: string): Verdict {
    const m = /^\s*\**\s*verdict\s*:\s*\**\s*(approve|concerns)\b/im.exec(text);
    return m ? (m[1]!.toLowerCase() as Verdict) : "unknown";
}