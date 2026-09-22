export type StockScreenMode = 'list' | 'search';

export function stockScreenMode(query: string): StockScreenMode {
  return query.trim() ? 'search' : 'list';
}
