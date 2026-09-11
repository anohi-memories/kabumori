import type { ImportantStockNews } from '@/lib/important-news';

export const trackingLabels = { holding: '保有', watch: '監視' } as const;

// Prefer the app severity; fall back to the X importance for an RPC without it.
export function importanceLabel(
  item: Pick<ImportantStockNews, 'severity' | 'importance'>,
): { text: string; subtle: boolean } {
  const severity = item.severity
    ?? (item.importance === 'most_important' ? 'critical' : item.importance === 'important' ? 'high' : 'medium');
  if (severity === 'critical') return { text: '最重要', subtle: false };
  if (severity === 'high') return { text: '重要', subtle: false };
  return { text: '注目', subtle: true };
}

/** Badge text and the line next to it: 市場 + 関連業種, or 保有/監視 + ticker. */
export function targetLabel(
  item: Pick<ImportantStockNews, 'matched_sector' | 'matched_sectors' | 'tracking_type' | 'ticker_code'>,
): { badge: string; detail: string } {
  if (item.matched_sector) {
    // Up to two sectors, most tracked stocks first (the RPC already orders them).
    const sectors = item.matched_sectors?.filter(Boolean).slice(0, 2) ?? [];
    return { badge: '市場', detail: `関連: ${(sectors.length ? sectors : [item.matched_sector]).join('・')}` };
  }
  return { badge: trackingLabels[item.tracking_type] ?? '', detail: item.ticker_code ?? '' };
}

export function formatNewsTime(value: string, withYear = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    ...(withYear ? { year: 'numeric' as const } : {}),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
