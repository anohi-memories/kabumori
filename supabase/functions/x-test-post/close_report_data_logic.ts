import type { RawMorningMetric } from "./morning_report_logic.ts";

export const YAHOO_NIKKEI_CLOSE_URL =
  "https://query2.finance.yahoo.com/v8/finance/chart/%5EN225?range=5d&interval=1m&events=history";
export const YAHOO_TOPIX_CLOSE_URL =
  "https://query2.finance.yahoo.com/v8/finance/chart/%5ETPX?range=5d&interval=1m&events=history";

type YahooChartResult = {
  meta?: { chartPreviousClose?: number; previousClose?: number };
  timestamp?: number[];
  indicators?: { quote?: Array<{ close?: Array<number | null> }> };
};

type YahooChartResponse = {
  chart?: { result?: Array<YahooChartResult | null> };
};

function jstDateAndMinutes(value: string): { date: string; minutes: number } | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function latestClose(result: YahooChartResult | null | undefined): {
  value: number; timestamp: string;
} | null {
  if (!result || typeof result !== "object") return null;
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = result.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes)) return null;
  for (let index = Math.min(timestamps.length, closes.length) - 1; index >= 0; index -= 1) {
    const timestamp = timestamps[index];
    const value = closes[index];
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    return { value, timestamp: new Date(timestamp * 1000).toISOString() };
  }
  return null;
}

export async function fetchYahooJpxCloseMetric(
  url: string,
  label: string,
  referenceIso: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RawMorningMetric | null> {
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const body = await response.json() as YahooChartResponse;
    const result = body.chart?.result?.[0];
    const close = latestClose(result);
    if (!close) return null;
    const observed = jstDateAndMinutes(close.timestamp);
    const reference = jstDateAndMinutes(referenceIso);
    // The Tokyo Stock Exchange cash-session close is 15:30 JST. Values from
    // 15:00-15:29 are still intraday and must not be treated as the close.
    if (!observed || !reference || observed.date !== reference.date || observed.minutes < (15 * 60 + 30)) return null;
    const previous = result?.meta?.chartPreviousClose ?? result?.meta?.previousClose;
    return {
      label,
      value: String(close.value),
      previous_close: typeof previous === "number" && Number.isFinite(previous) ? String(previous) : "",
      change: "",
      change_percent: "",
      timestamp: close.timestamp,
      source_url: url,
    };
  } catch {
    return null;
  }
}

export async function fetchJpxCloseMetrics(
  referenceIso: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ nikkei: RawMorningMetric | null; topix: RawMorningMetric | null }> {
  const nikkei = await fetchYahooJpxCloseMetric(YAHOO_NIKKEI_CLOSE_URL, "日経平均", referenceIso, fetchImpl);
  const topix = await fetchYahooJpxCloseMetric(YAHOO_TOPIX_CLOSE_URL, "TOPIX", referenceIso, fetchImpl);
  return { nikkei, topix };
}
