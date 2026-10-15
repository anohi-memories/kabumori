// Transport retry decisions. This layer retries the SAME request after a transient transport failure only;
// regenerating because the content was rejected is the caller's job and never happens here. A refusal is never
// retried (no attempt to get around a safety decision), and there is no switch to another provider.
//
// At most one attempt for an ambiguous outcome (F6 J1 R2, 2026-10-16): only a failure the provider reported as NOT
// processed is sent again. A timeout (ours or the provider's 504 / timeout_error), a lost connection, any other
// server error and anything that may have been billed ends the call, whatever `maxAttempts` says: the request may
// have been processed, and a second attempt could pay twice. There is no opt-in for that here; one would need its
// own reviewed and approved policy with a per-operation spend contract.

import type { ClassifiedError } from "./errors.ts";
import type { AiErrorCode, AiTransportPolicy } from "./types.ts";

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

/**
 * Rate limits (HTTP 429) and overloads (Anthropic 529, OpenAI 503): the provider refused the request before
 * processing it, so nothing was generated or billed. These are the only failures this layer sends again.
 */
const KNOWN_UNSENT_CODES: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>(["RATE_LIMITED", "OVERLOADED"]);

/** True when the provider said it did not process the request (and nothing about it may have been billed). */
export function isKnownUnsent(error: ClassifiedError): boolean {
  return KNOWN_UNSENT_CODES.has(error.code) && error.retryable === true && error.maybeBilled === false;
}

/** True when the policy is well formed (1..3 attempts). Asking to retry after a timeout is refused, not ignored. */
export function isValidTransportPolicy(policy: AiTransportPolicy | undefined): boolean {
  return !!policy && Number.isInteger(policy.maxAttempts) && policy.maxAttempts >= 1 && policy.maxAttempts <= MAX_TRANSPORT_ATTEMPTS &&
    (policy.retryOnTimeout === undefined || policy.retryOnTimeout === false);
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
  if (!isKnownUnsent(error)) return null;
  if (error.retryAfterMs !== null) {
    if (error.retryAfterMs > timing.maxRetryAfterMs) return null;
    return error.retryAfterMs;
  }
  const exponential = Math.min(timing.maxDelayMs, timing.baseDelayMs * 2 ** (attempt - 1));
  const jitter = 0.5 + 0.5 * Math.min(1, Math.max(0, random()));
  return Math.round(exponential * jitter);
}
