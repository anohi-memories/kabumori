import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMaterialFreshness,
  classifyOptionalMaterialForInclusion,
  hasIndependentCausalSupport,
  hasStrongCausalAssertion,
  independentPublisherCount,
} from "./report_material_logic.ts";

const reference = "2026-08-30T23:17:00Z";
const target = "2026-08-31";
const freshness = (materialType: Parameters<typeof classifyMaterialFreshness>[0]["materialType"], timestamp: string) =>
  classifyMaterialFreshness({
    materialType, timestamp, referenceIso: reference, targetTradingDate: target,
    expectedSessionDate: "2026-08-28",
  });

test("date-only material is evaluated by calendar date, not fabricated UTC elapsed hours", () => {
  assert.equal(freshness("central_bank_policy", "2026-08-28"), "usable");
});

test("the previous US market session remains usable for a Monday morning report", () => {
  assert.equal(freshness("market_session", "2026-08-28"), "usable");
  assert.equal(freshness("market_session", "2026-08-27"), "stale");
});

test("a Fed policy item from several days earlier remains usable", () => {
  assert.equal(freshness("central_bank_policy", "2026-08-25"), "usable");
  assert.equal(freshness("central_bank_policy", "2026-08-20"), "stale");
});

test("date-only or old FX material cannot describe the current market", () => {
  assert.equal(freshness("realtime_market", "2026-08-31"), "stale");
  assert.equal(freshness("realtime_market", "2026-08-30T22:00:00Z"), "stale");
  assert.equal(freshness("realtime_market", "2026-08-30T23:00:00Z"), "usable");
});

test("corporate material remains usable for up to three business days", () => {
  assert.equal(freshness("corporate", "2026-08-26"), "usable");
  assert.equal(freshness("corporate", "2026-08-25"), "stale");
});

test("future material is always rejected", () => {
  assert.equal(freshness("central_bank_policy", "2026-09-01"), "future");
  assert.equal(freshness("realtime_market", "2026-08-31T00:00:00Z"), "future");
});

const optionalDecision = (
  materialType: Parameters<typeof classifyOptionalMaterialForInclusion>[0]["materialType"],
  timestamp: string,
  text: string,
) => classifyOptionalMaterialForInclusion({
  materialType,
  timestamp,
  text,
  referenceIso: reference,
  targetTradingDate: target,
  expectedSessionDate: "2026-08-28",
});

test("future economic releases are excluded from conditional factors", () => {
  const decision = optionalDecision("economic_indicator", "2026-09-01", "JOLTS will be released tomorrow");
  assert.equal(decision.include, false);
  assert.equal(decision.filteredReason, "future");
});

test("future earnings schedules are excluded from conditional factors", () => {
  const decision = optionalDecision("corporate", "2026-08-31", "NVIDIA決算発表予定");
  assert.equal(decision.include, false);
  assert.equal(decision.filteredReason, "future");
});

test("future Fed events are excluded from conditional factors", () => {
  const decision = optionalDecision("central_bank_policy", "2026-08-31", "Upcoming FOMC meeting");
  assert.equal(decision.include, false);
  assert.equal(decision.filteredReason, "future");
});

test("unknown optional timestamps are excluded from conditional factors", () => {
  const decision = optionalDecision("geopolitics", "unknown", "確認時刻が不明の材料");
  assert.equal(decision.include, false);
  assert.equal(decision.filteredReason, "unknown_timestamp");
});

test("verified past optional materials remain available", () => {
  const decision = optionalDecision("central_bank_policy", "2026-08-28", "Fedが金融政策に関する講演を公表した");
  assert.equal(decision.include, true);
  assert.equal(decision.filteredReason, null);
});

test("same publisher subdomains are not counted as independent media", () => {
  const domains = ["reuters.com", "apnews.com"];
  assert.equal(independentPublisherCount([
    "https://www.reuters.com/a", "https://markets.reuters.com/b", "https://reuters.com/c",
  ], domains), 1);
  assert.equal(independentPublisherCount([
    "https://www.reuters.com/a", "https://apnews.com/b",
  ], domains), 2);
});

test("strong causal assertions require two independent publishers", () => {
  const domains = ["reuters.com", "apnews.com"];
  assert.equal(hasStrongCausalAssertion("FRB発言を受けて半導体株が下落した"), true);
  assert.equal(hasStrongCausalAssertion("FRB発言が重しになった可能性があります"), false);
  assert.equal(hasStrongCausalAssertion(
    "FRB発言によって半導体株が下落した。日本株にも影響する可能性があります",
  ), true);
  assert.equal(hasIndependentCausalSupport([
    "https://www.reuters.com/a", "https://markets.reuters.com/b",
  ], domains), false);
  assert.equal(hasIndependentCausalSupport([
    "https://www.reuters.com/a", "https://apnews.com/b",
  ], domains), true);
});
