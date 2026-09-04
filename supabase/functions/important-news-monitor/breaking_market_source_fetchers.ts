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
// 4. A candidate is discarded unless its published_at falls inside the freshness window (24h default,
//    much tighter than market_macro's 14 days — breaking news that's already a day old is not breaking).

export type BreakingMarketQuery = {
  key: string;
  searchQuery: string;
  defaultCategory: ImportantNewsCategory;
  defaultTopicKey: string;
};

export const BREAKING_MARKET_QUERIES: BreakingMarketQuery[] = [
  {
    key: "trump_tariff_semiconductor",
    searchQuery: "Trump tariff sanctions China Japan semiconductor export controls announcement today",
    defaultCategory: "tariffs",
    defaultTopicKey: "breaking:trump_tariff",
  },
  {
    key: "war_geopolitics_taiwan",
    searchQuery: "war ceasefire military conflict Taiwan Middle East breaking news today",
    defaultCategory: "geopolitics",
    defaultTopicKey: "breaking:conflict",
  },
  {
    key: "fx_intervention_boj_fed_emergency",
    searchQuery: "Japan yen FX intervention Ministry of Finance emergency BOJ Fed rate decision today",
    defaultCategory: "fx",
    defaultTopicKey: "breaking:fx_intervention",
  },
  {
    key: "us_economic_data_surprise",
    searchQuery: "US CPI inflation jobs report payrolls surprise data today",
    defaultCategory: "us_government_policy",
    defaultTopicKey: "breaking:us_economic_data",
  },
  {
    key: "market_move_breaking",
    searchQuery: "USDJPY yen Nikkei futures NASDAQ SOX crude oil surge plunge crash today",
    defaultCategory: "other_market_moving",
    defaultTopicKey: "breaking:market_move",
  },
  {
    key: "bank_china_stimulus",
    searchQuery: "bank collapse failure China stimulus package economic policy today",
    defaultCategory: "china_policy",
    defaultTopicKey: "breaking:bank_or_china_policy",
  },
];

export const MAX_BREAKING_MARKET_SEARCHES_PER_FETCH = 2;
export const BREAKING_MARKET_ROTATION_INTERVAL_MS = 20 * 60 * 1000;

export const BREAKING_MARKET_SOURCE_DOMAINS = [
  "reuters.com", "apnews.com", "bloomberg.com", "nikkei.com",
  "mof.go.jp", "boj.or.jp", "federalreserve.gov", "ustr.gov",
  "whitehouse.gov", "commerce.gov", "bis.doc.gov", "state.gov",
  "bls.gov", "bea.gov", "treasury.gov",
];

const MAX_BREAKING_MARKET_ITEM_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BREAKING_MARKET_FUTURE_SKEW_MS = 60 * 60 * 1000;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-5.6-luna" as const;

// Deterministic, stateless rotation: which queries run this cycle depends only on the current time, so
// two concurrent/retried calls within the same 20-minute window pick the same queries (no drift, no DB
// state needed), and every query gets a turn roughly every ceil(queries.length / maxPerCycle) cycles.
export function selectBreakingMarketQueriesForCycle(
  queries: BreakingMarketQuery[],
  now: Date = new Date(),
  maxPerCycle: number = MAX_BREAKING_MARKET_SEARCHES_PER_FETCH,
): BreakingMarketQuery[] {
  if (queries.length === 0) return [];
  const cycleIndex = Math.floor(now.getTime() / BREAKING_MARKET_ROTATION_INTERVAL_MS);
  const start = (cycleIndex * maxPerCycle) % queries.length;
  const selected: BreakingMarketQuery[] = [];
  for (let offset = 0; offset < Math.min(maxPerCycle, queries.length); offset += 1) {
    selected.push(queries[(start + offset) % queries.length]);
  }
  return selected;
}

export function isFreshBreakingMarketPublishedAt(publishedAtIso: string, now: Date): boolean {
  const parsed = Date.parse(publishedAtIso);
  if (!Number.isFinite(parsed)) return false;
  const delta = now.getTime() - parsed;
  return delta <= MAX_BREAKING_MARKET_ITEM_AGE_MS && delta >= -MAX_BREAKING_MARKET_FUTURE_SKEW_MS;
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

type RawBreakingMarketCandidate = {
  title: string;
  summary: string | null;
  source_url: string;
  published_at: string;
  category: string;
};

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

function parseRawCandidates(value: unknown): RawBreakingMarketCandidate[] {
  if (typeof value !== "object" || value === null) throw new Error("BREAKING_MARKET_INVALID_OUTPUT");
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) throw new Error("BREAKING_MARKET_INVALID_OUTPUT");
  return candidates.filter((item): item is RawBreakingMarketCandidate =>
    typeof item === "object" && item !== null &&
    typeof (item as Record<string, unknown>).title === "string" &&
    typeof (item as Record<string, unknown>).source_url === "string" &&
    typeof (item as Record<string, unknown>).published_at === "string" &&
    typeof (item as Record<string, unknown>).category === "string"
  );
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
  const actualCanonical = new Set(
    Array.from(actualSourceUrls).map(canonicalizeUrl).filter((url): url is string => url !== null),
  );
  const results: IncomingNewsCandidate[] = [];
  for (const item of raw) {
    const title = item.title.trim();
    if (!title) continue;
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(item.source_url);
    } catch {
      continue;
    }
    if (sourceUrl.protocol !== "https:" || !isAllowedBreakingMarketUrl(item.source_url)) continue;
    const canonical = canonicalizeUrl(item.source_url);
    if (!canonical || !actualCanonical.has(canonical)) continue;
    if (!Number.isFinite(Date.parse(item.published_at))) continue;
    const publishedAt = new Date(item.published_at).toISOString();
    if (!isFreshBreakingMarketPublishedAt(publishedAt, now)) continue;
    const category = isImportantNewsCategory(item.category) ? item.category : query.defaultCategory;
    results.push({
      sourceType: "breaking_market",
      sourceName: "breaking_market",
      sourceUrl: item.source_url,
      title,
      bodySummary: item.summary?.trim() || null,
      companyName: null,
      companyCode: null,
      entityKey: query.defaultTopicKey,
      category,
      publishedAt,
    });
  }
  return results;
}

export async function fetchBreakingMarketQuery(
  openAiApiKey: string,
  query: BreakingMarketQuery,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<IncomingNewsCandidate[]> {
  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
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
        "許可ドメインの検索結果で実際に確認できた、直近24時間以内に公開が確認できる材料だけを候補にします。該当がなければcandidatesは空配列にします。",
        "candidatesは最大3件。各候補にはtitle、summary（1-2文の事実要約）、source_url（実際に開いた許可ドメインのURL）、published_at（確認できた日時、ISO 8601かYYYY-MM-DD）、categoryを含めます。",
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
                category: { type: "string", enum: IMPORTANT_NEWS_CATEGORIES },
              },
              required: ["title", "summary", "source_url", "published_at", "category"],
              additionalProperties: false,
            },
          },
        },
        required: ["candidates"],
        additionalProperties: false,
      } } },
    }),
  });
  if (!response.ok) throw new Error(`BREAKING_MARKET_SEARCH_FAILED:${query.key}:${response.status}`);
  const raw = await response.json();
  const output = extractOutputText(raw);
  if (!output) throw new Error(`BREAKING_MARKET_EMPTY_OUTPUT:${query.key}`);
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error(`BREAKING_MARKET_INVALID_OUTPUT:${query.key}`); }
  const rawCandidates = parseRawCandidates(parsed);
  const actualSourceUrls = collectBreakingMarketSourceUrls(raw);
  return collectBreakingMarketCandidates(query, rawCandidates, actualSourceUrls, now);
}
