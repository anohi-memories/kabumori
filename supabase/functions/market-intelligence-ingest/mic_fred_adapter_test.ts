import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFredObservationsUrl,
  FredAdapterError,
  fetchFredMetrics,
  FRED_SERIES_MAPPINGS,
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

// --- Macro Indicators Phase 1A: units parameter ---

test("buildFredObservationsUrl: units omitted entirely when not requested -- existing mappings' URL shape is byte-for-byte unchanged", () => {
  const url = new URL(buildFredObservationsUrl("DGS10", "test-key", 5));
  assert.equal(url.searchParams.has("units"), false);
  assert.equal(url.toString(), "https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=test-key&file_type=json&sort_order=desc&limit=5");
});

test("buildFredObservationsUrl: units=pc1 (year-over-year %) is passed through verbatim", () => {
  const url = new URL(buildFredObservationsUrl("CPIAUCSL", "test-key", 5, "pc1"));
  assert.equal(url.searchParams.get("units"), "pc1");
  assert.equal(url.searchParams.get("series_id"), "CPIAUCSL");
});

test("buildFredObservationsUrl: units=chg (period change) is passed through verbatim", () => {
  const url = new URL(buildFredObservationsUrl("PAYEMS", "test-key", 5, "chg"));
  assert.equal(url.searchParams.get("units"), "chg");
});

test("buildFredObservationsUrl: units=pch (percent change from prior period) is passed through verbatim", () => {
  const url = new URL(buildFredObservationsUrl("RSAFS", "test-key", 5, "pch"));
  assert.equal(url.searchParams.get("units"), "pch");
});

test("fetchFredMetrics: the same seriesId can be fetched twice under two different metric_keys/units, and each request URL carries the right units param", async () => {
  const requestedUrls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    requestedUrls.push(String(url));
    const parsed = new URL(String(url));
    const units = parsed.searchParams.get("units");
    const value = units === "pc1" ? "3.10" : "313.53"; // YoY% vs index level
    return new Response(JSON.stringify({ observations: [{ date: "2026-08-01", value } ] }), { status: 200 });
  };
  const metrics = await fetchFredMetrics(
    {
      apiKey: "k",
      fetchedAt: new Date("2026-09-17T00:00:00.000Z"),
      mappings: [
        { seriesId: "CPIAUCSL", metricKey: "US_CPI", unit: "cpi_index_1982_84_100" },
        { seriesId: "CPIAUCSL", metricKey: "US_CPI_YOY", unit: "percent", units: "pc1" },
      ],
    },
    fetchImpl as typeof fetch,
  );
  assert.equal(metrics.length, 2);
  assert.equal(requestedUrls.length, 2);
  assert.ok(requestedUrls[0].includes("series_id=CPIAUCSL") && !requestedUrls[0].includes("units="));
  assert.ok(requestedUrls[1].includes("series_id=CPIAUCSL") && requestedUrls[1].includes("units=pc1"));
  const level = metrics.find((m) => m.metricKey === "US_CPI");
  const yoy = metrics.find((m) => m.metricKey === "US_CPI_YOY");
  assert.equal(level?.value, 313.53);
  assert.equal(yoy?.value, 3.10);
  assert.equal(level?.metadata?.fredUnits, undefined, "raw mapping must not carry a fredUnits key");
  assert.equal(yoy?.metadata?.fredUnits, "pc1");
});

// --- Macro Indicators Phase 1A: provenance ---

test("normalizeFredObservation: a raw macro mapping (no units) keeps metadata shape identical to the existing US2Y/US10Y/equity-index pattern (no fredUnits key)", () => {
  const metric = normalizeFredObservation(
    { seriesId: "GDPC1", metricKey: "US_GDP", unit: "billions_of_chained_2017_dollars", underlyingSource: "U.S. Bureau of Economic Analysis" },
    { date: "2026-04-01", value: "24269.613" },
    new Date("2026-09-17T00:00:00.000Z"),
  );
  assert.deepEqual(metric.metadata, {
    seriesId: "GDPC1",
    fredDate: "2026-04-01",
    underlyingSource: "U.S. Bureau of Economic Analysis",
  });
});

test("normalizeFredObservation: a derived macro mapping (units set) carries seriesId + fredUnits + underlyingSource + fredDate in metadata", () => {
  const metric = normalizeFredObservation(
    {
      seriesId: "A191RL1Q225SBEA",
      metricKey: "US_GDP_GROWTH",
      unit: "percent_annualized",
      underlyingSource: "U.S. Bureau of Economic Analysis",
    },
    { date: "2026-04-01", value: "1.5" },
    new Date("2026-09-17T00:00:00.000Z"),
  );
  // US_GDP_GROWTH is its own distinct FRED series (not a units= transform
  // of GDPC1), so it legitimately has no `units` on its mapping -- confirm
  // that "no units field on the mapping" still produces provenance-correct
  // metadata (seriesId/fredDate/underlyingSource), distinguishing "this
  // series IS the growth rate" from "this is a units= transform of a level
  // series" without conflating the two.
  assert.deepEqual(metric.metadata, {
    seriesId: "A191RL1Q225SBEA",
    fredDate: "2026-04-01",
    underlyingSource: "U.S. Bureau of Economic Analysis",
  });

  const derived = normalizeFredObservation(
    {
      seriesId: "PAYEMS",
      metricKey: "US_NFP_CHANGE",
      unit: "thousands_of_persons",
      underlyingSource: "U.S. Bureau of Labor Statistics",
      units: "chg",
    },
    { date: "2026-08-01", value: "142" },
    new Date("2026-09-17T00:00:00.000Z"),
  );
  assert.deepEqual(derived.metadata, {
    seriesId: "PAYEMS",
    fredDate: "2026-08-01",
    underlyingSource: "U.S. Bureau of Labor Statistics",
    fredUnits: "chg",
  });
  assert.equal(derived.provider, "FRED", "provider is always FRED regardless of units transform");
});

// --- Macro Indicators Phase 1A: precision (no fabricated intraday time) ---

test("normalizeFredObservation: every macro mapping produces observedAt=null and time_precision='date', including derived (units=) mappings", () => {
  const raw = normalizeFredObservation(
    { seriesId: "UNRATE", metricKey: "US_UNEMPLOYMENT_RATE", unit: "percent" },
    { date: "2026-08-01", value: "4.1" },
    new Date("2026-09-17T00:00:00.000Z"),
  );
  const derived = normalizeFredObservation(
    { seriesId: "RSAFS", metricKey: "US_RETAIL_SALES_MOM", unit: "percent", units: "pch" },
    { date: "2026-08-01", value: "0.6" },
    new Date("2026-09-17T00:00:00.000Z"),
  );
  for (const metric of [raw, derived]) {
    assert.equal(metric.observedAt, null);
    assert.equal(metric.timePrecision, "date");
    assert.equal(metric.observedDate, "2026-08-01");
  }
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

test("fetchFredMetrics: 7 non-macro mappings (US2Y/US10Y + 5 equity index) return one metric each", async () => {
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
    {
      apiKey: "k",
      fetchedAt: new Date("2026-09-17T00:00:00.000Z"),
      mappings: [
        { seriesId: "DGS2", metricKey: "US2Y", unit: "percent" },
        { seriesId: "DGS10", metricKey: "US10Y", unit: "percent" },
        { seriesId: "NIKKEI225", metricKey: "NIKKEI225", unit: "index_points" },
        { seriesId: "SP500", metricKey: "SP500", unit: "index_points" },
        { seriesId: "NASDAQCOM", metricKey: "NASDAQCOMPOSITE", unit: "index_points" },
        { seriesId: "NASDAQ100", metricKey: "NASDAQ100", unit: "index_points" },
        { seriesId: "VIXCLS", metricKey: "VIX", unit: "index_points" },
      ],
    },
    fetchImpl as typeof fetch,
  );
  assert.equal(metrics.length, 7);
  assert.deepEqual(
    metrics.map((m) => m.metricKey).sort(),
    ["NASDAQ100", "NASDAQCOMPOSITE", "NIKKEI225", "SP500", "US10Y", "US2Y", "VIX"],
  );
  assert.ok(metrics.every((m) => m.observedAt === null && m.timePrecision === "date"));
});

test("FRED_SERIES_MAPPINGS: default export now has 23 entries (7 pre-macro + 16 Macro Indicators Phase 1A)", () => {
  assert.equal(FRED_SERIES_MAPPINGS.length, 23);
  const macroKeys = FRED_SERIES_MAPPINGS.filter((m) =>
    m.metricKey.startsWith("US_") || m.metricKey === "JP_GDP"
  ).map((m) => m.metricKey);
  assert.deepEqual(
    macroKeys.sort(),
    [
      "US_CORE_CPI",
      "US_CORE_CPI_YOY",
      "US_CORE_PCE",
      "US_CORE_PCE_YOY",
      "US_CPI",
      "US_CPI_YOY",
      "US_GDP",
      "US_GDP_GROWTH",
      "US_NFP",
      "US_NFP_CHANGE",
      "US_PCE",
      "US_PCE_YOY",
      "US_RETAIL_SALES",
      "US_RETAIL_SALES_MOM",
      "US_UNEMPLOYMENT_RATE",
      "JP_GDP",
    ].sort(),
  );
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
