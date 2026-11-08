import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canTransition, type SessionStatus, type StartOptions } from "@codehands/contracts";

// Only what the runner needs to stop, resume, diff, approve or reject.
// The daemon owns the real database and the upload.
export interface SessionRecord {
  options: StartOptions;
  status: SessionStatus;
  worktreePath?: string;
  repoKey?: string;         // set by start(). Where this repo's memory lives
  branch?: string;
  baseCommit?: string;
  pid?: number;             // never saved: after a restart the number may belong to another program
  stopRequested?: boolean;  // set by stop(), so the agent's exit reads as task.stopped, not task.failed. Never saved
  lastSeq: number;
  diff?: { patch: string; stat: string };
}

// Session ids name files, so one like ../../x must never reach the disk.
const SAFE_ID = /^[\w-]+$/;

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private root?: string;

  // With a root, every record is also a file (<root>/<sessionId>.json), so it outlives a restart.
  // Without one it stays in memory, which is all the fake runner needs.
  constructor(root?: string) {
    this.root = root;
    if (root) mkdirSync(root, { recursive: true });
  }

  create(options: StartOptions): SessionRecord {
    if (this.root && !SAFE_ID.test(options.sessionId)) throw new Error(`bad session id ${options.sessionId}`);
    if (this.find(options.sessionId)) throw new Error(`session ${options.sessionId} already exists`);
    const record: SessionRecord = { options, status: "queued", lastSeq: 0 };
    this.sessions.set(options.sessionId, record);
    this.save(record);
    return record;
  }

  get(sessionId: string): SessionRecord {
    const record = this.find(sessionId);
    if (!record) throw new Error(`unknown session ${sessionId}`);
    return record;
  }

  // Every saved session, including ones from before a restart.
  ids(): string[] {
    if (!this.root) return [...this.sessions.keys()];
    return readdirSync(this.root).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
  }

  // Writes to a temp file first, so a crash mid-write can't leave half a record.
  save(record: SessionRecord): void {
    if (!this.root) return;
    const { pid: _pid, stopRequested: _stopRequested, ...saved } = record;
    const file = this.file(record.options.sessionId);
    writeFileSync(`${file}.tmp`, JSON.stringify(saved));
    renameSync(`${file}.tmp`, file);
  }

  // Refuses any move not in SESSION_TRANSITIONS, e.g. approving a running session.
  transition(sessionId: string, to: SessionStatus): SessionRecord {
    const record = this.check(sessionId, to);
    record.status = to;
    this.save(record);
    return record;
  }

  // The same check without moving, for work that must happen before the move (commit, then approved).
  check(sessionId: string, to: SessionStatus): SessionRecord {
    const record = this.get(sessionId);
    if (!canTransition(record.status, to)) {
      throw new Error(`illegal move for ${sessionId}: ${record.status} -> ${to}`);
    }
    return record;
  }

  // Memory first, then the disk. undefined when it's in neither.
  private find(sessionId: string): SessionRecord | undefined {
    const known = this.sessions.get(sessionId);
    if (known || !this.root || !SAFE_ID.test(sessionId)) return known;
    let text: string;
    try {
      text = readFileSync(this.file(sessionId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const record = JSON.parse(text) as SessionRecord;
    this.sessions.set(sessionId, record);
    return record;
  }

  private file(sessionId: string): string {
    return join(this.root!, `${sessionId}.json`);
  }
}
