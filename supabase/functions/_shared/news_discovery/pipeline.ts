// Discovery pipeline: fetch -> normalize -> dedupe -> topics/entities -> tickers -> signal pool.
//
// No AI call and no Web Search anywhere in this file. Items that might deserve a search only get a
// `needs_verification` flag. Nothing here publishes, notifies or writes to production tables.
import { type AliasIndex, matchTickers } from "./company_alias.ts";
import {
  type FetchImpl,
  fetchSource,
  GDELT_DISCOVERY_QUERIES,
  type GdeltQuery,
  gdeltQueryUrl,
  HostRateGate,
  type ValidatorCache,
} from "./fetcher.ts";
import {
  canonicalizeUrl,
  resolveHttpUrl,
  isFuture,
  isStale,
  normalizeTitle,
  parseTimestamp,
  sha256Hex,
  truncateHint,
  urlDedupeKey,
} from "./normalize.ts";
import type { RunDeadline } from "./run_deadline.ts";
import { type DedupeHit, type DuplicateLookup, InMemoryNewsSignalStore, type NewsSignalStore, type SaveResult } from "./store.ts";
import { classifyTopics, extractEntities } from "./topics.ts";
import type { FetchFailureCode, NewsSignal, RawItem, SourceDefinition, VerificationFlag } from "./types.ts";

/** JMA telegram titles worth observing (eqvol feed). Routine forecasts are dropped before normalizing. */
export const JMA_EQVOL_MATERIAL_TITLES: readonly RegExp[] = [
  /震度速報/,
  /震源・震度に関する情報/,
  /津波警報|津波注意報|津波情報/,
  /噴火警報|噴火速報/,
  /南海トラフ地震/,
  /後発地震注意情報/,
  /長周期地震動に関する観測情報/,
];
/** extra feed: the generic title "気象特別警報・警報・注意報" is used for routine warnings too. */
export const JMA_EXTRA_MATERIAL_TITLES: readonly RegExp[] = [/記録的短時間大雨情報/, /土砂災害警戒情報/, /竜巻注意情報/];
const JMA_EXTRA_SPECIAL_WARNING = /特別警報(?!・警報・注意報)/;

export type ItemFilterResult = { keep: true } | { keep: false; reason: string };

export function filterItem(source: SourceDefinition, item: RawItem): ItemFilterResult {
  if (source.source_id === "jp_jma_eqvol") {
    return JMA_EQVOL_MATERIAL_TITLES.some((pattern) => pattern.test(item.title))
      ? { keep: true }
      : { keep: false, reason: "jma_routine_telegram" };
  }
  if (source.source_id === "jp_jma_extra") {
    const text = `${item.title} ${item.summary ?? ""}`;
    return JMA_EXTRA_MATERIAL_TITLES.some((pattern) => pattern.test(item.title)) || JMA_EXTRA_SPECIAL_WARNING.test(text)
      ? { keep: true }
      : { keep: false, reason: "jma_routine_telegram" };
  }
  return { keep: true };
}

/** Titles shorter than this are too generic ("震度速報", "Press Release") to dedupe on. */
export const MIN_TITLE_FINGERPRINT_CHARS = 15;
export const TITLE_DEDUPE_WINDOW_MS = 72 * 60 * 60 * 1000;
export const SAME_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SAME_EVENT_MIN_SIMILARITY = 0.6;

export function signalUrlKey(signal: Pick<NewsSignal, "canonical_url">): string {
  return urlDedupeKey(signal.canonical_url);
}

export type NormalizeDrop = { dropped: true; reason: "invalid_url" | "empty_title" | "filtered" | "stale"; detail: string };

export async function normalizeItem(
  source: SourceDefinition,
  item: RawItem,
  context: { fetchedAt: string; now: Date; aliasIndex: AliasIndex | null; discoveredVia: string; feedUrl: string; itemIndex: number },
): Promise<NewsSignal | NormalizeDrop> {
  const filtered = filterItem(source, item);
  if (!filtered.keep) return { dropped: true, reason: "filtered", detail: filtered.reason };
  // Resolve the raw feed link once: this absolute http(s) URL is what is stored as source_url
  // (the DB requires ^https?://). An unresolvable link drops only this item, never the batch.
  const sourceUrl = resolveHttpUrl(item.link, context.feedUrl);
  const canonical = sourceUrl ? canonicalizeUrl(sourceUrl) : null;
  if (!sourceUrl || !canonical) return { dropped: true, reason: "invalid_url", detail: item.link.slice(0, 120) };
  const title = item.title.replace(/\s+/g, " ").trim();
  if (!title) return { dropped: true, reason: "empty_title", detail: canonical };

  const published = parseTimestamp(item.published_raw);
  const updated = parseTimestamp(item.updated_raw);
  const seen = parseTimestamp(item.seen_raw);
  // Freshness guard (DIRECT sources): old feed backlog is not new news. detected_at (GDELT/search
  // first-seen) is deliberately not used here.
  if (source.max_item_age_days !== null && isStale(published, updated, context.now, source.max_item_age_days)) {
    return { dropped: true, reason: "stale", detail: (published ?? updated)!.iso };
  }
  const flags: VerificationFlag[] = [];
  if (!published) flags.push("no_published_at");
  if (published?.precision === "date") flags.push("date_only_precision");
  if (isFuture(published, context.now) || isFuture(updated, context.now)) flags.push("future_timestamp");
  if (source.discovery_only) flags.push("discovery_only_needs_primary");

  const summaryAllowed = source.headline_storage_allowed && !source.discovery_only;
  // A guid that is just the item URL is not a stable id: ESRI reuses one URL for new releases.
  const externalId = item.external_id && canonicalizeUrl(item.external_id, context.feedUrl) !== canonical
    ? item.external_id
    : null;
  const summaryHint = summaryAllowed ? truncateHint(item.summary) : null;
  const text = `${title}\n${summaryHint ?? ""}`;
  const tickers = context.aliasIndex
    ? matchTickers({ title, summary: summaryHint, structured_ticker: item.structured_ticker }, context.aliasIndex)
    : [];
  if (tickers.length > 0 && tickers.every((ticker) => ticker.status === "candidate")) flags.push("weak_ticker_only");

  const urlKey = urlDedupeKey(canonical);
  const normalizedTitle = normalizeTitle(title);
  const titleFingerprint = (await sha256Hex(normalizedTitle)).slice(0, 32);
  // Without a source id, URL + title identify the item (a source may reuse one URL for new items).
  const fingerprint = await sha256Hex(`${source.source_id}\u0000${externalId ?? `${urlKey}\u0000${titleFingerprint}`}`);
  const imageAllowed = source.image_usage_allowed && !source.discovery_only;

  return {
    id: fingerprint,
    source_id: source.source_id,
    source_type: source.source_type,
    policy: source.policy,
    source_url: sourceUrl,
    canonical_url: canonical,
    external_id: externalId,
    title,
    title_display_allowed: !source.discovery_only && source.headline_storage_allowed &&
      source.commercial_usage_status.startsWith("allowed"),
    summary_hint: summaryHint,
    published_at: published?.iso ?? null,
    published_at_precision: published?.precision ?? null,
    updated_at: updated?.iso ?? null,
    detected_at: seen?.iso ?? null,
    fetched_at: context.fetchedAt,
    language: item.language ?? source.language,
    country: item.country ?? source.country,
    publisher: item.publisher ?? source.operator,
    topics: classifyTopics(text, source.default_topics),
    entities: extractEntities(text),
    ticker_candidates: tickers,
    // The feed's own image URL is recorded (never downloaded) only when the source allows images.
    image_url: imageAllowed ? item.image_url : null,
    image_source: imageAllowed && item.image_url ? "feed_media" : null,
    image_usage_allowed: imageAllowed,
    discovery_only: source.discovery_only,
    restricted_publisher: false,
    search_id: null,
    discovered_via: context.discoveredVia,
    raw_reference: { feed_url: context.feedUrl, item_index: context.itemIndex },
    fingerprint,
    title_fingerprint: titleFingerprint,
    same_event_group: null,
    needs_verification: flags,
  };
}

function bigrams(value: string): Set<string> {
  const chars = [...value];
  const out = new Set<string>();
  for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

/**
 * Japanese headlines differ mostly in particles and okurigana ("日銀が利上げを決定" / "日銀、利上げ決定"),
 * so hiragana is dropped before comparing when the title also has kanji/katakana.
 */
function similarityKey(title: string): string {
  const normalized = normalizeTitle(title);
  return /[\p{Script=Han}\p{Script=Katakana}]/u.test(normalized) ? normalized.replace(/\p{Script=Hiragana}/gu, "") : normalized;
}

export function titleSimilarity(a: string, b: string): number {
  const x = bigrams(similarityKey(a));
  const y = bigrams(similarityKey(b));
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/**
 * Cheap same-event grouping (no AI): a signal joins the group of an earlier signal from a
 * *different* source when their titles are similar or they name the same confirmed ticker within
 * the window and share a topic. The group id is the earliest member's id.
 */
/** The fields same-event grouping needs; a DB store returns only these for recent signals. */
export type GroupingSignal = Pick<NewsSignal, "id" | "source_id" | "title" | "fetched_at" | "topics" | "same_event_group"> & {
  ticker_candidates: ReadonlyArray<Pick<NewsSignal["ticker_candidates"][number], "ticker" | "status">>;
};

export function assignSameEventGroup(signal: GroupingSignal, recent: readonly GroupingSignal[]): string | null {
  const at = Date.parse(signal.fetched_at);
  const tickers = new Set(signal.ticker_candidates.filter((c) => c.status === "confirmed").map((c) => c.ticker));
  for (const other of recent) {
    if (other.id === signal.id || other.source_id === signal.source_id) continue;
    if (Math.abs(Date.parse(other.fetched_at) - at) > SAME_EVENT_WINDOW_MS) continue;
    const similar = titleSimilarity(signal.title, other.title) >= SAME_EVENT_MIN_SIMILARITY;
    const sameTicker = other.ticker_candidates.some((c) => c.status === "confirmed" && tickers.has(c.ticker)) &&
      other.topics.some((topic) => signal.topics.includes(topic));
    if (similar || sameTicker) return other.same_event_group ?? other.id;
  }
  return null;
}

export type SourceStats = {
  source_id: string;
  policy: SourceDefinition["policy"];
  requests: number;
  failures: Array<{ code: FetchFailureCode; status: number | null; detail: string }>;
  raw_items: number;
  filtered: number;
  normalize_failed: number;
  normalized: number;
  duplicates: Record<DedupeHit["reason"], number>;
  kept: number;
  with_published_at: number;
  with_published_datetime: number;
  with_any_timestamp: number;
  with_image_url: number;
  with_confirmed_ticker: number;
  with_candidate_ticker_only: number;
  with_topic: number;
  bytes: number;
  inserted: number;
  insert_conflicts: number;
  duration_ms: number;
  /** One entry per HTTP request: codes and counts only (never article text). */
  request_log: Array<{ via: string; outcome: "ok" | "not_modified" | "DEADLINE_SKIPPED" | FetchFailureCode; http_status: number | null; duration_ms: number; items: number; detail: string | null }>;
  /** Requests not started because the run deadline left no usable time (not a source failure). */
  skipped_deadline: number;
  /** Items dropped by the freshness guard (also counted in `filtered`). */
  stale_filtered: number;
};

export type DiscoveryRunResult = {
  started_at: string;
  finished_at: string;
  signals: NewsSignal[]; // kept (new) signals of this run
  duplicates: Array<{ source_id: string; title: string; reason: DedupeHit["reason"]; duplicate_of: string }>;
  stats: SourceStats[];
  totals: Omit<SourceStats, "source_id" | "policy" | "failures" | "request_log" | "duration_ms"> & { failed_requests: number };
  db_duplicates: number;
  /** Model calls and web_search tool calls (only the search stage makes any). */
  ai_calls: number;
  web_search_calls: number;
};

export type RunOptions = {
  sources: readonly SourceDefinition[];
  store: NewsSignalStore;
  aliasIndex: AliasIndex | null;
  fetchImpl?: FetchImpl;
  now?: () => Date;
  gate?: HostRateGate;
  validators?: ValidatorCache;
  gdeltQueries?: readonly GdeltQuery[];
  /** Cap on items processed per source per run (keeps sample runs small). */
  maxItemsPerSource?: number;
  /** Structured per-source log line (codes and counts only). */
  log?: (line: Record<string, unknown>) => void;
  /** Invocation deadline: no request starts without usable time; timeouts are capped. */
  deadline?: RunDeadline;
};

function emptyStats(source: SourceDefinition): SourceStats {
  return {
    source_id: source.source_id,
    policy: source.policy,
    requests: 0,
    failures: [],
    raw_items: 0,
    filtered: 0,
    normalize_failed: 0,
    normalized: 0,
    duplicates: { canonical_url: 0, normalized_url: 0, source_external_id: 0, title_fingerprint: 0 },
    kept: 0,
    with_published_at: 0,
    with_published_datetime: 0,
    with_any_timestamp: 0,
    with_image_url: 0,
    with_confirmed_ticker: 0,
    with_candidate_ticker_only: 0,
    with_topic: 0,
    bytes: 0,
    inserted: 0,
    insert_conflicts: 0,
    duration_ms: 0,
    request_log: [],
    skipped_deadline: 0,
    stale_filtered: 0,
  };
}

/**
 * State of one observer run. Feed fetching and Web Search results both go through ingest(), so
 * normalization, dedupe (in-run and against the pool), grouping and stats are identical for every
 * kind of source. Nothing is written until finish().
 */
export class DiscoveryRun {
  readonly startedAt: string;
  readonly kept: NewsSignal[] = [];
  readonly duplicates: DiscoveryRunResult["duplicates"] = [];
  readonly stats: SourceStats[] = [];
  #batch = new InMemoryNewsSignalStore(signalUrlKey);
  #recent: GroupingSignal[] = [];
  #aiCalls = 0;
  /** Signals already handed to the store (persisted, or resolved as conflicts / DB duplicates). */
  #resolved = new Set<string>();
  #insertedIds = new Set<string>();
  #dbDuplicates = 0;
  #webSearchCalls = 0;
  readonly now: () => Date;

  private constructor(private readonly options: RunOptions) {
    this.now = options.now ?? (() => new Date());
    this.startedAt = this.now().toISOString();
  }

  static async start(options: RunOptions): Promise<DiscoveryRun> {
    const run = new DiscoveryRun(options);
    run.#recent = await options.store.recent(run.now().getTime() - SAME_EVENT_WINDOW_MS);
    return run;
  }

  get store(): NewsSignalStore {
    return this.options.store;
  }

  /** Recent pool signals plus this run's new signals (for trigger planning / grouping). */
  get context(): readonly GroupingSignal[] {
    return [...this.#recent, ...this.kept];
  }

  statsFor(source: SourceDefinition): SourceStats {
    let found = this.stats.find((entry) => entry.source_id === source.source_id);
    if (!found) {
      found = emptyStats(source);
      this.stats.push(found);
    }
    return found;
  }

  /** Model / web-search calls made by the search stage (the feed stage makes none). */
  recordUsage(aiCalls: number, webSearchCalls: number): void {
    this.#aiCalls += aiCalls;
    this.#webSearchCalls += webSearchCalls;
  }

  async fetchSources(sources: readonly SourceDefinition[]): Promise<void> {
    const gate = this.options.gate ?? new HostRateGate();
    for (const source of sources) {
      const sourceStats = this.statsFor(source);
      const sourceStarted = Date.now();
      const requests: Array<{ url: string; via: string }> = source.source_type === "gdelt_doc_json"
        ? (this.options.gdeltQueries ?? GDELT_DISCOVERY_QUERIES).map((query) => ({ url: gdeltQueryUrl(source, query), via: `gdelt:${query.key}` }))
        : [{ url: source.endpoint, via: `feed:${source.source_id}` }];

      for (const request of requests) {
        const deadline = this.options.deadline;
        if (deadline && !deadline.canStartFetch()) {
          // No usable time left: do not start the request; the reserve stays for persisting.
          sourceStats.skipped_deadline += 1;
          sourceStats.request_log.push({ via: request.via, outcome: "DEADLINE_SKIPPED", http_status: null, duration_ms: 0, items: 0, detail: null });
          continue;
        }
        sourceStats.requests += 1;
        const requestStarted = Date.now();
        // Isolation: fetchSource never throws for source failures; anything unexpected is recorded too.
        let result;
        try {
          result = await fetchSource(source, {
            fetchImpl: this.options.fetchImpl,
            gate,
            now: this.now,
            validators: this.options.validators,
            url: request.url,
            timeoutMs: deadline ? deadline.capTimeout(source.timeout_ms) : undefined,
          });
        } catch (error) {
          result = {
            source_id: source.source_id,
            ok: false as const,
            code: "NETWORK_ERROR" as const,
            status: null,
            detail: error instanceof Error ? error.name.slice(0, 120) : "unexpected",
            fetched_at: this.now().toISOString(),
          };
        }
        const requestMs = Date.now() - requestStarted;
        if (!result.ok) {
          sourceStats.failures.push({ code: result.code, status: result.status, detail: result.detail });
          sourceStats.request_log.push({ via: request.via, outcome: result.code, http_status: result.status, duration_ms: requestMs, items: 0, detail: result.detail });
          continue;
        }
        sourceStats.bytes += result.bytes;
        const items = result.items.slice(0, this.options.maxItemsPerSource ?? result.items.length);
        sourceStats.request_log.push({
          via: request.via,
          outcome: result.not_modified ? "not_modified" : "ok",
          http_status: result.status,
          duration_ms: requestMs,
          items: items.length,
          detail: null,
        });
        await this.ingest(source, items, { via: request.via, feedUrl: request.url, fetchedAt: result.fetched_at });
      }
      sourceStats.duration_ms += Date.now() - sourceStarted;
      if (this.options.deadline) {
        if (sourceStats.skipped_deadline > 0) this.options.deadline.stats.sources_skipped += 1;
        else this.options.deadline.stats.sources_completed += 1;
      }
    }
  }

  /**
   * Hand not-yet-persisted signals to the store now (all pending ones, or just `signals`). Used to
   * flush feed signals before the search stage and each search's signals before its search row is
   * completed, so persisted counts are real. Throws if the store cannot write; those signals stay
   * pending (a later persist retries the DB write — never the search).
   */
  async persist(signals?: readonly NewsSignal[]): Promise<SaveResult> {
    const pending = (signals ?? this.kept).filter((signal) => !this.#resolved.has(signal.id));
    if (pending.length === 0) return { inserted: [], conflicted: [], duplicates: [] };
    const saved = await this.options.store.save(pending);
    const result: SaveResult = saved ?? { inserted: pending.map((signal) => signal.id), conflicted: [] };
    for (const signal of pending) this.#resolved.add(signal.id);
    for (const id of result.inserted) this.#insertedIds.add(id);
    this.#dbDuplicates += result.duplicates?.length ?? 0;
    return result;
  }

  get persistedCount(): number {
    return this.#insertedIds.size;
  }

  /** Usage so far (for a failed run's final record). */
  get usage(): { ai_calls: number; web_search_calls: number } {
    return { ai_calls: this.#aiCalls, web_search_calls: this.#webSearchCalls };
  }

  /**
   * normalize -> one batched lookup against the pool -> in-run dedupe in order. Returns the new
   * (non-duplicate) signals. `decorate` may adjust a normalized signal (search metadata) before dedupe.
   */
  async ingest(
    source: SourceDefinition,
    items: readonly RawItem[],
    meta: { via: string; feedUrl: string; fetchedAt: string; decorate?: (signal: NewsSignal, item: RawItem) => NewsSignal | null },
  ): Promise<NewsSignal[]> {
    const sourceStats = this.statsFor(source);
    sourceStats.raw_items += items.length;
    const prepared: Array<{ signal: NewsSignal; lookup: DuplicateLookup }> = [];
    for (const [itemIndex, item] of items.entries()) {
      const normalized = await normalizeItem(source, item, {
        fetchedAt: meta.fetchedAt,
        now: this.now(),
        aliasIndex: this.options.aliasIndex,
        discoveredVia: meta.via,
        feedUrl: meta.feedUrl,
        itemIndex,
      });
      if ("dropped" in normalized) {
        if (normalized.reason === "filtered" || normalized.reason === "stale") sourceStats.filtered += 1;
        else sourceStats.normalize_failed += 1;
        if (normalized.reason === "stale") sourceStats.stale_filtered += 1;
        continue;
      }
      const decorated = meta.decorate ? meta.decorate(normalized, item) : normalized;
      if (!decorated) {
        sourceStats.filtered += 1;
        continue;
      }
      sourceStats.normalized += 1;
      const titleUsable = [...normalizeTitle(decorated.title)].length >= MIN_TITLE_FINGERPRINT_CHARS;
      prepared.push({
        signal: decorated,
        lookup: {
          canonical_url: decorated.canonical_url,
          url_key: signalUrlKey(decorated),
          source_id: decorated.source_id,
          external_id: decorated.external_id,
          title_fingerprint: titleUsable ? decorated.title_fingerprint : null,
          title_fingerprint_any: decorated.title_fingerprint,
          since_ms: this.now().getTime() - TITLE_DEDUPE_WINDOW_MS,
        },
      });
    }
    const store = this.options.store;
    const poolHits = store.findDuplicates
      ? await store.findDuplicates(prepared.map((entry) => entry.lookup))
      : await Promise.all(prepared.map((entry) => store.findDuplicate(entry.lookup)));

    const fresh: NewsSignal[] = [];
    for (const [index, { signal: normalized, lookup }] of prepared.entries()) {
      const hit = (await this.#batch.findDuplicate(lookup)) ?? poolHits[index];
      if (hit) {
        sourceStats.duplicates[hit.reason] += 1;
        this.duplicates.push({ source_id: source.source_id, title: normalized.title, reason: hit.reason, duplicate_of: hit.signal_id });
        continue;
      }
      normalized.same_event_group = assignSameEventGroup(normalized, this.context);
      await this.#batch.save([normalized]);
      this.kept.push(normalized);
      fresh.push(normalized);
      sourceStats.kept += 1;
      if (normalized.published_at) sourceStats.with_published_at += 1;
      if (normalized.published_at_precision === "datetime") sourceStats.with_published_datetime += 1;
      if (normalized.published_at || normalized.updated_at || normalized.detected_at) sourceStats.with_any_timestamp += 1;
      if (normalized.image_url) sourceStats.with_image_url += 1;
      if (normalized.ticker_candidates.some((c) => c.status === "confirmed")) sourceStats.with_confirmed_ticker += 1;
      else if (normalized.ticker_candidates.length > 0) sourceStats.with_candidate_ticker_only += 1;
      if (normalized.topics.length > 0) sourceStats.with_topic += 1;
    }
    return fresh;
  }

  /** Persist and summarize. A store that cannot write throws: the caller decides how the run ends. */
  async finish(): Promise<DiscoveryRunResult> {
    await this.persist();
    const inserted = this.#insertedIds;
    for (const sourceStats of this.stats) {
      const own = this.kept.filter((signal) => signal.source_id === sourceStats.source_id);
      sourceStats.inserted = own.filter((signal) => inserted.has(signal.id)).length;
      sourceStats.insert_conflicts = own.length - sourceStats.inserted;
      this.options.log?.({
        event: "news_discovery_source",
        source_id: sourceStats.source_id,
        policy: sourceStats.policy,
        requests: sourceStats.request_log.map((entry) => ({ via: entry.via, outcome: entry.outcome, http_status: entry.http_status, duration_ms: entry.duration_ms })),
        fetched: sourceStats.raw_items,
        normalized: sourceStats.normalized,
        stale_filtered: sourceStats.stale_filtered,
        duplicates: Object.values(sourceStats.duplicates).reduce((a, b) => a + b, 0),
        inserted: sourceStats.inserted,
        ticker_confirmed: sourceStats.with_confirmed_ticker,
        topic_matched: sourceStats.with_topic,
        duration_ms: sourceStats.duration_ms,
      });
    }
    const stats = this.stats;
    const sum = (pick: (s: SourceStats) => number) => stats.reduce((total, s) => total + pick(s), 0);
    return {
      started_at: this.startedAt,
      finished_at: this.now().toISOString(),
      signals: this.kept,
      duplicates: this.duplicates,
      stats,
      totals: {
        requests: sum((s) => s.requests),
        failed_requests: sum((s) => s.failures.length),
        raw_items: sum((s) => s.raw_items),
        filtered: sum((s) => s.filtered),
        normalize_failed: sum((s) => s.normalize_failed),
        normalized: sum((s) => s.normalized),
        duplicates: {
          canonical_url: sum((s) => s.duplicates.canonical_url),
          normalized_url: sum((s) => s.duplicates.normalized_url),
          source_external_id: sum((s) => s.duplicates.source_external_id),
          title_fingerprint: sum((s) => s.duplicates.title_fingerprint),
        },
        kept: sum((s) => s.kept),
        with_published_at: sum((s) => s.with_published_at),
        with_published_datetime: sum((s) => s.with_published_datetime),
        with_any_timestamp: sum((s) => s.with_any_timestamp),
        with_image_url: sum((s) => s.with_image_url),
        with_confirmed_ticker: sum((s) => s.with_confirmed_ticker),
        with_candidate_ticker_only: sum((s) => s.with_candidate_ticker_only),
        with_topic: sum((s) => s.with_topic),
        bytes: sum((s) => s.bytes),
        inserted: sum((s) => s.inserted),
        insert_conflicts: sum((s) => s.insert_conflicts),
        skipped_deadline: sum((s) => s.skipped_deadline),
        stale_filtered: sum((s) => s.stale_filtered),
      },
      /** Rows the DB resolved as URL duplicates of a concurrent run's rows (subset of insert_conflicts). */
      db_duplicates: this.#dbDuplicates,
      ai_calls: this.#aiCalls,
      web_search_calls: this.#webSearchCalls,
    };
  }
}

/** Feed-only run (N2 behaviour): fetch every source, then persist. */
export async function runDiscovery(options: RunOptions): Promise<DiscoveryRunResult> {
  const run = await DiscoveryRun.start(options);
  await run.fetchSources(options.sources);
  return await run.finish();
}

/** Rates for the report (0-1, two decimals). */
export function summarizeRates(totals: DiscoveryRunResult["totals"]) {
  const rate = (n: number) => totals.kept === 0 ? 0 : Math.round((n / totals.kept) * 100) / 100;
  return {
    normalize_success_rate: totals.raw_items - totals.filtered === 0
      ? 0
      : Math.round((totals.normalized / (totals.raw_items - totals.filtered)) * 100) / 100,
    published_at_rate: rate(totals.with_published_at),
    published_datetime_rate: rate(totals.with_published_datetime),
    any_timestamp_rate: rate(totals.with_any_timestamp),
    thumbnail_rate: rate(totals.with_image_url),
    confirmed_ticker_rate: rate(totals.with_confirmed_ticker),
    topic_rate: rate(totals.with_topic),
  };
}
