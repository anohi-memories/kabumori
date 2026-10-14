// Shadow (Phase 1) producer of market_data_packet.v1.
//
// Reads only: Yahoo daily charts, market_holidays, MIC market_metrics /
// mic_metric_domain_map, and important_news_candidates (ids and metadata).
// Writes only through claim/complete/fail_market_report_cycle. It never calls
// OpenAI, X, the push dispatcher, x-test-post, personalized-reports or
// important-news-monitor, and nothing consumes its packets yet.
//
// Auth: verify_jwt = false + X-Cron-Secret, compared with the existing
// SEND_PUSH_NOTIFICATIONS_CRON_SECRET (same convention as personalized-reports;
// no new secret). Diagnostics hold only codes and HTTP statuses.

import { buildMarketDataPacket, type NewsCandidateRow, packetContentHash, type YahooFetchResult } from "./packet_builder.ts";
import type { StoredPacketRow } from "./session_reuse.ts";
import type { MicMetricRow, MicThresholdRow } from "./mic_metrics.ts";
import {
  METRIC_SPECS,
  type MicSpec,
  specsFor,
  TOPIX_YAHOO_SYMBOLS,
  type TopixYahooSymbol,
  validateMarketDataPacket,
  type YahooSpec,
} from "./packet_schema.ts";
import { addDays, decideRunWindow, newsWindowStart, type ReportType } from "./session_logic.ts";
import { parseDailyChart, yahooDailyUrl } from "./yahoo_daily.ts";

export type Deps = {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  now: () => Date;
};

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const YAHOO_TIMEOUT_MS = 15_000;
const MIC_LOOKBACK_DAYS = 45;
// Enough to cover the sessions a packet may need an already-stored value from.
const STORED_PACKET_LOOKBACK_DAYS = 7;
const STORED_PACKET_LIMIT = 8;

/**
 * TOPIX index candidate source (2026-10-14). Unset, "off" or anything unknown: no "topix" metric (the packet is exactly
 * as before). "yahoo:^TOPX" / "yahoo:998405.T": also fetch that Yahoo chart symbol. Keep it off in production until the
 * Yahoo terms and the JPX index license allow showing TOPIX (docs/market-report-shared-platform/F2_TOPIX_DIRECT.md).
 */
export const TOPIX_SOURCE_ENV = "KABUMORI_MARKET_DATA_TOPIX_SOURCE";

export function topixSource(raw: string | undefined): { symbol: TopixYahooSymbol | null; diagnostic: string } {
  const value = (raw ?? "").trim();
  if (value === "" || value === "off") return { symbol: null, diagnostic: "off" };
  const symbol = TOPIX_YAHOO_SYMBOLS.find((candidate) => value === `yahoo:${candidate}`);
  return symbol ? { symbol, diagnostic: value } : { symbol: null, diagnostic: "unknown_value_off" };
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "UNEXPECTED_ERROR";
  return /^[A-Za-z0-9_:.-]+$/.test(value) ? value.slice(0, 120) : "UNEXPECTED_ERROR";
}

function secretKey(env: Deps["env"]): string | null {
  const raw = env("SUPABASE_SECRET_KEYS");
  if (!raw) return null;
  try {
    const value = (JSON.parse(raw) as Record<string, unknown>)["default"];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

type Db = {
  get<T>(path: string): Promise<T>;
  rpc<T>(name: string, args: Record<string, unknown>): Promise<T>;
};

function database(deps: Deps, supabaseUrl: string, key: string): Db {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  return {
    async get<T>(path: string) {
      const result = await deps.fetch(`${supabaseUrl}/rest/v1/${path}`, { headers });
      if (!result.ok) throw new Error(`REST_GET_FAILED:${path.split("?")[0]}:${result.status}`);
      return await result.json() as T;
    },
    async rpc<T>(name: string, args: Record<string, unknown>) {
      const result = await deps.fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
        method: "POST", headers, body: JSON.stringify(args),
      });
      if (!result.ok) throw new Error(`RPC_FAILED:${name}:${result.status}`);
      const text = await result.text();
      return (text ? JSON.parse(text) : null) as T;
    },
  };
}

async function fetchYahoo(
  deps: Deps,
  symbol: string,
): Promise<{ result: YahooFetchResult; fetchedAt: string; diagnostic: string }> {
  try {
    const response = await deps.fetch(yahooDailyUrl(symbol), {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
    });
    const fetchedAt = deps.now().toISOString();
    if (!response.ok) return { result: { ok: false }, fetchedAt, diagnostic: `http_${response.status}` };
    return { result: { ok: true, payload: await response.json() }, fetchedAt, diagnostic: "ok" };
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    return { result: { ok: false }, fetchedAt: deps.now().toISOString(), diagnostic: timeout ? "timeout" : "network_error" };
  }
}

async function attempt<T>(label: string, diagnostics: Record<string, string>, run: () => Promise<T>): Promise<T | null> {
  try {
    const value = await run();
    diagnostics[label] = "ok";
    return value;
  } catch (error) {
    diagnostics[label] = safeCode(error);
    return null;
  }
}

type ClaimRow = { cycle_id: string; claim_token: string | null; attempt: number; outcome: string };
type CompleteRow = { packet_id: string; cycle_status: string };

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return respond({ error: "METHOD_NOT_ALLOWED" }, 405);
  const expectedSecret = deps.env("SEND_PUSH_NOTIFICATIONS_CRON_SECRET");
  if (!expectedSecret || req.headers.get("X-Cron-Secret") !== expectedSecret) {
    return respond({ error: "UNAUTHORIZED" }, 401);
  }
  const supabaseUrl = deps.env("SUPABASE_URL");
  const key = secretKey(deps.env);
  if (!supabaseUrl || !key) return respond({ error: "MISSING_CONFIGURATION" }, 500);

  let body: { mode?: unknown; dry_run?: unknown; topix_source?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const reportType: ReportType | null = body.mode === "morning" || body.mode === "close" ? body.mode : null;
  if (!reportType) return respond({ error: "INVALID_MODE" }, 400);
  const dryRun = body.dry_run === true;

  const db = database(deps, supabaseUrl, key);
  const asOf = deps.now();

  let jpxHolidays: Set<string>;
  let nyseHolidays: Set<string>;
  let nyseCalendarLastDate: string | null;
  try {
    const from = `${asOf.getUTCFullYear() - 1}-12-01`;
    const rows = await db.get<Array<{ market: string; holiday_date: string }>>(
      `market_holidays?select=market,holiday_date&market=in.(JPX,NYSE)&holiday_date=gte.${from}`,
    );
    jpxHolidays = new Set(rows.filter((row) => row.market === "JPX").map((row) => row.holiday_date));
    const nyse = rows.filter((row) => row.market === "NYSE").map((row) => row.holiday_date).sort();
    nyseHolidays = new Set(nyse);
    nyseCalendarLastDate = nyse.length > 0 ? `${nyse[nyse.length - 1].slice(0, 4)}-12-31` : null;
  } catch (error) {
    return respond({ status: "failed", error: safeCode(error) }, 500);
  }

  const window = decideRunWindow(reportType, asOf, jpxHolidays);
  if (!window.run) return respond({ status: "skipped", reason: window.reason, reportType, tradingDate: window.tradingDate });
  const tradingDate = window.tradingDate;

  let claim: ClaimRow | null = null;
  if (!dryRun) {
    try {
      const rows = await db.rpc<ClaimRow[]>("claim_market_report_cycle", {
        p_report_type: reportType,
        p_trading_date: tradingDate,
        p_scheduled_for: asOf.toISOString(),
      });
      claim = rows?.[0] ?? null;
    } catch (error) {
      return respond({ status: "failed", error: safeCode(error), reportType, tradingDate }, 500);
    }
    if (!claim || claim.outcome !== "claimed" || !claim.claim_token) {
      return respond({ status: "skipped", reason: claim?.outcome ?? "CLAIM_EMPTY", reportType, tradingDate });
    }
  }

  const diagnostics: Record<string, string> = {};
  try {
    // A dry run (no write) may name the candidate itself, so a symbol can be checked without changing the Secret.
    const topix = topixSource(
      dryRun && typeof body.topix_source === "string" ? body.topix_source : deps.env(TOPIX_SOURCE_ENV),
    );
    // Recorded only when set, so a run with the switch off stores exactly what it stored before.
    if (topix.diagnostic !== "off") diagnostics.topix_source = topix.diagnostic;
    const yahooSpecs = specsFor(reportType, topix.symbol).filter((spec): spec is YahooSpec => spec.source === "yahoo_daily");
    const micKeys = METRIC_SPECS.filter((spec): spec is MicSpec =>
      spec.source === "mic" && spec.reportTypes.includes(reportType)
    ).map((spec) => spec.micKey);
    const windowStart = newsWindowStart(tradingDate, jpxHolidays);
    const micSince = addDays(tradingDate, -MIC_LOOKBACK_DAYS);

    const [yahooResults, micRows, micThresholds, newsRows, storedPackets] = await Promise.all([
      Promise.all(yahooSpecs.map(async (spec) => [spec.symbol, await fetchYahoo(deps, spec.symbol)] as const)),
      attempt("mic_metrics", diagnostics, () =>
        db.get<MicMetricRow[]>(
          "market_metrics?select=metric_key,value,observed_date,observed_at,fetched_at,provider,source_url,quality_tier" +
            `&metric_key=in.(${micKeys.join(",")})&observed_date=gte.${micSince}` +
            "&order=observed_date.desc,fetched_at.desc&limit=500",
        )),
      attempt("mic_thresholds", diagnostics, () =>
        db.get<MicThresholdRow[]>(
          `mic_metric_domain_map?select=metric_key,expected_observation_lag_minutes&metric_key=in.(${micKeys.join(",")})`,
        )),
      attempt("news_refs", diagnostics, () =>
        db.get<NewsCandidateRow[]>(
          "important_news_candidates?select=id,source_type,company_code,coverage_severity,coverage_categories," +
            "emergency_class,published_at,created_at,source_url,fact_check_status,duplicate_of" +
            "&duplicate_of=is.null&fact_check_status=eq.passed&coverage_severity=in.(emergency,critical,high,medium)" +
            `&created_at=gte.${encodeURIComponent(windowStart.toISOString())}` +
            `&created_at=lte.${encodeURIComponent(asOf.toISOString())}` +
            "&order=created_at.desc&limit=30",
        )),
      attempt("stored_packets", diagnostics, () =>
        db.get<StoredPacketRow[]>(
          "market_data_packets?select=id,content_hash,data_quality_status,payload" +
            `&trading_date=gte.${addDays(tradingDate, -STORED_PACKET_LOOKBACK_DAYS)}` +
            `&data_quality_status=in.(ok,partial)&order=created_at.desc&limit=${STORED_PACKET_LIMIT}`,
        )),
    ]);
    for (const [symbol, fetched] of yahooResults) diagnostics[`yahoo:${symbol}`] = fetched.diagnostic;

    const packet = buildMarketDataPacket({
      reportType,
      tradingDate,
      asOf,
      generatedAt: deps.now(),
      jpxHolidays,
      nyseHolidays,
      nyseCalendarLastDate,
      yahoo: new Map(yahooResults.map(([symbol, fetched]) => [symbol, fetched])),
      micRows,
      micThresholds: micThresholds ?? [],
      newsRows,
      newsWindowStart: windowStart,
      storedPackets: storedPackets ?? [],
      topixSymbol: topix.symbol,
    });
    const issues = validateMarketDataPacket(packet);
    const contentHash = await packetContentHash(packet);

    if (dryRun) {
      // What Yahoo itself reported for the TOPIX candidate (identity and the last bars), to check a symbol by hand.
      const topixFetch = topix.symbol ? yahooResults.find(([symbol]) => symbol === topix.symbol)?.[1].result : undefined;
      const topixChart = topixFetch?.ok ? parseDailyChart(topixFetch.payload) : null;
      const topixProbe = topixChart ? { ...topixChart, bars: topixChart.bars.slice(-3) } : null;
      return respond({ status: "dry_run", reportType, tradingDate, issues, contentHash, diagnostics, packet, topixProbe });
    }
    if (issues.length > 0) {
      await db.rpc("fail_market_report_cycle", {
        p_cycle_id: claim!.cycle_id,
        p_claim_token: claim!.claim_token,
        p_error: "PACKET_SCHEMA_INVALID",
        p_diagnostics: { ...diagnostics, validation: issues.join(",").slice(0, 500) },
      });
      return respond({ status: "failed", error: "PACKET_SCHEMA_INVALID", issues, reportType, tradingDate }, 500);
    }

    const completed = await db.rpc<CompleteRow[]>("complete_market_report_cycle", {
      p_cycle_id: claim!.cycle_id,
      p_claim_token: claim!.claim_token,
      p_payload: packet,
      p_content_hash: contentHash,
      p_as_of: packet.as_of,
      p_generated_at: packet.generated_at,
      p_diagnostics: diagnostics,
    });
    return respond({
      status: completed?.[0]?.cycle_status ?? "unknown",
      reportType,
      tradingDate,
      attempt: claim!.attempt,
      packetId: completed?.[0]?.packet_id ?? null,
      dataQuality: packet.data_quality.status,
      requiredMissing: packet.data_quality.required_missing,
      contentHash,
      diagnostics,
    });
  } catch (error) {
    const code = safeCode(error);
    if (claim?.claim_token) {
      await db.rpc("fail_market_report_cycle", {
        p_cycle_id: claim.cycle_id,
        p_claim_token: claim.claim_token,
        p_error: code,
        p_diagnostics: diagnostics,
      }).catch(() => {});
    }
    return respond({ status: "failed", error: code, reportType, tradingDate }, 500);
  }
}
