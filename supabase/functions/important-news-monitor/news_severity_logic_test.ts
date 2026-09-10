import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveNewsSeverity,
  detectCorporateIrSubtype,
  NEWS_CATEGORY_TAXONOMY,
  newsScopeFor,
  proposedDeliveryPolicy,
  type NewsSeverityInput,
} from "./news_severity_logic.ts";
import { IMPORTANT_NEWS_CATEGORIES } from "./news_candidate_logic.ts";
import { checkPublishCandidate, type PublishCandidate } from "./publish_logic.ts";

const sourceUrl = "https://www.release.tdnet.info/inbs/example.pdf";

function input(overrides: Partial<NewsSeverityInput> = {}): NewsSeverityInput {
  return {
    importance: "no_post",
    category: "other_corporate_ir",
    title: "当社株式の貸借銘柄選定に関するお知らせ",
    sourceType: "tdnet",
    sourceUrl,
    publishedAt: "2026-09-10T06:30:00Z",
    companyCode: "79740",
    japanMarketRelevance: "low",
    factCheckStatus: "passed",
    ...overrides,
  };
}

// --- taxonomy -----------------------------------------------------------------

test("every existing category has a scope and a transmission path", () => {
  for (const category of IMPORTANT_NEWS_CATEGORIES) {
    const entry = NEWS_CATEGORY_TAXONOMY[category];
    assert.ok(entry, `missing taxonomy entry for ${category}`);
    assert.ok(entry.transmission.length > 0);
  }
});

test("a company code pins the scope to the company, even for a market category", () => {
  assert.equal(newsScopeFor("major_security_incident", true), "company");
  assert.equal(newsScopeFor("major_security_incident", false), "market");
  assert.equal(newsScopeFor("tariffs", false), "market");
  assert.equal(newsScopeFor("tob", true), "company");
});

// --- X tiers keep their meaning -----------------------------------------------

test("the two X tiers map to critical and high only when the Fact check passed", () => {
  assert.equal(deriveNewsSeverity(input({ importance: "most_important", category: "tob" })).severity, "critical");
  assert.equal(deriveNewsSeverity(input({ importance: "important", category: "share_buyback" })).severity, "high");
});

test("an X-tier judgement that failed the Fact check is never above medium", () => {
  for (const importance of ["important", "most_important"]) {
    const decision = deriveNewsSeverity(input({ importance, category: "tob", factCheckStatus: "needs_review" }));
    assert.equal(decision.severity, "medium");
    assert.equal(decision.reason, "UNVERIFIED_X_TIER_DEMOTED");
  }
});

// --- company coverage (positive) ------------------------------------------------

test("holder-relevant company categories judged no_post become medium app items", () => {
  for (const category of [
    "earnings", "earnings_revision_up", "earnings_revision_down", "share_buyback", "dividend_increase",
    "dividend_decrease", "no_dividend", "ma", "tob", "business_alliance", "capital_alliance", "large_order",
    "misconduct", "administrative_action", "litigation", "major_shareholder", "large_shareholding",
  ] as const) {
    const decision = deriveNewsSeverity(input({ category }));
    assert.equal(decision.severity, "medium", category);
    assert.equal(decision.reason, "HOLDER_RELEVANT_COMPANY_NEWS", category);
  }
});

test("holder-relevant IR hidden in other_corporate_ir is recognised from the real headlines", () => {
  const cases: Array<[string, string]> = [
    ["2026年９月期 ８月度 月次業績（売上高）速報", "monthly_sales"],
    ["月次営業レポート（2026年８月度）", "monthly_sales"],
    ["株主優待制度の新設に関するお知らせ", "shareholder_benefit"],
    ["株主優待制度の廃止に関するお知らせ", "shareholder_benefit"],
    ["株式分割及び定款の一部変更に関するお知らせ", "stock_split"],
    ["第三者割当により発行された第19回新株予約権（行使価額修正条項付）の大量行使に関するお知らせ", "dilution"],
    ["第三者割当による新株式の発行に関するお知らせ", "dilution"],
    ["代表取締役の異動に関するお知らせ", "management_change"],
    ["腰椎椎間板ヘルニア治療剤SI-6603の米国承認申請に関する審査完了報告通知の受領について", "regulatory_approval"],
    ["SSL/TLSサーバー証明書発行サービスの一時停止に関するお知らせ", "business_disruption"],
    ["当社工場における火災発生に関するお知らせ", "business_disruption"],
    ["上場廃止の決定に関するお知らせ", "delisting_or_listing_change"],
    ["第5回無担保社債の発行に関するお知らせ", "debt_financing"],
  ];
  for (const [title, subtype] of cases) {
    assert.equal(detectCorporateIrSubtype(title), subtype, title);
  }
});

test("routine IR from the real rejected set stays low", () => {
  for (const title of [
    "監査役の辞任及び補欠監査役の監査役就任に関するお知らせ",
    "子会社設立のお知らせ",
    "支店閉鎖に関するお知らせ",
    "「内部統制システムの基本方針」の一部改定に関するお知らせ",
    "臨時株主総会招集のための基準日設定及び臨時株主総会開催並びに付議議案の決定に関するお知らせ",
    "連結子会社からの配当金受領に関するお知らせ",
    "当社株式の貸借銘柄選定に関するお知らせ",
  ]) {
    assert.equal(detectCorporateIrSubtype(title), "routine", title);
    assert.equal(deriveNewsSeverity(input({ title })).severity, "low", title);
  }
});

test("a holder-relevant IR subtype becomes a medium app item", () => {
  const decision = deriveNewsSeverity(input({ title: "2026年８月度 月次速報" }));
  assert.equal(decision.severity, "medium");
  assert.equal(decision.reason, "HOLDER_RELEVANT_IR_SUBTYPE");
  assert.equal(decision.irSubtype, "monthly_sales");
});

test("company news without a company code cannot reach holders and stays low", () => {
  const decision = deriveNewsSeverity(input({
    companyCode: null,
    category: "other_corporate_ir",
    title: "株主優待制度の新設に関するお知らせ",
    japanMarketRelevance: "high",
  }));
  // other_corporate_ir is a company category; without a code it has no holders to show it to.
  assert.equal(decision.scope, "company");
  assert.equal(decision.severity, "low");
});

// --- market-wide coverage ----------------------------------------------------------

test("tariff / export-control / war / ceasefire / sanctions news with a market path becomes medium", () => {
  const cases: Array<Partial<NewsSeverityInput>> = [
    { category: "tariffs", title: "Canada strikes back with tariffs on about $20 billion worth of U.S. goods" },
    { category: "semiconductor_ai", title: "China imposes new measures on Japanese exports of a key chipmaking material" },
    { category: "war_ceasefire", title: "Asian shares fall as crude oil trades above $100 amid U.S.-Iran conflict" },
    { category: "sanctions", title: "US Treasury imposes sweeping sanctions on Russian oil exports" },
    { category: "us_government_policy", title: "President signs executive order raising tariffs on imported vehicles" },
    { category: "geopolitics", title: "Strait of Hormuz shipping halted after tanker attacks" },
  ];
  for (const overrides of cases) {
    const decision = deriveNewsSeverity(input({
      sourceType: "market_macro",
      companyCode: null,
      japanMarketRelevance: "high",
      factCheckStatus: "needs_review",
      ...overrides,
    }));
    assert.equal(decision.scope, "market", String(overrides.title));
    assert.equal(decision.severity, "medium", String(overrides.title));
    assert.equal(decision.reason, "MARKET_TRANSMISSION_PATH", String(overrides.title));
  }
});

test("a verified X-tier market event keeps its X tier as severity", () => {
  const decision = deriveNewsSeverity(input({
    category: "tariffs", sourceType: "market_macro", companyCode: null,
    importance: "most_important", japanMarketRelevance: "high",
    title: "US announces 25% additional tariffs on Japanese automobiles effective immediately",
  }));
  assert.equal(decision.severity, "critical");
});

test("political small talk or a remark with no market effect is not treated as news", () => {
  for (const overrides of [
    { category: "us_government_policy", title: "President comments on upcoming state dinner", japanMarketRelevance: "none" },
    { category: "geopolitics", title: "UN chief, Red Cross renew call for rules on lethal autonomous weapons", japanMarketRelevance: "low" },
    { category: "war_ceasefire", title: "Guterres urges leaders to invest in peace as conflicts deepen", japanMarketRelevance: "low" },
    { category: "boj", title: "「日銀夏休み親子見学会2026」を開催しました", japanMarketRelevance: "none" },
  ] as Array<Partial<NewsSeverityInput>>) {
    const decision = deriveNewsSeverity(input({ sourceType: "market_macro", companyCode: null, ...overrides }));
    assert.equal(decision.severity, "low", String(overrides.title));
    assert.equal(decision.reason, "MARKET_NO_TRANSMISSION_PATH", String(overrides.title));
  }
});

test("routine central-bank speeches and statistics the judge could not verify stay low", () => {
  // Real rows: relevance medium, fact needs_review.
  for (const title of [
    "【挨拶】増審議委員「わが国の経済・物価情勢と金融政策」（福井）",
    "【記者会見】植田総裁（G20、9月1日分）",
    "債券市場サーベイ（2026年8月調査）",
    "消費者物価のコア指標",
  ]) {
    const decision = deriveNewsSeverity(input({
      sourceType: "market_macro", companyCode: null, category: "boj",
      japanMarketRelevance: "medium", factCheckStatus: "needs_review", title,
    }));
    assert.equal(decision.severity, "low", title);
  }
  // The same relevance with a passed Fact check is enough (e.g. BOJ FX data).
  const verified = deriveNewsSeverity(input({
    sourceType: "market_macro", companyCode: null, category: "fx",
    japanMarketRelevance: "medium", factCheckStatus: "passed",
    title: "BOJ data show USD/JPY fell from 156.20-21 to 155.55-56",
  }));
  assert.equal(verified.severity, "medium");
});

test("an unverified web-search item needs high relevance before it is shown at all", () => {
  const medium = deriveNewsSeverity(input({
    sourceType: "breaking_market", companyCode: null, category: "tariffs",
    japanMarketRelevance: "medium", factCheckStatus: "needs_review",
    title: "China says it hopes to agree with the US on tariff reductions",
  }));
  assert.equal(medium.severity, "low");
  const high = deriveNewsSeverity(input({
    sourceType: "breaking_market", companyCode: null, category: "war_ceasefire",
    japanMarketRelevance: "high", factCheckStatus: "needs_review",
    title: "US strikes Iranian tankers after more attempted missile attacks on Navy ships",
  }));
  assert.equal(high.severity, "medium");
});

// --- fail closed ---------------------------------------------------------------------

test("missing source url or published time is never shown, whatever the judgement", () => {
  for (const overrides of [
    { sourceUrl: null }, { sourceUrl: "" }, { sourceUrl: "http://example.com/a" }, { sourceUrl: "not a url" },
    { publishedAt: null }, { publishedAt: "not a date" },
  ] as Array<Partial<NewsSeverityInput>>) {
    const decision = deriveNewsSeverity(input({ importance: "most_important", category: "tob", ...overrides }));
    assert.equal(decision.severity, "low", JSON.stringify(overrides));
    assert.equal(decision.reason, "MISSING_FACT_BASIS");
  }
});

test("unknown relevance values are treated as no market path", () => {
  for (const japanMarketRelevance of [null, "", "very_high"]) {
    const decision = deriveNewsSeverity(input({
      sourceType: "market_macro", companyCode: null, category: "fx", japanMarketRelevance,
    }));
    assert.equal(decision.severity, "low");
  }
});

// --- nothing new can reach X ---------------------------------------------------------

test("severity never alters importance, so the existing X publish gate still rejects every new app item", () => {
  // Every item this module newly surfaces (medium) comes from a no_post or an
  // unverified judgement. Run them through the real pre-publish check.
  const surfaced: NewsSeverityInput[] = [
    input({ category: "administrative_action" }),
    input({ title: "2026年８月度 月次速報" }),
    input({ category: "war_ceasefire", sourceType: "market_macro", companyCode: null, japanMarketRelevance: "high", factCheckStatus: "needs_review" }),
    input({ importance: "most_important", category: "tob", factCheckStatus: "needs_review" }),
  ];
  for (const item of surfaced) {
    const before = { ...item };
    const decision = deriveNewsSeverity(item);
    assert.equal(decision.severity, "medium");
    assert.deepEqual(item, before, "deriveNewsSeverity must not mutate its input");

    const candidate: PublishCandidate = {
      id: "c", importance: item.importance, status: "ready_for_publish",
      generatedText: `【速報】本文\n\n出典: ${sourceUrl}`,
      generationFactStatus: item.factCheckStatus === "passed" ? "passed" : "failed",
      generationVoiceStatus: "passed", sourceUrl, xPostId: null, publishedAt: null, publishAttempts: 0,
    };
    assert.equal(checkPublishCandidate(candidate).passed, false, JSON.stringify(item));
  }
});

test("no combination of inputs turns a no_post item into an X tier", () => {
  const relevances = ["none", "low", "medium", "high", null];
  const facts = ["passed", "needs_review", null];
  const sources = ["tdnet", "company_ir", "market_macro", "breaking_market"];
  for (const category of IMPORTANT_NEWS_CATEGORIES) {
    for (const japanMarketRelevance of relevances) {
      for (const factCheckStatus of facts) {
        for (const sourceType of sources) {
          for (const companyCode of ["79740", null]) {
            const severity = deriveNewsSeverity(input({
              importance: "no_post", category, japanMarketRelevance, factCheckStatus, sourceType, companyCode,
            })).severity;
            assert.ok(severity === "medium" || severity === "low", `${category}/${japanMarketRelevance}/${factCheckStatus}/${sourceType}/${companyCode} -> ${severity}`);
          }
        }
      }
    }
  }
});

// --- delivery policy (design only) -------------------------------------------------------

test("proposed delivery policy: holdings get critical+high pushes, watchlist critical only, market-only never", () => {
  assert.deepEqual(
    (["critical", "high", "medium", "low"] as const).map((s) => proposedDeliveryPolicy(s, "holding").pushCandidate),
    [true, true, false, false],
  );
  assert.deepEqual(
    (["critical", "high", "medium", "low"] as const).map((s) => proposedDeliveryPolicy(s, "watch").pushCandidate),
    [true, false, false, false],
  );
  assert.deepEqual(
    (["critical", "high", "medium", "low"] as const).map((s) => proposedDeliveryPolicy(s, "market_only").pushCandidate),
    [false, false, false, false],
  );
  assert.deepEqual(
    (["critical", "high", "medium", "low"] as const).map((s) => proposedDeliveryPolicy(s, "holding").appFeed),
    [true, true, true, false],
  );
  assert.equal(proposedDeliveryPolicy("critical", "holding").xDecidedByExistingGate, true);
});

test("the module is not wired into the live pipeline in this phase", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert.ok(!index.includes("news_severity_logic"), "index.ts must not import the severity module yet");
});
