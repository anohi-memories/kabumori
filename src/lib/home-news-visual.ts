// Chooses a fallback visual for a home news card. ImportantStockNews carries no
// image/thumbnail URL today (confirmed: the RPC and its type have no such
// field), so this never scrapes or guesses a URL -- it only picks a glyph
// deterministically from existing metadata (source_type, then coverage
// category, then a neutral default).
//
// `imageUrl` is included now, always null, so that if a real thumbnail field
// is ever added to the feed, the home cards can start showing it by filling
// this one field without changing every call site.
//
// This module has no RN imports so it can be tested with Deno and bundled by Metro.

export type HomeNewsVisual = {
  glyph: string;
  imageUrl: null;
};

const SOURCE_TYPE_GLYPH: Record<string, string> = {
  tdnet: '◆',
  company_ir: '◎',
  market_macro: '◈',
  breaking_market: '✦',
};

const CATEGORY_GLYPH: Record<string, string> = {
  earnings: '◆',
  corporate: '◎',
  monetary_policy: '◈',
  fx: '◈',
  rates: '◈',
  geopolitics: '✦',
  disaster: '✦',
};

const NEUTRAL_GLYPH = '›';

export function homeNewsVisual(
  item: { source_type?: string | null; coverage_categories?: string[] | null },
): HomeNewsVisual {
  const bySource = item.source_type ? SOURCE_TYPE_GLYPH[item.source_type] : undefined;
  if (bySource) return { glyph: bySource, imageUrl: null };

  const category = (item.coverage_categories ?? []).find((value) => value in CATEGORY_GLYPH);
  if (category) return { glyph: CATEGORY_GLYPH[category], imageUrl: null };

  return { glyph: NEUTRAL_GLYPH, imageUrl: null };
}
