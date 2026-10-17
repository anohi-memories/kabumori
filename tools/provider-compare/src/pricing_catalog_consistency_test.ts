import assert from "node:assert/strict";
import test from "node:test";
import { listModelSpecs } from "../../../supabase/functions/_shared/ai_provider/model_catalog.ts";
import { MODEL_PRICES } from "./pricing.ts";

// The harness keeps its own price table (it is a standalone tool). Where a model is also in the production provider
// catalog (supabase/functions/_shared/ai_provider/model_catalog.ts, read-only), the two must agree, so a cost comparison
// made here is the same arithmetic production will use. A model that only one side knows is not compared.

const catalog = listModelSpecs();

test("every model both tables know has the same prices", () => {
  const common = catalog.filter((spec) => spec.id in MODEL_PRICES);
  // guards against a rename silently emptying the comparison
  assert.ok(common.length >= 4, `common models: ${common.map((s) => s.id).join(",")}`);
  for (const spec of common) {
    const price = MODEL_PRICES[spec.id];
    const base = spec.priceTiers[0];
    assert.equal(price.provider, spec.provider, spec.id);
    assert.equal(price.inputPerMTok, base.inputPer1M, `${spec.id} input`);
    assert.equal(price.outputPerMTok, base.outputPer1M, `${spec.id} output`);
    if (price.provider === "anthropic") {
      assert.equal(price.cacheReadPerMTok, base.cacheReadPer1M, `${spec.id} cache read`);
      assert.equal(price.cacheWritePerMTok, base.cacheWrite5mPer1M, `${spec.id} cache write`);
    }
    const long = spec.priceTiers[1];
    if (long) {
      assert.ok(price.longContext, `${spec.id} has a long-context tier in the catalog`);
      assert.equal(price.longContext.overPromptTokens, long.promptTokensAbove, `${spec.id} long-context threshold`);
      assert.equal(price.longContext.inputPerMTok, long.inputPer1M, `${spec.id} long-context input`);
      assert.equal(price.longContext.outputPerMTok, long.outputPer1M, `${spec.id} long-context output`);
    } else {
      assert.equal(price.longContext, undefined, `${spec.id} has no long-context tier in the catalog`);
    }
  }
});

test("the Claude 5.5 family is in both tables", () => {
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
    assert.ok(catalog.some((s) => s.id === id), `${id} missing from the production catalog`);
    assert.ok(id in MODEL_PRICES, `${id} missing from the harness table`);
  }
});
