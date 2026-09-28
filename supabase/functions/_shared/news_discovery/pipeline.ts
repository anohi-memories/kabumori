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
  isFuture,
  normalizeTitle,
  parseTimestamp,
  sha256Hex,
  truncateHint,
  urlDedupeKey,
} from "./normalize.ts";
import { InMemoryNewsSignalStore, type DedupeHit, type NewsSignalStore } from "./store.ts";
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

export type NormalizeDrop = { dropped: true; reason: "invalid_url" | "empty_title" | "filtered"; detail: string };

export async function normalizeItem(
  source: SourceDefinition,
  item: RawItem,
  context: { fetchedAt: string; now: Date; aliasIndex: AliasIndex | null; discoveredVia: string; feedUrl: string; itemIndex: number },
): Promise<NewsSignal | NormalizeDrop> {
  const filtered = filterItem(source, item);
  if (!filtered.keep) return { dropped: true, reason: "filtered", detail: filtered.reason };
  const canonical = canonicalizeUrl(item.link, context.feedUrl);
  if (!canonical) return { dropped: true, reason: "invalid_url", detail: item.link.slice(0, 120) };
  const title = item.title.replace(/\s+/g, " ").trim();
  if (!title) return { dropped: true, reason: "empty_title", detail: canonical };

  const published = parseTimestamp(item.published_raw);
  const updated = parseTimestamp(item.updated_raw);
  const seen = parseTimestamp(item.seen_raw);
  const flags: VerificationFlag[] = [];
  if (!published) flags.push("no_published_at");
  if (published?.precision === "date") flags.push("date_only_precision");
  if (isFuture(published, context.now) || isFuture(updated, context.now)) flags.push("future_timestamp");
  if (source.discovery_only) flags.push("discovery_only_needs_primary");

  const summaryAllowed = source.headline_storage_allowed && !source.discovery_only;
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
  const fingerprint = await sha256Hex(`${source.source_id}\u0000${item.external_id ?? `${urlKey}\u0000${titleFingerprint}`}`);
  const imageAllowed = source.image_usage_allowed && !source.discovery_only;

  return {
    id: fingerprint,
    source_id: source.source_id,
    source_type: source.source_type,
    policy: source.policy,
    source_url: item.link,
    canonical_url: canonical,
    external_id: item.external_id,
    title,
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
export function assignSameEventGroup(signal: NewsSignal, recent: readonly NewsSignal[]): string | null {
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
};

export type DiscoveryRunResult = {
  started_at: string;
  finished_at: string;
  signals: NewsSignal[]; // kept (new) signals of this run
  duplicates: Array<{ source_id: string; title: string; reason: DedupeHit["reason"]; duplicate_of: string }>;
  stats: SourceStats[];
  totals: Omit<SourceStats, "source_id" | "policy" | "failures"> & { failed_requests: number };
  ai_calls: 0;
  web_search_calls: 0;
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
  };
}

export async function runDiscovery(options: RunOptions): Promise<DiscoveryRunResult> {
  const now = options.now ?? (() => new Date());
  const gate = options.gate ?? new HostRateGate();
  const startedAt = now().toISOString();
  const batch = new InMemoryNewsSignalStore(signalUrlKey);
  const kept: NewsSignal[] = [];
  const duplicates: DiscoveryRunResult["duplicates"] = [];
  const stats: SourceStats[] = [];
  const recent = await options.store.recent(now().getTime() - SAME_EVENT_WINDOW_MS);

  for (const source of options.sources) {
    const sourceStats = emptyStats(source);
    stats.push(sourceStats);
    const requests: Array<{ url: string; via: string }> = source.source_type === "gdelt_doc_json"
      ? (options.gdeltQueries ?? GDELT_DISCOVERY_QUERIES).map((query) => ({ url: gdeltQueryUrl(source, query), via: `gdelt:${query.key}` }))
      : [{ url: source.endpoint, via: `feed:${source.source_id}` }];

    for (const request of requests) {
      sourceStats.requests += 1;
      // Isolation: fetchSource never throws for source failures; anything unexpected is recorded too.
      let result;
      try {
        result = await fetchSource(source, { fetchImpl: options.fetchImpl, gate, now, validators: options.validators, url: request.url });
      } catch (error) {
        sourceStats.failures.push({ code: "NETWORK_ERROR", status: null, detail: error instanceof Error ? error.message.slice(0, 120) : "unexpected" });
        continue;
      }
      if (!result.ok) {
        sourceStats.failures.push({ code: result.code, status: result.status, detail: result.detail });
        continue;
      }
      sourceStats.bytes += result.bytes;
      const items = result.items.slice(0, options.maxItemsPerSource ?? result.items.length);
      sourceStats.raw_items += items.length;

      for (const [itemIndex, item] of items.entries()) {
        const normalized = await normalizeItem(source, item, {
          fetchedAt: result.fetched_at,
          now: now(),
          aliasIndex: options.aliasIndex,
          discoveredVia: request.via,
          feedUrl: request.url,
          itemIndex,
        });
        if ("dropped" in normalized) {
          if (normalized.reason === "filtered") sourceStats.filtered += 1;
          else sourceStats.normalize_failed += 1;
          continue;
        }
        sourceStats.normalized += 1;
        const titleUsable = [...normalizeTitle(normalized.title)].length >= MIN_TITLE_FINGERPRINT_CHARS;
        const lookup = {
          canonical_url: normalized.canonical_url,
          url_key: signalUrlKey(normalized),
          source_id: normalized.source_id,
          external_id: normalized.external_id,
          title_fingerprint: titleUsable ? normalized.title_fingerprint : null,
          title_fingerprint_any: normalized.title_fingerprint,
          since_ms: now().getTime() - TITLE_DEDUPE_WINDOW_MS,
        };
        const hit = (await batch.findDuplicate(lookup)) ?? (await options.store.findDuplicate(lookup));
        if (hit) {
          sourceStats.duplicates[hit.reason] += 1;
          duplicates.push({ source_id: source.source_id, title: normalized.title, reason: hit.reason, duplicate_of: hit.signal_id });
          continue;
        }
        normalized.same_event_group = assignSameEventGroup(normalized, [...recent, ...kept]);
        await batch.save([normalized]);
        kept.push(normalized);
        sourceStats.kept += 1;
        if (normalized.published_at) sourceStats.with_published_at += 1;
        if (normalized.published_at_precision === "datetime") sourceStats.with_published_datetime += 1;
        if (normalized.published_at || normalized.updated_at || normalized.detected_at) sourceStats.with_any_timestamp += 1;
        if (normalized.image_url) sourceStats.with_image_url += 1;
        if (normalized.ticker_candidates.some((c) => c.status === "confirmed")) sourceStats.with_confirmed_ticker += 1;
        else if (normalized.ticker_candidates.length > 0) sourceStats.with_candidate_ticker_only += 1;
        if (normalized.topics.length > 0) sourceStats.with_topic += 1;
      }
    }
  }

  await options.store.save(kept);
  const sum = (pick: (s: SourceStats) => number) => stats.reduce((total, s) => total + pick(s), 0);
  return {
    started_at: startedAt,
    finished_at: now().toISOString(),
    signals: kept,
    duplicates,
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
    },
    ai_calls: 0,
    web_search_calls: 0,
  };
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
