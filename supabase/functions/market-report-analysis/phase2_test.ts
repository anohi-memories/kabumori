// 共通朝刊・大引け Phase 2 (2026-10-14, F2): TOPIX and the ETF 1306, content-based news selection, the column prompt,
// the rewrite triggers and the X order. Offline: real repository fixtures, scripted model answers, a fake PostgREST.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnalysisInput,
  hasMarketLink,
  isCorporateNews,
  isMarketMovingCompanyNews,
  MAX_UNLINKED_BROAD_ITEMS,
  newsScope,
  type NewsInputItem,
  type NewsTextRow,
  selectMarketWideNews,
  TOPIX_GAP_JA,
} from "./analysis_input.ts";
import { assemblePacket, codeFallbacks, generationRequestBody, qualityRewriteHints, unitChecker } from "./analysis_logic.ts";
import { type Deps, handleRequest, JAPAN_METRICS_ENV } from "./handler.ts";
import { formatSharedXPost, REPORT_DISCLAIMER_JA } from "../_shared/market_report_packet.ts";
import type { MarketDataPacket } from "../market-report-data-packet/packet_schema.ts";
import { inputOf, loadFixture, rich0917, richMorning1001, YUME_MORNING_FIXTURE } from "./test_support.ts";

const close0917 = await loadFixture("close_2026-09-17");
const close1001 = await loadFixture("close_2026-10-01");
const morning1001 = await loadFixture("morning_2026-10-01");

/** The 10/14 close shape: the Nikkei inside the flat band of the direction (−0.05%), the ETF 1306 down (−0.28%). */
function oct14Shape(packet: MarketDataPacket): MarketDataPacket {
  return {
    ...packet,
    metrics: packet.metrics.map((metric) =>
      metric.key === "nikkei225" ? { ...metric, change_pct: -0.05, change: -32 } : metric.key === "topix_proxy_1306" ? { ...metric, change_pct: -0.28, change: -1.2 } : metric
    ),
  };
}

const build = (packet: MarketDataPacket, japanMetrics: "nikkei_only" | "legacy_1306") =>
  buildAnalysisInput({
    dataPacket: packet, dataPacketId: close0917.data.id, dataContentHash: close0917.data.content_hash, newsRows: close0917.news,
    japanMetrics,
  });

// ---- 2. TOPIX: never the ETF in its place ----------------------------------------------------------------------------

test("nikkei_only: 1306 is not in the metrics, the facts, the model input or the direction; the TOPIX gap is stated", () => {
  const input = build(close0917.data.payload, "nikkei_only");
  assert.ok(!input.majorMoves.some((move) => move.metric_key === "topix_proxy_1306"));
  assert.ok(!input.metricFacts.some((fact) => fact.key === "topix_proxy_1306"));
  const model = input.modelInput as { 指標: Array<{ ref: string; 名称: string }>; 取得できなかったデータ: string[] };
  assert.ok(!model.指標.some((metric) => metric.ref === "metric:topix_proxy_1306" || metric.名称.includes("TOPIX")));
  assert.ok(!input.allowedRefs.has("metric:topix_proxy_1306"), "1306 cannot be cited");
  assert.deepEqual(input.directionBasis, ["nikkei225"]);
  assert.deepEqual(input.sessionViews.find((view) => view.market === "tokyo")?.basis, ["nikkei225"]);
  assert.ok(input.dataGapsJa.includes(TOPIX_GAP_JA) && model.取得できなかったデータ.includes(TOPIX_GAP_JA));
  // The stored data packet is not changed: 1306 is still collected there.
  assert.ok(close0917.data.payload.metrics.some((metric) => metric.key === "topix_proxy_1306"));
});

test("the 10/14 close shape: the ETF no longer turns a flat Nikkei into a 'down' market", () => {
  const packet = oct14Shape(close0917.data.payload);
  assert.equal(build(packet, "legacy_1306").direction, "down", "before: the ETF's −0.28% decided the direction");
  assert.equal(build(packet, "nikkei_only").direction, "flat", "after: the Nikkei 225 (−0.05%) alone");
});

test("the prompt says TOPIX is not in the input only when the ETF is not either; legacy keeps the 1306 rules", () => {
  const nikkeiOnly = String(generationRequestBody(build(close0917.data.payload, "nikkei_only"), []).instructions);
  const legacy = String(generationRequestBody(build(close0917.data.payload, "legacy_1306"), []).instructions);
  assert.ok(nikkeiOnly.includes("入力には TOPIX（指数）の値がありません（TOPIX連動ETF（1306）も使いません）"));
  assert.ok(nikkeiOnly.includes("日経平均と TOPIX の比較を書きません"));
  assert.ok(!legacy.includes("入力には TOPIX（指数）の値がありません"));
});

test("a sentence about TOPIX or 1306 is removed when neither is in the input; the Nikkei sentence stays", () => {
  const input = build(oct14Shape(close0917.data.payload), "nikkei_only");
  const check = unitChecker(input, []);
  const topix = check("9月17日のTOPIXは日経平均より大きく下げました。", "factual");
  assert.ok(topix.remove.some((finding) => finding.code === "TOPIX_MISLABEL" && finding.detail.startsWith("入力に無いTOPIX（指数）")), JSON.stringify(topix));
  const etf = check("9月17日のTOPIX連動ETF（1306）は427.4円でした。", "factual");
  assert.ok(etf.remove.length > 0, "the ETF's value is not in the input either");
  const nikkei = input.metricFacts.find((fact) => fact.key === "nikkei225")!;
  assert.deepEqual(check(`9月17日の日経平均は${nikkei.valueDisplay}（前日比${nikkei.changeDisplay}）でした。`, "factual").remove, []);
});

test("the code fallback summary never prints the ETF in nikkei_only mode", () => {
  const fallbacks = codeFallbacks(build(close0917.data.payload, "nikkei_only"));
  assert.ok(!fallbacks.summary.includes("1306") && !fallbacks.summary.includes("TOPIX"), fallbacks.summary);
  assert.ok(fallbacks.summary.includes("日経平均"));
});

// ---- 3. news: content decides, not the label --------------------------------------------------------------------------

const row = (patch: Partial<NewsTextRow>): NewsTextRow => ({
  id: crypto.randomUUID(), source_type: "news", company_code: null, company_name: null, title: null,
  coverage_severity: "high", coverage_categories: [], published_at: "2026-10-14T06:00:00Z", created_at: "2026-10-14T06:00:00Z",
  app_title_ja: null, app_summary_ja: null, app_copy_fact_status: "passed", generated_text: null, generation_fact_status: null, ...patch,
});

test("10/14: a small company's results without a company code, tagged 東証 / 為替 by keywords, are company news and left out", () => {
  const axus = row({
    app_title_ja: "アクサスHD（3536）、上期経常は増益で着地", app_summary_ja: "東証スタンダード上場のアクサスHDが決算を発表。円安も追い風。",
    coverage_categories: ["earnings", "corporate", "japan_market", "fx"],
  });
  const packet = { ...close0917.data.payload, news_refs: { ...close0917.data.payload.news_refs, items: [{ ...close0917.data.payload.news_refs.items[0], ref_id: axus.id }] } };
  const input = buildAnalysisInput({ dataPacket: packet, dataPacketId: "d", dataContentHash: "h", newsRows: [axus], newsSelection: "market_wide" });
  assert.deepEqual(input.news, []);
  assert.deepEqual(input.excludedNews, [{ ref: `news:${axus.id}`, reason: "COMPANY_NOT_MARKET_WIDE" }]);
  // Before Phase 2 the same row was 市場全体.
  assert.equal(newsScope(["earnings", "corporate", "japan_market", "fx"], false, "アクサスHD（3536）、上期経常は増益"), "company");
});

test("company detection: a code, a company form, or a disclosure without a macro story; macro news is not a company's", () => {
  assert.ok(isCorporateNews([], false, "アクサスホールディングスが配当を発表"));
  assert.ok(isCorporateNews(["japan_market"], false, "某社が決算を発表、東証で上昇"));
  assert.ok(!isCorporateNews(["us_market"], false, "米大手銀の決算を受けてNY株が上昇"), "a market story told through earnings");
  assert.ok(!isCorporateNews(["monetary_policy"], false, "日銀が政策金利を据え置き"));
  assert.equal(newsScope(["us_market", "earnings"], false, "米大手銀の決算を受けてNY株が上昇"), "broad");
});

const company = (patch: Partial<NewsInputItem>): NewsInputItem => ({
  ref: "news:c", headline_ja: "某社の発表", summary_ja: null, severity: "high", categories: ["corporate"], company: null,
  published_at: null, scope: "company", ...patch,
});

test("market-moving companies: majors by code, global majors by name, critical semiconductor / energy news; never an AI tag alone", () => {
  assert.ok(isMarketMovingCompanyNews(company({ company: "トヨタ自動車（7203）", headline_ja: "トヨタが通期見通しを下方修正" })));
  assert.ok(isMarketMovingCompanyNews(company({ headline_ja: "東京エレクトロン（8035）が受注見通しを引き上げ" })), "code in the text");
  assert.ok(isMarketMovingCompanyNews(company({ headline_ja: "エヌビディア決算、データセンター売上が拡大", categories: ["earnings", "semiconductors"] })));
  assert.ok(isMarketMovingCompanyNews(company({ severity: "critical", categories: ["semiconductors", "corporate"], company: "中堅半導体（6999）" })));
  assert.ok(!isMarketMovingCompanyNews(company({ severity: "critical", categories: ["ai_tech", "corporate"], company: "SBIインシュアランス（7326）" })));
  assert.ok(!isMarketMovingCompanyNews(company({ severity: "medium", company: "トヨタ自動車（7203）" })), "a major's routine item (medium) stays out");
  assert.ok(!isMarketMovingCompanyNews(company({ company: "アクサスHD（3536）" })));
});

test("a broad item without a stated path to prices: at most two, the rest logged; linked items always stay", () => {
  const conflict = (ref: string) => ({ ref, headline_ja: `${ref}の地域で衝突`, summary_ja: "日本株への影響は限定的とみられます。", severity: "high", categories: ["geopolitics"], company: null, published_at: null, scope: "broad" as const });
  assert.ok(!hasMarketLink(conflict("news:a")), "a stock line in the summary is not a path (headline only)");
  const oil = { ...conflict("news:oil"), headline_ja: "ホルムズ海峡で緊張、原油の供給に懸念" };
  const { kept, excluded } = selectMarketWideNews([conflict("news:a"), oil, conflict("news:b"), conflict("news:c"), conflict("news:d")]);
  assert.equal(MAX_UNLINKED_BROAD_ITEMS, 2);
  assert.deepEqual(kept.map((news) => news.ref), ["news:a", "news:oil", "news:b"]);
  assert.deepEqual(excluded.map((news) => news.reason), ["BROAD_NO_MARKET_LINK_CAP", "BROAD_NO_MARKET_LINK_CAP"]);
});

test("the model is told which kept items have no confirmed path to prices", () => {
  const input = inputOf(close1001, { newsSelection: "market_wide" });
  const model = (input.modelInput as { ニュース: Array<{ 見出し: string; 市場との関係: string }> }).ニュース;
  assert.ok(model.every((news) => news.市場との関係 === "あり" || news.市場との関係 === "未確認"));
  assert.ok(model.filter((news) => news.市場との関係 === "未確認").length <= MAX_UNLINKED_BROAD_ITEMS);
  assert.ok(model.some((news) => news.見出し.includes("エネルギー施設") && news.市場との関係 === "あり"));
  const prompt = String(generationRequestBody(input, []).instructions);
  assert.ok(prompt.includes("入力にニュースがあるという理由だけで主な材料にしません"));
});

// ---- 4. the column prompt ------------------------------------------------------------------------------------------------

test("the prompt asks for one connected column, varied wording and no restating; the fact rules are unchanged", () => {
  for (const input of [inputOf(morning1001), inputOf(close0917)]) {
    const prompt = String(generationRequestBody(input, []).instructions);
    assert.ok(prompt.includes("ゆめちゃんはニュースを読み上げるアナウンサーではなく"));
    assert.ok(prompt.includes("「市場の事実 → その背景 → ゆめちゃんの解釈 → 考えられる今後の展開 → リスク」"));
    assert.ok(prompt.includes("段落の書き出しは前の段落を受けます"));
    assert.ok(prompt.includes("同じ言い回し（「私は〜と見ています」を含む）を段落ごとに繰り返しません"));
    for (const phrase of ["市場の空気", "温度差", "頭の片隅に置いておきたい", "見ておきたいところです", "動向を注視する必要があります", "〜という見方もできます"]) {
      assert.ok(prompt.includes(`「${phrase}」`), phrase);
    }
    assert.ok(prompt.includes("今日のポイント（points_ja）に書いたことを本文でそのまま言い直さず"));
    assert.ok(prompt.includes("長さは必要以上に削らなくてかまいません"));
    assert.ok(!prompt.includes("「〜と考えられます」「〜しやすい」「〜の可能性があります」「〜が焦点です」のように"), "no stock hedges handed to the model");
    assert.ok(prompt.includes("同じ項目の中で同じ日付の同じ市場に続けて触れるときは、日付を毎回くり返さなくてかまいません"));
    assert.ok(prompt.includes("日付の違う指標を1つの文に並べるときは、それぞれの日付を書きます"), "the date rule that prevents the 10/01 mix-up stays");
    assert.ok(prompt.includes("すでに起きた値動きの理由は、入力のニュースが理由として明記している（causal の claim がある）場合だけ事実として書きます"));
  }
  const morning = String(generationRequestBody(inputOf(morning1001), []).instructions);
  const close = String(generationRequestBody(inputOf(close0917), []).instructions);
  assert.ok(morning.includes("朝刊の目的は、今日の市場がどう動くとゆめちゃんが考えるかを伝えることです"));
  assert.ok(close.includes("大引けの目的は、今日の市場で何が起きたか、それをゆめちゃんがどう考えるかを伝えることです"));
  assert.ok(close.includes("実際のデータから何を読み違えたかを考察します"));
});

test("an empty optional paragraph no longer buys a rewrite (it bought filler); a missing core paragraph still does", () => {
  for (const optional of ["news", "strong", "cross_asset", "watch", "moves"]) {
    assert.deepEqual(qualityRewriteHints([`APP_STORY_SECTION_OMITTED:${optional}`]), [], optional);
  }
  assert.deepEqual(qualityRewriteHints(["X_POST_WATCH_OMITTED", "X_POST_NEWS_OMITTED"]), []);
  for (const core of ["summary", "japan", "overseas"]) assert.equal(qualityRewriteHints([`APP_STORY_SECTION_OMITTED:${core}`]).length, 1, core);
  assert.equal(qualityRewriteHints(["X_POST_CONTEXT_OMITTED"]).length, 1);
  assert.ok(!qualityRewriteHints(["APP_STORY_SHORTER_THAN_TARGET:600"])[0].includes("900字以上"), "the hint no longer asks for a length");
});

// ---- 7. X: ① 📌 points ② the short commentary ③ 🔮 her call ------------------------------------------------------------

test("X: the points open the post, then one commentary paragraph, then her call with its own 🔮", () => {
  const input = inputOf(morning1001);
  const analysis = { ...richMorning1001(input), yume: YUME_MORNING_FIXTURE };
  const packet = assemblePacket(input, analysis, { generatedAt: new Date("2026-09-30T22:56:00Z"), attempts: 1 });
  const post = formatSharedXPost(packet);
  const blocks = post.split("\n\n");
  assert.ok(blocks[0].startsWith("【朝刊】きょうの日本株、ここをチェック☀️\n📌 今日のポイント\n・"));
  assert.equal(blocks[1], `${analysis.x_post.lead_ja}\n${analysis.x_post.context_ja}`);
  const call = blocks.findIndex((block) => block.startsWith("🔮ゆめちゃんの予想："));
  assert.ok(call > 1 && blocks[call + 1] === REPORT_DISCLAIMER_JA, "her call is the last paragraph before the disclaimer");
  assert.ok(!post.includes("💬"), "no 💬 title over her call");
});

test("X without points starts with the header and the lead, and still ends with her call", () => {
  const input = inputOf(morning1001);
  const analysis = { ...richMorning1001(input), yume: YUME_MORNING_FIXTURE };
  const packet = assemblePacket(input, { ...analysis, x_post: { ...analysis.x_post, points_ja: [] } }, { generatedAt: new Date(), attempts: 1 });
  const blocks = formatSharedXPost(packet).split("\n\n");
  assert.equal(blocks[0], `【朝刊】きょうの日本株、ここをチェック☀️\n${analysis.x_post.lead_ja}`);
  assert.equal(blocks[1], analysis.x_post.context_ja);
});

// ---- handler: the defaults and the switches ------------------------------------------------------------------------------

const SUPABASE = "https://project-ref.supabase.co";
const SECRET = "cron-secret-for-tests";

function harness(env: Record<string, string>) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url === "https://api.openai.com/v1/responses") {
      const isFact = String(body?.instructions).includes("Factチェッカー");
      return json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(isFact ? { passed: true, issues: [] } : rich0917(inputOf(close0917))) }] }], usage: { input_tokens: 900, output_tokens: 300 } });
    }
    const path = url.slice(`${SUPABASE}/rest/v1/`.length);
    if (path.startsWith("market_holidays")) return json([]);
    if (path === "rpc/claim_market_report_analysis") {
      return json([{ cycle_id: "11111111-1111-4111-8111-111111111111", claim_token: "22222222-2222-4222-8222-222222222222", attempt: 1, outcome: "claimed", data_packet_id: close0917.data.id }]);
    }
    if (path.startsWith("market_data_packets")) return json([{ id: close0917.data.id, content_hash: close0917.data.content_hash, payload: close0917.data.payload, data_quality_status: "partial" }]);
    if (path.startsWith("important_news_candidates")) return json(close0917.news);
    if (path.startsWith("market_report_generation_traces")) return json(null, 201);
    if (path === "rpc/complete_market_report_analysis") return json("33333333-3333-4333-8333-333333333333");
    if (path === "rpc/fail_market_report_analysis") return json("failed");
    throw new Error(`UNEXPECTED_PATH:${path}`);
  };
  const deps: Deps = {
    env: (name) => ({ SUPABASE_URL: SUPABASE, SUPABASE_SECRET_KEYS: JSON.stringify({ default: "service-NOT-REAL" }), SEND_PUSH_NOTIFICATIONS_CRON_SECRET: SECRET, OPENAI_API_KEY: "openai-NOT-REAL", ...env } as Record<string, string>)[name],
    fetch: fetchMock, now: () => new Date("2026-09-17T07:20:00Z"), sleep: () => Promise.resolve(),
  };
  return { calls, deps };
}

const run = (deps: Deps) => handleRequest(new Request("https://functions.local/market-report-analysis", {
  method: "POST", headers: { "Content-Type": "application/json", "X-Cron-Secret": SECRET }, body: JSON.stringify({ mode: "close" }),
}), deps);

test("handler default: the model input has no 1306 and states the TOPIX gap; diagnostics record japan_metrics", async () => {
  const { calls, deps } = harness({});
  await run(deps);
  const generate = calls.find((call) => call.url.includes("openai") && !String(call.body?.instructions).includes("Factチェッカー"))!;
  const modelInput = String(generate.body!.input);
  assert.ok(!modelInput.includes("1306") && !modelInput.includes("topix_proxy"));
  assert.ok(modelInput.includes(TOPIX_GAP_JA));
  const done = calls.filter((call) => /rpc\/(complete|fail)_market_report_analysis$/.test(call.url)).at(-1)!;
  assert.equal((done.body!.p_diagnostics as Record<string, string>).japan_metrics, "nikkei_only");
});

test(`${JAPAN_METRICS_ENV}=legacy_1306 restores the pre-Phase-2 input without a deploy`, async () => {
  const { calls, deps } = harness({ [JAPAN_METRICS_ENV]: "legacy_1306", KABUMORI_MARKET_REPORT_NEWS_SELECTION: "all" });
  const body = await (await run(deps)).json();
  assert.equal(body.status, "completed");
  const generate = calls.find((call) => call.url.includes("openai") && !String(call.body?.instructions).includes("Factチェッカー"))!;
  assert.ok(String(generate.body!.input).includes("metric:topix_proxy_1306"));
});
