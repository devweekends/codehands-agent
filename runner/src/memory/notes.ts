// Week 1 guide, section 8. Friday.
// ~/.codehands/memory/<repoKey>/notes.md, repoKey = first 12 chars of sha1(origin url or absolute path).
// Never write CLAUDE.md or AGENTS.md into the worktree, they would show up in the diff.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { git } from "../git/worktree.js";

// Also names the repo's worktree folder, so start() needs it before Friday.
export async function repoKey(repoPath: string): Promise<string> {
  const origin = await git(repoPath, ["remote", "get-url", "origin"]).catch(() => resolve(repoPath));
  return createHash("sha1").update(origin).digest("hex").slice(0, 12);
}

// TODO(Fri): read notes.md, empty string if missing.
export async function readNotes(_repoKey: string): Promise<string> {
  throw new Error("not implemented: readNotes (Fri)");
}

// TODO(Fri): append a dated summary, keep the file under about 200 lines, drop oldest first.
export async function appendNotes(_repoKey: string, _entry: string): Promise<void> {
  throw new Error("not implemented: appendNotes (Fri)");
}
