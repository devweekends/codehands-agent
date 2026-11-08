import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartOptions } from "@codehands/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "codehands-store-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const newRoot = () => mkdtempSync(join(tmp, "root-"));
const options = (sessionId: string = randomUUID()): StartOptions =>
  ({ sessionId, repoPath: "/repo", prompt: "Fix it", agent: "claude-code" });

describe("SessionStore on disk", () => {
  it("a new store finds what the old one saved", () => {
    const root = newRoot();
    const o = options();
    const old = new SessionStore(root);
    old.create(o);
    old.transition(o.sessionId, "running");

    const store = new SessionStore(root);
    expect(store.get(o.sessionId)).toMatchObject({ options: o, status: "running", lastSeq: 0 });
    expect(store.ids()).toEqual([o.sessionId]);
  });

  it("never saves the pid or stopRequested", () => {
    const root = newRoot();
    const o = options();
    const store = new SessionStore(root);
    const record = store.create(o);
    record.pid = 1234;
    record.stopRequested = true;
    store.save(record);

    const saved = JSON.parse(readFileSync(join(root, `${o.sessionId}.json`), "utf8"));
    expect(saved).not.toHaveProperty("pid");
    expect(saved).not.toHaveProperty("stopRequested");
    expect(record.pid).toBe(1234); // the live record keeps them
  });

  it("leaves no temp file behind", () => {
    const root = newRoot();
    const o = options();
    new SessionStore(root).create(o);
    expect(readdirSync(root)).toEqual([`${o.sessionId}.json`]);
  });

  it("refuses a second session with an id already on disk", () => {
    const root = newRoot();
    const o = options();
    new SessionStore(root).create(o);
    expect(() => new SessionStore(root).create(o)).toThrow(/already exists/);
  });

  it("still checks moves after loading from disk", () => {
    const root = newRoot();
    const o = options();
    new SessionStore(root).create(o);
    expect(() => new SessionStore(root).transition(o.sessionId, "approved")).toThrow(/illegal move/);
  });

  it("treats an id that isn't a plain name as unknown, and won't write it", () => {
    const store = new SessionStore(newRoot());
    expect(() => store.get("../../secrets")).toThrow(/unknown session/);
    expect(() => store.create(options("../../secrets"))).toThrow(/bad session id/);
  });
});

describe("SessionStore in memory", () => {
  it("writes nothing and forgets on restart", () => {
    const o = options();
    const store = new SessionStore();
    store.create(o);
    expect(store.ids()).toEqual([o.sessionId]);
    expect(() => new SessionStore().get(o.sessionId)).toThrow(/unknown session/);
  });
});
