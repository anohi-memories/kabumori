// Error classification table (documented Anthropic / OpenAI error shapes) and retry decisions.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyHttpError, classifyTransportError, messageFor, retryAfterMsFrom } from "./errors.ts";
import { DEFAULT_RETRY_TIMING, nextRetryDelayMs } from "./retry.ts";
import { anthropicError } from "./test_support.ts";
import type { AiErrorCode } from "./types.ts";

function anthropic(status: number, body: unknown, headers: Record<string, string> = {}) {
  return classifyHttpError("anthropic", status, body, new Headers(headers), 0);
}

function openai(status: number, body: unknown, headers: Record<string, string> = {}) {
  return classifyHttpError("openai", status, body, new Headers(headers), 0);
}

test("Anthropic: documented statuses and types map to neutral codes", () => {
  const rows: Array<[number, unknown, AiErrorCode, boolean]> = [
    [400, anthropicError(400, "invalid_request_error", "messages: bad"), "INVALID_REQUEST", false],
    [401, anthropicError(401, "authentication_error", "invalid x-api-key"), "AUTH", false],
    [403, anthropicError(403, "permission_error", "no access"), "AUTH", false],
    [404, anthropicError(404, "not_found_error", "model: x"), "INVALID_REQUEST", false],
    [413, anthropicError(413, "request_too_large", "too large"), "INVALID_REQUEST", false],
    [429, anthropicError(429, "rate_limit_error", "slow down"), "RATE_LIMITED", true],
    [500, anthropicError(500, "api_error", "oops"), "SERVER_ERROR", true],
    [504, anthropicError(504, "timeout_error", "timed out"), "SERVER_ERROR", true],
    [529, anthropicError(529, "overloaded_error", "overloaded"), "OVERLOADED", true],
    [503, null, "SERVER_ERROR", true],
  ];
  for (const [status, body, code, retryable] of rows) {
    const result = anthropic(status, body);
    assert.equal(result.code, code, `${status}`);
    assert.equal(result.retryable, retryable, `${status}`);
    assert.equal(result.httpStatus, status);
  }
});

test("13. Anthropic: credit exhaustion, billing and spend limits are never retried", () => {
  const credit = anthropic(400, anthropicError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."));
  assert.deepEqual([credit.code, credit.retryable, credit.detail], ["CREDIT_EXHAUSTED", false, "credit_balance_too_low"]);
  const billing = anthropic(402, anthropicError(402, "billing_error", "payment"));
  assert.deepEqual([billing.code, billing.retryable], ["CREDIT_EXHAUSTED", false]);
  const tierCap = anthropic(429, anthropicError(429, "rate_limit_error", "You have reached your API usage limits", { details: { error_code: "enforced_spend_limit_reached" } }));
  assert.deepEqual([tierCap.code, tierCap.retryable, tierCap.detail], ["SPEND_LIMIT", false, "enforced_spend_limit_reached"]);
  for (const message of ["You have reached your specified API usage limits. You will regain access on 2026-11-01", "You have reached your specified workspace API usage limits."]) {
    const own = anthropic(400, anthropicError(400, "invalid_request_error", message));
    assert.deepEqual([own.code, own.retryable], ["SPEND_LIMIT", false]);
  }
});

test("13. OpenAI: insufficient_quota is credit exhaustion, not a rate limit", () => {
  const quota = openai(429, { error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" } });
  assert.deepEqual([quota.code, quota.retryable], ["CREDIT_EXHAUSTED", false]);
  const rows: Array<[number, AiErrorCode, boolean]> = [[429, "RATE_LIMITED", true], [500, "SERVER_ERROR", true], [502, "SERVER_ERROR", true], [503, "OVERLOADED", true], [504, "SERVER_ERROR", true], [401, "AUTH", false], [400, "INVALID_REQUEST", false], [404, "INVALID_REQUEST", false]];
  for (const [status, code, retryable] of rows) {
    const result = openai(status, { error: { type: "x", code: null, message: "m" } });
    assert.deepEqual([result.code, result.retryable], [code, retryable], `${status}`);
  }
});

test("provider free text never survives classification; only sanitised type / code", () => {
  const leaky = anthropic(400, anthropicError(400, "invalid_request_error", "messages.0.content: 個人情報 and sk-ant-api03-LEAKLEAKLEAK"));
  assert.ok(!JSON.stringify(leaky).includes("個人情報"));
  assert.ok(!JSON.stringify(leaky).includes("LEAK"));
  const weird = openai(400, { error: { code: "bad code <script>", type: "t" } });
  assert.equal(weird.detail, "bad_code__script_");
  for (const code of ["AUTH", "CREDIT_EXHAUSTED", "TIMEOUT", "SCHEMA_VIOLATION"] as AiErrorCode[]) assert.ok(messageFor(code).length > 0);
});

test("retry-after: seconds, HTTP date and retry-after-ms are understood", () => {
  assert.equal(retryAfterMsFrom(new Headers({ "retry-after": "7" })), 7_000);
  assert.equal(retryAfterMsFrom(new Headers({ "retry-after-ms": "1500" })), 1_500);
  assert.equal(retryAfterMsFrom(new Headers({ "retry-after": new Date(10_000).toUTCString() }), 4_000), 6_000);
  assert.equal(retryAfterMsFrom(new Headers({ "retry-after": "soon" })), null);
  assert.equal(anthropic(429, anthropicError(429, "rate_limit_error", "x"), { "retry-after": "3" }).retryAfterMs, 3_000);
});

test("transport failures: timeout and lost connection may have been billed", () => {
  assert.deepEqual(classifyTransportError(true), { code: "TIMEOUT", retryable: true, httpStatus: null, retryAfterMs: null, maybeBilled: true, detail: "client_timeout" });
  assert.equal(classifyTransportError(false).code, "NETWORK");
  assert.equal(classifyTransportError(false).maybeBilled, true);
});

test("retry decisions: attempts cap, non-retryable codes, timeout opt-in, retry-after cap, backoff", () => {
  const rate = anthropic(429, anthropicError(429, "rate_limit_error", "x"));
  const policy = { maxAttempts: 3 };
  assert.equal(nextRetryDelayMs(policy, DEFAULT_RETRY_TIMING, 1, rate, () => 1), 1_000);
  assert.equal(nextRetryDelayMs(policy, DEFAULT_RETRY_TIMING, 2, rate, () => 1), 2_000);
  assert.equal(nextRetryDelayMs(policy, DEFAULT_RETRY_TIMING, 2, rate, () => 0), 1_000, "jitter halves at most");
  assert.equal(nextRetryDelayMs(policy, DEFAULT_RETRY_TIMING, 3, rate, () => 1), null, "third attempt was the last");
  assert.equal(nextRetryDelayMs({ maxAttempts: 1 }, DEFAULT_RETRY_TIMING, 1, rate, () => 1), null, "maxAttempts 1 = no retry here");
  assert.equal(nextRetryDelayMs({ maxAttempts: 9 }, DEFAULT_RETRY_TIMING, 3, rate, () => 1), null, "hard cap 3 even if misconfigured");
  assert.equal(nextRetryDelayMs(policy, DEFAULT_RETRY_TIMING, 1, anthropic(401, null), () => 1), null);
  assert.equal(nextRetryDelayMs(policy, DEFAULT_RETRY_TIMING, 1, classifyTransportError(true), () => 1), null, "timeouts are not retried by default");
  assert.equal(nextRetryDelayMs({ maxAttempts: 3, retryOnTimeout: true }, DEFAULT_RETRY_TIMING, 1, classifyTransportError(true), () => 1), 1_000);
  const longWait = anthropic(429, anthropicError(429, "rate_limit_error", "x"), { "retry-after": "60" });
  assert.equal(nextRetryDelayMs(policy, DEFAULT_RETRY_TIMING, 1, longWait, () => 1), null, "a 60 s wait ends the retries");
  const shortWait = anthropic(529, anthropicError(529, "overloaded_error", "x"), { "retry-after": "4" });
  assert.equal(nextRetryDelayMs(policy, DEFAULT_RETRY_TIMING, 1, shortWait, () => 1), 4_000);
});
