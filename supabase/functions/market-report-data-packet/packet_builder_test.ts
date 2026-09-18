import assert from "node:assert/strict";
import test from "node:test";
import { buildMarketDataPacket, type NewsCandidateRow, type PacketInputs, packetContentHash, toNewsRefs } from "./packet_builder.ts";
import { type MarketDataPacket, TOPIX_PROXY_LABEL, validateMarketDataPacket } from "./packet_schema.ts";
import { CLOSE_0916, JPX_HOLIDAYS, MIC_ROWS, MIC_THRESHOLDS, NYSE_HOLIDAYS, nikkeiChart, jpBar } from "./test_fixtures.ts";

const AS_OF = new Date("2026-09-16T07:15:00Z"); // 16:15 JST close cycle
const NEWS_WINDOW = new Date("2026-09-15T06:30:00Z");

function yahooMap(overrides: Record<string, { ok: true; payload: unknown } | { ok: false }> = {}) {
  const base: Record<string, { ok: true; payload: unknown } | { ok: false }> = {
    "^N225": { ok: true, payload: CLOSE_0916.n225 },
    "1306.T": { ok: true, payload: CLOSE_0916.etf1306 },
    "^DJI": { ok: true, payload: CLOSE_0916.us("^DJI") },
    "^GSPC": { ok: true, payload: CLOSE_0916.us("^GSPC") },
    "^IXIC": { ok: true, payload: CLOSE_0916.us("^IXIC") },
    "^SOX": { ok: true, payload: CLOSE_0916.us("^SOX") },
    ...overrides,
  };
  return new Map(Object.entries(base).map(([symbol, result]) => [symbol, { result, fetchedAt: "2026-09-16T07:15:02.000Z" }]));
}

// JGB moved to a recent date so every attempted MIC metric is fresh by default.
const FRESH_MIC = MIC_ROWS.map((row) => row.metric_key.startsWith("JGB") ? { ...row, observed_date: "2026-09-15" } : row);

function inputs(overrides: Partial<PacketInputs> = {}): PacketInputs {
  return {
    reportType: "close",
    tradingDate: "2026-09-16",
    asOf: AS_OF,
    generatedAt: new Date("2026-09-16T07:15:04Z"),
    jpxHolidays: JPX_HOLIDAYS,
    nyseHolidays: NYSE_HOLIDAYS,
    nyseCalendarLastDate: "2026-12-31",
    yahoo: yahooMap(),
    micRows: FRESH_MIC,
    micThresholds: MIC_THRESHOLDS,
    newsRows: [],
    newsWindowStart: NEWS_WINDOW,
    ...overrides,
  };
}

const metric = (packet: MarketDataPacket, key: string) => packet.metrics.find((item) => item.key === key)!;

test("close packet with all attempted metrics fresh is ok and valid", () => {
  const packet = buildMarketDataPacket(inputs());
  assert.deepEqual(validateMarketDataPacket(packet), []);
  assert.equal(packet.schema_version, "market_data_packet.v1");
  assert.equal(packet.session.jpx_session_date, "2026-09-16");
  assert.equal(packet.session.us_session_date, "2026-09-15");
  assert.equal(packet.data_quality.status, "ok");
  assert.deepEqual(packet.data_quality.proxies, ["topix_proxy_1306"]);
  assert.deepEqual(packet.data_quality.intentional_gaps, ["nikkei225_futures", "growth250", "sector_performance", "event_calendar"]);
  assert.equal(metric(packet, "topix_proxy_1306").label, TOPIX_PROXY_LABEL);
  assert.equal(metric(packet, "usdjpy").basis, "ecb_daily_reference_rate");
  assert.equal(metric(packet, "usdjpy").quality, "trusted_free");
  assert.equal(metric(packet, "usdjpy").change, 0.67);
  assert.equal(metric(packet, "nikkei225_futures").gap_reason, "no_verified_source");
  assert.equal(metric(packet, "nikkei225_futures").value, null);
  assert.ok(!packet.metrics.some((item) => item.label === "TOPIX"));
});

test("stale MIC observation keeps its dated value, is flagged, and makes the packet partial", () => {
  const packet = buildMarketDataPacket(inputs({ micRows: MIC_ROWS }));
  const jgb = metric(packet, "jgb10y");
  assert.equal(jgb.freshness, "stale");
  assert.equal(jgb.gap_reason, "stale_observation");
  assert.equal(jgb.session_date, "2026-08-31");
  assert.equal(jgb.value, 2.943);
  assert.equal(packet.data_quality.status, "partial");
  assert.deepEqual(packet.data_quality.stale, ["jgb2y", "jgb10y"]);
  assert.deepEqual(validateMarketDataPacket(packet), []);
});

test("unavailable optional metric keeps the packet usable as partial", () => {
  const packet = buildMarketDataPacket(inputs({ yahoo: yahooMap({ "^SOX": { ok: false } }) }));
  assert.equal(metric(packet, "sox").freshness, "unavailable");
  assert.equal(metric(packet, "sox").gap_reason, "fetch_failed");
  assert.equal(packet.data_quality.status, "partial");
  assert.deepEqual(packet.data_quality.unavailable, ["sox"]);
  assert.deepEqual(packet.data_quality.required_missing, []);
  assert.deepEqual(validateMarketDataPacket(packet), []);
});

test("missing required close metric (previous-day only) blocks the packet", () => {
  const previousOnly = nikkeiChart("2026-09-15T06:45:00Z", [jpBar("2026-09-14", 63492.99), jpBar("2026-09-15", 63484.1)]);
  const packet = buildMarketDataPacket(inputs({ yahoo: yahooMap({ "^N225": { ok: true, payload: previousOnly } }) }));
  assert.equal(metric(packet, "nikkei225").value, null);
  assert.equal(metric(packet, "nikkei225").gap_reason, "expected_session_not_available");
  assert.equal(packet.data_quality.status, "blocked");
  assert.deepEqual(packet.data_quality.required_missing, ["nikkei225"]);
  assert.deepEqual(validateMarketDataPacket(packet), []);
});

test("missing MIC data blocks on the required USDJPY and marks the source failed", () => {
  const packet = buildMarketDataPacket(inputs({ micRows: null }));
  assert.equal(metric(packet, "usdjpy").gap_reason, "fetch_failed");
  assert.equal(packet.data_quality.status, "blocked");
  assert.ok(packet.data_quality.required_missing.includes("usdjpy"));
  assert.equal(packet.source_summary.find((item) => item.provider === "market_metrics")?.fetch_status, "failed");
});

test("morning packet uses the previous JPX session and has no growth250 slot", () => {
  const morningAsOf = new Date("2026-09-16T22:50:00Z"); // 07:50 JST 9/17
  const packet = buildMarketDataPacket(inputs({
    reportType: "morning",
    tradingDate: "2026-09-17",
    asOf: morningAsOf,
    generatedAt: new Date("2026-09-16T22:50:05Z"),
    yahoo: yahooMap({
      "^DJI": { ok: false }, "^GSPC": { ok: false }, "^IXIC": { ok: false }, "^SOX": { ok: false },
    }),
    newsWindowStart: new Date("2026-09-16T06:30:00Z"),
  }));
  assert.equal(packet.session.jpx_session_date, "2026-09-16");
  assert.equal(packet.session.us_session_date, "2026-09-16");
  assert.equal(metric(packet, "nikkei225").freshness, "fresh");
  assert.equal(metric(packet, "nikkei225").value, 63923);
  assert.ok(!packet.metrics.some((item) => item.key === "growth250"));
  assert.equal(packet.data_quality.status, "partial");
  assert.deepEqual(validateMarketDataPacket(packet), []);
});

test("NYSE calendar beyond coverage is noted", () => {
  const packet = buildMarketDataPacket(inputs({ nyseCalendarLastDate: "2025-12-31" }));
  assert.equal(packet.session.nyse_calendar_covered, false);
  assert.ok(packet.data_quality.notes.includes("nyse_calendar_not_covered"));
});

test("validator rejects guessed values, TOPIX mislabels, credentialed URLs and wrong sessions", () => {
  const good = buildMarketDataPacket(inputs());
  const clone = () => structuredClone(good) as MarketDataPacket;

  const filled = clone();
  metric(filled, "sox").freshness = "unavailable";
  metric(filled, "sox").gap_reason = "fetch_failed";
  assert.ok(validateMarketDataPacket(filled).includes("metrics.sox.unavailable_has_value"));

  const topix = clone();
  metric(topix, "topix_proxy_1306").label = "TOPIX";
  assert.ok(validateMarketDataPacket(topix).includes("metrics.topix_proxy_1306.topix_label"));

  const secret = clone();
  metric(secret, "nikkei225").source_url = "https://example.com/data?apikey=abc";
  assert.ok(validateMarketDataPacket(secret).includes("metrics.nikkei225.source_url"));

  const wrongSession = clone();
  metric(wrongSession, "nikkei225").session_date = "2026-09-15";
  assert.ok(validateMarketDataPacket(wrongSession).includes("metrics.nikkei225.fresh_wrong_session"));

  const quality = clone();
  quality.data_quality.status = "ok";
  metric(quality, "nikkei225").freshness = "unavailable";
  metric(quality, "nikkei225").value = null;
  metric(quality, "nikkei225").previous_close = null;
  metric(quality, "nikkei225").change = null;
  metric(quality, "nikkei225").change_pct = null;
  metric(quality, "nikkei225").gap_reason = "fetch_failed";
  assert.ok(validateMarketDataPacket(quality).includes("data_quality.inconsistent"));

  const closeSession = clone();
  closeSession.session.jpx_session_date = "2026-09-15";
  assert.ok(validateMarketDataPacket(closeSession).includes("session.close_must_use_trading_date"));
});

test("content hash ignores fetch time but changes with facts", async () => {
  const a = buildMarketDataPacket(inputs());
  const later = new Map([...inputs().yahoo].map(([symbol, entry]) => [symbol, { ...entry, fetchedAt: "2026-09-16T07:20:00.000Z" }]));
  const b = buildMarketDataPacket(inputs({ yahoo: later, generatedAt: new Date("2026-09-16T07:20:05Z") }));
  const c = buildMarketDataPacket(inputs({ yahoo: yahooMap({ "^SOX": { ok: false } }) }));
  const hashA = await packetContentHash(a);
  assert.match(hashA, /^[0-9a-f]{64}$/);
  assert.equal(hashA, await packetContentHash(b));
  assert.notEqual(hashA, await packetContentHash(c));
});

test("news refs keep only Fact-passed, non-duplicate, in-window medium+ items, as ids and metadata", () => {
  const row = (overrides: Partial<NewsCandidateRow>): NewsCandidateRow => ({
    id: "00000000-0000-4000-8000-000000000001", source_type: "breaking_market", company_code: null,
    coverage_severity: "high", coverage_categories: ["geopolitics"], emergency_class: null,
    published_at: "2026-09-16T01:00:00Z", created_at: "2026-09-16T01:05:00Z",
    source_url: "https://apnews.com/article/x", fact_check_status: "passed", duplicate_of: null, ...overrides,
  });
  const refs = toNewsRefs([
    row({}),
    row({ id: "dup", duplicate_of: "00000000-0000-4000-8000-000000000001" }),
    row({ id: "low", coverage_severity: "low" }),
    row({ id: "unchecked", fact_check_status: "needs_review" }),
    row({ id: "old", created_at: "2026-09-15T06:00:00Z" }),
    row({ id: "future", created_at: "2026-09-16T08:00:00Z" }),
    row({ id: "secret-url", created_at: "2026-09-16T02:00:00Z", source_url: "https://example.com/?token=abc" }),
  ], AS_OF, NEWS_WINDOW);
  assert.deepEqual(refs.map((ref) => ref.ref_id), ["secret-url", "00000000-0000-4000-8000-000000000001"]);
  assert.equal(refs[0].source_url, null);
  assert.ok(!("title" in refs[1]) && !("headline_ja" in refs[1]));
});
