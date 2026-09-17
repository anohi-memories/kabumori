import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFredObservationsUrl,
  FredAdapterError,
  fetchFredMetrics,
  latestValidFredObservation,
  normalizeFredObservation,
  parseFredObservations,
  validateFredObservationDate,
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

test("validateFredObservationDate returns the date unchanged -- never fabricates a time of day", () => {
  assert.equal(validateFredObservationDate("2026-09-10"), "2026-09-10");
});

test("validateFredObservationDate rejects a non YYYY-MM-DD date", () => {
  assert.throws(() => validateFredObservationDate("09/10/2026"), FredAdapterError);
});

test("normalizeFredObservation produces an official, delayed, date-precision metric with no fabricated time", () => {
  const metric = normalizeFredObservation(
    { seriesId: "DGS10", metricKey: "US10Y", unit: "percent" },
    { date: "2026-09-10", value: "4.05" },
    new Date("2026-09-12T00:00:00.000Z"),
  );
  assert.equal(metric.metricKey, "US10Y");
  assert.equal(metric.value, 4.05);
  assert.equal(metric.observedDate, "2026-09-10");
  assert.equal(metric.observedAt, null);
  assert.equal(metric.timePrecision, "date");
  assert.equal(metric.sourceKey, "fred");
  assert.equal(metric.isDelayed, true);
  assert.equal(metric.isOfficial, true);
  assert.equal(metric.qualityTier, "official");
});

// --- Equity Index Phase 1: NIKKEI225/SP500/NASDAQCOM/NASDAQ100/VIXCLS ---

test("normalizeFredObservation: NIKKEI225 -> metricKey NIKKEI225, unit index_points, provenance names Nikkei as underlying source", () => {
  const metric = normalizeFredObservation(
    { seriesId: "NIKKEI225", metricKey: "NIKKEI225", unit: "index_points", underlyingSource: "Nikkei Industry Research Institute" },
    { date: "2026-09-16", value: "44800.12" },
    new Date("2026-09-17T00:00:00.000Z"),
  );
  assert.equal(metric.metricKey, "NIKKEI225");
  assert.equal(metric.value, 44800.12);
  assert.equal(metric.unit, "index_points");
  assert.equal(metric.observedDate, "2026-09-16");
  assert.equal(metric.observedAt, null, "date-precision source must never get a fabricated time");
  assert.equal(metric.timePrecision, "date");
  assert.equal(metric.provider, "FRED");
  assert.equal(metric.isDelayed, true);
  assert.equal(metric.metadata?.underlyingSource, "Nikkei Industry Research Institute");
  assert.equal(metric.metadata?.seriesId, "NIKKEI225");
});

test("normalizeFredObservation: SP500 -> metricKey SP500, underlying source is S&P Dow Jones Indices LLC", () => {
  const metric = normalizeFredObservation(
    { seriesId: "SP500", metricKey: "SP500", unit: "index_points", underlyingSource: "S&P Dow Jones Indices LLC" },
    { date: "2026-09-16", value: "7551.81" },
    new Date("2026-09-17T00:00:00.000Z"),
  );
  assert.equal(metric.metricKey, "SP500");
  assert.equal(metric.unit, "index_points");
  assert.equal(metric.observedAt, null);
  assert.equal(metric.timePrecision, "date");
  assert.equal(metric.metadata?.underlyingSource, "S&P Dow Jones Indices LLC");
});

test("normalizeFredObservation: NASDAQCOM series maps to metricKey NASDAQCOMPOSITE (not NASDAQ100)", () => {
  const metric = normalizeFredObservation(
    { seriesId: "NASDAQCOM", metricKey: "NASDAQCOMPOSITE", unit: "index_points", underlyingSource: "Nasdaq, Inc." },
    { date: "2026-09-16", value: "22345.6" },
    new Date("2026-09-17T00:00:00.000Z"),
  );
  assert.equal(metric.metricKey, "NASDAQCOMPOSITE");
  assert.equal(metric.metadata?.seriesId, "NASDAQCOM");
  assert.equal(metric.metadata?.underlyingSource, "Nasdaq, Inc.");
});

test("normalizeFredObservation: NASDAQ100 is a distinct metric from NASDAQCOMPOSITE", () => {
  const metric = normalizeFredObservation(
    { seriesId: "NASDAQ100", metricKey: "NASDAQ100", unit: "index_points", underlyingSource: "Nasdaq, Inc." },
    { date: "2026-09-16", value: "24567.8" },
    new Date("2026-09-17T00:00:00.000Z"),
  );
  assert.equal(metric.metricKey, "NASDAQ100");
  assert.notEqual(metric.metricKey, "NASDAQCOMPOSITE");
});

test("normalizeFredObservation: VIXCLS series maps to metricKey VIX, underlying source is CBOE", () => {
  const metric = normalizeFredObservation(
    { seriesId: "VIXCLS", metricKey: "VIX", unit: "index_points", underlyingSource: "Chicago Board Options Exchange (CBOE)" },
    { date: "2026-09-15", value: "17.20" },
    new Date("2026-09-17T00:00:00.000Z"),
  );
  assert.equal(metric.metricKey, "VIX");
  assert.equal(metric.value, 17.20);
  assert.equal(metric.metadata?.underlyingSource, "Chicago Board Options Exchange (CBOE)");
});

test("normalizeFredObservation: US2Y/US10Y metadata is unchanged (no underlyingSource key) -- existing behavior preserved", () => {
  const metric = normalizeFredObservation(
    { seriesId: "DGS10", metricKey: "US10Y", unit: "percent" },
    { date: "2026-09-10", value: "4.05" },
    new Date("2026-09-12T00:00:00.000Z"),
  );
  assert.deepEqual(metric.metadata, { seriesId: "DGS10", fredDate: "2026-09-10" });
});

test("normalizeFredObservation: equity index series still rejects a non-numeric value", () => {
  assert.throws(
    () =>
      normalizeFredObservation(
        { seriesId: "VIXCLS", metricKey: "VIX", unit: "index_points" },
        { date: "2026-09-15", value: "." },
        new Date(),
      ),
    FredAdapterError,
  );
});

test("fetchFredMetrics: all 7 mappings (US2Y/US10Y + 5 equity index) return one metric each", async () => {
  const fetchImpl = async (url: string | URL) => {
    const seriesId = new URL(String(url)).searchParams.get("series_id");
    const values: Record<string, string> = {
      DGS2: "3.60",
      DGS10: "4.05",
      NIKKEI225: "44800.12",
      SP500: "7551.81",
      NASDAQCOM: "22345.6",
      NASDAQ100: "24567.8",
      VIXCLS: "17.20",
    };
    return new Response(JSON.stringify({ observations: [{ date: "2026-09-16", value: values[seriesId ?? ""] }] }), { status: 200 });
  };
  const metrics = await fetchFredMetrics(
    { apiKey: "k", fetchedAt: new Date("2026-09-17T00:00:00.000Z") },
    fetchImpl as typeof fetch,
  );
  assert.equal(metrics.length, 7);
  assert.deepEqual(
    metrics.map((m) => m.metricKey).sort(),
    ["NASDAQ100", "NASDAQCOMPOSITE", "NIKKEI225", "SP500", "US10Y", "US2Y", "VIX"],
  );
  assert.ok(metrics.every((m) => m.observedAt === null && m.timePrecision === "date"));
});

test("fetchFredMetrics: a missing observation for one equity index series surfaces FRED_NO_VALID_OBSERVATION for that series only", async () => {
  const fetchImpl = async (url: string | URL) => {
    const seriesId = new URL(String(url)).searchParams.get("series_id");
    if (seriesId === "VIXCLS") {
      return new Response(JSON.stringify({ observations: [{ date: "2026-09-16", value: "." }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ observations: [{ date: "2026-09-16", value: "1.0" }] }), { status: 200 });
  };
  await assert.rejects(
    () => fetchFredMetrics({ apiKey: "k", mappings: [{ seriesId: "VIXCLS", metricKey: "VIX", unit: "index_points" }] }, fetchImpl as typeof fetch),
    /FRED_NO_VALID_OBSERVATION/,
  );
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
    {
      apiKey: "k",
      fetchedAt: new Date("2026-09-12T00:00:00.000Z"),
      mappings: [
        { seriesId: "DGS2", metricKey: "US2Y", unit: "percent" },
        { seriesId: "DGS10", metricKey: "US10Y", unit: "percent" },
      ],
    },
    fetchImpl as typeof fetch,
  );
  assert.equal(metrics.length, 2);
  assert.deepEqual(metrics.map((m) => m.metricKey).sort(), ["US10Y", "US2Y"]);
  assert.ok(metrics.every((m) => m.observedDate === "2026-09-10" && m.observedAt === null && m.timePrecision === "date"));
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
