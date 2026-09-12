// EIA (U.S. Energy Information Administration) v2 Open Data API adapter --
// WTI (Cushing) and Brent spot prices.
//
// Endpoint confirmed by direct request during implementation (returns the
// documented API_KEY_MISSING error shape, confirming the route/params are
// valid without needing a real key):
// https://api.eia.gov/v2/petroleum/pri/spt/data/
//   ?api_key=<key>&frequency=daily&data[0]=value&facets[series][]=<code>
//   &sort[0][column]=period&sort[0][direction]=desc&length=<n>
// Response: { response: { data: [{ period: "YYYY-MM-DD", value: "<n>" }] } }.
import type { NormalizedMarketMetric } from "./mic_normalize_logic.ts";

export const EIA_SPOT_PRICES_URL = "https://api.eia.gov/v2/petroleum/pri/spt/data/";
export const EIA_SOURCE_KEY = "eia";

export class EiaAdapterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "EiaAdapterError";
  }
}

export type EiaSeriesMapping = { seriesCode: string; metricKey: string; unit: string };

export const EIA_SERIES_MAPPINGS: EiaSeriesMapping[] = [
  { seriesCode: "RWTC", metricKey: "WTI", unit: "usd_per_barrel" },
  { seriesCode: "RBRTE", metricKey: "BRENT", unit: "usd_per_barrel" },
];

// EIA's daily spot price series is typically finalized with roughly a
// one-day lag.
const EIA_EXPECTED_DELAY_MINUTES = 24 * 60;

export function buildEiaSpotPriceUrl(seriesCode: string, apiKey: string, length = 5): string {
  const url = new URL(EIA_SPOT_PRICES_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("frequency", "daily");
  url.searchParams.set("data[0]", "value");
  url.searchParams.set("facets[series][]", seriesCode);
  url.searchParams.set("sort[0][column]", "period");
  url.searchParams.set("sort[0][direction]", "desc");
  url.searchParams.set("length", String(length));
  return url.toString();
}

type EiaDatum = { period: string; value: string };

export function parseEiaResponse(payload: unknown): EiaDatum[] {
  if (typeof payload !== "object" || payload === null) {
    throw new EiaAdapterError("EIA_MALFORMED_RESPONSE", "payload is not an object");
  }
  const response = (payload as Record<string, unknown>).response;
  const data = (response as Record<string, unknown> | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new EiaAdapterError("EIA_MALFORMED_RESPONSE", "response.data missing or not an array");
  }
  return data.filter((entry): entry is EiaDatum =>
    typeof entry === "object" && entry !== null &&
    typeof (entry as Record<string, unknown>).period === "string" &&
    typeof (entry as Record<string, unknown>).value === "string"
  );
}

export function normalizeEiaObservation(
  mapping: EiaSeriesMapping,
  datum: EiaDatum,
  fetchedAt: Date,
): NormalizedMarketMetric {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum.period)) {
    throw new EiaAdapterError("EIA_INVALID_PERIOD", `unexpected period format: ${datum.period}`);
  }
  const value = Number(datum.value);
  if (!Number.isFinite(value)) {
    throw new EiaAdapterError("EIA_INVALID_VALUE", `non-numeric value for ${mapping.seriesCode}: ${datum.value}`);
  }
  return {
    metricKey: mapping.metricKey,
    value,
    unit: mapping.unit,
    // Daily spot price with no intraday time; treated as the US market
    // close for that date (21:00 UTC), same convention as the FRED adapter.
    observedAt: `${datum.period}T21:00:00.000Z`,
    fetchedAt: fetchedAt.toISOString(),
    sourceKey: EIA_SOURCE_KEY,
    provider: "EIA",
    sourceUrl: `https://www.eia.gov/dnav/pet/hist/${mapping.seriesCode}D.htm`,
    isDelayed: true,
    delayMinutes: EIA_EXPECTED_DELAY_MINUTES,
    qualityTier: "official",
    isOfficial: true,
    metadata: { seriesCode: mapping.seriesCode },
  };
}

export type FetchEiaMetricsParams = {
  apiKey: string;
  mappings?: EiaSeriesMapping[];
  fetchedAt?: Date;
  timeoutMs?: number;
};

export async function fetchEiaMetrics(
  params: FetchEiaMetricsParams,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedMarketMetric[]> {
  const mappings = params.mappings ?? EIA_SERIES_MAPPINGS;
  const fetchedAt = params.fetchedAt ?? new Date();
  const results: NormalizedMarketMetric[] = [];

  for (const mapping of mappings) {
    const url = buildEiaSpotPriceUrl(mapping.seriesCode, params.apiKey);
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(params.timeoutMs ?? 15_000) });
    } catch (error) {
      throw new EiaAdapterError("EIA_FETCH_FAILED", `${mapping.seriesCode}: ${String(error)}`);
    }
    if (!response.ok) {
      throw new EiaAdapterError("EIA_HTTP_ERROR", `${mapping.seriesCode}: status=${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EiaAdapterError("EIA_MALFORMED_RESPONSE", `${mapping.seriesCode}: invalid JSON`);
    }
    const data = parseEiaResponse(payload);
    const latest = data[0];
    if (!latest) {
      throw new EiaAdapterError("EIA_NO_DATA", `${mapping.seriesCode}: no data returned`);
    }
    results.push(normalizeEiaObservation(mapping, latest, fetchedAt));
  }

  return results;
}
