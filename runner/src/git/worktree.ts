import { homedir } from "node:os";
import { join } from "node:path";

// Week 1 guide, sections 6 and 7 (git worktree traps).

export function slugify(text: string, maxWords = 4): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join("-") || "task";
}

// codehands/fix-date-bug-3f2a9c1e: readable and never collides.
export function branchName(prompt: string, sessionId: string): string {
  return `codehands/${slugify(prompt)}-${sessionId.slice(0, 8)}`;
}

// Outside the repo, so worktrees never nest. Keep it short for Windows path limits.
export function worktreePath(repoKey: string, sessionId: string): string {
  return join(homedir(), ".codehands", "worktrees", repoKey, sessionId.slice(0, 8));
}

// TODO(Tue): `git rev-parse HEAD` in repoPath. Throw a clear error when the repo has no commits.
export async function baseCommit(_repoPath: string): Promise<string> {
  throw new Error("not implemented: baseCommit (Tue)");
}

// TODO(Tue): `git worktree add -b <branch> <path> <base>`. Always a new branch.
export async function addWorktree(_repoPath: string, _branch: string, _path: string, _base: string): Promise<void> {
  throw new Error("not implemented: addWorktree (Tue)");
}

// TODO(Wed): `git worktree remove --force <path>`, then `git branch -D <branch>` when rejecting.
export async function removeWorktree(_repoPath: string, _path: string, _deleteBranch?: string): Promise<void> {
  throw new Error("not implemented: removeWorktree (Wed)");
}

// TODO(Tue): `git worktree prune`, run once when the runner starts.
export async function pruneWorktrees(_repoPath: string): Promise<void> {
  throw new Error("not implemented: pruneWorktrees (Tue)");
}
