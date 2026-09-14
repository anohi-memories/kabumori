import { BrandContextError } from "./brand_context.ts";
import { fetchRecentKabumoriFingerprints } from "./kabumori_recent_fingerprints.ts";
import type { PublishedFingerprint } from "./cross_brand_dedupe.ts";

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
