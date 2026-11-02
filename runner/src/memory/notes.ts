import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "../git/worktree.js";
import type { RepoProfile } from "./profile.js";
import { formatNote, trimNotes, type MemoryStore } from "./store.js";

// One id per repo: names its worktree folder and its memory folder.
export async function repoKey(repoPath: string): Promise<string> {
  const origin = await git(repoPath, ["remote", "get-url", "origin"]).catch(() => resolve(repoPath));
  return createHash("sha1").update(origin).digest("hex").slice(0, 12);
}

// Memory on disk: ~/.codehands/memory/<repoKey>/notes.md and profile.json.
// Outside the worktree on purpose: CLAUDE.md or AGENTS.md there would show up in the diff.
export function createFileMemory(root = join(homedir(), ".codehands", "memory")): MemoryStore {
  const file = (key: string, name: string) => join(root, key, name);

  return {
    async notes(key) {
      return (await readIfExists(file(key, "notes.md"))) ?? "";
    },
    async addNote(key, note) {
      const old = (await readIfExists(file(key, "notes.md"))) ?? "";
      await mkdir(join(root, key), { recursive: true });
      await writeFile(file(key, "notes.md"), trimNotes(old + formatNote(note)));
    },
    async profile(key) {
      const text = await readIfExists(file(key, "profile.json"));
      return text ? (JSON.parse(text) as RepoProfile) : undefined;
    },
    async saveProfile(key, profile) {
      await mkdir(join(root, key), { recursive: true });
      await writeFile(file(key, "profile.json"), JSON.stringify(profile, null, 2));
    },
  };
}

// undefined when the file isn't there. Any other error is real, so it throws.
async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
