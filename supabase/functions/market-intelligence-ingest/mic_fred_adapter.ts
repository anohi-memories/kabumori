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
};

export const FRED_SERIES_MAPPINGS: FredSeriesMapping[] = [
  { seriesId: "DGS2", metricKey: "US2Y", unit: "percent" },
  { seriesId: "DGS10", metricKey: "US10Y", unit: "percent" },
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
];

// FRED's daily constant-maturity treasury series typically finalizes the
// prior business day's value with roughly a one business day lag.
const FRED_EXPECTED_DELAY_MINUTES = 24 * 60;

export function buildFredObservationsUrl(seriesId: string, apiKey: string, limit = 5): string {
  const url = new URL(FRED_OBSERVATIONS_URL);
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", String(limit));
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
    const url = buildFredObservationsUrl(mapping.seriesId, params.apiKey);
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
