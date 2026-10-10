import assert from "node:assert/strict";
import test from "node:test";
import { estimateSpecOf, parseProviderSpec, SpecError } from "./provider_spec.ts";

test("provider specs parse model, effort and thinking", () => {
  assert.deepEqual(parseProviderSpec("openai:gpt-6-luna"), { provider: "openai", model: "gpt-6-luna" });
  assert.deepEqual(parseProviderSpec("anthropic:claude-haiku-5-5@effort=low,thinking=off"), {
    provider: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off",
  });
  assert.deepEqual(parseProviderSpec("anthropic:claude-opus-5-5@effort=medium"), { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" });
});

test("bad specs are rejected with a typed error", () => {
  for (const bad of [
    "", "claude-haiku-5-5", "anthropic:", "anthropic:claude-unknown-9", "openai:claude-haiku-5-5", "anthropic:gpt-6-luna",
    "anthropic:claude-haiku-5-5@effort=extreme", "anthropic:claude-haiku-5-5@temperature=0", "openai:gpt-6-luna@thinking=off",
  ]) {
    assert.throws(() => parseProviderSpec(bad), SpecError, bad);
  }
});

test("the tokenizer factor applies to Claude specs only", () => {
  assert.equal(estimateSpecOf(parseProviderSpec("anthropic:claude-haiku-5-5"), 1.3).tokenizerFactor, 1.3);
  assert.equal(estimateSpecOf(parseProviderSpec("openai:gpt-6-luna"), 1.3).tokenizerFactor, 1);
});
