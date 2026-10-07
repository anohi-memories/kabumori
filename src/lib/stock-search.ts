export type StockScreenMode = 'list' | 'search';

export function stockScreenMode(query: string): StockScreenMode {
  return query.trim() ? 'search' : 'list';
}

// Stock search, shared by the dedicated 検索 screen. These are the semantics the 銘柄 tab used before the
// search moved to its own screen: unchanged, only extracted so they are pinned by tests.

/** Search starts this long after the last keystroke. */
export const STOCK_SEARCH_DEBOUNCE_MS = 350;

/** At most this many results. */
export const STOCK_SEARCH_LIMIT = 30;

export const STOCK_SEARCH_PROMPT = '銘柄コードまたは会社名を入力してください。';

/** PostgREST `or(...)` separators and wildcards are blanked so user input can never alter the filter. */
export function sanitizeStockSearchTerm(term: string): string {
  return term.replace(/[,%()]/g, ' ').trim();
}

/** The `or` filter: ticker code or company name contains the (sanitized) term, case-insensitive. */
export function stockSearchFilter(term: string): string {
  const escaped = sanitizeStockSearchTerm(term);
  return `ticker_code.ilike.%${escaped}%,company_name.ilike.%${escaped}%`;
}
