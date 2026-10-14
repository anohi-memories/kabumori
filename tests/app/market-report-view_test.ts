// 「きょうの市況」の新しい並び（ポイント → ゆめちゃん → お話 → 注目材料 → 参考資料）と、ゆめちゃんの文言のサーバーとの一致。
import assert from "node:assert/strict";
import test from "node:test";
import { parseAppMarketReport, YUME_DEFAULT_FLAT_BAND_PCT } from "../../src/lib/ondemand-analysis-presentation.ts";
import {
  bandRuleJa,
  buildMarketReportView,
  dateTimeJa,
  indicatorGroups,
  MARKET_REPORT_HEADINGS,
  type MarketReportBlock,
  YUME_STANCE_JA,
  YUME_UNDETERMINABLE_DEFAULT_JA,
  YUME_UNDETERMINABLE_JA,
  YUME_VERDICT_JA,
  yumeReviewLineJa,
} from "../../src/lib/market-report-view.ts";
import * as backend from "../../supabase/functions/_shared/market_report_yume.ts";

type Raw = Record<string, unknown>;

const MOVES = [
  { metric_key: "usdjpy", label: "ドル円", value_display: "150.00円", change_pct_display: "+0.20%", session_date: "2026-10-13", freshness: "fresh" },
  { metric_key: "nikkei225", label: "日経平均", value_display: "40,000", change_pct_display: "+1.00%", session_date: "2026-10-13", freshness: "fresh" },
  { metric_key: "sp500", label: "S&P500", value_display: "6,000", change_pct_display: "−0.50%", session_date: "2026-10-12", freshness: "fresh" },
  { metric_key: "topix_proxy_1306", label: "TOPIX連動ETF（1306）", value_display: "3,000円", change_pct_display: "+0.80%", session_date: "2026-10-13", freshness: "fresh" },
  { metric_key: "dow", label: "NYダウ", value_display: "45,000", change_pct_display: "−0.30%", session_date: "2026-10-12", freshness: "fresh" },
  { metric_key: "us10y", label: "米10年債", value_display: "4.10%", change_pct_display: null, session_date: "2026-10-09", freshness: "stale" },
  { metric_key: "brand_new_metric", label: "新しい指標", value_display: "1", change_pct_display: null, session_date: "2026-10-13", freshness: "fresh" },
  { label: "種類なし", value_display: "2", change_pct_display: null, session_date: "2026-10-13", freshness: "fresh" },
];

/** get_app_market_report が返す形（V1 の項目だけ）。 */
function v1Raw(type: "morning" | "close", extra: Raw = {}): Raw {
  return {
    status: "completed", report_type: type, trading_date: "2026-10-14", today: "2026-10-14", is_today: true,
    report_packet_id: "8b0c3a64-1111-4a2b-9c3d-000000000001", generated_at: "2026-10-13T23:05:00Z",
    headline_ja: "見出し", market_summary_ja: "V1の要約", market_direction: "up",
    claims: [{ text_ja: "日経平均は上昇", claim_type: "observation", scope: "today" }, { text_ja: "半導体が強い", claim_type: "causal", scope: "today" }],
    major_moves: MOVES.map(({ metric_key: _key, ...move }) => move),
    key_news: [
      { headline_ja: "A社が決算", why_it_matters_ja: "個別の材料", scope: "company" },
      { headline_ja: "日銀会合", why_it_matters_ja: "相場全体に効く", scope: "broad" },
      { headline_ja: "半導体の需要", why_it_matters_ja: "業種の材料", scope: "sector" },
      { headline_ja: "米雇用統計", why_it_matters_ja: "相場全体に効く", scope: "broad" },
    ],
    strong_themes: ["半導体"], weak_themes: ["不動産"],
    next_watch_ja: ["米CPI"], risks_ja: ["円高"], data_gaps_ja: [],
    points_ja: ["p1", "p2", "p3", "p4"], fact_status: "passed",
    ...extra,
  };
}

const STORY = {
  summary_ja: "お話の要約", overseas_ja: "米国の話", japan_ja: "日本の話", cross_asset_ja: "為替の話",
  news_ja: "ニュースの話", strong_ja: "強いテーマの話", caution_ja: "注意の話", watch_ja: "注目の話",
};

function v2Raw(type: "morning" | "close", extra: Raw = {}): Raw {
  return v1Raw(type, {
    major_moves: MOVES,
    presentation_version: "market_presentation.v2",
    app_story: STORY,
    session_views: [{ market: "us", session_date: "2026-10-12", direction: "down" }, { market: "tokyo", session_date: "2026-10-13", direction: "up" }],
    data_generated_at: "2026-10-13T22:40:00Z",
    yume: type === "morning"
      ? {
        stance: "up", horizon: "this_session", horizon_date: "2026-10-14", flat_band_pct: 0.3, headline_ja: "上がるとみます",
        reasons_ja: "米国株高を受けるため", scenario_ja: "前場は高く始まりそう", counter_ja: "円高が進むこと", invalidation_ja: "9時台に下げたら", review: null,
      }
      : {
        stance: "flat", horizon: "next_session", horizon_date: null, flat_band_pct: 0.3, headline_ja: "様子見とみます",
        reasons_ja: "材料待ちのため", scenario_ja: "", counter_ja: "", invalidation_ja: "",
        review: {
          verdict: "hit", reason_code: "COMPARED", morning_stance: "up", morning_headline_ja: "上がるとみます",
          actual_change_display: "+1.00%", actual_session_date: "2026-10-14", text_ja: "読みどおりでした",
        },
      },
    ...extra,
  });
}

function view(raw: Raw, type: "morning" | "close" = raw.report_type as "morning" | "close") {
  const report = parseAppMarketReport(raw, type);
  assert.equal(report.status, "completed");
  if (report.status !== "completed") throw new Error("not completed");
  return { report, blocks: buildMarketReportView(report).blocks };
}
function block(blocks: MarketReportBlock[], key: string): MarketReportBlock {
  const found = blocks.find((item) => item.key === key);
  if (!found) throw new Error(`block ${key} missing`);
  return found;
}

test("V2 の返り値を読む: お話・市場ごとの方向・ゆめちゃん・データの時刻・指標の種類・ニュースの範囲", () => {
  const { report } = view(v2Raw("close"));
  assert.equal(report.presentationVersion, "market_presentation.v2");
  assert.deepEqual(report.appStory, {
    summaryJa: "お話の要約", overseasJa: "米国の話", japanJa: "日本の話", crossAssetJa: "為替の話",
    newsJa: "ニュースの話", strongJa: "強いテーマの話", cautionJa: "注意の話", watchJa: "注目の話",
  });
  assert.deepEqual(report.sessionViews, [
    { market: "us", sessionDate: "2026-10-12", direction: "down" }, { market: "tokyo", sessionDate: "2026-10-13", direction: "up" },
  ]);
  assert.equal(report.dataGeneratedAt, "2026-10-13T22:40:00Z");
  assert.equal(report.majorMoves[1].metricKey, "nikkei225");
  assert.equal(report.majorMoves[7].metricKey, null);
  assert.deepEqual(report.keyNews.map((news) => news.scope), ["company", "broad", "sector", "broad"]);
  assert.deepEqual(report.yume, {
    stance: "flat", horizon: "next_session", horizonDate: null, flatBandPct: 0.3, headlineJa: "様子見とみます",
    reasonsJa: "材料待ちのため", scenarioJa: "", counterJa: "", invalidationJa: "",
    review: {
      verdict: "hit", reasonCode: "COMPARED", morningStance: "up", morningHeadlineJa: "上がるとみます",
      actualChangeDisplay: "+1.00%", actualSessionDate: "2026-10-14", textJa: "読みどおりでした",
    },
  });
});

test("V1 の返り値（新しい項目なし）は、従来どおりに読めて、新しい項目は null / []", () => {
  const raw = v1Raw("morning");
  const { report } = view(raw);
  assert.equal(report.presentationVersion, null);
  assert.equal(report.appStory, null);
  assert.deepEqual(report.sessionViews, []);
  assert.equal(report.yume, null);
  assert.equal(report.dataGeneratedAt, null);
  assert.ok(report.majorMoves.every((move) => move.metricKey === null));
  // 従来の項目は以前と同じ値。
  assert.equal(report.headlineJa, "見出し");
  assert.equal(report.summaryJa, "V1の要約");
  assert.deepEqual(report.pointsJa, ["p1", "p2", "p3", "p4"]);
  assert.deepEqual(report.claims[0], { textJa: "日経平均は上昇", claimType: "observation", scope: "today" });
  assert.deepEqual(report.majorMoves[0], { label: "ドル円", value: "150.00円", change: "+0.20%", sessionDate: "2026-10-13", stale: false, metricKey: null });
  assert.equal(report.majorMoves[5].stale, true);
  assert.deepEqual(report.strongThemes, ["半導体"]);
  assert.equal(report.generatedAt, "2026-10-13T23:05:00Z");
  // 古いサーバーは key_news の scope を返さないこともある。
  const { report: noScope } = view(v1Raw("morning", { key_news: [{ headline_ja: "ニュース", why_it_matters_ja: "理由" }] }));
  assert.deepEqual(noScope.keyNews, [{ headlineJa: "ニュース", whyJa: "理由", scope: null }]);
});

test("壊れた新しい項目は無視する（ゆめちゃんは予想・期間・見出し・理由が揃うときだけ、答え合わせは判定が正しいときだけ）", () => {
  const base = v2Raw("morning").yume as Raw;
  const yumeOf = (yume: unknown) => view(v2Raw("morning", { yume })).report.yume;
  assert.equal(yumeOf("文字列"), null);
  assert.equal(yumeOf({ ...base, stance: "sideways" }), null);
  assert.equal(yumeOf({ ...base, horizon: "next_week" }), null);
  assert.equal(yumeOf({ ...base, headline_ja: "  " }), null);
  assert.equal(yumeOf({ ...base, reasons_ja: null }), null);
  assert.equal(yumeOf({ ...base, review: { verdict: "maybe", text_ja: "x" } })?.review, null);
  assert.equal(yumeOf({ ...base, flat_band_pct: null })?.flatBandPct, YUME_DEFAULT_FLAT_BAND_PCT);
  assert.equal(yumeOf({ ...base, scenario_ja: undefined })?.scenarioJa, "");
  const odd = view(v2Raw("morning", { app_story: ["x"], session_views: { market: "us" }, presentation_version: 2 })).report;
  assert.equal(odd.appStory, null);
  assert.deepEqual(odd.sessionViews, []);
  assert.equal(odd.presentationVersion, null);
  const views = view(v2Raw("morning", { session_views: [{ market: "eu", direction: "up" }, { market: "us", direction: "" }, "x"] })).report;
  assert.deepEqual(views.sessionViews, []);
});

test("朝刊（V2）: ブロックの順と見出し、ゆめちゃんの予想、お話の小見出し、参考資料はいつも最後", () => {
  const { blocks } = view(v2Raw("morning"));
  assert.deepEqual(blocks.map((item) => item.key), ["points", "yume", "story", "outlook", "reference"]);
  assert.deepEqual(blocks.map((item) => item.heading), [
    "📌 今日のポイント", "🔮 ゆめちゃんの考察・予想", "📖 今日の相場のお話", "⚠️ この先の注目材料", "📊 参考資料｜主な市場指標",
  ]);
  assert.equal(blocks.at(-1)?.key, "reference");
  assert.deepEqual(block(blocks, "points").bullets, ["p1", "p2", "p3"], "ポイントは3つまで");

  const yume = block(blocks, "yume");
  assert.deepEqual(yume.paragraphs, [
    { subheading: "予想：きょうの日経平均は「上昇」", text: "上がるとみます" },
    { subheading: null, text: "米国株高を受けるため" },
    { subheading: null, text: "前場は高く始まりそう" },
  ]);
  assert.equal(yume.note, "基準：日経平均の前日比が±0.3%未満なら横ばい、それ以上なら上昇・下落。ゆめちゃん（AI）の見立てで、当たるとは限りません。");

  const story = block(blocks, "story");
  assert.equal(story.intro, "お話の要約");
  assert.deepEqual(story.paragraphs, [
    { subheading: "🇺🇸 前夜のアメリカ市場", text: "米国の話" },
    { subheading: "🇯🇵 日本株の見どころ", text: "日本の話" },
    { subheading: "💱 為替・金利・半導体", text: "為替の話" },
    { subheading: "📰 気になるニュース", text: "ニュースの話" },
    { subheading: "🔥 注目のテーマ", text: "強いテーマの話" },
  ]);
  assert.deepEqual(story.bullets, [
    "日銀会合 — 相場全体に効く", "米雇用統計 — 相場全体に効く", "半導体の需要 — 業種の材料", "A社が決算 — 個別の材料", "テーマ：半導体",
  ], "ニュースは 市場全体 → 業種 → 個別企業（同じ順位は元の順）");

  const outlook = block(blocks, "outlook");
  assert.deepEqual(outlook.paragraphs, [{ subheading: null, text: "注目の話" }, { subheading: null, text: "注意の話" }]);
  assert.deepEqual(outlook.bullets, [
    "米CPI", "円高", "弱めのテーマ：不動産", "ゆめちゃんの予想と逆の材料：円高が進むこと", "ゆめちゃんの予想が外れるとしたら：9時台に下げたら",
  ]);

  const reference = block(blocks, "reference");
  assert.equal(reference.intro, "対象：10月14日の朝刊。値の横に、それぞれの市場の取引日を書いています。");
  assert.equal(reference.meta, "データ取得：10月14日 07:40");
});

test("大引け（V2）: 答え合わせ（当たり）→ ゆめちゃんのことば → 次の営業日の見立て、お話は大引けの小見出し", () => {
  const { blocks } = view(v2Raw("close"));
  assert.deepEqual(blocks.map((item) => item.key), ["points", "yume", "story", "outlook", "reference"]);
  const yume = block(blocks, "yume");
  assert.deepEqual(yume.paragraphs, [
    { subheading: "朝の予想は「上昇」→ 結果は「当たり」（日経平均 前日比+1.00%）", text: "読みどおりでした" },
    { subheading: "次の営業日の見立て：日経平均は「横ばい」", text: "様子見とみます" },
    { subheading: null, text: "材料待ちのため" },
  ]);
  assert.match(yume.note ?? "", /ゆめちゃん（AI）の見立てで、当たるとは限りません。$/);
  const story = block(blocks, "story");
  assert.deepEqual(story.paragraphs, [
    { subheading: "🇯🇵 きょうの東京市場", text: "日本の話" },
    { subheading: "🌏 海外・為替・金利", text: "米国の話\n為替の話" },
    { subheading: "📰 相場を動かした材料", text: "ニュースの話" },
    { subheading: "🔥 強かったテーマ", text: "強いテーマの話" },
  ]);
  // 反対の材料・外れる条件が空なら、注目材料に出さない。
  assert.ok(!block(blocks, "outlook").bullets.some((line) => line.startsWith("ゆめちゃん")));
  assert.equal(block(blocks, "reference").intro, "対象：10月14日の大引け。値の横に、それぞれの市場の取引日を書いています。");
  // 海外の話が空なら、為替の話だけ。空の小見出しは出さない。
  const thin = view(v2Raw("close", { app_story: { ...STORY, overseas_ja: "", news_ja: "", strong_ja: " " } })).blocks;
  assert.deepEqual(block(thin, "story").paragraphs, [
    { subheading: "🇯🇵 きょうの東京市場", text: "日本の話" }, { subheading: "🌏 海外・為替・金利", text: "為替の話" },
  ]);
});

test("大引け: 答え合わせができないときは理由を出す（理由が分からなければ決まった文）", () => {
  const review = (reason_code: string, text_ja = "") => ({
    verdict: "undeterminable", reason_code, morning_stance: null, morning_headline_ja: null,
    actual_change_display: null, actual_session_date: null, text_ja,
  });
  const yumeWith = (r: Raw) => ({ ...(v2Raw("close").yume as Raw), review: r });
  const first = (raw: Raw) => block(view(raw).blocks, "yume").paragraphs[0];
  assert.deepEqual(first(v2Raw("close", { yume: yumeWith(review("NO_MORNING_FORECAST")) })), {
    subheading: "朝の予想との答え合わせはできません（この日の朝刊に予想の記録がありません）", text: "",
  });
  assert.equal(first(v2Raw("close", { yume: yumeWith(review("SOMETHING_NEW", "ことば")) })).subheading,
    "朝の予想との答え合わせはできません（比べられる記録がありません）");
  assert.equal(first(v2Raw("close", { yume: yumeWith(review("SOMETHING_NEW", "ことば")) })).text, "ことば");
  // 答え合わせが無い大引けは、次の営業日の見立てだけ。
  const none = block(view(v2Raw("close", { yume: yumeWith(null as unknown as Raw) })).blocks, "yume");
  assert.equal(none.paragraphs[0].subheading, "次の営業日の見立て：日経平均は「横ばい」");
});

test("古い回（V1 の返り値）: ゆめちゃんのブロックは無く、お話は要約と確認済みの動き", () => {
  const { blocks } = view(v1Raw("close"));
  assert.deepEqual(blocks.map((item) => item.key), ["points", "story", "outlook", "reference"]);
  const story = block(blocks, "story");
  assert.equal(story.intro, "V1の要約");
  assert.deepEqual(story.paragraphs, [{ subheading: null, text: "日経平均は上昇" }, { subheading: null, text: "半導体が強い" }]);
  assert.deepEqual(story.bullets.at(-1), "テーマ：半導体");
  assert.equal(story.bullets.length, 5);
  const outlook = block(blocks, "outlook");
  assert.deepEqual(outlook.paragraphs, []);
  assert.deepEqual(outlook.bullets, ["米CPI", "円高", "弱めのテーマ：不動産"]);
  // データの時刻が無いときは、レポートの作成時刻（ラベルも変える）。
  assert.equal(block(blocks, "reference").meta, "レポート作成：10月14日 08:05");
  // V1 は指標の種類を返さないので、すべて3つ目のまとまり（値は作らない）。
  const groups = block(blocks, "reference").groups ?? [];
  assert.deepEqual(groups.map((group) => group.title), ["為替・金利・商品など"]);
  assert.equal(groups[0].rows.length, MOVES.length);
});

test("ポイントが無ければブロックごと出さない。何も無いブロックも出さない", () => {
  const { blocks } = view(v1Raw("morning", {
    points_ja: [], next_watch_ja: [], risks_ja: [], weak_themes: [], major_moves: [], data_gaps_ja: [],
  }));
  assert.deepEqual(blocks.map((item) => item.key), ["story"]);
  // 時刻が読めなければ、時刻の行は出さない。
  const noTime = view(v1Raw("morning", { generated_at: null })).blocks;
  assert.equal(block(noTime, "reference").meta, undefined);
});

test("参考資料: 指標を種類で分ける（東京・米国・その他。知らない種類と種類なしは3つ目）。返ってきた行だけ", () => {
  const { report, blocks } = view(v2Raw("morning", { data_gaps_ja: ["WTI 原油を取得できませんでした"] }));
  const groups = indicatorGroups(report.majorMoves);
  assert.deepEqual(groups.map((group) => group.title), ["東京市場", "米国市場", "為替・金利・商品など"]);
  assert.deepEqual(groups[0].rows.map((row) => row.label), ["日経平均", "TOPIX連動ETF（1306）"]);
  assert.deepEqual(groups[1].rows.map((row) => row.label), ["NYダウ", "S&P500"]);
  assert.deepEqual(groups[2].rows.map((row) => row.label), ["ドル円", "米10年債", "新しい指標", "種類なし"]);
  assert.equal(groups.flatMap((group) => group.rows).length, MOVES.length, "行を足さない・落とさない");
  assert.deepEqual(groups[0].rows[0], { label: "日経平均", value: "40,000", change: "+1.00%", sessionDateJa: "10月13日", stale: false });
  assert.deepEqual(groups[2].rows[1], { label: "米10年債", value: "4.10%", change: null, sessionDateJa: "10月9日", stale: true });
  const reference = block(blocks, "reference");
  assert.equal(reference.bulletsTitle, "確認できなかったデータ");
  assert.deepEqual(reference.bullets, ["WTI 原油を取得できませんでした"]);
  // 東京・米国の指標が無ければ、そのまとまりは出さない（ナスダックが無くても作らない）。
  const onlyFx = indicatorGroups(view(v2Raw("morning", { major_moves: [MOVES[0]] })).report.majorMoves);
  assert.deepEqual(onlyFx.map((group) => group.title), ["為替・金利・商品など"]);
  assert.equal(dateTimeJa("2026-10-14T06:05:00Z"), "10月14日 15:05");
  assert.equal(dateTimeJa("not a time"), "");
});

test("ゆめちゃんの文言はサーバー（market_report_yume.ts）と同じ", () => {
  assert.deepEqual(YUME_STANCE_JA, backend.YUME_STANCE_JA);
  assert.deepEqual(YUME_VERDICT_JA, backend.YUME_VERDICT_JA);
  assert.deepEqual(YUME_UNDETERMINABLE_JA, backend.YUME_UNDETERMINABLE_JA);
  assert.equal(YUME_DEFAULT_FLAT_BAND_PCT, backend.YUME_FLAT_BAND_PCT);
  for (const band of [0.3, 0.5, 1]) assert.equal(bandRuleJa(band), backend.bandRuleJa(band));
  // 答え合わせの1行: 判定ごと・理由ごとに、サーバーの reviewLineJa と同じ文。
  const stances = ["up", "down", "flat"] as const;
  for (const verdict of ["hit", "partial", "miss"] as const) {
    for (const stance of stances) {
      const server = backend.reviewLineJa({
        verdict, reason_code: "COMPARED", morning_report_packet_id: "x", morning_stance: stance, morning_headline_ja: "h",
        flat_band_pct: 0.3, actual_change_pct: -0.45, actual_change_display: "−0.45%", actual_session_date: "2026-10-14", text_ja: "",
      });
      const app = yumeReviewLineJa({
        verdict, reasonCode: "COMPARED", morningStance: stance, morningHeadlineJa: "h", actualChangeDisplay: "−0.45%",
        actualSessionDate: "2026-10-14", textJa: "",
      });
      assert.equal(app, server, `${verdict}/${stance}`);
    }
  }
  for (const reason of [...Object.keys(backend.YUME_UNDETERMINABLE_JA), "UNKNOWN_REASON"]) {
    const server = backend.reviewLineJa({
      verdict: "undeterminable", reason_code: reason, morning_report_packet_id: null, morning_stance: null, morning_headline_ja: null,
      flat_band_pct: null, actual_change_pct: null, actual_change_display: null, actual_session_date: null, text_ja: "",
    });
    const app = yumeReviewLineJa({
      verdict: "undeterminable", reasonCode: reason, morningStance: null, morningHeadlineJa: null, actualChangeDisplay: null,
      actualSessionDate: null, textJa: "",
    });
    assert.equal(app, server, reason);
  }
  assert.ok(backend.reviewLineJa({
    verdict: "undeterminable", reason_code: "UNKNOWN_REASON", morning_report_packet_id: null, morning_stance: null,
    morning_headline_ja: null, flat_band_pct: null, actual_change_pct: null, actual_change_display: null, actual_session_date: null, text_ja: "",
  }).includes(YUME_UNDETERMINABLE_DEFAULT_JA));
  // 生成側と同じ見出し（アプリのブロックの見出しは固定）。
  assert.deepEqual(Object.values(MARKET_REPORT_HEADINGS), [
    "📌 今日のポイント", "🔮 ゆめちゃんの考察・予想", "📖 今日の相場のお話", "⚠️ この先の注目材料", "📊 参考資料｜主な市場指標",
  ]);
});

test("配線: 画面はブロックの順に描き、参考資料を最後（免責の前）に置く。古い平らな見出しは無い", async () => {
  const screen = (await Deno.readTextFile(new URL("../../src/app/market-report.tsx", import.meta.url)))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(screen.includes("buildMarketReportView(report).blocks"), "ブロックは純粋な関数で組み立てる");
  assert.ok(screen.includes("{bodyBlocks.map((block) => <ReportBlock key={block.key} block={block} />)}"));
  const order = ["{bodyBlocks.map(", "{analysis.enabled && (", "{referenceBlock && <ReportBlock block={referenceBlock} />}", "{REPORT_DISCLAIMER_JA}"]
    .map((marker) => screen.indexOf(marker));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), `並び: ${order}`);
  assert.ok(screen.includes('accessibilityRole="header">{block.heading}</Text>'), "見出しは読み上げで見出しとして扱う");
  assert.ok(screen.includes("{row.stale ? '前回値' : row.change ?? '—'}"), "前回の値は「前回値」");
  for (const old of [">ポイント<", ">主な指標<", "'今日の動き'", "'見ておきたい動き'", ">テーマ<", ">主なニュース<", ">次に見るポイント<", ">気をつけたい点<"]) {
    assert.ok(!screen.includes(old), `古い見出し ${old}`);
  }
  // 純粋な関数は型だけを読み込む（Deno から単体で動かせる）。
  const lib = await Deno.readTextFile(new URL("../../src/lib/market-report-view.ts", import.meta.url));
  assert.ok(!/^import (?!type )/m.test(lib), "型以外の import は無い");
  assert.ok(!/react|supabase|fetch\(/i.test(lib.replace(/^\/\/.*$/gm, "")), "React・通信を使わない");
});
