// F1: ホーム「今日のポイント」を、全員共通の朝刊・大引け（get_app_market_report）から作る。
// ここは手元の模擬サーバー（実 RPC ではない）。RPC の形の JSON を parseAppMarketReport に通し、ホームの判定まで通して確かめる。
// 実 RPC・実機での確認はこのファイルの対象外（Report の NOT_VERIFIED を参照）。
import assert from "node:assert/strict";
import test from "node:test";

import {
  HOME_MARKET_INITIAL,
  MARKET_CHARACTER_STATE,
  compareHomeMarketReports,
  homeMarketCtaLabel,
  homeMarketKindLabel,
  homeMarketRouteParams,
  isCurrentHomeMarketReport,
  latestHomeMarketReport,
  resolveHomeMarketState,
  toHomeMarketReport,
  type HomeMarketReport,
  type HomeMarketState,
} from "../../src/lib/home-market-report.ts";
import {
  datedMarketReportEmptyText,
  shiftTradingDate,
  stepMarketReportDate,
} from "../../src/lib/market-report-history.ts";
import {
  isRequestedMarketReport,
  marketReportParams,
  marketReportRequest,
  parseAppMarketReport,
  type AppMarketReport,
} from "../../src/lib/ondemand-analysis-presentation.ts";
import { marketReportDateLine, reportTypeLabel, type ReportType } from "../../src/lib/report-presentation.ts";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const ID = (n: number) => `8b0c3a64-1111-4a2b-9c3d-${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// 模擬サーバー: get_app_market_report と同じ回の選び方（直近 7 日の最新の完成した回 / 日付指定は 31 日前まで）
// ---------------------------------------------------------------------------

type Published = { type: ReportType; date: string; points: string[]; status?: "completed" | "running" | "failed" };
const POINTS = (label: string) => [`${label}の1`, `${label}の2`, `${label}の3`];

class FakeServer {
  constructor(public cycles: Published[], public today: string, public feedEnabled = true) {}
  private id(cycle: Published) {
    return ID(Number(cycle.date.replaceAll("-", "")) * 10 + (cycle.type === "close" ? 2 : 1));
  }
  private completed(cycle: Published) {
    return {
      status: "completed",
      report_type: cycle.type,
      trading_date: cycle.date,
      today: this.today,
      is_today: cycle.date === this.today,
      report_packet_id: this.id(cycle),
      generated_at: "2026-10-14T00:00:00Z",
      headline_ja: `${cycle.date} ${cycle.type}`,
      market_summary_ja: "要約",
      market_direction: "up",
      points_ja: cycle.points,
    };
  }
  /** RPC の返り値（JSON）。 */
  rpc(type: ReportType, date: string | null): unknown {
    if (!this.feedEnabled) return { status: "disabled" };
    const done = (cycle: Published) => (cycle.status ?? "completed") === "completed";
    if (date === null) {
      const lower = shiftTradingDate(this.today, -7)!;
      const found = this.cycles
        .filter((c) => c.type === type && done(c) && c.date >= lower && c.date <= this.today)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      return found ? this.completed(found) : { status: "missing", report_type: type, today: this.today };
    }
    const cycle = this.cycles.find((c) => c.type === type && c.date === date);
    if (!cycle) return { status: "missing", report_type: type, trading_date: date, today: this.today };
    return done(cycle) ? this.completed(cycle) : { status: "not_ready", report_type: type, trading_date: date, today: this.today };
  }
  /** ホームが読む 2 件（朝刊・大引けの最新）。 */
  home(): Array<PromiseSettledResult<AppMarketReport>> {
    return (["morning", "close"] as const).map((type) => ({
      status: "fulfilled" as const,
      value: parseAppMarketReport(this.rpc(type, null), type),
    }));
  }
}

const fulfilled = (value: AppMarketReport): PromiseSettledResult<AppMarketReport> => ({ status: "fulfilled", value });
const rejected = (): PromiseSettledResult<AppMarketReport> => ({ status: "rejected", reason: new Error("network") });
const homeOf = (server: FakeServer, previous: HomeMarketState = HOME_MARKET_INITIAL) =>
  resolveHomeMarketState(previous.report, server.home());
const shown = (state: HomeMarketState) => state.report && `${state.report.tradingDate}:${state.report.reportType}`;

const BASE: Published[] = [
  { type: "morning", date: "2026-10-13", points: POINTS("10/13朝刊") },
  { type: "close", date: "2026-10-13", points: POINTS("10/13大引け") },
];

// ---------------------------------------------------------------------------
// 表示モデルへの変換
// ---------------------------------------------------------------------------

test("変換: 完成した共通レポートだけが表示モデルになり、保存済みのポイントがそのまま（最大3項目・補完なし）出る", () => {
  const server = new FakeServer([{ type: "morning", date: "2026-10-14", points: ["  日経平均は\n続伸 ", "為替は円安", "米株は高い", "4つ目は出さない"] }], "2026-10-14");
  const model = toHomeMarketReport(parseAppMarketReport(server.rpc("morning", null), "morning"))!;
  assert.deepEqual(model.points, ["日経平均は 続伸", "為替は円安", "米株は高い"], "空白だけ整え、3項目まで");
  assert.deepEqual([model.reportType, model.tradingDate, model.reportId, model.isToday], ["morning", "2026-10-14", ID(202610141), true]);
  // 3項目に満たなければ、ある分だけ（架空の文で埋めない）。
  const two = new FakeServer([{ type: "close", date: "2026-10-14", points: ["一つ目", "二つ目"] }], "2026-10-14");
  assert.deepEqual(toHomeMarketReport(parseAppMarketReport(two.rpc("close", null), "close"))!.points, ["一つ目", "二つ目"]);
  // ポイントが無い回は、回としては残し、ポイントは空（見出しや要約から作らない）。
  const none = new FakeServer([{ type: "close", date: "2026-10-14", points: [] }], "2026-10-14");
  assert.deepEqual(toHomeMarketReport(parseAppMarketReport(none.rpc("close", null), "close"))!.points, []);
});

test("変換: 無効・未作成・作成中・取引日が不正な回は表示モデルにならない", () => {
  assert.equal(toHomeMarketReport({ status: "disabled" }), null);
  assert.equal(toHomeMarketReport({ status: "missing", reportType: "morning", tradingDate: null }), null);
  assert.equal(toHomeMarketReport({ status: "not_ready", reportType: "close", tradingDate: "2026-10-14" }), null);
  const odd = parseAppMarketReport({ status: "completed", trading_date: "10/14", headline_ja: "x", points_ja: ["a"] }, "morning");
  assert.equal(toHomeMarketReport(odd), null, "並べられない日付は出さない");
});

test("公開レポートの ID は UUID の形のときだけ受け取る", () => {
  const ok = parseAppMarketReport({ status: "completed", trading_date: "2026-10-14", headline_ja: "x", report_packet_id: ID(1) }, "morning");
  const bad = parseAppMarketReport({ status: "completed", trading_date: "2026-10-14", headline_ja: "x", report_packet_id: "../x" }, "morning");
  const absent = parseAppMarketReport({ status: "completed", trading_date: "2026-10-14", headline_ja: "x" }, "morning");
  assert.deepEqual([ok, bad, absent].map((report) => report.status === "completed" && report.reportPacketId), [ID(1), null, null]);
});

// ---------------------------------------------------------------------------
// どの回を出すか（公開済みの回だけから決める）
// ---------------------------------------------------------------------------

test("順序: 取引日が新しい回が先、同じ日なら大引け。入力の順や公開日時には依らない", () => {
  const m = (date: string): HomeMarketReport => ({ reportType: "morning", tradingDate: date, reportId: null, isToday: false, points: [] });
  const c = (date: string): HomeMarketReport => ({ reportType: "close", tradingDate: date, reportId: null, isToday: false, points: [] });
  assert.ok(compareHomeMarketReports(c("2026-10-14"), m("2026-10-14")) > 0, "同じ日は大引けが後");
  assert.ok(compareHomeMarketReports(m("2026-10-15"), c("2026-10-14")) > 0, "翌営業日の朝刊が前日の大引けより新しい");
  for (const list of [[m("2026-10-15"), c("2026-10-14"), m("2026-10-14")], [c("2026-10-14"), m("2026-10-14"), m("2026-10-15")]]) {
    assert.equal(latestHomeMarketReport(list), list.find((r) => r.tradingDate === "2026-10-15"));
  }
  assert.equal(latestHomeMarketReport([null, null]), null);
});

test("朝刊完成 → 大引け未生成 → 大引け完成 → 翌営業日の朝刊完成 の順に、ホームの表示が切り替わる", () => {
  const server = new FakeServer([...BASE], "2026-10-14");
  // 朝刊の生成前: 前営業日の大引けを、日付つきで（今日の回とは呼ばない）。
  let state = homeOf(server);
  assert.equal(shown(state), "2026-10-13:close");
  assert.equal(homeMarketKindLabel(state.report!, "2026-10-14", false), "10/13 大引け");
  assert.deepEqual(state.report!.points, POINTS("10/13大引け"));

  // 朝刊が完成 → 朝刊の3ポイント。
  server.cycles.push({ type: "morning", date: "2026-10-14", points: POINTS("10/14朝刊") });
  state = homeOf(server, state);
  assert.equal(shown(state), "2026-10-14:morning");
  assert.equal(homeMarketKindLabel(state.report!, "2026-10-14", false), "朝刊");
  assert.deepEqual(state.report!.points, POINTS("10/14朝刊"));

  // 大引けを生成中（未完成）: 先行表示しない。朝刊のまま。
  server.cycles.push({ type: "close", date: "2026-10-14", points: POINTS("10/14大引け"), status: "running" });
  state = homeOf(server, state);
  assert.equal(shown(state), "2026-10-14:morning", "未完成の大引けは出さない");
  // 生成に失敗した場合も同じ。
  server.cycles.find((c) => c.type === "close" && c.date === "2026-10-14")!.status = "failed";
  assert.equal(shown(homeOf(server, state)), "2026-10-14:morning");

  // 大引けが完成 → 大引けの3ポイントへ。
  server.cycles.find((c) => c.type === "close" && c.date === "2026-10-14")!.status = "completed";
  state = homeOf(server, state);
  assert.equal(shown(state), "2026-10-14:close");
  assert.equal(homeMarketKindLabel(state.report!, "2026-10-14", false), "大引け");
  assert.deepEqual(state.report!.points, POINTS("10/14大引け"));

  // 日付が変わっても、翌朝の朝刊が完成するまでは前日の大引けを「10/14 大引け」と日付つきで。
  server.today = "2026-10-15";
  state = homeOf(server, state);
  assert.equal(shown(state), "2026-10-14:close");
  assert.equal(homeMarketKindLabel(state.report!, "2026-10-15", false), "10/14 大引け");

  // 翌営業日の朝刊が完成 → 新しい朝刊へ。
  server.cycles.push({ type: "morning", date: "2026-10-15", points: POINTS("10/15朝刊") });
  state = homeOf(server, state);
  assert.equal(shown(state), "2026-10-15:morning");
  assert.deepEqual(state.report!.points, POINTS("10/15朝刊"));
});

test("土日祝・休場日: 新しい回が無い間は直近の大引けを、日付つきで。朝刊が完成したらそちらへ", () => {
  // 金曜の朝刊・大引けが公開済み。土曜・日曜・月曜（祝日で休場、朝刊なし）。
  const server = new FakeServer([
    { type: "morning", date: "2026-10-09", points: POINTS("金朝刊") },
    { type: "close", date: "2026-10-09", points: POINTS("金大引け") },
  ], "2026-10-10");
  for (const today of ["2026-10-10", "2026-10-11", "2026-10-12"]) {
    server.today = today;
    const state = homeOf(server);
    assert.equal(shown(state), "2026-10-09:close", today);
    assert.equal(isCurrentHomeMarketReport(state.report!, today), false, `${today}: 今日の回とは呼ばない`);
    assert.equal(homeMarketKindLabel(state.report!, today, false), "10/9 大引け");
  }
  // 月曜の朝刊が完成するまでは金曜の大引けのまま、完成したら朝刊へ。
  server.today = "2026-10-12";
  server.cycles.push({ type: "morning", date: "2026-10-12", points: POINTS("月朝刊") });
  assert.equal(shown(homeOf(server)), "2026-10-12:morning");
  // 直近 7 日に完成した回が1つも無ければ、空（エラーではない）。
  server.cycles = [];
  const empty = homeOf(server);
  assert.deepEqual([empty.report, empty.failed, empty.unconfirmed], [null, false, false]);
});

test("朝刊だけ・大引けだけが無い日でも、あるほうを出す。どちらも未生成なら空", () => {
  const onlyClose = new FakeServer([{ type: "close", date: "2026-10-13", points: POINTS("c") }], "2026-10-14");
  assert.equal(shown(homeOf(onlyClose)), "2026-10-13:close", "朝刊が未生成");
  const onlyMorning = new FakeServer([{ type: "morning", date: "2026-10-14", points: POINTS("m") }], "2026-10-14");
  assert.equal(shown(homeOf(onlyMorning)), "2026-10-14:morning", "大引けが未生成");
  assert.equal(homeOf(new FakeServer([], "2026-10-14")).report, null);
  // 公開のゲートが OFF（disabled）でも、壊れずに空。
  const off = new FakeServer(BASE, "2026-10-14", false);
  assert.deepEqual([homeOf(off).report, homeOf(off).failed], [null, false]);
});

// ---------------------------------------------------------------------------
// 取得失敗・保持・日付変更
// ---------------------------------------------------------------------------

test("取得失敗: 両方失敗して前回の回が無ければエラー、あれば前回の回を（確認できていない印つきで）残す", () => {
  const server = new FakeServer([...BASE, { type: "morning", date: "2026-10-14", points: POINTS("10/14朝刊") }], "2026-10-14");
  const first = homeOf(server);
  assert.equal(shown(first), "2026-10-14:morning");

  const failedFirst = resolveHomeMarketState(null, [rejected(), rejected()]);
  assert.deepEqual([failedFirst.report, failedFirst.failed, failedFirst.unconfirmed], [null, true, true], "初回の失敗は空白ではなくエラー");

  const kept = resolveHomeMarketState(first.report, [rejected(), rejected()]);
  assert.deepEqual([shown(kept), kept.failed, kept.unconfirmed], ["2026-10-14:morning", false, true]);
  assert.deepEqual(kept.report!.points, POINTS("10/14朝刊"), "保存済みのポイントをそのまま");
  assert.equal(homeMarketKindLabel(kept.report!, "2026-10-14", kept.unconfirmed), "朝刊（更新できません）");
});

test("取得失敗: 大引けの取得だけ失敗しても、取れた朝刊と前回の回のうち新しい方を、確認できていない印つきで出す", () => {
  const server = new FakeServer([...BASE, { type: "morning", date: "2026-10-14", points: POINTS("10/14朝刊") }], "2026-10-14");
  const [morning] = server.home();
  const state = resolveHomeMarketState(null, [morning, rejected()]);
  assert.deepEqual([shown(state), state.unconfirmed, state.failed], ["2026-10-14:morning", true, false]);

  // 前回 10/13 の大引けを持っていても、新しい 10/14 の朝刊が取れていればそちらが勝つ（古い回で新しい回を隠さない）。
  const yesterdayClose = toHomeMarketReport(parseAppMarketReport(server.rpc("close", null), "close"));
  assert.equal(shown(resolveHomeMarketState(yesterdayClose, [morning, rejected()])), "2026-10-14:morning");
  // 逆に、前回の回の方が新しければ、取れた古い回で置き換えない。
  const closeToday = new FakeServer([...BASE, { type: "close", date: "2026-10-14", points: POINTS("10/14大引け") }], "2026-10-14");
  const kept = toHomeMarketReport(parseAppMarketReport(closeToday.rpc("close", null), "close"));
  const olderMorning = fulfilled(parseAppMarketReport(closeToday.rpc("morning", null), "morning"));
  assert.equal(shown(resolveHomeMarketState(kept, [olderMorning, rejected()])), "2026-10-14:close");
});

test("両方取れたときは、前回の回を残さずサーバーの答えだけで決める（サーバーが「まだ無い」なら無い）", () => {
  const server = new FakeServer(BASE, "2026-10-14");
  const previous = toHomeMarketReport(parseAppMarketReport(new FakeServer([{ type: "close", date: "2026-10-14", points: ["古い保持"] }], "2026-10-14").rpc("close", null), "close"));
  const state = resolveHomeMarketState(previous, server.home());
  assert.equal(shown(state), "2026-10-13:close");
  assert.deepEqual(state.report!.points, POINTS("10/13大引け"));
  assert.equal(state.unconfirmed, false);
});

test("日付変更: 日付をまたいで保持した回は、サーバーが当日と判定した回でも「今日」と呼ばず、日付つきで出す（古い日付が分かる）", () => {
  const server = new FakeServer([{ type: "morning", date: "2026-10-14", points: POINTS("10/14朝刊") }], "2026-10-14");
  const state = homeOf(server);
  assert.equal(state.report!.isToday, true);
  assert.equal(homeMarketKindLabel(state.report!, "2026-10-14", false), "朝刊");
  // 日付が変わった後に取得が失敗: 保持している 10/14 の朝刊は、10/15 には日付つき。
  const rolled = resolveHomeMarketState(state.report, [rejected(), rejected()]);
  assert.equal(homeMarketKindLabel(rolled.report!, "2026-10-15", rolled.unconfirmed), "10/14 朝刊（更新できません）");
  assert.equal(isCurrentHomeMarketReport(rolled.report!, "2026-10-15"), false);
});

test("過去の回の文言は reportTypeLabel と同じ（型だけを読み込む都合で別に持っている）", () => {
  for (const type of ["morning", "close"] as const) {
    const missing = { status: "missing", reportType: type, tradingDate: "2026-10-12" } as const;
    assert.ok(datedMarketReportEmptyText(missing, type, "2026-10-12", "2026-10-14").includes(`日の${reportTypeLabel(type)}は`));
  }
});

test("ゆめちゃんの表情: 共通の市況はいつも中立（保有銘柄向けの判定を当てはめない）", () => {
  assert.equal(MARKET_CHARACTER_STATE, "neutral");
});

// ---------------------------------------------------------------------------
// ホーム → 詳細
// ---------------------------------------------------------------------------

test("ホームから渡す引数: 種類・取引日・公開レポートの ID と strict。別日へ誤遷移しない", () => {
  const server = new FakeServer([{ type: "close", date: "2026-10-13", points: POINTS("c") }], "2026-10-14");
  const report = homeOf(server).report!;
  const params = homeMarketRouteParams(report);
  assert.deepEqual(params, { type: "close", date: "2026-10-13", id: ID(202610132), strict: "1" });
  assert.deepEqual(homeMarketRouteParams({ ...report, reportId: null }), { type: "close", date: "2026-10-13", strict: "1" }, "ID が無くても type と date で開く");
  assert.match(homeMarketCtaLabel(report), /^10月13日の大引けを見る$/);
  // 詳細側の解釈: 指定の回だけを開く（strict）。
  assert.deepEqual(marketReportRequest(params), { type: "close", date: "2026-10-13", strict: true, reportId: ID(202610132) });
});

test("詳細の引数: strict は日付があるときだけ有効。通知の引数は従来どおり（直近の回へ戻してよい）", () => {
  assert.deepEqual(marketReportRequest({ type: "close", date: "2026-10-12" }), { type: "close", date: "2026-10-12", strict: false, reportId: null });
  assert.deepEqual(marketReportRequest({ type: "close", strict: "1" }), { type: "close", date: null, strict: false, reportId: null });
  assert.equal(marketReportRequest({ type: "close", date: "2026-10-12", strict: "true" }).strict, false, "'1' だけ");
  assert.equal(marketReportRequest({ type: "close", date: "2026-10-12", strict: "1", id: "../x" }).reportId, null, "不正な ID は無視");
  assert.deepEqual(marketReportRequest({ type: ["close"], date: ["2026-10-12"], strict: ["1"] }), { type: "morning", date: null, strict: false, reportId: null });
  // 既存の通知用の引数の解釈は変えていない。
  assert.deepEqual(marketReportParams({ type: "close", date: "2026-10-12" }), { type: "close", date: "2026-10-12" });
});

test("指定の回の判定: 種類・取引日が一致する完成した回だけ。別の日・別の種類・未完成は一致しない", () => {
  const server = new FakeServer([{ type: "close", date: "2026-10-13", points: POINTS("c") }, { type: "close", date: "2026-10-14", points: POINTS("c"), status: "running" }], "2026-10-14");
  const dated = parseAppMarketReport(server.rpc("close", "2026-10-13"), "close");
  assert.equal(isRequestedMarketReport(dated, "close", "2026-10-13"), true);
  assert.equal(isRequestedMarketReport(dated, "close", "2026-10-12"), false, "別の日");
  assert.equal(isRequestedMarketReport(dated, "morning", "2026-10-13"), false, "別の種類");
  assert.equal(isRequestedMarketReport(parseAppMarketReport(server.rpc("close", "2026-10-14"), "close"), "close", "2026-10-14"), false, "作成中");
  assert.equal(isRequestedMarketReport(parseAppMarketReport(server.rpc("morning", "2026-10-13"), "morning"), "morning", "2026-10-13"), false, "未作成");
});

test("詳細の見出し: 日付を指定して開いた過去の回を「直近の回を表示しています」と書かない", () => {
  const server = new FakeServer([{ type: "close", date: "2026-10-13", points: POINTS("c") }], "2026-10-14");
  const report = parseAppMarketReport(server.rpc("close", "2026-10-13"), "close");
  if (report.status !== "completed") throw new Error("completed expected");
  assert.equal(marketReportDateLine(report, true), "10月13日（火）の大引けレポート（過去の回）");
  // 日付の指定なし（直近の回）・通知の戻しは従来の文。
  assert.match(marketReportDateLine(report), /今日の分はまだありません。直近の回を表示しています/);
  assert.equal(marketReportDateLine({ ...report, isToday: true }, true), "10月13日（火）の大引けレポート");
});

// ---------------------------------------------------------------------------
// 過去の回（日付ナビ。一覧用の公開の関数は無い）
// ---------------------------------------------------------------------------

test("日付ナビ: 1 日ずつ、今日から 31 日前〜今日の範囲だけ動ける（月・年・うるう日をまたぐ）", () => {
  assert.equal(shiftTradingDate("2026-10-01", -1), "2026-09-30");
  assert.equal(shiftTradingDate("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftTradingDate("2028-03-01", -1), "2028-02-29");
  assert.equal(shiftTradingDate("2026-10-14", 7), "2026-10-21");
  assert.equal(shiftTradingDate("10/14", -1), null);
  const today = "2026-10-14";
  assert.equal(stepMarketReportDate("2026-10-14", -1, today), "2026-10-13");
  assert.equal(stepMarketReportDate("2026-10-14", 1, today), null, "未来へは進めない");
  assert.equal(stepMarketReportDate("2026-10-13", 1, today), "2026-10-14");
  assert.equal(stepMarketReportDate("2026-09-13", -1, today), null, "31 日より前へは戻れない（サーバーの範囲）");
  assert.equal(stepMarketReportDate("2026-09-14", -1, today), "2026-09-13", "ちょうど 31 日前（9/13）まで");
  assert.equal(stepMarketReportDate("bad", -1, today), null);
});

test("過去の回の選択: 指定の日の完成した回が読める。無い日・未公開の日は、別の日で埋めずその旨を出す", () => {
  const server = new FakeServer([
    { type: "morning", date: "2026-10-13", points: POINTS("m") },
    { type: "close", date: "2026-10-13", points: POINTS("c") },
    { type: "close", date: "2026-10-09", points: POINTS("金") },
    { type: "close", date: "2026-10-08", points: POINTS("x"), status: "failed" },
  ], "2026-10-14");
  const pick = (type: ReportType, date: string) => parseAppMarketReport(server.rpc(type, date), type);
  // 選んだ日の朝刊と大引けが、種類つきで区別して読める。
  const morning = pick("morning", "2026-10-13");
  const close = pick("close", "2026-10-13");
  assert.deepEqual([morning, close].map((r) => r.status === "completed" && `${r.reportType}:${r.tradingDate}`), ["morning:2026-10-13", "close:2026-10-13"]);
  // 休場日（回が無い）・失敗した回（未公開）は、完成扱いにならず文で説明する。
  const holiday = pick("close", "2026-10-12");
  const failed = pick("close", "2026-10-08");
  assert.equal(holiday.status, "missing");
  assert.equal(failed.status, "not_ready");
  assert.equal(datedMarketReportEmptyText(holiday, "close", "2026-10-12", "2026-10-14"), "10月12日の大引けレポートは公開されていません（休場日、または作成されなかった回です）。");
  assert.match(datedMarketReportEmptyText(failed, "close", "2026-10-08", "2026-10-14"), /公開されていません/);
  // 「作成中」と言ってよいのは今日の回だけ。
  const today = parseAppMarketReport({ status: "not_ready", report_type: "close", trading_date: "2026-10-14" }, "close");
  if (today.status === "completed") throw new Error("not completed expected");
  assert.match(datedMarketReportEmptyText(today, "close", "2026-10-14", "2026-10-14"), /作成中です/);
  assert.ok(!/今日の/.test(datedMarketReportEmptyText(holiday, "close", "2026-10-12", "2026-10-14")), "過去の日付に「今日の」と書かない");
});

// ---------------------------------------------------------------------------
// 配線（ソースを文字列で確かめる。既存のテストと同じ方式）
// ---------------------------------------------------------------------------

test("配線: ホームは共通の市況だけをヒーローに渡す（個別レポートの型・取得・自前の文章生成を使わない）", async () => {
  const home = await code("src/app/(tabs)/index.tsx");
  assert.ok(home.includes("fetchHomeMarketReports()") && home.includes("resolveHomeMarketState(previous.report, marketResults.value)"));
  assert.ok(!/fetchRecentReports|PersonalizedReport|buildReportHighlights|currentReport/.test(home));
  assert.ok(home.includes("report={market.report}") && home.includes("unconfirmed={market.unconfirmed}"));
  // 更新はフォーカス・引っ張り・アプリ復帰だけ。定期的な再取得（タイマー）は無い。
  assert.ok(!/setInterval|setTimeout/.test(home), "ポーリングを足していない");
  assert.ok(home.includes("AppState.addEventListener('change'") && home.includes("MARKET_RESUME_MIN_INTERVAL_MS"));
  const hero = await code("src/components/home/home-report-hero.tsx");
  assert.ok(!/PersonalizedReport|report_type|selectReportCharacterState/.test(hero), "ヒーローは個別レポートの型に依存しない");
  const lib = await code("src/lib/ondemand-analysis.ts");
  assert.ok(lib.includes("Promise.allSettled([fetchAppMarketReport('morning'), fetchAppMarketReport('close')])"), "RPC は朝刊・大引けの 2 回だけ");
});

test("配線: 詳細は、指定の回（ホーム・日付ナビ）を別の回で埋めず、前の回を読み込み中に見せ続けず、遅れて返った結果で上書きしない", async () => {
  const screen = await code("src/app/market-report.tsx");
  assert.ok(screen.includes("if (!tradingDate || onlyThisReport) throw dated;"), "指定の回は直近の回へ戻さない");
  assert.ok(screen.includes("isRequestedMarketReport(next, reportType, tradingDate)"), "返った回が指定と違えば出さない");
  assert.ok(screen.includes("result.key === requestKey"), "結果は回の印つき");
  assert.ok(screen.includes("if (sequence === requestSeq.current) setResult("), "古い応答で上書きしない");
  assert.ok(screen.includes("marketReportDateLine(report, strict)"));
  assert.ok(screen.includes("datedMarketReportEmptyText(report, type, date, today)"));
  assert.ok(screen.includes("goToLatest") && screen.includes("直近の{reportTypeLabel(type)}を見る"), "戻るのは利用者の操作のときだけ");
  // 保有銘柄向けの分析の入口と、通知経由の引数は残っている。
  assert.ok(screen.includes("router.push('/ai-analysis')") && screen.includes("marketReportRequest(params)"));
  // 戻る動線は従来どおり: 日付ナビは画面の状態で動かし（履歴を積まない）、もどるは 1 回でホームへ戻る。
  assert.ok(screen.includes("<BackButton />") && !/router\.(push|replace)\(\{?\s*['"`]?\/?market-report/.test(screen));
});
