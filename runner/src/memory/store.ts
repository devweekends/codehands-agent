import type { RepoProfile } from "./profile.js";

// What the runner remembers about a repo between runs, outside the worktree.
// The runner and the engine only see this interface: tests give it a Map, real runs give it files.
export interface MemoryNote { id: string; at: string; sessionId: string; text: string }  // id + at: ready to sync later

export interface MemoryStore {
  notes(repoKey: string): Promise<string>;           // "" when there are none
  addNote(repoKey: string, note: MemoryNote): Promise<void>;
  profile(repoKey: string): Promise<RepoProfile | undefined>; // undefined until a run has saved one
  saveProfile(repoKey: string, profile: RepoProfile): Promise<void>;
}

// One note as text. The stub and the file store both use it, so they read the same.
export function formatNote(n: MemoryNote): string {
  return `## ${n.at} · ${n.sessionId.slice(0, 8)}\n${n.text.trim()}\n\n`;
}

export function createMemoryStub(): MemoryStore {
  const notes = new Map<string, MemoryNote[]>();
  const profiles = new Map<string, RepoProfile>();
  return {
    async notes(key) { return (notes.get(key) ?? []).map(formatNote).join(""); },
    async addNote(key, note) { notes.set(key, [...(notes.get(key) ?? []), note]); },
    async profile(key) { return profiles.get(key); },
    async saveProfile(key, profile) { profiles.set(key, profile); },
  };
}

// Built from the run's own result. No model call.
export function runNote(prompt: string, payload: Record<string, unknown>, diffStat = ""): string {
  const cost = typeof payload.total_cost_usd === "number" ? `$${payload.total_cost_usd.toFixed(2)}` : "unknown";
  const changed = diffStat.trim().split("\n").at(-1)?.trim() || "no changes";
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const summary = oneLine(String(payload.result ?? "")).slice(0, 500);
  return `Task: ${oneLine(prompt)}\nOutcome: ${changed}, cost ${cost}\nSummary: ${summary}`;
}

// Drops whole notes from the top until it fits. Always keeps the newest one.
export function trimNotes(text: string, maxLines = 200): string {
  const blocks = text.split(/^(?=## )/m).filter((b) => b.trim());
  while (blocks.length > 1 && blocks.join("").split("\n").length > maxLines) blocks.shift();
  return blocks.join("");
}

// Notes go to Claude as one CLI argument: Windows caps a command line near 32,000 characters, and every character costs tokens.
const MAX_PROMPT_NOTES = 6000;

// Newest notes win when it's too long. undefined, so no flag is passed at all, when there are none.
export function notesForPrompt(notes: string): string | undefined {
  if (!notes.trim()) return undefined;
  return "Notes from earlier Code Hands runs on this repo. They may be out of date:\n\n" + notes.slice(-MAX_PROMPT_NOTES);
}
