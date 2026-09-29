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

// --- Reliability (2026-09-29) ------------------------------------------------
// Production evidence (mic_ingestion_runs, 2026-09-22..29): the 25 series
// were fetched one after another at ~4-5 s each, so a successful run took
// 108-144 s -- against the 150 s limit of the pg_net call / Edge request that
// runs it. Twice a slower run was cut off mid-flight and left 'running' until
// another source's stale sweep marked it MIC_STALE_RUN_TERMINATION; four times
// a single transient FRED 502 (DGS2, DGS10, NIKKEI225) failed the whole run.
//
// Now: bounded concurrency, bounded retry of transient failures only, and a
// hard deadline for the whole fetch phase so the run always reaches its own
// complete/fail write well inside the platform limit. Run semantics are
// unchanged: every series must succeed or the run fails (no partial success,
// see FetchFredMetricsParams); retries never write anything, because
// persistence happens only after the whole fetch phase returns.
export const FRED_FETCH_CONCURRENCY = 4;
export const FRED_MAX_ATTEMPTS = 3;
export const FRED_ATTEMPT_TIMEOUT_MS = 15_000;
// Whole fetch phase. Leaves >= 60 s of the 150 s limit for the claim, the
// stale sweep, the metric/event writes (~2 s observed) and the run's own
// completed/failed write.
export const FRED_FETCH_BUDGET_MS = 90_000;
const FRED_BACKOFF_BASE_MS = 500;
// A longer wait (e.g. a Retry-After asking for a minute) is not honored by
// retrying early: the series fails instead.
const FRED_MAX_RETRY_DELAY_MS = 5_000;
// Never start an attempt with less time than this left before the deadline.
const FRED_MIN_ATTEMPT_MS = 1_000;
const FRED_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export type FetchFredMetricsParams = {
  apiKey: string;
  mappings?: FredSeriesMapping[];
  fetchedAt?: Date;
  // Per-attempt timeout (capped by the remaining budget).
  timeoutMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  budgetMs?: number;
  // Injectable for tests.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type FredAttemptFailure = { code: string; detail: string; retryable: boolean; retryAfterMs: number | null };

function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function fetchFredSeriesOnce(
  mapping: FredSeriesMapping,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<{ ok: true; observation: FredObservation } | { ok: false; failure: FredAttemptFailure }> {
  const url = buildFredObservationsUrl(mapping.seriesId, apiKey, 5, mapping.units);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // Network error or per-attempt timeout: both transient.
    const detail = isAbort(error) ? `timeout after ${timeoutMs}ms` : "network error";
    return { ok: false, failure: { code: "FRED_FETCH_FAILED", detail, retryable: true, retryAfterMs: null } };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      failure: {
        code: "FRED_HTTP_ERROR",
        detail: `status=${response.status}`,
        retryable: FRED_RETRYABLE_STATUS.has(response.status),
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"), nowMs),
      },
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    // The body timing out mid-read is transient; a complete but unparsable
    // body is not.
    if (isAbort(error)) {
      return { ok: false, failure: { code: "FRED_FETCH_FAILED", detail: `timeout after ${timeoutMs}ms`, retryable: true, retryAfterMs: null } };
    }
    return { ok: false, failure: { code: "FRED_MALFORMED_RESPONSE", detail: "invalid JSON", retryable: false, retryAfterMs: null } };
  }
  let latest: FredObservation | null;
  try {
    latest = latestValidFredObservation(parseFredObservations(payload));
  } catch (error) {
    const code = error instanceof FredAdapterError ? error.code : "FRED_MALFORMED_RESPONSE";
    return { ok: false, failure: { code, detail: "malformed observations", retryable: false, retryAfterMs: null } };
  }
  if (!latest) {
    return { ok: false, failure: { code: "FRED_NO_VALID_OBSERVATION", detail: "no non-missing observation", retryable: false, retryAfterMs: null } };
  }
  return { ok: true, observation: latest };
}

// One series with bounded retry inside the shared deadline.
async function fetchFredSeriesWithRetry(
  mapping: FredSeriesMapping,
  params: Required<Pick<FetchFredMetricsParams, "apiKey" | "now" | "sleep">> & {
    timeoutMs: number;
    maxAttempts: number;
    deadline: number;
  },
  fetchImpl: typeof fetch,
): Promise<{ ok: true; observation: FredObservation } | { ok: false; failure: FredAttemptFailure; attempts: number }> {
  let attempts = 0;
  let last: FredAttemptFailure | null = null;
  while (attempts < params.maxAttempts) {
    const remaining = params.deadline - params.now();
    if (remaining < FRED_MIN_ATTEMPT_MS) {
      last = last ?? { code: "FRED_DEADLINE_EXCEEDED", detail: "fetch budget exhausted", retryable: false, retryAfterMs: null };
      break;
    }
    attempts += 1;
    const outcome = await fetchFredSeriesOnce(
      mapping,
      params.apiKey,
      Math.min(params.timeoutMs, remaining),
      fetchImpl,
      params.now(),
    );
    if (outcome.ok) return outcome;
    last = outcome.failure;
    if (!last.retryable || attempts >= params.maxAttempts) break;
    const backoff = Math.min(FRED_BACKOFF_BASE_MS * 2 ** (attempts - 1), FRED_MAX_RETRY_DELAY_MS);
    const delay = last.retryAfterMs ?? backoff;
    if (delay > FRED_MAX_RETRY_DELAY_MS) break;
    if (params.now() + delay + FRED_MIN_ATTEMPT_MS > params.deadline) break;
    await params.sleep(delay);
  }
  return { ok: false, failure: last!, attempts };
}

export async function fetchFredMetrics(
  params: FetchFredMetricsParams,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedMarketMetric[]> {
  const mappings = params.mappings ?? FRED_SERIES_MAPPINGS;
  const fetchedAt = params.fetchedAt ?? new Date();
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const settings = {
    apiKey: params.apiKey,
    now,
    sleep,
    timeoutMs: params.timeoutMs ?? FRED_ATTEMPT_TIMEOUT_MS,
    maxAttempts: Math.max(1, params.maxAttempts ?? FRED_MAX_ATTEMPTS),
    deadline: now() + (params.budgetMs ?? FRED_FETCH_BUDGET_MS),
  };
  const concurrency = Math.max(1, Math.min(params.concurrency ?? FRED_FETCH_CONCURRENCY, mappings.length || 1));

  // Results keep mapping order so writes stay deterministic.
  const observations: Array<FredObservation | null> = mappings.map(() => null);
  const failures: Array<{ seriesId: string; failure: FredAttemptFailure; attempts: number }> = [];
  let next = 0;
  const worker = async () => {
    while (next < mappings.length) {
      const index = next++;
      const mapping = mappings[index];
      // Once a series has definitively failed the run will fail; do not
      // spend further requests on the rest.
      if (failures.length > 0) return;
      const outcome = await fetchFredSeriesWithRetry(mapping, settings, fetchImpl);
      if (outcome.ok) observations[index] = outcome.observation;
      else failures.push({ seriesId: mapping.seriesId, failure: outcome.failure, attempts: outcome.attempts });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  if (failures.length > 0) {
    const [first, ...others] = failures;
    const extra = others.length > 0 ? `; also failed: ${others.map((f) => f.seriesId).join(",")}` : "";
    throw new FredAdapterError(
      first.failure.code,
      `${first.seriesId}: ${first.failure.detail} (attempts=${first.attempts})${extra}`,
    );
  }
  return mappings.map((mapping, index) => {
    const observation = observations[index];
    if (!observation) throw new FredAdapterError("FRED_FETCH_FAILED", `${mapping.seriesId}: not fetched`);
    return normalizeFredObservation(mapping, observation, fetchedAt);
  });
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
