// news-discovery-observer request handler (testable; index.ts only wires real dependencies).
//
// registry -> fetch -> normalize -> dedupe -> topic/entity -> ticker match -> DB insert -> run stats
//
// Discovery / observation only. This Function does NOT judge importance, run Fact/Voice, write app
// copy, generate X posts or send Push. Its only model use is the optional, budgeted Layer 3 Web
// Search (web_search.ts): off unless the request asks for it AND a provider is configured. It is
// independent of important-news-monitor's searches. It writes only to the news_discovery_* tables
// through their service_role-only functions.
import { type AliasIndex, buildAliasIndex, type StockMasterRow } from "../_shared/news_discovery/company_alias.ts";
import { type FetchImpl, GDELT_DISCOVERY_QUERIES, HostRateGate } from "../_shared/news_discovery/fetcher.ts";
import { DiscoveryRun, type DiscoveryRunResult, type SourceStats, summarizeRates } from "../_shared/news_discovery/pipeline.ts";
import { type DeadlineConfig, OBSERVER_DEADLINE, RunDeadline } from "../_shared/news_discovery/run_deadline.ts";
import { SEARCH_BUDGET_DEFAULTS, type SearchBudgetConfig } from "../_shared/news_discovery/search_config.ts";
import {
  emptySearchStats,
  executeSearchStage,
  type MarketAnomaly,
  planSearches,
  type SearchBudget,
  type SearchStageStats,
  type WebSearchProvider,
} from "../_shared/news_discovery/web_search.ts";
import { fetchableSources, NEWS_SOURCE_REGISTRY, sourceById } from "../_shared/news_discovery/source_registry.ts";
import {
  beginRun,
  finishRun,
  type RpcClient,
  type RunSourceRecord,
  SupabaseNewsSignalStore,
  SupabaseSearchBudget,
} from "../_shared/news_discovery/supabase_store.ts";
import type { FetchFailureCode, SourceDefinition } from "../_shared/news_discovery/types.ts";
import { isConfiguredObserverSecret, isValidObserverSecret, OBSERVER_SECRET_HEADER } from "./observer_auth.ts";

export const OBSERVER_CODE_VERSION = "news-discovery-observer/n3";
export const ALIAS_DICTIONARY_VERSION = "alias-v0-2026-09-28";

/**
 * Default source set: every fetchable DIRECT source. GDELT (DISCOVERY_ONLY) is off by default:
 * it answered 429 repeatedly on 2026-09-28 even at one request per 6 s, so no run may depend on it.
 */
export function defaultObserverSources(): SourceDefinition[] {
  return fetchableSources().filter((source) => source.policy === "DIRECT_SOURCE");
}

export type ObserverRequest = {
  sources?: string[];
  include_gdelt?: boolean;
  gdelt_queries?: number;
  max_items_per_source?: number;
  trigger_type?: "manual" | "scheduled" | "local_validation";
  /** Layer 3. Off unless enabled here; budget/cap/cooldown are enforced by the budget store. */
  search?: { enabled?: boolean; scheduled?: boolean; anomalies?: MarketAnomaly[] };
};

export type ObserverDeps = {
  observerSecret: string | undefined;
  rpc: RpcClient;
  loadStocks: () => Promise<StockMasterRow[]>;
  fetchImpl?: FetchImpl;
  gate?: HostRateGate;
  now?: () => Date;
  log?: (line: Record<string, unknown>) => void;
  /** Absent -> the search stage is skipped (e.g. no provider key configured). */
  searchProvider?: WebSearchProvider;
  searchBudget?: SearchBudget;
  searchConfig?: SearchBudgetConfig;
  /** Wall clock (ms) for the invocation deadline; injectable for tests. */
  clock?: () => number;
  deadlineConfig?: DeadlineConfig;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Resolved = { run: SourceDefinition[]; refused: Array<{ source: SourceDefinition; code: FetchFailureCode }> };

function refusalCode(source: SourceDefinition): FetchFailureCode {
  if (source.policy === "DISABLED") return "SOURCE_DISABLED";
  if (source.requires_api_key) return "SOURCE_REQUIRES_API_KEY";
  return "SOURCE_NOT_ENABLED_FOR_N2";
}

export function resolveSources(request: ObserverRequest): Resolved | { error: string } {
  const fetchable = new Set(fetchableSources().map((source) => source.source_id));
  const wanted = request.sources ?? defaultObserverSources().map((source) => source.source_id);
  if (!Array.isArray(wanted) || wanted.length > 50 || wanted.some((id) => typeof id !== "string")) {
    return { error: "INVALID_SOURCES" };
  }
  const ids = [...new Set(wanted)];
  if (request.include_gdelt && !ids.includes("gdelt_doc")) ids.push("gdelt_doc");
  const run: SourceDefinition[] = [];
  const refused: Resolved["refused"] = [];
  for (const id of ids) {
    const source = sourceById(id);
    if (!source) return { error: `UNKNOWN_SOURCE:${id.slice(0, 64)}` };
    if (fetchable.has(id)) run.push(source);
    else refused.push({ source, code: refusalCode(source) });
  }
  return { run, refused };
}

function sourceOutcome(stats: SourceStats): RunSourceRecord["outcome"] {
  const failed = stats.failures.length;
  if (failed === 0) return "ok";
  return failed < stats.requests ? "partial" : "failed";
}

function sourceRecord(stats: SourceStats): RunSourceRecord {
  return {
    source_id: stats.source_id,
    policy: stats.policy,
    outcome: sourceOutcome(stats),
    requests: stats.request_log,
    raw_items: stats.raw_items,
    filtered: stats.filtered,
    normalized: stats.normalized,
    duplicates: Object.values(stats.duplicates).reduce((a, b) => a + b, 0),
    inserted: stats.inserted,
    with_published_at: stats.with_published_at,
    with_topic: stats.with_topic,
    with_confirmed_ticker: stats.with_confirmed_ticker,
    duration_ms: stats.duration_ms,
  };
}

/** Discovery-only sources are optional: their failure alone never marks a run as failed or degraded. */
export function runStatus(stats: readonly SourceStats[]): "completed" | "completed_with_errors" | "failed" {
  const required = stats.filter((s) => s.policy === "DIRECT_SOURCE");
  const requiredFailed = required.filter((s) => sourceOutcome(s) === "failed").length;
  if (required.length > 0 && requiredFailed === required.length) return "failed";
  if (required.some((s) => sourceOutcome(s) !== "ok")) return "completed_with_errors";
  return "completed";
}

function errorSummary(stats: readonly SourceStats[]): string | null {
  const parts = stats.flatMap((s) => s.failures.map((f) => `${s.source_id}:${f.code}${f.status === null ? "" : `:${f.status}`}`));
  return parts.length ? parts.join(" | ").slice(0, 2000) : null;
}

export function createObserverHandler(deps: ObserverDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const clock = deps.clock ?? (() => Date.now());
  return async (request) => {
    if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
    if (!isConfiguredObserverSecret(deps.observerSecret)) return json(503, { error: "OBSERVER_SECRET_NOT_CONFIGURED" });
    if (!isValidObserverSecret(deps.observerSecret, request.headers.get(OBSERVER_SECRET_HEADER))) {
      return json(401, { error: "UNAUTHORIZED" });
    }

    let body: ObserverRequest;
    try {
      const text = await request.text();
      body = text.trim() ? JSON.parse(text) : {};
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      return json(400, { error: "INVALID_JSON" });
    }
    if (body.include_gdelt !== undefined && typeof body.include_gdelt !== "boolean") {
      return json(400, { error: "INVALID_GDELT_FLAG" });
    }
    const resolved = resolveSources(body);
    if ("error" in resolved) return json(400, { error: resolved.error });
    const maxItems = Math.max(1, Math.min(Number(body.max_items_per_source ?? 100) || 100, 200));
    const gdeltQueries = GDELT_DISCOVERY_QUERIES.slice(0, Math.max(0, Math.min(Number(body.gdelt_queries ?? 1) || 1, 2)));
    const triggerType = body.trigger_type ?? "manual";
    if (!["manual", "scheduled", "local_validation"].includes(triggerType)) return json(400, { error: "INVALID_TRIGGER_TYPE" });
    const search = body.search ?? {};
    if (body.search === null || typeof search !== "object" || Array.isArray(search) ||
      Object.keys(search).some((key) => !["enabled", "scheduled", "anomalies"].includes(key)) ||
      (search.enabled !== undefined && typeof search.enabled !== "boolean") ||
      (search.scheduled !== undefined && typeof search.scheduled !== "boolean") ||
      (search.anomalies !== undefined && (!Array.isArray(search.anomalies) || search.anomalies.length > 10 ||
        search.anomalies.some((a) => !a || typeof a !== "object" || Array.isArray(a) ||
          typeof a.instrument !== "string" || a.instrument.length > 64 ||
          Object.keys(a).some((key) => !["instrument", "change_pct", "window_minutes", "observed_at"].includes(key)) ||
          (a.change_pct !== undefined && (typeof a.change_pct !== "number" || !Number.isFinite(a.change_pct))) ||
          (a.window_minutes !== undefined && (!Number.isSafeInteger(a.window_minutes) || a.window_minutes <= 0)) ||
          (a.observed_at !== undefined && (typeof a.observed_at !== "string" || a.observed_at.length > 64 || !Number.isFinite(Date.parse(a.observed_at)))))))) {
      return json(400, { error: "INVALID_SEARCH_OPTIONS" });
    }

    const started = clock();
    // One wall-clock deadline for the whole invocation (run_deadline.ts holds every number).
    const deadline = new RunDeadline(started, deps.deadlineConfig ?? OBSERVER_DEADLINE, clock);
    let runId: string;
    try {
      runId = await beginRun(deps.rpc, {
        trigger_type: triggerType,
        requested_sources: [...resolved.run, ...resolved.refused.map((r) => r.source)].map((s) => s.source_id),
        code_version: OBSERVER_CODE_VERSION,
      });
    } catch (error) {
      log({ event: "news_discovery_run_begin_failed", error: error instanceof Error ? error.message : "unknown" });
      return json(500, { error: "RUN_BEGIN_FAILED" });
    }
    log({ event: "news_discovery_run_started", run_id: runId, sources: resolved.run.length, refused: resolved.refused.length, deadline_ms: deadline.stats.deadline_ms });

    const refusedRecords: RunSourceRecord[] = resolved.refused.map(({ source, code }) => ({
      source_id: source.source_id,
      policy: source.policy,
      outcome: "refused",
      requests: [{ via: `feed:${source.source_id}`, outcome: code, http_status: null, duration_ms: 0, items: 0, detail: "refused by source policy" }],
      raw_items: 0,
      filtered: 0,
      normalized: 0,
      duplicates: 0,
      inserted: 0,
      with_published_at: 0,
      with_topic: 0,
      with_confirmed_ticker: 0,
      duration_ms: 0,
    }));

    let run: DiscoveryRun | null = null;
    let searchStats: SearchStageStats = emptySearchStats();
    const execution = () => ({
      ...deadline.stats,
      elapsed_ms: deadline.elapsedMs(),
      signals_persisted: run?.persistedCount ?? 0,
    });
    try {
      let aliasIndex: AliasIndex | null = null;
      try {
        const rows = await deps.loadStocks();
        aliasIndex = rows.length ? buildAliasIndex(rows) : null;
      } catch (error) {
        // Ticker matching is optional for discovery; the run continues without it and says so.
        log({ event: "news_discovery_alias_unavailable", run_id: runId, error: error instanceof Error ? error.message : "unknown" });
      }
      const store = new SupabaseNewsSignalStore(deps.rpc, runId, ALIAS_DICTIONARY_VERSION);
      run = await DiscoveryRun.start({
        sources: resolved.run,
        store,
        aliasIndex,
        fetchImpl: deps.fetchImpl,
        gate: deps.gate ?? new HostRateGate(),
        now: deps.now,
        gdeltQueries,
        maxItemsPerSource: maxItems,
        log: (line) => log({ ...line, run_id: runId }),
        deadline,
      });
      // Layers 1 + 2: official feeds and discovery sources (each request gated by the deadline).
      await run.fetchSources(resolved.run);
      // Persist what the free layers found before any paid search starts.
      await run.persist();

      // Layer 3: limited Web Search, only for what the free layers did not explain.
      let searchNote: string | null = null;
      if (search.enabled === true) {
        if (!deps.searchProvider) {
          searchNote = "SEARCH_PROVIDER_NOT_CONFIGURED";
        } else {
          const config = deps.searchConfig ?? SEARCH_BUDGET_DEFAULTS;
          const plan = planSearches({
            now: run.now(),
            config,
            anomalies: search.anomalies,
            fresh: run.kept,
            context: run.context,
            scheduled: search.scheduled !== false,
          });
          searchStats = await executeSearchStage({
            run,
            runId,
            plan,
            provider: deps.searchProvider,
            budget: deps.searchBudget ?? new SupabaseSearchBudget(deps.rpc),
            config,
            log: (line) => log({ ...line, run_id: runId }),
            deadline,
          });
        }
      }
      const result = await run.finish();
      const feedStats = result.stats.filter((s) => s.source_id !== "web_search");
      let status = runStatus(feedStats);
      if (status === "completed" && (deadline.stats.deadline_reached || searchStats.persist_failed)) status = "completed_with_errors";
      if (searchStats.persist_failed) status = "failed";
      const totals = buildTotals(feedStats, result.totals, searchStats, result.ai_calls, result.web_search_calls);
      const notes = [
        errorSummary(result.stats),
        ...searchStats.failed.map((f) => `search:${f.search_key}:${f.code}`),
        searchStats.persist_failed ? "SEARCH_SIGNAL_PERSIST_FAILED" : null,
        deadline.stats.deadline_reached ? `DEADLINE_REACHED:sources_skipped=${deadline.stats.sources_skipped}:searches_skipped=${deadline.stats.searches_skipped}` : null,
        searchNote,
        aliasIndex ? null : "ALIAS_INDEX_UNAVAILABLE",
      ].filter((note): note is string => !!note);
      const summary = notes.length ? notes.join(" | ").slice(0, 2000) : null;
      await finishRun(deps.rpc, {
        run_id: runId,
        status,
        totals,
        sources: [...result.stats.map(sourceRecord), ...refusedRecords],
        error_summary: summary,
        execution: execution(),
      });
      const response = {
        run_id: runId,
        status,
        duration_ms: clock() - started,
        totals,
        execution: execution(),
        rates: summarizeRates(result.totals),
        sources: [
          ...result.stats.map((s) => ({ source_id: s.source_id, policy: s.policy, outcome: sourceOutcome(s), failures: s.failures.map((f) => f.code), skipped_deadline: s.skipped_deadline })),
          ...refusedRecords.map((r) => ({ source_id: r.source_id, policy: r.policy, outcome: r.outcome, failures: [] as string[], skipped_deadline: 0 })),
        ],
        alias_index: aliasIndex ? { companies: aliasIndex.tickers.size, dictionary_version: ALIAS_DICTIONARY_VERSION } : null,
        search: {
          enabled: search.enabled === true,
          note: searchNote,
          planned: searchStats.planned,
          executed: searchStats.executed,
          escalations: searchStats.escalations,
          denied: searchStats.denied,
          skipped: searchStats.skipped,
          failed: searchStats.failed,
          results: searchStats.result_count,
          new_signals: searchStats.new_signal_count,
          useful_signals: searchStats.useful_signal_count,
          persisted_signals: searchStats.persisted_signal_count,
          persisted_useful_signals: searchStats.persisted_useful_signal_count,
          persist_failed: searchStats.persist_failed,
          duplicates: searchStats.duplicate_count,
          restricted_publisher_results: searchStats.restricted_count,
          policy_blocked_results: searchStats.policy_blocked_count,
          rejected_unverified_urls: searchStats.rejected_unverified_count,
          per_search: searchStats.per_search,
        },
      };
      log({ event: "news_discovery_run_finished", run_id: runId, status, duration_ms: response.duration_ms, ...totals, ...execution() });
      return json(status === "failed" && searchStats.persist_failed ? 500 : 200, response);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "unknown";
      log({ event: "news_discovery_run_failed", run_id: runId, error: message });
      // Keep what was actually done/spent. finish_run also derives search usage from the search rows,
      // so the run never shows 0 searches/AI calls when calls were made.
      const partialStats = run ? run.stats.filter((s) => s.source_id !== "web_search") : [];
      const usage = run?.usage ?? { ai_calls: searchStats.model_calls, web_search_calls: searchStats.web_search_calls };
      try {
        await finishRun(deps.rpc, {
          run_id: runId,
          status: "failed",
          totals: buildTotals(partialStats, null, searchStats, usage.ai_calls, usage.web_search_calls),
          sources: [...partialStats.map(sourceRecord), ...refusedRecords],
          error_summary: `RUN_FAILED:${message}`,
          execution: execution(),
        });
      } catch { /* the run row stays 'running'; visible as stale in monitoring */ }
      return json(500, { run_id: runId, error: "RUN_FAILED" });
    }
  };
}

/**
 * Client-side run totals. For a failed run (`totals` null) the counts come from the per-source stats
 * collected so far. Search usage is repeated here, but finish_run takes the larger of these and the
 * values it derives from news_discovery_searches, so nothing actually spent can disappear.
 */
function buildTotals(
  feedStats: readonly SourceStats[],
  totals: DiscoveryRunResult["totals"] | null,
  searchStats: SearchStageStats,
  aiCalls: number,
  webSearchCalls: number,
): Record<string, number> {
  const sum = (pick: (s: SourceStats) => number) => feedStats.reduce((total, s) => total + pick(s), 0);
  const duplicates = (s: SourceStats) => Object.values(s.duplicates).reduce((a, b) => a + b, 0);
  return {
    source_count: feedStats.length,
    successful_sources: feedStats.filter((s) => sourceOutcome(s) === "ok").length,
    failed_sources: feedStats.filter((s) => sourceOutcome(s) !== "ok").length,
    http_requests: totals?.requests ?? sum((s) => s.requests),
    fetched_count: totals?.raw_items ?? sum((s) => s.raw_items),
    filtered_count: totals?.filtered ?? sum((s) => s.filtered),
    normalized_count: totals?.normalized ?? sum((s) => s.normalized),
    duplicate_count: totals ? Object.values(totals.duplicates).reduce((a, b) => a + b, 0) : sum(duplicates),
    inserted_count: totals?.inserted ?? 0,
    insert_conflict_count: totals?.insert_conflicts ?? 0,
    topic_matched_count: totals?.with_topic ?? sum((s) => s.with_topic),
    ticker_confirmed_count: totals?.with_confirmed_ticker ?? sum((s) => s.with_confirmed_ticker),
    ticker_candidate_count: totals?.with_candidate_ticker_only ?? sum((s) => s.with_candidate_ticker_only),
    search_count: searchStats.executed,
    search_denied_count: searchStats.denied.length,
    search_result_count: searchStats.result_count,
    search_useful_signal_count: searchStats.persisted_useful_signal_count,
    search_duplicate_count: searchStats.duplicate_count,
    ai_calls: aiCalls,
    web_search_calls: webSearchCalls,
  };
}

/** Registry summary for docs/tests (policy lists). */
export function registrySummary() {
  return {
    direct_enabled: fetchableSources().filter((s) => s.policy === "DIRECT_SOURCE").map((s) => s.source_id),
    direct_disabled: NEWS_SOURCE_REGISTRY.filter((s) => s.policy === "DIRECT_SOURCE" && !fetchableSources().includes(s)).map((s) => s.source_id),
    discovery_only: NEWS_SOURCE_REGISTRY.filter((s) => s.policy === "DISCOVERY_ONLY").map((s) => s.source_id),
    disabled: NEWS_SOURCE_REGISTRY.filter((s) => s.policy === "DISABLED").map((s) => s.source_id),
  };
}
