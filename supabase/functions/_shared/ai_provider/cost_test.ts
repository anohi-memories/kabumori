// Price table and estimated cost (required test 23): pinned official prices, cache pricing, long-context tiers,
// upper bounds that never under-estimate, unknown usage never summed as zero, and the JST usage month.
import assert from "node:assert/strict";
import test from "node:test";
import { attemptCostUsd, costBasisOf, sumUsage, upperBoundAttemptCostUsd, upperBoundInputTokens, usageMonthJst } from "./cost.ts";
import { findModelSpec, listModelSpecs, priceTierFor } from "./model_catalog.ts";
import { sampleRequest } from "./test_support.ts";
import type { AiTokenUsage } from "./types.ts";

function spec(id: string) {
  const found = findModelSpec(id);
  assert.ok(found, id);
  return found;
}

function usage(partial: Partial<AiTokenUsage>): AiTokenUsage {
  return {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: null,
    ...partial,
  };
}

test("catalog: pinned official prices per 1M tokens (verified 2026-10-10)", () => {
  const rows = Object.fromEntries(listModelSpecs().map((s) => [s.id, s.priceTiers.map((t) => [t.promptTokensAbove, t.inputPer1M, t.cacheReadPer1M, t.cacheWrite5mPer1M, t.cacheWrite1hPer1M, t.outputPer1M])]));
  assert.deepEqual(rows, {
    "claude-opus-5-5": [[0, 4, 0.2, 5, 8, 20]],
    "claude-sonnet-5-5": [[0, 2, 0.1, 2.5, 4, 10]],
    "claude-haiku-5-5": [[0, 0.1, 0.01, 0.125, 0.2, 0.5], [100_000, 0.5, 0.05, 0.625, 1, 2.5]],
    "gpt-6.1-sol": [[0, 2, 0.1, 2, 2, 10], [272_000, 4, 0.2, 4, 4, 15]],
    "gpt-6-luna": [[0, 0.1, 0.01, 0.1, 0.1, 0.5]],
  });
});

test("catalog: only documented capabilities; no unknown model; frozen", () => {
  assert.deepEqual(spec("claude-opus-5-5").reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.ok(!spec("gpt-6.1-sol").reasoningEfforts.includes("none"), "Sol does not accept none");
  assert.ok(spec("gpt-6-luna").reasoningEfforts.includes("none"));
  assert.equal(findModelSpec("gpt-6-sol"), undefined, "not verified here, so not callable");
  assert.equal(findModelSpec("claude-opus-5"), undefined);
  for (const entry of listModelSpecs()) {
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.priceTiers) && Object.isFrozen(entry.priceTiers[0]));
    assert.match(entry.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(entry.priceTiers[0].promptTokensAbove, 0);
    assert.ok(entry.id.startsWith(entry.provider === "anthropic" ? "claude-" : "gpt-"));
  }
});

test("23. cost: uncached input, cache read, cache writes and output priced separately", () => {
  // Opus: 1,000 total input = 600 uncached + 200 read + 100 write5m + 100 write1h; 500 output.
  const cost = attemptCostUsd(spec("claude-opus-5-5"), usage({
    inputTokens: 1_000,
    cacheReadInputTokens: 200,
    cacheWrite5mInputTokens: 100,
    cacheWrite1hInputTokens: 100,
    outputTokens: 500,
  }));
  const expected = (600 * 4 + 200 * 0.2 + 100 * 5 + 100 * 8 + 500 * 20) / 1_000_000;
  assert.equal(cost, Math.round(expected * 1e8) / 1e8);
  // OpenAI Sol: 1,000 input of which 200 cached, 300 output.
  assert.equal(attemptCostUsd(spec("gpt-6.1-sol"), usage({ inputTokens: 1_000, cacheReadInputTokens: 200, outputTokens: 300 })), (800 * 2 + 200 * 0.1 + 300 * 10) / 1_000_000);
});

test("23. cost: long-context tiers count the whole prompt including cache, and apply to the whole request", () => {
  const haiku = spec("claude-haiku-5-5");
  assert.equal(priceTierFor(haiku, 100_000).inputPer1M, 0.1);
  assert.equal(priceTierFor(haiku, 100_001).inputPer1M, 0.5);
  const over = attemptCostUsd(haiku, usage({ inputTokens: 100_001, cacheReadInputTokens: 90_000, outputTokens: 1_000 }));
  assert.equal(over, Math.round(((10_001 * 0.5 + 90_000 * 0.05 + 1_000 * 2.5) / 1_000_000) * 1e8) / 1e8);
  assert.equal(priceTierFor(spec("gpt-6.1-sol"), 272_001).outputPer1M, 15);
});

test("upper bound: never below the measured cost of a realistic Japanese request", () => {
  const request = sampleRequest("anthropic", { userContent: "日経平均は前日比で下落しました。".repeat(200), maxOutputTokens: 4_000 });
  const bound = upperBoundInputTokens(request);
  assert.ok(bound > [...request.userContent].length * 2.9, "about 3 bytes per Japanese character");
  const opus = spec("claude-opus-5-5");
  const upper = upperBoundAttemptCostUsd(opus, request);
  const realistic = attemptCostUsd(opus, usage({ inputTokens: [...request.userContent].length * 2, outputTokens: 4_000 }));
  assert.ok(upper >= realistic);
  assert.equal(upper, Math.ceil(((bound * 4 + 4_000 * 20) / 1_000_000) * 1e8) / 1e8);
});

test("totals: unknown usage is counted as unknown, never added as zero", () => {
  const totals = sumUsage([usage({ inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2 }), null, usage({ inputTokens: 1, outputTokens: 1 })]);
  assert.equal(totals.inputTokens, 11);
  assert.equal(totals.outputTokens, 6);
  assert.equal(totals.reasoningOutputTokens, 2);
  assert.equal(totals.unknownUsageAttempts, 1);
  assert.equal(costBasisOf([]), "no_request");
  assert.equal(costBasisOf([{ costIsUpperBound: false }]), "measured");
  assert.equal(costBasisOf([{ costIsUpperBound: false }, { costIsUpperBound: true }]), "includes_upper_bound");
});

test("usage month is the JST calendar month", () => {
  assert.equal(usageMonthJst(Date.UTC(2026, 9, 31, 14, 59)), "2026-10");
  assert.equal(usageMonthJst(Date.UTC(2026, 9, 31, 15, 0)), "2026-11", "00:00 JST on Nov 1");
  assert.equal(usageMonthJst(Date.UTC(2026, 11, 31, 15, 0)), "2027-01");
});
