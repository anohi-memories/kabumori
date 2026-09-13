// Phase 3G: real-data input for checkCrossBrandDuplicate(), replacing Phase 3F's synthetic
// self-referential probe. published_content_fingerprints (added in this phase) has no rows yet -- its
// write path is populated by the live publish-completion path, which is a separate, not-yet-wired task.
//
// CORRECTED after the first real invocation reported kabumori_posts_checked: 0. Read-only production
// investigation found the initial version queried post_execution_logs.generated_text, a column that does
// not exist on that table (confirmed via information_schema.columns) -- the REST call was returning a
// PostgREST 400, which this module's own fail-safe path (`if (!response.ok) return []`) silently
// swallowed into an empty window. post_execution_logs never stores final post text for any post type; the
// tables that do are the per-report-type "run" tables, each carrying its own generated_text +
// status + brand_id: close_report_runs, morning_report_runs, us_premarket_report_runs (confirmed via
// information_schema.columns and read-only row counts: close_report_runs and morning_report_runs
// currently have real status='succeeded', brand_id='kabumori' rows with non-null generated_text;
// us_premarket_report_runs has none yet but is included for when it does). tip/interaction/useful_tip/
// morning_greeting post types have no per-instance generated-text column anywhere in the schema, so they
// are out of scope for this real-data window.
//
// This reads generated_text only long enough to hash it in this function's own memory; the raw text is
// never returned, logged, or included in any response this module's caller builds. Only the brand id,
// the normalized-text SHA-256, and the publish timestamp leave this function -- the same shape
// PublishedFingerprint already requires. No Kabumori token, OAuth, or Vault table is read here.
import {
  fingerprintText,
  type PublishedFingerprint,
} from "./cross_brand_dedupe.ts";
import { LEGACY_KABUMORI_BRAND_ID } from "./brand_context.ts";

const REPORT_RUN_TABLES = [
  "close_report_runs",
  "morning_report_runs",
  "us_premarket_report_runs",
] as const;

function supabaseHeaders(serviceRoleKey: string): Record<string, string> {
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
}

type RawRow = { generated_text?: unknown; generated_at?: unknown };

async function fetchFromReportRunTable({
  table,
  supabaseUrl,
  serviceRoleKey,
  limit,
  fetchImpl,
  strict,
}: {
  table: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  limit: number;
  fetchImpl: typeof fetch;
  strict: boolean;
}): Promise<RawRow[] | null> {
  const params = new URLSearchParams({
    select: "generated_text,generated_at",
    status: "eq.succeeded",
    brand_id: `eq.${LEGACY_KABUMORI_BRAND_ID}`,
    generated_text: "not.is.null",
    order: "generated_at.desc",
    limit: String(limit),
  });
  try {
    const response = await fetchImpl(
      `${supabaseUrl}/rest/v1/${table}?${params}`,
      {
        headers: supabaseHeaders(serviceRoleKey),
      },
    );
    // Fails safe per table: one table's read failure must never block (or falsely allow) AI Lab's own
    // dry-run generation, and must never abort the other tables' reads.
    if (!response.ok) return strict ? null : [];
    const rows = await response.json();
    return Array.isArray(rows) ? rows : strict ? null : [];
  } catch {
    return strict ? null : [];
  }
}

export async function fetchRecentKabumoriFingerprints({
  supabaseUrl,
  serviceRoleKey,
  limit = 20,
  strict = false,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  limit?: number;
  /** A live pre-publish dedupe read must fail closed if any source table is unavailable. */
  strict?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<PublishedFingerprint[]> {
  const perTableRows = await Promise.all(
    REPORT_RUN_TABLES.map((table) =>
      fetchFromReportRunTable({
        table,
        supabaseUrl,
        serviceRoleKey,
        limit,
        fetchImpl,
        strict,
      })
    ),
  );
  if (strict && perTableRows.some((rows) => rows === null)) {
    throw new Error("KABUMORI_FINGERPRINT_READ_FAILED");
  }

  const candidates: Array<{ generatedText: string; generatedAt: string }> = [];
  for (const rows of perTableRows) {
    if (!rows) continue;
    for (const row of rows) {
      const generatedText = row.generated_text;
      const generatedAt = row.generated_at;
      if (typeof generatedText !== "string" || generatedText.length === 0) {
        continue;
      }
      if (typeof generatedAt !== "string") continue;
      candidates.push({ generatedText, generatedAt });
    }
  }
  candidates.sort((a, b) =>
    Date.parse(b.generatedAt) - Date.parse(a.generatedAt)
  );

  const fingerprints: PublishedFingerprint[] = [];
  for (const candidate of candidates.slice(0, limit)) {
    fingerprints.push({
      brandId: LEGACY_KABUMORI_BRAND_ID,
      normalizedTextSha256: await fingerprintText(candidate.generatedText),
      publishedAt: candidate.generatedAt,
    });
  }
  return fingerprints;
}
