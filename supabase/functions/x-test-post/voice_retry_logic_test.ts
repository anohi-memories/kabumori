import assert from "node:assert/strict";
import test from "node:test";
import { runWithSingleRetry, SingleRetryExhaustedError } from "./voice_retry_logic.ts";

test("transport/output failure retries once and succeeds", async () => {
  let calls = 0;
  const result = await runWithSingleRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error("VOICE_EVALUATION_EMPTY_OUTPUT");
    return { passed: true };
  }, (error) => error instanceof Error && error.message === "VOICE_EVALUATION_EMPTY_OUTPUT");
  assert.equal(calls, 2);
  assert.equal(result.retryCount, 1);
  assert.deepEqual(result.value, { passed: true });
});

test("second output failure stops after one retry", async () => {
  let calls = 0;
  await assert.rejects(
    () => runWithSingleRetry(async () => {
      calls += 1;
      throw new Error("VOICE_EVALUATION_JSON_PARSE_FAILED");
    }, () => true),
    (error) => error instanceof SingleRetryExhaustedError && error.firstError instanceof Error && error.secondError instanceof Error,
  );
  assert.equal(calls, 2);
});

test("normal Voice rejection is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    () => runWithSingleRetry(async () => {
      calls += 1;
      throw new Error("VOICE_REJECTION");
    }, () => false),
  );
  assert.equal(calls, 1);
});
