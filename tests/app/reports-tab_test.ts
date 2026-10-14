// F1: レポートタブを、旧個別レポートから共通の朝刊・大引け中心へ。ホームと同じ保存済みの共通データを使う。
// ここは手元のデータ（実 RPC ではない）。RPC の形の JSON を parseAppMarketReport に通し、カードの判定まで通して確かめる。
import assert from "node:assert/strict";
import test from "node:test";

import { homeMarketRouteParams, toHomeMarketReport } from "../../src/lib/home-market-report.ts";
import { previousWeekday, reportsTabPastParams } from "../../src/lib/market-report-history.ts";
import { marketReportRequest, parseAppMarketReport, type AppMarketReport } from "../../src/lib/ondemand-analysis-presentation.ts";
import {
  REPORTS_TAB_CARDS_INITIAL,
  reportsTabFailed,
  reportsTabOpenParams,
  resolveReportsTabCard,
  resolveReportsTabCards,
  type ReportsTabCard,
} from "../../src/lib/reports-tab.ts";
import type { ReportType } from "../../src/lib/report-presentation.ts";

const repoRoot = new URL("../../", import.meta.url);
const code = async (path: string) =>
  (await Deno.readTextFile(new URL(path, repoRoot))).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const ID = (n: number) => `8b0c3a64-1111-4a2b-9c3d-${String(n).padStart(12, "0")}`;
const completed = (type: ReportType, date: string, today: string, extra: Record<string, unknown> = {}) =>
  parseAppMarketReport({
    status: "completed",
    report_type: type,
    trading_date: date,
    is_today: date === today,
    report_packet_id: ID(Number(date.replaceAll("-", "")) * 10 + (type === "close" ? 2 : 1)),
    generated_at: "2026-10-14T07:56:00Z",
    headline_ja: `${date} ${type} の見出し`,
    market_summary_ja: `${date} ${type}\nの要約`,
    market_direction: "up",
    points_ja: ["a", "b", "c"],
    ...extra,
  }, type);
const fulfilled = (value: AppMarketReport): PromiseSettledResult<AppMarketReport> => ({ status: "fulfilled", value });
const rejected = (): PromiseSettledResult<AppMarketReport> => ({ status: "rejected", reason: new Error("network") });
const missing = (type: ReportType) => fulfilled(parseAppMarketReport({ status: "missing", report_type: type }, type));
const report = (card: ReportsTabCard | null) => {
  if (card?.kind !== "report") throw new Error(`report card expected: ${JSON.stringify(card)}`);
  return card;
};

test("朝刊・大引けが完成していれば、種類を区別した 2 枚のカードになり、見出し・要約・取引日・公開レポート ID を持つ", () => {
  const today = "2026-10-14";
  const cards = resolveReportsTabCards(REPORTS_TAB_CARDS_INITIAL, [
    fulfilled(completed("morning", today, today)),
    fulfilled(completed("close", today, today)),
  ]);
  const [morning, close] = [report(cards.morning), report(cards.close)];
  assert.deepEqual([morning.type, close.type], ["morning", "close"]);
  assert.deepEqual([morning.report.reportType, close.report.reportType], ["morning", "close"]);
  assert.equal(morning.headline, "2026-10-14 morning の見出し");
  assert.equal(close.summary, "2026-10-14 close の要約", "要約は空白を整えるだけ（作文しない）");
  assert.deepEqual([morning.report.tradingDate, morning.report.isToday, morning.unconfirmed], ["2026-10-14", true, false]);
  assert.equal(morning.report.reportId, ID(202610141));
});

test("カードから開く引数は、ホームと同じ契約（種類・取引日・ID・strict）で、詳細は指定の回だけを開く", () => {
  const today = "2026-10-14";
  const card = report(resolveReportsTabCard("close", null, fulfilled(completed("close", "2026-10-13", today))));
  const params = reportsTabOpenParams(card);
  assert.deepEqual(params, { type: "close", date: "2026-10-13", id: ID(202610132), strict: "1" });
  assert.deepEqual(params, homeMarketRouteParams(toHomeMarketReport(completed("close", "2026-10-13", today))!), "ホームと同じ引数");
  assert.deepEqual(marketReportRequest(params), { type: "close", date: "2026-10-13", strict: true, reportId: ID(202610132) });
});

test("今日の回が無い間（作成中・休場日）は、直近の回を『その回の取引日』で出す。今日の回としては扱わない", () => {
  // 朝刊は今日の分が完成、大引けはまだ（latest は前日の大引けを返す）。
  const today = "2026-10-14";
  const cards = resolveReportsTabCards(REPORTS_TAB_CARDS_INITIAL, [
    fulfilled(completed("morning", today, today)),
    fulfilled(completed("close", "2026-10-13", today)),
  ]);
  assert.equal(report(cards.morning).report.isToday, true);
  assert.deepEqual([report(cards.close).report.tradingDate, report(cards.close).report.isToday], ["2026-10-13", false]);
  // 休場日（祝日の月曜）: 朝刊・大引けとも金曜の回。日付は金曜のまま。
  const holiday = resolveReportsTabCards(REPORTS_TAB_CARDS_INITIAL, [
    fulfilled(completed("morning", "2026-10-09", "2026-10-12")),
    fulfilled(completed("close", "2026-10-09", "2026-10-12")),
  ]);
  assert.deepEqual([holiday.morning, holiday.close].map((card) => report(card).report.tradingDate), ["2026-10-09", "2026-10-09"]);
  assert.deepEqual([holiday.morning, holiday.close].map((card) => report(card).report.isToday), [false, false]);
});

test("未生成・未公開は『無い』と書く（別の日の回で埋めない）。公開のゲート OFF は準備中", () => {
  const cards = resolveReportsTabCards(REPORTS_TAB_CARDS_INITIAL, [missing("morning"), missing("close")]);
  assert.deepEqual(cards.morning, { kind: "empty", type: "morning", reason: "none" });
  assert.deepEqual(cards.close, { kind: "empty", type: "close", reason: "none" });
  const notReady = fulfilled(parseAppMarketReport({ status: "not_ready", report_type: "close", trading_date: "2026-10-14" }, "close"));
  assert.deepEqual(resolveReportsTabCard("close", null, notReady), { kind: "empty", type: "close", reason: "none" });
  const off = fulfilled(parseAppMarketReport({ status: "disabled" }, "morning"));
  assert.deepEqual(resolveReportsTabCard("morning", null, off), { kind: "empty", type: "morning", reason: "disabled" });
  // 完成と書いてあっても取引日が読めない回・種類が違う回は出さない。
  assert.equal(resolveReportsTabCard("morning", null, fulfilled(completed("morning", "bad-date", "2026-10-14"))).kind, "empty");
  assert.equal(resolveReportsTabCard("morning", null, fulfilled(completed("close", "2026-10-14", "2026-10-14"))).kind, "empty", "種類が違う回は朝刊のカードにしない");
});

test("取得失敗: 初回はエラーのカード、前回の回があれば確認できていない印つきで残す。両方失敗のときだけ全体のエラー", () => {
  const today = "2026-10-14";
  const first = resolveReportsTabCards(REPORTS_TAB_CARDS_INITIAL, [rejected(), rejected()]);
  assert.deepEqual([first.morning?.kind, first.close?.kind, reportsTabFailed(first)], ["error", "error", true]);
  const ok = resolveReportsTabCards(REPORTS_TAB_CARDS_INITIAL, [fulfilled(completed("morning", today, today)), fulfilled(completed("close", "2026-10-13", today))]);
  // 大引けの取得だけ失敗: 朝刊は更新され、大引けは前回の回（別の日で埋めない）を印つきで。
  const partial = resolveReportsTabCards(ok, [fulfilled(completed("morning", today, today)), rejected()]);
  assert.equal(report(partial.morning).unconfirmed, false);
  assert.deepEqual([report(partial.close).report.tradingDate, report(partial.close).unconfirmed], ["2026-10-13", true]);
  assert.equal(reportsTabFailed(partial), false);
  // 両方失敗でも、前回の回は残る（空白にしない）。
  const both = resolveReportsTabCards(ok, [rejected(), rejected()]);
  assert.deepEqual([report(both.morning).unconfirmed, report(both.close).unconfirmed, reportsTabFailed(both)], [true, true, false]);
  // 片方だけ初回から失敗: その種類だけエラー、もう一方は表示。
  const half = resolveReportsTabCards(REPORTS_TAB_CARDS_INITIAL, [fulfilled(completed("morning", today, today)), rejected()]);
  assert.deepEqual([half.morning?.kind, half.close?.kind, reportsTabFailed(half)], ["report", "error", false]);
  // 両方取れたときは、前回の回を残さずサーバーの答えだけで決める。
  const reset = resolveReportsTabCards(ok, [missing("morning"), missing("close")]);
  assert.deepEqual([reset.morning?.kind, reset.close?.kind], ["empty", "empty"]);
});

test("過去のレポートの入口: 最新の回の前の平日から日付ナビで（過去の回の一覧を返す関数が無いため）。無ければ今日から", () => {
  const today = "2026-10-14"; // 水曜
  const latest = (date: string) => resolveReportsTabCard("close", null, fulfilled(completed("close", date, today)));
  assert.deepEqual(reportsTabPastParams(latest("2026-10-14"), "close", today), { type: "close", date: "2026-10-13", strict: "1" });
  assert.deepEqual(reportsTabPastParams(latest("2026-10-12"), "close", today), { type: "close", date: "2026-10-09", strict: "1" }, "月曜の前は金曜（土日を飛ばす）");
  assert.deepEqual(reportsTabPastParams(null, "morning", today), { type: "morning", date: today, strict: "1" });
  assert.deepEqual(reportsTabPastParams({ kind: "empty", type: "morning", reason: "none" }, "morning", today), { type: "morning", date: today, strict: "1" });
  assert.deepEqual(reportsTabPastParams({ kind: "error", type: "morning" }, "morning", today), { type: "morning", date: today, strict: "1" });
  // サーバーの範囲（今日から 31 日前）の外へは出発点を置かない。
  assert.deepEqual(reportsTabPastParams(latest("2026-09-13"), "close", today), { type: "close", date: today, strict: "1" });
  // 入口の引数は詳細で「指定の日付の回だけ」と解釈される。
  assert.deepEqual(marketReportRequest(reportsTabPastParams(null, "close", today)), { type: "close", date: today, strict: true, reportId: null });
});

test("前の平日: 土日だけ飛ばし、範囲外・不正な日付は null", () => {
  const today = "2026-10-14";
  assert.equal(previousWeekday("2026-10-13", today), "2026-10-12");
  assert.equal(previousWeekday("2026-10-12", today), "2026-10-09");
  assert.equal(previousWeekday("2026-10-10", today), "2026-10-09", "土曜からは金曜");
  assert.equal(previousWeekday("2026-10-11", today), "2026-10-09", "日曜からは金曜");
  assert.equal(previousWeekday("2026-09-15", today), "2026-09-14", "範囲（9/13〜）の内側なら出す");
  assert.equal(previousWeekday("2026-09-14", today), null, "月曜 9/14 の前の平日は金曜 9/11 で、範囲（9/13〜）の外");
  assert.equal(previousWeekday("bad", today), null);
  assert.equal(previousWeekday("2026-10-13", "bad"), null);
});

// ---------------------------------------------------------------------------
// 配線（ソースを文字列で確かめる。既存のテストと同じ方式）
// ---------------------------------------------------------------------------

test("配線: レポートタブは共通の朝刊・大引けのカードと過去の入口を、ホームと同じ取得で出し、タップで指定の回の詳細へ", async () => {
  const tab = await code("src/app/(tabs)/reports/index.tsx");
  assert.ok(tab.includes("fetchHomeMarketReports()"), "ホームと同じ保存済みの共通データ");
  assert.ok(tab.includes("resolveReportsTabCards(previous, results)"));
  assert.ok(tab.includes("router.push({ pathname: '/market-report', params: reportsTabOpenParams(card) })"), "カード → 指定の回の詳細");
  assert.ok(tab.includes("params: reportsTabPastParams(cards[type], type, today)"), "過去の入口 → 日付ナビ");
  assert.ok(tab.includes("marketCard('morning')") && tab.includes("marketCard('close')"));
  assert.ok(tab.includes("isCurrentHomeMarketReport(card.report, today)"), "今日のバッジは取引日が今日の回だけ");
  // 取得失敗の表示と再試行がある。
  assert.ok(tab.includes("を読み込めませんでした。") && tab.includes("共通の朝刊・大引けを読み込めませんでした。"));
});

test("配線: 画面の構成は 最新の市況 → 過去のレポート → 保有銘柄のAI分析（通知は最後）", async () => {
  const tab = await code("src/app/(tabs)/reports/index.tsx");
  assert.ok(tab.includes('<Text style={styles.title}>レポート</Text>'));
  const order = ["最新の市況</Text>", "過去のレポート</Text>", "保有銘柄のAI分析</Text>", "共通の朝刊・大引けの通知</Text>"].map((needle) => tab.indexOf(needle));
  assert.ok(order.every((index) => index > 0) && [...order].sort((a, b) => a - b).join() === order.join(), `order ${order}`);
});

test("配線: 旧個別定時レポート前提の文言・カードを残さない（『平日の朝8時半』『あなたのレポート』『今日の個別カード』）", async () => {
  const tab = await code("src/app/(tabs)/reports/index.tsx");
  for (const old of ["8時半", "17時", "あなたのレポート", "YOUR PORTFOLIO", "SCHEDULE", "todays(", "登録した保有・監視銘柄に合わせて"]) {
    assert.ok(!tab.includes(old), old);
  }
});

test("配線: 保有銘柄向けの個別分析・個別レポート・通知設定は別の導線で残っている（削除していない）", async () => {
  const tab = await code("src/app/(tabs)/reports/index.tsx");
  assert.ok(tab.includes("router.push('/ai-analysis')") && tab.includes("{ondemand.enabled && ("), "AI分析の入口");
  assert.ok(tab.includes("fetchRecentReports()") && tab.includes("pathname: '/reports/[id]'"), "これまでの個別レポート");
  assert.ok(tab.includes("これまでの個別レポート"));
  assert.ok(tab.includes("fetchReportAlertSettings()") && tab.includes("setReportAlert(column, enabled)"));
  assert.ok(tab.includes("toggleRow('morning_report', '朝刊の通知')") && tab.includes("toggleRow('close_report', '大引けの通知')"), "通知設定の列は変えない");
  // 個別レポートの取得が失敗しても共通の市況は出る（独立に読む）。
  assert.ok(tab.includes("const marketPromise") && tab.includes("const personalPromise") && tab.includes("await Promise.all([marketPromise, personalPromise])"));
  const nested = await code("src/app/(tabs)/reports/_layout.tsx");
  assert.ok(nested.includes('<Stack.Screen name="[id]"'), "個別レポートの詳細は同じタブのスタック");
});
