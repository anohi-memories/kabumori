// Transport retry decisions. This layer retries the SAME request after a transient transport failure only;
// regenerating because the content was rejected is the caller's job and never happens here. A refusal is never
// retried (no attempt to get around a safety decision), and there is no switch to another provider.

import type { ClassifiedError } from "./errors.ts";
import type { AiTransportPolicy } from "./types.ts";

export const MAX_TRANSPORT_ATTEMPTS = 3;

export type RetryTiming = {
  /** First backoff; doubles per retry, with jitter between 50% and 100%. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A provider-requested wait longer than this ends the retries instead of sleeping through it. */
  readonly maxRetryAfterMs: number;
  /** Do not start an attempt with less time than this before the deadline. */
  readonly minAttemptMs: number;
};

export const DEFAULT_RETRY_TIMING: RetryTiming = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 20_000,
  minAttemptMs: 5_000,
});

/** True when the policy is well formed (1..3 attempts). */
export function isValidTransportPolicy(policy: AiTransportPolicy | undefined): boolean {
  return !!policy && Number.isInteger(policy.maxAttempts) && policy.maxAttempts >= 1 && policy.maxAttempts <= MAX_TRANSPORT_ATTEMPTS &&
    (policy.retryOnTimeout === undefined || typeof policy.retryOnTimeout === "boolean");
}

/**
 * The wait before the next attempt, or null when no further attempt may be made.
 * `attempt` is the 1-based number of the attempt that just failed.
 */
export function nextRetryDelayMs(
  policy: AiTransportPolicy,
  timing: RetryTiming,
  attempt: number,
  error: ClassifiedError,
  random: () => number,
): number | null {
  if (attempt >= Math.min(policy.maxAttempts, MAX_TRANSPORT_ATTEMPTS)) return null;
  if (!error.retryable) return null;
  if (error.code === "TIMEOUT" && policy.retryOnTimeout !== true) return null;
  if (error.retryAfterMs !== null) {
    if (error.retryAfterMs > timing.maxRetryAfterMs) return null;
    return error.retryAfterMs;
  }
  const exponential = Math.min(timing.maxDelayMs, timing.baseDelayMs * 2 ** (attempt - 1));
  const jitter = 0.5 + 0.5 * Math.min(1, Math.max(0, random()));
  return Math.round(exponential * jitter);
}
