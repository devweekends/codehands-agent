import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

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
export function worktreePath(repoKey: string, sessionId: string, root = join(homedir(), ".codehands", "worktrees")): string {
  return join(root, repoKey, sessionId.slice(0, 8));
}

// Runs git in a folder and returns trimmed stdout. Throws with git's own message on failure.
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd, stdin: "ignore" });
  return stdout.trim();
}

// A repo with no commits can't make worktrees, so say that plainly.
export async function baseCommit(repoPath: string): Promise<string> {
  try {
    return await git(repoPath, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(`${repoPath} is not a git repo or has no commits yet`);
  }
}

// Always a new branch: one branch can only be checked out in one worktree.
export async function addWorktree(repoPath: string, branch: string, path: string, base: string): Promise<void> {
  await git(repoPath, ["worktree", "add", "-b", branch, path, base]);
}

// Approve keeps the branch, reject passes it to be deleted too.
// If the folder was already deleted by hand, prune clears git's stale entry instead.
export async function removeWorktree(repoPath: string, path: string, deleteBranch?: string): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", path]).catch(() => pruneWorktrees(repoPath));
  if (deleteBranch) await git(repoPath, ["branch", "-D", deleteBranch]);
}

// Clears entries for worktree folders that were deleted by hand.
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(repoPath, ["worktree", "prune"]);
}
