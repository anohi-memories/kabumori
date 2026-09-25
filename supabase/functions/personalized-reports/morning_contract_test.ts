// Morning prompt ↔ Fact checker contract (production v28 morning dry-runs failed Fact 2/2):
//   A. the prompt asked for 「寄り付き」「場中」 watch points the packet cannot support;
//   B. 「個別ニュースは確認されていません」 was read as a claim that no news exists.
// The fix changes what the model is asked to write; the Fact checker only gains a precise permission
// for describing the packet's own empty news input.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BENCHMARK_LABEL,
  buildPacket,
  buildSnapshot,
  EMPTY_NEWS_FACT_RULE,
  EMPTY_NEWS_RULE,
  MORNING_TIMING_RULE,
  REPORT_FACT_INSTRUCTIONS,
  REPORT_LIMITS,
  reportDraftRequestBody,
  reportFactRequestBody,
  type NewsInput,
  type PriceSeries,
  type ReportBody,
} from "./report_logic.ts";

function series(closes: Array<[string, number]>): PriceSeries {
  return { bars: closes.map(([date, close]) => ({ date, close })), marketTimeIso: "2026-09-25T06:30:00Z" };
}

const FLAT = series([["2026-09-24", 1000], ["2026-09-25", 1000], ["2026-09-28", 1000]]);

function instructions(reportType: "morning" | "close"): string {
  const snapshot = buildSnapshot({
    reportType,
    tradingDate: "2026-09-28",
    tracked: [{
      trackedStockId: "t1", tickerCode: "1111", companyName: "会社1111", sector: "サービス業",
      trackingType: "holding", quantity: 100, averagePrice: 900, positionType: "cash", side: "long",
    }],
    prices: new Map([["1111", FLAT]]),
    indices: [{ label: "日経平均", series: FLAT }, { label: BENCHMARK_LABEL, series: FLAT }],
    news: [],
  });
  return String(reportDraftRequestBody(reportType, buildPacket(snapshot, [])).instructions);
}

// --- A. timing wording -----------------------------------------------------------------------

test("A: the morning prompt no longer asks for 寄り付き / 場中 observations", () => {
  const morning = instructions("morning");
  assert.ok(!morning.includes("寄り付きや場中で見るべき点"), "the old contradictory instruction is gone");
  // 寄り付き / 場中 may appear only inside the rule that forbids treating them as observed facts.
  const outsideRule = morning.split(MORNING_TIMING_RULE).join("").split(EMPTY_NEWS_RULE).join("");
  assert.ok(!/寄り付き|場中/.test(outsideRule), "no other instruction requests intraday timing");
  assert.ok(morning.includes(MORNING_TIMING_RULE));
  for (const phrase of ["「寄り付き後」「場中」「今日の値動きで〜」", "観測済みの事実のように書きません", "前営業日の終値や入力された材料に照らして確認する点"]) {
    assert.ok(MORNING_TIMING_RULE.includes(phrase), phrase);
  }
});

test("A: the morning prompt still asks for watch points and checkpoints, grounded in the input", () => {
  const morning = instructions("morning");
  assert.ok(morning.includes("watch_ja には、前営業日の終値や入力された材料に照らして確認する点（確認ポイント・注目点）を書きます。"));
  assert.ok(morning.includes("checkpoints_ja は今日確認するとよい点を1〜4個、短く書きます。"));
  assert.ok(!instructions("close").includes(MORNING_TIMING_RULE), "the timing rule is morning-only");
});

// --- B. empty-news wording --------------------------------------------------------------------

test("B: both prompts describe empty news as an input state, never as a world state", () => {
  for (const reportType of ["morning", "close"] as const) {
    assert.ok(instructions(reportType).includes(EMPTY_NEWS_RULE), reportType);
  }
  for (const allowed of ["「入力に個別の材料は含まれていません」", "「このレポートの入力には個別ニュースがありません」"]) {
    assert.ok(EMPTY_NEWS_RULE.includes(allowed), allowed);
  }
  for (const avoided of ["「個別ニュースは確認されていません」", "「ニュースはありません」", "「材料はありません」"]) {
    assert.ok(EMPTY_NEWS_RULE.includes(avoided), avoided);
  }
  // The no-material fact_ja template now states the input, not the world.
  const prompt = instructions("close");
  assert.ok(prompt.includes("すべて空の場合に限り、fact_ja に「入力に明確な個別材料は含まれていません」と書くこともできます。"));
  assert.ok(!prompt.includes("書ける事実がなければ空文字にします。"), "fact_ja is never asked to be empty");
  assert.ok(prompt.includes("fact_ja は空にしません。"));
  assert.ok(!prompt.includes("no_clear_material にし、fact_ja に「入力に明確な個別材料は含まれていません」と書きます。"));
  assert.ok(!prompt.includes("fact_ja に「明確な個別材料は確認できていません」と書きます。"));
});

// --- C. Fact checker: one precise permission, nothing relaxed ---------------------------------

test("C: the Fact checker allows only the precise empty-input meta-claim", () => {
  assert.ok(REPORT_FACT_INSTRUCTIONS.includes(EMPTY_NEWS_FACT_RULE));
  assert.ok(EMPTY_NEWS_FACT_RULE.includes("空のとき"), "only when the packet's news is empty");
  assert.ok(EMPTY_NEWS_FACT_RULE.includes("「入力に個別の材料は含まれていません」"));
  assert.ok(EMPTY_NEWS_FACT_RULE.includes("1件でもあるのに空入力を断定した場合は passed を false"));
  // Broad no-news claims and unsupported intraday claims remain failures.
  for (const stillRejected of ["「ニュースはありません」", "「材料はありません」", "「個別ニュースは確認されていません」", "寄り付き・場中の値動きを観測済みの事実として書く", "passed を false にします"]) {
    assert.ok(EMPTY_NEWS_FACT_RULE.includes(stillRejected), stillRejected);
  }
});

test("B/C: mixed per-stock news cannot trigger an unconditional empty-input fact_ja", () => {
  const tracked = ["1111", "2222"].map((tickerCode) => ({
    trackedStockId: `t${tickerCode}`, tickerCode, companyName: `会社${tickerCode}`, sector: "サービス業",
    trackingType: "holding" as const, quantity: 100, averagePrice: 900,
    positionType: "cash" as const, side: "long" as const,
  }));
  const news: NewsInput[] = [{
    newsId: "n1", tickerCode: "1111", companyName: "会社1111", trackingType: "holding",
    severity: "medium", matchedSectors: [], newsTime: "2026-09-25T06:00:00Z",
    sourceUrl: null, sourceType: null, textOrigin: "verified_post", headlineJa: "会社1111が資料を公表",
    summaryJa: null, keyPointsJa: [],
  }];
  const snapshot = buildSnapshot({
    reportType: "morning", tradingDate: "2026-09-28", tracked,
    prices: new Map([["1111", FLAT], ["2222", FLAT]]),
    indices: [{ label: "日経平均", series: FLAT }, { label: BENCHMARK_LABEL, series: FLAT }], news,
  });
  const packet = buildPacket(snapshot, news);
  assert.equal(packet.holdings[0].own_news.length, 1);
  assert.equal(packet.holdings[1].own_news.length, 0);

  const draftInstructions = String(reportDraftRequestBody("morning", packet).instructions);
  assert.ok(draftInstructions.includes("すべて空の場合に限り、fact_ja に「入力に明確な個別材料は含まれていません」と書くこともできます。"));
  const report = {
    title_ja: "朝刊", summary_ja: "概要", tone: "neutral", overview_ja: "概要", holding_impacts: [],
    morning_review_ja: "", watch_notes: [], risk_notes_ja: [], checkpoints_ja: ["確認点"],
  } satisfies ReportBody;
  const factRequest = reportFactRequestBody(packet, report);
  assert.equal(factRequest.instructions, REPORT_FACT_INSTRUCTIONS);
  assert.ok(String(factRequest.input).includes("会社1111が資料を公表"));
  assert.ok(String(factRequest.instructions).includes("1件でもあるのに空入力を断定した場合は passed を false"));
});

test("C: adversarial absence, intraday and causal text reaches the Fact gate verbatim", () => {
  const emptyPacket = { holdings: [], watch: [], market_news: [] };
  const nonemptyPacket = { holdings: [{ own_news: [{ headline: "資料を公表" }], related_market_news: [] }], watch: [], market_news: [] };
  for (const [packet, text] of [
    [nonemptyPacket, "入力に個別の材料は含まれていません。"],
    [emptyPacket, "ニュースはありません。"],
    [emptyPacket, "個別ニュースは確認されていません。"],
    [emptyPacket, "寄り付き後に上昇しています。"],
    [emptyPacket, "場中は強含みです。"],
    [emptyPacket, "今日の値動きでは買い場です。"],
    [emptyPacket, "入力に個別の材料は含まれていません。円高が上昇の原因です。"],
    [emptyPacket, "入力に個別の材料は含まれていません\n円高が上昇の原因です。"],
  ] as const) {
    const report = {
      title_ja: "朝刊", summary_ja: "概要", tone: "neutral", overview_ja: text,
      holding_impacts: [], morning_review_ja: "", watch_notes: [], risk_notes_ja: [], checkpoints_ja: ["確認点"],
    } satisfies ReportBody;
    const request = reportFactRequestBody(packet, report);
    const sent = JSON.parse(String(request.input)) as { report: ReportBody };
    assert.equal(sent.report.overview_ja, text);
    assert.ok(String(request.instructions).includes(EMPTY_NEWS_FACT_RULE));
  }
  // These are instructions to the real Fact model, not a deterministic semantic classification test.
  assert.ok(EMPTY_NEWS_FACT_RULE.includes("1件でもあるのに空入力を断定した場合は passed を false"));
  assert.ok(REPORT_FACT_INSTRUCTIONS.includes("将来の値動きの断定、売買推奨"));
  assert.ok(REPORT_FACT_INSTRUCTIONS.includes("ニュースと値動きの因果の断定"));
});

test("C: the existing Fact rejections are all still present", () => {
  for (const rule of [
    "packetに無い数字・日付・固有名詞・事実",
    "ニュースと値動きの因果の断定",
    "将来の値動きの断定",
    "売買推奨",
    "価格未取得・未登録の項目を推測で埋めた記述",
    "shared_market と矛盾する市場の方向や理由",
    "fact_ja に推定や因果の断定が混ざっていたら passed を false にします",
  ]) {
    assert.ok(REPORT_FACT_INSTRUCTIONS.includes(rule), rule);
  }
});

test("brief limits stay morning 120 / close 160", () => {
  assert.equal(REPORT_LIMITS.impactBriefMorning, 120);
  assert.equal(REPORT_LIMITS.impactBriefClose, 160);
});
