import { estimateCostUsd, usageFromResponse } from "./usage_ledger.ts";
import {
  IMPORTANT_NEWS_CATEGORIES,
  isImportantNewsCategory,
  type ImportantNewsCategory,
  type IncomingNewsCandidate,
} from "./news_candidate_logic.ts";

// breaking_market lane (P0.5): fills the gaps official RSS (market_macro, P0) cannot — fast-moving
// breaking news (war, tariff/sanction announcements, bank failures) and official macro releases that
// have no working public RSS (US CPI/payrolls, MOF FX intervention, semiconductor export controls; see
// the P0.5 report for which official sources were checked and found to have none). Uses OpenAI's
// Responses API web_search tool, the same mechanism already proven in x-test-post's morning report.
//
// Hard cost/safety rules, non-negotiable at this layer:
// 1. At most MAX_BREAKING_MARKET_SEARCHES_PER_FETCH queries run per fetch cycle (selectBreakingMarketQueriesForCycle
//    enforces this by construction — it can never return more than that many entries).
// 2. A candidate is discarded unless its source_url is one the web_search tool actually visited (present
//    in web_search_call.action.sources on the raw response) — never trust a model-claimed URL on its own.
// 3. A candidate is discarded unless the source host is in BREAKING_MARKET_SOURCE_DOMAINS.
// 4. A candidate is discarded unless its article and, when supplied, event timestamps fall inside the
//    freshness window. The critical query additionally requires an exact event timestamp so a fresh
//    follow-up article cannot re-surface an old scheduled release as breaking news.

export type BreakingMarketQuery = {
  key: string;
  searchQuery: string;
  defaultCategory: ImportantNewsCategory;
  defaultTopicKey: string;
  requireEventTimestamp?: boolean;
  /** Per-topic article/event freshness. The default remains the strict three-hour breaking-news window. */
  maxItemAgeMs?: number;
  /** This query must return a newly reported update to an ongoing event, not an old recap. */
  followUpOnly?: boolean;
  /**
   * "fixed" topics run in every cycle; "rotating" topics share the remaining
   * slot. Phase 2 promotes the two topics whose events are only useful within
   * the hour (Japan security, disaster) to fixed slots, because a rotation of
   * eight topics would leave them unwatched for up to 160 minutes.
   */
  slot?: "fixed" | "rotating";
};

export const CRITICAL_BREAKING_MARKET_QUERY_KEY = "critical_market_events";

export const BREAKING_MARKET_QUERIES: BreakingMarketQuery[] = [
  {
    key: CRITICAL_BREAKING_MARKET_QUERY_KEY,
    // One fixed slot every 20-minute cycle. Keeping the highest-impact scheduled releases, emergency
    // policy actions, and live market shocks together prevents any one of them waiting an hour for a
    // six-query rotation while preserving the existing two-search cost ceiling.
    searchQuery:
      "breaking today US jobs payrolls employment report CPI inflation release emergency BOJ Fed rate decision Ministry of Finance FX intervention USDJPY Nikkei futures NASDAQ SOX crude oil surge plunge crash",
    defaultCategory: "other_market_moving",
    defaultTopicKey: "breaking:critical_market_events",
    requireEventTimestamp: true,
  },
  {
    key: "trump_tariff_semiconductor",
    // Covers both the original tariff/export-control announcements AND the intersection of trade policy
    // with pressure on the Federal Reserve (e.g. "Trump threatens to halt trade with countries unless the
    // Fed cuts rates") — a real production coverage gap where trade-policy vocabulary alone missed
    // stories whose news hook was the Fed-pressure angle rather than tariffs/export-controls themselves.
    searchQuery:
      "Trump tariff trade policy sanctions China Japan semiconductor export controls Federal Reserve rate cut pressure threat to halt trade today",
    defaultCategory: "tariffs",
    defaultTopicKey: "breaking:trump_tariff",
  },
  {
    key: "war_geopolitics_taiwan",
    // Covers general war/ceasefire/Taiwan coverage AND the specific intersection of military conflict
    // with oil shipping/energy infrastructure (e.g. a strike on oil tankers near the Strait of Hormuz) —
    // a real production gap where general Middle East vocabulary missed a story whose market-impact hook
    // was disrupted oil transport, not the military conflict framing alone.
    searchQuery:
      "war ceasefire military conflict Taiwan Middle East Iran Israel Strait of Hormuz oil tanker maritime attack energy infrastructure CENTCOM breaking news today",
    defaultCategory: "geopolitics",
    defaultTopicKey: "breaking:conflict",
  },
  {
    key: "bank_china_stimulus",
    searchQuery: "bank collapse failure China stimulus package economic policy today",
    defaultCategory: "china_policy",
    defaultTopicKey: "breaking:bank_or_china_policy",
  },
  // --- Phase 2 (broad coverage) -------------------------------------------
  // The 2026-09-12 North Korean launch was never fetched: no topic mentioned
  // North Korea, missiles, J-Alert or Japan's EEZ, and no primary Japanese
  // security source was subscribed. A launch matters to Japanese equities only
  // within the hour, so this topic takes a fixed slot.
  {
    key: "japan_security_emergency",
    searchQuery:
      "North Korea missile launch ballistic projectile J-Alert Japan EEZ Sea of Japan Taiwan Strait military escalation incursion Japan Ministry of Defense breaking today",
    defaultCategory: "major_security_incident",
    defaultTopicKey: "breaking:japan_security",
    slot: "fixed",
  },
  // Earthquakes, tsunami and large infrastructure outages move insurers,
  // construction, utilities and supply chains, and were previously only
  // reachable by accident. Also a fixed slot: the market reaction is immediate.
  {
    key: "disaster_infrastructure",
    searchQuery:
      "major earthquake tsunami warning volcanic eruption typhoon evacuation Japan power grid blackout refinery plant shutdown infrastructure outage breaking today",
    defaultCategory: "disaster",
    defaultTopicKey: "breaking:disaster",
    slot: "fixed",
  },
  {
    key: "shipping_chokepoints",
    searchQuery:
      "Strait of Hormuz Suez Canal Red Sea Bab el-Mandeb Panama Canal closure blockade tanker attack seizure Gulf shipping container freight rates disruption today",
    defaultCategory: "geopolitics",
    defaultTopicKey: "breaking:chokepoint",
  },
  {
    key: "financial_system_infrastructure",
    searchQuery:
      "stock exchange outage trading halt clearing settlement failure bank run deposit insurance systemic risk cyber attack financial institution today",
    defaultCategory: "major_security_incident",
    defaultTopicKey: "breaking:financial_system",
  },
  {
    key: "commodities_energy_supply",
    searchQuery:
      "OPEC production cut crude oil supply disruption export ban LNG natural gas gold copper iron ore rare earth restriction price surge today",
    defaultCategory: "other_market_moving",
    defaultTopicKey: "breaking:commodities",
  },
  {
    key: "us_market_session",
    searchQuery:
      "Nasdaq S&P 500 Dow Jones selloff rally SOX semiconductor index Nvidia AI data center capex US Treasury yields today",
    defaultCategory: "other_market_moving",
    defaultTopicKey: "breaking:us_session",
  },
  {
    key: "japan_market_session",
    searchQuery:
      "Nikkei 225 Topix Tokyo stocks yen USDJPY Bank of Japan policy Japanese government economic package today",
    defaultCategory: "other_market_moving",
    defaultTopicKey: "breaking:japan_session",
  },
  {
    key: "market_event_followups",
    searchQuery:
      "new follow-up update published today ongoing market-moving event Saudi Arabia Aramco East-West oil pipeline repair restoration timeline 5-6 weeks outage duration supply volume shipping route vessel transit resumption sanctions policy change damage update financial system outage",
    defaultCategory: "other_market_moving",
    defaultTopicKey: "breaking:event_followup",
    maxItemAgeMs: 6 * 60 * 60 * 1000,
    followUpOnly: true,
  },
];

// Three fixed topics plus one rotating slot. Phase 5 adds one follow-up topic
// without increasing the per-cycle/per-hour search ceiling; the larger rotating
// set changes the worst-case revisit interval from 160 to 180 minutes.
export const MAX_BREAKING_MARKET_SEARCHES_PER_FETCH = 4;
export const BREAKING_MARKET_ROTATION_INTERVAL_MS = 20 * 60 * 1000;

export const BREAKING_MARKET_SOURCE_DOMAINS = [
  "reuters.com", "apnews.com", "bloomberg.com", "nikkei.com",
  "mof.go.jp", "boj.or.jp", "federalreserve.gov", "ustr.gov",
  "whitehouse.gov", "commerce.gov", "bis.doc.gov", "state.gov",
  "bls.gov", "bea.gov", "treasury.gov",
  // Verified real, resolvable .mil/.gov domains (DNS-confirmed, not guessed) for official US military
  // statements on strikes/incidents affecting oil shipping and energy infrastructure — e.g. CENTCOM's own
  // press releases on an attack on oil tankers. Being on this list only makes a candidate's source_url
  // eligible; every other gate (actual-visited-URL check, https, freshness, category) still applies
  // exactly as before — a .mil/.gov domain is never trusted on domain alone.
  "centcom.mil", "defense.gov",
  // Phase 2: Japanese primary sources for security, disaster and market
  // infrastructure events. Their own RSS/HTML endpoints are not subscribable
  // (mod.go.jp returns 403 to a plain request, jpx.co.jp / kantei.go.jp / mof.go.jp
  // return 404 for the documented feed paths), so these hosts reach the pipeline
  // as web_search results instead. Being listed only makes a source_url eligible;
  // the actual-visited-URL, https, freshness and category gates all still apply.
  "jma.go.jp", "mod.go.jp", "kantei.go.jp", "jpx.co.jp", "fdma.go.jp", "nhk.or.jp",
];

export const MAX_BREAKING_MARKET_ITEM_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_BREAKING_MARKET_FUTURE_SKEW_MS = 60 * 60 * 1000;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
// Temporarily held on GPT-5.6 Luna (recall first). After the 2026-09-23 switch, gpt-6-luna returned an
// empty candidates array for all 152 production queries, including runs where the search itself
// surfaced 16-23 allowed-domain sources (search + open_page) and the response parsed cleanly: the model
// declines the sources under this prompt ("only URLs actually opened"), while gpt-5.6-luna produced
// candidates from the same prompt. Re-enable GPT-6 only after it yields candidates on this request body
// (breakingMarketRequestBody makes a same-request comparison possible).
const MODEL = "gpt-5.6-luna" as const;
const BREAKING_MARKET_REQUEST_TIMEOUT_MS = 60_000;

/** The critical topic is always fixed; Phase 2 topics may declare slot: "fixed" too. */
export function isFixedBreakingMarketQuery(query: BreakingMarketQuery): boolean {
  return query.key === CRITICAL_BREAKING_MARKET_QUERY_KEY || query.slot === "fixed";
}

// The fixed queries run in every cycle and the remaining slots rotate. maxPerCycle is still the hard
// ceiling: with more fixed topics than slots the extra fixed topics are dropped (in declaration order)
// rather than exceeding the search budget.
//
// Rotation is least-recently-searched when the caller supplies lastSearchedAt (query key -> epoch ms of
// its latest attempt, from recent run diagnostics). A wall-clock index only visits every topic when the
// fetch cadence is exactly one ROTATION_INTERVAL: at the hourly/2-hourly cadence the index advanced by 3
// or 6 per run, and with 9 rotating topics only 3 of them were ever selected. The history-based order
// does not depend on the cadence or on the number of topics. Without history (first run, or the history
// read failed) the stateless wall-clock index remains the fallback.
export function selectBreakingMarketQueriesForCycle(
  queries: BreakingMarketQuery[],
  now: Date = new Date(),
  maxPerCycle: number = MAX_BREAKING_MARKET_SEARCHES_PER_FETCH,
  lastSearchedAt: ReadonlyMap<string, number> | null = null,
): BreakingMarketQuery[] {
  if (queries.length === 0 || !Number.isInteger(maxPerCycle) || maxPerCycle < 1) return [];
  const cycleIndex = Math.floor(now.getTime() / BREAKING_MARKET_ROTATION_INTERVAL_MS);
  const fixed = queries.filter(isFixedBreakingMarketQuery);
  const rotating = queries.filter((query) => !isFixedBreakingMarketQuery(query));
  if (fixed.length === 0) {
    if (lastSearchedAt) return leastRecentlySearched(queries, lastSearchedAt, maxPerCycle);
    const start = (cycleIndex * maxPerCycle) % queries.length;
    return Array.from({ length: Math.min(maxPerCycle, queries.length) }, (_, offset) =>
      queries[(start + offset) % queries.length]
    );
  }
  const selected = fixed.slice(0, maxPerCycle);
  const rotatingSlots = Math.min(maxPerCycle - selected.length, rotating.length);
  if (lastSearchedAt) return [...selected, ...leastRecentlySearched(rotating, lastSearchedAt, rotatingSlots)];
  for (let offset = 0; offset < rotatingSlots; offset += 1) {
    selected.push(rotating[(cycleIndex * rotatingSlots + offset) % rotating.length]);
  }
  return selected;
}

/** Never-searched topics first, then the oldest attempt; ties keep declaration order. */
function leastRecentlySearched(
  queries: BreakingMarketQuery[],
  lastSearchedAt: ReadonlyMap<string, number>,
  count: number,
): BreakingMarketQuery[] {
  return queries
    .map((query, order) => ({ query, order, at: lastSearchedAt.get(query.key) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .slice(0, Math.max(0, count))
    .map((item) => item.query);
}

/**
 * Latest attempt per query key from important_news_monitor_runs rows shaped
 * `{ started_at, queries: diagnostics->breakingMarket->queries }`. Malformed rows are skipped.
 */
export function breakingMarketLastSearchedAt(rows: unknown): Map<string, number> {
  const latest = new Map<string, number>();
  if (!Array.isArray(rows)) return latest;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as { started_at?: unknown; queries?: unknown };
    const at = typeof record.started_at === "string" ? Date.parse(record.started_at) : NaN;
    if (!Number.isFinite(at) || !Array.isArray(record.queries)) continue;
    for (const item of record.queries) {
      const key = typeof item === "object" && item !== null ? (item as { queryKey?: unknown }).queryKey : null;
      if (typeof key !== "string") continue;
      if (at > (latest.get(key) ?? Number.NEGATIVE_INFINITY)) latest.set(key, at);
    }
  }
  return latest;
}

/** How long a rotating topic can go unwatched, in minutes — stated so the cost/latency trade-off is explicit. */
export function maxUnwatchedMinutes(
  queries: BreakingMarketQuery[] = BREAKING_MARKET_QUERIES,
  maxPerCycle: number = MAX_BREAKING_MARKET_SEARCHES_PER_FETCH,
): number {
  const fixedCount = Math.min(queries.filter(isFixedBreakingMarketQuery).length, maxPerCycle);
  const rotating = queries.filter((query) => !isFixedBreakingMarketQuery(query)).length;
  const rotatingSlots = Math.max(0, maxPerCycle - fixedCount);
  if (rotating === 0) return 0;
  if (rotatingSlots === 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(rotating / rotatingSlots) * (BREAKING_MARKET_ROTATION_INTERVAL_MS / 60_000);
}

export function isFreshBreakingMarketPublishedAt(
  publishedAtIso: string,
  now: Date,
  maxAgeMs: number = MAX_BREAKING_MARKET_ITEM_AGE_MS,
): boolean {
  const parsed = Date.parse(publishedAtIso);
  if (!Number.isFinite(parsed)) return false;
  const delta = now.getTime() - parsed;
  return delta <= maxAgeMs && delta >= -MAX_BREAKING_MARKET_FUTURE_SKEW_MS;
}

function isAllowedBreakingMarketUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return BREAKING_MARKET_SOURCE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function canonicalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

// Walks the raw Responses API payload for every "url" string the web_search tool itself recorded as
// visited (web_search_call.action.sources), restricted to the allowed domains. This is the only source
// of truth for "was this URL actually looked at" — a candidate's own claimed source_url is never trusted
// on its own (see collectBreakingMarketCandidates below).
export function collectBreakingMarketSourceUrls(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectBreakingMarketSourceUrls(item, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "url" && typeof child === "string" && isAllowedBreakingMarketUrl(child)) {
        found.add(child);
      } else {
        collectBreakingMarketSourceUrls(child, found);
      }
    }
  }
  return found;
}

export function countBreakingMarketWebSearchCalls(response: unknown): number {
  if (typeof response !== "object" || response === null) return 0;
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return 0;
  return output.filter((item) =>
    typeof item === "object" && item !== null && (item as { type?: unknown }).type === "web_search_call"
  ).length;
}

/**
 * What the web_search tool actually did and returned, independent of the model's answer: action types
 * (search / open_page / find_in_page) and how many source URLs it surfaced, in total and on the allowed
 * domains. An empty candidates array with zero allowed sources means the search returned nothing usable;
 * with sources present it means the model declined them.
 */
export const BREAKING_MARKET_SOURCE_SAMPLE_LIMIT = 5;
const SOURCE_SAMPLE_URL_MAX = 300;
const SOURCE_SAMPLE_TITLE_MAX = 160;
const SEARCH_QUERY_MAX = 200;

/**
 * Observability only: metadata of a web_search source, never its content. publishedAt is whatever
 * date the tool itself attached to the source (null when it attached none); urlDate is a YYYY-MM-DD
 * read from the URL path (e.g. reuters.com/.../2026-09-25/), so an undated source can still be aged.
 */
export type BreakingMarketSourceSample = {
  url: string | null;
  domain: string | null;
  title: string | null;
  publishedAt: string | null;
  urlDate: string | null;
  opened: boolean;
};

function clip(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function urlDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function urlDate(url: string | null): string | null {
  const path = (() => {
    try {
      return url ? new URL(url).pathname : "";
    } catch {
      return "";
    }
  })();
  const found = path.match(/(20\d{2})[-/](\d{2})[-/](\d{2})(?![\d])/);
  return found ? `${found[1]}-${found[2]}-${found[3]}` : null;
}

function sourceDate(source: Record<string, unknown>): string | null {
  for (const key of ["published_at", "publishedAt", "published_date", "date", "last_updated"]) {
    const value = clip(source[key], 40);
    if (value) return value;
  }
  return null;
}

/**
 * What the web_search tool actually did and returned, independent of the model's answer: action types
 * (search / open_page / find_in_page), how many source URLs it surfaced (total and on the allowed
 * domains), the first BREAKING_MARKET_SOURCE_SAMPLE_LIMIT sources in the tool's own order, the pages it
 * opened, and the search strings the model issued. An empty candidates array with zero allowed sources
 * means the search returned nothing usable; with sources present it means the model declined them.
 */
export function summarizeBreakingMarketWebSearch(response: unknown): {
  actions: Record<string, number>;
  sourceCount: number;
  allowedSourceCount: number;
  sourcesSample: BreakingMarketSourceSample[];
  openedUrls: string[];
  searchQueries: string[];
} {
  const actions: Record<string, number> = {};
  let sourceCount = 0;
  const sources: Record<string, unknown>[] = [];
  const openedUrls: string[] = [];
  const searchQueries: string[] = [];
  const output = typeof response === "object" && response !== null
    ? (response as { output?: unknown }).output
    : null;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item !== "object" || item === null) continue;
      if ((item as { type?: unknown }).type !== "web_search_call") continue;
      const action = (item as { action?: unknown }).action;
      const record = typeof action === "object" && action !== null ? action as Record<string, unknown> : {};
      const type = typeof record.type === "string" ? record.type : "unknown";
      actions[type] = (actions[type] ?? 0) + 1;
      if (Array.isArray(record.sources)) {
        sourceCount += record.sources.length;
        for (const source of record.sources) {
          sources.push(typeof source === "object" && source !== null ? source as Record<string, unknown> : {});
        }
      }
      const opened = type === "open_page" ? clip(record.url, SOURCE_SAMPLE_URL_MAX) : null;
      if (opened && !openedUrls.includes(opened)) openedUrls.push(opened);
      for (const query of [record.query, ...(Array.isArray(record.queries) ? record.queries : [])]) {
        const text = clip(query, SEARCH_QUERY_MAX);
        if (text && !searchQueries.includes(text)) searchQueries.push(text);
      }
    }
  }
  const sourcesSample = sources.slice(0, BREAKING_MARKET_SOURCE_SAMPLE_LIMIT).map((source) => {
    const url = clip(source.url, SOURCE_SAMPLE_URL_MAX);
    return {
      url,
      domain: urlDomain(url),
      title: clip(source.title, SOURCE_SAMPLE_TITLE_MAX),
      publishedAt: sourceDate(source),
      urlDate: urlDate(url),
      opened: url !== null && openedUrls.includes(url),
    };
  });
  return {
    actions,
    sourceCount,
    allowedSourceCount: collectBreakingMarketSourceUrls(response).size,
    sourcesSample,
    openedUrls: openedUrls.slice(0, 3),
    searchQueries: searchQueries.slice(0, 3),
  };
}

type RawBreakingMarketCandidate = {
  title: string;
  summary: string | null;
  source_url: string;
  published_at: string;
  event_at?: string | null;
  category: string;
};

export const BREAKING_MARKET_REJECTION_REASONS = [
  "invalid_candidate_shape", "empty_title", "invalid_url", "non_https", "disallowed_domain", "source_not_visited",
  "invalid_published_at", "stale_published_at", "missing_event_at", "invalid_event_at", "stale_event_at",
] as const;

export type BreakingMarketRejectionReason = typeof BREAKING_MARKET_REJECTION_REASONS[number];
export type BreakingMarketValidationDiagnostics = {
  rawCandidateCount: number;
  validatedCandidateCount: number;
  rejectionCounts: Record<BreakingMarketRejectionReason, number>;
};

export type BreakingMarketQueryDiagnostics = BreakingMarketValidationDiagnostics & {
  queryKey: string;
  query: string;
  providerStatus: "succeeded" | "failed";
  httpStatus: number | null;
  responseStatus: string | null;
  incompleteReason: string | null;
  webSearchCallCount: number;
  /** Billed tokens of the Responses API call (0 when no response body was received). */
  inputTokens: number;
  outputTokens: number;
  /** Tokens plus web_search tool calls at usage_ledger rates. */
  estimatedCostUsd: number;
  model: string;
  failureCode: string | null;
  /** web_search_call action types in the response (see summarizeBreakingMarketWebSearch). */
  webSearchActions?: Record<string, number>;
  /** Source URLs the search surfaced, in total and on BREAKING_MARKET_SOURCE_DOMAINS. */
  searchSourceCount?: number;
  allowedSourceCount?: number;
  /** Up to BREAKING_MARKET_SOURCE_SAMPLE_LIMIT source metadata rows, in the tool's order. */
  searchSourcesSample?: BreakingMarketSourceSample[];
  /** Pages the tool opened (open_page actions), at most 3. */
  openedUrls?: string[];
  /** Search strings the model issued (search actions), at most 3. */
  searchQueries?: string[];
};

export type BreakingMarketQueryResult = {
  candidates: IncomingNewsCandidate[];
  diagnostics: BreakingMarketQueryDiagnostics;
};

export class BreakingMarketQueryError extends Error {
  readonly diagnostics: BreakingMarketQueryDiagnostics;

  constructor(message: string, diagnostics: BreakingMarketQueryDiagnostics) {
    super(message);
    this.name = "BreakingMarketQueryError";
    this.diagnostics = diagnostics;
  }
}

function extractOutputText(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  const text = output.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const content = (item as { content?: unknown }).content;
    return Array.isArray(content) ? content : [];
  }).filter((item) =>
    typeof item === "object" && item !== null &&
    (item as { type?: unknown }).type === "output_text" &&
    typeof (item as { text?: unknown }).text === "string"
  ).map((item) => (item as { text: string }).text).join("").trim();
  return text || null;
}

function parseRawCandidates(value: unknown): {
  candidates: RawBreakingMarketCandidate[];
  rawCandidateCount: number;
  invalidCandidateShapeCount: number;
} {
  if (typeof value !== "object" || value === null) throw new Error("BREAKING_MARKET_INVALID_OUTPUT");
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) throw new Error("BREAKING_MARKET_INVALID_OUTPUT");
  let invalidCandidateShapeCount = 0;
  const parsedCandidates: RawBreakingMarketCandidate[] = [];
  for (const item of candidates) {
    if (typeof item !== "object" || item === null) {
      invalidCandidateShapeCount += 1;
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.title !== "string" || typeof record.source_url !== "string" ||
      typeof record.published_at !== "string" || typeof record.category !== "string") {
      invalidCandidateShapeCount += 1;
      continue;
    }
    parsedCandidates.push({
      title: record.title,
      summary: typeof record.summary === "string" ? record.summary : null,
      source_url: record.source_url,
      published_at: record.published_at,
      event_at: typeof record.event_at === "string" ? record.event_at : null,
      category: record.category,
    });
  }
  return {
    candidates: parsedCandidates,
    rawCandidateCount: candidates.length,
    invalidCandidateShapeCount,
  };
}

function emptyRejectionCounts(): Record<BreakingMarketRejectionReason, number> {
  return Object.fromEntries(BREAKING_MARKET_REJECTION_REASONS.map((reason) => [reason, 0])) as
    Record<BreakingMarketRejectionReason, number>;
}

function hasExactTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function breakingEventKind(item: RawBreakingMarketCandidate): string | null {
  const text = `${item.title}\n${item.summary ?? ""}`.normalize("NFKC").toLowerCase();
  if (/nonfarm payroll|payrolls|jobs report|employment situation/.test(text)) return "us_payrolls";
  if (/\bcpi\b|consumer price index/.test(text)) return "us_cpi";
  if (/(ministry of finance|\bmof\b|財務省).*(interven|介入)|(interven|介入).*(yen|円|currency|為替)/.test(text)) {
    return "mof_fx_intervention";
  }
  if (/(bank of japan|\bboj\b|日銀).*(rate|policy|利上げ|利下げ|金融政策|緊急)/.test(text)) return "boj_policy";
  if (/(federal reserve|\bfed\b|\bfomc\b).*(rate|policy|cut|hike|金利|金融政策|緊急)/.test(text)) {
    return "fed_policy";
  }
  if (/usdjpy|dollar.?yen|ドル.?円|\byen\b/.test(text)) return "market_usdjpy";
  if (/nikkei futures|日経.*先物/.test(text)) return "market_nikkei_futures";
  if (/\bnasdaq\b/.test(text)) return "market_nasdaq";
  if (/\bsox\b|semiconductor index/.test(text)) return "market_sox";
  if (/crude oil|\boil\b|原油/.test(text)) return "market_oil";
  if (/semiconductor|chip/.test(text) && /export control|restriction|輸出規制/.test(text)) {
    return "semiconductor_export_controls";
  }
  if (/tariff|関税/.test(text)) return "tariff";
  if (/ceasefire|truce|停戦/.test(text)) return "ceasefire";
  if (/bank/.test(text) && /fail|collapse|破綻/.test(text)) return "bank_failure";
  return null;
}

function breakingEntityKey(
  query: BreakingMarketQuery,
  item: RawBreakingMarketCandidate,
  eventAt: string | null,
): string {
  const kind = breakingEventKind(item);
  if (!kind || !eventAt) return query.defaultTopicKey;
  const eventMinute = `${eventAt.slice(0, 16)}Z`;
  return `breaking:event:${kind}:${eventMinute}`;
}

// Turns validated raw model output into IncomingNewsCandidate[], applying every safety gate: the
// source_url must be one the tool actually visited (actualSourceUrls, canonicalized), must be on the
// allowed-domain list, must parse to a valid https URL, must be within the freshness window, and the
// category must be one of the declared enum values (falls back to the query's default otherwise).
export function collectBreakingMarketCandidates(
  query: BreakingMarketQuery,
  raw: RawBreakingMarketCandidate[],
  actualSourceUrls: Set<string>,
  now: Date = new Date(),
): IncomingNewsCandidate[] {
  return collectBreakingMarketCandidatesWithDiagnostics(query, raw, actualSourceUrls, now).candidates;
}

export function collectBreakingMarketCandidatesWithDiagnostics(
  query: BreakingMarketQuery,
  raw: RawBreakingMarketCandidate[],
  actualSourceUrls: Set<string>,
  now: Date = new Date(),
): { candidates: IncomingNewsCandidate[]; diagnostics: BreakingMarketValidationDiagnostics } {
  const actualCanonical = new Set(
    Array.from(actualSourceUrls).map(canonicalizeUrl).filter((url): url is string => url !== null),
  );
  const results: IncomingNewsCandidate[] = [];
  const rejectionCounts = emptyRejectionCounts();
  const reject = (reason: BreakingMarketRejectionReason) => {
    rejectionCounts[reason] += 1;
  };
  for (const item of raw) {
    const title = item.title.trim();
    if (!title) { reject("empty_title"); continue; }
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(item.source_url);
    } catch {
      reject("invalid_url");
      continue;
    }
    if (sourceUrl.protocol !== "https:") { reject("non_https"); continue; }
    if (!isAllowedBreakingMarketUrl(item.source_url)) { reject("disallowed_domain"); continue; }
    const canonical = canonicalizeUrl(item.source_url);
    if (!canonical || !actualCanonical.has(canonical)) { reject("source_not_visited"); continue; }
    if (!Number.isFinite(Date.parse(item.published_at))) { reject("invalid_published_at"); continue; }
    const publishedAt = new Date(item.published_at).toISOString();
    const maxItemAgeMs = query.maxItemAgeMs ?? MAX_BREAKING_MARKET_ITEM_AGE_MS;
    if (!isFreshBreakingMarketPublishedAt(publishedAt, now, maxItemAgeMs)) { reject("stale_published_at"); continue; }
    const rawEventAt = item.event_at?.trim() || null;
    if ((query.requireEventTimestamp || query.followUpOnly) && !rawEventAt) { reject("missing_event_at"); continue; }
    if (rawEventAt && !hasExactTimestamp(rawEventAt)) { reject("invalid_event_at"); continue; }
    const eventAt = rawEventAt ? new Date(rawEventAt).toISOString() : null;
    if (eventAt && !isFreshBreakingMarketPublishedAt(eventAt, now, maxItemAgeMs)) { reject("stale_event_at"); continue; }
    const category = isImportantNewsCategory(item.category) ? item.category : query.defaultCategory;
    results.push({
      sourceType: "breaking_market",
      sourceName: "breaking_market",
      sourceUrl: item.source_url,
      title,
      bodySummary: item.summary?.trim() || null,
      companyName: null,
      companyCode: null,
      entityKey: breakingEntityKey(query, item, eventAt),
      category,
      publishedAt,
    });
  }
  return {
    candidates: results,
    diagnostics: {
      rawCandidateCount: raw.length,
      validatedCandidateCount: results.length,
      rejectionCounts,
    },
  };
}

function diagnosticBase(query: BreakingMarketQuery): BreakingMarketQueryDiagnostics {
  return {
    queryKey: query.key,
    query: query.searchQuery,
    providerStatus: "failed",
    httpStatus: null,
    responseStatus: null,
    incompleteReason: null,
    webSearchCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    model: MODEL,
    rawCandidateCount: 0,
    validatedCandidateCount: 0,
    rejectionCounts: emptyRejectionCounts(),
    failureCode: null,
  };
}

/** The Responses API request for one breaking_market query. Exported so a model comparison can send
 * byte-identical instructions/schema with only the model changed. */
export function breakingMarketRequestBody(
  query: BreakingMarketQuery,
  now: Date,
  model: string = MODEL,
): Record<string, unknown> {
  return {
    model,
    store: false,
    reasoning: { effort: "low" },
    max_output_tokens: 1200,
    max_tool_calls: 1,
    tools: [{
      type: "web_search",
      filters: { allowed_domains: BREAKING_MARKET_SOURCE_DOMAINS },
      search_context_size: "low",
    }],
    tool_choice: "required",
    include: ["web_search_call.action.sources"],
    instructions: [
      "あなたは市場に影響しうる速報ニュース収集の担当です。1回だけ検索し、投稿文ではなく候補JSONを返します。推測や捏造は禁止です。",
      query.followUpOnly
        ? "許可ドメインで実際に確認できた、直近6時間以内に新たに公表された『進行中事象の具体的な続報』だけを候補にします。復旧見通し、停止期間、供給量、航行再開、被害更新、追加制裁、政策変更など新しい情報が必要です。元の事象が古くても、今回の更新自体が直近6時間以内なら対象です。過去記事の再掲、初報、分析、単なる現状まとめは除外します。記事は6時間以内に公開されている必要があります。該当がなければcandidatesは空配列にします。"
        : "許可ドメインの検索結果で実際に確認できた、直近3時間以内に発生・発表され、記事も直近3時間以内に公開された材料だけを候補にします。該当がなければcandidatesは空配列にします。",
      "candidatesは最大3件。各候補にはtitle、summary（1-2文の事実要約）、source_url（実際に開いた許可ドメインのURL）、published_at（記事公開日時、時刻付きISO 8601）、event_at（実際の発生・公表日時、確認できない場合null）、categoryを含めます。",
      query.requireEventTimestamp
        ? "この検索枠ではevent_atをsource_urlで時刻まで確認できる候補だけを返します。event_at不明、日付だけ、過去イベントの後追い記事は候補にしません。"
        : query.followUpOnly
        ? "event_atは報告対象となる今回の続報・復旧見通し等が公表された具体的時刻（元の危機発生日ではない）を確認して必ず時刻付きISO 8601で返します。今回の更新時刻を確認できない候補は除外します。記事公開時刻も必須です。"
        : "event_atが確認できる場合は必ず時刻付きISO 8601で返します。過去イベントの後追い記事を新しい速報として返しません。",
      "categoryは次のいずれかから最も近いものを選びます: " + IMPORTANT_NEWS_CATEGORIES.join(", "),
      "未確定・予定・観測記事・分析記事ではなく、既に発生・発表が確認された事実だけを対象にします。日本株や世界市場への影響が具体的に見込まれない軽微な話題は候補にしません。",
      "source_urlが無い、または検索結果で実際に開いていないURLを候補にしません。APIキーや秘密値は返しません。",
    ].join("\n"),
    input: `search topic: ${query.searchQuery}\nreference UTC: ${now.toISOString()}`,
    text: { format: { type: "json_schema", name: "breaking_market_candidates", strict: true, schema: {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          minItems: 0,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              source_url: { type: "string" },
              published_at: { type: "string" },
              event_at: { type: ["string", "null"] },
              category: { type: "string", enum: IMPORTANT_NEWS_CATEGORIES },
            },
            required: ["title", "summary", "source_url", "published_at", "event_at", "category"],
            additionalProperties: false,
          },
        },
      },
      required: ["candidates"],
      additionalProperties: false,
    } } },
  };
}

export async function fetchBreakingMarketQueryWithDiagnostics(
  openAiApiKey: string,
  query: BreakingMarketQuery,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<BreakingMarketQueryResult> {
  const diagnostics = diagnosticBase(query);
  let response: Response;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(BREAKING_MARKET_REQUEST_TIMEOUT_MS),
      body: JSON.stringify(breakingMarketRequestBody(query, now)),
    });
  } catch {
    const code = `BREAKING_MARKET_REQUEST_FAILED:${query.key}`;
    diagnostics.failureCode = code;
    throw new BreakingMarketQueryError(code, diagnostics);
  }
  diagnostics.httpStatus = response.status;
  if (!response.ok) {
    const code = `BREAKING_MARKET_SEARCH_FAILED:${query.key}:${response.status}`;
    diagnostics.failureCode = code;
    throw new BreakingMarketQueryError(code, diagnostics);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    const code = `BREAKING_MARKET_INVALID_RESPONSE:${query.key}`;
    diagnostics.failureCode = code;
    throw new BreakingMarketQueryError(code, diagnostics);
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as { status?: unknown; incomplete_details?: { reason?: unknown } };
    diagnostics.responseStatus = typeof record.status === "string" ? record.status : null;
    diagnostics.incompleteReason = typeof record.incomplete_details?.reason === "string"
      ? record.incomplete_details.reason : null;
  }
  diagnostics.webSearchCallCount = countBreakingMarketWebSearchCalls(raw);
  const search = summarizeBreakingMarketWebSearch(raw);
  diagnostics.webSearchActions = search.actions;
  diagnostics.searchSourceCount = search.sourceCount;
  diagnostics.allowedSourceCount = search.allowedSourceCount;
  diagnostics.searchSourcesSample = search.sourcesSample;
  diagnostics.openedUrls = search.openedUrls;
  diagnostics.searchQueries = search.searchQueries;
  // Recorded before any later failure: an incomplete or unparsable response is still billed.
  const usage = usageFromResponse(raw);
  diagnostics.inputTokens = usage.inputTokens;
  diagnostics.outputTokens = usage.outputTokens;
  diagnostics.estimatedCostUsd = estimateCostUsd(MODEL, usage.inputTokens, usage.outputTokens, diagnostics.webSearchCallCount);
  if (diagnostics.responseStatus === "incomplete") {
    const code = `BREAKING_MARKET_INCOMPLETE:${query.key}:${diagnostics.incompleteReason ?? "unknown"}`;
    diagnostics.failureCode = code;
    throw new BreakingMarketQueryError(code, diagnostics);
  }
  const output = extractOutputText(raw);
  if (!output) {
    const code = `BREAKING_MARKET_EMPTY_OUTPUT:${query.key}`;
    diagnostics.failureCode = code;
    throw new BreakingMarketQueryError(code, diagnostics);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch {
    const code = `BREAKING_MARKET_INVALID_OUTPUT:${query.key}`;
    diagnostics.failureCode = code;
    throw new BreakingMarketQueryError(code, diagnostics);
  }
  let parsedCandidates: ReturnType<typeof parseRawCandidates>;
  try { parsedCandidates = parseRawCandidates(parsed); } catch {
    const code = `BREAKING_MARKET_INVALID_OUTPUT:${query.key}`;
    diagnostics.failureCode = code;
    throw new BreakingMarketQueryError(code, diagnostics);
  }
  const actualSourceUrls = collectBreakingMarketSourceUrls(raw);
  const collected = collectBreakingMarketCandidatesWithDiagnostics(
    query,
    parsedCandidates.candidates,
    actualSourceUrls,
    now,
  );
  collected.diagnostics.rawCandidateCount = parsedCandidates.rawCandidateCount;
  collected.diagnostics.rejectionCounts.invalid_candidate_shape += parsedCandidates.invalidCandidateShapeCount;
  Object.assign(diagnostics, collected.diagnostics, { providerStatus: "succeeded", failureCode: null });
  return { candidates: collected.candidates, diagnostics };
}

export async function fetchBreakingMarketQuery(
  openAiApiKey: string,
  query: BreakingMarketQuery,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<IncomingNewsCandidate[]> {
  return (await fetchBreakingMarketQueryWithDiagnostics(openAiApiKey, query, now, fetchImpl)).candidates;
}
