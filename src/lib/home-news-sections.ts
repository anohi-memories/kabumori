// Splits the single get_my_important_stock_news feed into the home screen's
// two news sections. The RPC already orders items by severity/freshness, so
// this only filters and caps -- it never re-fetches or re-sorts.
//
// This module has no RN imports so it can be tested with Deno and bundled by Metro.

import type { ImportantStockNews } from '@/lib/important-news';

export type HomeNewsSections = {
  market: ImportantStockNews[];
  holding: ImportantStockNews[];
};

const SECTION_LIMIT = 3;

export function splitHomeNewsSections(items: readonly ImportantStockNews[]): HomeNewsSections {
  const market: ImportantStockNews[] = [];
  const holding: ImportantStockNews[] = [];
  for (const item of items) {
    if (item.tracking_type === 'market' && market.length < SECTION_LIMIT) market.push(item);
    else if (item.tracking_type === 'holding' && holding.length < SECTION_LIMIT) holding.push(item);
    if (market.length >= SECTION_LIMIT && holding.length >= SECTION_LIMIT) break;
  }
  return { market, holding };
}
