import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateUsPremarketFacts,
  isUsDaylightSaving,
  normalizeUsPremarketMetric,
  resolveUsPremarketRunMode,
  validateUsPremarketFreshness,
  type RawUsPremarketMetric,
} from "./us_premarket_logic.ts";

const raw = (overrides: Partial<RawUsPremarketMetric> = {}): RawUsPremarketMetric => ({
  label: "S&P500先物", value: "5600", previous_close: "5580", change: "+20",
  change_percent: "+0.36%", timestamp: "2026-08-31T12:55:00.000Z",
  source_url: "https://www.cmegroup.com/example", ...overrides,
});

test("US daylight saving selects the correct JST window", () => {
  assert.equal(isUsDaylightSaving("2026-08-31T13:00:00.000Z"), true);
  assert.equal(resolveUsPremarketRunMode("2026-08-31T13:00:00.000Z"), "live"); // 22:00 JST
  assert.equal(isUsDaylightSaving("2026-12-01T14:00:00.000Z"), false);
  assert.equal(resolveUsPremarketRunMode("2026-12-01T14:00:00.000Z"), "live"); // 23:00 JST
});

test("realtime futures freshness is checked independently", () => {
  assert.equal(validateUsPremarketFreshness("futures", "2026-08-31T12:55:00.000Z", "2026-08-31T13:00:00.000Z", "live"), "fresh");
  assert.equal(validateUsPremarketFreshness("futures", "2026-08-31T11:00:00.000Z", "2026-08-31T13:00:00.000Z", "live"), "stale");
  assert.equal(validateUsPremarketFreshness("futures", "2026-08-28T20:00:00.000Z", "2026-08-30T13:00:00.000Z", "preflight"), "preflight_latest");
});

test("change percent is recalculated and valid facts pass", () => {
  const reference = "2026-08-31T13:00:00.000Z";
  const futures = ["S&P500先物", "Nasdaq100先物", "Dow先物"].map((label) =>
    normalizeUsPremarketMetric(raw({ label }), "futures", reference, "live")
  );
  const semiconductor = normalizeUsPremarketMetric(raw({ label: "SOX", timestamp: "2026-08-28T20:00:00.000Z" }), "semiconductor_signal", reference, "live");
  assert.equal(futures[0].change_percent, "+0.36%");
  assert.equal(evaluateUsPremarketFacts({
    requiredFutures: futures, semiconductorSignal: semiconductor, movers: [], optional: [],
    trustedSourceCount: 2, dateConsistencyPassed: true, importantNewsVerified: true,
    isUsMarketOpen: true, mode: "live",
  }).status, "passed");
});

test("missing futures, contradiction, or a live holiday stops publication", () => {
  const reference = "2026-08-31T13:00:00.000Z";
  const missing = normalizeUsPremarketMetric(raw({ value: "", source_url: "" }), "futures", reference, "live");
  const semiconductor = normalizeUsPremarketMetric(raw({ label: "SOX", change: "+999", timestamp: "2026-08-28T20:00:00.000Z" }), "semiconductor_signal", reference, "live");
  const result = evaluateUsPremarketFacts({
    requiredFutures: [missing], semiconductorSignal: semiconductor, movers: [], optional: [],
    trustedSourceCount: 1, dateConsistencyPassed: true, importantNewsVerified: true,
    isUsMarketOpen: false, mode: "live",
  });
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" | "), /必須米先物データ取得不能/);
  assert.match(result.notes.join(" | "), /米国市場休場/);
});
