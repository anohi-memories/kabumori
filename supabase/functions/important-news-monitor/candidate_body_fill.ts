import type { FedStoredState } from "./fed_statement_enrichment.ts";

// Phase 7 / PR #129 R2: the two database-facing steps of the FOMC statement enrichment, kept apart from index.ts so that
// they can be exercised against a fully mocked PostgREST. No schema, RPC or migration is involved: both use the
// existing important_news_candidates columns through the same service-role REST path the rest of the function uses.

export type StoredCandidateRow = {
  id: string;
  status?: string;
  body_summary?: string | null;
  source_name?: string | null;
};

/**
 * Stored state of the feed's statement items, keyed by the feed's own URL. A row that does not belong to the
 * market_macro lane is reported as "has a body" so that it is never fetched for nor updated.
 */
export async function storedStatementStates(
  statements: Array<{ sourceUrl: string; normalizedUrl: string }>,
  lookup: (normalizedUrl: string) => Promise<StoredCandidateRow | null>,
): Promise<Map<string, FedStoredState>> {
  const states = new Map<string, FedStoredState>();
  for (const statement of statements) {
    const row = await lookup(statement.normalizedUrl);
    if (!row) continue;
    const ours = row.source_name === "market_macro";
    states.set(statement.sourceUrl, {
      id: row.id,
      status: typeof row.status === "string" ? row.status : "unknown",
      hasBody: !ours || (typeof row.body_summary === "string" && row.body_summary.trim().length > 0),
    });
  }
  return states;
}

export type BodyFillResult = "filled" | "skipped";

/**
 * Fills the official body into a candidate that has none, atomically in one conditional UPDATE: the row must still be
 * awaiting judgement, still belong to the market_macro lane and still have no body. A judged, generated, generating or
 * published candidate is never rewritten, and a second run (or a concurrent judgement that already moved the row)
 * changes nothing ("skipped"). The row returned by the update is read back and must hold exactly the body that was sent.
 * content_hash is left untouched on purpose: it is the hash of the headline-only candidate, which is what a later
 * title-only copy of the same item hashes to, so that copy keeps being recognised as a duplicate.
 */
export async function fillMissingCandidateBody(
  supabaseUrl: string,
  serviceRoleKey: string,
  candidateId: string,
  bodySummary: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BodyFillResult> {
  if (bodySummary.trim().length === 0) return "skipped";
  const params = new URLSearchParams({
    id: `eq.${candidateId}`,
    status: "eq.pending_judgement",
    source_name: "eq.market_macro",
    or: "(body_summary.is.null,body_summary.eq.)",
    select: "id,status,body_summary",
  });
  const result = await fetchImpl(`${supabaseUrl}/rest/v1/important_news_candidates?${params}`, {
    method: "PATCH",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ body_summary: bodySummary }),
  });
  if (!result.ok) throw new Error("NEWS_CANDIDATE_BODY_FILL_FAILED");
  const rows = await result.json() as Array<{ id?: unknown; status?: unknown; body_summary?: unknown }>;
  if (!Array.isArray(rows) || rows.length === 0) return "skipped";
  const row = rows[0];
  if (rows.length !== 1 || row.id !== candidateId || row.status !== "pending_judgement" || row.body_summary !== bodySummary) {
    throw new Error("NEWS_CANDIDATE_BODY_FILL_READBACK_MISMATCH");
  }
  return "filled";
}
