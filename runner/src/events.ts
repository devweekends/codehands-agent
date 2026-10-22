import type { RunnerEvent, RunnerEventType } from "@codehands/contracts";

// Hands out RunnerEvents with seq 1, 2, 3 … per session.
export class EventSequence {
  private seq = 0;

  constructor(readonly sessionId: string, startAfter = 0) {
    this.seq = startAfter;
  }

  next(type: RunnerEventType, payload: Record<string, unknown> = {}, raw?: unknown): RunnerEvent {
    this.seq += 1;
    const event: RunnerEvent = { sessionId: this.sessionId, seq: this.seq, type, at: new Date().toISOString(), payload };
    if (raw !== undefined) event.raw = raw;
    return event;
  }

  get last(): number {
    return this.seq;
  }
}
