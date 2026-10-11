// Delivery-first calibration of the causal guard (2026-10-01 close). The first natural v2 close failed
// both scheduled attempts on a sentence that restated a news item:
//   input news : 「AI向け半導体需要の拡大を背景に、半導体輸出も大幅に増加しました」
//   generated  : 「AI向け半導体需要を背景に半導体輸出も大幅増と報じられました」
// That is the news item's own cause and effect, not a reason for the Tokyo market's move. A cause given
// for a market / index move stays a hard reject unless the news supports that market causality.
// Inputs are the real 10/1 close packets (fixtures/close_2026-10-01_*); the generated text is hand-written.
import assert from "node:assert/strict";
import test from "node:test";
import type { MarketDataPacket } from "../market-report-data-packet/packet_schema.ts";
import { formatSharedXPost } from "../_shared/market_report_packet.ts";
import { appStoryText, buildAppMarketStory } from "../_shared/market_report_story.ts";
import {
  assemblePacket,
  type GeneratedAnalysis,
  generateSharedAnalysis,
  localAnalysisCheck,
  MAX_GENERATIONS,
  type Requester,
} from "./analysis_logic.ts";
import { inputOf, loadFixture, richClose1001, richMorning1001 } from "./test_support.ts";

const close1001 = await loadFixture("close_2026-10-01");
const morning1001 = await loadFixture("morning_2026-10-01");
const input = inputOf(close1001);
const KOREA = input.news.find((item) => item.headline_ja.includes("韓国の9月輸出"))!.ref;
const FAILED_SENTENCE = "AI向け半導体需要を背景に半導体輸出も大幅増と報じられました";
const CAUSAL = "根拠の無い因果の断定";
const NOW = () => new Date("2026-10-01T07:20:30Z");

const hard = (analysis: GeneratedAnalysis, built = input) => localAnalysisCheck(analysis, built).hard;
const has = (issues: string[], fragment: string) => issues.some((issue) => issue.includes(fragment));
/** The 10/1 analysis with one more sentence in the X news paragraph and the app news section. */
function withNews(sentence: string, mutate: (analysis: GeneratedAnalysis) => void = () => {}): GeneratedAnalysis {
  const analysis = richClose1001(input);
  analysis.x_post.news_ja = `${sentence}。米国ではトランプ大統領がAI企業と安全対策の自主協定を発表しています。`;
  analysis.app_story!.news_ja = `${sentence}。米国では、トランプ大統領がAI企業と安全対策の自主協定を発表しました。`;
  mutate(analysis);
  return analysis;
}
const withoutKoreaClaim = (analysis: GeneratedAnalysis) => { analysis.claims = analysis.claims.filter((claim) => claim.claim_id !== "c4"); };
const withCausalKoreaClaim = (analysis: GeneratedAnalysis) => {
  analysis.claims[3] = { claim_id: "c4", text_ja: "韓国の9月輸出は過去最高を更新しました。", claim_type: "causal", evidence_refs: [KOREA], scope: "today" };
};

function requester(steps: Array<{ step: "generate" | "fact"; payload: unknown }>, calls: string[] = []): Requester {
  return (step) => {
    calls.push(step);
    const next = steps.shift();
    assert.ok(next, `unexpected ${step} call`);
    assert.equal(next.step, step);
    return Promise.resolve({ payload: next.payload, inputTokens: 1000, outputTokens: 400 });
  };
}

// ---------------------------------------------------------------------------------------------
// Must PASS
// ---------------------------------------------------------------------------------------------

test("the news item is in the input and states the cause itself", () => {
  const item = input.news.find((news) => news.ref === KOREA)!;
  assert.equal(KOREA, "news:47b69d8a-4a57-40c1-b9c1-efddb404a21b");
  assert.ok(item.summary_ja!.includes("AI向け半導体需要の拡大を背景に、半導体輸出も大幅に増加しました"));
  assert.ok(!/東京市場|日経|日本株|株式/.test(`${item.headline_ja}${item.summary_ja}`), "it says nothing about a stock market");
});

test("1+3: the 10/1 sentence passes as an observation claim, in the X news paragraph and in the app news section", () => {
  const analysis = richClose1001(input);
  assert.equal(analysis.claims[3].claim_type, "observation");
  assert.ok(analysis.claims[3].text_ja.includes(FAILED_SENTENCE));
  assert.ok(analysis.x_post.news_ja!.includes(FAILED_SENTENCE) && analysis.app_story!.news_ja.includes(FAILED_SENTENCE));
  assert.deepEqual(localAnalysisCheck(analysis, input), { hard: [], warnings: [] });
});

test("1: referenced only through key_news, or not typed as a claim at all, it still passes", () => {
  assert.deepEqual(hard(withNews(FAILED_SENTENCE, withoutKoreaClaim)), []);
  // The exact 16:35 shape: the sentence alone, no claim about the item.
  const bare = withNews(FAILED_SENTENCE, (analysis) => {
    withoutKoreaClaim(analysis);
    analysis.key_news = analysis.key_news.filter((news) => news.ref !== KOREA);
  });
  assert.deepEqual(hard(bare), []);
  // Other faithful wordings of the same item.
  for (const sentence of [
    "韓国ではAI向け半導体需要の拡大を背景に、半導体輸出が大幅に増加しました",
    "AI向け半導体需要を背景に、韓国の半導体輸出も大幅に増えたと伝えられています",
  ]) {
    assert.deepEqual(hard(withNews(sentence, withoutKoreaClaim)), [], sentence);
  }
});

test("2: saying the reason for the market move is unknown passes", () => {
  for (const sentence of [
    "東京市場の上昇理由は、確認できる材料だけでは断定できません",
    "東京市場が上昇した理由を説明するニュースは確認できません",
  ]) {
    const analysis = richClose1001(input);
    analysis.x_post.closing_ja = `${sentence}。`;
    analysis.x_post.context_ja = "10月1日の東京市場は日経平均の上げ幅が大きく、TOPIX連動ETF（1306）も上昇しました。9月30日の米国市場はNYダウとS&P500が下落し、ナスダック総合は上昇と方向が分かれています。";
    assert.deepEqual(hard(analysis), [], sentence);
  }
});

test("a reworded but faithful restatement passes; the model need not copy the news text", () => {
  for (const sentence of [
    "AI半導体の需要拡大を背景に半導体輸出が大きく増えたと報じられました",
    "韓国の輸出統計では、AI向け半導体需要を背景に半導体輸出も大幅増となりました",
    "AI向け半導体需要の拡大を受けて、韓国の半導体輸出は大幅に増加しました",
    "半導体需要を背景に韓国の輸出が過去最高になったと報じられました",
  ]) {
    for (const mutate of [() => {}, withoutKoreaClaim, withCausalKoreaClaim]) {
      assert.deepEqual(hard(withNews(sentence, mutate)), [], sentence);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Must FAIL
// ---------------------------------------------------------------------------------------------

test("4: the same news cause attached to the Tokyo market's move is rejected, with or without a causal claim", () => {
  const sentences = [
    "AI向け半導体需要を背景に東京市場も上昇しました",
    "AI向け半導体需要を背景に日経平均も大きく上昇しました",
    "AI向け半導体需要を背景に日本株も買われました",
    // No subject: a price move with no named subject is read as the market's.
    "AI向け半導体需要を背景に上昇しました",
  ];
  for (const sentence of sentences) {
    for (const mutate of [() => {}, withoutKoreaClaim, withCausalKoreaClaim]) {
      const issues = hard(withNews(sentence, mutate));
      assert.ok(has(issues, CAUSAL), `accepted: ${sentence}`);
    }
    const headline = richClose1001(input);
    headline.headline_ja = sentence;
    assert.ok(has(hard(headline), CAUSAL), `accepted in headline: ${sentence}`);
  }
});

test("5: the news item does not license an unrelated cause or an unrelated effect", () => {
  for (const sentence of [
    // unrelated market causes
    "韓国の輸出増加を受けて日経平均は上昇しました",
    "AI向け半導体需要を背景に米国株も上昇しました",
    "米国株高を受けて東京市場は上昇しました",
    // a cause the item does not state
    "中東情勢の緊迫を背景に半導体輸出も大幅増と報じられました",
    "円安を背景に半導体輸出も大幅増と報じられました",
    // an effect the item does not state
    "AI向け半導体需要を背景に原油価格も上昇したと報じられました",
    "AI向け半導体需要を背景に雇用も拡大したと報じられました",
  ]) {
    for (const mutate of [() => {}, withCausalKoreaClaim]) {
      assert.ok(has(hard(withNews(sentence, mutate)), CAUSAL), `accepted: ${sentence}`);
    }
  }
});

test("6: reversing the effect or swapping cause and effect is rejected", () => {
  for (const sentence of [
    "AI向け半導体需要を背景に半導体輸出は大幅減と報じられました",
    "AI向け半導体需要を背景に半導体輸出も大幅に減少しました",
    "半導体輸出の増加を背景にAI向け半導体需要が拡大したと報じられました",
    // the cause reversed, and a second cause the item does not state
    "AI向け半導体需要の縮小を背景に半導体輸出も大幅増と報じられました",
    "AI向け半導体需要と円安を背景に半導体輸出も大幅増と報じられました",
  ]) {
    for (const mutate of [() => {}, withCausalKoreaClaim]) {
      assert.ok(has(hard(withNews(sentence, mutate)), CAUSAL), `accepted: ${sentence}`);
    }
  }
});

test("7: a mistyped or nonexistent news ref stays a hard reject (the 16:20 attempt)", () => {
  const mistyped = richClose1001(input);
  mistyped.claims[3].evidence_refs = ["news:47b69d8a-4a57-40c1-b9c1-efddb404b0b1"];
  const issues = hard(mistyped);
  assert.ok(has(issues, "入力に無い ref: news:47b69d8a-4a57-40c1-b9c1-efddb404b0b1"), issues.join(" / "));
  assert.ok(!has(issues, CAUSAL), "the supported sentence is no longer part of the rejection");
  const causalMistyped = richClose1001(input);
  causalMistyped.claims[3] = { ...causalMistyped.claims[3], claim_type: "causal", evidence_refs: ["news:47b69d8a-4a57-40c1-b9c1-efddb404b0b1"] };
  assert.ok(has(hard(causalMistyped), "入力に無い ref") && has(hard(causalMistyped), "ニュースの根拠が無い causal: c4"));
  const unknownKeyNews = richClose1001(input);
  unknownKeyNews.key_news[0].ref = "news:00000000-0000-4000-8000-000000000000";
  assert.ok(has(hard(unknownKeyNews), "入力に無いニュース"));
});

test("8: the 10/1 mixed-session wording stays blocked", () => {
  const payload: MarketDataPacket = structuredClone(morning1001.data.payload);
  Object.assign(payload.metrics.find((metric) => metric.key === "nikkei225")!, {
    session_date: "2026-09-29", value: 65481.2695, previous_close: 65877.6172, change: -396.3477, change_pct: -0.6, freshness: "stale",
  });
  const mixed = inputOf(morning1001, { payload });
  const analysis = richMorning1001(mixed);
  analysis.headline_ja = "前夜の米国株はまちまち";
  analysis.claims = analysis.claims.filter((claim) => !["c1", "c5", "c6"].includes(claim.claim_id));
  analysis.x_post.lead_ja = "前夜の米国株はまちまちでした📊";
  analysis.x_post.points_ja[0] = "9月30日のTOPIX連動ETF（1306）は431.5円（前日比+1.43%）";
  analysis.app_story!.summary_ja = "前夜の米国市場は指数によって方向が分かれました。";
  analysis.app_story!.japan_ja = "9月30日のTOPIX連動ETF（1306）は431.5円（前日比+1.43%）でした。";
  analysis.market_summary_ja = "9月30日は日経平均65,481.27（-0.60%）、1306は431.5（+1.43%）でした。";
  assert.ok(has(hard(analysis, mixed), "日付と指標の不一致（日経平均は9月29日の値、本文は9月30日）"), hard(analysis, mixed).join(" / "));
});

test("9+10: a stale value written as current, and 1306 written as TOPIX, stay blocked", () => {
  const stale = richClose1001(input);
  stale.app_story!.cross_asset_ja = "日本国債10年利回りは2.943%です。";
  assert.ok(has(hard(stale), "古い値を日付なしで記載（日本国債10年利回りは8月31日時点）"), hard(stale).join(" / "));
  const current = richClose1001(input);
  current.app_story!.cross_asset_ja = "現在の日本国債10年利回りは8月31日時点で2.943%です。";
  assert.ok(hard(current).length > 0, "a stale value called current is rejected");
  const topix = richClose1001(input);
  topix.x_post.lead_ja = "10月1日は日経平均もTOPIXも上昇しました📈";
  assert.ok(has(hard(topix), "TOPIX連動ETF（1306）をTOPIXと表記"));
});

// ---------------------------------------------------------------------------------------------
// Delivery: the natural 10/1 close replayed
// ---------------------------------------------------------------------------------------------

test("replay 16:35: the draft that was rejected twice now reaches Fact and is delivered in one generation", async () => {
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: richClose1001(input) },
    { step: "fact", payload: { passed: true, issues: [] } },
  ], calls), NOW);
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, ["generate", "fact"]);
  assert.deepEqual([outcome.trace.generations, outcome.trace.hardRejections, outcome.trace.deliveredGeneration], [1, [], 1]);
  assert.ok(outcome.ok && outcome.packet.x_post.news_ja!.includes(FAILED_SENTENCE));
});

test("replay 16:20: the mistyped ref is regenerated once, within the unchanged call budget", async () => {
  assert.equal(MAX_GENERATIONS, 2);
  const mistyped = richClose1001(input);
  mistyped.claims[3].evidence_refs = ["news:47b69d8a-4a57-40c1-b9c1-efddb404b0b1"];
  const calls: string[] = [];
  const recovered = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: mistyped },
    { step: "generate", payload: richClose1001(input) },
    { step: "fact", payload: { passed: true, issues: [] } },
  ], calls), NOW);
  assert.equal(recovered.ok, true);
  assert.deepEqual(calls, ["generate", "generate", "fact"]);
  assert.deepEqual([recovered.trace.hardRejections, recovered.trace.deliveredGeneration], [["local"], 2]);
  // A ref that stays wrong is never repaired by fuzzy matching and never costs a third generation: the claim that
  // carries it is removed and the rest is delivered (2026-10-07, delivery first).
  const twice: string[] = [];
  const degraded = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: mistyped }, { step: "generate", payload: mistyped },
    { step: "fact", payload: { passed: true, issues: [] } },
  ], twice), NOW);
  assert.deepEqual(twice, ["generate", "generate", "fact"]);
  assert.ok(degraded.ok);
  assert.ok(degraded.ok && !degraded.packet.claims.some((claim) => claim.evidence_refs.includes("news:47b69d8a-4a57-40c1-b9c1-efddb404b0b1")));
  assert.ok(degraded.ok && degraded.packet.fact.removed_units?.includes(`UNIT_REMOVED:UNKNOWN_REF@claims[${mistyped.claims[3].claim_id}]`));
  // Market causality without evidence never reaches the packet: the sentence is removed, the rest delivered.
  const market = withNews("AI向け半導体需要を背景に東京市場も上昇しました");
  const blocked = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: market }, { step: "generate", payload: market },
    { step: "fact", payload: { passed: true, issues: [] } },
  ]), NOW);
  assert.ok(has(blocked.trace.records[0].localIssues, CAUSAL));
  assert.ok(blocked.ok);
  const delivered = blocked.ok ? `${formatSharedXPost(blocked.packet)}\n${blocked.packet.app_story?.news_ja}` : "";
  assert.ok(!delivered.includes("背景に東京市場も上昇"), delivered);
  assert.ok(delivered.includes("トランプ大統領がAI企業と安全対策の自主協定"), "the safe sentence of the same paragraph stays");
});

test("product check: the 10/1 close renders a readable X digest and app story with the news sentence in both", () => {
  const analysis = richClose1001(input);
  const packet = assemblePacket(input, analysis, { generatedAt: NOW(), attempts: 1, warnings: [] });
  const post = formatSharedXPost(packet);
  const story = buildAppMarketStory(packet);
  const length = Array.from(post).length;
  assert.ok(length >= 430 && length <= 560, `X ${length}`);
  assert.ok(story.char_count >= 900 && story.char_count <= 1500, `app narrative ${story.char_count}`);
  assert.ok(post.includes(`📰 韓国の9月輸出は過去最高で、${FAILED_SENTENCE}。`));
  assert.ok(appStoryText(story).includes(FAILED_SENTENCE));
  assert.ok(post.includes("東京市場の上昇理由は、確認できる材料だけでは断定できません。"));
  assert.deepEqual(packet.key_news.map((news) => news.scope), ["broad", "broad", "sector", "company"]);
});

test("the prompt lets a news item's own cause be restated and keeps it apart from the market's reason", async () => {
  const { generationRequestBody } = await import("./analysis_logic.ts");
  const instructions = String(generationRequestBody(input, []).instructions);
  assert.ok(instructions.includes("そのニュース本文に書かれている原因と結果を、本文の言い方に沿ってそのまま書いてかまいません"));
  assert.ok(instructions.includes("本文に因果の表現が無いニュースには「〜を受けて」「〜を背景に」を足しません"));
  assert.ok(instructions.includes("ニュースの中の原因を、東京市場・米国市場・指数の値動きの理由にはしません"));
  // The market-level rule is unchanged.
  assert.ok(instructions.includes("値動きの理由として書けるのは、入力のニュースが理由として明記しているもの（causal の claim）だけです"));
});

test("a news item that states its cause in other words is still a supported restatement", () => {
  // Synthetic item: the source ties cause and effect with 「〜を理由に」.
  const row = {
    ...close1001.news[0],
    id: "0f0f0f0f-0000-4000-8000-000000001001",
    company_code: null, company_name: null, coverage_severity: "high", coverage_categories: ["regulation_policy"],
    title: "Country A bans imports", app_title_ja: "A国、B国産品の輸入を禁止",
    app_summary_ja: "A国は、B国の追加関税を理由に、B国産の一部製品の輸入を禁止しました。",
    app_copy_fact_status: "passed", generated_text: null, generation_fact_status: null,
  };
  const payload: MarketDataPacket = structuredClone(close1001.data.payload);
  payload.news_refs.items.push({ ...payload.news_refs.items[0], ref_id: row.id });
  const built = inputOf(close1001, { payload, news: [...close1001.news, row] });
  assert.ok(built.news.some((item) => item.ref === `news:${row.id}`));
  const analysis = richClose1001(built);
  analysis.x_post.news_ja = "A国は、B国の追加関税を受けてB国産品の輸入を禁止したと報じられました。";
  assert.deepEqual(localAnalysisCheck(analysis, built).hard, []);
  // The same cause turned into the market's reason is not supported by it.
  analysis.x_post.news_ja = "B国の追加関税を受けて東京市場は上昇しました。";
  assert.ok(has(localAnalysisCheck(analysis, built).hard, CAUSAL));
});

// Sentence shapes taken from real production news text (public news; the items are added to the 10/1 input).
function inputWithNews(summaries: string[]) {
  const rows = summaries.map((summary, index) => ({
    ...close1001.news[0],
    id: `0f0f0f0f-0000-4000-8000-0000000020${String(index).padStart(2, "0")}`,
    company_code: null, company_name: null, coverage_severity: "high", coverage_categories: ["us_market"],
    title: `Real-shape item ${index}`, app_title_ja: summary.split("。")[0], app_summary_ja: summary,
    app_copy_fact_status: "passed", generated_text: null, generation_fact_status: null,
  }));
  const payload: MarketDataPacket = structuredClone(close1001.data.payload);
  for (const row of rows) payload.news_refs.items.unshift({ ...payload.news_refs.items[0], ref_id: row.id });
  const built = inputOf(close1001, { payload, news: [...rows, ...close1001.news] });
  return { built, refs: rows.map((row) => `news:${row.id}`) };
}

test("real news shapes: verbatim restatements pass without a causal claim", () => {
  const sentences = [
    "前日の米国株上昇と原油価格の低下を受け、アジア株はおおむね上昇しました",
    "化学品事業が好調で、中東情勢への不安を背景に取引先が在庫を積み増したことなどから、受注数量が想定を上回ったとのこと",
    "ビジネスマッチング事業の売上減や、新規導入の進捗遅れなどが響きました",
    "今後の業績はさまざまな要因で予想と異なる見通しです",
  ];
  const { built } = inputWithNews(sentences.map((sentence) => `${sentence}。`));
  for (const sentence of sentences) {
    assert.ok(built.news.some((item) => (item.summary_ja ?? "").includes(sentence)), `in input: ${sentence}`);
    const analysis = richClose1001(built);
    analysis.app_story!.news_ja = `${sentence}。`;
    assert.deepEqual(localAnalysisCheck(analysis, built).hard, [], sentence);
  }
  // The same items do not support a changed direction, a dropped-in second cause, or the Tokyo market.
  for (const sentence of [
    "前日の米国株下落と原油価格の低下を受け、アジア株はおおむね上昇しました",
    "前日の米国株上昇と原油価格の低下を受け、アジア株はおおむね下落しました",
    "前日の米国株上昇と円安を受け、アジア株はおおむね上昇しました",
    "前日の米国株上昇と原油価格の低下を受け、東京市場も上昇しました",
    "中東情勢への不安を背景に東京市場は上昇しました",
  ]) {
    const analysis = richClose1001(built);
    analysis.app_story!.news_ja = `${sentence}。`;
    assert.ok(has(localAnalysisCheck(analysis, built).hard, CAUSAL), `accepted: ${sentence}`);
  }
});

test("a named non-market subject's price move is its own news; a market metric's move still needs a causal claim", () => {
  const company = "A社の株価は、通期予想の上方修正を受けて急騰しました";
  const brent = "ブレント原油は、中東情勢の緊迫を受けて上昇しました";
  const { built, refs } = inputWithNews([`${company}。`, `${brent}。`]);
  const stock = richClose1001(built);
  stock.app_story!.news_ja = `${company}。`;
  assert.deepEqual(localAnalysisCheck(stock, built).hard, [], "company news restated");
  // Brent is a market metric of the packet: giving its move a reason is market-level causality.
  const oil = richClose1001(built);
  oil.app_story!.news_ja = `${brent}。`;
  assert.ok(has(localAnalysisCheck(oil, built).hard, CAUSAL), "observation only: rejected");
  oil.claims.push({ claim_id: "c7", text_ja: "ブレント原油の上昇は中東情勢の緊迫が理由と報じられました。", claim_type: "causal", evidence_refs: [refs[1]], scope: "today" });
  assert.deepEqual(localAnalysisCheck(oil, built).hard, [], "with a causal claim citing the news that states it");
});
