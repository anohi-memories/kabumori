// 共通の朝刊・大引けの一斉通知: 通知のタップから、その日・その種類の共通の市況を開く。
import assert from "node:assert/strict";
import test from "node:test";
import { marketReportParams } from "../../src/lib/ondemand-analysis-presentation.ts";
import { reportRouteForPush } from "../../src/lib/report-presentation.ts";

const repoRoot = new URL("../../", import.meta.url);
const code = async (path: string) =>
  (await Deno.readTextFile(new URL(path, repoRoot))).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

test("一斉通知のタップは、その日・その種類の共通の市況を開く（不正な値は共通の市況の最新へ）", () => {
  assert.equal(reportRouteForPush({ source_type: "market_report", source_id: "close:2026-10-12" }), "/market-report?type=close&date=2026-10-12");
  assert.equal(reportRouteForPush({ source_type: "market_report", source_id: "morning:2026-10-09" }), "/market-report?type=morning&date=2026-10-09");
  for (const bad of ["weekly:2026-10-12", "close:2026-10-1", "close:2026-10-12;x", "", "../x"]) {
    assert.equal(reportRouteForPush({ source_type: "market_report", source_id: bad }), "/market-report", bad);
  }
  assert.equal(reportRouteForPush({ source_type: "market_report", source_id: 3 }), "/market-report");
  // 既存の行き先は変わらない。
  assert.equal(reportRouteForPush({ source_type: "important_news", source_id: "x" }), null);
  assert.equal(reportRouteForPush({ source_type: "personalized_report", source_id: "8b0c3a64-1111-4a2b-9c3d-000000000001" }), "/reports/8b0c3a64-1111-4a2b-9c3d-000000000001");
});

test("画面の引数: 種類と日付だけを受け取り、不正な値は無視する", () => {
  assert.deepEqual(marketReportParams({ type: "close", date: "2026-10-12" }), { type: "close", date: "2026-10-12" });
  assert.deepEqual(marketReportParams({ type: "morning" }), { type: "morning", date: null });
  assert.deepEqual(marketReportParams({}), { type: "morning", date: null });
  assert.deepEqual(marketReportParams({ type: "weekly", date: "2026/10/12" }), { type: "morning", date: null });
  assert.deepEqual(marketReportParams({ type: ["close"], date: ["2026-10-12"] }), { type: "morning", date: null });
});

test("配線: 画面は引数の日付の回を読み、通知の日付は種類を切り替えたら直近の回へ。読めない通知の日付は直近の回に戻す", async () => {
  const screen = await code("src/app/market-report.tsx");
  assert.ok(screen.includes("useLocalSearchParams<{ type?: string; date?: string; id?: string; strict?: string }>()"));
  assert.ok(screen.includes("const initial = marketReportRequest(params);"));
  assert.ok(screen.includes("void load(type, date, strict);"));
  assert.ok(/setType\(entry\);\s*if \(!strict\) setDate\(null\);/.test(screen), "通知の日付は切り替えで外す（指定の日付は同じ日の別の種類へ）");
  assert.ok(/if \(!tradingDate \|\| onlyThisReport\) throw dated;\s*return fetchAppMarketReport\(reportType\);/.test(screen), "読めない通知の日付だけ直近の回へ（指定の回は戻さない）");
  const lib = await code("src/lib/ondemand-analysis.ts");
  assert.ok(lib.includes("...(tradingDate ? { p_trading_date: tradingDate } : {}),"), "日付はサーバーの公開の関数に渡す（ゲートと公開項目はサーバーが守る）");
  assert.ok(!/market_report_packets|market_report_broadcast/.test(lib), "アプリは共通の表を直接読まない");
});
