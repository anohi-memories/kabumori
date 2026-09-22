import type { PersonalizedReport, ReportType } from '@/lib/report-presentation';
import type { TrackedStock } from '@/lib/stocks';

export type DashboardGreeting = {
  eyebrow: 'KABUMORI';
  title: string;
};

export type TrackedStockSummary = {
  holdingCount: number;
  watchCount: number;
  totalCount: number;
};

export type DashboardSection = 'stocks' | 'news' | 'reports';

export const DASHBOARD_ERROR_MESSAGES: Record<DashboardSection, string> = {
  stocks: '登録銘柄を読み込めませんでした。',
  news: '重要ニュースを読み込めませんでした。',
  reports: 'レポートを読み込めませんでした。',
};

export function dashboardSectionError(section: DashboardSection): string {
  return DASHBOARD_ERROR_MESSAGES[section];
}

/** Returns a stable greeting for the user's local (JST) time of day. */
export function dashboardGreeting(date = new Date()): DashboardGreeting {
  const jstHour = new Date(date.getTime() + 9 * 60 * 60 * 1000).getUTCHours();

  if (jstHour < 11) return { eyebrow: 'KABUMORI', title: 'おはようございます' };
  if (jstHour < 18) return { eyebrow: 'KABUMORI', title: '今日のかぶモリ' };
  return { eyebrow: 'KABUMORI', title: '今日もお疲れさまでした' };
}

export function summarizeTrackedStocks(items: readonly TrackedStock[]): TrackedStockSummary {
  const holdingCount = items.filter((item) => item.tracking_type === 'holding').length;
  const watchCount = items.filter((item) => item.tracking_type === 'watch').length;
  return { holdingCount, watchCount, totalCount: holdingCount + watchCount };
}

export function todayJst(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function todaysReports(
  reports: readonly PersonalizedReport[],
  today = todayJst(),
): Record<ReportType, PersonalizedReport | null> {
  return {
    morning: reports.find((report) => report.trading_date === today && report.report_type === 'morning') ?? null,
    close: reports.find((report) => report.trading_date === today && report.report_type === 'close') ?? null,
  };
}
