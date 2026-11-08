import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Runner, RunnerEvent, StartOptions } from "@codehands/contracts";
import { execa } from "execa";
import { claudeArgs, claudeResumeArgs, newClaudeParseState, parseClaudeLine } from "./agents/claude-code.js";
import { EventSequence } from "./events.js";
import { commitAll, diffSince } from "./git/diff.js";
import { addWorktree, baseCommit, branchName, git, pruneWorktrees, removeWorktree, worktreePath } from "./git/worktree.js";
import { createFileMemory, repoKey } from "./memory/notes.js";
import { detectRepoProfile } from "./memory/profile.js";
import { notesForPrompt, runNote, type MemoryStore } from "./memory/store.js";
import { stopProcessTree } from "./process/kill-tree.js";
import { SessionStore, type SessionRecord } from "./session-store.js";

// The real runner. Diagram 1c in the week 1 guide is the map for start().

export interface RunnerOptions {
  worktreeRoot?: string;    // default ~/.codehands/worktrees
  sessionRoot?: string;     // default ~/.codehands/sessions. Session records, so they outlive a restart
  memory?: MemoryStore;     // default: files under ~/.codehands/memory. Tests pass createMemoryStub()
  // Which program to run for a task. Tests swap in a script that replays a recording.
  // notes: the repo's memory for the prompt, undefined when there is none.
  agentCommand?: (o: StartOptions, notes?: string) => { file: string; args: string[] };
  resumeCommand?: (o: StartOptions, prompt: string) => { file: string; args: string[] };
}

// What recover() did. failed: sessions a restart interrupted, for the daemon to mark failed too.
// cleanupErrors: sessions it couldn't clean up. They stay on disk and the next recover() tries again.
export interface RecoveryReport {
  failed: string[];
  cleanupErrors: { sessionId: string; reason: string }[];
}

export interface RecoverableRunner extends Runner {
  recover(): Promise<RecoveryReport>;
}

const claudeCommand = (o: StartOptions, notes?: string) => ({ file: "claude", args: claudeArgs(o, notes) });
// start() passes our sessionId as Claude's --session-id, so the same id resumes it.
const claudeResumeCommand = (o: StartOptions, prompt: string) =>
  ({ file: "claude", args: claudeResumeArgs(o.sessionId, prompt, o.budgetUsd) });

export function createRunner({
  worktreeRoot,
  sessionRoot = join(homedir(), ".codehands", "sessions"),
  memory = createFileMemory(),
  agentCommand = claudeCommand,
  resumeCommand = claudeResumeCommand,
}: RunnerOptions = {}): RecoverableRunner {
  const store = new SessionStore(sessionRoot);
  // The running agent of each session, so stop() can wait for it to exit.
  const exits = new Map<string, Promise<unknown>>();

  // Every event goes through emit, so lastSeq is always right for resume().
  function emitters(record: SessionRecord, seq: EventSequence) {
    const emit = (event: RunnerEvent) => {
      record.lastSeq = seq.last;
      store.save(record);
      return event;
    };
    const fail = (reason: string, extra: Record<string, unknown> = {}) => {
      store.transition(record.options.sessionId, "failed");
      return emit(seq.next("task.failed", { reason, ...extra }));
    };
    return { emit, fail };
  }

  async function* start(o: StartOptions): AsyncIterable<RunnerEvent> {
    const record = store.create(o);
    const seq = new EventSequence(o.sessionId);
    const { fail } = emitters(record, seq);

    if (o.agent !== "claude-code") {
      yield fail(`agent ${o.agent} is not supported yet`);
      return;
    }

    // 1. A private copy of the repo on a new branch.
    try {
      record.baseCommit = await baseCommit(o.repoPath);
      record.branch = branchName(o.prompt, o.sessionId);
      record.repoKey = await repoKey(o.repoPath);
      record.worktreePath = worktreePath(record.repoKey, o.sessionId, worktreeRoot);
      store.save(record); // before the worktree exists, so a crash here can't leave one nobody knows about
      await pruneWorktrees(o.repoPath);
      await addWorktree(o.repoPath, record.branch, record.worktreePath, record.baseCommit);
    } catch (err) {
      yield fail(`could not make the worktree: ${(err as Error).message}`);
      return;
    }
    // Memory helps a run but must never fail one.
    const notes = await loadMemory(record.repoKey!, record.worktreePath!).catch(() => undefined);
    store.transition(o.sessionId, "running");
    yield* runAgent(record, seq, agentCommand(o, notes));
  }

  // Steps 2 to 5 of a run. start() and resume() share them, so a resumed run ends the same way.
  async function* runAgent(record: SessionRecord, seq: EventSequence, { file, args }: { file: string; args: string[] }): AsyncIterable<RunnerEvent> {
    const { sessionId } = record.options;
    const { worktreePath, baseCommit } = worktreeOf(sessionId);
    const { emit, fail } = emitters(record, seq);
    record.stopRequested = false;

    // 2. Run the agent inside the copy. reject: false, so a crash or a missing binary is a result, not a throw.
    const child = execa(file, args, {
      cwd: worktreePath,
      stdin: "ignore",
      reject: false,
      buffer: { stdout: false, stderr: true },
      windowsHide: true,
    });
    record.pid = child.pid;
    exits.set(sessionId, child);

    // 3. Every complete stdout line becomes events. readline never hands over half a line.
    //    The final event waits until the process is gone, so it can carry the diff.
    const parseState = newClaudeParseState();
    let finished: RunnerEvent | undefined;
    for await (const line of createInterface({ input: child.stdout!, crlfDelay: Infinity })) {
      for (const event of parseClaudeLine(line, seq, parseState)) {
        if (event.type === "task.finished" || event.type === "task.failed") finished = event;
        else yield emit(event);
      }
    }

    // 4. The process is done. No result line means it crashed or never started.
    const result = await child;
    record.pid = undefined;
    exits.delete(sessionId);

    // stop() killed it. The worktree stays so the session can resume.
    if (record.stopRequested) {
      if (record.status === "running") store.transition(sessionId, "stopped");
      yield emit(seq.next("task.stopped", {}));
      return;
    }
    if (!finished) {
      yield fail("the agent exited without a result", {
        exitCode: result.exitCode,
        error: result.failed ? result.shortMessage : undefined,
        stderr: String(result.stderr ?? "").slice(-2000),
      });
      return;
    }
    if (finished.type === "task.failed") {
      store.transition(sessionId, "failed");
      yield emit(finished);
      return;
    }

    // 5. Store the change and put its summary on task.finished, so the phone shows it right away.
    //    Then ask for approval: the daemon shows Approve / Reject on approval.requested.
    try {
      record.diff = await diffSince(worktreePath, baseCommit);
      finished.payload.diffStat = record.diff.stat;
    } catch (err) {
      finished.payload.diffError = (err as Error).message;
    }

    if (record.repoKey) {
      await memory.addNote(record.repoKey, {
        id: randomUUID(), at: new Date().toISOString(), sessionId,
        text: runNote(record.options.prompt, finished.payload, record.diff?.stat),
      }).catch(() => {}); // memory never fails a run
    }

    store.transition(sessionId, "awaiting_approval");
    yield emit(finished);
    yield emit(seq.next("approval.requested", { diffStat: record.diff?.stat ?? "" }));
  }

  // Everything below needs the worktree that start() made.
  function worktreeOf(sessionId: string) {
    const record = store.get(sessionId);
    if (!record.worktreePath || !record.baseCommit || !record.branch) {
      throw new Error(`session ${sessionId} has no worktree`);
    }
    return { record, worktreePath: record.worktreePath, baseCommit: record.baseCommit, branch: record.branch };
  }

  // Saves what the worktree looks like and returns the notes for the prompt.
  async function loadMemory(key: string, worktree: string): Promise<string | undefined> {
    await memory.saveProfile(key, await detectRepoProfile(worktree));
    return notesForPrompt(await memory.notes(key));
  }

  // A failed session can't be approved or rejected, so nothing else would remove its worktree.
  async function discardWorktree(record: SessionRecord): Promise<void> {
    const { repoPath } = record.options;
    await removeWorktree(repoPath, record.worktreePath!);
    if (existsSync(record.worktreePath!)) throw new Error(`could not remove ${record.worktreePath}`);
    // The branch goes only if it never moved: commits the agent made are kept.
    const tip = await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${record.branch}`]).catch(() => "");
    if (tip && tip === record.baseCommit) await git(repoPath, ["branch", "-D", record.branch!]);
    record.worktreePath = undefined;
    store.save(record);
  }

  return {
    start,
    // Call once when the daemon starts, before it starts or commands anything.
    // A session still marked queued or running lost its agent, so it becomes failed.
    // awaiting_approval and stopped sessions are left alone: approve, reject and resume still work.
    async recover() {
      const report: RecoveryReport = { failed: [], cleanupErrors: [] };
      for (const sessionId of store.ids()) {
        if (exits.has(sessionId)) continue; // its agent is alive in this process
        try {
          const record = store.get(sessionId);
          if (record.status === "queued" || record.status === "running") {
            store.transition(sessionId, "failed");
            report.failed.push(sessionId);
          }
          if (record.status === "failed" && record.worktreePath) await discardWorktree(record);
        } catch (err) {
          report.cleanupErrors.push({ sessionId, reason: (err as Error).message });
        }
      }
      return report;
    },
    // Kills the agent and everything it started. task.stopped comes out of the start() stream,
    // and the session is stopped by the time this resolves. The worktree stays.
    async stop(sessionId) {
      const record = store.check(sessionId, "stopped");
      const exited = exits.get(sessionId);
      if (!record.pid || !exited) throw new Error(`session ${sessionId} has no agent process to stop`);
      record.stopRequested = true;
      await stopProcessTree(record.pid, exited);
      if (record.status === "running") store.transition(sessionId, "stopped");
    },
    // Continues a stopped session in the same worktree. seq carries on from the last event,
    // and the run ends the way start()'s does. If Claude never saved the session, it ends in task.failed.
    async *resume(sessionId, prompt = "Continue.") {
      const record = store.transition(sessionId, "running");
      yield* runAgent(record, new EventSequence(sessionId, record.lastSeq), resumeCommand(record.options, prompt));
    },
    // The change since the base commit, new files included. Fresh each call while the worktree exists.
    async diff(sessionId) {
      const { record, worktreePath, baseCommit } = worktreeOf(sessionId);
      if (record.status === "approved" || record.status === "rejected") {
        if (!record.diff) throw new Error(`session ${sessionId} has no stored diff`);
        return record.diff;
      }
      record.diff = await diffSince(worktreePath, baseCommit);
      return record.diff;
    },

    // Commit on the task's branch, then remove the worktree. The branch stays for the person to merge.
    async approve(sessionId, message) {
      const { record, worktreePath, baseCommit, branch } = worktreeOf(sessionId);
      store.check(sessionId, "approved");
      record.diff = await diffSince(worktreePath, baseCommit);
      const commit = await commitAll(worktreePath, message.trim() || `codehands: ${record.options.prompt}`);
      await removeWorktree(record.options.repoPath, worktreePath);
      store.transition(sessionId, "approved");
      return { branch, commit };
    },

    // Throw the change away: worktree and branch both go.
    async reject(sessionId) {
      const { record, worktreePath, branch } = worktreeOf(sessionId);
      store.check(sessionId, "rejected");
      await removeWorktree(record.options.repoPath, worktreePath, branch);
      store.transition(sessionId, "rejected");
    },
  };
}
