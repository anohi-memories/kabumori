import type { RawMorningMetric } from "./morning_report_logic.ts";

export const YAHOO_NIKKEI_CLOSE_URL =
  "https://query2.finance.yahoo.com/v8/finance/chart/%5EN225?range=5d&interval=1m&events=history";
export const YAHOO_TOPIX_CLOSE_URL =
  "https://query2.finance.yahoo.com/v8/finance/chart/%5ETPX?range=5d&interval=1m&events=history";
export const YAHOO_TOPIX_ETF_CLOSE_URL =
  "https://query2.finance.yahoo.com/v8/finance/chart/1306.T?range=5d&interval=1m&events=history";
export const TOPIX_PROXY_LABEL = "TOPIX連動ETF（1306）";

type YahooChartResult = {
  meta?: { chartPreviousClose?: number; previousClose?: number; symbol?: string; exchangeName?: string; fullExchangeName?: string; currency?: string };
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

function hasJapaneseTopixIdentity(result: YahooChartResult | null | undefined): boolean {
  const meta = result?.meta;
  if (!meta) return false;
  const symbol = typeof meta.symbol === "string" ? meta.symbol : "";
  const exchange = `${meta.exchangeName ?? ""} ${meta.fullExchangeName ?? ""}`;
  return /topix/i.test(symbol) && /jpx|tokyo|japan/i.test(exchange) && meta.currency === "JPY";
}

function hasJapaneseTopixEtfIdentity(result: YahooChartResult | null | undefined): boolean {
  const meta = result?.meta;
  if (!meta) return false;
  const symbol = typeof meta.symbol === "string" ? meta.symbol.toUpperCase() : "";
  const exchange = `${meta.exchangeName ?? ""} ${meta.fullExchangeName ?? ""}`;
  return symbol === "1306.T" && /jpx|tokyo|japan/i.test(exchange) && meta.currency === "JPY";
}

export async function fetchYahooJpxCloseMetric(
  url: string,
  label: string,
  referenceIso: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RawMorningMetric | null> {
  // Yahoo's ^TPX endpoint is not a reliable TOPIX source: it has returned
  // an OPRA/CBO USD instrument with no Tokyo-session timestamps. Never allow
  // that endpoint to be relabeled as the Japanese TOPIX.
  if (url === YAHOO_TOPIX_CLOSE_URL) return null;
  // 1306.T is accepted only under its explicit ETF label; it must never be
  // represented as the TOPIX index itself.
  if (url === YAHOO_TOPIX_ETF_CLOSE_URL && label !== TOPIX_PROXY_LABEL) return null;
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const body = await response.json() as YahooChartResponse;
    const result = body.chart?.result?.[0];
    if (label === "TOPIX" && !hasJapaneseTopixIdentity(result)) return null;
    if (label === TOPIX_PROXY_LABEL && !hasJapaneseTopixEtfIdentity(result)) return null;
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
  const topixProxy = await fetchYahooJpxCloseMetric(YAHOO_TOPIX_ETF_CLOSE_URL, TOPIX_PROXY_LABEL, referenceIso, fetchImpl);
  return { nikkei, topix: topixProxy };
}
