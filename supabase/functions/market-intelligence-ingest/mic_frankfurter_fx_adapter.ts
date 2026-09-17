// Frankfurter (https://frankfurter.dev) FX adapter -- USD/JPY, Phase 1 of
// the fx domain.
//
// Frankfurter is a free, no-API-key, no-quota exchange rate API. Its own
// underlying data is the European Central Bank's daily reference rates
// (published once per ECB TARGET business day, ~16:00 CET); Frankfurter
// itself does not quote USD/JPY directly -- it derives it as a
// EUR-denominated cross-rate. This is why provider ("Frankfurter") and the
// underlying source (ECB reference rates) are kept distinct throughout
// this adapter: `provider` names who we're calling, `metadata.underlyingSource`
// names whose data it actually is. quality_tier is "trusted_free" and
// is_official is false for exactly this reason -- it is not a direct
// one-source-of-truth quote the way FRED's Treasury yields or MOF's JGB
// yields are.
//
// Endpoint confirmed by a direct GET during implementation:
// https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY
// Response: { amount: 1, base: "USD", date: "YYYY-MM-DD", rates: { JPY: <number> } }
import type { NormalizedMarketMetric } from "./mic_normalize_logic.ts";

export const FRANKFURTER_LATEST_URL = "https://api.frankfurter.dev/v1/latest";
export const FRANKFURTER_SOURCE_KEY = "frankfurter";
const FRANKFURTER_UNDERLYING_SOURCE = "ECB reference rates (via Frankfurter)";

export class FrankfurterAdapterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "FrankfurterAdapterError";
  }
}

export type FrankfurterPairMapping = { base: string; symbol: string; metricKey: string; unit: string };

// Phase 1: USD/JPY only. EUR/USD and EUR/JPY (mentioned as future
// candidates) are a one-line addition here, same pattern as
// FRED_SERIES_MAPPINGS / EIA_SERIES_MAPPINGS -- no new adapter needed.
export const FRANKFURTER_PAIR_MAPPINGS: FrankfurterPairMapping[] = [
  { base: "USD", symbol: "JPY", metricKey: "USDJPY", unit: "JPY_per_USD" },
];

// ECB publishes its daily reference rates once per TARGET business day;
// Frankfurter mirrors that cadence with roughly a one-day lag.
const FRANKFURTER_EXPECTED_DELAY_MINUTES = 24 * 60;

export function buildFrankfurterUrl(base: string, symbol: string): string {
  const url = new URL(FRANKFURTER_LATEST_URL);
  url.searchParams.set("base", base);
  url.searchParams.set("symbols", symbol);
  return url.toString();
}

type FrankfurterResponse = { amount: number; base: string; date: string; rates: Record<string, unknown> };

export function parseFrankfurterResponse(payload: unknown): FrankfurterResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new FrankfurterAdapterError("FRANKFURTER_MALFORMED_RESPONSE", "payload is not an object");
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.date !== "string") {
    throw new FrankfurterAdapterError("FRANKFURTER_MALFORMED_RESPONSE", "date field missing or not a string");
  }
  if (typeof obj.rates !== "object" || obj.rates === null) {
    throw new FrankfurterAdapterError("FRANKFURTER_MALFORMED_RESPONSE", "rates field missing or not an object");
  }
  return {
    amount: typeof obj.amount === "number" ? obj.amount : 1,
    base: typeof obj.base === "string" ? obj.base : "",
    date: obj.date,
    rates: obj.rates as Record<string, unknown>,
  };
}

export function normalizeFrankfurterObservation(
  mapping: FrankfurterPairMapping,
  response: FrankfurterResponse,
  fetchedAt: Date,
): NormalizedMarketMetric {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(response.date)) {
    throw new FrankfurterAdapterError("FRANKFURTER_INVALID_DATE", `unexpected date format: ${response.date}`);
  }
  const rawRate = response.rates[mapping.symbol];
  if (typeof rawRate !== "number" || !Number.isFinite(rawRate)) {
    throw new FrankfurterAdapterError(
      "FRANKFURTER_MISSING_RATE",
      `no numeric rate for ${mapping.symbol} in response (base=${response.base})`,
    );
  }
  return {
    metricKey: mapping.metricKey,
    value: rawRate,
    unit: mapping.unit,
    // Frankfurter (like FRED's and MOF's daily series) gives only a
    // calendar date, never a time of day -- observedAt stays null and
    // timePrecision is "date", never a fabricated intraday timestamp.
    observedDate: response.date,
    observedAt: null,
    timePrecision: "date",
    fetchedAt: fetchedAt.toISOString(),
    sourceKey: FRANKFURTER_SOURCE_KEY,
    provider: "Frankfurter",
    sourceUrl: buildFrankfurterUrl(mapping.base, mapping.symbol),
    isDelayed: true,
    delayMinutes: FRANKFURTER_EXPECTED_DELAY_MINUTES,
    qualityTier: "trusted_free",
    isOfficial: false,
    metadata: {
      base: mapping.base,
      symbol: mapping.symbol,
      underlyingSource: FRANKFURTER_UNDERLYING_SOURCE,
    },
  };
}

export type FetchFrankfurterFxMetricsParams = {
  mappings?: FrankfurterPairMapping[];
  fetchedAt?: Date;
  timeoutMs?: number;
};

export async function fetchFrankfurterFxMetrics(
  params: FetchFrankfurterFxMetricsParams = {},
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedMarketMetric[]> {
  const mappings = params.mappings ?? FRANKFURTER_PAIR_MAPPINGS;
  const fetchedAt = params.fetchedAt ?? new Date();
  const results: NormalizedMarketMetric[] = [];

  for (const mapping of mappings) {
    const url = buildFrankfurterUrl(mapping.base, mapping.symbol);
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(params.timeoutMs ?? 15_000) });
    } catch (error) {
      throw new FrankfurterAdapterError("FRANKFURTER_FETCH_FAILED", `${mapping.metricKey}: ${String(error)}`);
    }
    if (!response.ok) {
      throw new FrankfurterAdapterError("FRANKFURTER_HTTP_ERROR", `${mapping.metricKey}: status=${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new FrankfurterAdapterError("FRANKFURTER_MALFORMED_RESPONSE", `${mapping.metricKey}: invalid JSON`);
    }
    const parsed = parseFrankfurterResponse(payload);
    results.push(normalizeFrankfurterObservation(mapping, parsed, fetchedAt));
  }

  return results;
}
