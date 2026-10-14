// 「きょうの市況」で過去の共通朝刊・大引けを日付で読む（純粋な関数。ネットワークは呼ばない）。
//
// 過去の回の「一覧」を返す公開の関数は、いまのサーバーには無い（get_app_market_report は 1 日・1 種類ずつ）。
// そこで一覧は作らず、利用者の操作ごとに 1 回だけ、指定の日の回を読む。サーバーが受け付ける範囲
// （今日から 31 日前まで）の外へは進めない。一覧用の契約は docs/market-report-shared-platform/F1_HOME_MARKET_REPORT_CONTRACT.md。

import type { AppMarketReport } from './ondemand-analysis-presentation';
import type { ReportType } from './report-presentation';

/** get_app_market_report が受け付ける、今日から遡れる日数（サーバーの `p_trading_date < v_today - 31` と同じ）。 */
export const MARKET_REPORT_HISTORY_DAYS = 31;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// report-presentation.ts の reportTypeLabel と同じ文言（型だけを読み込み、Deno で単体で動かせるようにここに置く。テストで一致を確かめる）。
const TYPE_LABEL_JA: Record<ReportType, string> = { morning: '朝刊', close: '大引けレポート' };

/** "2026-10-14" を days 日ずらす（カレンダーの日付だけの計算。形が違えば null）。 */
export function shiftTradingDate(date: string, days: number): string | null {
  if (!DATE_PATTERN.test(date)) return null;
  const base = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * 日付ナビの移動先。範囲（今日から 31 日前〜今日）の外・不正な日付なら null（ボタンを押せなくする）。
 * `today` は日本時間の今日。
 */
export function stepMarketReportDate(current: string, delta: -1 | 1, today: string): string | null {
  const target = shiftTradingDate(current, delta);
  const earliest = shiftTradingDate(today, -MARKET_REPORT_HISTORY_DAYS);
  if (!target || !earliest || !DATE_PATTERN.test(today)) return null;
  return target >= earliest && target <= today ? target : null;
}

/**
 * 日付を指定して開いた回が読めなかった（無い・未公開）ときの文。直近の回の文（今日の〜は作成中です）とは分ける:
 * 過去の日付に「今日の」とは書かず、別の日の回で埋めない。作成中と言ってよいのは今日の回だけ。
 */
export function datedMarketReportEmptyText(
  report: Exclude<AppMarketReport, { status: 'completed' }>,
  type: ReportType,
  date: string,
  today: string,
): string {
  if (report.status === 'disabled') return 'この機能は準備中です。';
  const label = TYPE_LABEL_JA[type];
  const [, month, day] = date.split('-');
  const when = `${Number(month)}月${Number(day)}日の${label}`;
  if (report.status === 'not_ready' && date === today) return `${when}は作成中です。少し時間をおいてご覧ください。`;
  return `${when}は公開されていません（休場日、または作成されなかった回です）。`;
}
