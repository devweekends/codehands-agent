import { canTransition, type SessionStatus, type StartOptions } from "@codehands/contracts";

// Only what the runner needs to stop, resume, diff, approve or reject.
// The daemon owns the real database and the upload.
export interface SessionRecord {
  options: StartOptions;
  status: SessionStatus;
  worktreePath?: string;
  branch?: string;
  baseCommit?: string;
  pid?: number;
  lastSeq: number;
}

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();

  create(options: StartOptions): SessionRecord {
    if (this.sessions.has(options.sessionId)) throw new Error(`session ${options.sessionId} already exists`);
    const record: SessionRecord = { options, status: "queued", lastSeq: 0 };
    this.sessions.set(options.sessionId, record);
    return record;
  }

  get(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`unknown session ${sessionId}`);
    return record;
  }

  // Refuses any move not in SESSION_TRANSITIONS, e.g. approving a running session.
  transition(sessionId: string, to: SessionStatus): SessionRecord {
    const record = this.get(sessionId);
    if (!canTransition(record.status, to)) {
      throw new Error(`illegal move for ${sessionId}: ${record.status} -> ${to}`);
    }
    record.status = to;
    return record;
  }
}
