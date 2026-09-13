// Phase 3G: real-data input for checkCrossBrandDuplicate(), replacing Phase 3F's synthetic
// self-referential probe. published_content_fingerprints (added in this phase) has no rows yet -- its
// write path is populated by the live publish-completion path, which is a separate, not-yet-wired task
// -- so "real recent Kabumori content" is read from post_execution_logs instead: the same table every
// successfully published Kabumori post already writes generated_text into.
//
// This reads generated_text only long enough to hash it in this function's own memory; the raw text is
// never returned, logged, or included in any response this module's caller builds. Only the brand id,
// the normalized-text SHA-256, and the publish timestamp leave this function -- the same shape
// PublishedFingerprint already requires. No Kabumori token, OAuth, or Vault table is read here.
import { fingerprintText, type PublishedFingerprint } from "./cross_brand_dedupe.ts";
import { LEGACY_KABUMORI_BRAND_ID } from "./brand_context.ts";

function supabaseHeaders(serviceRoleKey: string): Record<string, string> {
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
}

export async function fetchRecentKabumoriFingerprints({
  supabaseUrl,
  serviceRoleKey,
  limit = 20,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<PublishedFingerprint[]> {
  const params = new URLSearchParams({
    select: "generated_text,created_at",
    status: "eq.succeeded",
    brand_id: `eq.${LEGACY_KABUMORI_BRAND_ID}`,
    generated_text: "not.is.null",
    order: "created_at.desc",
    limit: String(limit),
  });
  let response: Response;
  try {
    response = await fetchImpl(`${supabaseUrl}/rest/v1/post_execution_logs?${params}`, {
      headers: supabaseHeaders(serviceRoleKey),
    });
  } catch {
    // Fails safe: a repository read failure must never block (or falsely allow) AI Lab's own dry-run
    // generation -- it just means this invocation has no real-data window to compare against, same as
    // if Kabumori had no recent posts at all.
    return [];
  }
  if (!response.ok) return [];
  let rows: unknown;
  try {
    rows = await response.json();
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];

  const fingerprints: PublishedFingerprint[] = [];
  for (const row of rows) {
    const generatedText = (row as { generated_text?: unknown }).generated_text;
    const createdAt = (row as { created_at?: unknown }).created_at;
    if (typeof generatedText !== "string" || generatedText.length === 0) continue;
    if (typeof createdAt !== "string") continue;
    fingerprints.push({
      brandId: LEGACY_KABUMORI_BRAND_ID,
      normalizedTextSha256: await fingerprintText(generatedText),
      publishedAt: createdAt,
    });
  }
  return fingerprints;
}
