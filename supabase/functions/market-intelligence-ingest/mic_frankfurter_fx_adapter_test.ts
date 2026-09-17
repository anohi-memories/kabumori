import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFrankfurterUrl,
  FrankfurterAdapterError,
  fetchFrankfurterFxMetrics,
  normalizeFrankfurterObservation,
  parseFrankfurterResponse,
} from "./mic_frankfurter_fx_adapter.ts";

test("buildFrankfurterUrl shapes the documented latest-rate query", () => {
  // Endpoint/params confirmed directly against api.frankfurter.dev during
  // implementation: base=USD&symbols=JPY returned a well-formed response.
  const url = new URL(buildFrankfurterUrl("USD", "JPY"));
  assert.equal(url.origin + url.pathname, "https://api.frankfurter.dev/v1/latest");
  assert.equal(url.searchParams.get("base"), "USD");
  assert.equal(url.searchParams.get("symbols"), "JPY");
});

test("parseFrankfurterResponse extracts a well-shaped response", () => {
  const payload = { amount: 1, base: "USD", date: "2026-09-16", rates: { JPY: 155.05 } };
  assert.deepEqual(parseFrankfurterResponse(payload), payload);
});

test("parseFrankfurterResponse throws FRANKFURTER_MALFORMED_RESPONSE when date is missing", () => {
  assert.throws(() => parseFrankfurterResponse({ base: "USD", rates: { JPY: 155.05 } }), FrankfurterAdapterError);
});

test("parseFrankfurterResponse throws FRANKFURTER_MALFORMED_RESPONSE when rates is missing", () => {
  assert.throws(() => parseFrankfurterResponse({ base: "USD", date: "2026-09-16" }), FrankfurterAdapterError);
});

test("parseFrankfurterResponse throws FRANKFURTER_MALFORMED_RESPONSE on a non-object payload", () => {
  assert.throws(() => parseFrankfurterResponse(null), FrankfurterAdapterError);
  assert.throws(() => parseFrankfurterResponse("not an object"), FrankfurterAdapterError);
});

test("normalizeFrankfurterObservation produces a trusted_free, non-official, delayed metric with provenance", () => {
  const metric = normalizeFrankfurterObservation(
    { base: "USD", symbol: "JPY", metricKey: "USDJPY", unit: "JPY_per_USD" },
    { amount: 1, base: "USD", date: "2026-09-16", rates: { JPY: 155.05 } },
    new Date("2026-09-17T00:00:00.000Z"),
  );
  assert.equal(metric.metricKey, "USDJPY");
  assert.equal(metric.value, 155.05);
  assert.equal(metric.unit, "JPY_per_USD");
  assert.equal(metric.observedDate, "2026-09-16");
  assert.equal(metric.observedAt, null, "date-precision source must never get a fabricated time");
  assert.equal(metric.timePrecision, "date");
  assert.equal(metric.sourceKey, "frankfurter");
  assert.equal(metric.provider, "Frankfurter");
  assert.equal(metric.qualityTier, "trusted_free");
  assert.equal(metric.isOfficial, false, "USD/JPY here is a EUR-derived cross-rate, not a direct one-source quote");
  assert.equal(metric.isDelayed, true);
  assert.match(metric.sourceUrl ?? "", /api\.frankfurter\.dev/);
  assert.equal(metric.metadata?.underlyingSource, "ECB reference rates (via Frankfurter)");
  assert.equal(metric.metadata?.base, "USD");
  assert.equal(metric.metadata?.symbol, "JPY");
});

test("normalizeFrankfurterObservation rejects a missing rate for the requested symbol", () => {
  assert.throws(
    () =>
      normalizeFrankfurterObservation(
        { base: "USD", symbol: "JPY", metricKey: "USDJPY", unit: "JPY_per_USD" },
        { amount: 1, base: "USD", date: "2026-09-16", rates: { GBP: 0.79 } },
        new Date(),
      ),
    FrankfurterAdapterError,
  );
});

test("normalizeFrankfurterObservation rejects a non-numeric rate", () => {
  assert.throws(
    () =>
      normalizeFrankfurterObservation(
        { base: "USD", symbol: "JPY", metricKey: "USDJPY", unit: "JPY_per_USD" },
        { amount: 1, base: "USD", date: "2026-09-16", rates: { JPY: "n/a" as unknown as number } },
        new Date(),
      ),
    FrankfurterAdapterError,
  );
});

test("normalizeFrankfurterObservation rejects an unexpected date format", () => {
  assert.throws(
    () =>
      normalizeFrankfurterObservation(
        { base: "USD", symbol: "JPY", metricKey: "USDJPY", unit: "JPY_per_USD" },
        { amount: 1, base: "USD", date: "2026/09/16", rates: { JPY: 155.05 } },
        new Date(),
      ),
    FrankfurterAdapterError,
  );
});

test("fetchFrankfurterFxMetrics: normal path returns one metric per mapping", async () => {
  const fetchImpl = async (url: string | URL) => {
    const symbol = new URL(String(url)).searchParams.get("symbols");
    return new Response(
      JSON.stringify({ amount: 1, base: "USD", date: "2026-09-16", rates: { [symbol ?? "JPY"]: 155.05 } }),
      { status: 200 },
    );
  };
  const metrics = await fetchFrankfurterFxMetrics(
    { fetchedAt: new Date("2026-09-17T00:00:00.000Z") },
    fetchImpl as typeof fetch,
  );
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].metricKey, "USDJPY");
  assert.equal(metrics[0].value, 155.05);
});

test("fetchFrankfurterFxMetrics: non-200 surfaces FRANKFURTER_HTTP_ERROR", async () => {
  const fetchImpl = async () => new Response("bad gateway", { status: 502 });
  await assert.rejects(() => fetchFrankfurterFxMetrics({}, fetchImpl as typeof fetch), /FRANKFURTER_HTTP_ERROR/);
});

test("fetchFrankfurterFxMetrics: a fetch-level failure (timeout) surfaces FRANKFURTER_FETCH_FAILED", async () => {
  const fetchImpl = async () => {
    throw new DOMException("signal timed out", "TimeoutError");
  };
  await assert.rejects(() => fetchFrankfurterFxMetrics({}, fetchImpl as typeof fetch), /FRANKFURTER_FETCH_FAILED/);
});

test("fetchFrankfurterFxMetrics: malformed JSON surfaces FRANKFURTER_MALFORMED_RESPONSE", async () => {
  const fetchImpl = async () => new Response("not json", { status: 200 });
  await assert.rejects(
    () => fetchFrankfurterFxMetrics({}, fetchImpl as typeof fetch),
    /FRANKFURTER_MALFORMED_RESPONSE/,
  );
});

test("fetchFrankfurterFxMetrics: a response missing the requested symbol surfaces FRANKFURTER_MISSING_RATE", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ amount: 1, base: "USD", date: "2026-09-16", rates: {} }), { status: 200 });
  await assert.rejects(() => fetchFrankfurterFxMetrics({}, fetchImpl as typeof fetch), /FRANKFURTER_MISSING_RATE/);
});
