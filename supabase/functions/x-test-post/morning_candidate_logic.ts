import {
  independentPublisherCount,
  publisherKey,
  type MaterialFreshness,
  type ReportMaterialType,
} from "./report_material_logic.ts";

export const MAX_MORNING_SEARCH_CALLS = 3;

export type MorningSearchLane = "lane_a_us_market" | "lane_b_macro_policy" | "lane_c_supplement";
export type MorningLaneSearchDiagnostics = {
  lane: MorningSearchLane;
  webSearchCallItemCount: number;
  actionTypes: string[];
  searchQueryCount: number;
};
export type MorningSearchBudget = {
  passed: boolean;
  laneApiCallCount: number;
  totalSearchQueryCount: number;
  reasons: string[];
};
export type CandidateLevel = "high" | "medium" | "low";
export type CandidateImportance = "major" | "standard" | "administrative";
export type CandidateCausalStrength = "none" | "qualified" | "strong";

export type MorningCandidate = {
  title: string;
  summary: string;
  publisher: string;
  source_url: string;
  supporting_source_urls: string[];
  timestamp: string;
  timestamp_precision: "date" | "datetime";
  material_type: ReportMaterialType;
  japan_relevance: string;
  japan_relevance_level: CandidateLevel;
  market_impact: CandidateLevel;
  importance_class: CandidateImportance;
  causal_claim_strength: CandidateCausalStrength;
  affected_sectors: string[];
  what_to_watch: string;
  lane: MorningSearchLane;
};

export type CheckedMorningCandidate = MorningCandidate & {
  source_verified: boolean;
  freshness: MaterialFreshness;
  causal_support_passed: boolean;
  content_allowed: boolean;
  publisher_key: string | null;
};

export type MorningCandidateDecision = {
  candidate: CheckedMorningCandidate;
  score: number;
  rank: number | null;
  selected: boolean;
  reasons: string[];
};

export type MorningCandidateSelection = {
  selected: CheckedMorningCandidate[];
  decisions: MorningCandidateDecision[];
  qualifiedCount: number;
  publisherCount: number;
  hasUsMarketOrSemiconductor: boolean;
};

export type MorningSupplementContext = {
  qualifiedCandidateCount: number;
  publishers: string[];
  categories: ReportMaterialType[];
  hasUsMarketOrSemiconductor: boolean;
  reasons: string[];
  missingPriorityCategories: ReportMaterialType[];
};

export function morningCandidateExtractionInstructions(
  lane: MorningSearchLane,
  supplementNeeds: string[] = [],
): string[] {
  const needsUsMarketSupplement = supplementNeeds.includes("US_MARKET_OR_SEMICONDUCTOR_SHORTAGE");
  const role = lane === "lane_a_us_market"
    ? "Lane A: 直近の米国通常取引セッション、米国株全体、半導体セクター、AI・ハイテク株、主要テック企業の決算・guidance、日本株へ波及しやすい米国市場材料だけを検索します。Fed・中央銀行・金利・政策講演は、AIやtechnologyへの言及があってもLane A候補にしません。検索結果に独立した検証可能材料が複数あれば、1件で止めず最大3件まで返します。"
    : lane === "lane_b_macro_policy"
    ? "Lane B: Fed、中央銀行・政策講演、米金利、主要経済指標、関税・政府政策、中国政策、地政学だけを検索します。講演内にAIやtechnologyへの言及があっても政策・マクロ材料として扱います。重要度や日本株への影響を候補生成時点で厳しく選別せず、検証可能なら最大3件まで返します。"
    : `Lane C: 不足補完を行います。優先理由は ${supplementNeeds.join(", ")}。${needsUsMarketSupplement ? "米国市場・半導体・AI/ハイテク株の実材料不足を最優先で補います。" : "publisher不足、有力候補不足を順に補います。"}既存publisherと異なる信頼できるpublisher、既存カテゴリと重複しない検証可能材料を優先し、必要なら国内の政策・重要IRも検索します。`;
  return [
    role,
    "候補の最終採否は決めません。検索結果内で事実として検証可能な材料を、各Laneの上限まで広めにcandidateへ含め、除外判断は後段コードへ任せます。",
    "弱い材料、administrative、low impact、weak Japan relevanceでも、事実として検証可能なら正しく分類してcandidateへ含めて構いません。",
    "候補数合わせの捏造は禁止です。candidatesを空配列にするのは、検索結果内に検証可能な候補が本当に存在しない場合だけです。",
  ];
}

function decisionIsQualified(decision: MorningCandidateDecision): boolean {
  return decision.reasons.every((reason) => reason === "SELECTED" || reason === "NOT_IN_TOP_THREE");
}

export function buildMorningSupplementContext(
  selection: MorningCandidateSelection,
  reasons: string[],
): MorningSupplementContext {
  const qualified = selection.decisions.filter(decisionIsQualified).map((decision) => decision.candidate);
  const publishers = Array.from(new Set(qualified.map((candidate) => candidate.publisher_key).filter(
    (publisher): publisher is string => Boolean(publisher),
  ))).sort();
  const categories = Array.from(new Set(qualified.map((candidate) => candidate.material_type))).sort();
  const priorityCategories: ReportMaterialType[] = [
    "market_session", "central_bank_policy", "economic_indicator", "corporate", "geopolitics",
  ];
  return {
    qualifiedCandidateCount: selection.qualifiedCount,
    publishers,
    categories,
    hasUsMarketOrSemiconductor: selection.hasUsMarketOrSemiconductor,
    reasons: [...reasons],
    missingPriorityCategories: priorityCategories.filter((category) => !categories.includes(category)),
  };
}

const REPORTING_DOMAINS = [
  "reuters.com", "bloomberg.com", "nikkei.com", "apnews.com", "finance.yahoo.com", "investing.com",
];

const ADMINISTRATIVE_PATTERN = /(?:予定表|公表予定|発表予定|スケジュール|カレンダー|日程|事務的|更新しました|掲載しました)/iu;
const CORRECTION_PATTERN = /(?:訂正|軽微な修正|正誤|erratum|correction)/iu;
const HIGH_IMPORTANCE_PATTERN = /(?:利上げ|利下げ|政策変更|FOMC|決算|上方修正|下方修正|業績修正|M&A|TOB|公開買付|自社株買|大型受注|関税|制裁|半導体|人工知能|\bAI\b|重大)/iu;
const US_MARKET_SESSION_PATTERN = /(?:米国株|米株|U\.?S\.?\s+(?:stocks?|equities)|S&P(?:\s*500)?|NASDAQ|Nasdaq|ナスダック|Dow|ダウ).{0,100}(?:市場|相場|指数|取引|終値|上昇|下落|反発|続伸|続落|market|session|close|stocks?|equities|rose|fell|gained|lost|rallied|slid)/iu;
const SEMICONDUCTOR_MARKET_PATTERN = /(?:半導体株|半導体セクター|半導体指数|SOX|semiconductor\s+(?:stocks?|sector|index)|chipmakers?)/iu;
const MAJOR_CHIPMAKER_PATTERN = /(?:NVIDIA|Nvidia|エヌビディア|AMD|Intel|インテル|Broadcom|ブロードコム)/u;
const EQUITY_EVENT_PATTERN = /(?:決算|業績|ガイダンス|guidance|earnings|results|revenue|profit|株価|株式|上昇|下落|急伸|急落|shares?|stocks?|rose|fell|rallied|slid)/iu;
const TECH_EQUITY_PATTERN = /(?:AI関連株|AI株|ハイテク株|テクノロジー株|AI\s+stocks?|high-tech\s+stocks?|tech(?:nology)?\s+stocks?)/iu;

export function inspectMorningWebSearchCalls(
  response: unknown,
  lane: MorningSearchLane,
): MorningLaneSearchDiagnostics {
  const output = typeof response === "object" && response !== null &&
      Array.isArray((response as { output?: unknown }).output)
    ? (response as { output: unknown[] }).output
    : [];
  const webSearchItems = output.filter((item) =>
    typeof item === "object" && item !== null &&
    (item as { type?: unknown }).type === "web_search_call"
  );
  const actionTypes = webSearchItems.map((item) => {
    const action = (item as { action?: unknown }).action;
    if (typeof action !== "object" || action === null) return "unknown";
    const type = (action as { type?: unknown }).type;
    return typeof type === "string" ? type : "unknown";
  });
  return {
    lane,
    webSearchCallItemCount: webSearchItems.length,
    actionTypes,
    searchQueryCount: actionTypes.filter((type) => type === "search").length,
  };
}

export function evaluateMorningSearchBudget(
  lanes: MorningLaneSearchDiagnostics[],
): MorningSearchBudget {
  const reasons: string[] = [];
  if (lanes.length > MAX_MORNING_SEARCH_CALLS) reasons.push("LANE_API_CALL_LIMIT_EXCEEDED");
  for (const lane of lanes) {
    if (lane.searchQueryCount > 1) reasons.push(`LANE_SEARCH_QUERY_LIMIT_EXCEEDED:${lane.lane}`);
  }
  const totalSearchQueryCount = lanes.reduce((sum, lane) => sum + lane.searchQueryCount, 0);
  if (totalSearchQueryCount > MAX_MORNING_SEARCH_CALLS) reasons.push("TOTAL_SEARCH_QUERY_LIMIT_EXCEEDED");
  return {
    passed: reasons.length === 0,
    laneApiCallCount: lanes.length,
    totalSearchQueryCount,
    reasons,
  };
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return value.trim();
  }
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function sourceReliabilityScore(url: string): number {
  const key = publisherKey(url, REPORTING_DOMAINS);
  return key ? 8 : 10;
}

function weakMaterialReason(candidate: CheckedMorningCandidate): string | null {
  const text = `${candidate.title}\n${candidate.summary}`;
  const explicitlyImportant = candidate.importance_class === "major" && candidate.market_impact === "high";
  if (candidate.importance_class === "administrative" && !explicitlyImportant) return "ADMINISTRATIVE_MATERIAL";
  if (ADMINISTRATIVE_PATTERN.test(text) && !explicitlyImportant) return "SCHEDULE_OR_ADMINISTRATIVE_UPDATE";
  if (CORRECTION_PATTERN.test(text) && !explicitlyImportant && !HIGH_IMPORTANCE_PATTERN.test(text)) {
    return "MINOR_CORRECTION";
  }
  if (candidate.japan_relevance_level === "low" || candidate.market_impact === "low") {
    return "INSUFFICIENT_MARKET_RELEVANCE";
  }
  return null;
}

export function scoreMorningCandidate(candidate: CheckedMorningCandidate): number {
  const level = { high: 32, medium: 16, low: -20 } as const;
  const importance = { major: 30, standard: 12, administrative: -35 } as const;
  const material: Record<ReportMaterialType, number> = {
    market_session: 24,
    central_bank_policy: 20,
    economic_indicator: 16,
    corporate: 20,
    geopolitics: 16,
    realtime_market: 12,
    other: 2,
  };
  const text = `${candidate.title}\n${candidate.summary}`;
  return level[candidate.market_impact] + level[candidate.japan_relevance_level] +
    importance[candidate.importance_class] + material[candidate.material_type] +
    sourceReliabilityScore(candidate.source_url) + (candidate.timestamp_precision === "datetime" ? 2 : 0) +
    (HIGH_IMPORTANCE_PATTERN.test(text) ? 12 : 0) +
    (candidate.lane === "lane_a_us_market" ? 8 : candidate.lane === "lane_b_macro_policy" ? 5 : 3);
}

export function isUsMarketOrSemiconductorCandidate(candidate: MorningCandidate): boolean {
  if (candidate.material_type === "central_bank_policy" || candidate.material_type === "economic_indicator") {
    return false;
  }
  if (candidate.material_type === "market_session") return true;
  const text = `${candidate.title}\n${candidate.summary}`;
  if (US_MARKET_SESSION_PATTERN.test(text) || SEMICONDUCTOR_MARKET_PATTERN.test(text)) return true;
  if (MAJOR_CHIPMAKER_PATTERN.test(text) && EQUITY_EVENT_PATTERN.test(text)) return true;
  return TECH_EQUITY_PATTERN.test(text) && EQUITY_EVENT_PATTERN.test(text);
}

export function selectMorningCandidates(
  candidates: CheckedMorningCandidate[],
  trustedPublisherDomains: readonly string[],
  limit = 3,
): MorningCandidateSelection {
  const preliminary = candidates.map((candidate) => {
    const reasons: string[] = [];
    if (!candidate.source_verified || !candidate.publisher_key) reasons.push("SOURCE_NOT_VERIFIED");
    if (candidate.freshness !== "usable") reasons.push(`FRESHNESS_${candidate.freshness.toUpperCase()}`);
    if (!candidate.causal_support_passed) reasons.push("CAUSAL_SUPPORT_INSUFFICIENT");
    if (!candidate.content_allowed) reasons.push("UNAVAILABLE_MARKET_DATA_MENTION");
    const weakReason = weakMaterialReason(candidate);
    if (weakReason) reasons.push(weakReason);
    return { candidate, score: scoreMorningCandidate(candidate), rank: null, selected: false, reasons };
  });

  const sorted = preliminary.slice().sort((left, right) =>
    right.score - left.score || left.candidate.title.localeCompare(right.candidate.title, "ja")
  );
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const qualified: MorningCandidateDecision[] = [];
  for (const decision of sorted) {
    if (decision.reasons.length) continue;
    const urlKey = canonicalUrl(decision.candidate.source_url);
    const titleKey = normalizedTitle(decision.candidate.title);
    if (seenUrls.has(urlKey) || seenTitles.has(titleKey)) {
      decision.reasons.push("DUPLICATE_CANDIDATE");
      continue;
    }
    seenUrls.add(urlKey);
    seenTitles.add(titleKey);
    qualified.push(decision);
  }

  const selectedDecisions: MorningCandidateDecision[] = [];
  const selectedPublishers = new Set<string>();
  const selectedCategories = new Set<ReportMaterialType>();
  while (selectedDecisions.length < limit && qualified.length > selectedDecisions.length) {
    const remaining = qualified.filter((decision) => !selectedDecisions.includes(decision));
    remaining.sort((left, right) => {
      const adjusted = (decision: MorningCandidateDecision) => decision.score +
        (!selectedPublishers.has(decision.candidate.publisher_key ?? "") ? 15 : 0) +
        (!selectedCategories.has(decision.candidate.material_type) ? 7 : 0);
      return adjusted(right) - adjusted(left) || right.score - left.score ||
        left.candidate.title.localeCompare(right.candidate.title, "ja");
    });
    const chosen = remaining[0];
    if (!chosen) break;
    selectedDecisions.push(chosen);
    if (chosen.candidate.publisher_key) selectedPublishers.add(chosen.candidate.publisher_key);
    selectedCategories.add(chosen.candidate.material_type);
  }

  selectedDecisions.forEach((decision, index) => {
    decision.selected = true;
    decision.rank = index + 1;
    decision.reasons.push("SELECTED");
  });
  for (const decision of preliminary) {
    if (!decision.selected && decision.reasons.length === 0) decision.reasons.push("NOT_IN_TOP_THREE");
  }
  const selected = selectedDecisions.map((decision) => decision.candidate);
  return {
    selected,
    decisions: preliminary,
    qualifiedCount: qualified.length,
    publisherCount: independentPublisherCount(selected.map((candidate) => candidate.source_url), trustedPublisherDomains),
    hasUsMarketOrSemiconductor: qualified.some((decision) => isUsMarketOrSemiconductorCandidate(decision.candidate)),
  };
}

export function supplementReasons(
  selection: MorningCandidateSelection,
  laneApiCallsUsed: number,
): string[] {
  if (laneApiCallsUsed >= MAX_MORNING_SEARCH_CALLS) return [];
  const reasons: string[] = [];
  if (!selection.hasUsMarketOrSemiconductor) reasons.push("US_MARKET_OR_SEMICONDUCTOR_SHORTAGE");
  if (selection.publisherCount < 2) reasons.push("PUBLISHER_SHORTAGE");
  if (selection.qualifiedCount < 3) reasons.push("QUALIFIED_CANDIDATE_SHORTAGE");
  return reasons;
}

export function capCandidatePool<T>(candidates: T[], max = 8): T[] {
  return candidates.slice(0, max);
}
