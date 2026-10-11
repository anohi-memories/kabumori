// 定時の個別レポート（personalized-reports）とオンデマンド分析の worker（personalized-analysis-worker）が
// 共有する、利用者ごとの入力: 保有・ウォッチの銘柄、Fact 確認済みのニュースの入力、Yahoo の日足の終値。
// 2026-10-11 に index.ts から中身を変えずに移した（両方が同じスナップショットの入力を作るため）。
import { parseYahooDaily, type NewsInput, type PriceSeries, type TrackedInput } from "./report_logic.ts";

const YAHOO_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/";
const PRICE_CONCURRENCY = 6;

/** PostgREST select for tracked_stocks rows consumed by toTracked. */
export const TRACKED_SELECT = "id,user_id,tracking_type,quantity,average_price,position_type,side," +
  "stock:stocks_master(ticker_code,company_name,sector)";

export type TrackedRow = {
  id: string;
  user_id: string;
  tracking_type: "holding" | "watch";
  quantity: number | string | null;
  average_price: number | string | null;
  position_type: "cash" | "margin" | null;
  side: "long" | "short" | null;
  stock: { ticker_code: string; company_name: string; sector: string | null } | null;
};

export type NewsRow = {
  news_id: string;
  ticker_code: string | null;
  company_name: string;
  tracking_type: "holding" | "watch";
  severity: string;
  matched_sectors: string[] | null;
  news_time: string;
  source_url: string | null;
  source_type: string | null;
  text_origin: NewsInput["textOrigin"];
  headline_ja: string;
  summary_ja: string | null;
  key_points_ja: unknown;
};

function toNumber(value: number | string | null): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function toTracked(row: TrackedRow): TrackedInput | null {
  if (!row.stock?.ticker_code) return null;
  return {
    trackedStockId: row.id,
    tickerCode: row.stock.ticker_code,
    companyName: row.stock.company_name,
    sector: row.stock.sector,
    trackingType: row.tracking_type,
    quantity: toNumber(row.quantity),
    averagePrice: toNumber(row.average_price),
    positionType: row.position_type,
    side: row.side,
  };
}

export function toNews(row: NewsRow): NewsInput {
  return {
    newsId: row.news_id,
    tickerCode: row.ticker_code,
    companyName: row.company_name,
    trackingType: row.tracking_type,
    severity: row.severity,
    matchedSectors: Array.isArray(row.matched_sectors) ? row.matched_sectors : [],
    newsTime: row.news_time,
    sourceUrl: row.source_url,
    sourceType: row.source_type,
    textOrigin: row.text_origin,
    headlineJa: row.headline_ja,
    summaryJa: row.summary_ja,
    keyPointsJa: Array.isArray(row.key_points_ja)
      ? row.key_points_ja.filter((point): point is string => typeof point === "string")
      : [],
  };
}

export async function fetchSeries(symbol: string, fetchImpl: typeof fetch = fetch): Promise<PriceSeries | null> {
  try {
    const result = await fetchImpl(
      `${YAHOO_CHART_URL}${encodeURIComponent(symbol)}?range=1mo&interval=1d&events=history`,
      { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) },
    );
    if (!result.ok) return null;
    return parseYahooDaily(await result.json());
  } catch {
    return null;
  }
}

export async function fetchAllSeries(
  symbols: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, PriceSeries | null>> {
  const results = new Map<string, PriceSeries | null>();
  const queue = [...new Set(symbols)];
  const workers = Array.from({ length: Math.min(PRICE_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const symbol = queue.shift()!;
      results.set(symbol, await fetchSeries(symbol, fetchImpl));
    }
  });
  await Promise.all(workers);
  return results;
}
