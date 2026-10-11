import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RETRY,
  delayFor,
  isRetryable,
  ProviderFailure,
  type RetryOptions,
  toProviderError,
  withRetry,
} from "./retry.ts";

const sleeps: number[] = [];
const options: RetryOptions = {
  maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000,
  sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
};

test("which failures are retried", () => {
  for (const status of [408, 409, 429, 500, 502, 503, 529]) {
    assert.equal(isRetryable(new ProviderFailure(`HTTP_${status}`, status, "x")), true, String(status));
  }
  for (const status of [400, 401, 403, 404, 413, 422]) {
    assert.equal(isRetryable(new ProviderFailure(`HTTP_${status}`, status, "x")), false, String(status));
  }
  assert.equal(isRetryable(new ProviderFailure("TIMEOUT", null, "x")), true);
  assert.equal(isRetryable(new ProviderFailure("NETWORK", null, "x")), true);
  assert.equal(isRetryable(new ProviderFailure("INVALID_RESPONSE", 200, "x")), false);
});

test("a spend-limit 429 and an empty-credit 400/429 are never retried (retrying only spends the budget)", () => {
  const spend = new ProviderFailure(
    "HTTP_429", 429,
    '{"error":{"type":"rate_limit_error","details":{"error_code":"enforced_spend_limit_reached"}}}',
  );
  assert.equal(isRetryable(spend), false);
  const credit = new ProviderFailure("HTTP_400", 400, "Your credit balance is too low to access the Anthropic API.");
  assert.equal(isRetryable(credit), false);
  const credit429 = new ProviderFailure("HTTP_429", 429, "Your credit balance is too low to access the Anthropic API.");
  assert.equal(isRetryable(credit429), false);
  const quota = new ProviderFailure("HTTP_429", 429, '{"error":{"code":"insufficient_quota"}}');
  assert.equal(isRetryable(quota), false);
});

test("retries until success and counts every attempt", async () => {
  let calls = 0;
  // deno-lint-ignore require-await
  const outcome = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new ProviderFailure("HTTP_529", 529, "overloaded");
    return "done";
  }, options);
  assert.deepEqual(outcome, { ok: true, value: "done", attempts: 3 });
});

test("stops at maxAttempts and returns the last failure", async () => {
  let calls = 0;
  // deno-lint-ignore require-await
  const outcome = await withRetry(async () => {
    calls += 1;
    throw new ProviderFailure("HTTP_500", 500, `boom ${calls}`);
  }, options);
  assert.equal(calls, 3);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.attempts, 3);
    assert.equal(outcome.failure.message, "boom 3");
  }
});

test("a non-retryable failure stops after one attempt", async () => {
  let calls = 0;
  // deno-lint-ignore require-await
  const outcome = await withRetry(async () => {
    calls += 1;
    throw new ProviderFailure("HTTP_400", 400, "bad request");
  }, options);
  assert.equal(calls, 1);
  assert.equal(outcome.ok, false);
});

test("errors that are not ProviderFailure (a budget stop, a bug) propagate instead of being retried", async () => {
  let calls = 0;
  await assert.rejects(
    // deno-lint-ignore require-await
    withRetry(async () => {
      calls += 1;
      throw new RangeError("budget");
    }, options),
    RangeError,
  );
  assert.equal(calls, 1);
});

test("backoff doubles, retry-after wins but is capped", () => {
  assert.equal(delayFor(new ProviderFailure("HTTP_500", 500, "x"), 0, options), 100);
  assert.equal(delayFor(new ProviderFailure("HTTP_500", 500, "x"), 2, options), 400);
  assert.equal(delayFor(new ProviderFailure("HTTP_500", 500, "x"), 10, options), 1000);
  assert.equal(delayFor(new ProviderFailure("HTTP_429", 429, "x", 250), 0, options), 250);
  assert.equal(delayFor(new ProviderFailure("HTTP_429", 429, "x", 3_600_000), 0, options), 1000);
  assert.equal(DEFAULT_RETRY.maxAttempts, 3);
});

test("sleep is called between attempts only", async () => {
  sleeps.length = 0;
  // deno-lint-ignore require-await
  await withRetry(async () => { throw new ProviderFailure("HTTP_500", 500, "x"); }, options);
  assert.deepEqual(sleeps, [100, 200]);
});

test("toProviderError redacts secrets and truncates", () => {
  const failure = new ProviderFailure("HTTP_401", 401, `bad key sk-ant-FAKEFAKE0123456 ${"x".repeat(900)}`);
  const error = toProviderError(failure);
  assert.ok(!error.message.includes("FAKEFAKE"));
  assert.ok(error.message.length <= 500);
  assert.equal(error.retryable, false);
});
