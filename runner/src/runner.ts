import type { Runner } from "@codehands/contracts";
import { SessionStore } from "./session-store.js";

// The real runner. Diagram 1c in the week 1 guide is the map for start().

export function createRunner(): Runner {
  const store = new SessionStore();
  void store;

  return {
    // TODO(Tue): baseCommit -> addWorktree -> spawn claude with execa (cwd = worktree)
    // -> readline over stdout -> parseClaudeLine -> yield. No result line -> task.failed.
    // Handle both `exit` and `error` on the child.
    start() {
      throw new Error("not implemented: start (Tue)");
    },
    // TODO(Wed): stopProcessTree(pid), transition to stopped, yield task.stopped. Keep the worktree.
    async stop() {
      throw new Error("not implemented: stop (Wed)");
    },
    // TODO(Thu am): claudeResumeArgs in the same worktree, seq continues from lastSeq.
    resume() {
      throw new Error("not implemented: resume (Thu)");
    },
    // TODO(Wed): diffSince(worktree, baseCommit), store it on the session.
    async diff() {
      throw new Error("not implemented: diff (Wed)");
    },
    // TODO(Wed): commitAll on the branch, removeWorktree, keep the branch.
    async approve() {
      throw new Error("not implemented: approve (Wed)");
    },
    // TODO(Wed): removeWorktree and delete the branch.
    async reject() {
      throw new Error("not implemented: reject (Wed)");
    },
  };
}
