// DB writers for Facts (market_events, market_metrics). All functions take
// an injectable `fetchImpl` (same DI pattern as _shared/x_oauth2_post.ts and
// stocks-master-sync/index.ts) so this module is fully unit-testable
// without a real database.
//
// Deliberately NOT a single "apply many rows" RPC like
// apply_stocks_master_sync: unlike the JPX sync (which needs a delist-guard
// transaction spanning the whole snapshot), each market_events/
// market_metrics row is independent, so a plain per-row PostgREST
// insert/upsert is simpler, safer, and matches how important-news-monitor's
// index.ts already writes important_news_candidates one row at a time.
import type { FinalizedMarketEvent, NormalizedMarketMetric } from "./mic_normalize_logic.ts";

export type RestContext = { supabaseUrl: string; secretKey: string };

export function restHeaders(secretKey: string, prefer?: string): Record<string, string> {
  return {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

export function safeErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : "UNEXPECTED_ERROR";
  return value.slice(0, 500);
}

export type WriteMarketEventResult =
  | { outcome: "inserted"; id: string }
  | { outcome: "duplicate"; id: string | null };

// Inserts one market_events row. On a unique-violation (409) against
// content_hash -- i.e. this exact fact is already known -- this does NOT
// retry as a second row; it looks the existing row up by content_hash and
// reports it as a duplicate, mirroring important-news-monitor/index.ts's
// insertCandidate 409-retry dance.
export async function writeMarketEvent(
  ctx: RestContext,
  event: FinalizedMarketEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<WriteMarketEventResult> {
  const body = {
    occurred_at: event.occurredAt,
    published_at: event.publishedAt,
    event_type: event.eventType,
    category: event.category,
    subcategory: event.subcategory ?? null,
    country: event.country ?? null,
    region: event.region ?? null,
    entity_type: event.entityType ?? null,
    entity_id: event.entityId ?? null,
    ticker: event.ticker ?? null,
    sector: event.sector ?? null,
    title: event.title,
    summary: event.summary,
    source_name: event.sourceName,
    source_url: event.sourceUrl,
    source_key: event.sourceKey,
    source_timestamp: event.sourceTimestamp ?? null,
    importance: event.importance ?? null,
    market_direction: event.marketDirection ?? null,
    confidence: event.confidence ?? null,
    raw_payload: event.rawPayload ?? null,
    content_hash: event.contentHash,
    dedupe_key: event.dedupeKey,
  };

  const result = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/market_events`, {
    method: "POST",
    headers: restHeaders(ctx.secretKey, "return=representation"),
    body: JSON.stringify(body),
  });

  if (result.status === 409) {
    const existing = await fetchImpl(
      `${ctx.supabaseUrl}/rest/v1/market_events` +
        `?content_hash=eq.${encodeURIComponent(event.contentHash)}&select=id&limit=1`,
      { headers: restHeaders(ctx.secretKey) },
    );
    if (!existing.ok) {
      throw new Error(`MARKET_EVENT_DUPLICATE_LOOKUP_FAILED:${existing.status}`);
    }
    const rows = await existing.json() as Array<{ id?: unknown }>;
    const id = typeof rows[0]?.id === "string" ? rows[0].id : null;
    return { outcome: "duplicate", id };
  }

  if (!result.ok) {
    throw new Error(`MARKET_EVENT_INSERT_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }

  const rows = await result.json() as Array<{ id?: unknown }>;
  const id = rows[0]?.id;
  if (typeof id !== "string") {
    throw new Error("MARKET_EVENT_INSERT_RESPONSE_MISSING_ID");
  }
  return { outcome: "inserted", id };
}

export type UpsertMarketMetricResult = { outcome: "upserted" };

// Upserts one market_metrics row keyed on (metric_key, source_key,
// dedupe_anchor_at) -- a generated column, never set directly by this
// writer (see the migration's column comment). Re-ingesting the exact same
// observation from the same source is expected (every adapter run
// re-fetches "latest"), so this is a merge-duplicates upsert, not an
// insert-or-fail -- the value for a given key triple is deterministic, so
// overwriting with a republished value is a safe no-op in practice, and
// refreshes fetched_at/metadata.
export async function upsertMarketMetric(
  ctx: RestContext,
  metric: NormalizedMarketMetric,
  fetchImpl: typeof fetch = fetch,
): Promise<UpsertMarketMetricResult> {
  const body = {
    metric_key: metric.metricKey,
    value: metric.value,
    unit: metric.unit,
    observed_date: metric.observedDate,
    observed_at: metric.observedAt,
    time_precision: metric.timePrecision,
    fetched_at: metric.fetchedAt,
    source_key: metric.sourceKey,
    provider: metric.provider,
    source_url: metric.sourceUrl,
    is_delayed: metric.isDelayed,
    delay_minutes: metric.delayMinutes,
    quality_tier: metric.qualityTier,
    is_official: metric.isOfficial,
    metadata: metric.metadata ?? null,
  };

  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/market_metrics?on_conflict=metric_key,source_key,dedupe_anchor_at`,
    {
      method: "POST",
      headers: restHeaders(ctx.secretKey, "resolution=merge-duplicates,return=minimal"),
      body: JSON.stringify(body),
    },
  );

  if (!result.ok) {
    throw new Error(`MARKET_METRIC_UPSERT_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  return { outcome: "upserted" };
}
