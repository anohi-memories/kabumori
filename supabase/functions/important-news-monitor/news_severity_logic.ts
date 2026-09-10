// Phase 1 of "collect broadly, deliver narrowly".
//
// Today one field, `importance` (no_post / important / most_important), decides
// BOTH whether a news item is worth keeping AND whether it is posted to X:
// important and most_important flow straight into generation and auto-publish.
// So anything a holder would care about that is not X-worthy is judged no_post,
// stored as rejected, and never shown in the app.
//
// This module adds a separate, app-facing severity that is derived from the
// judgement the pipeline already stores. It is deliberately NOT wired into the
// live pipeline in this phase:
//   - it never reads or writes `importance`, so the X publish gate
//     (checkPublishCandidate: importance in important/most_important +
//     ready_for_publish + Fact/Voice passed) is untouched;
//   - it adds no source, no AI call and no schema;
//   - nothing imports it from index.ts.
// Phase 2 can persist the severity and use it for the app feed / push policy
// once that scope is approved.

import type { ImportantNewsCategory, ImportantNewsImportance } from "./news_candidate_logic.ts";

export type NewsSeverity = "critical" | "high" | "medium" | "low";
export type NewsScope = "company" | "market";
export type JapanMarketRelevance = "none" | "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/**
 * How news in each existing category reaches Japanese equities. Company
 * categories act on the named stock; market categories must name a
 * transmission path (index, FX, rates, oil, a sector) to matter at all.
 */
export const NEWS_CATEGORY_TAXONOMY: Record<ImportantNewsCategory, {
  scope: NewsScope;
  transmission: string;
  holderRelevant: boolean;
}> = {
  earnings_revision_up: { scope: "company", transmission: "業績予想（上方修正）", holderRelevant: true },
  earnings_revision_down: { scope: "company", transmission: "業績予想（下方修正）", holderRelevant: true },
  earnings: { scope: "company", transmission: "決算", holderRelevant: true },
  share_buyback: { scope: "company", transmission: "自社株買い・消却（需給・株主還元）", holderRelevant: true },
  dividend_increase: { scope: "company", transmission: "増配・復配", holderRelevant: true },
  dividend_decrease: { scope: "company", transmission: "減配", holderRelevant: true },
  no_dividend: { scope: "company", transmission: "無配", holderRelevant: true },
  ma: { scope: "company", transmission: "M&A・買収・売却", holderRelevant: true },
  tob: { scope: "company", transmission: "TOB（株価に直結）", holderRelevant: true },
  business_alliance: { scope: "company", transmission: "業務提携", holderRelevant: true },
  capital_alliance: { scope: "company", transmission: "資本提携", holderRelevant: true },
  large_order: { scope: "company", transmission: "大口受注・大型契約", holderRelevant: true },
  misconduct: { scope: "company", transmission: "不祥事・事故", holderRelevant: true },
  administrative_action: { scope: "company", transmission: "行政処分・規制・承認", holderRelevant: true },
  litigation: { scope: "company", transmission: "訴訟", holderRelevant: true },
  major_shareholder: { scope: "company", transmission: "主要株主の異動", holderRelevant: true },
  large_shareholding: { scope: "company", transmission: "大量保有", holderRelevant: true },
  other_corporate_ir: { scope: "company", transmission: "その他IR（小分類で判定）", holderRelevant: false },
  boj: { scope: "market", transmission: "日銀→金利・円相場・銀行株", holderRelevant: false },
  frb: { scope: "market", transmission: "FRB→米金利・ドル円・グロース株", holderRelevant: false },
  interest_rates: { scope: "market", transmission: "金利→銀行・不動産・グロース株", holderRelevant: false },
  fx: { scope: "market", transmission: "為替→輸出株・内需株", holderRelevant: false },
  tariffs: { scope: "market", transmission: "関税→輸出・自動車・部品", holderRelevant: false },
  china_policy: { scope: "market", transmission: "対中政策・米中摩擦→半導体・素材・サプライチェーン", holderRelevant: false },
  us_government_policy: { scope: "market", transmission: "米政権の政策・大統領令", holderRelevant: false },
  geopolitics: { scope: "market", transmission: "地政学→原油・海運・防衛・リスク心理", holderRelevant: false },
  war_ceasefire: { scope: "market", transmission: "戦争・停戦→原油・防衛・リスク心理", holderRelevant: false },
  sanctions: { scope: "market", transmission: "制裁→エネルギー・商社・対象国関連", holderRelevant: false },
  major_security_incident: { scope: "market", transmission: "重大事件・サイバー攻撃→複数業種", holderRelevant: false },
  semiconductor_ai: { scope: "market", transmission: "半導体・AI規制/需要→SOX・半導体株", holderRelevant: false },
  other_market_moving: { scope: "market", transmission: "指標・原油・株価急変", holderRelevant: false },
};

/**
 * `major_security_incident` is a market category, but a company-level cyber
 * incident or accident carries a company code and belongs to that stock.
 */
export function newsScopeFor(category: ImportantNewsCategory, hasCompanyCode: boolean): NewsScope {
  if (hasCompanyCode) return "company";
  return NEWS_CATEGORY_TAXONOMY[category]?.scope ?? "market";
}

// ---------------------------------------------------------------------------
// Holder-relevant IR hidden inside other_corporate_ir
// ---------------------------------------------------------------------------

export type CorporateIrSubtype =
  | "monthly_sales"
  | "shareholder_benefit"
  | "stock_split"
  | "dilution"
  | "debt_financing"
  | "management_change"
  | "regulatory_approval"
  | "business_disruption"
  | "delisting_or_listing_change"
  | "product_launch_or_delay"
  | "routine";

// Order matters: the first match wins, and the routine patterns come last so a
// headline that mentions both (e.g. 監査役 + 代表取締役) is not buried as routine.
const CORPORATE_IR_SUBTYPE_RULES: Array<{ subtype: Exclude<CorporateIrSubtype, "routine">; pattern: RegExp }> = [
  { subtype: "delisting_or_listing_change", pattern: /上場廃止|整理銘柄|監理銘柄|特別注意銘柄|市場区分の変更|上場市場の変更/u },
  { subtype: "regulatory_approval", pattern: /承認(?:取得|申請)|審査完了報告|CRL|製造販売|薬事|治験|許認可|認可取得/u },
  { subtype: "business_disruption", pattern: /停止|休止|操業|火災|事故|障害|不正アクセス|サイバー|リコール|延期|中止/u },
  { subtype: "dilution", pattern: /新株予約権.*(?:大量行使|行使)|第三者割当|公募増資|募集株式|転換社債|CB|ライツ/u },
  { subtype: "stock_split", pattern: /株式分割|株式併合/u },
  { subtype: "shareholder_benefit", pattern: /株主優待/u },
  { subtype: "management_change", pattern: /代表取締役.*(?:異動|交代|就任|辞任)|社長.*(?:交代|就任|辞任)|CEO/u },
  { subtype: "monthly_sales", pattern: /月次|(?:\d|[０-９])+\s*月度|売上高?速報|営業レポート/u },
  { subtype: "debt_financing", pattern: /社債|借入|資金調達|コミットメントライン/u },
  { subtype: "product_launch_or_delay", pattern: /新製品|新サービス|提供開始|発売/u },
];

export function detectCorporateIrSubtype(title: string): CorporateIrSubtype {
  const normalized = title.normalize("NFKC");
  for (const rule of CORPORATE_IR_SUBTYPE_RULES) {
    if (rule.pattern.test(normalized)) return rule.subtype;
  }
  return "routine";
}

/** Subtypes a holder generally wants to see in the app even when X would not post them. */
const HOLDER_VISIBLE_IR_SUBTYPES: ReadonlySet<CorporateIrSubtype> = new Set([
  "monthly_sales", "shareholder_benefit", "stock_split", "dilution", "management_change",
  "regulatory_approval", "business_disruption", "delisting_or_listing_change", "product_launch_or_delay",
]);

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export type NewsSeverityInput = {
  importance: ImportantNewsImportance | string;
  category: ImportantNewsCategory;
  title: string;
  sourceType: string;
  sourceUrl: string | null;
  publishedAt: string | null;
  companyCode: string | null;
  japanMarketRelevance: JapanMarketRelevance | string | null;
  factCheckStatus: string | null;
};

export type NewsSeverityDecision = {
  severity: NewsSeverity;
  scope: NewsScope;
  reason:
    | "MISSING_FACT_BASIS"
    | "X_TIER_MOST_IMPORTANT"
    | "X_TIER_IMPORTANT"
    | "UNVERIFIED_X_TIER_DEMOTED"
    | "HOLDER_RELEVANT_COMPANY_NEWS"
    | "HOLDER_RELEVANT_IR_SUBTYPE"
    | "ROUTINE_COMPANY_IR"
    | "MARKET_TRANSMISSION_PATH"
    | "MARKET_NO_TRANSMISSION_PATH";
  irSubtype: CorporateIrSubtype | null;
};

const RELEVANCE_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3 };

function hasFactBasis(input: NewsSeverityInput): boolean {
  if (typeof input.publishedAt !== "string" || !Number.isFinite(Date.parse(input.publishedAt))) return false;
  try {
    return new URL(input.sourceUrl ?? "").protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Derives the app-facing severity. The X tiers map one-to-one onto the top two
 * levels only when the Fact check passed; everything the pipeline currently
 * discards is re-examined for the app, never promoted above `medium`. So this
 * function can widen what an app may SHOW, but by construction can never make
 * anything X-eligible that is not already X-eligible.
 */
export function deriveNewsSeverity(input: NewsSeverityInput): NewsSeverityDecision {
  const hasCode = typeof input.companyCode === "string" && input.companyCode.trim().length > 0;
  const scope = newsScopeFor(input.category, hasCode);
  const irSubtype = input.category === "other_corporate_ir" ? detectCorporateIrSubtype(input.title) : null;

  // No verifiable source or time: nothing is shown, whatever the model said.
  if (!hasFactBasis(input)) return { severity: "low", scope, reason: "MISSING_FACT_BASIS", irSubtype };

  const factPassed = input.factCheckStatus === "passed";
  if (input.importance === "most_important" && factPassed) {
    return { severity: "critical", scope, reason: "X_TIER_MOST_IMPORTANT", irSubtype };
  }
  if (input.importance === "important" && factPassed) {
    return { severity: "high", scope, reason: "X_TIER_IMPORTANT", irSubtype };
  }

  const relevance = RELEVANCE_RANK[String(input.japanMarketRelevance)] ?? 0;
  const xTierButUnverified = input.importance === "important" || input.importance === "most_important";

  if (scope === "company") {
    // A company item needs a real ticker to reach its holders at all.
    if (!hasCode) return { severity: "low", scope, reason: "ROUTINE_COMPANY_IR", irSubtype };
    if (xTierButUnverified) return { severity: "medium", scope, reason: "UNVERIFIED_X_TIER_DEMOTED", irSubtype };
    if (NEWS_CATEGORY_TAXONOMY[input.category]?.holderRelevant) {
      return { severity: "medium", scope, reason: "HOLDER_RELEVANT_COMPANY_NEWS", irSubtype };
    }
    if (irSubtype && HOLDER_VISIBLE_IR_SUBTYPES.has(irSubtype)) {
      return { severity: "medium", scope, reason: "HOLDER_RELEVANT_IR_SUBTYPE", irSubtype };
    }
    return { severity: "low", scope, reason: "ROUTINE_COMPANY_IR", irSubtype };
  }

  // Market-wide: only with a stated path into Japanese equities, i.e. the
  // judgement itself rated the relevance at least medium. A bare political
  // remark with no market effect stays low. When the judge could not verify the
  // item from the stored text (needs_review), only a HIGH relevance is enough:
  // on real data a "medium + unverified" bar let routine central-bank speeches
  // and statistics through, while the genuinely market-moving unverified items
  // (tanker strikes, oil above $100, chip-material export curbs) were all rated high.
  const requiredRelevance = factPassed ? RELEVANCE_RANK.medium : RELEVANCE_RANK.high;
  if (relevance >= requiredRelevance) {
    return {
      severity: "medium",
      scope,
      reason: xTierButUnverified ? "UNVERIFIED_X_TIER_DEMOTED" : "MARKET_TRANSMISSION_PATH",
      irSubtype,
    };
  }
  return { severity: "low", scope, reason: "MARKET_NO_TRANSMISSION_PATH", irSubtype };
}

// ---------------------------------------------------------------------------
// Delivery policy (design only - not enabled anywhere)
// ---------------------------------------------------------------------------

export type NewsAudienceRelation = "holding" | "watch" | "market_only";

export type NewsDeliveryPolicy = {
  appFeed: boolean;
  pushCandidate: boolean;
  /** X eligibility is NOT decided here; it stays with the existing importance-based publish gate. */
  xDecidedByExistingGate: true;
};

/**
 * Proposed future policy, expressed as code so Phase 2 can adopt it verbatim:
 *   holding     : push critical + high, feed critical..medium
 *   watch       : push critical only, feed critical..medium
 *   market_only : no push until a market-alert setting or sector mapping exists
 *                 (company_code-less news must never fan out to every user)
 */
export function proposedDeliveryPolicy(
  severity: NewsSeverity,
  relation: NewsAudienceRelation,
): NewsDeliveryPolicy {
  const appFeed = severity !== "low";
  let pushCandidate = false;
  if (relation === "holding") pushCandidate = severity === "critical" || severity === "high";
  if (relation === "watch") pushCandidate = severity === "critical";
  return { appFeed, pushCandidate, xDecidedByExistingGate: true };
}
