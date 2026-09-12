// Shared types and pure normalization helpers for the Market Intelligence
// Core ingestion pipeline. Nothing here does network or DB I/O -- adapters
// produce the "pre-finalized" shapes below, and finalizeMarketEvent /
// metric writers attach the hash/dedupe fields before handing off to
// mic_writer_logic.ts. Keeping this provider-agnostic is deliberate: no
// adapter-specific field (e.g. a FRED series id) belongs in these types,
// only in each adapter's own `metadata`.

export type QualityTier = "official" | "official_delayed" | "trusted_free" | "fallback";
export type TimePrecision = "date" | "timestamp";

export type NormalizedMarketMetric = {
  metricKey: string;
  value: number;
  unit: string;
  // Always the calendar date the observation pertains to, exactly as given
  // by the source -- "YYYY-MM-DD", no timezone conversion invented here.
  observedDate: string;
  // Only set when the source itself reports a real sub-day timestamp.
  // MUST be null when timePrecision is "date" -- never fabricate a time of
  // day for a date-only source (e.g. do not claim a FRED daily value
  // "happened at 21:00 UTC"). See mic_writer_logic.ts / the migration's
  // dedupe_anchor_at comment for how dedupe still works safely without it.
  observedAt: string | null;
  timePrecision: TimePrecision;
  fetchedAt: string; // ISO timestamp
  sourceKey: string;
  provider: string;
  sourceUrl: string | null;
  isDelayed: boolean;
  delayMinutes: number | null;
  qualityTier: QualityTier;
  isOfficial: boolean;
  metadata?: Record<string, unknown>;
};

export type MarketEventInput = {
  occurredAt: string | null;
  publishedAt: string;
  eventType: string;
  category: string;
  subcategory?: string | null;
  country?: string | null;
  region?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  ticker?: string | null;
  sector?: string | null;
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  sourceKey: string;
  sourceTimestamp?: string | null;
  importance?: string | null;
  marketDirection?: string | null;
  confidence?: number | null;
  rawPayload?: Record<string, unknown> | null;
};

export type FinalizedMarketEvent = MarketEventInput & {
  contentHash: string;
  dedupeKey: string | null;
};

// NFKC normalization + whitespace collapse, mirroring
// important-news-monitor/news_candidate_logic.ts's normalizeText so dedupe
// behaves the same way across both pipelines.
export function normalizeText(input: string): string {
  return input.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAM_NAMES = new Set(["ref", "source", "campaign"]);

// Strips hash fragments and common tracking params, sorts the remainder,
// and collapses duplicate/trailing slashes -- same intent as
// news_candidate_logic.ts's normalizeSourceUrl, generalized beyond news
// URLs (no assumption about the URL being a news article).
export function normalizeSourceUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error(`NORMALIZE_URL_REQUIRES_HTTPS: ${rawUrl}`);
  }
  const keep: [string, string][] = [];
  for (const [key, value] of url.searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    if (TRACKING_PARAM_NAMES.has(lowerKey)) continue;
    if (TRACKING_PARAM_PREFIXES.some((prefix) => lowerKey.startsWith(prefix))) continue;
    keep.push([key, value]);
  }
  keep.sort(([a], [b]) => a.localeCompare(b));
  const search = new URLSearchParams(keep);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/{2,}/g, "/") || "/";
  const query = search.toString();
  return `https://${url.host}${path}${query ? `?${query}` : ""}`;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Same construction as important-news-monitor's content_hash: a SHA-256
// over normalized title + normalized summary + an entity identity string.
// Two adapters that independently observe the exact same fact (same title,
// same summary, same entity) produce the same hash and collide on the
// unique index, which is the point -- the writer treats that as "already
// known", not as an error.
export async function computeContentHash(
  input: { title: string; summary: string; entityIdentity: string },
): Promise<string> {
  const normalized = [
    normalizeText(input.title),
    normalizeText(input.summary),
    normalizeText(input.entityIdentity),
  ].join("|");
  return await sha256Hex(normalized);
}

export function buildDedupeKey(input: MarketEventInput): string | null {
  try {
    return normalizeSourceUrl(input.sourceUrl);
  } catch {
    return null;
  }
}

export async function finalizeMarketEvent(input: MarketEventInput): Promise<FinalizedMarketEvent> {
  const entityIdentity = input.entityId ?? input.ticker ?? input.sourceKey;
  const contentHash = await computeContentHash({
    title: input.title,
    summary: input.summary,
    entityIdentity,
  });
  return {
    ...input,
    contentHash,
    dedupeKey: buildDedupeKey(input),
  };
}
