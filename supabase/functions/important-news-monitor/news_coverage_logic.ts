// "Collect broadly, notify by user choice" — see docs/news-coverage/REDESIGN.md.
//
// Phase 2 wires the CLASSIFICATION half only: index.ts calls
// classifyCollectionCoverage when a candidate is stored and classifyCoverage
// when the judgement is saved, writing coverage_severity / coverage_categories /
// emergency_class. The NOTIFICATION half below (presets, category mutes,
// notificationEligibility) stays unwired: no producer reads it, so no user's
// push volume changes in this phase.
//
// Three separate decisions, deliberately kept apart:
//   1. coverage categories — what a stored item is about (many per item)
//   2. coverage severity   — emergency / critical / high / medium / low
//   3. notification policy — whether THIS user gets a push, from their preset
//
// The existing X publish gate (importance + Fact + Voice) and the existing
// app severity (deriveNewsSeverity, mirrored in SQL) are read, never changed:
// this module can only widen what is stored and what a user may opt into.

import type { ImportantNewsCategory } from "./news_candidate_logic.ts";
import {
  deriveNewsSeverity,
  type JapanMarketRelevance,
  type NewsScope,
  type NewsSeverity,
  type NewsSeverityInput,
} from "./news_severity_logic.ts";

// ---------------------------------------------------------------------------
// 1. Coverage categories
// ---------------------------------------------------------------------------

export const COVERAGE_CATEGORIES = [
  "geopolitics",
  "disaster",
  "monetary_policy",
  "fx",
  "rates",
  "oil_energy",
  "commodities",
  "shipping_logistics",
  "semiconductors",
  "ai_tech",
  "us_market",
  "japan_market",
  "regulation_policy",
  "corporate",
  "earnings",
  "financial_system",
] as const;

export type CoverageCategory = typeof COVERAGE_CATEGORIES[number];

/** Base mapping from the stored (X-oriented) category to coverage categories. */
export const COVERAGE_FROM_NEWS_CATEGORY: Record<ImportantNewsCategory, CoverageCategory[]> = {
  earnings_revision_up: ["earnings", "corporate"],
  earnings_revision_down: ["earnings", "corporate"],
  earnings: ["earnings", "corporate"],
  share_buyback: ["corporate"],
  dividend_increase: ["corporate"],
  dividend_decrease: ["corporate"],
  no_dividend: ["corporate"],
  ma: ["corporate"],
  tob: ["corporate"],
  business_alliance: ["corporate"],
  capital_alliance: ["corporate"],
  large_order: ["corporate"],
  misconduct: ["corporate"],
  administrative_action: ["corporate", "regulation_policy"],
  litigation: ["corporate"],
  major_shareholder: ["corporate"],
  large_shareholding: ["corporate"],
  other_corporate_ir: ["corporate"],
  boj: ["monetary_policy", "japan_market"],
  frb: ["monetary_policy", "us_market"],
  interest_rates: ["rates"],
  fx: ["fx"],
  tariffs: ["regulation_policy"],
  china_policy: ["regulation_policy", "geopolitics"],
  us_government_policy: ["regulation_policy", "us_market"],
  geopolitics: ["geopolitics"],
  war_ceasefire: ["geopolitics"],
  sanctions: ["geopolitics", "regulation_policy"],
  major_security_incident: ["geopolitics"],
  semiconductor_ai: ["semiconductors", "ai_tech"],
  disaster: ["disaster"],
  other_market_moving: [],
};

/**
 * Extra categories a headline earns on its own wording, so an item is findable
 * by what it affects and not only by the single category the judge picked.
 * Deterministic: patterns only, no AI, no network.
 */
export const COVERAGE_KEYWORD_RULES: Array<{ category: CoverageCategory; pattern: RegExp }> = [
  { category: "disaster", pattern: /earthquake|tsunami|typhoon|eruption|volcan|flood|wildfire|blackout|power outage|地震|津波|噴火|台風|洪水|大雪|停電|災害|避難/iu },
  { category: "geopolitics", pattern: /missile|ballistic|north korea|pyongyang|taiwan|strait|war\b|ceasefire|airstrike|drone attack|invasion|nuclear test|j-?alert|ミサイル|弾道|北朝鮮|台湾|海峡|戦争|停戦|空爆|侵攻|核実験|Jアラート|警報/iu },
  { category: "shipping_logistics", pattern: /hormuz|suez|red sea|bab el.?mandeb|panama canal|tanker|shipping|freight|port strike|chokepoint|ホルムズ|スエズ|紅海|パナマ運河|タンカー|海運|運賃|港湾/iu },
  { category: "oil_energy", pattern: /crude|brent|wti|opec|refinery|pipeline|natural gas|lng|electricity price|原油|ブレント|石油|製油所|パイプライン|天然ガス|電力価格/iu },
  { category: "commodities", pattern: /gold|copper|iron ore|wheat|grain|aluminium|aluminum|nickel|rare earth|金価格|銅|鉄鉱石|小麦|穀物|ニッケル|レアアース/iu },
  { category: "monetary_policy", pattern: /\bfomc\b|federal reserve|\bfed\b|\bboj\b|bank of japan|\becb\b|rate (?:cut|hike|decision)|quantitative|yield curve control|日銀|金融政策|政策金利|利上げ|利下げ|量的/iu },
  { category: "rates", pattern: /yield|jgb|treasury|bond market|10-year|長期金利|国債|利回り/iu },
  { category: "fx", pattern: /\bfx\b|yen|usd\/?jpy|dollar|exchange rate|intervention|為替|円安|円高|ドル円|介入/iu },
  { category: "semiconductors", pattern: /semiconductor|chip|wafer|foundry|euv|tsmc|nvidia|\bsox\b|半導体|ウエハ|ファウンドリ/iu },
  { category: "ai_tech", pattern: /\bai\b|artificial intelligence|data ?cent(?:er|re)|gpu|cloud capex|人工知能|データセンター/iu },
  { category: "us_market", pattern: /nasdaq|s&p 500|dow jones|wall street|payrolls|\bcpi\b|\bppi\b|米株|米雇用|米消費者物価/iu },
  { category: "japan_market", pattern: /nikkei|topix|tse|japanese stocks|日経平均|東証|日本株|ＴＯＰＩＸ/iu },
  { category: "financial_system", pattern: /bank (?:failure|collapse|run)|deposit insurance|exchange outage|clearing|systemic|銀行破綻|取引所障害|決済障害|システム障害|金融システム/iu },
  { category: "regulation_policy", pattern: /tariff|sanction|export control|antitrust|regulation|executive order|関税|制裁|輸出規制|独占禁止|規制|大統領令/iu },
  { category: "earnings", pattern: /earnings|guidance|profit warning|決算|業績予想|上方修正|下方修正/iu },
];

export function coverageCategoriesFor(input: {
  category: ImportantNewsCategory;
  title: string;
  bodySummary?: string | null;
  companyCode?: string | null;
}): CoverageCategory[] {
  const found = new Set<CoverageCategory>(COVERAGE_FROM_NEWS_CATEGORY[input.category] ?? []);
  const text = `${input.title}\n${input.bodySummary ?? ""}`.normalize("NFKC");
  for (const rule of COVERAGE_KEYWORD_RULES) {
    if (rule.pattern.test(text)) found.add(rule.category);
  }
  // A stock's own disclosure is always corporate news, whatever else it mentions.
  if (input.companyCode && input.companyCode.trim()) found.add("corporate");
  // Never leave an item uncategorised: it would be invisible to category filters.
  if (found.size === 0) found.add(input.companyCode ? "corporate" : "japan_market");
  return COVERAGE_CATEGORIES.filter((category) => found.has(category));
}

// ---------------------------------------------------------------------------
// 2. Emergency
// ---------------------------------------------------------------------------

export const EMERGENCY_CLASSES = [
  "missile_near_japan",
  "war_escalation",
  "chokepoint_disruption",
  "taiwan_contingency",
  "major_disaster",
  "emergency_monetary_action",
  "market_infrastructure_failure",
  "oil_supply_disruption",
] as const;

export type EmergencyClass = typeof EMERGENCY_CLASSES[number];

export function isEmergencyClass(value: unknown): value is EmergencyClass {
  return typeof value === "string" && (EMERGENCY_CLASSES as readonly string[]).includes(value);
}

/**
 * Each class needs BOTH an event pattern and a severity qualifier, so "North
 * Korea policy talks" or "earthquake preparedness drill" never reads as an
 * emergency. Patterns are matched on the NFKC-normalised title + summary.
 */
export const EMERGENCY_RULES: Array<{
  emergencyClass: EmergencyClass;
  event: RegExp;
  qualifier: RegExp;
}> = [
  {
    emergencyClass: "missile_near_japan",
    event: /(?:missile|ballistic|projectile|ミサイル|弾道|飛翔体)/iu,
    qualifier: /(?:japan|japanese|hokkaido|okinawa|eez|exclusive economic zone|j-?alert|launch|fired|over\s+japan|日本|北海道|沖縄|排他的経済水域|Jアラート|発射|落下|通過)/iu,
  },
  {
    emergencyClass: "war_escalation",
    event: /(?:war|invasion|airstrike|air strike|missile strike|bombard|military operation|戦争|侵攻|空爆|攻撃|軍事作戦)/iu,
    qualifier: /(?:declare|declares|launch(?:es|ed)?|begin|escalat|retaliat|strikes?\s+(?:on|against)|state of emergency|mobiliz|宣言|開始|拡大|報復|緊急事態|動員)/iu,
  },
  {
    emergencyClass: "chokepoint_disruption",
    event: /(?:hormuz|suez|bab el.?mandeb|red sea|panama canal|ホルムズ|スエズ|紅海|パナマ運河)/iu,
    qualifier: /(?:clos(?:e|ed|ure)|block(?:ade|ed|ing)?|halt|suspend|attack|seiz|mine[sd]?\b|封鎖|閉鎖|停止|攻撃|拿捕|機雷)/iu,
  },
  {
    emergencyClass: "taiwan_contingency",
    event: /(?:taiwan|taiwan strait|台湾|台湾海峡)/iu,
    qualifier: /(?:blockade|quarantine|invasion|live-?fire|military exercise|incursion|mobiliz|封鎖|侵攻|実弾|軍事演習|領空侵犯)/iu,
  },
  {
    emergencyClass: "major_disaster",
    event: /(?:earthquake|tsunami|eruption|typhoon|地震|津波|噴火|台風)/iu,
    qualifier: /(?:magnitude\s*[6-9]|\bm[6-9]\b|warning|advisory|evacuat|shindo|震度\s*[5-7]|マグニチュード\s*[6-9]|警報|避難|大津波)/iu,
  },
  {
    emergencyClass: "emergency_monetary_action",
    event: /(?:federal reserve|\bfed\b|\bboj\b|bank of japan|\becb\b|central bank|日銀|中央銀行|金融政策)/iu,
    qualifier: /(?:emergency|unscheduled|intermeeting|inter-meeting|surprise|extraordinary|緊急|臨時|予定外)/iu,
  },
  {
    emergencyClass: "market_infrastructure_failure",
    event: /(?:exchange|clearing|settlement|trading system|payment system|取引所|清算|決済|売買システム)/iu,
    qualifier: /(?:outage|halt(?:ed|s)?|suspend|failure|down\b|breach|障害|停止|中断|不正アクセス)/iu,
  },
  {
    emergencyClass: "oil_supply_disruption",
    event: /(?:crude|oil|refinery|pipeline|opec|lng|原油|石油|製油所|パイプライン)/iu,
    qualifier: /(?:supply (?:cut|halt|disruption)|export ban|force majeure|shut ?down|sabotage|供給停止|輸出禁止|操業停止|破壊)/iu,
  },
];

/**
 * Sources trusted enough for an emergency (which bypasses the tracked-sector
 * filter): the official/major-wire hosts the pipeline already allows, plus the
 * Japanese authorities for J-alert / quake-grade events. Host match is exact or
 * a subdomain, never a substring.
 */
export const EMERGENCY_SOURCE_HOSTS = [
  "reuters.com", "apnews.com", "bloomberg.com", "nikkei.com",
  "boj.or.jp", "mof.go.jp", "federalreserve.gov", "ecb.europa.eu",
  "centcom.mil", "defense.gov", "state.gov",
  "jma.go.jp", "kishou.go.jp", "nhk.or.jp", "kantei.go.jp", "mod.go.jp", "fdma.go.jp",
  "jpx.co.jp",
];

export const MAX_EMERGENCY_AGE_MS = 6 * 60 * 60 * 1000;

export function isEmergencySourceHost(sourceUrl: string | null): boolean {
  try {
    const url = new URL(sourceUrl ?? "");
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return EMERGENCY_SOURCE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

export type EmergencyDecision = {
  isEmergency: boolean;
  emergencyClass: EmergencyClass | null;
  reason:
    | "EMERGENCY"
    | "NO_EMERGENCY_PATTERN"
    | "SOURCE_NOT_TRUSTED"
    | "STALE"
    | "COMPANY_SCOPED"
    | "MISSING_TIMESTAMP";
};

/**
 * Deterministic emergency detection. It deliberately does NOT look at the
 * tracked stocks or sectors of any user: an emergency reaches an opted-in user
 * regardless. The Fact/source gates stay: an untrusted host, a stale item, a
 * missing timestamp or a company-scoped disclosure is never an emergency.
 */
export function detectEmergency(input: {
  title: string;
  bodySummary?: string | null;
  companyCode?: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  now?: Date;
}): EmergencyDecision {
  const none = (reason: EmergencyDecision["reason"]): EmergencyDecision =>
    ({ isEmergency: false, emergencyClass: null, reason });
  if (input.companyCode && input.companyCode.trim()) return none("COMPANY_SCOPED");
  if (!isEmergencySourceHost(input.sourceUrl)) return none("SOURCE_NOT_TRUSTED");
  const published = Date.parse(input.publishedAt ?? "");
  if (!Number.isFinite(published)) return none("MISSING_TIMESTAMP");
  const now = input.now ?? new Date();
  const age = now.getTime() - published;
  if (age > MAX_EMERGENCY_AGE_MS || age < -60 * 60 * 1000) return none("STALE");
  const text = `${input.title}\n${input.bodySummary ?? ""}`.normalize("NFKC");
  for (const rule of EMERGENCY_RULES) {
    if (rule.event.test(text) && rule.qualifier.test(text)) {
      return { isEmergency: true, emergencyClass: rule.emergencyClass, reason: "EMERGENCY" };
    }
  }
  return none("NO_EMERGENCY_PATTERN");
}

// ---------------------------------------------------------------------------
// 3. Coverage severity (emergency on top of the existing app severity)
// ---------------------------------------------------------------------------

export type CoverageSeverity = "emergency" | NewsSeverity;

export const COVERAGE_SEVERITY_RANK: Record<CoverageSeverity, number> = {
  emergency: 5, critical: 4, high: 3, medium: 2, low: 1,
};

export type CoverageDecision = {
  severity: CoverageSeverity;
  scope: NewsScope;
  categories: CoverageCategory[];
  emergencyClass: EmergencyClass | null;
  /** Emergencies reach opted-in users without a tracked-sector match. */
  bypassesSectorMatch: boolean;
  appSeverity: NewsSeverity;
  appReason: string;
  emergencyReason: EmergencyDecision["reason"];
};

/**
 * Wraps the shipped deriveNewsSeverity (unchanged, still mirrored in SQL) and
 * adds the emergency level. A market-wide item that the judge could not verify
 * still stays at most `medium` for display, but an emergency is promoted so the
 * notification policy can act on it — the push text gate (Fact-passed Japanese
 * only) is enforced separately, in the producer.
 */
export function classifyCoverage(input: NewsSeverityInput & {
  bodySummary?: string | null;
  japanMarketRelevance: JapanMarketRelevance | string | null;
  now?: Date;
  /**
   * An emergency already recorded at collection time. Judgement runs minutes to
   * hours later, so re-deriving it there would silently demote an item that has
   * simply aged past the freshness window.
   */
  priorEmergencyClass?: EmergencyClass | null;
}): CoverageDecision {
  const app = deriveNewsSeverity(input);
  const categories = coverageCategoriesFor({
    category: input.category,
    title: input.title,
    bodySummary: input.bodySummary,
    companyCode: input.companyCode,
  });
  const emergency = detectEmergency({
    title: input.title,
    bodySummary: input.bodySummary,
    companyCode: input.companyCode,
    sourceUrl: input.sourceUrl,
    publishedAt: input.publishedAt,
    now: input.now,
  });
  const prior = input.priorEmergencyClass ?? null;
  const emergencyClass = emergency.emergencyClass ?? prior;
  const isEmergency = emergency.isEmergency || prior !== null;
  return {
    severity: isEmergency ? "emergency" : app.severity,
    scope: app.scope,
    categories,
    emergencyClass,
    bypassesSectorMatch: isEmergency,
    appSeverity: app.severity,
    appReason: app.reason,
    emergencyReason: emergency.isEmergency ? emergency.reason
      : prior !== null ? "EMERGENCY" : emergency.reason,
  };
}

/**
 * What can be decided the moment a candidate is stored, before any AI
 * judgement: its coverage categories and whether it is an emergency. The
 * severity beyond that needs the judgement, so it stays null here.
 */
export function classifyCollectionCoverage(input: {
  category: ImportantNewsCategory;
  title: string;
  bodySummary?: string | null;
  companyCode?: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  now?: Date;
}): { categories: CoverageCategory[]; emergencyClass: EmergencyClass | null; severity: "emergency" | null } {
  const emergency = detectEmergency(input);
  return {
    categories: coverageCategoriesFor(input),
    emergencyClass: emergency.emergencyClass,
    severity: emergency.isEmergency ? "emergency" : null,
  };
}

// ---------------------------------------------------------------------------
// 4. Storage policy: collection is never narrowed by notification settings
// ---------------------------------------------------------------------------

export type StorageDecision = { store: boolean; reason: "STORE" | "NO_VERIFIABLE_SOURCE" };

/**
 * What is worth keeping (and therefore showable in the app). The only reason to
 * drop an item is that it has no verifiable source or time — never "the user
 * probably does not want a push about it", and never "no tracked stock or
 * sector matches".
 */
export function shouldStoreForCoverage(input: {
  sourceUrl: string | null;
  publishedAt: string | null;
}): StorageDecision {
  const timeOk = Number.isFinite(Date.parse(input.publishedAt ?? ""));
  let urlOk = false;
  try {
    urlOk = new URL(input.sourceUrl ?? "").protocol === "https:";
  } catch {
    urlOk = false;
  }
  return timeOk && urlOk ? { store: true, reason: "STORE" } : { store: false, reason: "NO_VERIFIABLE_SOURCE" };
}

// ---------------------------------------------------------------------------
// 5. Notification policy
// ---------------------------------------------------------------------------

export const NOTIFICATION_PRESETS = ["quiet", "standard", "many", "all"] as const;
export type NotificationPreset = typeof NOTIFICATION_PRESETS[number];

/**
 * Minimum severity per scope for each preset. Emergencies are handled by their
 * own switch and are not subject to the market threshold.
 * `low` is never pushed by any preset: it stays visible in the app instead.
 */
export const PRESET_THRESHOLDS: Record<NotificationPreset, {
  company: CoverageSeverity;
  market: CoverageSeverity;
  label: string;
}> = {
  quiet: { company: "critical", market: "emergency", label: "静かめ" },
  standard: { company: "high", market: "critical", label: "標準" },
  many: { company: "medium", market: "high", label: "多め" },
  all: { company: "medium", market: "medium", label: "全部通知" },
};

export type UserNotificationSettings = {
  pushEnabled: boolean;
  /** Master switch for news pushes (existing alert_settings.important_news). */
  importantNews: boolean;
  preset: NotificationPreset;
  /** Emergencies reach the user without a sector match (proposed, default true). */
  emergencyAlerts: boolean;
  /** Categories the user switched off; everything not listed stays on. */
  mutedCategories?: CoverageCategory[];
};

export type NotificationEligibility = {
  send: boolean;
  reason:
    | "SEND"
    | "PUSH_DISABLED"
    | "NEWS_PUSH_DISABLED"
    | "EMERGENCY_DISABLED"
    | "CATEGORY_MUTED"
    | "BELOW_PRESET_THRESHOLD"
    | "NO_TRACKED_MATCH"
    | "NO_FACT_PASSED_TEXT"
    | "ALREADY_NOTIFIED";
};

export type NotificationCandidate = {
  scope: NewsScope;
  severity: CoverageSeverity;
  categories: CoverageCategory[];
  /** Emergency: true for an item allowed to skip the sector match. */
  bypassesSectorMatch: boolean;
  /** A tracked stock (company scope) or a tracked sector (market scope) matched. */
  trackedMatch: boolean;
  /** Fact-passed Japanese text exists (app copy or verified post). */
  hasFactPassedText: boolean;
  alreadyNotified: boolean;
};

/**
 * One place that decides whether a push goes out. Order matters: the hard
 * blocks (off switches, dedupe, missing verified text) come before the
 * preference thresholds, so widening a preset can never bypass them.
 */
export function notificationEligibility(
  candidate: NotificationCandidate,
  settings: UserNotificationSettings,
): NotificationEligibility {
  if (!settings.pushEnabled) return { send: false, reason: "PUSH_DISABLED" };
  if (!settings.importantNews) return { send: false, reason: "NEWS_PUSH_DISABLED" };
  if (candidate.alreadyNotified) return { send: false, reason: "ALREADY_NOTIFIED" };
  // Never push text the Fact check has not cleared, at any severity.
  if (!candidate.hasFactPassedText) return { send: false, reason: "NO_FACT_PASSED_TEXT" };
  const muted = new Set(settings.mutedCategories ?? []);
  if (candidate.categories.length > 0 && candidate.categories.every((category) => muted.has(category))) {
    return { send: false, reason: "CATEGORY_MUTED" };
  }
  const isEmergency = candidate.severity === "emergency";
  if (isEmergency) {
    if (!settings.emergencyAlerts) return { send: false, reason: "EMERGENCY_DISABLED" };
    return { send: true, reason: "SEND" };
  }
  if (candidate.scope === "market" && !candidate.trackedMatch && !candidate.bypassesSectorMatch) {
    return { send: false, reason: "NO_TRACKED_MATCH" };
  }
  if (candidate.scope === "company" && !candidate.trackedMatch) {
    return { send: false, reason: "NO_TRACKED_MATCH" };
  }
  const threshold = PRESET_THRESHOLDS[settings.preset] ?? PRESET_THRESHOLDS.standard;
  const required = candidate.scope === "company" ? threshold.company : threshold.market;
  if (COVERAGE_SEVERITY_RANK[candidate.severity] < COVERAGE_SEVERITY_RANK[required]) {
    return { send: false, reason: "BELOW_PRESET_THRESHOLD" };
  }
  return { send: true, reason: "SEND" };
}

/** How today's production settings map onto a preset, so nothing changes for an existing user. */
export function presetFromLegacySettings(settings: {
  marketCriticalNews: boolean;
}): NotificationPreset {
  // Today: company pushes fire at X-tier (critical/high) and market pushes only
  // for opted-in users at critical. That is exactly "standard"; a user who never
  // opted into market news is "quiet" apart from its emergency allowance.
  return settings.marketCriticalNews ? "standard" : "quiet";
}
