import { describe, expect, it } from "vitest";
import { providerFailure, rateLimitRejected } from "../src/agents/provider-status.js";

// Claude Code's own failure texts, one per provider state. Nothing here calls a provider.
describe("providerFailure", () => {
  it.each([
    ["Not logged in · Please run /login", "auth_expired", undefined],
    ["Invalid API key · Please run /login", "auth_expired", undefined],
    ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}', "auth_expired", 401],
    ["Credit balance is too low", "subscription_inactive", undefined],
    ["Your subscription is inactive", "subscription_inactive", undefined],
    ["Claude AI usage limit reached|1794516000", "usage_limit", undefined],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}', "rate_limited", 429],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "down", 529],
    ["API Error: 500 Internal server error", "down", 500],
    ["API Error: 503", "down", 503],
    ["API Error: Request timed out.", "down", undefined],
    ["API Error: Connection error.", "down", undefined],
  ])("%s -> %s", (text, state, code) => {
    expect(providerFailure(text)).toMatchObject({ state, code });
  });

  it("reads the reset time of a usage limit, and leaves the bar out of the message", () => {
    expect(providerFailure("Claude AI usage limit reached|1794516000")).toEqual({
      state: "usage_limit", message: "Claude AI usage limit reached", code: undefined, retryAt: "2026-11-12T20:40:00.000Z",
    });
  });

  it("says nothing about failures that aren't the provider's", () => {
    for (const text of ["error_max_budget_usd", "error_max_turns", "the agent exited without a result", "spawn claude ENOENT", "API Error: 400 bad request", "", undefined]) {
      expect(providerFailure(text)).toBeUndefined();
    }
  });
});

describe("rateLimitRejected", () => {
  it("is quiet while the limit allows the run", () => {
    expect(rateLimitRejected({ status: "allowed", rateLimitType: "five_hour", resetsAt: 1794516000 })).toBeUndefined();
    expect(rateLimitRejected({ status: "allowed_warning", rateLimitType: "seven_day", resetsAt: 1794516000 })).toBeUndefined();
    expect(rateLimitRejected(undefined)).toBeUndefined();
  });

  it("a plan window that's used up is a usage limit, with when it resets", () => {
    expect(rateLimitRejected({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1794516000 })).toEqual({
      state: "usage_limit", message: "Claude five hour limit reached", retryAt: "2026-11-12T20:40:00.000Z",
    });
  });

  it("anything else rejected is a rate limit", () => {
    expect(rateLimitRejected({ status: "rejected" })).toMatchObject({ state: "rate_limited", retryAt: undefined });
  });
});
