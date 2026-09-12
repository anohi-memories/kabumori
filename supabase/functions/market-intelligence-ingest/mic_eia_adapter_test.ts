import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEiaSpotPriceUrl,
  EiaAdapterError,
  fetchEiaMetrics,
  normalizeEiaObservation,
  parseEiaResponse,
} from "./mic_eia_adapter.ts";

test("buildEiaSpotPriceUrl shapes the documented v2 petroleum spot-price query", () => {
  // Parameter shape confirmed directly against api.eia.gov during
  // implementation: a key-less request to this exact URL shape returns
  // the documented API_KEY_MISSING error (not a 404), confirming the
  // route/params below are valid.
  const url = new URL(buildEiaSpotPriceUrl("RWTC", "test-key", 3));
  assert.equal(url.origin + url.pathname, "https://api.eia.gov/v2/petroleum/pri/spt/data/");
  assert.equal(url.searchParams.get("api_key"), "test-key");
  assert.equal(url.searchParams.get("frequency"), "daily");
  assert.equal(url.searchParams.get("data[0]"), "value");
  assert.equal(url.searchParams.get("facets[series][]"), "RWTC");
  assert.equal(url.searchParams.get("length"), "3");
});

test("parseEiaResponse extracts well-shaped entries from response.data", () => {
  const payload = { response: { data: [{ period: "2026-09-10", value: "65.12" }, { period: "bad" }] } };
  assert.deepEqual(parseEiaResponse(payload), [{ period: "2026-09-10", value: "65.12" }]);
});

test("parseEiaResponse throws EIA_MALFORMED_RESPONSE when response.data is missing", () => {
  assert.throws(() => parseEiaResponse({ response: {} }), EiaAdapterError);
  assert.throws(() => parseEiaResponse({}), EiaAdapterError);
});

test("normalizeEiaObservation produces an official, delayed metric", () => {
  const metric = normalizeEiaObservation(
    { seriesCode: "RWTC", metricKey: "WTI", unit: "usd_per_barrel" },
    { period: "2026-09-10", value: "65.12" },
    new Date("2026-09-12T00:00:00.000Z"),
  );
  assert.equal(metric.metricKey, "WTI");
  assert.equal(metric.value, 65.12);
  assert.equal(metric.observedDate, "2026-09-10");
  assert.equal(metric.observedAt, null);
  assert.equal(metric.timePrecision, "date");
  assert.equal(metric.sourceKey, "eia");
  assert.equal(metric.isOfficial, true);
});

test("normalizeEiaObservation rejects a non-numeric value", () => {
  assert.throws(
    () =>
      normalizeEiaObservation(
        { seriesCode: "RWTC", metricKey: "WTI", unit: "usd_per_barrel" },
        { period: "2026-09-10", value: "n/a" },
        new Date(),
      ),
    EiaAdapterError,
  );
});

test("normalizeEiaObservation rejects an unexpected period format", () => {
  assert.throws(
    () =>
      normalizeEiaObservation(
        { seriesCode: "RWTC", metricKey: "WTI", unit: "usd_per_barrel" },
        { period: "2026/09/10", value: "65.12" },
        new Date(),
      ),
    EiaAdapterError,
  );
});

test("fetchEiaMetrics: normal path returns one metric per mapping", async () => {
  const fetchImpl = async (url: string | URL) => {
    const seriesCode = new URL(String(url)).searchParams.get("facets[series][]");
    const value = seriesCode === "RWTC" ? "65.12" : "69.40";
    return new Response(JSON.stringify({ response: { data: [{ period: "2026-09-10", value }] } }), { status: 200 });
  };
  const metrics = await fetchEiaMetrics(
    { apiKey: "k", fetchedAt: new Date("2026-09-12T00:00:00.000Z") },
    fetchImpl as typeof fetch,
  );
  assert.equal(metrics.length, 2);
  assert.deepEqual(metrics.map((m) => m.metricKey).sort(), ["BRENT", "WTI"]);
});

test("fetchEiaMetrics: non-200 surfaces EIA_HTTP_ERROR (e.g. 403 API_KEY_MISSING)", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { code: "API_KEY_MISSING" } }), { status: 403 });
  await assert.rejects(() => fetchEiaMetrics({ apiKey: "" }, fetchImpl as typeof fetch), /EIA_HTTP_ERROR/);
});

test("fetchEiaMetrics: a fetch-level failure (timeout) surfaces EIA_FETCH_FAILED", async () => {
  const fetchImpl = async () => {
    throw new DOMException("signal timed out", "TimeoutError");
  };
  await assert.rejects(() => fetchEiaMetrics({ apiKey: "k" }, fetchImpl as typeof fetch), /EIA_FETCH_FAILED/);
});

test("fetchEiaMetrics: an empty data array surfaces EIA_NO_DATA", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ response: { data: [] } }), { status: 200 });
  await assert.rejects(() => fetchEiaMetrics({ apiKey: "k" }, fetchImpl as typeof fetch), /EIA_NO_DATA/);
});
