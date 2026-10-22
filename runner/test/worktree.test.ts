import { describe, expect, it } from "vitest";
import { branchName } from "../src/index.js";

describe("branchName", () => {
  it("is codehands/<slug>-<first 8 of sessionId>", () => {
    expect(branchName("Fix the date bug!", "3f2a9c1e-aaaa-bbbb")).toBe("codehands/fix-the-date-bug-3f2a9c1e");
  });

  it("falls back to 'task' for an empty prompt", () => {
    expect(branchName("???", "3f2a9c1e")).toBe("codehands/task-3f2a9c1e");
  });
});
