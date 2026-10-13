import assert from "node:assert/strict";
import test from "node:test";
import { costUsd, estimateRequestUsd, MODEL_PRICES, priceOf, promptTokens, UnknownModelError } from "./pricing.ts";
import type { Usage } from "./types.ts";

const usage = (overrides: Partial<Usage> = {}): Usage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0, ...overrides,
});

test("official Claude prices (docs retrieved 2026-10-09) are in the table", () => {
  assert.deepEqual(
    [MODEL_PRICES["claude-opus-5-5"].inputPerMTok, MODEL_PRICES["claude-opus-5-5"].outputPerMTok, MODEL_PRICES["claude-opus-5-5"].cacheReadPerMTok],
    [4, 20, 0.2],
  );
  assert.deepEqual(
    [MODEL_PRICES["claude-sonnet-5-5"].inputPerMTok, MODEL_PRICES["claude-sonnet-5-5"].outputPerMTok, MODEL_PRICES["claude-sonnet-5-5"].cacheReadPerMTok],
    [2, 10, 0.1],
  );
  assert.deepEqual(
    [MODEL_PRICES["claude-haiku-5-5"].inputPerMTok, MODEL_PRICES["claude-haiku-5-5"].outputPerMTok, MODEL_PRICES["claude-haiku-5-5"].cacheReadPerMTok],
    [0.1, 0.5, 0.01],
  );
  assert.deepEqual(
    [MODEL_PRICES["claude-fable-5-1"].inputPerMTok, MODEL_PRICES["claude-fable-5-1"].outputPerMTok],
    [10, 50],
  );
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]) {
    assert.equal(MODEL_PRICES[model].verified, "official", model);
    assert.equal(MODEL_PRICES[model].webSearchPer1000, 10, model);
  }
});

test("OpenAI rows are flagged as ledger assumptions, never as verified invoices", () => {
  for (const [model, price] of Object.entries(MODEL_PRICES)) {
    if (price.provider === "openai") assert.equal(price.verified, "ledger_assumption", model);
  }
});

test("token cost: input, output, cache write and cache read each use their own rate", () => {
  // Sonnet 5.5: 1M in x $2 + 1M out x $10 + 1M cache write x $2.5 + 1M cache read x $0.10
  const total = costUsd("claude-sonnet-5-5", usage({
    inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000,
  }));
  assert.equal(total, 14.6);
});

test("web search is $10 per 1,000 searches on top of tokens", () => {
  assert.equal(costUsd("claude-opus-5-5", usage({ webSearchRequests: 1000 })), 10);
  assert.equal(costUsd("claude-opus-5-5", usage({ webSearchRequests: 3 })), 0.03);
  // one search with 13,273 input and 216 output tokens on Sonnet 5.5
  assert.equal(costUsd("claude-sonnet-5-5", usage({ inputTokens: 13_273, outputTokens: 216, webSearchRequests: 1 })), 0.038706);
});

test("Claude Haiku 5.5 switches to the long-prompt tier only OVER 100,000 prompt tokens (cache included)", () => {
  const at = usage({ inputTokens: 100_000, outputTokens: 1_000_000 });
  const over = usage({ inputTokens: 100_001, outputTokens: 1_000_000 });
  assert.equal(costUsd("claude-haiku-5-5", at), 0.01 + 0.5);
  assert.equal(Number(costUsd("claude-haiku-5-5", over).toFixed(6)), Number((100_001 * 0.5 / 1e6 + 2.5).toFixed(6)));
  // cache reads count toward the prompt length
  const viaCache = usage({ inputTokens: 10, cacheReadTokens: 100_000, outputTokens: 0 });
  assert.equal(promptTokens(viaCache), 100_010);
  assert.equal(Number(costUsd("claude-haiku-5-5", viaCache).toFixed(8)), Number((10 * 0.5 / 1e6 + 100_000 * 0.05 / 1e6).toFixed(8)));
});

test("a model without a cache rate charges cache tokens at the input rate (conservative)", () => {
  const price = priceOf("gpt-6-luna");
  assert.equal(price.cacheReadPerMTok, undefined);
  assert.equal(costUsd("gpt-6-luna", usage({ cacheReadTokens: 1_000_000 })), price.inputPerMTok);
});

test("negative, NaN and fractional token counts never produce negative or NaN cost", () => {
  const cost = costUsd("claude-opus-5-5", usage({ inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: 2.9 }));
  assert.ok(Number.isFinite(cost) && cost >= 0);
});

test("unknown model throws a typed error instead of guessing a price", () => {
  assert.throws(() => priceOf("claude-imaginary"), UnknownModelError);
  assert.throws(() => costUsd("gpt-9", usage()), /PRICE_UNKNOWN_MODEL:gpt-9/);
});

test("the pre-call estimate is pessimistic: 1 token per character and the whole output allowance", () => {
  const estimate = estimateRequestUsd("claude-sonnet-5-5", 2000, 1000);
  assert.equal(estimate, (2000 * 2 + 1000 * 10) / 1e6);
  assert.ok(estimateRequestUsd("claude-sonnet-5-5", 2000, 1000, 1) > estimate);
});
