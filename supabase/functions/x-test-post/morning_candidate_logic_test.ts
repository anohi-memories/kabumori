import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MORNING_SEARCH_CALLS,
  buildMorningSupplementContext,
  capCandidatePool,
  evaluateMorningSearchBudget,
  inspectMorningWebSearchCalls,
  isUsMarketOrSemiconductorCandidate,
  morningCandidateExtractionInstructions,
  selectMorningCandidates,
  supplementReasons,
  type CheckedMorningCandidate,
} from "./morning_candidate_logic.ts";

const domains = ["reuters.com", "apnews.com", "boj.or.jp", "jpx.co.jp"];
const candidate = (overrides: Partial<CheckedMorningCandidate> = {}): CheckedMorningCandidate => ({
  title: "米国半導体株が上昇",
  summary: "前営業日の米国市場で半導体株が上昇した。",
  publisher: "Reuters",
  source_url: "https://www.reuters.com/markets/example",
  supporting_source_urls: [],
  timestamp: "2026-08-28",
  timestamp_precision: "date",
  material_type: "market_session",
  japan_relevance: "日本の半導体株の確認材料。",
  japan_relevance_level: "high",
  market_impact: "high",
  importance_class: "major",
  causal_claim_strength: "none",
  affected_sectors: ["半導体"],
  what_to_watch: "寄り後の半導体株。",
  lane: "lane_a_us_market",
  source_verified: true,
  freshness: "usable",
  causal_support_passed: true,
  content_allowed: true,
  publisher_key: "reuters.com",
  ...overrides,
});

test("ranking is deterministic and does not depend on Luna order", () => {
  const strong = candidate({ title: "FOMCが政策変更", source_url: "https://www.reuters.com/a" });
  const standard = candidate({
    title: "通常の企業材料", source_url: "https://apnews.com/b", publisher_key: "apnews.com",
    market_impact: "medium", japan_relevance_level: "medium", importance_class: "standard", material_type: "corporate",
  });
  const first = selectMorningCandidates([standard, strong], domains).selected.map((item) => item.title);
  const second = selectMorningCandidates([strong, standard], domains).selected.map((item) => item.title);
  assert.deepEqual(first, second);
  assert.equal(first[0], "FOMCが政策変更");
});

test("a publication schedule does not outrank major material", () => {
  const schedule = candidate({
    title: "日銀の公表予定表", summary: "本日の公表スケジュール。", publisher: "日本銀行",
    source_url: "https://www.boj.or.jp/calendar", publisher_key: "boj.or.jp", lane: "lane_c_supplement",
    importance_class: "administrative", market_impact: "low", japan_relevance_level: "medium",
    material_type: "economic_indicator",
  });
  const result = selectMorningCandidates([schedule, candidate()], domains);
  assert.equal(result.selected.some((item) => item.title === schedule.title), false);
  assert.match(result.decisions.find((item) => item.candidate.title === schedule.title)?.reasons.join(" ") ?? "", /ADMINISTRATIVE|SCHEDULE/);
});

test("a minor statistical correction is kept out of the top three", () => {
  const correction = candidate({
    title: "コミットメントライン統計を訂正", summary: "軽微な数値の訂正。", publisher: "日本銀行",
    source_url: "https://www.boj.or.jp/correction", publisher_key: "boj.or.jp", lane: "lane_c_supplement",
    importance_class: "standard", market_impact: "medium", japan_relevance_level: "medium",
    material_type: "economic_indicator",
  });
  const result = selectMorningCandidates([correction, candidate()], domains);
  assert.equal(result.selected.some((item) => item.title === correction.title), false);
  assert.match(result.decisions.find((item) => item.candidate.title === correction.title)?.reasons.join(" ") ?? "", /MINOR_CORRECTION/);
});

test("duplicate URL or title candidates are suppressed", () => {
  const one = candidate();
  const duplicate = candidate({ publisher: "別表記" });
  const result = selectMorningCandidates([one, duplicate], domains);
  assert.equal(result.qualifiedCount, 1);
  assert.equal(result.decisions.some((item) => item.reasons.includes("DUPLICATE_CANDIDATE")), true);
});

test("one publisher triggers supplement while two publishers can pass diversity", () => {
  const onePublisher = selectMorningCandidates([
    candidate({ source_url: "https://www.reuters.com/a" }),
    candidate({ title: "米国AI株の動き", source_url: "https://www.reuters.com/b" }),
    candidate({ title: "米国ハイテク株の動き", source_url: "https://www.reuters.com/c" }),
  ], domains);
  assert.equal(onePublisher.publisherCount, 1);
  assert.deepEqual(supplementReasons(onePublisher, 2)[0], "PUBLISHER_SHORTAGE");

  const twoPublishers = selectMorningCandidates([
    candidate({ source_url: "https://www.reuters.com/a" }),
    candidate({ title: "FRB政策", source_url: "https://apnews.com/b", publisher_key: "apnews.com", lane: "lane_b_macro_policy", material_type: "central_bank_policy" }),
    candidate({ title: "米国ハイテク株", source_url: "https://www.reuters.com/c" }),
  ], domains);
  assert.equal(twoPublishers.publisherCount, 2);
});

test("missing US market material or fewer than three qualified candidates requests supplement", () => {
  const macroOnly = selectMorningCandidates([
    candidate({ title: "Fed政策", lane: "lane_b_macro_policy", material_type: "central_bank_policy" }),
    candidate({ title: "経済指標", lane: "lane_b_macro_policy", material_type: "economic_indicator", source_url: "https://apnews.com/b", publisher_key: "apnews.com" }),
  ], domains);
  const reasons = supplementReasons(macroOnly, 2);
  assert.equal(reasons.includes("US_MARKET_OR_SEMICONDUCTOR_SHORTAGE"), true);
  assert.equal(reasons.includes("QUALIFIED_CANDIDATE_SHORTAGE"), true);
});

test("a Fed speech mentioning AI is not a US market or semiconductor candidate", () => {
  const speech = candidate({
    title: "Fed Chair discusses AI and the economic outlook",
    summary: "The central-bank speech mentioned AI while explaining monetary-policy principles.",
    material_type: "central_bank_policy",
    lane: "lane_a_us_market",
  });
  assert.equal(isUsMarketOrSemiconductorCandidate(speech), false);
});

test("central bank policy remains false even with technology and semiconductor keywords", () => {
  const policy = candidate({
    title: "Central bank policy speech on technology",
    summary: "The speech also mentioned AI and the semiconductor industry.",
    material_type: "central_bank_policy",
  });
  assert.equal(isUsMarketOrSemiconductorCandidate(policy), false);
});

test("Nvidia earnings are a substantive semiconductor candidate", () => {
  const earnings = candidate({
    title: "Nvidia reports quarterly earnings and guidance",
    summary: "Revenue and guidance were released with the results.",
    material_type: "corporate",
  });
  assert.equal(isUsMarketOrSemiconductorCandidate(earnings), true);
});

test("semiconductor sector and Nasdaq session reports are substantive market candidates", () => {
  const sector = candidate({
    title: "Semiconductor sector gains after chipmakers report results",
    material_type: "other",
  });
  const session = candidate({
    title: "Nasdaq market closes higher as technology stocks rally",
    material_type: "other",
  });
  assert.equal(isUsMarketOrSemiconductorCandidate(sector), true);
  assert.equal(isUsMarketOrSemiconductorCandidate(session), true);
});

test("actual high-tech stock movement is a substantive market candidate", () => {
  const techStocks = candidate({
    title: "Tech stocks rallied in the latest U.S. session",
    material_type: "other",
  });
  assert.equal(isUsMarketOrSemiconductorCandidate(techStocks), true);
});

test("qualified macro candidates still trigger US market shortage with highest priority", () => {
  const macroOnly = selectMorningCandidates([
    candidate({
      title: "Fed Chair discusses AI",
      summary: "A monetary-policy speech that mentions artificial intelligence.",
      material_type: "central_bank_policy",
      lane: "lane_b_macro_policy",
    }),
  ], domains);
  const reasons = supplementReasons(macroOnly, 2);
  assert.equal(macroOnly.hasUsMarketOrSemiconductor, false);
  assert.equal(reasons[0], "US_MARKET_OR_SEMICONDUCTOR_SHORTAGE");
});

test("Lane C prioritizes US market supplementation when that shortage exists", () => {
  const instructions = morningCandidateExtractionInstructions("lane_c_supplement", [
    "US_MARKET_OR_SEMICONDUCTOR_SHORTAGE",
    "PUBLISHER_SHORTAGE",
    "QUALIFIED_CANDIDATE_SHORTAGE",
  ]).join("\n");
  assert.match(instructions, /米国市場・半導体・AI\/ハイテク株の実材料不足を最優先/);
});

test("search budget never exceeds three and unresolved shortage remains visible", () => {
  const insufficient = selectMorningCandidates([candidate()], domains);
  assert.equal(MAX_MORNING_SEARCH_CALLS, 3);
  assert.deepEqual(supplementReasons(insufficient, 3), []);
  assert.equal(insufficient.selected.length < 3 || insufficient.publisherCount < 2, true);
});

test("candidate pool is capped at eight", () => {
  assert.equal(capCandidatePool(Array.from({ length: 12 }, (_, index) => index)).length, 8);
});

test("candidate extraction asks every lane to return broad verifiable candidates", () => {
  for (const lane of ["lane_a_us_market", "lane_b_macro_policy", "lane_c_supplement"] as const) {
    const instructions = morningCandidateExtractionInstructions(lane, ["PUBLISHER_SHORTAGE"]).join("\n");
    assert.match(instructions, /最終採否は決めません/);
    assert.match(instructions, /上限まで広め/);
    assert.match(instructions, /administrative/);
    assert.match(instructions, /空配列.*本当に存在しない場合だけ/);
  }
});

test("Lane A and B preserve their candidate limits in extraction guidance", () => {
  assert.match(morningCandidateExtractionInstructions("lane_a_us_market").join("\n"), /最大3件/);
  assert.match(morningCandidateExtractionInstructions("lane_b_macro_policy").join("\n"), /最大3件/);
});

test("weak and administrative candidates can reach deterministic downstream rejection", () => {
  const weak = candidate({
    title: "日銀の公表予定表",
    summary: "事務的な公表スケジュール。",
    importance_class: "administrative",
    market_impact: "low",
    japan_relevance_level: "low",
  });
  const result = selectMorningCandidates([weak], domains);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.selected.length, 0);
  assert.match(result.decisions[0].reasons.join(" "), /ADMINISTRATIVE|SCHEDULE|RELEVANCE/);
});

test("Lane C receives compact publisher and category shortage context", () => {
  const selection = selectMorningCandidates([
    candidate({ source_url: "https://www.reuters.com/a" }),
    candidate({
      title: "FRB政策",
      source_url: "https://www.reuters.com/b",
      lane: "lane_b_macro_policy",
      material_type: "central_bank_policy",
    }),
  ], domains);
  const reasons = supplementReasons(selection, 2);
  const context = buildMorningSupplementContext(selection, reasons);
  assert.equal(context.qualifiedCandidateCount, 2);
  assert.deepEqual(context.publishers, ["reuters.com"]);
  assert.deepEqual(context.categories, ["central_bank_policy", "market_session"]);
  assert.equal(context.hasUsMarketOrSemiconductor, true);
  assert.equal(context.reasons.includes("PUBLISHER_SHORTAGE"), true);
  assert.equal(context.missingPriorityCategories.includes("corporate"), true);
  assert.match(
    morningCandidateExtractionInstructions("lane_c_supplement", reasons).join("\n"),
    /既存publisherと異なる/,
  );
});

test("multiple web search call items pass when only one is a search query", () => {
  const diagnostics = inspectMorningWebSearchCalls({ output: [
    { type: "web_search_call", action: { type: "search", query: "US stocks" } },
    { type: "web_search_call", action: { type: "open_page", url: "https://www.reuters.com/a" } },
    { type: "web_search_call", action: { type: "find_in_page", pattern: "semiconductor" } },
  ] }, "lane_a_us_market");
  assert.equal(diagnostics.webSearchCallItemCount, 3);
  assert.deepEqual(diagnostics.actionTypes, ["search", "open_page", "find_in_page"]);
  assert.equal(diagnostics.searchQueryCount, 1);
  assert.equal(evaluateMorningSearchBudget([diagnostics]).passed, true);
});

test("page operations are not counted as search queries", () => {
  const diagnostics = inspectMorningWebSearchCalls({ output: [
    { type: "web_search_call", action: { type: "open_page" } },
    { type: "web_search_call", action: { type: "find_in_page" } },
  ] }, "lane_b_macro_policy");
  assert.equal(diagnostics.searchQueryCount, 0);
});

test("two search queries in one lane fail safely", () => {
  const budget = evaluateMorningSearchBudget([{
    lane: "lane_a_us_market",
    webSearchCallItemCount: 2,
    actionTypes: ["search", "search"],
    searchQueryCount: 2,
  }]);
  assert.equal(budget.passed, false);
  assert.equal(budget.reasons.includes("LANE_SEARCH_QUERY_LIMIT_EXCEEDED:lane_a_us_market"), true);
});

test("Lane A, B and C with one search each stay within budget", () => {
  const budget = evaluateMorningSearchBudget([
    { lane: "lane_a_us_market", webSearchCallItemCount: 1, actionTypes: ["search"], searchQueryCount: 1 },
    { lane: "lane_b_macro_policy", webSearchCallItemCount: 1, actionTypes: ["search"], searchQueryCount: 1 },
    { lane: "lane_c_supplement", webSearchCallItemCount: 1, actionTypes: ["search"], searchQueryCount: 1 },
  ]);
  assert.equal(budget.passed, true);
  assert.equal(budget.laneApiCallCount, 3);
  assert.equal(budget.totalSearchQueryCount, 3);
});

test("a fourth lane call is rejected", () => {
  const budget = evaluateMorningSearchBudget([
    { lane: "lane_a_us_market", webSearchCallItemCount: 1, actionTypes: ["search"], searchQueryCount: 1 },
    { lane: "lane_b_macro_policy", webSearchCallItemCount: 1, actionTypes: ["search"], searchQueryCount: 1 },
    { lane: "lane_c_supplement", webSearchCallItemCount: 1, actionTypes: ["search"], searchQueryCount: 1 },
    { lane: "lane_c_supplement", webSearchCallItemCount: 0, actionTypes: [], searchQueryCount: 0 },
  ]);
  assert.equal(budget.passed, false);
  assert.equal(budget.reasons.includes("LANE_API_CALL_LIMIT_EXCEEDED"), true);
});

test("more than three total search queries fail safely", () => {
  const budget = evaluateMorningSearchBudget([
    { lane: "lane_a_us_market", webSearchCallItemCount: 2, actionTypes: ["search", "search"], searchQueryCount: 2 },
    { lane: "lane_b_macro_policy", webSearchCallItemCount: 1, actionTypes: ["search"], searchQueryCount: 1 },
    { lane: "lane_c_supplement", webSearchCallItemCount: 1, actionTypes: ["search"], searchQueryCount: 1 },
  ]);
  assert.equal(budget.passed, false);
  assert.equal(budget.totalSearchQueryCount, 4);
  assert.equal(budget.reasons.includes("TOTAL_SEARCH_QUERY_LIMIT_EXCEEDED"), true);
});
