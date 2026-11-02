import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFileMemory } from "../src/memory/notes.js";
import { createMemoryStub, formatNote, notesForPrompt, runNote, trimNotes, type MemoryNote } from "../src/memory/store.js";

const note = (text: string, at = new Date().toISOString()): MemoryNote => ({ id: randomUUID(), at, sessionId: randomUUID(), text });
const blocks = (text: string) => text.split(/^(?=## )/m).filter((b) => b.trim());

describe("memory stub", () => {
  it("returns notes in the order they were added", async () => {
    const memory = createMemoryStub();
    await memory.addNote("repo1", note("first run"));
    await memory.addNote("repo1", note("second run"));
    const text = await memory.notes("repo1");
    expect(text.indexOf("first run")).toBeGreaterThan(-1);
    expect(text.indexOf("first run")).toBeLessThan(text.indexOf("second run"));
  });

  it("keeps each repo's memory apart, and an unknown repo has none", async () => {
    const memory = createMemoryStub();
    await memory.addNote("repo1", note("only here"));
    await memory.saveProfile("repo1", { language: "node", nodeVersion: "22", needsInstall: false });
    expect(await memory.notes("repo2")).toBe("");
    expect(await memory.profile("repo2")).toBeUndefined();
    expect(await memory.profile("repo1")).toMatchObject({ language: "node" });
  });
});

describe("trimNotes", () => {
  it("drops whole notes from the top and keeps the newest", () => {
    const text = Array.from({ length: 30 }, (_, i) => formatNote(note(`note ${i}\n${"line\n".repeat(7)}`))).join("");
    const trimmed = trimNotes(text, 200);
    expect(trimmed.split("\n").length).toBeLessThanOrEqual(200);
    expect(trimmed).not.toContain("note 0\n");
    expect(trimmed).toContain("note 29\n");
    expect(blocks(trimmed).every((b) => b.startsWith("## "))).toBe(true);
  });

  it("never empties the file, even when one note is too long", () => {
    const huge = formatNote(note("line\n".repeat(500)));
    expect(trimNotes(huge, 200)).toBe(huge);
  });
});

describe("notesForPrompt", () => {
  it("gives undefined when there is nothing to say, so no flag is passed", () => {
    expect(notesForPrompt("")).toBeUndefined();
    expect(notesForPrompt("  \n\n ")).toBeUndefined();
  });

  it("caps long notes and keeps the newest end", () => {
    const long = "x".repeat(9_000) + "NEWEST";
    const out = notesForPrompt(long)!;
    expect(out.startsWith("Notes from earlier Code Hands runs")).toBe(true);
    expect(out.endsWith("NEWEST")).toBe(true);
    expect(out.length).toBeLessThan(6_200);
  });
});

describe("runNote", () => {
  it("has the task, the diff summary line and the cost", () => {
    const text = runNote("Fix the failing test", { total_cost_usd: 0.123, result: "Fixed it." }, " src/date.js | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
    expect(text).toContain("Task: Fix the failing test");
    expect(text).toContain("Outcome: 1 file changed, 1 insertion(+), 1 deletion(-), cost $0.12");
    expect(text).toContain("Summary: Fixed it.");
  });

  it("cuts the summary to 500 characters", () => {
    const text = runNote("t", { result: "y".repeat(900) });
    expect(text.split("Summary: ")[1]!.length).toBe(500);
  });

  it("keeps a markdown summary on one line, so it can't look like a new note", () => {
    const text = runNote("t", { result: "## Summary\nFixed the bug.\n\n## Files\nsrc/date.js" });
    expect(blocks(formatNote(note(text)))).toHaveLength(1);
  });

  it("says so when the cost or the change is missing", () => {
    expect(runNote("t", {})).toContain("no changes, cost unknown");
  });
});

describe("file memory", () => {
  const tmp = mkdtempSync(join(tmpdir(), "codehands-memory-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("writes notes to disk, so a new store on the same folder reads them back", async () => {
    const root = join(tmp, "a");
    await createFileMemory(root).addNote("repo1", note("remember me"));
    expect(await createFileMemory(root).notes("repo1")).toContain("remember me");
  });

  it("gives nothing, without throwing, when the files don't exist", async () => {
    const memory = createFileMemory(join(tmp, "empty"));
    expect(await memory.notes("repo1")).toBe("");
    expect(await memory.profile("repo1")).toBeUndefined();
  });

  it("round-trips the profile", async () => {
    const memory = createFileMemory(join(tmp, "b"));
    const profile = { language: "node", packageManager: "npm", testCommand: "npm test", nodeVersion: "22", needsInstall: false } as const;
    await memory.saveProfile("repo1", profile);
    expect(await createFileMemory(join(tmp, "b")).profile("repo1")).toEqual(profile);
  });
});
