import type { ProviderError } from "./types.ts";
import { redactSecrets } from "./redact.ts";

/** Thrown inside a provider attempt; classified here so both vendors share one retry policy. */
export class ProviderFailure extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly retryAfterMs: number | null;

  constructor(code: string, status: number | null, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "ProviderFailure";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Error text / codes after which retrying cannot help and only spends more of the budget. */
const NON_RETRYABLE_MESSAGE = /credit balance is too low|enforced_spend_limit_reached|insufficient_quota|reached your (?:specified )?(?:workspace )?api usage limits/i;

export function isRetryable(failure: ProviderFailure): boolean {
  if (NON_RETRYABLE_MESSAGE.test(failure.message) || NON_RETRYABLE_MESSAGE.test(failure.code)) return false;
  if (failure.code === "TIMEOUT" || failure.code === "NETWORK") return true;
  const status = failure.status;
  if (status === null) return false;
  // 408 timeout, 409 conflict, 429 rate limit, 5xx (529 = Anthropic "overloaded").
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

export type RetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
};

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 20_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type RetryOutcome<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; failure: ProviderFailure; attempts: number };

export function delayFor(failure: ProviderFailure, attemptIndex: number, options: RetryOptions): number {
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attemptIndex);
  // A server-provided retry-after wins, but never beyond maxDelayMs (an hour-long wait is a failure, not a retry).
  return failure.retryAfterMs !== null ? Math.min(options.maxDelayMs, failure.retryAfterMs) : exponential;
}

/** Runs `attempt` until it succeeds, fails non-retryably, or maxAttempts is used up. Never throws a ProviderFailure. */
export async function withRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY,
): Promise<RetryOutcome<T>> {
  let last: ProviderFailure | null = null;
  for (let index = 0; index < options.maxAttempts; index += 1) {
    try {
      return { ok: true, value: await attempt(index + 1), attempts: index + 1 };
    } catch (error) {
      if (!(error instanceof ProviderFailure)) throw error;
      last = error;
      if (!isRetryable(error) || index === options.maxAttempts - 1) {
        return { ok: false, failure: error, attempts: index + 1 };
      }
      await options.sleep(delayFor(error, index, options));
    }
  }
  return { ok: false, failure: last ?? new ProviderFailure("UNKNOWN", null, "no attempt ran"), attempts: options.maxAttempts };
}

export function toProviderError(failure: ProviderFailure, knownSecrets: readonly string[] = []): ProviderError {
  return {
    code: failure.code,
    status: failure.status,
    retryable: isRetryable(failure),
    message: redactSecrets(failure.message, knownSecrets).slice(0, 500),
  };
}
