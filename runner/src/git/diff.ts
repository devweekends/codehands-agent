// Week 1 guide, Wednesday. Untracked files are invisible to plain `git diff`,
// so stage everything first.

// TODO(Wed): `git add -A`, then `git diff --cached --binary <base>` and `--stat`.
export async function diffSince(_worktree: string, _base: string): Promise<{ patch: string; stat: string }> {
  throw new Error("not implemented: diffSince (Wed)");
}

// TODO(Wed): `git commit -m <message>` in the worktree, return the new commit hash.
export async function commitAll(_worktree: string, _message: string): Promise<string> {
  throw new Error("not implemented: commitAll (Wed)");
}
