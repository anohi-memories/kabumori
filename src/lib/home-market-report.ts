// ホーム「今日のポイント」を、全員共通の朝刊・大引け（get_app_market_report）から作る（純粋な関数。AI もネットワークも使わない）。
//
// - ポイントは、公開済みの回に保存されている points_ja（X と同じ 3 項目）をそのまま使う。作文・補完・再生成はしない。
//   3 項目に満たなければ、ある分だけを出す。
// - 朝刊と大引けのどちらを出すかは、実際に公開済み（completed）の回だけから決める。順序は「取引日が新しい回 →
//   同じ取引日なら大引け」。端末の現在時刻では決めない（端末の時計は、今日の回かどうかの表示の判定にだけ使う）。
//   公開済みでない回（作成中・未作成・失敗）は候補に入らないので、未完成の大引けが先に出ることはない。
// - 取得に失敗したときは、最後に確認できた回（日付と種類が分かる）だけを残してよい。別の日の回を今日のものとして出さない。
// - 共通の市況は個別の保有レポート（PersonalizedReport）とは別のモデル。型を流用せず、ここで専用の表示モデルに変換する。
//
// このファイルは型だけを読み込む（テストから Deno で単体で動かせるようにしている）。

import type { AppMarketReport } from './ondemand-analysis-presentation';
import type { ReportType } from './report-presentation';

export const HOME_MARKET_MAX_POINTS = 3;

/** ゆめちゃんの表情。保有銘柄向けの判定（追い風・向かい風など）は共通の市況には当てはまらないので、いつも中立。 */
export const MARKET_CHARACTER_STATE = 'neutral' as const;

export type HomeMarketReport = {
  reportType: ReportType;
  tradingDate: string;
  /** 公開済みの回の一意な ID（report_packet_id）。 */
  reportId: string | null;
  /** サーバーが「取得した時点で、取引日が今日」と判定したか。 */
  isToday: boolean;
  /** 保存済みの points_ja（空白を整えただけ。最大 3 項目）。 */
  points: string[];
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_RANK: Record<ReportType, number> = { morning: 0, close: 1 };
const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();

/** 完成した共通レポートだけを表示モデルへ。それ以外（無効・未作成・作成中）と、取引日の形が不正な回は null。 */
export function toHomeMarketReport(report: AppMarketReport): HomeMarketReport | null {
  if (report.status !== 'completed' || !DATE_PATTERN.test(report.tradingDate)) return null;
  return {
    reportType: report.reportType,
    tradingDate: report.tradingDate,
    reportId: report.reportPacketId,
    isToday: report.isToday,
    points: report.pointsJa.map(collapse).filter(Boolean).slice(0, HOME_MARKET_MAX_POINTS),
  };
}

/** 新しい回ほど大きい。取引日が新しい方、同じ取引日なら大引け（朝刊の後に出る回）。 */
export function compareHomeMarketReports(a: HomeMarketReport, b: HomeMarketReport): number {
  return a.tradingDate.localeCompare(b.tradingDate) || TYPE_RANK[a.reportType] - TYPE_RANK[b.reportType];
}

export function latestHomeMarketReport(candidates: ReadonlyArray<HomeMarketReport | null>): HomeMarketReport | null {
  let latest: HomeMarketReport | null = null;
  for (const candidate of candidates) {
    if (candidate && (!latest || compareHomeMarketReports(candidate, latest) > 0)) latest = candidate;
  }
  return latest;
}

export type HomeMarketState = {
  report: HomeMarketReport | null;
  /** 朝刊・大引けのどちらかの取得に失敗し、最新かどうか確認できていない。 */
  unconfirmed: boolean;
  /** 何も読めず、残せる回もない（エラー表示にする）。 */
  failed: boolean;
};

export const HOME_MARKET_INITIAL: HomeMarketState = { report: null, unconfirmed: false, failed: false };

/**
 * 朝刊・大引けの最新を取った結果（Promise.allSettled の 2 件）から、ホームに出す回を決める。
 * - 両方取れた: サーバーの答えだけで決める（前回の回は残さない。サーバーが「まだ無い」と言えば、無いと表示する）。
 * - どちらか失敗: 取れた回と、前回の回（残してよいのは日付・種類が分かるもの）のうち最新を出し、確認できていないことを示す。
 * - 両方失敗: 前回の回があればそれを、無ければエラーに。
 */
export function resolveHomeMarketState(
  previous: HomeMarketReport | null,
  results: ReadonlyArray<PromiseSettledResult<AppMarketReport>>,
): HomeMarketState {
  const fresh = results.map((result) => (result.status === 'fulfilled' ? toHomeMarketReport(result.value) : null));
  if (results.every((result) => result.status === 'fulfilled')) {
    return { report: latestHomeMarketReport(fresh), unconfirmed: false, failed: false };
  }
  const report = latestHomeMarketReport([...fresh, previous]);
  return { report, unconfirmed: true, failed: report === null };
}

const kindJa = (type: ReportType) => (type === 'close' ? '大引け' : '朝刊');
/** "2026-10-14" -> "10/14" */
const monthDaySlash = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const monthDayJa = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

/** 今日の回か。サーバーの判定と、端末の日本時間の日付の両方が「今日」のときだけ（日付をまたいだ保持分を今日と呼ばない）。 */
export function isCurrentHomeMarketReport(report: Pick<HomeMarketReport, 'isToday' | 'tradingDate'>, todayJst: string): boolean {
  return report.isToday && report.tradingDate === todayJst;
}

/** ヒーローの「今日のポイント」の隣の短い表示。今日の回は種類だけ、そうでなければ日付つき。確認できていなければ、そう書く。 */
export function homeMarketKindLabel(report: HomeMarketReport, todayJst: string, unconfirmed: boolean): string {
  const kind = kindJa(report.reportType);
  const base = isCurrentHomeMarketReport(report, todayJst) ? kind : `${monthDaySlash(report.tradingDate)} ${kind}`;
  return unconfirmed ? `${base}（更新できません）` : base;
}

/** ボタンの読み上げ。どの日のどの回を開くかを言う。 */
export function homeMarketCtaLabel(report: HomeMarketReport): string {
  return `${monthDayJa(report.tradingDate)}の${kindJa(report.reportType)}を見る`;
}

/** ホームから共通の市況の画面へ渡す引数。種類・取引日・公開レポートの ID と、指定の回だけを開く印（strict）。 */
export function homeMarketRouteParams(report: HomeMarketReport): Record<string, string> {
  return {
    type: report.reportType,
    date: report.tradingDate,
    ...(report.reportId ? { id: report.reportId } : {}),
    strict: '1',
  };
}
