import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeModelArgs, createCannedModel, createClaudeModel, parseClaudeJson, type ModelRequest } from "../src/index.js";

const fake = fileURLToPath(new URL("./helpers/fake-claude-json.mjs", import.meta.url));
const spike = fileURLToPath(new URL("./fixtures/spike-1.jsonl", import.meta.url));
const req: ModelRequest = { step: "plan", model: "claude-haiku-5-5", system: "You plan.", prompt: 'Line one\nLine "two" with $HOME and %PATH%' };
const fakeModel = (mode: string) => createClaudeModel({ command: (args) => ({ file: process.execPath, args: [fake, mode, ...args] }) });
const pair = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("claudeModelArgs", () => {
    it("asks for one plain answer: no tools, our system prompt, nothing saved", () => {
        const a = claudeModelArgs(req, 0.2);
        expect(pair(a, "-p")).toBe(req.prompt);
        expect(pair(a, "--output-format")).toBe("json");
        expect(pair(a, "--tools")).toBe("");
        expect(pair(a, "--system-prompt")).toBe("You plan.");
        expect(pair(a, "--model")).toBe("claude-haiku-5-5");
        expect(pair(a, "--max-budget-usd")).toBe("0.2");
        expect(a).toContain("--strict-mcp-config");
        expect(a).toContain("--no-session-persistence");
    });
});

describe("createClaudeModel", () => {
    it("passes the prompt through untouched, newlines and quotes included, and reads the cost", async () => {
        const reply = await fakeModel("ok").complete(req);
        expect(pair(JSON.parse(reply.text), "-p")).toBe(req.prompt);
        expect(reply.costUsd).toBe(0.0012);
    });

    it("throws when Claude reports an error", async () => {
        await expect(fakeModel("error").complete(req)).rejects.toThrow(/claude failed: budget exceeded/);
    });

    it("throws when Claude prints something that isn't JSON", async () => {
        await expect(fakeModel("garbage").complete(req)).rejects.toThrow(/claude gave no answer \(exit 1\)/);
    });

    it("throws when Claude isn't installed", async () => {
        const missing = createClaudeModel({ command: (args) => ({ file: "codehands-no-such-claude", args }) });
        await expect(missing.complete(req)).rejects.toThrow(/^claude (gave no answer|could not start)/);
    });
});

describe("parseClaudeJson", () => {
    it("reads the result line of a real recorded run", () => {
        const last = readFileSync(spike, "utf8").trim().split("\n").at(-1)!;
        const reply = parseClaudeJson(last, "");
        expect(reply.text).toMatch(/npm test/);
        expect(reply.costUsd).toBeGreaterThan(0);
    });
});

describe("createCannedModel", () => {
    it("answers per step, records every call, and fails a step given an Error", async () => {
        const model = createCannedModel({ plan: "1. do it", review: new Error("model down") });
        expect((await model.complete(req)).text).toBe("1. do it");
        expect((await model.complete({ ...req, step: "analyze" })).text).toBe("(canned analyze)");
        await expect(model.complete({ ...req, step: "review" })).rejects.toThrow("model down");
        expect(model.calls.map((c) => c.step)).toEqual(["plan", "analyze", "review"]);
    });
});