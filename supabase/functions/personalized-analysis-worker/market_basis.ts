// オンデマンド分析の「どの日の朝刊・大引けを基準にするか」と、株価の基準日の扱い（純粋な関数）。
//
// 基準の決め方（依頼した日 = request_date、東京時間）
//   - 候補: request_date から7日前までの、完成した共通の回（report_status=completed、パケットあり）。
//     scope が morning / close ならその種類だけ、latest なら両方（同じ日なら大引けを新しいとみなす）。
//   - 最も新しい候補より新しい回が作成中（pending / running）なら、最後の試行でない限り待つ（再試行）。
//     最後の試行では、完成済みの最も新しい回で書く（日付は結果とアプリに必ず出す）。
//   - 候補が無ければ、最後の試行でない限り待ち、最後は「市況レポートが無い」で失敗する。
// 古い回を新しい値として扱わない: 基準の日付は結果の report_type / trading_date に残し、株価もその日に合わせる。

import { REPORT_MODEL, type PriceSeries, type ReportType } from "../personalized-reports/report_logic.ts";

export type AnalysisScope = "morning" | "close" | "latest";

export type CycleRow = {
  report_type: ReportType;
  trading_date: string;
  report_status: string;
  current_report_packet_id: string | null;
};

export type MarketBasis =
  | { action: "use"; reportType: ReportType; tradingDate: string; reportPacketId: string; isRequestDate: boolean }
  | { action: "retry"; code: "MARKET_REPORT_NOT_READY" }
  | { action: "fail"; code: "MARKET_REPORT_UNAVAILABLE" };

export const BASIS_WINDOW_DAYS = 7;

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function rank(row: CycleRow): string {
  return `${row.trading_date}:${row.report_type === "close" ? 1 : 0}`;
}

export function resolveMarketBasis(input: {
  scope: AnalysisScope;
  requestDate: string;
  cycles: readonly CycleRow[];
  finalAttempt: boolean;
}): MarketBasis {
  const types: ReportType[] = input.scope === "latest" ? ["morning", "close"] : [input.scope];
  const from = addDays(input.requestDate, -BASIS_WINDOW_DAYS);
  const inWindow = input.cycles.filter((row) =>
    types.includes(row.report_type) && row.trading_date <= input.requestDate && row.trading_date >= from
  );
  const best = inWindow
    .filter((row) => row.report_status === "completed" && typeof row.current_report_packet_id === "string")
    .sort((a, b) => rank(b).localeCompare(rank(a)))[0] ?? null;
  const newerInProgress = inWindow.some((row) =>
    (row.report_status === "pending" || row.report_status === "running") && (!best || rank(row) > rank(best))
  );
  if (newerInProgress && !input.finalAttempt) return { action: "retry", code: "MARKET_REPORT_NOT_READY" };
  if (best) {
    return {
      action: "use",
      reportType: best.report_type,
      tradingDate: best.trading_date,
      reportPacketId: best.current_report_packet_id!,
      isRequestDate: best.trading_date === input.requestDate,
    };
  }
  return input.finalAttempt
    ? { action: "fail", code: "MARKET_REPORT_UNAVAILABLE" }
    : { action: "retry", code: "MARKET_REPORT_NOT_READY" };
}

/**
 * 株価の系列を基準の回に合わせる。
 * - 基準日より後の足は使わない（後の日の値を、基準日の値として扱わない）。
 * - 過去の日の大引け: その日の日足は確定しているので、市場の時刻をその日の 15:30（東京時間）とみなす。
 *   （report_logic.priceFactFor は、市場の時刻が基準日の 15:30 以降のときだけ大引けの値を使うため。）
 * - 今日の大引け・朝刊は、Yahoo の市場の時刻をそのまま使う（取引時間中の値を終値として扱わない）。
 */
export function pinSeriesToSession(
  series: PriceSeries | null,
  reportType: ReportType,
  tradingDate: string,
  todayJst: string,
): PriceSeries | null {
  if (!series) return null;
  const bars = series.bars.filter((bar) => bar.date <= tradingDate);
  if (reportType === "close" && tradingDate < todayJst) {
    return {
      bars,
      marketTimeIso: bars.some((bar) => bar.date === tradingDate)
        ? new Date(`${tradingDate}T15:30:00+09:00`).toISOString()
        : null,
    };
  }
  return { bars, marketTimeIso: series.marketTimeIso };
}

/** V1 で使えるのは通常分析（今の個別レポートと同じ、低費用のモデル）だけ。上位の分析は受け付けない。 */
export function modelForTier(tier: string): string {
  if (tier === "standard") return REPORT_MODEL;
  throw new Error("MODEL_TIER_UNAVAILABLE");
}

/** 再試行しても結果が変わらない失敗（もう一度 AI を呼ばない）。それ以外は回数の上限まで再試行する。 */
const FINAL_CODES = new Set(["NO_TRACKED_STOCKS", "MODEL_TIER_UNAVAILABLE", "MARKET_REPORT_UNAVAILABLE"]);

export function isRetryable(code: string): boolean {
  return !FINAL_CODES.has(code);
}

export function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "ANALYSIS_UNEXPECTED_ERROR";
  // 大文字で始まり空白を含まない固定のコードだけを記録する（例外の文章や秘密情報を DB に残さない）。
  return /^[A-Z][A-Za-z0-9_:.-]*$/.test(value) ? value.slice(0, 120) : "ANALYSIS_UNEXPECTED_ERROR";
}
