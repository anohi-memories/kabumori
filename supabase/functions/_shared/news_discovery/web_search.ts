// Observer Web Search (N3 v2): Layer 3 of the discovery stack.
//
//   Layer 1 official feeds  -> Layer 2 GDELT discovery -> Layer 3 limited Web Search -> (Layer 4 paid API)
//
// Web Search here is a radar ("something happened"), never a source of record:
// * broad lane queries (many stories per search), never one company per search;
// * a daily soft budget, a hard cap and a per-theme cooldown, enforced by the budget store
//   (DB function under a lock in production);
// * result pages are never fetched; only URL, domain, a discovery title, lane, query, reason and
//   detection time are kept; no summary, no image, no model-claimed timestamps;
// * results from DISABLED/no_access publishers are dropped; no_direct_fetch publishers are kept
//   only as flagged discovery leads that need an official/primary source.
// Independent of important-news-monitor's search code (not imported, not changed).
import { canonicalizeUrl } from "./normalize.ts";
import type { DiscoveryRun, GroupingSignal } from "./pipeline.ts";
import {
  ANOMALY_INSTRUMENT_LANES,
  SEARCH_BUDGET_DEFAULTS,
  SEARCH_LANES,
  SEARCH_LANES_ORDER,
  SEARCH_PROVIDER_DEFAULTS,
  type SearchBudgetConfig,
  type SearchLane,
  type SearchProviderConfig,
  type SearchReason,
  TOPIC_TO_LANE,
  TRIGGER_TOPICS,
} from "./search_config.ts";
import { publisherRestriction, sourceById } from "./source_registry.ts";
import type { NewsSignal, RawItem } from "./types.ts";

// ------------------------------------------------------------------------------------------------
// Provider (NewsSourceAdapter family: OfficialFeed / Gdelt / WebSearch / future PaidNews)

export type WebSearchResultItem = { url: string; title: string; publisher: string | null };
export type ProviderUsage = { model_calls: number; web_search_calls: number; input_tokens: number; output_tokens: number };
export type ProviderResult =
  | { ok: true; results: WebSearchResultItem[]; rejected_unverified: number; usage: ProviderUsage }
  | { ok: false; code: "PROVIDER_NOT_CONFIGURED" | "PROVIDER_TIMEOUT" | "PROVIDER_RATE_LIMITED" | "PROVIDER_HTTP_ERROR" | "PROVIDER_BAD_RESPONSE" | "PROVIDER_NETWORK_ERROR"; status: number | null; usage: ProviderUsage };

export interface WebSearchProvider {
  readonly name: string;
  readonly model: string;
  search(input: { query: string; lane: SearchLane; maxResults: number; recencyHours: number; now: Date }): Promise<ProviderResult>;
}

const NO_USAGE: ProviderUsage = { model_calls: 0, web_search_calls: 0, input_tokens: 0, output_tokens: 0 };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Request body for the observer's own search (exported for tests / review). */
export function openAiSearchRequestBody(
  input: { query: string; lane: SearchLane; maxResults: number; recencyHours: number; now: Date },
  config: SearchProviderConfig = SEARCH_PROVIDER_DEFAULTS,
): Record<string, unknown> {
  return {
    model: config.model,
    store: false,
    reasoning: { effort: "low" },
    max_output_tokens: config.max_output_tokens,
    max_tool_calls: 1,
    tools: [{ type: "web_search", search_context_size: config.search_context_size }],
    tool_choice: "required",
    include: ["web_search_call.action.sources"],
    instructions: [
      "You are a news discovery radar for a Japanese stock app. Search once and list distinct news stories found.",
      `Only stories published or updated within the last ${input.recencyHours} hours. At most ${input.maxResults} items.`,
      "For each item return the article URL exactly as it appeared in the search results, its headline, and the publisher name.",
      "Do not summarize, do not invent URLs, do not include items you did not see in the search results. Return an empty list if nothing qualifies.",
    ].join("\n"),
    input: `lane: ${input.lane}\nsearch focus: ${input.query}\nreference UTC: ${input.now.toISOString()}`,
    text: {
      format: {
        type: "json_schema",
        name: "news_discovery_results",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["items"],
          properties: {
            items: {
              type: "array",
              maxItems: input.maxResults,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["url", "title", "publisher"],
                properties: {
                  url: { type: "string" },
                  title: { type: "string" },
                  publisher: { type: ["string", "null"] },
                },
              },
            },
          },
        },
      },
    },
  };
}

/** URLs the search tool actually returned or cited. Model-claimed URLs outside this set are rejected. */
export function verifiedUrlsFromResponse(raw: unknown): Set<string> {
  const urls = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const canonical = canonicalizeUrl(value);
    if (canonical) urls.add(canonical);
  };
  const output = (raw as { output?: unknown })?.output;
  if (!Array.isArray(output)) return urls;
  for (const item of output) {
    const record = item as Record<string, unknown>;
    if (record?.type === "web_search_call") {
      const sources = (record.action as { sources?: unknown } | undefined)?.sources;
      if (Array.isArray(sources)) for (const source of sources) add((source as { url?: unknown })?.url);
    }
    if (record?.type === "message" && Array.isArray(record.content)) {
      for (const part of record.content as Array<Record<string, unknown>>) {
        if (!Array.isArray(part.annotations)) continue;
        for (const annotation of part.annotations as Array<Record<string, unknown>>) {
          if (annotation.type === "url_citation") add(annotation.url);
        }
      }
    }
  }
  return urls;
}

export function parseOpenAiSearchResponse(raw: unknown): { results: WebSearchResultItem[]; rejected_unverified: number; usage: ProviderUsage } | null {
  const record = raw as { output?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  if (!record || !Array.isArray(record.output)) return null;
  const webSearchCalls = record.output.filter((item) => (item as { type?: unknown })?.type === "web_search_call").length;
  const usage: ProviderUsage = {
    model_calls: 1,
    web_search_calls: webSearchCalls,
    input_tokens: typeof record.usage?.input_tokens === "number" ? record.usage.input_tokens : 0,
    output_tokens: typeof record.usage?.output_tokens === "number" ? record.usage.output_tokens : 0,
  };
  let text = "";
  for (const item of record.output as Array<Record<string, unknown>>) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.items)) return null;
  const verified = verifiedUrlsFromResponse(raw);
  const results: WebSearchResultItem[] = [];
  let rejected = 0;
  for (const value of parsed.items as Array<Record<string, unknown>>) {
    const url = typeof value.url === "string" ? value.url : "";
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const canonical = canonicalizeUrl(url);
    if (!canonical || !title || !verified.has(canonical)) {
      rejected += 1;
      continue;
    }
    results.push({ url: canonical, title: title.slice(0, 300), publisher: typeof value.publisher === "string" ? value.publisher.slice(0, 120) : null });
  }
  return { results, rejected_unverified: rejected, usage };
}

export class OpenAiWebSearchProvider implements WebSearchProvider {
  readonly name = "openai_responses_web_search";
  readonly model: string;
  constructor(
    private readonly apiKey: string | undefined,
    private readonly config: SearchProviderConfig = SEARCH_PROVIDER_DEFAULTS,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.model = config.model;
  }

  async search(input: { query: string; lane: SearchLane; maxResults: number; recencyHours: number; now: Date }): Promise<ProviderResult> {
    if (!this.apiKey) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", status: null, usage: NO_USAGE };
    let response: Response;
    try {
      response = await this.fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(openAiSearchRequestBody(input, this.config)),
        signal: AbortSignal.timeout(this.config.timeout_ms),
      });
    } catch (error) {
      const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      // A timed-out request may still have been billed: count it as one model call.
      return { ok: false, code: timeout ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR", status: null, usage: { ...NO_USAGE, model_calls: 1 } };
    }
    if (response.status === 429) {
      await response.body?.cancel();
      return { ok: false, code: "PROVIDER_RATE_LIMITED", status: 429, usage: NO_USAGE };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, code: "PROVIDER_HTTP_ERROR", status: response.status, usage: NO_USAGE };
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { ok: false, code: "PROVIDER_BAD_RESPONSE", status: response.status, usage: { ...NO_USAGE, model_calls: 1 } };
    }
    const parsed = parseOpenAiSearchResponse(raw);
    if (!parsed) return { ok: false, code: "PROVIDER_BAD_RESPONSE", status: response.status, usage: { ...NO_USAGE, model_calls: 1 } };
    return { ok: true, ...parsed };
  }
}

// ------------------------------------------------------------------------------------------------
// Budget

export type SearchRequest = {
  lane: SearchLane;
  reason: SearchReason;
  query: string;
  /** Theme identity for cooldown/escalation: rotation:LANE, anomaly:WTI, signal:war:Iran ... */
  search_key: string;
  triggered_by: string | null;
  parent_search_id: string | null;
};

export type ReserveResult =
  | { allowed: true; search_id: string; searches_today: number }
  | { allowed: false; reason: "hard_cap" | "soft_budget" | "duplicate_search_key" | "escalation_limit" | "bad_parent"; searches_today: number };

export type SearchCompletion = {
  search_id: string;
  status: "succeeded" | "failed";
  error_code: string | null;
  result_count: number;
  new_signal_count: number;
  useful_signal_count: number;
  duplicate_count: number;
  restricted_count: number;
  policy_blocked_count: number;
  rejected_unverified_count: number;
  usage: ProviderUsage;
};

export interface SearchBudget {
  reserve(request: SearchRequest & { run_id: string; provider: string; model: string }): Promise<ReserveResult>;
  complete(completion: SearchCompletion): Promise<void>;
}

/** Budget day key in JST (YYYY-MM-DD). */
export function budgetDay(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

type BudgetRow = SearchRequest & { id: string; day: string; at: number; status: "reserved" | "succeeded" | "failed" };

/** In-memory budget with exactly the rules of news_discovery_reserve_search (tests / local runs). */
export class InMemorySearchBudget implements SearchBudget {
  rows: BudgetRow[] = [];
  completions: SearchCompletion[] = [];
  denied: Array<SearchRequest & { deny_reason: string }> = [];
  #seq = 0;
  constructor(private readonly config: SearchBudgetConfig = SEARCH_BUDGET_DEFAULTS, private readonly now: () => Date = () => new Date()) {}

  reserve(request: SearchRequest & { run_id: string }): Promise<ReserveResult> {
    const now = this.now();
    const day = budgetDay(now);
    const today = this.rows.filter((row) => row.day === day);
    const deny = (reason: Extract<ReserveResult, { allowed: false }>["reason"]): Promise<ReserveResult> => {
      this.denied.push({ ...request, deny_reason: reason });
      return Promise.resolve({ allowed: false, reason, searches_today: today.length });
    };
    if (today.length >= this.config.daily_hard_limit) return deny("hard_cap");
    if (request.reason === "scheduled_rotation" && today.length >= this.config.daily_soft_budget) return deny("soft_budget");
    if (request.reason === "escalation") {
      if (!request.parent_search_id || !this.rows.some((row) => row.id === request.parent_search_id && row.search_key === request.search_key)) {
        return deny("bad_parent");
      }
      const escalations = today.filter((row) => row.reason === "escalation" && row.search_key === request.search_key).length;
      if (escalations >= this.config.max_escalations_per_key_per_day) return deny("escalation_limit");
    } else {
      const cooldown = request.reason === "scheduled_rotation" ? this.config.lane_rotation_interval_minutes : this.config.search_key_cooldown_minutes;
      if (this.rows.some((row) => row.search_key === request.search_key && now.getTime() - row.at < cooldown * 60_000)) {
        return deny("duplicate_search_key");
      }
    }
    const id = `00000000-0000-4000-9000-${String(++this.#seq).padStart(12, "0")}`;
    this.rows.push({ ...request, id, day, at: now.getTime(), status: "reserved" });
    return Promise.resolve({ allowed: true, search_id: id, searches_today: today.length + 1 });
  }

  complete(completion: SearchCompletion): Promise<void> {
    const row = this.rows.find((entry) => entry.id === completion.search_id);
    if (row && row.status === "reserved") row.status = completion.status;
    this.completions.push(completion);
    return Promise.resolve();
  }
}

// ------------------------------------------------------------------------------------------------
// Planning

export type MarketAnomaly = { instrument: string; change_pct?: number; window_minutes?: number; observed_at?: string };

export type PlannedSkip = { search_key: string; reason: "explained_by_pool" | "unknown_instrument" | "per_run_limit" | "no_trigger" };

export type SearchPlan = { requests: SearchRequest[]; skipped: PlannedSkip[] };

function laneForTopics(topics: readonly string[]): SearchLane | null {
  for (const topic of topics) {
    const lane = TOPIC_TO_LANE[topic as keyof typeof TOPIC_TO_LANE];
    if (lane) return lane;
  }
  return null;
}

function queryFromTitle(title: string): string {
  return title.replace(/["'“”‘’()[\]{}]/g, " ").split(/\s+/).filter(Boolean).slice(0, 14).join(" ");
}

/**
 * Decide this run's searches. Order: market-anomaly triggers, discovery-signal triggers, then one
 * lane rotation. The budget store still has the final say (cooldowns, soft budget, hard cap).
 */
export function planSearches(input: {
  now: Date;
  config?: SearchBudgetConfig;
  anomalies?: readonly MarketAnomaly[];
  /** Signals new in this run (feeds + GDELT). */
  fresh: readonly NewsSignal[];
  /** Recent pool + this run (for "already explained" checks). */
  context: readonly GroupingSignal[];
  scheduled?: boolean;
}): SearchPlan {
  const config = input.config ?? SEARCH_BUDGET_DEFAULTS;
  const requests: SearchRequest[] = [];
  const skipped: PlannedSkip[] = [];
  const nowMs = input.now.getTime();
  const directIds = new Set(input.fresh.filter((s) => s.policy === "DIRECT_SOURCE").map((s) => s.id));
  const isDirect = (signal: GroupingSignal) =>
    directIds.has(signal.id) || (!signal.source_id.startsWith("gdelt") && signal.source_id !== "web_search");
  const explainedLane = (lane: SearchLane) =>
    input.context.some((signal) =>
      isDirect(signal) && nowMs - Date.parse(signal.fetched_at) <= config.anomaly_explained_window_minutes * 60_000 &&
      signal.topics.some((topic) => SEARCH_LANES[lane].topics.includes(topic))
    );
  const pushTrigger = (request: SearchRequest) => {
    const triggers = requests.filter((r) => r.reason !== "scheduled_rotation").length;
    if (triggers >= config.max_trigger_searches_per_run) {
      skipped.push({ search_key: request.search_key, reason: "per_run_limit" });
      return;
    }
    if (!requests.some((r) => r.search_key === request.search_key)) requests.push(request);
  };

  for (const anomaly of input.anomalies ?? []) {
    const instrument = String(anomaly.instrument ?? "").toUpperCase();
    const lanes = ANOMALY_INSTRUMENT_LANES[instrument];
    if (!lanes) {
      skipped.push({ search_key: `anomaly:${instrument.slice(0, 20)}`, reason: "unknown_instrument" });
      continue;
    }
    const lane = lanes[0];
    const key = `anomaly:${instrument}`;
    if (explainedLane(lane)) {
      skipped.push({ search_key: key, reason: "explained_by_pool" });
      continue;
    }
    const move = typeof anomaly.change_pct === "number" ? ` (${anomaly.change_pct > 0 ? "+" : ""}${anomaly.change_pct}%)` : "";
    pushTrigger({
      lane,
      reason: "trigger_market_anomaly",
      query: `why did ${instrument}${move} move sharply in the last hours: ${SEARCH_LANES[lane].query}`,
      search_key: key,
      triggered_by: `anomaly:${instrument}`,
      parent_search_id: null,
    });
  }

  for (const signal of input.fresh) {
    if (!signal.discovery_only || signal.source_id === "web_search") continue;
    const topic = signal.topics.find((t) => TRIGGER_TOPICS.includes(t));
    if (!topic) continue;
    const lane = TOPIC_TO_LANE[topic] ?? laneForTopics(signal.topics);
    if (!lane) continue;
    const entity = signal.entities[0]?.value ?? signal.title_fingerprint.slice(0, 8);
    const key = `signal:${topic}:${entity}`.slice(0, 120);
    const confirmedByDirect = input.fresh.some((other) =>
      other.policy === "DIRECT_SOURCE" && other.topics.includes(topic) &&
      other.entities.some((e) => signal.entities.some((x) => x.value === e.value))
    );
    if (confirmedByDirect) {
      skipped.push({ search_key: key, reason: "explained_by_pool" });
      continue;
    }
    pushTrigger({
      lane,
      reason: "trigger_discovery_signal",
      query: queryFromTitle(signal.title),
      search_key: key,
      triggered_by: `signal:${signal.id}`,
      parent_search_id: null,
    });
  }

  if (input.scheduled !== false && config.max_scheduled_searches_per_run > 0) {
    // Deterministic rotation slot; the DB cooldown prevents a lane repeating within its interval.
    const slotMinutes = Math.max(1, Math.floor(config.lane_rotation_interval_minutes / SEARCH_LANES_ORDER.length));
    const slot = Math.floor(nowMs / 60_000 / slotMinutes) % SEARCH_LANES_ORDER.length;
    for (let i = 0; i < config.max_scheduled_searches_per_run; i += 1) {
      const lane = SEARCH_LANES_ORDER[(slot + i) % SEARCH_LANES_ORDER.length];
      requests.push({
        lane,
        reason: "scheduled_rotation",
        query: SEARCH_LANES[lane].query,
        search_key: `rotation:${lane}`,
        triggered_by: null,
        parent_search_id: null,
      });
    }
  }
  return { requests, skipped };
}

// ------------------------------------------------------------------------------------------------
// Execution

export type SearchStageStats = {
  planned: number;
  skipped: PlannedSkip[];
  executed: number;
  denied: Array<{ search_key: string; reason: string }>;
  failed: Array<{ search_key: string; code: string }>;
  escalations: number;
  result_count: number;
  new_signal_count: number;
  useful_signal_count: number;
  duplicate_count: number;
  restricted_count: number;
  policy_blocked_count: number;
  rejected_unverified_count: number;
  model_calls: number;
  web_search_calls: number;
  input_tokens: number;
  output_tokens: number;
  per_search: Array<{ search_id: string; lane: SearchLane; reason: SearchReason; search_key: string; results: number; useful: number; duplicates: number }>;
};

export function emptySearchStats(): SearchStageStats {
  return {
    planned: 0, skipped: [], executed: 0, denied: [], failed: [], escalations: 0, result_count: 0, new_signal_count: 0,
    useful_signal_count: 0, duplicate_count: 0, restricted_count: 0, policy_blocked_count: 0, rejected_unverified_count: 0,
    model_calls: 0, web_search_calls: 0, input_tokens: 0, output_tokens: 0, per_search: [],
  };
}

/** Useful = new (not a duplicate) and classifiable: at least one topic or a confirmed ticker. */
export function isUsefulSignal(signal: NewsSignal): boolean {
  return signal.topics.length > 0 || signal.ticker_candidates.some((c) => c.status === "confirmed");
}

export async function executeSearchStage(input: {
  run: DiscoveryRun;
  runId: string;
  plan: SearchPlan;
  provider: WebSearchProvider;
  budget: SearchBudget;
  config?: SearchBudgetConfig;
  log?: (line: Record<string, unknown>) => void;
}): Promise<SearchStageStats> {
  const config = input.config ?? SEARCH_BUDGET_DEFAULTS;
  const source = sourceById("web_search")!;
  const stats = emptySearchStats();
  stats.planned = input.plan.requests.length;
  stats.skipped = [...input.plan.skipped];
  const queue: SearchRequest[] = [...input.plan.requests];

  while (queue.length > 0) {
    const request = queue.shift()!;
    const reservation = await input.budget.reserve({ ...request, run_id: input.runId, provider: input.provider.name, model: input.provider.model });
    if (!reservation.allowed) {
      stats.denied.push({ search_key: request.search_key, reason: reservation.reason });
      input.log?.({ event: "news_discovery_search_denied", search_key: request.search_key, lane: request.lane, reason: reservation.reason, searches_today: reservation.searches_today });
      continue;
    }
    const now = input.run.now();
    const response = await input.provider.search({
      query: request.query,
      lane: request.lane,
      maxResults: config.max_results_per_search,
      recencyHours: config.recency_hours,
      now,
    });
    stats.executed += 1;
    if (request.reason === "escalation") stats.escalations += 1;
    stats.model_calls += response.usage.model_calls;
    stats.web_search_calls += response.usage.web_search_calls;
    stats.input_tokens += response.usage.input_tokens;
    stats.output_tokens += response.usage.output_tokens;
    input.run.recordUsage(response.usage.model_calls, response.usage.web_search_calls);

    if (!response.ok) {
      stats.failed.push({ search_key: request.search_key, code: response.code });
      await input.budget.complete({
        search_id: reservation.search_id, status: "failed", error_code: response.code, result_count: 0, new_signal_count: 0,
        useful_signal_count: 0, duplicate_count: 0, restricted_count: 0, policy_blocked_count: 0, rejected_unverified_count: 0, usage: response.usage,
      });
      input.log?.({ event: "news_discovery_search_failed", search_id: reservation.search_id, lane: request.lane, code: response.code, status: response.status });
      continue;
    }

    let restricted = 0;
    let blocked = 0;
    const fetchedAt = now.toISOString();
    const items: RawItem[] = [];
    for (const result of response.results) {
      const restriction = publisherRestriction(result.url);
      if (restriction?.scope === "no_access") {
        blocked += 1; // terms forbid AI/TDM processing: not kept at all
        continue;
      }
      if (restriction) restricted += 1;
      items.push({
        title: result.title,
        link: result.url,
        external_id: null,
        summary: null,
        published_raw: null, // model-reported times are not source-verified: never stored as published_at
        updated_raw: null,
        seen_raw: fetchedAt,
        structured_ticker: null,
        image_url: null,
        publisher: result.publisher ?? new URL(result.url).hostname,
        language: null,
        country: null,
      });
    }
    const duplicatesBefore = input.run.duplicates.length;
    const fresh = await input.run.ingest(source, items, {
      via: `search:${request.lane}:${request.reason}`,
      feedUrl: source.endpoint,
      fetchedAt,
      decorate: (signal) => {
        const restriction = publisherRestriction(signal.canonical_url);
        return {
          ...signal,
          search_id: reservation.search_id,
          restricted_publisher: restriction?.scope === "no_direct_fetch",
          needs_verification: restriction
            ? [...new Set([...signal.needs_verification, "restricted_publisher_needs_primary" as const])]
            : signal.needs_verification,
        };
      },
    });
    const duplicates = input.run.duplicates.length - duplicatesBefore;
    const useful = fresh.filter(isUsefulSignal).length;
    stats.result_count += response.results.length;
    stats.new_signal_count += fresh.length;
    stats.useful_signal_count += useful;
    stats.duplicate_count += duplicates;
    stats.restricted_count += restricted;
    stats.policy_blocked_count += blocked;
    stats.rejected_unverified_count += response.rejected_unverified;
    stats.per_search.push({ search_id: reservation.search_id, lane: request.lane, reason: request.reason, search_key: request.search_key, results: response.results.length, useful, duplicates });
    await input.budget.complete({
      search_id: reservation.search_id, status: "succeeded", error_code: null, result_count: response.results.length,
      new_signal_count: fresh.length, useful_signal_count: useful, duplicate_count: duplicates, restricted_count: restricted,
      policy_blocked_count: blocked, rejected_unverified_count: response.rejected_unverified, usage: response.usage,
    });
    input.log?.({
      event: "news_discovery_search", search_id: reservation.search_id, lane: request.lane, reason: request.reason,
      results: response.results.length, new_signals: fresh.length, useful, duplicates, restricted, policy_blocked: blocked,
      rejected_unverified: response.rejected_unverified, searches_today: reservation.searches_today,
    });

    // Escalation: a trigger that found nothing useful gets one broader follow-up, never more.
    if (useful === 0 && (request.reason === "trigger_market_anomaly" || request.reason === "trigger_discovery_signal")) {
      queue.push({
        lane: request.lane,
        reason: "escalation",
        query: SEARCH_LANES[request.lane].fallback_query,
        search_key: request.search_key,
        triggered_by: request.triggered_by,
        parent_search_id: reservation.search_id,
      });
    }
  }
  return stats;
}
