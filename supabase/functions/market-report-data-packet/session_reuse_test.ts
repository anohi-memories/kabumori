import assert from "node:assert/strict";
import test from "node:test";
import { buildMarketDataPacket, type PacketInputs } from "./packet_builder.ts";
import { type MarketDataPacket, type Metric, validateMarketDataPacket } from "./packet_schema.ts";
import { applySessionReuse, buildReuseIndex, type StoredPacketRow } from "./session_reuse.ts";
import { CLOSE_0916, JPX_HOLIDAYS, MIC_ROWS, MIC_THRESHOLDS, NYSE_HOLIDAYS, nikkeiChart, jpBar } from "./test_fixtures.ts";

const HASH = "a".repeat(64);
const FRESH_MIC = MIC_ROWS.map((row) => row.metric_key.startsWith("JGB") ? { ...row, observed_date: "2026-09-15" } : row);

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

function inputs(overrides: Partial<PacketInputs> = {}): PacketInputs {
  return {
    reportType: "close",
    tradingDate: "2026-09-16",
    asOf: new Date("2026-09-16T07:15:00Z"),
    generatedAt: new Date("2026-09-16T07:15:04Z"),
    jpxHolidays: JPX_HOLIDAYS,
    nyseHolidays: NYSE_HOLIDAYS,
    nyseCalendarLastDate: "2026-12-31",
    yahoo: yahooMap(),
    micRows: FRESH_MIC,
    micThresholds: MIC_THRESHOLDS,
    newsRows: [],
    newsWindowStart: new Date("2026-09-15T06:30:00Z"),
    ...overrides,
  };
}

const metric = (packet: MarketDataPacket, key: string) => packet.metrics.find((item) => item.key === key)!;

/** A stored packet whose nikkei225 value for 2026-09-16 is confirmed. */
function storedPacket(overrides: Partial<StoredPacketRow> = {}, metricOverrides: Partial<Metric> = {}): StoredPacketRow {
  const source = metric(buildMarketDataPacket(inputs()), "nikkei225");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    content_hash: HASH,
    data_quality_status: "partial",
    payload: { metrics: [{ ...source, ...metricOverrides }] },
    ...overrides,
  };
}

/** Yahoo lost the 2026-09-16 close: the bar is there with a null value. */
const LOST_SESSION = nikkeiChart("2026-09-17T04:49:00Z", [
  jpBar("2026-09-15", 63484.1), jpBar("2026-09-16", null), jpBar("2026-09-17", 64160.72),
]);

test("a live Yahoo value is always preferred over a stored one", () => {
  const stored = storedPacket({}, { value: 99999 });
  const packet = buildMarketDataPacket(inputs({ storedPackets: [stored] }));
  assert.equal(metric(packet, "nikkei225").value, 63923);
  assert.equal(metric(packet, "nikkei225").provider, "yahoo_chart");
  assert.equal(metric(packet, "nikkei225").reused_from, undefined);
  assert.deepEqual(packet.data_quality.reused, []);
});

test("a lost session is filled from the stored packet of the same session, with lineage", () => {
  const packet = buildMarketDataPacket(inputs({
    yahoo: yahooMap({ "^N225": { ok: true, payload: LOST_SESSION } }),
    storedPackets: [storedPacket()],
  }));
  const nikkei = metric(packet, "nikkei225");
  assert.equal(nikkei.value, 63923);
  assert.equal(nikkei.session_date, "2026-09-16");
  assert.equal(nikkei.freshness, "fresh");
  assert.equal(nikkei.gap_reason, null);
  assert.equal(nikkei.provider, "market_data_packet");
  assert.deepEqual(nikkei.reused_from, {
    data_packet_id: "11111111-1111-4111-8111-111111111111",
    content_hash: HASH,
    session_date: "2026-09-16",
    provider: "yahoo_chart",
    observed_at: "2026-09-16T06:45:00.000Z",
  });
  assert.deepEqual(packet.data_quality.required_missing, []);
  assert.deepEqual(packet.data_quality.reused, ["nikkei225"]);
  assert.equal(packet.data_quality.status, "ok");
  assert.deepEqual(validateMarketDataPacket(packet), []);
});

test("a fetch failure is also fillable, but a session that has not closed yet is not", () => {
  const fetchFailed = buildMarketDataPacket(inputs({
    yahoo: yahooMap({ "^N225": { ok: false } }),
    storedPackets: [storedPacket()],
  }));
  assert.equal(metric(fetchFailed, "nikkei225").value, 63923);
  assert.deepEqual(fetchFailed.data_quality.reused, ["nikkei225"]);

  // 2026-09-17 intraday: the close does not exist anywhere yet, so nothing may fill it.
  const intraday = nikkeiChart("2026-09-17T04:49:00Z", [jpBar("2026-09-16", 63923), jpBar("2026-09-17", 64160.72)]);
  const notClosed = buildMarketDataPacket(inputs({
    tradingDate: "2026-09-17",
    asOf: new Date("2026-09-17T07:15:00Z"),
    generatedAt: new Date("2026-09-17T07:15:04Z"),
    newsWindowStart: new Date("2026-09-16T06:30:00Z"),
    yahoo: yahooMap({ "^N225": { ok: true, payload: intraday } }),
    storedPackets: [storedPacket()],
  }));
  assert.equal(metric(notClosed, "nikkei225").gap_reason, "session_not_closed");
  assert.equal(metric(notClosed, "nikkei225").value, null);
  // 1306 has no 2026-09-17 bar in the fixture either; neither may be filled from another session.
  assert.deepEqual(notClosed.data_quality.required_missing, ["nikkei225", "topix_proxy_1306"]);
  assert.deepEqual(notClosed.data_quality.reused, []);
});

test("a stored value from another session, a blocked packet or a stale value is never reused", () => {
  const otherSession = buildMarketDataPacket(inputs({
    yahoo: yahooMap({ "^N225": { ok: true, payload: LOST_SESSION } }),
    storedPackets: [storedPacket({}, { session_date: "2026-09-15", expected_session_date: "2026-09-15" })],
  }));
  assert.equal(metric(otherSession, "nikkei225").value, null);
  assert.equal(metric(otherSession, "nikkei225").gap_reason, "expected_session_not_available");

  const blockedSource = buildMarketDataPacket(inputs({
    yahoo: yahooMap({ "^N225": { ok: true, payload: LOST_SESSION } }),
    storedPackets: [storedPacket({ data_quality_status: "blocked" })],
  }));
  assert.equal(blockedSource.data_quality.status, "blocked");
  assert.deepEqual(blockedSource.data_quality.reused, []);

  const staleSource = buildMarketDataPacket(inputs({
    yahoo: yahooMap({ "^N225": { ok: true, payload: LOST_SESSION } }),
    storedPackets: [storedPacket({}, { freshness: "stale", gap_reason: "stale_observation" })],
  }));
  assert.deepEqual(staleSource.data_quality.reused, []);

  const reusedSource = buildMarketDataPacket(inputs({
    yahoo: yahooMap({ "^N225": { ok: true, payload: LOST_SESSION } }),
    storedPackets: [storedPacket({}, {
      reused_from: { data_packet_id: "x", content_hash: HASH, session_date: "2026-09-16", provider: "yahoo_chart", observed_at: null },
    })],
  }));
  assert.deepEqual(reusedSource.data_quality.reused, [], "a reuse is never chained");
});

test("the newest stored packet wins and nothing is invented", () => {
  const older = storedPacket({ id: "22222222-2222-4222-8222-222222222222", content_hash: "b".repeat(64) }, { value: 111 });
  const newer = storedPacket();
  const index = buildReuseIndex([newer, older]);
  assert.equal(index.get("nikkei225@2026-09-16")!.value.value, 63923);
  assert.equal(index.size, 1);

  // No candidate: the metric is returned untouched.
  const untouched = metric(buildMarketDataPacket(inputs({ yahoo: yahooMap({ "^N225": { ok: true, payload: LOST_SESSION } }) })), "nikkei225");
  assert.equal(applySessionReuse(untouched, new Map()), untouched);
  assert.equal(untouched.value, null);
});

test("validator rejects a reuse without matching session or lineage", () => {
  const packet = buildMarketDataPacket(inputs({
    yahoo: yahooMap({ "^N225": { ok: true, payload: LOST_SESSION } }),
    storedPackets: [storedPacket()],
  }));
  const wrongSession = structuredClone(packet) as MarketDataPacket;
  metric(wrongSession, "nikkei225").reused_from!.session_date = "2026-09-15";
  assert.ok(validateMarketDataPacket(wrongSession).includes("metrics.nikkei225.reuse_session_mismatch"));

  const badHash = structuredClone(packet) as MarketDataPacket;
  metric(badHash, "nikkei225").reused_from!.content_hash = "nope";
  assert.ok(validateMarketDataPacket(badHash).includes("metrics.nikkei225.reuse_lineage"));

  const wrongProvider = structuredClone(packet) as MarketDataPacket;
  metric(wrongProvider, "nikkei225").provider = "yahoo_chart";
  assert.ok(validateMarketDataPacket(wrongProvider).includes("metrics.nikkei225.reuse_provider"));
});

test("close path regression: a normal close is unaffected by the reuse code", () => {
  const withStored = buildMarketDataPacket(inputs({ storedPackets: [storedPacket()] }));
  const withoutStored = buildMarketDataPacket(inputs());
  assert.deepEqual(withStored.metrics, withoutStored.metrics);
  assert.equal(withStored.data_quality.status, "ok");
  assert.deepEqual(validateMarketDataPacket(withStored), []);
});
