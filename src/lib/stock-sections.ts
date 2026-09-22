import type { TrackedStock, TrackingType } from '@/lib/stocks';

export type StockSection = TrackingType;

export function partitionTrackedStocks(items: readonly TrackedStock[]): Record<StockSection, TrackedStock[]> {
  return {
    holding: items.filter((item) => item.tracking_type === 'holding'),
    watch: items.filter((item) => item.tracking_type === 'watch'),
  };
}

/** Defaults to holdings when present, otherwise shows the only useful section. */
export function defaultStockSection(items: readonly TrackedStock[]): StockSection {
  return items.some((item) => item.tracking_type === 'holding') ? 'holding' : 'watch';
}

export function stockSectionLabel(section: StockSection): string {
  return section === 'holding' ? '保有' : '監視';
}

export function stockSectionEmptyMessage(section: StockSection): string {
  return section === 'holding'
    ? '保有銘柄はまだありません。上の検索から登録できます。'
    : '監視銘柄はまだありません。上の検索から登録できます。';
}
