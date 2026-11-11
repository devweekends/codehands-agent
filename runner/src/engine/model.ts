import { tmpdir } from "node:os";
import type { StepName } from "@codehands/contracts";
import { execa } from "execa";

// What the engine needs from a model: text in, text out, and what it cost.
// Tania's model code plugs in here later. Tests use createCannedModel().
export interface ModelRequest {
    step: StepName;
    model: string;
    system: string;
    prompt: string;
}

export interface ModelReply {
    text: string;
    costUsd: number;
}

export interface ModelClient {
    complete(req: ModelRequest): Promise<ModelReply>;
}

export interface ClaudeModelOptions {
    budgetUsd?: number;  // per call, default 0.2
    // Which program to run. Tests swap in a script that prints a canned reply.
    command?: (args: string[]) => { file: string; args: string[] };
}

// One plain answer from Claude Code: no tools, our own system prompt, nothing saved.
// --tools "" means the model can only think and write, never touch files.
export function claudeModelArgs(req: ModelRequest, budgetUsd: number): string[] {
    return [
        "-p", req.prompt,
        "--output-format", "json",
        "--tools", "",
        "--system-prompt", req.system,
        "--model", req.model,
        "--strict-mcp-config",
        "--no-session-persistence",
        "--max-budget-usd", String(budgetUsd),
    ];
}

// Runs in the temp folder, so no CLAUDE.md from a repo is read into the answer.
export function createClaudeModel({ budgetUsd = 0.2, command = (args) => ({ file: "claude", args }) }: ClaudeModelOptions = {}): ModelClient {
    return {
        async complete(req) {
            const { file, args } = command(claudeModelArgs(req, budgetUsd));
            // execa can still throw, before it even starts: when the program isn't found, Windows
            // falls back to cmd.exe, which refuses a prompt with newlines in it.
            let r;
            try {
                r = await execa(file, args, { cwd: tmpdir(), reject: false, stdin: "ignore", timeout: 5 * 60_000, windowsHide: true });
            } catch (err) {
                throw new Error(`claude could not start: ${(err as Error).message.split("\n")[0]}`);
            }
            return parseClaudeJson(String(r.stdout ?? ""), String(r.stderr ?? ""), r.exitCode);
        },
    };
}

// --output-format json prints one object, the same shape as the `result` line in stream-json.
export function parseClaudeJson(stdout: string, stderr: string, exitCode?: number): ModelReply {
    let o: { result?: unknown; is_error?: boolean; subtype?: string; total_cost_usd?: number };
    try {
        o = JSON.parse(stdout);
    } catch {
        throw new Error(`claude gave no answer (exit ${exitCode ?? "?"}): ${stderr.trim().slice(-300) || stdout.trim().slice(-300)}`);
    }
    if (o.is_error || typeof o.result !== "string") {
        throw new Error(`claude failed: ${typeof o.result === "string" ? o.result : o.subtype ?? "no result"}`);
    }
    return { text: o.result, costUsd: Number(o.total_cost_usd ?? 0) };
}

// Canned answers per step, for tests and free demos. An Error makes that step fail.
// calls keeps every request, so a test can check what each step was asked.
export function createCannedModel(answers: Partial<Record<StepName, string | Error>>): ModelClient & { calls: ModelRequest[] } {
    const calls: ModelRequest[] = [];
    return {
        calls,
        async complete(req) {
            calls.push(req);
            const answer = answers[req.step];
            if (answer instanceof Error) throw answer;
            return { text: answer ?? `(canned ${req.step})`, costUsd: 0 };
        },
    };
}