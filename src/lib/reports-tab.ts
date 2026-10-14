// レポートタブ「最新の市況」の朝刊・大引けのカード（純粋な関数。AI もネットワークも使わない）。
//
// ホームと同じ保存済みの共通レポート（get_app_market_report の朝刊・大引けの最新）だけから作る。完成・公開済み（completed）の
// 回だけがカードになり、未作成・作成中・ゲート OFF は「無い」と書く（別の日の回を今日のものとして出さない。日付は必ず回の取引日）。
// 取得に失敗したときは、その種類について最後に確認できた回を、確認できていない印つきで残す（別の種類・別の日で埋めない）。
//
// このファイルは型だけを読み込む（テストから Deno で単体で動かせるようにしている）。

import type { AppMarketReport } from './ondemand-analysis-presentation';
import type { ReportType } from './report-presentation';

/** カードが指す公開済みの回（ホームの HomeMarketReport と同じ識別項目。ポイントは持たない）。 */
export type ReportsTabReport = {
  reportType: ReportType;
  tradingDate: string;
  /** 公開済みの回の一意な ID（report_packet_id）。 */
  reportId: string | null;
  /** サーバーが「取得した時点で、取引日が今日」と判定したか。 */
  isToday: boolean;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ReportsTabCard =
  | {
    kind: 'report';
    type: ReportType;
    report: ReportsTabReport;
    headline: string;
    summary: string;
    generatedAt: string | null;
    /** 取得に失敗し、最後に確認できた回を残している（最新かどうか確認できていない）。 */
    unconfirmed: boolean;
  }
  | { kind: 'empty'; type: ReportType; reason: 'disabled' | 'none' }
  | { kind: 'error'; type: ReportType };

/** 1 種類ぶんの取得結果から、そのカードを決める。 */
export function resolveReportsTabCard(
  type: ReportType,
  previous: ReportsTabCard | null,
  result: PromiseSettledResult<AppMarketReport>,
): ReportsTabCard {
  if (result.status === 'rejected') {
    return previous?.kind === 'report' ? { ...previous, unconfirmed: true } : { kind: 'error', type };
  }
  const value = result.value;
  if (value.status === 'disabled') return { kind: 'empty', type, reason: 'disabled' };
  // 完成していない回・取引日が読めない回・求めた種類と違う回は出さない。
  if (value.status !== 'completed' || !DATE_PATTERN.test(value.tradingDate) || value.reportType !== type) {
    return { kind: 'empty', type, reason: 'none' };
  }
  return {
    kind: 'report',
    type,
    report: { reportType: value.reportType, tradingDate: value.tradingDate, reportId: value.reportPacketId, isToday: value.isToday },
    headline: value.headlineJa,
    summary: value.summaryJa.replace(/\s+/g, ' ').trim(),
    generatedAt: value.generatedAt,
    unconfirmed: false,
  };
}

export type ReportsTabCards = { morning: ReportsTabCard | null; close: ReportsTabCard | null };

/** fetchHomeMarketReports（朝刊・大引けの順）の結果から、2 枚のカードを決める。 */
export function resolveReportsTabCards(
  previous: ReportsTabCards,
  results: readonly [PromiseSettledResult<AppMarketReport>, PromiseSettledResult<AppMarketReport>],
): ReportsTabCards {
  return {
    morning: resolveReportsTabCard('morning', previous.morning, results[0]),
    close: resolveReportsTabCard('close', previous.close, results[1]),
  };
}

export const REPORTS_TAB_CARDS_INITIAL: ReportsTabCards = { morning: null, close: null };

/** 両方読めず、残せる回も無い（カードの代わりに 1 つのエラーを出す）。 */
export function reportsTabFailed(cards: ReportsTabCards): boolean {
  return cards.morning?.kind === 'error' && cards.close?.kind === 'error';
}

/** カードを開く引数。ホームと同じ契約（種類・取引日・公開レポート ID・strict）で、指定の回だけを開く。 */
export function reportsTabOpenParams(card: Extract<ReportsTabCard, { kind: 'report' }>): Record<string, string> {
  return {
    type: card.report.reportType,
    date: card.report.tradingDate,
    ...(card.report.reportId ? { id: card.report.reportId } : {}),
    strict: '1',
  };
}
