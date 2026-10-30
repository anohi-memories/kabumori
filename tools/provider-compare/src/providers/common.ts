import type { ProviderName, ProviderResult, Usage } from "../types.ts";
import { ZERO_USAGE } from "../types.ts";

export const DEFAULT_TIMEOUT_MS = 60_000;

export function emptyResult(provider: ProviderName, model: string, label: string): ProviderResult {
  return {
    provider,
    model,
    label,
    ok: false,
    text: null,
    parsed: null,
    parseError: null,
    usage: { ...ZERO_USAGE },
    costUsd: 0,
    latencyMs: 0,
    stopReason: null,
    attempts: 0,
    sourceUrls: [],
    error: null,
  };
}

/** Parses the model's JSON answer; a failure is data (parseError), never an exception. */
export function parseJsonText(text: string | null, expectJson: boolean): { parsed: unknown | null; parseError: string | null } {
  if (!expectJson) return { parsed: null, parseError: null };
  if (text === null || text.trim().length === 0) return { parsed: null, parseError: "EMPTY_OUTPUT" };
  try {
    return { parsed: JSON.parse(text), parseError: null };
  } catch {
    return { parsed: null, parseError: "INVALID_JSON" };
  }
}

export function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    webSearchRequests: a.webSearchRequests + b.webSearchRequests,
  };
}

export function retryAfterMsFrom(header: string | null | undefined): number | null {
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

/** characters the budget guard uses to size a request before sending it */
export function requestChars(system: string, user: string): number {
  return system.length + user.length;
}
