import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StartOptions, StepName } from "@codehands/contracts";
import type { SandboxResult } from "../runtime/sandbox.js";
import type { Verdict } from "./prompts.js";

// Everything the engine needs to carry on after a restart: what each finished step gave,
// and where the run stands. One file per run, next to its step files:
// <runsRoot>/<sessionId>/run.json. Saved before every event goes out.
export interface RunState {
    options: StartOptions;
    status: "running" | "stopped" | "awaiting_approval" | "failed";
    step?: StepName;                              // the step running now
    analysis?: string;                            // set when analyze finished
    plan?: string;                                // set when plan finished
    implemented?: boolean;                        // Claude Code finished: the change is in the worktree
    tests?: SandboxResult;                        // the test step's result, output cut short
    review?: { verdict: Verdict; text: string };  // set when review finished, or failed
    lastSeq: number;                              // the last event sent, so seq carries on
    files: number;                                // step files written so far
    costUsd: number;
}

// Session ids name folders, so one like ../../x must never reach the disk.
const SAFE_ID = /^[\w-]+$/;

export class RunStore {
    constructor(private readonly root: string) { }

    // Writes to a temp file first, so a crash mid-write can't leave half a state.
    save(state: RunState): void {
        const dir = join(this.root, state.options.sessionId);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "run.json");
        writeFileSync(`${file}.tmp`, JSON.stringify(state));
        renameSync(`${file}.tmp`, file);
    }

    // undefined when the session isn't the engine's: a Claude Code run, or an unknown id.
    load(sessionId: string): RunState | undefined {
        if (!SAFE_ID.test(sessionId)) return undefined;
        let text: string;
        try {
            text = readFileSync(join(this.root, sessionId, "run.json"), "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw err;
        }
        return JSON.parse(text) as RunState;
    }

    // Every run with a state file, including ones from before a restart.
    ids(): string[] {
        if (!existsSync(this.root)) return [];
        return readdirSync(this.root, { withFileTypes: true })
            .filter((d) => d.isDirectory() && existsSync(join(this.root, d.name, "run.json")))
            .map((d) => d.name);
    }
}