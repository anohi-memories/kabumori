// Read-only loader for stocks_master (existing table, not modified). PostgREST returns at most
// 1,000 rows per request by default, so the loader pages with Range headers.
import type { StockMasterRow } from "../_shared/news_discovery/company_alias.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function loadListedStocks(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: FetchLike = fetch,
  pageSize = 1000,
  maxRows = 20_000,
): Promise<StockMasterRow[]> {
  const base = supabaseUrl.replace(/\/+$/, "");
  const rows: StockMasterRow[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const response = await fetchImpl(
      `${base}/rest/v1/stocks_master?select=ticker_code,company_name,is_listed&is_listed=eq.true&order=ticker_code.asc`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Range-Unit": "items",
          Range: `${from}-${from + pageSize - 1}`,
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok && response.status !== 206) throw new Error(`STOCKS_MASTER_READ_FAILED:${response.status}`);
    const page = await response.json() as StockMasterRow[];
    if (!Array.isArray(page)) throw new Error("STOCKS_MASTER_BAD_RESPONSE");
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}
