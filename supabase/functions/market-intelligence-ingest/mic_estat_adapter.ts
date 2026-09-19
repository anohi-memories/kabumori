// e-Stat (政府統計の総合窓口, Statistics Bureau of Japan) adapter --
// Macro Indicators Phase 1B: Japan CPI / Core CPI only.
//
// Endpoint confirmed against e-Stat's own official API manual
// (https://www.e-stat.go.jp/api/api-info/e-stat-manual3-0):
// GET https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData?<params>
// Response shape: GET_STATS_DATA.RESULT.STATUS (0 = success; confirmed
// live that a bad/missing appId returns STATUS=100 with
// ERROR_MSG="認証に失敗しました。アプリケーションIDを確認してください。" --
// appId is required for every call, including metadata-only calls; there
// is no unauthenticated tier), and
// GET_STATS_DATA.STATISTICAL_DATA.DATA_INF.VALUE, an array (or, per a
// well-known e-Stat API quirk, a single bare object when there is only
// one matching row) of { "@tab", "@cat01", "@area", "@time", "@unit",
// "$", "@annotation"? }.
//
// statsDataId=0004052037 is "消費者物価指数（2025年基準）" (2025-base CPI,
// base year 2025=100), confirmed via e-Stat's own news announcement
// (https://www.e-stat.go.jp/api/info-cat/news/httpswwwe-statgojpapiinfo-catnewscpi-info202607)
// -- the 2020-base table has a DIFFERENT statsDataId and will stop being
// updated after the 2026-12 release; this adapter targets the 2025-base
// table only.
//
// cdArea=00000 ("全国") and cdCat01=0001 ("総合") / 0161 ("生鮮食品を除く
// 総合") were confirmed live via e-Stat's own dbview UI (the region/item
// picker's checkbox codes), NOT guessed -- 0166 ("持家の帰属家賃及び生鮮
// 食品を除く総合") and 0178 ("生鮮食品及びエネルギーを除く総合", the
// closer analogue to US "core CPI", a Phase 1C candidate) are visually
// adjacent in the picker and are deliberately NOT used here.
//
// The @tab (表章項目) codes for "指数" and "前年同月比" are NOT documented
// as fixed numbers anywhere in e-Stat's public API manual (unlike
// cdArea/cdCat01, which are visible as literal codes in the item picker).
// They were confirmed live, per this phase's explicit instruction to
// never hardcode a guessed tab code, by isolating each column in
// e-Stat's OWN dbview UI (https://www.e-stat.go.jp/dbview?sid=0004052037)
// one at a time and reading the resulting internal
// `POST /dbview/api_get_result` request's `colItemList1` parameter (the
// site's own selected-column-code list, not a public API response, but a
// live, first-party confirmation against this exact statsDataId):
//   - selecting only "指数"       -> colItemList1="1"
//   - selecting only "前年同月比"  -> colItemList1="3"
//   - ("前月比・前年比・前年度比" -> "2", unused by this adapter)
// If e-Stat ever changes this table's tab numbering, ESTAT_API_ERROR /
// ESTAT_METRIC_NOT_FOUND below will surface it loudly rather than
// silently mis-mapping a value.
import type { NormalizedMarketMetric } from "./mic_normalize_logic.ts";

export const ESTAT_GET_STATS_DATA_URL = "https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData";
export const ESTAT_SOURCE_KEY = "estat";
export const ESTAT_STATS_DATA_ID = "0004052037";
export const ESTAT_AREA_CODE = "00000"; // 全国 -- confirmed live via e-Stat's dbview region picker
export const ESTAT_BASE_YEAR = 2025;
export const ESTAT_SOURCE_URL = `https://www.e-stat.go.jp/dbview?sid=${ESTAT_STATS_DATA_ID}`;

// 表章項目 (tab) codes -- see the header comment for how these were
// confirmed live, not guessed.
export const ESTAT_TAB_INDEX = "1";
export const ESTAT_TAB_YOY = "3";

export class EstatAdapterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "EstatAdapterError";
  }
}

export type EstatCategoryMapping = {
  // 2025年基準品目 (cdCat01) code -- confirmed live via e-Stat's dbview
  // item picker, e.g. "0001" for 総合.
  cat01Code: string;
  indexMetricKey: string;
  yoyMetricKey: string;
  indexUnit: string;
  yoyUnit: string;
  underlyingSource: string;
};

export const ESTAT_CPI_CATEGORY_MAPPINGS: EstatCategoryMapping[] = [
  {
    cat01Code: "0001", // 総合
    indexMetricKey: "JP_CPI",
    yoyMetricKey: "JP_CPI_YOY",
    indexUnit: "cpi_index_2025_100",
    yoyUnit: "percent",
    underlyingSource: "Statistics Bureau of Japan",
  },
  {
    cat01Code: "0161", // 生鮮食品を除く総合 -- distinct from 0166/0178, see header comment
    indexMetricKey: "JP_CORE_CPI",
    yoyMetricKey: "JP_CORE_CPI_YOY",
    indexUnit: "cpi_index_2025_100",
    yoyUnit: "percent",
    underlyingSource: "Statistics Bureau of Japan",
  },
];

// e-Stat's own publication lag for this table is roughly one month
// (reference-period-end to publish); the Facts-layer is_delayed/delayMinutes
// pair here is purely descriptive (mirrors FRED/MOF's own convention) --
// the real freshness handling for a monthly series lives in
// mic_metric_domain_map's expected_observation_lag_minutes/
// observation_stale_after_minutes columns (State layer), not here.
const ESTAT_EXPECTED_DELAY_MINUTES = 24 * 60;

export function buildEstatStatsDataUrl(appId: string, cat01Codes: string[], statsDataId = ESTAT_STATS_DATA_ID): string {
  const url = new URL(ESTAT_GET_STATS_DATA_URL);
  url.searchParams.set("appId", appId);
  url.searchParams.set("lang", "J");
  url.searchParams.set("statsDataId", statsDataId);
  url.searchParams.set("cdArea", ESTAT_AREA_CODE);
  url.searchParams.set("cdCat01", cat01Codes.join(","));
  return url.toString();
}

export type EstatValueRow = {
  tab: string;
  cat01: string;
  area: string;
  time: string;
  unit: string;
  rawValue: string;
  annotation?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

export function parseEstatGetStatsDataResponse(payload: unknown): EstatValueRow[] {
  const root = asRecord(payload)?.["GET_STATS_DATA"];
  const rootObj = asRecord(root);
  if (!rootObj) {
    throw new EstatAdapterError("ESTAT_MALFORMED_RESPONSE", "GET_STATS_DATA missing or not an object");
  }

  const result = asRecord(rootObj["RESULT"]);
  const status = result?.["STATUS"];
  if (status !== 0) {
    const errorMsg = typeof result?.["ERROR_MSG"] === "string" ? result["ERROR_MSG"] : "unknown error";
    throw new EstatAdapterError("ESTAT_API_ERROR", `STATUS=${String(status)}: ${errorMsg}`);
  }

  const statisticalData = asRecord(rootObj["STATISTICAL_DATA"]);
  const dataInf = asRecord(statisticalData?.["DATA_INF"]);
  const rawValue = dataInf?.["VALUE"];
  // Well-known e-Stat API quirk: VALUE is a bare object (not a one-element
  // array) when exactly one row matches the query -- normalize to an array
  // either way.
  const rows = Array.isArray(rawValue) ? rawValue : rawValue !== undefined ? [rawValue] : [];

  return rows
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      tab: String(entry["@tab"] ?? ""),
      cat01: String(entry["@cat01"] ?? ""),
      area: String(entry["@area"] ?? ""),
      time: String(entry["@time"] ?? ""),
      unit: typeof entry["@unit"] === "string" ? entry["@unit"] : "",
      rawValue: String(entry["$"] ?? ""),
      annotation: typeof entry["@annotation"] === "string" ? entry["@annotation"] : undefined,
    }));
}

// @time is a 10-digit code. Confirmed live against two consecutive months
// for this exact statsDataId: 2026-08 -> "2026000808", 2026-07 ->
// "2026000707". This parser relies ONLY on the positions confirmed by
// those two examples -- year in digits[0:4], month in digits[8:10] -- and
// does NOT assume anything about digits[4:8] (whose exact meaning was not
// independently confirmed), so a future month whose middle digits don't
// follow the "repeat the month" pattern observed here still parses
// correctly as long as the year/month positions hold. Never converted
// into anything but a date-only observed_date -- no time-of-day is
// invented.
export function parseEstatTimeCode(time: string): string {
  if (!/^\d{10}$/.test(time)) {
    throw new EstatAdapterError("ESTAT_INVALID_TIME_CODE", `unexpected @time format: ${time}`);
  }
  const year = time.slice(0, 4);
  const month = time.slice(8, 10);
  const monthNum = Number(month);
  if (monthNum < 1 || monthNum > 12) {
    throw new EstatAdapterError("ESTAT_INVALID_TIME_CODE", `unexpected month in @time: ${time}`);
  }
  return `${year}-${month}-01`;
}

export type EstatObservation = {
  metricKey: string;
  cat01: string;
  tab: string;
  time: string;
  value: number;
  unit: string;
  underlyingSource: string;
};

// For each configured category, picks the latest (highest @time --
// zero-padded fixed-width strings sort lexically the same as numerically)
// valid (numeric, non-suppressed) observation for the index tab and the
// YoY tab. Only area===ESTAT_AREA_CODE rows are considered, even though
// the query already requests cdArea=00000 server-side -- defense in
// depth, same principle as the FRED adapter never trusting a response
// blindly. Throws if any of the 4 target metrics has zero valid
// observations, matching FRED's all-or-nothing-per-request philosophy
// (this is one HTTP call for all 4 metrics, not 4 separate calls).
export function selectLatestEstatObservations(
  rows: EstatValueRow[],
  categoryMappings: EstatCategoryMapping[] = ESTAT_CPI_CATEGORY_MAPPINGS,
): EstatObservation[] {
  const results: EstatObservation[] = [];

  for (const mapping of categoryMappings) {
    for (
      const [tab, metricKey, unit] of [
        [ESTAT_TAB_INDEX, mapping.indexMetricKey, mapping.indexUnit],
        [ESTAT_TAB_YOY, mapping.yoyMetricKey, mapping.yoyUnit],
      ] as const
    ) {
      const candidates = rows
        .filter((row) => row.area === ESTAT_AREA_CODE && row.cat01 === mapping.cat01Code && row.tab === tab)
        .filter((row) => Number.isFinite(Number(row.rawValue)) && row.rawValue.trim() !== "")
        .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));

      const latest = candidates[0];
      if (!latest) {
        throw new EstatAdapterError(
          "ESTAT_NO_VALID_OBSERVATION",
          `no valid observation for cat01=${mapping.cat01Code} tab=${tab} (metricKey=${metricKey})`,
        );
      }
      results.push({
        metricKey,
        cat01: latest.cat01,
        tab: latest.tab,
        time: latest.time,
        value: Number(latest.rawValue),
        unit,
        underlyingSource: mapping.underlyingSource,
      });
    }
  }

  return results;
}

export function normalizeEstatObservation(observation: EstatObservation, fetchedAt: Date): NormalizedMarketMetric {
  return {
    metricKey: observation.metricKey,
    value: observation.value,
    unit: observation.unit,
    observedDate: parseEstatTimeCode(observation.time),
    observedAt: null,
    timePrecision: "date",
    fetchedAt: fetchedAt.toISOString(),
    sourceKey: ESTAT_SOURCE_KEY,
    provider: "e-Stat",
    sourceUrl: ESTAT_SOURCE_URL,
    isDelayed: true,
    delayMinutes: ESTAT_EXPECTED_DELAY_MINUTES,
    qualityTier: "official",
    isOfficial: true,
    metadata: {
      statsDataId: ESTAT_STATS_DATA_ID,
      cdArea: ESTAT_AREA_CODE,
      cdCat01: observation.cat01,
      tabCode: observation.tab,
      cdTime: observation.time,
      baseYear: ESTAT_BASE_YEAR,
      underlyingSource: observation.underlyingSource,
    },
  };
}

export type FetchEstatCpiMetricsParams = {
  // Required, non-empty. Callers (index.ts) are responsible for the
  // "is ESTAT_APP_ID configured at all" check -- same division of
  // responsibility as FRED_API_KEY/EIA_API_KEY -- so this adapter never
  // reads Deno.env itself and never logs/embeds the value anywhere beyond
  // using it as a query parameter value in the outgoing request URL.
  appId: string;
  categoryMappings?: EstatCategoryMapping[];
  fetchedAt?: Date;
  timeoutMs?: number;
};

export async function fetchEstatCpiMetrics(
  params: FetchEstatCpiMetricsParams,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedMarketMetric[]> {
  if (!params.appId) {
    throw new EstatAdapterError("ESTAT_APP_ID_MISSING", "appId is required");
  }
  const categoryMappings = params.categoryMappings ?? ESTAT_CPI_CATEGORY_MAPPINGS;
  const fetchedAt = params.fetchedAt ?? new Date();
  const url = buildEstatStatsDataUrl(params.appId, categoryMappings.map((m) => m.cat01Code));

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(params.timeoutMs ?? 20_000) });
  } catch (error) {
    throw new EstatAdapterError("ESTAT_FETCH_FAILED", String(error));
  }
  if (!response.ok) {
    throw new EstatAdapterError("ESTAT_HTTP_ERROR", `status=${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EstatAdapterError("ESTAT_MALFORMED_RESPONSE", "invalid JSON");
  }

  const rows = parseEstatGetStatsDataResponse(payload);
  const observations = selectLatestEstatObservations(rows, categoryMappings);
  return observations.map((observation) => normalizeEstatObservation(observation, fetchedAt));
}
