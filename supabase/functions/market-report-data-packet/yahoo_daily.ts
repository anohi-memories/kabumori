// Yahoo chart daily bars → metrics. Yahoo is an interim, uncontracted source
// (quality "unofficial_delayed"); provider, URL and timestamps are kept per
// metric so it can be replaced later without changing the packet shape.
//
// Closing values come from daily bars plus the session check below. One-minute
// bars are never used: their timestamps are bar-open times, so the last bar of
// a Tokyo session is 15:29 (^N225) or 15:24 (1306.T) and a ">= 15:30" test on
// them fails every day (DESIGN.md §1.5).

import { JPX_SESSION, localParts, NYSE_SESSION, type SessionSpec, zonedInstant } from "./session_logic.ts";
import type { Metric, YahooSpec } from "./packet_schema.ts";

export const YAHOO_PROVIDER = "yahoo_chart";

export function yahooDailyUrl(symbol: string): string {
  return `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d&events=history`;
}

export type DailyBar = { sessionDate: string; close: number };

export type ParsedDailyChart = {
  symbol: string | null;
  currency: string | null;
  timezone: string | null;
  instrumentType: string | null;
  regularMarketTime: string | null;
  bars: DailyBar[];
};

type ChartPayload = {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: unknown;
        currency?: unknown;
        exchangeTimezoneName?: unknown;
        instrumentType?: unknown;
        regularMarketTime?: unknown;
      };
      timestamp?: unknown;
      indicators?: { quote?: Array<{ close?: unknown }> };
    } | null>;
  };
};

const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

export function parseDailyChart(payload: unknown): ParsedDailyChart | null {
  const result = (payload as ChartPayload)?.chart?.result?.[0];
  if (!result || typeof result !== "object") return null;
  const meta = result.meta ?? {};
  const timezone = text(meta.exchangeTimezoneName);
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = result.indicators?.quote?.[0]?.close;
  if (!timezone || !Array.isArray(closes)) return null;

  // One bar per session date; a later duplicate (Yahoo sometimes appends the
  // live bar again) replaces the earlier one.
  const byDate = new Map<string, number>();
  const length = Math.min(timestamps.length, closes.length);
  for (let index = 0; index < length; index += 1) {
    const stamp = timestamps[index];
    const close = closes[index];
    if (typeof stamp !== "number" || !Number.isFinite(stamp)) continue;
    if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) continue;
    // Yahoo returns binary floats (423.8999938964844); prices never need more than 4 decimals.
    byDate.set(localParts(new Date(stamp * 1000), timezone).date, round(close, 4));
  }
  const bars = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sessionDate, close]) => ({ sessionDate, close }));
  const marketTime = typeof meta.regularMarketTime === "number" && Number.isFinite(meta.regularMarketTime)
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : null;
  return {
    symbol: text(meta.symbol),
    currency: text(meta.currency),
    timezone,
    instrumentType: text(meta.instrumentType),
    regularMarketTime: marketTime,
    bars,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sessionSpec(spec: YahooSpec): SessionSpec {
  return spec.session === "jpx" ? JPX_SESSION : NYSE_SESSION;
}

type FetchOutcome = { ok: true; payload: unknown } | { ok: false };

function unavailable(
  spec: YahooSpec,
  expectedSessionDate: string,
  required: boolean,
  gapReason: Metric["gap_reason"],
  fetchedAt: string | null,
): Metric {
  return {
    key: spec.key,
    label: spec.label,
    kind: spec.kind,
    value: null,
    previous_close: null,
    change: null,
    change_pct: null,
    currency: spec.currency,
    unit: spec.unit,
    session_date: null,
    expected_session_date: expectedSessionDate,
    observed_at: null,
    fetched_at: fetchedAt,
    provider: YAHOO_PROVIDER,
    source_url: yahooDailyUrl(spec.symbol),
    basis: "daily_close",
    freshness: "unavailable",
    quality: "unofficial_delayed",
    is_proxy: spec.isProxy,
    proxy_for: spec.proxyFor,
    required,
    gap_reason: gapReason,
  };
}

/**
 * The metric for `expectedSessionDate`, or an unavailable metric. A value is
 * accepted only when the chart identity matches and that session is known to
 * be closed: either a later session's bar exists, or regularMarketTime is on
 * the session date at or after the session close. A previous session's close
 * is never substituted.
 */
export function yahooMetric(
  spec: YahooSpec,
  outcome: FetchOutcome,
  expectedSessionDate: string,
  required: boolean,
  fetchedAt: string,
): Metric {
  if (!outcome.ok) return unavailable(spec, expectedSessionDate, required, "fetch_failed", fetchedAt);
  const chart = parseDailyChart(outcome.payload);
  if (!chart) return unavailable(spec, expectedSessionDate, required, "invalid_value", fetchedAt);
  if (
    chart.symbol !== spec.expect.symbol || chart.currency !== spec.expect.currency ||
    chart.timezone !== spec.expect.timezone || chart.instrumentType !== spec.expect.instrumentType
  ) {
    return unavailable(spec, expectedSessionDate, required, "identity_mismatch", fetchedAt);
  }

  const index = chart.bars.findIndex((bar) => bar.sessionDate === expectedSessionDate);
  if (index < 0) return unavailable(spec, expectedSessionDate, required, "expected_session_not_available", fetchedAt);

  const session = sessionSpec(spec);
  const laterBarExists = index < chart.bars.length - 1;
  const market = chart.regularMarketTime ? localParts(new Date(chart.regularMarketTime), session.timezone) : null;
  const closedByMarketTime = Boolean(
    market && market.date === expectedSessionDate && market.minutes >= session.closeMinutes,
  );
  if (!laterBarExists && !closedByMarketTime) {
    return unavailable(spec, expectedSessionDate, required, "session_not_closed", fetchedAt);
  }

  const value = chart.bars[index].close;
  const previous = index > 0 ? chart.bars[index - 1].close : null;
  const change = previous === null ? null : round(value - previous, 4);
  const changePct = previous === null ? null : round(((value - previous) / previous) * 100, 2);
  const observedAt = closedByMarketTime
    ? chart.regularMarketTime
    : zonedInstant(expectedSessionDate, session.closeMinutes, session.timezone).toISOString();

  return {
    key: spec.key,
    label: spec.label,
    kind: spec.kind,
    value,
    previous_close: previous,
    change,
    change_pct: changePct,
    currency: spec.currency,
    unit: spec.unit,
    session_date: expectedSessionDate,
    expected_session_date: expectedSessionDate,
    observed_at: observedAt,
    fetched_at: fetchedAt,
    provider: YAHOO_PROVIDER,
    source_url: yahooDailyUrl(spec.symbol),
    basis: "daily_close",
    freshness: "fresh",
    quality: "unofficial_delayed",
    is_proxy: spec.isProxy,
    proxy_for: spec.proxyFor,
    required,
    gap_reason: null,
  };
}
