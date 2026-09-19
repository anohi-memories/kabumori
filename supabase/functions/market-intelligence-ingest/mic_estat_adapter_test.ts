import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEstatStatsDataUrl,
  ESTAT_AREA_CODE,
  ESTAT_CPI_CATEGORY_MAPPINGS,
  ESTAT_SOURCE_KEY,
  ESTAT_STATS_DATA_ID,
  ESTAT_TAB_INDEX,
  ESTAT_TAB_YOY,
  EstatAdapterError,
  fetchEstatCpiMetrics,
  normalizeEstatObservation,
  parseEstatGetStatsDataResponse,
  parseEstatTimeCode,
  selectLatestEstatObservations,
} from "./mic_estat_adapter.ts";

// A realistic fixture mirroring the confirmed live response shape for
// statsDataId=0004052037: 全国 (00000) + 東京都区部 (13100, a decoy region
// that must be excluded), cat01 0001 (総合) and 0161 (生鮮食品を除く総合)
// plus a decoy 0166 (持家の帰属家賃及び生鮮食品を除く総合, must be
// excluded), tab 1 (指数)/2 (前月比等, unused)/3 (前年同月比), two
// consecutive months (2026-07, 2026-08) to exercise "latest wins".
function fixtureValueRows() {
  return [
    // --- 全国, 0001 総合, 2026-07 (older) ---
    { "@tab": "1", "@cat01": "0001", "@area": "00000", "@time": "2026000707", "@unit": "", "$": "102.0" },
    { "@tab": "3", "@cat01": "0001", "@area": "00000", "@time": "2026000707", "@unit": "%", "$": "1.8" },
    // --- 全国, 0001 総合, 2026-08 (latest) ---
    { "@tab": "1", "@cat01": "0001", "@area": "00000", "@time": "2026000808", "@unit": "", "$": "102.2" },
    { "@tab": "2", "@cat01": "0001", "@area": "00000", "@time": "2026000808", "@unit": "%", "$": "0.1" },
    { "@tab": "3", "@cat01": "0001", "@area": "00000", "@time": "2026000808", "@unit": "%", "$": "1.9" },
    // --- 全国, 0161 生鮮食品を除く総合, 2026-08 ---
    { "@tab": "1", "@cat01": "0161", "@area": "00000", "@time": "2026000808", "@unit": "", "$": "102.0" },
    { "@tab": "3", "@cat01": "0161", "@area": "00000", "@time": "2026000808", "@unit": "%", "$": "1.7", "@annotation": "J1" },
    // --- decoy: 東京都区部 (13100), must never be picked ---
    { "@tab": "1", "@cat01": "0001", "@area": "13100", "@time": "2026000808", "@unit": "", "$": "999.9" },
    { "@tab": "3", "@cat01": "0001", "@area": "13100", "@time": "2026000808", "@unit": "%", "$": "99.9" },
    // --- decoy: 0166 持家の帰属家賃及び生鮮食品を除く総合, must never be picked ---
    { "@tab": "1", "@cat01": "0166", "@area": "00000", "@time": "2026000808", "@unit": "", "$": "888.8" },
    { "@tab": "3", "@cat01": "0166", "@area": "00000", "@time": "2026000808", "@unit": "%", "$": "88.8" },
    // --- suppressed/missing value for 0161 index at 2026-07 (must be skipped, not crash) ---
    { "@tab": "1", "@cat01": "0161", "@area": "00000", "@time": "2026000707", "@unit": "", "$": "-" },
  ];
}

function fixtureResponse(overrides: Partial<{ status: number; errorMsg: string; value: unknown }> = {}) {
  return {
    GET_STATS_DATA: {
      RESULT: { STATUS: overrides.status ?? 0, ERROR_MSG: overrides.errorMsg ?? "正常に終了しました。", DATE: "2026-09-20T09:00:00.000+09:00" },
      STATISTICAL_DATA: {
        DATA_INF: { VALUE: overrides.value ?? fixtureValueRows() },
      },
    },
  };
}

// --- buildEstatStatsDataUrl ---

test("buildEstatStatsDataUrl shapes the confirmed query params (appId, lang, statsDataId, cdArea, cdCat01)", () => {
  const url = new URL(buildEstatStatsDataUrl("test-app-id", ["0001", "0161"]));
  assert.equal(url.origin + url.pathname, "https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData");
  assert.equal(url.searchParams.get("appId"), "test-app-id");
  assert.equal(url.searchParams.get("lang"), "J");
  assert.equal(url.searchParams.get("statsDataId"), ESTAT_STATS_DATA_ID);
  assert.equal(url.searchParams.get("cdArea"), ESTAT_AREA_CODE);
  assert.equal(url.searchParams.get("cdCat01"), "0001,0161");
});

// --- parseEstatTimeCode ---

test("parseEstatTimeCode: 2026000808 -> 2026-08-01 (confirmed live example)", () => {
  assert.equal(parseEstatTimeCode("2026000808"), "2026-08-01");
});

test("parseEstatTimeCode: 2026000707 -> 2026-07-01 (confirmed live example)", () => {
  assert.equal(parseEstatTimeCode("2026000707"), "2026-07-01");
});

test("parseEstatTimeCode: rejects a non-10-digit code", () => {
  assert.throws(() => parseEstatTimeCode("202608"), EstatAdapterError);
});

test("parseEstatTimeCode: rejects an out-of-range month", () => {
  assert.throws(() => parseEstatTimeCode("2026001313"), EstatAdapterError);
});

// --- parseEstatGetStatsDataResponse ---

test("parseEstatGetStatsDataResponse: extracts VALUE rows from a well-formed response", () => {
  const rows = parseEstatGetStatsDataResponse(fixtureResponse());
  assert.equal(rows.length, fixtureValueRows().length);
  assert.deepEqual(rows[0], { tab: "1", cat01: "0001", area: "00000", time: "2026000707", unit: "", rawValue: "102.0", annotation: undefined });
});

test("parseEstatGetStatsDataResponse: normalizes a bare VALUE object (single-row quirk) into a 1-element array", () => {
  const rows = parseEstatGetStatsDataResponse(
    fixtureResponse({ value: { "@tab": "1", "@cat01": "0001", "@area": "00000", "@time": "2026000808", "@unit": "", "$": "102.2" } }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rawValue, "102.2");
});

test("parseEstatGetStatsDataResponse: surfaces annotation when present", () => {
  const rows = parseEstatGetStatsDataResponse(fixtureResponse());
  const annotated = rows.find((r) => r.cat01 === "0161" && r.tab === "3" && r.time === "2026000808");
  assert.equal(annotated?.annotation, "J1");
});

test("parseEstatGetStatsDataResponse: STATUS!=0 throws ESTAT_API_ERROR with the ERROR_MSG (appId missing/invalid case, confirmed live)", () => {
  assert.throws(
    () => parseEstatGetStatsDataResponse(fixtureResponse({ status: 100, errorMsg: "認証に失敗しました。アプリケーションIDを確認してください。" })),
    /ESTAT_API_ERROR/,
  );
});

test("parseEstatGetStatsDataResponse: throws ESTAT_MALFORMED_RESPONSE when GET_STATS_DATA is missing", () => {
  assert.throws(() => parseEstatGetStatsDataResponse({ nope: true }), EstatAdapterError);
});

test("parseEstatGetStatsDataResponse: throws ESTAT_MALFORMED_RESPONSE on a non-object payload", () => {
  assert.throws(() => parseEstatGetStatsDataResponse("not json"), EstatAdapterError);
});

// --- selectLatestEstatObservations: the 4 target metrics ---

test("selectLatestEstatObservations: JP_CPI (0001, tab=1) picks the latest (2026-08) index value, not the older 2026-07 one", () => {
  const rows = parseEstatGetStatsDataResponse(fixtureResponse());
  const observations = selectLatestEstatObservations(rows);
  const jpCpi = observations.find((o) => o.metricKey === "JP_CPI");
  assert.equal(jpCpi?.value, 102.2);
  assert.equal(jpCpi?.time, "2026000808");
});

test("selectLatestEstatObservations: JP_CPI_YOY (0001, tab=3) picks 1.9, not tab=2's 0.1", () => {
  const rows = parseEstatGetStatsDataResponse(fixtureResponse());
  const observations = selectLatestEstatObservations(rows);
  const jpCpiYoy = observations.find((o) => o.metricKey === "JP_CPI_YOY");
  assert.equal(jpCpiYoy?.value, 1.9);
});

test("selectLatestEstatObservations: JP_CORE_CPI (0161, tab=1) picks 102.0 for 2026-08, skipping the suppressed '-' value at 2026-07", () => {
  const rows = parseEstatGetStatsDataResponse(fixtureResponse());
  const observations = selectLatestEstatObservations(rows);
  const jpCoreCpi = observations.find((o) => o.metricKey === "JP_CORE_CPI");
  assert.equal(jpCoreCpi?.value, 102.0);
  assert.equal(jpCoreCpi?.time, "2026000808");
});

test("selectLatestEstatObservations: JP_CORE_CPI_YOY (0161, tab=3) picks 1.7", () => {
  const rows = parseEstatGetStatsDataResponse(fixtureResponse());
  const observations = selectLatestEstatObservations(rows);
  const jpCoreCpiYoy = observations.find((o) => o.metricKey === "JP_CORE_CPI_YOY");
  assert.equal(jpCoreCpiYoy?.value, 1.7);
});

test("selectLatestEstatObservations: returns exactly 4 observations for the 2-category mapping (no decoys leak through)", () => {
  const rows = parseEstatGetStatsDataResponse(fixtureResponse());
  const observations = selectLatestEstatObservations(rows);
  assert.equal(observations.length, 4);
  assert.deepEqual(
    observations.map((o) => o.metricKey).sort(),
    ["JP_CORE_CPI", "JP_CORE_CPI_YOY", "JP_CPI", "JP_CPI_YOY"],
  );
});

test("selectLatestEstatObservations: 東京都区部 (13100) rows are excluded even though they share cat01=0001", () => {
  const rows = parseEstatGetStatsDataResponse(fixtureResponse());
  const observations = selectLatestEstatObservations(rows);
  const jpCpi = observations.find((o) => o.metricKey === "JP_CPI");
  assert.notEqual(jpCpi?.value, 999.9);
  const jpCpiYoy = observations.find((o) => o.metricKey === "JP_CPI_YOY");
  assert.notEqual(jpCpiYoy?.value, 99.9);
});

test("selectLatestEstatObservations: 0166 (持家の帰属家賃及び生鮮食品を除く総合) rows never map to JP_CORE_CPI despite being adjacent in the item picker", () => {
  const rows = parseEstatGetStatsDataResponse(fixtureResponse());
  const observations = selectLatestEstatObservations(rows);
  const jpCoreCpi = observations.find((o) => o.metricKey === "JP_CORE_CPI");
  assert.notEqual(jpCoreCpi?.value, 888.8);
});

test("selectLatestEstatObservations: throws ESTAT_NO_VALID_OBSERVATION when a target metric has zero valid rows", () => {
  const rows = parseEstatGetStatsDataResponse(
    fixtureResponse({ value: [{ "@tab": "1", "@cat01": "0001", "@area": "00000", "@time": "2026000808", "@unit": "", "$": "102.2" }] }),
  );
  // Only JP_CPI's row exists; JP_CPI_YOY/JP_CORE_CPI/JP_CORE_CPI_YOY have none.
  assert.throws(() => selectLatestEstatObservations(rows), /ESTAT_NO_VALID_OBSERVATION/);
});

test("selectLatestEstatObservations: a wholly missing/suppressed value ('-', 'X', '...') for every period of a target metric throws rather than silently returning a non-numeric value", () => {
  const rows = parseEstatGetStatsDataResponse(
    fixtureResponse({
      value: [
        { "@tab": "1", "@cat01": "0001", "@area": "00000", "@time": "2026000808", "@unit": "", "$": "-" },
        { "@tab": "3", "@cat01": "0001", "@area": "00000", "@time": "2026000808", "@unit": "%", "$": "1.9" },
        { "@tab": "1", "@cat01": "0161", "@area": "00000", "@time": "2026000808", "@unit": "", "$": "102.0" },
        { "@tab": "3", "@cat01": "0161", "@area": "00000", "@time": "2026000808", "@unit": "%", "$": "1.7" },
      ],
    }),
  );
  assert.throws(() => selectLatestEstatObservations(rows), /ESTAT_NO_VALID_OBSERVATION/);
});

// --- normalizeEstatObservation: provenance + precision ---

test("normalizeEstatObservation: JP_CPI carries the full provenance set and date-only precision, no fabricated time", () => {
  const metric = normalizeEstatObservation(
    { metricKey: "JP_CPI", cat01: "0001", tab: "1", time: "2026000808", value: 102.2, unit: "cpi_index_2025_100", underlyingSource: "Statistics Bureau of Japan" },
    new Date("2026-09-20T00:00:00.000Z"),
  );
  assert.equal(metric.metricKey, "JP_CPI");
  assert.equal(metric.value, 102.2);
  assert.equal(metric.unit, "cpi_index_2025_100");
  assert.equal(metric.observedDate, "2026-08-01");
  assert.equal(metric.observedAt, null, "no fabricated intraday time for a date-only source");
  assert.equal(metric.timePrecision, "date");
  assert.equal(metric.sourceKey, ESTAT_SOURCE_KEY);
  assert.equal(metric.provider, "e-Stat");
  assert.equal(metric.isOfficial, true);
  assert.equal(metric.qualityTier, "official");
  assert.deepEqual(metric.metadata, {
    statsDataId: ESTAT_STATS_DATA_ID,
    cdArea: ESTAT_AREA_CODE,
    cdCat01: "0001",
    tabCode: "1",
    cdTime: "2026000808",
    baseYear: 2025,
    underlyingSource: "Statistics Bureau of Japan",
  });
});

test("normalizeEstatObservation: JP_CPI_YOY uses percent unit and the same provenance shape", () => {
  const metric = normalizeEstatObservation(
    { metricKey: "JP_CPI_YOY", cat01: "0001", tab: "3", time: "2026000808", value: 1.9, unit: "percent", underlyingSource: "Statistics Bureau of Japan" },
    new Date("2026-09-20T00:00:00.000Z"),
  );
  assert.equal(metric.unit, "percent");
  assert.equal(metric.metadata?.tabCode, "3");
});

// --- fetchEstatCpiMetrics: end-to-end with mocked fetch ---

test("fetchEstatCpiMetrics: appId missing throws ESTAT_APP_ID_MISSING before any network call", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  await assert.rejects(
    () => fetchEstatCpiMetrics({ appId: "" }, fetchImpl as typeof fetch),
    /ESTAT_APP_ID_MISSING/,
  );
  assert.equal(called, false, "must not attempt a network call without an appId");
});

test("fetchEstatCpiMetrics: happy path returns all 4 metrics with correct values", async () => {
  const fetchImpl = async () => new Response(JSON.stringify(fixtureResponse()), { status: 200 });
  const metrics = await fetchEstatCpiMetrics({ appId: "test-app-id", fetchedAt: new Date("2026-09-20T00:00:00.000Z") }, fetchImpl as typeof fetch);
  assert.equal(metrics.length, 4);
  assert.deepEqual(metrics.map((m) => m.metricKey).sort(), ["JP_CORE_CPI", "JP_CORE_CPI_YOY", "JP_CPI", "JP_CPI_YOY"]);
  assert.ok(metrics.every((m) => m.observedAt === null && m.timePrecision === "date" && m.sourceKey === "estat"));
});

test("fetchEstatCpiMetrics: appId is never embedded in the returned metrics/metadata", async () => {
  const fetchImpl = async () => new Response(JSON.stringify(fixtureResponse()), { status: 200 });
  const metrics = await fetchEstatCpiMetrics({ appId: "super-secret-app-id-value", fetchedAt: new Date() }, fetchImpl as typeof fetch);
  const serialized = JSON.stringify(metrics);
  assert.ok(!serialized.includes("super-secret-app-id-value"));
});

test("fetchEstatCpiMetrics: STATUS=100 (bad/missing appId, confirmed live shape) surfaces ESTAT_API_ERROR", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify(fixtureResponse({ status: 100, errorMsg: "認証に失敗しました。アプリケーションIDを確認してください。" })), { status: 200 });
  await assert.rejects(
    () => fetchEstatCpiMetrics({ appId: "bad-app-id" }, fetchImpl as typeof fetch),
    /ESTAT_API_ERROR/,
  );
});

test("fetchEstatCpiMetrics: malformed JSON surfaces ESTAT_MALFORMED_RESPONSE", async () => {
  const fetchImpl = async () => new Response("not json{", { status: 200 });
  await assert.rejects(() => fetchEstatCpiMetrics({ appId: "k" }, fetchImpl as typeof fetch), EstatAdapterError);
});

test("fetchEstatCpiMetrics: non-200 surfaces ESTAT_HTTP_ERROR", async () => {
  const fetchImpl = async () => new Response("nope", { status: 503 });
  await assert.rejects(() => fetchEstatCpiMetrics({ appId: "k" }, fetchImpl as typeof fetch), /ESTAT_HTTP_ERROR/);
});

test("fetchEstatCpiMetrics: a fetch-level failure (e.g. timeout) surfaces ESTAT_FETCH_FAILED", async () => {
  const fetchImpl = async () => {
    throw new DOMException("signal timed out", "TimeoutError");
  };
  await assert.rejects(() => fetchEstatCpiMetrics({ appId: "k" }, fetchImpl as typeof fetch), /ESTAT_FETCH_FAILED/);
});

test("ESTAT_CPI_CATEGORY_MAPPINGS: exactly the 2 target categories (0001/0161), nothing else", () => {
  assert.deepEqual(ESTAT_CPI_CATEGORY_MAPPINGS.map((m) => m.cat01Code).sort(), ["0001", "0161"]);
});

test("ESTAT_TAB_INDEX/ESTAT_TAB_YOY are the live-confirmed codes, not placeholders", () => {
  assert.equal(ESTAT_TAB_INDEX, "1");
  assert.equal(ESTAT_TAB_YOY, "3");
});
