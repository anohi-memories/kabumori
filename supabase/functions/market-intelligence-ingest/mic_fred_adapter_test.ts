import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFredObservationsUrl,
  FredAdapterError,
  fetchFredMetrics,
  fredObservedAtFromDate,
  latestValidFredObservation,
  normalizeFredObservation,
  parseFredObservations,
} from "./mic_fred_adapter.ts";

test("buildFredObservationsUrl shapes the documented query params", () => {
  const url = new URL(buildFredObservationsUrl("DGS10", "test-key", 3));
  assert.equal(url.origin + url.pathname, "https://api.stlouisfed.org/fred/series/observations");
  assert.equal(url.searchParams.get("series_id"), "DGS10");
  assert.equal(url.searchParams.get("api_key"), "test-key");
  assert.equal(url.searchParams.get("file_type"), "json");
  assert.equal(url.searchParams.get("sort_order"), "desc");
  assert.equal(url.searchParams.get("limit"), "3");
});

test("parseFredObservations extracts only well-shaped entries", () => {
  const payload = { observations: [{ date: "2026-09-10", value: "4.05" }, { date: "bad-entry" }] };
  assert.deepEqual(parseFredObservations(payload), [{ date: "2026-09-10", value: "4.05" }]);
});

test("parseFredObservations throws FRED_MALFORMED_RESPONSE when observations is missing", () => {
  assert.throws(() => parseFredObservations({}), FredAdapterError);
});

test("latestValidFredObservation skips FRED's '.' missing-value marker", () => {
  const observations = [{ date: "2026-09-11", value: "." }, { date: "2026-09-10", value: "4.05" }];
  assert.deepEqual(latestValidFredObservation(observations), { date: "2026-09-10", value: "4.05" });
});

test("latestValidFredObservation returns null when every observation is missing", () => {
  assert.equal(latestValidFredObservation([{ date: "2026-09-11", value: "." }]), null);
});

test("fredObservedAtFromDate anchors to a fixed UTC time for the date", () => {
  assert.equal(fredObservedAtFromDate("2026-09-10"), "2026-09-10T21:00:00.000Z");
});

test("fredObservedAtFromDate rejects a non YYYY-MM-DD date", () => {
  assert.throws(() => fredObservedAtFromDate("09/10/2026"), FredAdapterError);
});

test("normalizeFredObservation produces an official, delayed metric", () => {
  const metric = normalizeFredObservation(
    { seriesId: "DGS10", metricKey: "US10Y", unit: "percent" },
    { date: "2026-09-10", value: "4.05" },
    new Date("2026-09-12T00:00:00.000Z"),
  );
  assert.equal(metric.metricKey, "US10Y");
  assert.equal(metric.value, 4.05);
  assert.equal(metric.sourceKey, "fred");
  assert.equal(metric.isDelayed, true);
  assert.equal(metric.isOfficial, true);
  assert.equal(metric.qualityTier, "official");
});

test("normalizeFredObservation rejects a non-numeric value", () => {
  assert.throws(
    () =>
      normalizeFredObservation(
        { seriesId: "DGS10", metricKey: "US10Y", unit: "percent" },
        { date: "2026-09-10", value: "not-a-number" },
        new Date(),
      ),
    FredAdapterError,
  );
});

test("fetchFredMetrics: normal path returns one metric per mapping", async () => {
  const fetchImpl = async (url: string | URL) => {
    const seriesId = new URL(String(url)).searchParams.get("series_id");
    const value = seriesId === "DGS2" ? "3.60" : "4.05";
    return new Response(JSON.stringify({ observations: [{ date: "2026-09-10", value }] }), { status: 200 });
  };
  const metrics = await fetchFredMetrics(
    { apiKey: "k", fetchedAt: new Date("2026-09-12T00:00:00.000Z") },
    fetchImpl as typeof fetch,
  );
  assert.equal(metrics.length, 2);
  assert.deepEqual(metrics.map((m) => m.metricKey).sort(), ["US10Y", "US2Y"]);
});

test("fetchFredMetrics: malformed response surfaces FRED_MALFORMED_RESPONSE", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ nope: true }), { status: 200 });
  await assert.rejects(() => fetchFredMetrics({ apiKey: "k" }, fetchImpl as typeof fetch), FredAdapterError);
});

test("fetchFredMetrics: non-200 surfaces FRED_HTTP_ERROR", async () => {
  const fetchImpl = async () => new Response("nope", { status: 503 });
  await assert.rejects(
    () => fetchFredMetrics({ apiKey: "k" }, fetchImpl as typeof fetch),
    /FRED_HTTP_ERROR/,
  );
});

test("fetchFredMetrics: a fetch-level failure (e.g. timeout) surfaces FRED_FETCH_FAILED", async () => {
  const fetchImpl = async () => {
    throw new DOMException("signal timed out", "TimeoutError");
  };
  await assert.rejects(
    () => fetchFredMetrics({ apiKey: "k" }, fetchImpl as typeof fetch),
    /FRED_FETCH_FAILED/,
  );
});

test("fetchFredMetrics: every observation missing for a series surfaces FRED_NO_VALID_OBSERVATION", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ observations: [{ date: "2026-09-10", value: "." }] }), { status: 200 });
  await assert.rejects(
    () => fetchFredMetrics({ apiKey: "k" }, fetchImpl as typeof fetch),
    /FRED_NO_VALID_OBSERVATION/,
  );
});
