// Week 1 guide, Wednesday. Untracked files are invisible to plain `git diff`,
// so stage everything first.

import { execa } from "execa";
import { git } from "./worktree.js";

export async function diffSince(worktree: string, base: string): Promise<{ patch: string; stat: string }> {
  await git(worktree, ["add", "-A"]);
  // Not trimmed: a patch needs its final newline to apply.
  const { stdout: patch } = await execa("git", ["diff", "--cached", "--binary", base], { cwd: worktree, stdin: "ignore", stripFinalNewline: false });
  const stat = await git(worktree, ["diff", "--cached", "--stat", base]);
  return { patch, stat };
}

// Commits everything the agent changed on the worktree's branch and returns the new commit hash.
export async function commitAll(worktree: string, message: string): Promise<string> {
  await git(worktree, ["add", "-A"]);
  const staged = await git(worktree, ["diff", "--cached", "--name-only"]);
  if (!staged) throw new Error("nothing to approve: the agent made no changes");
  await git(worktree, ["commit", "-q", "-m", message]);
  return git(worktree, ["rev-parse", "HEAD"]);
}
