import assert from "node:assert/strict";
import test from "node:test";
import { METRIC_SPECS, TOPIX_PROXY_LABEL, type YahooSpec } from "./packet_schema.ts";
import { parseDailyChart, yahooDailyUrl, yahooMetric } from "./yahoo_daily.ts";
import { chart, CLOSE_0916, jpBar, nikkeiChart, topixEtfChart, usBar, usIndexChart } from "./test_fixtures.ts";

const spec = (key: string) => METRIC_SPECS.find((item) => item.key === key) as YahooSpec;
const FETCHED = "2026-09-16T07:15:03.000Z";

test("close: same-day daily bar + regularMarketTime after 15:30 is fresh", () => {
  const metric = yahooMetric(spec("nikkei225"), { ok: true, payload: CLOSE_0916.n225 }, "2026-09-16", true, FETCHED);
  assert.deepEqual(metric.freshness, "fresh");
  assert.deepEqual(metric.value, 63923);
  assert.deepEqual(metric.previous_close, 63484.1);
  assert.deepEqual(metric.change, 438.9);
  assert.deepEqual(metric.change_pct, 0.69);
  assert.deepEqual(metric.session_date, "2026-09-16");
  assert.deepEqual(metric.observed_at, "2026-09-16T06:45:00.000Z");
  assert.deepEqual(metric.provider, "yahoo_chart");
  assert.deepEqual(metric.quality, "unofficial_delayed");
  assert.deepEqual(metric.source_url, "https://query2.finance.yahoo.com/v8/finance/chart/%5EN225?range=1mo&interval=1d&events=history");
  assert.deepEqual(metric.gap_reason, null);
});

test("1306 is labelled as the TOPIX-tracking ETF proxy, never as TOPIX", () => {
  const metric = yahooMetric(spec("topix_proxy_1306"), { ok: true, payload: CLOSE_0916.etf1306 }, "2026-09-16", true, FETCHED);
  assert.deepEqual(metric.label, TOPIX_PROXY_LABEL);
  assert.deepEqual(metric.label, "TOPIX連動ETF（1306）");
  assert.deepEqual(metric.kind, "proxy_etf");
  assert.deepEqual(metric.is_proxy, true);
  assert.deepEqual(metric.proxy_for, "TOPIX");
  assert.deepEqual(metric.freshness, "fresh");
  assert.deepEqual(metric.value, 423.9);
});

test("close: intraday bar (regularMarketTime 13:49 JST) is not a close", () => {
  const payload = nikkeiChart("2026-09-17T04:49:00Z", [jpBar("2026-09-16", 63923), jpBar("2026-09-17", 64160.72)]);
  const metric = yahooMetric(spec("nikkei225"), { ok: true, payload }, "2026-09-17", true, FETCHED);
  assert.deepEqual(metric.freshness, "unavailable");
  assert.deepEqual(metric.gap_reason, "session_not_closed");
  assert.deepEqual(metric.value, null);
  assert.deepEqual(metric.previous_close, null);
});

test("close: only the previous day's close exists → rejected, never substituted", () => {
  const payload = nikkeiChart("2026-09-15T06:45:00Z", [jpBar("2026-09-14", 63492.99), jpBar("2026-09-15", 63484.1)]);
  const metric = yahooMetric(spec("nikkei225"), { ok: true, payload }, "2026-09-16", true, FETCHED);
  assert.deepEqual(metric.freshness, "unavailable");
  assert.deepEqual(metric.gap_reason, "expected_session_not_available");
  assert.deepEqual(metric.value, null);
  assert.deepEqual(metric.expected_session_date, "2026-09-16");
});

test("close at 15:30 JST exactly counts as closed; 15:29 does not", () => {
  const at1530 = topixEtfChart("2026-09-16T06:30:00Z", [jpBar("2026-09-15", 421.3), jpBar("2026-09-16", 423.9)]);
  const at1529 = topixEtfChart("2026-09-16T06:29:00Z", [jpBar("2026-09-15", 421.3), jpBar("2026-09-16", 423.9)]);
  assert.deepEqual(yahooMetric(spec("topix_proxy_1306"), { ok: true, payload: at1530 }, "2026-09-16", true, FETCHED).freshness, "fresh");
  assert.deepEqual(yahooMetric(spec("topix_proxy_1306"), { ok: true, payload: at1529 }, "2026-09-16", true, FETCHED).gap_reason, "session_not_closed");
});

test("morning: previous session is final when a later bar exists", () => {
  const payload = nikkeiChart("2026-09-17T04:49:00Z", [jpBar("2026-09-15", 63484.1), jpBar("2026-09-16", 63923), jpBar("2026-09-17", 64160.72)]);
  const metric = yahooMetric(spec("nikkei225"), { ok: true, payload }, "2026-09-16", true, FETCHED);
  assert.deepEqual(metric.freshness, "fresh");
  assert.deepEqual(metric.value, 63923);
  assert.deepEqual(metric.observed_at, "2026-09-16T06:30:00.000Z");
});

test("US index: closed session via regularMarketTime after 16:00 New York", () => {
  const payload = usIndexChart("^SOX", "2026-09-16T21:15:00Z", [usBar("2026-09-15", 11175.55), usBar("2026-09-16", 11246.11)]);
  const metric = yahooMetric(spec("sox"), { ok: true, payload }, "2026-09-16", false, FETCHED);
  assert.deepEqual(metric.freshness, "fresh");
  assert.deepEqual(metric.value, 11246.11);
  assert.deepEqual(metric.change_pct, 0.63);
  assert.deepEqual(metric.required, false);
});

test("identity mismatch (e.g. the CBOE instrument behind ^TPX) is rejected", () => {
  const payload = chart({
    symbol: "^N225", currency: "USD", timezone: "America/Chicago", instrumentType: "INDEX",
    regularMarketTime: "2026-09-16T06:45:00Z", bars: [jpBar("2026-09-15", 1), jpBar("2026-09-16", 2)],
  });
  const metric = yahooMetric(spec("nikkei225"), { ok: true, payload }, "2026-09-16", true, FETCHED);
  assert.deepEqual(metric.gap_reason, "identity_mismatch");
  assert.deepEqual(metric.value, null);
});

test("fetch failure and malformed payload become gaps", () => {
  assert.deepEqual(yahooMetric(spec("dow"), { ok: false }, "2026-09-15", false, FETCHED).gap_reason, "fetch_failed");
  assert.deepEqual(yahooMetric(spec("dow"), { ok: true, payload: { chart: { result: [] } } }, "2026-09-15", false, FETCHED).gap_reason, "invalid_value");
});

test("parser drops null/non-positive closes and keeps the last duplicate per date", () => {
  const parsed = parseDailyChart(nikkeiChart("2026-09-16T06:45:00Z", [
    jpBar("2026-09-14", null), jpBar("2026-09-15", 0), jpBar("2026-09-16", 63900), ["2026-09-16T06:45:00Z", 63923],
  ]));
  assert.deepEqual(parsed?.bars, [{ sessionDate: "2026-09-16", close: 63923 }]);
});

test("source URLs carry no credentials", () => {
  assert.deepEqual(yahooDailyUrl("1306.T"), "https://query2.finance.yahoo.com/v8/finance/chart/1306.T?range=1mo&interval=1d&events=history");
});
