// オンデマンド個別AI分析と、アプリ向けの共通朝刊・大引けの表示・配線。
import assert from "node:assert/strict";
import test from "node:test";
import {
  analysisAsReport,
  failureReasonJa,
  jobStatusLabel,
  newClientRequestId,
  parseAnalysisStatus,
  parseAppMarketReport,
  remainingToday,
  requestOutcome,
  shouldRefresh,
  STATUS_OFF,
} from "../../src/lib/ondemand-analysis-presentation.ts";
import { basisLabel, marketReportDateLine, marketReportEmptyText, reportRouteForPush } from "../../src/lib/report-presentation.ts";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
const JOB = "8b0c3a64-1111-4a2b-9c3d-000000000001";

test("状態: サーバーが ON と返したときだけ入口を出す（未公開・壊れた値は OFF）", () => {
  assert.deepEqual(parseAnalysisStatus(null), STATUS_OFF);
  assert.deepEqual(parseAnalysisStatus({ enabled: false, market_feed_enabled: true }), { ...STATUS_OFF, marketFeedEnabled: true });
  assert.deepEqual(parseAnalysisStatus({ enabled: "true" }), STATUS_OFF);
  const on = parseAnalysisStatus({
    enabled: true, market_feed_enabled: false, daily_limit: 5, used_today: 2, active_job_id: JOB, active_status: "processing",
  });
  assert.deepEqual(on, {
    enabled: true, marketFeedEnabled: false, dailyLimit: 5, usedToday: 2, activeJobId: JOB, activeStatus: "processing",
  });
  assert.equal(remainingToday(on), 3);
  assert.equal(remainingToday({ ...on, usedToday: 9 }), 0);
  assert.equal(remainingToday(STATUS_OFF), null);
  assert.equal(parseAnalysisStatus({ enabled: true, active_status: "completed" }).activeStatus, null);
});

test("依頼の返り値は、内部のコードを見せずに利用者向けの文にする", () => {
  assert.equal(requestOutcome({ status: "queued", job_id: JOB }).kind, "accepted");
  assert.match(requestOutcome({ status: "queued", job_id: JOB }).message, /アプリを閉じても続きます/);
  assert.equal(requestOutcome({ status: "replayed", job_id: JOB }).jobId, JOB);
  assert.equal(requestOutcome({ status: "already_active", job_id: JOB }).kind, "info");
  assert.match(requestOutcome({ status: "daily_limit_reached", limit: 5 }).message, /5回/);
  assert.match(requestOutcome({ status: "no_tracked_stocks" }).message, /登録すると/);
  assert.equal(requestOutcome({ status: "disabled" }).message, "この機能は準備中です。");
  const unknown = requestOutcome({ status: "PERSONALIZED_ANALYSIS_X" });
  assert.equal(unknown.kind, "error");
  assert.doesNotMatch(unknown.message, /[A-Z_]{4,}/);
});

test("ジョブの状態と失敗の理由（内部のコードは出さない）", () => {
  assert.equal(jobStatusLabel({ status: "queued" }), "順番待ち");
  assert.equal(jobStatusLabel({ status: "processing" }), "分析中");
  assert.equal(jobStatusLabel({ status: "completed" }), "完成");
  assert.equal(jobStatusLabel({ status: "failed" }), "作成できませんでした");
  for (const code of ["NO_TRACKED_STOCKS", "MARKET_REPORT_UNAVAILABLE", "REPORT_FACT_FAILED", "REST_GET_FAILED:x:503", null]) {
    assert.doesNotMatch(failureReasonJa(code), /[A-Z_]{4,}/, String(code));
  }
  assert.match(failureReasonJa("MARKET_REPORT_NOT_READY"), /朝刊・大引けがまだ/);
  assert.equal(shouldRefresh([{ status: "completed" }, { status: "failed" }]), false);
  assert.equal(shouldRefresh([{ status: "completed" }, { status: "queued" }]), true);
  assert.equal(shouldRefresh([{ status: "processing" }]), true);
});

test("基準の回は必ず日付つきで出す", () => {
  assert.equal(basisLabel("close", "2026-10-09"), "10月9日（金）の大引けレポートを基準にした分析");
  assert.equal(basisLabel("morning", "2026-10-12"), "10月12日（月）の朝刊を基準にした分析");
});

test("依頼の重複を防ぐ ID は UUID v4 の形（サーバーの uuid 型に入る）", () => {
  const id = newClientRequestId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(newClientRequestId(), id);
  assert.equal(newClientRequestId(() => 0), "00000000-0000-4000-8000-000000000000");
  assert.equal(newClientRequestId(() => 0.9999), "ffffffff-ffff-4fff-bfff-ffffffffffff");
});

test("分析結果は個別レポートと同じ形で詳細画面に渡す", () => {
  const report = analysisAsReport({
    job_id: JOB, report_type: "close", trading_date: "2026-10-09", title_ja: "t", summary_ja: null, body: null,
    portfolio_snapshot: null, generated_at: "2026-10-09T08:00:00Z",
  });
  assert.deepEqual(report, {
    id: JOB, report_type: "close", trading_date: "2026-10-09", title_ja: "t", summary_ja: null, body: null,
    portfolio_snapshot: null, generated_at: "2026-10-09T08:00:00Z",
  });
});

test("共通の朝刊・大引け: 公開された項目だけを読み、今日の分でなければ日付ではっきり示す", () => {
  const completed = parseAppMarketReport({
    status: "completed", report_type: "close", trading_date: "2026-10-09", today: "2026-10-10", is_today: false,
    headline_ja: "見出し", market_summary_ja: "要約", market_direction: "up", generated_at: "2026-10-09T07:20:00Z",
    points_ja: ["p1", "", 3], claims: [{ text_ja: "上昇", claim_type: "observation", scope: "today" }, { text_ja: "" }],
    major_moves: [{ label: "日経平均", value_display: "40,000", change_pct_display: "+1.0%", session_date: "2026-10-09", freshness: "fresh" },
      { label: "米10年債", value_display: "4.1%", change_pct_display: null, session_date: "2026-10-01", freshness: "stale" }],
    key_news: [{ headline_ja: "ニュース", why_it_matters_ja: "理由" }], strong_themes: ["半導体"], weak_themes: [],
    next_watch_ja: ["注目"], risks_ja: ["リスク"], data_gaps_ja: [],
  }, "close");
  assert.equal(completed.status, "completed");
  if (completed.status !== "completed") return;
  assert.deepEqual(completed.pointsJa, ["p1"]);
  assert.deepEqual(completed.claims, [{ textJa: "上昇", claimType: "observation", scope: "today" }]);
  assert.equal(completed.majorMoves[1].stale, true);
  assert.equal(marketReportDateLine(completed), "10月9日（金）の大引けレポート（今日の分はまだありません。直近の回を表示しています）");
  assert.equal(marketReportDateLine({ ...completed, isToday: true }), "10月9日（金）の大引けレポート");
  assert.deepEqual(parseAppMarketReport({ status: "disabled" }, "morning"), { status: "disabled" });
  const missing = parseAppMarketReport({ status: "missing", report_type: "morning", today: "2026-10-10" }, "morning");
  assert.equal(missing.status, "missing");
  if (missing.status !== "completed") assert.equal(marketReportEmptyText(missing), "直近の朝刊はまだありません。");
  const notReady = parseAppMarketReport({ status: "not_ready", report_type: "close", trading_date: "2026-10-10" }, "close");
  if (notReady.status !== "completed") assert.match(marketReportEmptyText(notReady), /作成中/);
  // 必要な項目が欠けた「completed」は表示しない。
  assert.equal(parseAppMarketReport({ status: "completed", trading_date: "2026-10-10" }, "morning").status, "missing");
});

test("完成の通知をタップすると、その分析結果を開く（不正な ID は分析の画面へ）", () => {
  assert.equal(reportRouteForPush({ source_type: "personalized_analysis", source_id: JOB }), `/reports/${JOB}?source=analysis`);
  assert.equal(reportRouteForPush({ source_type: "personalized_analysis", source_id: "../x" }), "/ai-analysis");
  assert.equal(reportRouteForPush({ source_type: "personalized_report", source_id: JOB }), `/reports/${JOB}`);
});

test("配線: 処理はサーバーで行い、アプリは依頼と読み取りだけ（service_role のキーも AI も持たない）", async () => {
  const lib = await code("src/lib/ondemand-analysis.ts");
  for (const rpc of ["get_personalized_analysis_status", "request_personalized_analysis", "get_app_market_report"]) {
    assert.ok(lib.includes(`supabase.rpc('${rpc}'`), rpc);
  }
  assert.ok(lib.includes("p_model_tier: 'standard'"), "上位のモデルは選べない");
  assert.ok(!/p_user_id|user_id:/.test(lib), "利用者の ID はアプリから渡さない（サーバーが auth.uid() で決める）");
  for (const path of ["src/lib/ondemand-analysis.ts", "src/app/ai-analysis.tsx", "src/app/market-report.tsx"]) {
    const text = await code(path);
    assert.ok(!/service_role|SECRET|openai|anthropic|claim_personalized_analysis_jobs|complete_personalized_analysis_job/i.test(text), path);
  }
  const screen = await code("src/app/ai-analysis.tsx");
  assert.ok(screen.includes("newClientRequestId()"), "依頼ごとに重複を防ぐ ID");
  assert.ok(screen.includes("pending.current = null;"), "サーバーが答えたら ID を捨てる（通信の失敗では同じ ID で送り直す）");
  assert.ok(/if \(!active\) return undefined;/.test(screen), "画面の再読み込みは処理中のジョブがあるときだけ");
  assert.ok(screen.includes("pathname: '/report-detail', params: { id: job.id, source: 'analysis' }"));
});

test("配線: 入口はサーバーが公開したときだけ。詳細画面は source=analysis で分析結果を読む", async () => {
  const list = await code("src/app/(tabs)/reports/index.tsx");
  assert.ok(list.includes("fetchAnalysisStatus().catch(() => STATUS_OFF)"));
  assert.ok(list.includes("{ondemand.marketFeedEnabled && ("));
  assert.ok(list.includes("{ondemand.enabled && ("));
  const detail = await code("src/app/(tabs)/reports/[id].tsx");
  assert.ok(detail.includes("analysis ? fetchAnalysisReport(String(id)) : fetchReport(String(id))"));
  assert.ok(detail.includes("basisLabel(report.report_type, report.trading_date)"));
  const market = await code("src/app/market-report.tsx");
  assert.ok(market.includes("{analysis.enabled && (") && market.includes("router.push('/ai-analysis')"), "共通の市況から分析へ");
  const root = await read("src/app/_layout.tsx");
  assert.ok(root.includes('<Stack.Screen name="market-report" />') && root.includes('<Stack.Screen name="ai-analysis" />'));
});
