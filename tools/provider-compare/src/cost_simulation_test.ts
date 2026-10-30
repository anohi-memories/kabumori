import assert from "node:assert/strict";
import test from "node:test";
import { loadLedgerSnapshot } from "./ledger_snapshot.ts";
import { markdownTable, SCENARIOS, simulate, simulateAll } from "./cost_simulation.ts";
import { MODEL_PRICES } from "./pricing.ts";
import { thinkingOverhead } from "./estimate.ts";

const snapshot = await loadLedgerSnapshot();
const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!;

test("scenario A reproduces the measured ledger: ~$13.3/month for the news pipeline", () => {
  const a = simulate(snapshot, scenario("A"));
  const measuredTotal = Object.values(snapshot.features).reduce((sum, f) => sum + f.totalUsd, 0);
  const expected = (measuredTotal / snapshot.window.days) * 30;
  assert.ok(Math.abs(a.monthlyOpenAiUsd - expected) < 0.05, `${a.monthlyOpenAiUsd} vs ${expected}`);
  assert.equal(a.monthlyClaudeUsd, 0);
  assert.ok(a.monthlyOpenAiUsd > 12 && a.monthlyOpenAiUsd < 15);
  assert.ok(a.steps.every((s) => s.basis === "measured"));
});

test("Sol-class judgement is the biggest OpenAI line, as the ledger says (~66% of spend)", () => {
  const a = simulate(snapshot, scenario("A"));
  const sol = a.steps.find((s) => s.feature === "judgement_sol")!;
  assert.ok(sol.monthlyUsd / a.monthlyOpenAiUsd > 0.6);
});

test("moving a step to Claude removes it from OpenAI and adds it to Claude, as an 'assumed' line", () => {
  const b = simulate(snapshot, scenario("B"));
  const sol = b.steps.find((s) => s.feature === "judgement_sol")!;
  assert.equal(sol.provider, "anthropic");
  assert.equal(sol.model, "claude-sonnet-5-5");
  assert.equal(sol.basis, "assumed");
  const untouched = b.steps.find((s) => s.feature === "generation_draft")!;
  assert.equal(untouched.provider, "openai");
  assert.ok(b.monthlyClaudeUsd > 0 && b.monthlyOpenAiUsd < simulate(snapshot, scenario("A")).monthlyOpenAiUsd);
});

test("Claude lines grow with the tokenizer factor; OpenAI lines do not", () => {
  const one = simulate(snapshot, scenario("C"), { tokenizerFactor: 1 });
  const more = simulate(snapshot, scenario("C"), { tokenizerFactor: 1.3 });
  assert.ok(more.monthlyClaudeUsd > one.monthlyClaudeUsd * 1.25);
  assert.equal(more.monthlyOpenAiUsd, one.monthlyOpenAiUsd);
  const a1 = simulate(snapshot, scenario("A"), { tokenizerFactor: 1 });
  const a2 = simulate(snapshot, scenario("A"), { tokenizerFactor: 1.3 });
  assert.equal(a1.monthlyTotalUsd, a2.monthlyTotalUsd);
});

test("the credit defaults to ZERO: an unverified credit is never counted", () => {
  for (const result of simulateAll(snapshot)) {
    assert.equal(result.creditUsd, 0);
    assert.equal(result.claudeCoveredByCreditUsd, 0);
    assert.equal(result.selfPayUsd, result.monthlyTotalUsd);
  }
});

test("a verified $100 credit covers only Claude spend, never OpenAI, and is capped at the spend", () => {
  const b = simulate(snapshot, scenario("B"), { creditUsd: 100 });
  assert.equal(b.claudeCoveredByCreditUsd, b.monthlyClaudeUsd);
  assert.equal(b.selfPayUsd, b.monthlyOpenAiUsd);
  const a = simulate(snapshot, scenario("A"), { creditUsd: 100 });
  assert.equal(a.claudeCoveredByCreditUsd, 0, "nothing to cover when nothing runs on Claude");
  assert.equal(a.selfPayUsd, a.monthlyOpenAiUsd);
  const tiny = simulate(snapshot, scenario("C"), { creditUsd: 5 });
  assert.equal(tiny.claudeCoveredByCreditUsd, 5);
  assert.ok(Math.abs(tiny.selfPayUsd - (tiny.monthlyTotalUsd - 5)) < 0.011);
});

test("a negative credit is treated as zero", () => {
  assert.equal(simulate(snapshot, scenario("B"), { creditUsd: -50 }).creditUsd, 0);
});

test("Haiku 5.5 with thinking off prices exactly like gpt-6-luna per token, so the light steps are a cost wash", () => {
  assert.equal(MODEL_PRICES["claude-haiku-5-5"].inputPerMTok, MODEL_PRICES["gpt-6-luna"].inputPerMTok);
  assert.equal(MODEL_PRICES["claude-haiku-5-5"].outputPerMTok, MODEL_PRICES["gpt-6-luna"].outputPerMTok);
  assert.equal(thinkingOverhead("claude-haiku-5-5", "low", "off"), 0);
  assert.equal(thinkingOverhead("claude-sonnet-5-5", "low", "off"), 0);
  assert.ok(thinkingOverhead("claude-opus-5-5", "low", "off") > 0, "Opus 5.5 cannot turn thinking off");
});

test("Sonnet 5.5 prices like gpt-6-sol per token; only the thinking overhead separates them", () => {
  assert.equal(MODEL_PRICES["claude-sonnet-5-5"].inputPerMTok, MODEL_PRICES["gpt-6-sol"].inputPerMTok);
  assert.equal(MODEL_PRICES["claude-sonnet-5-5"].outputPerMTok, MODEL_PRICES["gpt-6-sol"].outputPerMTok);
});

test("the table lists all three scenarios at both tokenizer factors", () => {
  const table = markdownTable(simulateAll(snapshot));
  assert.equal(table.split("\n").length, 2 + 6);
  assert.match(table, /\| A /);
  assert.match(table, /\| B /);
  assert.match(table, /\| C /);
});
