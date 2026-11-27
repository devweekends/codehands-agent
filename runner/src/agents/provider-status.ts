import type { ProviderState } from "@codehands/contracts";

// Why the provider couldn't serve a run, read from a failure's text. The payload of a provider.status event.
// Meanings: codehands-docs#provider-failures. The app shows each state differently (sign in, wait, try the other agent).
export interface ProviderStatus {
  state: ProviderState;
  message: string;
  code?: number;    // HTTP status, when the text has one ("API Error: 429 …")
  retryAt?: string; // ISO time the limit resets, when the text says
}

// Checked in this order: the first match wins. Only ever given text from a run that already failed,
// so a summary that merely mentions "429" or "login" never gets here.
const RULES: [ProviderState, RegExp][] = [
  ["auth_expired", /not logged in|invalid api key|please run \/login|oauth token (has )?expired|authentication_error|token (has been )?revoked/i],
  ["subscription_inactive", /subscription (is )?(inactive|expired|cancel)|no active subscription|credit balance is too low|organization (has been )?disabled|does not have access to claude/i],
  ["usage_limit", /usage limit|hit your limit|out of (extra )?usage/i],
  ["rate_limited", /rate[_ ]limit|too many requests/i],
  ["down", /overloaded|internal server error|service unavailable|bad gateway|timed out|timeout|connection error|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i],
];

// What an HTTP status means when the text says nothing more specific.
function stateOfCode(code: number): ProviderState | undefined {
  if (code === 401) return "auth_expired";
  if (code === 402) return "subscription_inactive";
  if (code === 429) return "rate_limited";
  if (code >= 500) return "down";  // 529 is Anthropic's "overloaded"
  return undefined;
}

// Claude prints the reset time as unix seconds after a bar: "Claude AI usage limit reached|1794516000".
function retryAtOf(text: string): string | undefined {
  const m = /\|(\d{10})\b/.exec(text);
  return m ? new Date(Number(m[1]) * 1000).toISOString() : undefined;
}

// undefined when the failure isn't the provider's: a bug, a crash, a budget cap, a bad repo.
export function providerFailure(text: string | undefined): ProviderStatus | undefined {
  if (!text?.trim()) return undefined;
  const m = /API Error:?\s*(\d{3})\b/i.exec(text);
  const code = m ? Number(m[1]) : undefined;
  const state = RULES.find(([, re]) => re.test(text))?.[0] ?? (code ? stateOfCode(code) : undefined);
  if (!state) return undefined;
  const message = text.trim().replace(/\|\d{10}\b/, "").slice(0, 500);
  return { state, message, code, retryAt: retryAtOf(text) };
}

// Claude Code's rate_limit_event. "allowed" and "allowed_warning" are normal; "rejected" means it's blocked.
// The plan's windows (five_hour, seven_day …) are usage limits that reset; anything else is a rate limit.
export function rateLimitRejected(info: Record<string, any> | undefined): ProviderStatus | undefined {
  if (info?.status !== "rejected") return undefined;
  const window = typeof info.rateLimitType === "string" ? info.rateLimitType : undefined;
  const state: ProviderState = window && /hour|day|week/.test(window) ? "usage_limit" : "rate_limited";
  const retryAt = typeof info.resetsAt === "number" ? new Date(info.resetsAt * 1000).toISOString() : undefined;
  return { state, message: `Claude ${window ? window.replace(/_/g, " ") + " " : ""}limit reached`, retryAt };
}
