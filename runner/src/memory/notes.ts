// Week 1 guide, section 8. Friday.
// ~/.codehands/memory/<repoKey>/notes.md, repoKey = first 12 chars of sha1(origin url or absolute path).
// Never write CLAUDE.md or AGENTS.md into the worktree, they would show up in the diff.

// TODO(Fri): sha1 of `git remote get-url origin`, falling back to the absolute path.
export async function repoKey(_repoPath: string): Promise<string> {
  throw new Error("not implemented: repoKey (Fri)");
}

// TODO(Fri): read notes.md, empty string if missing.
export async function readNotes(_repoKey: string): Promise<string> {
  throw new Error("not implemented: readNotes (Fri)");
}

// TODO(Fri): append a dated summary, keep the file under about 200 lines, drop oldest first.
export async function appendNotes(_repoKey: string, _entry: string): Promise<void> {
  throw new Error("not implemented: appendNotes (Fri)");
}
