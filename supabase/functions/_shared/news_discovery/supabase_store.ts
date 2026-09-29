// Supabase (PostgREST RPC) implementation of NewsSignalStore for the observation-only tables of
// migration 20260929090000_news_discovery_observer.sql. The pipeline only sees NewsSignalStore.
//
// Writes go exclusively through the news_discovery_* SECURITY DEFINER functions (service_role
// only); the tables themselves grant no INSERT/UPDATE/DELETE to anyone.
import { urlDedupeKey } from "./normalize.ts";
import type { GroupingSignal } from "./pipeline.ts";
import type { DedupeHit, DuplicateLookup, NewsSignalStore, SaveResult } from "./store.ts";
import type { NewsSignal } from "./types.ts";
import type { ReserveResult, SearchBudget, SearchCompletion, SearchRequest } from "./web_search.ts";

export type RpcFunction =
  | "news_discovery_begin_run"
  | "news_discovery_find_duplicates"
  | "news_discovery_insert_signals"
  | "news_discovery_recent_for_grouping"
  | "news_discovery_finish_run"
  | "news_discovery_reserve_search"
  | "news_discovery_complete_search";

export interface RpcClient {
  call(fn: RpcFunction, payload: Record<string, unknown>): Promise<unknown>;
}

/** Error carrying a machine code and HTTP status only (never the key, never a response body dump). */
export class NewsDiscoveryDbError extends Error {
  constructor(readonly code: string, readonly status: number | null, readonly retryable: boolean) {
    super(`${code}${status === null ? "" : `:${status}`}`);
    this.name = "NewsDiscoveryDbError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Retry read-only/idempotent RPCs only. A lost acknowledgement of begin_run or reserve_search
 * may already have committed: replay would create a second run or consume another reservation.
 */
export function postgrestRpcClient(
  supabaseUrl: string,
  serviceRoleKey: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; retries?: number } = {},
): RpcClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = supabaseUrl.replace(/\/+$/, "");
  return {
    async call(fn, payload) {
      let lastError: NewsDiscoveryDbError | null = null;
      const retries = fn === "news_discovery_begin_run" || fn === "news_discovery_reserve_search"
        ? 0 : Math.max(0, Math.min(options.retries ?? 1, 1));
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        let response: Response;
        try {
          response = await fetchImpl(`${base}/rest/v1/rpc/${fn}`, {
            method: "POST",
            headers: {
              apikey: serviceRoleKey,
              Authorization: `Bearer ${serviceRoleKey}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify({ p: payload }),
            signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
          });
        } catch {
          lastError = new NewsDiscoveryDbError(`DB_RPC_TRANSPORT:${fn}`, null, true);
          continue;
        }
        if (response.ok) return await response.json();
        const retryable = response.status >= 500;
        // PostgREST error bodies may contain SQL detail; only the PG error code is kept.
        let pgCode = "";
        try {
          const body = await response.json() as { code?: unknown };
          pgCode = typeof body.code === "string" ? `:${body.code.slice(0, 10)}` : "";
        } catch { /* ignore */ }
        lastError = new NewsDiscoveryDbError(`DB_RPC_FAILED:${fn}${pgCode}`, response.status, retryable);
        if (!retryable) break;
      }
      throw lastError ?? new NewsDiscoveryDbError(`DB_RPC_FAILED:${fn}`, null, false);
    },
  };
}

export const MAX_RPC_BATCH = 200;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Row sent to news_discovery_insert_signals (column names follow the migration). */
export function signalToRow(signal: NewsSignal): Record<string, unknown> {
  return {
    id: signal.id,
    source_id: signal.source_id,
    source_type: signal.source_type,
    policy: signal.policy,
    discovery_only: signal.discovery_only,
    restricted_publisher: signal.restricted_publisher,
    search_id: signal.search_id,
    discovered_via: signal.discovered_via,
    source_url: signal.source_url,
    canonical_url: signal.canonical_url,
    url_key: urlDedupeKey(signal.canonical_url),
    external_id: signal.external_id,
    title: signal.title,
    title_fingerprint: signal.title_fingerprint,
    title_display_allowed: signal.title_display_allowed,
    summary_hint: signal.discovery_only ? null : signal.summary_hint,
    published_at: signal.published_at,
    published_at_precision: signal.published_at_precision,
    updated_at: signal.updated_at,
    detected_at: signal.detected_at,
    fetched_at: signal.fetched_at,
    language: signal.language,
    country: signal.country,
    publisher: signal.publisher,
    topics: signal.topics,
    needs_verification: signal.needs_verification,
    same_event_group: signal.same_event_group,
    image_url: signal.image_usage_allowed && !signal.discovery_only ? signal.image_url : null,
    image_usage_allowed: signal.image_usage_allowed && !signal.discovery_only,
    raw_reference: signal.discovery_only
      ? { feed_url: signal.raw_reference.feed_url, item_index: signal.raw_reference.item_index }
      : signal.raw_reference,
    tickers: signal.ticker_candidates.map((ticker) => ({
      ticker: ticker.ticker,
      status: ticker.status,
      confirmation_basis: ticker.confirmation_basis,
      match_types: ticker.match_types,
      matched_aliases: ticker.matched_aliases,
      in_title: ticker.in_title,
      score: ticker.score,
    })),
    entities: signal.entities.map((entity) => ({ kind: entity.kind, value: entity.value })),
  };
}

type RecentRow = {
  id: string;
  source_id: string;
  title: string;
  fetched_at: string;
  topics: NewsSignal["topics"];
  same_event_group: string | null;
  confirmed_tickers: string[];
};

export class SupabaseNewsSignalStore implements NewsSignalStore {
  constructor(
    private readonly rpc: RpcClient,
    private readonly runId: string,
    private readonly aliasDictionaryVersion: string,
  ) {}

  async findDuplicate(lookup: DuplicateLookup): Promise<DedupeHit | null> {
    return (await this.findDuplicates([lookup]))[0];
  }

  async findDuplicates(lookups: readonly DuplicateLookup[]): Promise<Array<DedupeHit | null>> {
    const out: Array<DedupeHit | null> = lookups.map(() => null);
    for (const [chunkIndex, chunk] of chunks(lookups, MAX_RPC_BATCH).entries()) {
      const offset = chunkIndex * MAX_RPC_BATCH;
      const response = await this.rpc.call("news_discovery_find_duplicates", {
        lookups: chunk.map((lookup, i) => ({
          i: offset + i,
          source_id: lookup.source_id,
          external_id: lookup.external_id,
          canonical_url: lookup.canonical_url,
          url_key: lookup.url_key,
          title_fingerprint: lookup.title_fingerprint,
          title_fingerprint_any: lookup.title_fingerprint_any,
          since: new Date(lookup.since_ms).toISOString(),
        })),
      });
      if (!Array.isArray(response)) throw new NewsDiscoveryDbError("DB_RPC_BAD_RESPONSE:find_duplicates", null, false);
      for (const hit of response as Array<{ i: number; reason: DedupeHit["reason"]; signal_id: string }>) {
        if (Number.isInteger(hit.i) && hit.i >= 0 && hit.i < out.length) out[hit.i] = { reason: hit.reason, signal_id: hit.signal_id };
      }
    }
    return out;
  }

  async recent(sinceMs: number): Promise<GroupingSignal[]> {
    const response = await this.rpc.call("news_discovery_recent_for_grouping", { since: new Date(sinceMs).toISOString() });
    if (!Array.isArray(response)) throw new NewsDiscoveryDbError("DB_RPC_BAD_RESPONSE:recent", null, false);
    return (response as RecentRow[]).map((row) => ({
      id: row.id,
      source_id: row.source_id,
      title: row.title,
      fetched_at: new Date(row.fetched_at).toISOString(),
      topics: row.topics ?? [],
      same_event_group: row.same_event_group,
      ticker_candidates: (row.confirmed_tickers ?? []).map((ticker) => ({ ticker, status: "confirmed" as const })),
    }));
  }

  /**
   * Each chunk is one DB transaction (all rows of the chunk or none). A failing chunk throws after
   * the client's retry; chunks already written stay written, and a re-run of the same items is a
   * no-op for them (ON CONFLICT DO NOTHING), so retrying a whole run is safe.
   */
  async save(signals: readonly NewsSignal[]): Promise<SaveResult> {
    const result: SaveResult = { inserted: [], conflicted: [], duplicates: [] };
    for (const chunk of chunks(signals, MAX_RPC_BATCH)) {
      const response = await this.rpc.call("news_discovery_insert_signals", {
        run_id: this.runId,
        alias_dictionary_version: this.aliasDictionaryVersion,
        signals: chunk.map(signalToRow),
      }) as { inserted?: unknown; conflicted?: unknown; duplicates?: unknown };
      if (!Array.isArray(response?.inserted) || !Array.isArray(response?.conflicted) ||
        (response.duplicates !== undefined && !Array.isArray(response.duplicates))) {
        throw new NewsDiscoveryDbError("DB_RPC_BAD_RESPONSE:insert_signals", null, false);
      }
      result.inserted.push(...response.inserted as string[]);
      result.conflicted.push(...response.conflicted as string[]);
      // URL duplicates of rows a concurrent run committed first (resolved inside the DB under a lock).
      result.duplicates!.push(...(response.duplicates ?? []) as NonNullable<SaveResult["duplicates"]>);
    }
    return result;
  }
}

export async function beginRun(
  rpc: RpcClient,
  input: { trigger_type: "manual" | "scheduled" | "local_validation"; requested_sources: string[]; code_version: string },
): Promise<string> {
  const response = await rpc.call("news_discovery_begin_run", input) as { run_id?: unknown };
  if (typeof response?.run_id !== "string") throw new NewsDiscoveryDbError("DB_RPC_BAD_RESPONSE:begin_run", null, false);
  return response.run_id;
}

export type RunSourceRecord = {
  source_id: string;
  policy: string;
  outcome: "ok" | "partial" | "failed" | "refused";
  requests: unknown[];
  raw_items: number;
  filtered: number;
  normalized: number;
  duplicates: number;
  inserted: number;
  with_published_at: number;
  with_topic: number;
  with_confirmed_ticker: number;
  duration_ms: number;
};

export async function finishRun(
  rpc: RpcClient,
  input: {
    run_id: string;
    status: "completed" | "completed_with_errors" | "failed";
    /**
     * Client-side counts. Search usage (search_count, ai_calls, web_search_calls, results, persisted
     * useful signals) and inserted_count are NOT taken from here: finish_run derives them from the
     * search rows and persisted signals, so a failed run still shows what was actually spent.
     */
    totals: Record<string, number>;
    sources: RunSourceRecord[];
    error_summary: string | null;
    /** Deadline / progress facts (deadline_reached, sources/searches completed or skipped, ...). */
    execution?: Record<string, number | boolean>;
  },
): Promise<boolean> {
  const response = await rpc.call("news_discovery_finish_run", input) as { finished?: unknown };
  return response?.finished === true;
}

/**
 * Search budget backed by news_discovery_reserve_search / news_discovery_complete_search. The DB
 * function takes an advisory lock, reads the soft budget / hard cap from
 * news_discovery_search_config and applies the cooldown / escalation rules, so concurrent runs
 * can never exceed the hard cap.
 */
export class SupabaseSearchBudget implements SearchBudget {
  constructor(private readonly rpc: RpcClient) {}

  async reserve(request: SearchRequest & { run_id: string; provider: string; model: string }): Promise<ReserveResult> {
    const response = await this.rpc.call("news_discovery_reserve_search", {
      run_id: request.run_id,
      lane: request.lane,
      reason: request.reason,
      query: request.query.slice(0, 500),
      search_key: request.search_key.slice(0, 200),
      triggered_by: request.triggered_by?.slice(0, 200) ?? null,
      parent_search_id: request.parent_search_id,
      provider: request.provider,
      model: request.model,
    }) as Partial<ReserveResult> & { search_id?: unknown; reason?: unknown };
    if (response?.allowed === true && typeof response.search_id === "string") {
      return { allowed: true, search_id: response.search_id, searches_today: Number(response.searches_today ?? 0) };
    }
    if (response?.allowed === false && typeof response.reason === "string") {
      return { allowed: false, reason: response.reason as Extract<ReserveResult, { allowed: false }>["reason"], searches_today: Number(response.searches_today ?? 0) };
    }
    throw new NewsDiscoveryDbError("DB_RPC_BAD_RESPONSE:reserve_search", null, false);
  }

  async complete(completion: SearchCompletion): Promise<void> {
    await this.rpc.call("news_discovery_complete_search", {
      search_id: completion.search_id,
      status: completion.status,
      error_code: completion.error_code,
      result_count: completion.result_count,
      new_signal_count: completion.new_signal_count,
      useful_signal_count: completion.useful_signal_count,
      duplicate_count: completion.duplicate_count,
      restricted_count: completion.restricted_count,
      policy_blocked_count: completion.policy_blocked_count,
      rejected_unverified_count: completion.rejected_unverified_count,
      model_calls: completion.usage.model_calls,
      web_search_calls: completion.usage.web_search_calls,
      input_tokens: completion.usage.input_tokens,
      output_tokens: completion.usage.output_tokens,
    });
  }
}
