import assert from "node:assert/strict";
import test from "node:test";

import {
  UsefulTipAttemptError,
  UsefulTipGenerationError,
  runUsefulTipLunaWithTruncationRetry,
  runUsefulTipVoiceGatedPublish,
  shouldEscalateUsefulTipToSol,
  usefulTipStoredDiagnostics,
  type UsefulTipAttemptDiagnostic,
} from "./useful_tip_generation_logic.ts";

function diagnostic(overrides: Partial<UsefulTipAttemptDiagnostic> = {}): UsefulTipAttemptDiagnostic {
  return {
    model: "gpt-5.6-luna",
    attempt: 1,
    maxOutputTokens: 2400,
    responseStatus: "completed",
    incompleteReason: null,
    truncated: false,
    ...overrides,
  };
}

test("initial Luna truncation retries once with a larger output limit and succeeds", async () => {
  const calls: Array<{ maxOutputTokens: number; attempt: number }> = [];
  const result = await runUsefulTipLunaWithTruncationRetry(async (maxOutputTokens, attempt) => {
    calls.push({ maxOutputTokens, attempt });
    if (attempt === 1) {
      throw new UsefulTipAttemptError("USEFUL_TIP_OUTPUT_TRUNCATED", diagnostic({
        responseStatus: "incomplete", incompleteReason: "max_output_tokens", truncated: true,
      }));
    }
    return { value: "ok", diagnostic: diagnostic({ attempt: 2, maxOutputTokens }) };
  });
  assert.deepEqual(calls, [
    { maxOutputTokens: 2400, attempt: 1 },
    { maxOutputTokens: 3400, attempt: 2 },
  ]);
  assert.equal(result.value, "ok");
  assert.equal(result.diagnostics.retryCount, 1);
  assert.equal(result.diagnostics.truncated, true);
});

test("a second Luna truncation fails without a third attempt", async () => {
  let calls = 0;
  await assert.rejects(
    runUsefulTipLunaWithTruncationRetry(async (maxOutputTokens, attempt) => {
      calls += 1;
      throw new UsefulTipAttemptError("USEFUL_TIP_OUTPUT_TRUNCATED", diagnostic({
        attempt, maxOutputTokens, responseStatus: "incomplete",
        incompleteReason: "max_output_tokens", truncated: true,
      }));
    }),
    (error: unknown) => {
      assert.ok(error instanceof UsefulTipGenerationError);
      assert.equal(error.diagnostics.attemptCount, 2);
      assert.equal(error.diagnostics.retryCount, 1);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("non-truncation errors are not retried", async () => {
  let calls = 0;
  await assert.rejects(
    runUsefulTipLunaWithTruncationRetry(async () => {
      calls += 1;
      throw new UsefulTipAttemptError("USEFUL_TIP_SCHEMA_INVALID", diagnostic());
    }),
    /USEFUL_TIP_SCHEMA_INVALID/,
  );
  assert.equal(calls, 1);
});

test("successful Luna output without needs_sol does not require Sol", () => {
  assert.equal(shouldEscalateUsefulTipToSol(false, "passed"), false);
});

test("needs_sol or Luna Fact failure still requires Sol", () => {
  assert.equal(shouldEscalateUsefulTipToSol(true, "passed"), true);
  assert.equal(shouldEscalateUsefulTipToSol(false, "failed"), true);
});

test("Voice pass permits exactly one publish callback", async () => {
  let publishes = 0;
  const result = await runUsefulTipVoiceGatedPublish({
    factCheckStatus: "passed",
    text: "本文",
    evaluateVoice: async () => ({ passed: true }),
    publish: async () => { publishes += 1; return "posted"; },
  });
  assert.equal(result.publishResult, "posted");
  assert.equal(publishes, 1);
});

test("Voice failure prevents the X publish callback", async () => {
  let publishes = 0;
  await assert.rejects(runUsefulTipVoiceGatedPublish({
    factCheckStatus: "passed",
    text: "本文",
    evaluateVoice: async () => ({ passed: false }),
    publish: async () => { publishes += 1; },
  }), /USEFUL_TIP_VOICE_CHECK_FAILED/);
  assert.equal(publishes, 0);
});

test("Fact failure prevents both Voice and X callbacks", async () => {
  let voices = 0;
  let publishes = 0;
  await assert.rejects(runUsefulTipVoiceGatedPublish({
    factCheckStatus: "failed",
    text: "",
    evaluateVoice: async () => { voices += 1; return { passed: true }; },
    publish: async () => { publishes += 1; },
  }), /USEFUL_TIP_FACT_CHECK_FAILED/);
  assert.equal(voices, 0);
  assert.equal(publishes, 0);
});

test("truncation failure diagnostics are safe structured DB data", () => {
  const stored = usefulTipStoredDiagnostics("tip-id", "テーマ", {
    attemptCount: 2,
    retryCount: 1,
    truncated: true,
    attempts: [
      diagnostic({ responseStatus: "incomplete", incompleteReason: "max_output_tokens", truncated: true }),
      diagnostic({ attempt: 2, maxOutputTokens: 3400, responseStatus: "incomplete", incompleteReason: "max_output_tokens", truncated: true }),
    ],
    xApiCalled: 0,
  }, "USEFUL_TIP_OUTPUT_TRUNCATED");
  assert.equal(stored.useful_tip_id, "tip-id");
  assert.equal(stored.title, "テーマ");
  assert.equal(stored.retry_count, 1);
  assert.equal(stored.attempts[1].incomplete_reason, "max_output_tokens");
  assert.equal(stored.failure_code, "USEFUL_TIP_OUTPUT_TRUNCATED");
  assert.equal(stored.x_api_called, 0);
});
