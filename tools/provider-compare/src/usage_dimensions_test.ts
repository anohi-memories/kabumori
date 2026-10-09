import assert from "node:assert/strict";
import test from "node:test";
import { aggregate, allocateMonthlyCredit } from "./usage_dimensions.ts";
import type { UsageRecord } from "./types.ts";

const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 };
const row = (provider: "openai" | "anthropic", app: string, feature: string, costUsd: number, month = "2026-10", model = "m"): UsageRecord => ({
  provider, app, feature, model, month, usage, costUsd,
});

const records = [
  row("anthropic", "kabumori", "news_judgement_detail", 3, "2026-10", "claude-sonnet-5-5"),
  row("anthropic", "kabumori", "news_judgement_detail", 1, "2026-10", "claude-sonnet-5-5"),
  row("anthropic", "postona", "ai_consult", 4, "2026-10", "claude-sonnet-5-5"),
  row("openai", "kabumori", "news_judgement_primary", 0.5, "2026-10", "gpt-6-luna"),
  row("anthropic", "kabumori", "news_judgement_detail", 9, "2026-11", "claude-sonnet-5-5"),
];

test("usage can be grouped by provider, app, feature, model and month", () => {
  const byProvider = aggregate(records, ["provider"]);
  assert.deepEqual([...byProvider.keys()], ["anthropic", "openai"]);
  assert.equal(byProvider.get("anthropic")!.costUsd, 17);
  const byApp = aggregate(records, ["provider", "app"]);
  assert.equal(byApp.get("anthropic/kabumori")!.costUsd, 13);
  assert.equal(byApp.get("anthropic/postona")!.costUsd, 4);
  assert.equal(byApp.get("anthropic/kabumori")!.calls, 3);
  const byFeature = aggregate(records, ["month", "app", "feature"]);
  assert.equal(byFeature.get("2026-10/kabumori/news_judgement_detail")!.costUsd, 4);
});

test("group keys are stable and sorted", () => {
  const keys = [...aggregate(records, ["app", "provider"]).keys()];
  assert.deepEqual(keys, [...keys].sort());
});

test("a month's credit covers that month's Claude spend and is split across apps by spend", () => {
  const allocation = allocateMonthlyCredit(records, "2026-10", 6);
  assert.equal(allocation.claudeSpendUsd, 8);
  assert.equal(allocation.coveredByCreditUsd, 6);
  assert.equal(allocation.selfPayUsd, 2);
  assert.equal(allocation.byApp.kabumori.spendUsd, 4);
  assert.equal(allocation.byApp.postona.spendUsd, 4);
  assert.equal(allocation.byApp.kabumori.coveredByCreditUsd, 3);
  assert.equal(allocation.byApp.postona.selfPayUsd, 1);
});

test("OpenAI spend and other months are never covered by a month's Claude credit", () => {
  const allocation = allocateMonthlyCredit(records, "2026-10", 1000);
  assert.equal(allocation.claudeSpendUsd, 8, "the 2026-11 row and the OpenAI row are excluded");
  assert.equal(allocation.coveredByCreditUsd, 8);
  assert.equal(allocation.selfPayUsd, 0);
});

test("unused credit expires at the end of the cycle: it is reported, never rolled over", () => {
  const allocation = allocateMonthlyCredit(records, "2026-10", 100);
  assert.equal(allocation.expiredCreditUsd, 92);
  const november = allocateMonthlyCredit(records, "2026-11", 100);
  assert.equal(november.claudeSpendUsd, 9);
  assert.equal(november.expiredCreditUsd, 91, "October's unused credit does not increase November's");
});

test("with no Claude spend or no credit nothing is divided by zero", () => {
  const none = allocateMonthlyCredit([], "2026-10", 100);
  assert.deepEqual(none.byApp, {});
  assert.equal(none.expiredCreditUsd, 100);
  const noCredit = allocateMonthlyCredit(records, "2026-10", 0);
  assert.equal(noCredit.selfPayUsd, 8);
  assert.equal(noCredit.byApp.kabumori.coveredByCreditUsd, 0);
  assert.equal(allocateMonthlyCredit(records, "2026-10", -5).creditUsd, 0);
});
