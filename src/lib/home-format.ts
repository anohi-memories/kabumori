// Small, deterministic text helpers for the compact Home layout.
//
// This module has no RN imports so it can be tested with Deno and bundled by Metro.

/**
 * "2時間前" style relative time for the compact Home cards. Falls back to an empty string for an
 * unparseable value (the caller then shows nothing rather than a wrong time), and to a plain
 * month/day once the item is older than a week.
 */
export function relativeTimeJa(value: string, now: Date = new Date()): string {
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return '';
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 0) return 'たった今';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}日前`;
  return `${then.getMonth() + 1}/${then.getDate()}`;
}

/** First character of a company name (kept for callers that want a single-character mark). */
export function companyInitial(name: string): string {
  return Array.from(name.trim())[0] ?? '·';
}

/**
 * First two characters of a company name, for the tile shown when no logo data exists. Two
 * characters keep companies that share an initial (サンリオ / サイバーエージェント) apart.
 */
export function companyMark(name: string): string {
  return Array.from(name.trim()).slice(0, 2).join('') || '·';
}

/** Category tint for the news media tile: deterministic from existing metadata, never fetched. */
export type NewsTint = { background: string; foreground: string };

const TINTS: Record<string, NewsTint> = {
  monetary_policy: { background: '#e7eefb', foreground: '#2f5fb3' },
  rates: { background: '#e7eefb', foreground: '#2f5fb3' },
  fx: { background: '#e7eefb', foreground: '#2f5fb3' },
  us_market: { background: '#e9eef8', foreground: '#37528f' },
  japan_market: { background: '#fdebec', foreground: '#b3363c' },
  semiconductors: { background: '#e6f4f1', foreground: '#1f7a63' },
  ai_tech: { background: '#e6f4f1', foreground: '#1f7a63' },
  earnings: { background: '#fff1dc', foreground: '#a4640f' },
  corporate: { background: '#fff1dc', foreground: '#a4640f' },
  geopolitics: { background: '#f0e9f8', foreground: '#6a3fa0' },
  disaster: { background: '#f0e9f8', foreground: '#6a3fa0' },
};

const NEUTRAL_TINT: NewsTint = { background: '#e9f3ec', foreground: '#397449' };

const COMPANY_TINTS: readonly NewsTint[] = [
  { background: '#fde8ea', foreground: '#b3363c' },
  { background: '#e7eefb', foreground: '#2f5fb3' },
  { background: '#e6f4f1', foreground: '#1f7a63' },
  { background: '#fff1dc', foreground: '#a4640f' },
  { background: '#f0e9f8', foreground: '#6a3fa0' },
];

/** Tile tint by row position, so neighbouring rows are always different colours. */
export function rowTint(index: number): NewsTint {
  return COMPANY_TINTS[((index % COMPANY_TINTS.length) + COMPANY_TINTS.length) % COMPANY_TINTS.length];
}

export function newsTint(categories: readonly string[] | null | undefined): NewsTint {
  const category = (categories ?? []).find((value) => value in TINTS);
  return category ? TINTS[category] : NEUTRAL_TINT;
}
