// FRED (Federal Reserve Economic Data, https://fred.stlouisfed.org) adapter.
//
// Endpoint confirmed against FRED's own API reference
// (https://fred.stlouisfed.org/docs/api/fred/series_observations.html):
// GET https://api.stlouisfed.org/fred/series/observations
//   ?series_id=<id>&api_key=<key>&file_type=json&sort_order=desc&limit=<n>
// Response: { observations: [{ date: "YYYY-MM-DD", value: "<number>|." }] }.
// A missing observation is represented as value="." (not omitted), per
// FRED's documented convention.
//
// Phase 1A wired US2Y (DGS2) and US10Y (DGS10) only. Equity Index Phase 1
// adds NIKKEI225/SP500/NASDAQCOM/NASDAQ100/VIXCLS the same way the header
// comment always said this would work: a plain addition to
// FRED_SERIES_MAPPINGS, no new adapter file.
//
// FRED itself is not the original source for any of these -- it
// republishes each index from its actual provider (Nikkei Industry
// Research Institute, S&P Dow Jones Indices LLC, Nasdaq Inc., CBOE). The
// optional `underlyingSource` on each mapping keeps that distinction
// explicit in metadata (provider="FRED" always; metadata.underlyingSource
// names whose data it actually is), the same principle already applied to
// the Frankfurter/ECB fx adapter. US2Y/US10Y's mappings intentionally omit
// it (unchanged from Phase 1A) since "U.S. Department of the Treasury" was
// never previously recorded and adding it now is out of scope for this
// phase.
//
// Macro Indicators Phase 1A adds an optional `units` field on
// FredSeriesMapping, mapped 1:1 onto FRED's own documented `units` query
// parameter (https://fred.stlouisfed.org/docs/api/fred/series_observations.html#units,
// e.g. "pc1" = percent change from a year ago, "chg" = change from prior
// period, "pch" = percent change from prior period). This lets the same
// seriesId be fetched twice under two different metric_keys -- e.g.
// CPIAUCSL raw (index level, metric_key=US_CPI) and CPIAUCSL with
// units=pc1 (year-over-year %, metric_key=US_CPI_YOY) -- without
// duplicating any fetch/parse logic. When `units` is omitted, the query
// param is not sent at all (FRED's own default, "lin"/no transformation),
// so every mapping added before this phase (US2Y/US10Y/equity index) is
// byte-for-byte unaffected: buildFredObservationsUrl only sets the
// `units` param when a mapping explicitly asks for one. The transform
// itself is computed by FRED server-side, never by this adapter --
// normalizeFredObservation records `fredUnits` in metadata precisely so a
// transformed value is never mistaken for something this codebase derived
// itself.
import type { NormalizedMarketMetric } from "./mic_normalize_logic.ts";

export const FRED_OBSERVATIONS_URL = "https://api.stlouisfed.org/fred/series/observations";
export const FRED_SOURCE_KEY = "fred";

export class FredAdapterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "FredAdapterError";
  }
}

export type FredSeriesMapping = {
  seriesId: string;
  metricKey: string;
  unit: string;
  // Who the data actually comes from, when that differs from "FRED" (the
  // provider we call). Omitted for US2Y/US10Y (unchanged from Phase 1A).
  underlyingSource?: string;
  // FRED's `units` query parameter (e.g. "pc1", "chg", "pch"). Omitted
  // means "no transform" -- FRED serves the raw series, and the query URL
  // never gains a `units` param, matching every mapping's behavior before
  // Macro Indicators Phase 1A.
  units?: string;
};

export const FRED_SERIES_MAPPINGS: FredSeriesMapping[] = [
  { seriesId: "DGS2", metricKey: "US2Y", unit: "percent" },
  { seriesId: "DGS10", metricKey: "US10Y", unit: "percent" },
  // Fed policy target range (official series source: Board of Governors).
  // These are effective-date daily observations, not statement timestamps.
  {
    seriesId: "DFEDTARL",
    metricKey: "FED_FUNDS_TARGET_LOWER",
    unit: "percent",
    underlyingSource: "Board of Governors of the Federal Reserve System (US)",
  },
  {
    seriesId: "DFEDTARU",
    metricKey: "FED_FUNDS_TARGET_UPPER",
    unit: "percent",
    underlyingSource: "Board of Governors of the Federal Reserve System (US)",
  },
  {
    seriesId: "NIKKEI225",
    metricKey: "NIKKEI225",
    unit: "index_points",
    underlyingSource: "Nikkei Industry Research Institute",
  },
  {
    seriesId: "SP500",
    metricKey: "SP500",
    unit: "index_points",
    underlyingSource: "S&P Dow Jones Indices LLC",
  },
  {
    seriesId: "NASDAQCOM",
    metricKey: "NASDAQCOMPOSITE",
    unit: "index_points",
    underlyingSource: "Nasdaq, Inc.",
  },
  {
    seriesId: "NASDAQ100",
    metricKey: "NASDAQ100",
    unit: "index_points",
    underlyingSource: "Nasdaq, Inc.",
  },
  {
    seriesId: "VIXCLS",
    metricKey: "VIX",
    unit: "index_points",
    underlyingSource: "Chicago Board Options Exchange (CBOE)",
  },
  // --- Macro Indicators Phase 1A: FRED-sourced US/JP macro releases ---
  // Each "level" series is paired with a second mapping of the SAME
  // seriesId under FRED's own `units` transform, producing a distinct
  // metric_key for the derived figure (YoY%, MoM%, or period change) that
  // media/investors actually react to. Neither figure is computed by this
  // codebase -- both come straight from FRED's own API response.
  {
    seriesId: "CPIAUCSL",
    metricKey: "US_CPI",
    unit: "cpi_index_1982_84_100",
    underlyingSource: "U.S. Bureau of Labor Statistics",
  },
  {
    seriesId: "CPIAUCSL",
    metricKey: "US_CPI_YOY",
    unit: "percent",
    underlyingSource: "U.S. Bureau of Labor Statistics",
    units: "pc1",
  },
  {
    seriesId: "CPILFESL",
    metricKey: "US_CORE_CPI",
    unit: "cpi_index_1982_84_100",
    underlyingSource: "U.S. Bureau of Labor Statistics",
  },
  {
    seriesId: "CPILFESL",
    metricKey: "US_CORE_CPI_YOY",
    unit: "percent",
    underlyingSource: "U.S. Bureau of Labor Statistics",
    units: "pc1",
  },
  {
    seriesId: "PCEPI",
    metricKey: "US_PCE",
    unit: "pce_index_2017_100",
    underlyingSource: "U.S. Bureau of Economic Analysis",
  },
  {
    seriesId: "PCEPI",
    metricKey: "US_PCE_YOY",
    unit: "percent",
    underlyingSource: "U.S. Bureau of Economic Analysis",
    units: "pc1",
  },
  {
    seriesId: "PCEPILFE",
    metricKey: "US_CORE_PCE",
    unit: "pce_index_2017_100",
    underlyingSource: "U.S. Bureau of Economic Analysis",
  },
  {
    seriesId: "PCEPILFE",
    metricKey: "US_CORE_PCE_YOY",
    unit: "percent",
    underlyingSource: "U.S. Bureau of Economic Analysis",
    units: "pc1",
  },
  {
    seriesId: "PAYEMS",
    metricKey: "US_NFP",
    unit: "thousands_of_persons",
    underlyingSource: "U.S. Bureau of Labor Statistics",
  },
  {
    seriesId: "PAYEMS",
    metricKey: "US_NFP_CHANGE",
    unit: "thousands_of_persons",
    underlyingSource: "U.S. Bureau of Labor Statistics",
    units: "chg",
  },
  {
    seriesId: "UNRATE",
    metricKey: "US_UNEMPLOYMENT_RATE",
    unit: "percent",
    underlyingSource: "U.S. Bureau of Labor Statistics",
  },
  {
    seriesId: "GDPC1",
    metricKey: "US_GDP",
    unit: "billions_of_chained_2017_dollars",
    underlyingSource: "U.S. Bureau of Economic Analysis",
  },
  {
    seriesId: "A191RL1Q225SBEA",
    metricKey: "US_GDP_GROWTH",
    unit: "percent_annualized",
    underlyingSource: "U.S. Bureau of Economic Analysis",
  },
  {
    seriesId: "RSAFS",
    metricKey: "US_RETAIL_SALES",
    unit: "millions_of_dollars",
    underlyingSource: "U.S. Census Bureau",
  },
  {
    seriesId: "RSAFS",
    metricKey: "US_RETAIL_SALES_MOM",
    unit: "percent",
    underlyingSource: "U.S. Census Bureau",
    units: "pch",
  },
  {
    seriesId: "JPNRGDPEXP",
    metricKey: "JP_GDP",
    unit: "billions_of_chained_2015_yen",
    underlyingSource: "Cabinet Office, Government of Japan",
  },
];

// FRED's daily constant-maturity treasury series typically finalizes the
// prior business day's value with roughly a one business day lag.
const FRED_EXPECTED_DELAY_MINUTES = 24 * 60;

export function buildFredObservationsUrl(seriesId: string, apiKey: string, limit = 5, units?: string): string {
  const url = new URL(FRED_OBSERVATIONS_URL);
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", String(limit));
  // Omitted entirely (not even as an empty string) when the mapping asks
  // for no transform, so every pre-Phase-1A mapping's URL is byte-for-byte
  // unchanged.
  if (units) url.searchParams.set("units", units);
  return url.toString();
}

export function buildFredHistoricalObservationsUrl(
  seriesId: string,
  apiKey: string,
  observationStart: string,
  observationEnd: string,
  units?: string,
): string {
  const url = new URL(buildFredObservationsUrl(seriesId, apiKey, 100_000, units));
  url.searchParams.set("sort_order", "asc");
  url.searchParams.set("observation_start", observationStart);
  url.searchParams.set("observation_end", observationEnd);
  return url.toString();
}

type FredObservation = { date: string; value: string };

export function parseFredObservations(payload: unknown): FredObservation[] {
  if (typeof payload !== "object" || payload === null) {
    throw new FredAdapterError("FRED_MALFORMED_RESPONSE", "payload is not an object");
  }
  const observations = (payload as Record<string, unknown>).observations;
  if (!Array.isArray(observations)) {
    throw new FredAdapterError("FRED_MALFORMED_RESPONSE", "observations field missing or not an array");
  }
  return observations.filter((entry): entry is FredObservation =>
    typeof entry === "object" && entry !== null &&
    typeof (entry as Record<string, unknown>).date === "string" &&
    typeof (entry as Record<string, unknown>).value === "string"
  );
}

// FRED represents a missing value as the literal string "." rather than
// omitting the row; observations are already sorted desc by the query.
export function latestValidFredObservation(observations: FredObservation[]): FredObservation | null {
  for (const observation of observations) {
    if (observation.value !== ".") return observation;
  }
  return null;
}

// FRED daily observations carry a date with no intraday time. Per Phase 1A
// review, this is NOT converted into a fabricated timestamp (e.g. "21:00
// UTC") -- it is validated and returned as-is for use as observedDate,
// with observedAt left null and timePrecision set to "date".
export function validateFredObservationDate(dateStr: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new FredAdapterError("FRED_INVALID_DATE", `unexpected date format: ${dateStr}`);
  }
  return dateStr;
}

export function normalizeFredObservation(
  mapping: FredSeriesMapping,
  observation: FredObservation,
  fetchedAt: Date,
): NormalizedMarketMetric {
  const value = Number(observation.value);
  if (!Number.isFinite(value)) {
    throw new FredAdapterError("FRED_INVALID_VALUE", `non-numeric value for ${mapping.seriesId}: ${observation.value}`);
  }
  return {
    metricKey: mapping.metricKey,
    value,
    unit: mapping.unit,
    observedDate: validateFredObservationDate(observation.date),
    observedAt: null,
    timePrecision: "date",
    fetchedAt: fetchedAt.toISOString(),
    sourceKey: FRED_SOURCE_KEY,
    provider: "FRED",
    sourceUrl: `https://fred.stlouisfed.org/series/${mapping.seriesId}`,
    isDelayed: true,
    delayMinutes: FRED_EXPECTED_DELAY_MINUTES,
    qualityTier: "official",
    isOfficial: true,
    metadata: {
      seriesId: mapping.seriesId,
      fredDate: observation.date,
      ...(mapping.underlyingSource ? { underlyingSource: mapping.underlyingSource } : {}),
      // Only present for a transformed (derived) mapping -- discloses that
      // FRED computed this value server-side (e.g. "pc1" = YoY %), so it
      // is never mistaken for a value this codebase derived itself. Raw
      // mappings (units undefined) keep their metadata shape byte-for-byte
      // identical to before this phase.
      ...(mapping.units ? { fredUnits: mapping.units } : {}),
    },
  };
}

export type FetchFredMetricsParams = {
  apiKey: string;
  mappings?: FredSeriesMapping[];
  fetchedAt?: Date;
  timeoutMs?: number;
};

export async function fetchFredMetrics(
  params: FetchFredMetricsParams,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedMarketMetric[]> {
  const mappings = params.mappings ?? FRED_SERIES_MAPPINGS;
  const fetchedAt = params.fetchedAt ?? new Date();
  const results: NormalizedMarketMetric[] = [];

  for (const mapping of mappings) {
    const url = buildFredObservationsUrl(mapping.seriesId, params.apiKey, 5, mapping.units);
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(params.timeoutMs ?? 15_000) });
    } catch (error) {
      throw new FredAdapterError("FRED_FETCH_FAILED", `${mapping.seriesId}: ${String(error)}`);
    }
    if (!response.ok) {
      throw new FredAdapterError("FRED_HTTP_ERROR", `${mapping.seriesId}: status=${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new FredAdapterError("FRED_MALFORMED_RESPONSE", `${mapping.seriesId}: invalid JSON`);
    }
    const observations = parseFredObservations(payload);
    const latest = latestValidFredObservation(observations);
    if (!latest) {
      throw new FredAdapterError("FRED_NO_VALID_OBSERVATION", `${mapping.seriesId}: no non-missing observation`);
    }
    results.push(normalizeFredObservation(mapping, latest, fetchedAt));
  }

  return results;
}

export type FetchFredHistoricalMetricsParams = {
  apiKey: string;
  observationStart: string;
  observationEnd: string;
  mappings?: FredSeriesMapping[];
  fetchedAt?: Date;
  timeoutMs?: number;
};

export async function fetchFredHistoricalMetrics(
  params: FetchFredHistoricalMetricsParams,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedMarketMetric[]> {
  const mappings = params.mappings ?? FRED_SERIES_MAPPINGS.filter((mapping) =>
    mapping.metricKey === "FED_FUNDS_TARGET_LOWER" || mapping.metricKey === "FED_FUNDS_TARGET_UPPER"
  );
  const fetchedAt = params.fetchedAt ?? new Date();
  const results: NormalizedMarketMetric[] = [];
  for (const mapping of mappings) {
    const url = buildFredHistoricalObservationsUrl(mapping.seriesId, params.apiKey, params.observationStart, params.observationEnd, mapping.units);
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(params.timeoutMs ?? 15_000) });
    } catch (error) {
      throw new FredAdapterError("FRED_FETCH_FAILED", `${mapping.seriesId}: ${String(error)}`);
    }
    if (!response.ok) throw new FredAdapterError("FRED_HTTP_ERROR", `${mapping.seriesId}: status=${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new FredAdapterError("FRED_MALFORMED_RESPONSE", `${mapping.seriesId}: invalid JSON`);
    }
    const observations = parseFredObservations(payload).filter((observation) => observation.value !== ".");
    if (observations.length === 0) {
      throw new FredAdapterError("FRED_NO_VALID_OBSERVATION", `${mapping.seriesId}: no non-missing observations in requested range`);
    }
    for (const observation of observations) results.push(normalizeFredObservation(mapping, observation, fetchedAt));
  }
  return results;
}
