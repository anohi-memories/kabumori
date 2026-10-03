import { BrandContextError } from "./brand_context.ts";
import { fetchRecentKabumoriFingerprints } from "./kabumori_recent_fingerprints.ts";
import type { PublishedFingerprint } from "./cross_brand_dedupe.ts";
import { AI_LAB_EVENT_KEY_PATTERN, type AiLabTopicUsage } from "./ai_lab_dev_diary_context.ts";

function serviceHeaders(serviceRoleKey: string): Record<string, string> {
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
}

export async function loadRecentPublishedFingerprints({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): Promise<PublishedFingerprint[]> {
  const params = new URLSearchParams({
    select: "brand_id,normalized_text_sha256,published_at",
    order: "published_at.desc",
    limit: "200",
  });
  const response = await fetchImpl(
    `${supabaseUrl}/rest/v1/published_content_fingerprints?${params}`,
    {
      headers: serviceHeaders(serviceRoleKey),
    },
  );
  if (!response.ok) {
    throw new BrandContextError("PUBLISHED_FINGERPRINT_READ_FAILED");
  }
  const rows = await response.json() as Array<{
    brand_id?: unknown;
    normalized_text_sha256?: unknown;
    published_at?: unknown;
  }>;
  if (!Array.isArray(rows)) {
    throw new BrandContextError("PUBLISHED_FINGERPRINT_READ_FAILED");
  }
  return rows.flatMap((row) =>
    typeof row.brand_id === "string" &&
      typeof row.normalized_text_sha256 === "string" &&
      typeof row.published_at === "string"
      ? [{
        brandId: row.brand_id,
        normalizedTextSha256: row.normalized_text_sha256,
        publishedAt: row.published_at,
      }]
      : []
  );
}

export async function loadAiLabRecentDedupeFingerprints({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): Promise<PublishedFingerprint[]> {
  const [persisted, kabumoriReports] = await Promise.all([
    loadRecentPublishedFingerprints({ supabaseUrl, serviceRoleKey, fetchImpl }),
    fetchRecentKabumoriFingerprints({
      supabaseUrl,
      serviceRoleKey,
      strict: true,
      fetchImpl,
    }),
  ]);
  return [...persisted, ...kabumoriReports];
}

/**
 * Read-only: how many AI Lab brand_post schedule rows come strictly before `scheduledFor`. Consecutive
 * posts get consecutive numbers, which is the rotation index for topic selection (no schema/RPC change,
 * no new write). Returns null on any failure so the caller can fall back instead of blocking a post.
 */
export async function countAiLabBrandPostsBefore({
  supabaseUrl,
  serviceRoleKey,
  scheduledFor,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  scheduledFor: string;
  fetchImpl?: typeof fetch;
}): Promise<number | null> {
  try {
    const params = new URLSearchParams({
      select: "id",
      brand_id: "eq.ai_salaryman_lab",
      post_type: "eq.brand_post",
      scheduled_for: `lt.${scheduledFor}`,
      limit: "1",
    });
    const response = await fetchImpl(`${supabaseUrl}/rest/v1/scheduled_posts?${params}`, {
      headers: { ...serviceHeaders(serviceRoleKey), Prefer: "count=exact" },
    });
    if (!response.ok) return null;
    const total = /\/(\d+)$/u.exec(response.headers.get("content-range") ?? "")?.[1];
    return total === undefined ? null : Number(total);
  } catch {
    return null;
  }
}

/** 使用済みイベントを振り返る期間。fresh 期間（3日）より十分長く、evergreen のクールダウン（72時間）も含む。 */
export const AI_LAB_TOPIC_USAGE_LOOKBACK_DAYS = 14;

/**
 * Read-only: AI Lab topics that were actually published within the lookback window (event keys only, no
 * post text). Returns null on any failure or malformed row so the caller fails closed (skip diary events,
 * use evergreen) instead of re-posting an event it cannot prove is unused.
 */
export async function loadAiLabTopicUsage({
  supabaseUrl,
  serviceRoleKey,
  now = new Date(),
  lookbackDays = AI_LAB_TOPIC_USAGE_LOOKBACK_DAYS,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  now?: Date;
  lookbackDays?: number;
  fetchImpl?: typeof fetch;
}): Promise<AiLabTopicUsage[] | null> {
  try {
    const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({
      select: "event_key,published_at",
      brand_id: "eq.ai_salaryman_lab",
      published_at: `gte.${since}`,
      order: "published_at.desc",
      limit: "200",
    });
    const response = await fetchImpl(`${supabaseUrl}/rest/v1/ai_lab_topic_event_usage?${params}`, {
      headers: serviceHeaders(serviceRoleKey),
    });
    if (!response.ok) return null;
    const rows = await response.json() as unknown;
    if (!Array.isArray(rows)) return null;
    const usage: AiLabTopicUsage[] = [];
    for (const row of rows) {
      const eventKey = (row as { event_key?: unknown })?.event_key;
      const publishedAt = (row as { published_at?: unknown })?.published_at;
      if (
        typeof eventKey !== "string" || !AI_LAB_EVENT_KEY_PATTERN.test(eventKey) ||
        typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt))
      ) {
        return null;
      }
      usage.push({ eventKey, publishedAt });
    }
    return usage;
  } catch {
    return null;
  }
}

/**
 * Records that `eventKey` was actually published (call only after X confirmed the post). Idempotent per
 * scheduled post (primary key + ignore-duplicates). Never throws: the X write already happened, so a
 * failure here must not reach the outer failure handler (which could re-queue the post); it only means the
 * event may be offered again, and the text-level guards remain as the second line of defense.
 */
export async function recordAiLabTopicUsage({
  supabaseUrl,
  serviceRoleKey,
  eventKey,
  unitKey,
  scheduledPostId,
  xPostId,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  eventKey: string;
  unitKey: string;
  scheduledPostId: string;
  xPostId: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  try {
    if (!AI_LAB_EVENT_KEY_PATTERN.test(eventKey)) return false;
    const response = await fetchImpl(
      `${supabaseUrl}/rest/v1/ai_lab_topic_event_usage?on_conflict=scheduled_post_id`,
      {
        method: "POST",
        headers: {
          ...serviceHeaders(serviceRoleKey),
          "Content-Type": "application/json",
          Prefer: "resolution=ignore-duplicates,return=minimal",
        },
        body: JSON.stringify({
          scheduled_post_id: scheduledPostId,
          event_key: eventKey,
          unit_key: unitKey,
          x_post_id: xPostId,
        }),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function recordAndCompleteAiLabBrandPost({
  supabaseUrl,
  serviceRoleKey,
  scheduledPostId,
  xPostId,
  normalizedTextSha256,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  scheduledPostId: string;
  xPostId: string;
  normalizedTextSha256: string;
  fetchImpl?: typeof fetch;
}): Promise<{ fingerprintPersisted: boolean }> {
  const response = await fetchImpl(
    `${supabaseUrl}/rest/v1/rpc/complete_ai_salaryman_lab_brand_post`,
    {
      method: "POST",
      headers: {
        ...serviceHeaders(serviceRoleKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_scheduled_post_id: scheduledPostId,
        p_x_post_id: xPostId,
        p_normalized_text_sha256: normalizedTextSha256,
      }),
    },
  );
  if (!response.ok) throw new BrandContextError("AI_LAB_COMPLETION_RPC_FAILED");
  const payload = await response.json() as unknown;
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (
    typeof row !== "object" || row === null ||
    typeof (row as Record<string, unknown>).fingerprint_persisted !== "boolean"
  ) {
    throw new BrandContextError("AI_LAB_COMPLETION_RPC_INVALID_RESPONSE");
  }
  return {
    fingerprintPersisted:
      (row as { fingerprint_persisted: boolean }).fingerprint_persisted,
  };
}
