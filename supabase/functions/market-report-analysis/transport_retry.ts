// Bounded retry for transient OpenAI transport failures (HTTP 429 / 5xx / network drop).
//
// 2026-09-28 morning: both scheduled attempts (07:55, 08:05 JST) failed on the very first generation
// request with ANALYSIS_OPENAI_GENERATE_FAILED:429, because a single 429 ended the whole run. This layer
// retries only the HTTP request itself; generation / local-check / Fact logic, the claim fencing and the
// scheduled retry are untouched. Content failures (non-OK 4xx, empty / invalid output, local or Fact
// rejection) are never retried here.
//
// Bounds (per run, shared by every request in that run):
//   - at most `maxRetriesPerCall` extra requests for one call,
//   - at most `runRetryBudget` extra requests in total,
//   - at most `runWaitBudgetMs` of total waiting,
//   - a Retry-After longer than `maxRetryAfterMs` is not waited for (the scheduled retry takes over).

export type TransportRetryPolicy = {
  maxRetriesPerCall: number;
  runRetryBudget: number;
  runWaitBudgetMs: number;
  backoffMs: number[];
  maxRetryAfterMs: number;
};

export const DEFAULT_TRANSPORT_RETRY: TransportRetryPolicy = {
  maxRetriesPerCall: 2,
  runRetryBudget: 3,
  runWaitBudgetMs: 30_000,
  backoffMs: [2_000, 6_000],
  maxRetryAfterMs: 20_000,
};

/** Non-sensitive counters only (no prompt, key or response body). */
export type TransportStats = {
  retries: number;
  waitedMs: number;
  reasons: string[];
  exhausted: boolean;
  succeededAfterRetry: boolean;
};

export function newTransportStats(): TransportStats {
  return { retries: 0, waitedMs: 0, reasons: [], exhausted: false, succeededAfterRetry: false };
}

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE_5XX = new Set([500, 502, 503, 504]);

/** Retry-After from `retry-after-ms` or `retry-after` (seconds or HTTP date). null when absent/unusable. */
export function retryAfterMs(headers: Headers, nowMs: number): number | null {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.ceil(Number(ms));
  const value = headers.get("retry-after");
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

/** Whether a non-OK response is a transient upstream condition. A quota-exhausted 429 is not. */
export async function transientReason(response: Response): Promise<string | null> {
  if (RETRYABLE_5XX.has(response.status)) return `http_${response.status}`;
  if (response.status !== 429) return null;
  try {
    const body = await response.clone().json() as { error?: { code?: unknown; type?: unknown } };
    if (body?.error?.code === "insufficient_quota" || body?.error?.type === "insufficient_quota") return null;
  } catch { /* non-JSON 429 body: treat as a rate limit */ }
  return "http_429";
}

/** A fetch-level network failure (not our own timeout abort, which is not retried: it already used the time). */
export function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return false;
  return error instanceof TypeError;
}

/**
 * Runs `doFetch` with bounded retries for transient failures. Returns the final Response (OK, or the last
 * non-OK one for the caller to turn into its existing error code), or rethrows the last network error.
 */
export async function fetchWithTransportRetry(
  doFetch: () => Promise<Response>,
  ctx: { policy?: TransportRetryPolicy; stats: TransportStats; sleep?: Sleep; now?: () => number },
): Promise<Response> {
  const policy = ctx.policy ?? DEFAULT_TRANSPORT_RETRY;
  const sleep = ctx.sleep ?? realSleep;
  const now = ctx.now ?? (() => Date.now());
  const { stats } = ctx;
  for (let attempt = 0; ; attempt += 1) {
    let response: Response | null = null;
    let networkError: unknown = null;
    try {
      response = await doFetch();
    } catch (error) {
      if (!isRetryableNetworkError(error)) throw error;
      networkError = error;
    }
    if (response?.ok) {
      if (attempt > 0) stats.succeededAfterRetry = true;
      return response;
    }
    const reason = response ? await transientReason(response) : "network";
    if (!reason) return response!; // non-retryable: unchanged behaviour
    const hinted = response ? retryAfterMs(response.headers, now()) : null;
    const delay = hinted ?? policy.backoffMs[Math.min(attempt, policy.backoffMs.length - 1)];
    const canRetry = attempt < policy.maxRetriesPerCall &&
      stats.retries < policy.runRetryBudget &&
      delay <= policy.maxRetryAfterMs &&
      stats.waitedMs + delay <= policy.runWaitBudgetMs;
    if (!canRetry) {
      stats.exhausted = true;
      if (response) return response;
      throw networkError;
    }
    stats.retries += 1;
    stats.waitedMs += delay;
    stats.reasons.push(reason);
    await sleep(delay);
  }
}

/** Flat, non-sensitive diagnostics fields for the cycle's diagnostics jsonb. */
export function transportDiagnostics(stats: TransportStats): Record<string, string> {
  return {
    transport_retries: String(stats.retries),
    transport_retry_wait_ms: String(stats.waitedMs),
    transport_retry_reasons: stats.reasons.join(","),
    transport_retry_exhausted: String(stats.exhausted),
    transport_success_after_retry: String(stats.succeededAfterRetry),
  };
}
