// Read-side REST helpers: fetch the views/tables the evaluator needs and
// parse them into the typed shapes from mic_state_types.ts. No decision
// logic here -- purely fetch + shape.
import { restHeaders } from "./mic_state_run_logic.ts";
import type { RestContext } from "./mic_state_run_logic.ts";
import { eventTypesForDomain } from "./mic_state_decision_logic.ts";
import type {
  Domain,
  EventFact,
  MetricDomainMapRow,
  MetricObservationRow,
  PriorState,
} from "./mic_state_types.ts";

export async function fetchDomainMetricMap(
  ctx: RestContext,
  domain: Domain,
  fetchImpl: typeof fetch = fetch,
): Promise<MetricDomainMapRow[]> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_metric_domain_map?domain=eq.${encodeURIComponent(domain)}` +
      `&select=metric_key,domain,display_name,pct_change_threshold,abs_change_threshold,always_material`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!result.ok) {
    throw new Error(`DOMAIN_METRIC_MAP_FETCH_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    metricKey: String(row.metric_key),
    domain: row.domain as Domain,
    displayName: String(row.display_name),
    pctChangeThreshold: typeof row.pct_change_threshold === "number" ? row.pct_change_threshold : null,
    absChangeThreshold: typeof row.abs_change_threshold === "number" ? row.abs_change_threshold : null,
    alwaysMaterial: row.always_material === true,
  }));
}

export async function fetchMetricObservationStatus(
  ctx: RestContext,
  domain: Domain,
  fetchImpl: typeof fetch = fetch,
): Promise<MetricObservationRow[]> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/v_mic_metric_observation_status?domain=eq.${encodeURIComponent(domain)}`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!result.ok) {
    throw new Error(`METRIC_OBSERVATION_STATUS_FETCH_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    metricKey: String(row.metric_key),
    domain: row.domain as Domain,
    currentValue: typeof row.current_value === "number" ? row.current_value : null,
    previousValue: typeof row.previous_value === "number" ? row.previous_value : null,
    pctChange: typeof row.pct_change === "number" ? row.pct_change : null,
    absChange: typeof row.abs_change === "number" ? row.abs_change : null,
    unit: typeof row.unit === "string" ? row.unit : null,
    observedDate: typeof row.observed_date === "string" ? row.observed_date : null,
    observedAt: typeof row.observed_at === "string" ? row.observed_at : null,
    timePrecision: (row.time_precision as "date" | "timestamp" | null) ?? null,
    fetchedAt: typeof row.fetched_at === "string" ? row.fetched_at : null,
    sourceKey: typeof row.source_key === "string" ? row.source_key : null,
    provider: typeof row.provider === "string" ? row.provider : null,
    isOfficial: typeof row.is_official === "boolean" ? row.is_official : null,
    expectedLagMinutes: typeof row.expected_lag_minutes === "number" ? row.expected_lag_minutes : null,
    observationAgeMinutes: typeof row.observation_age_minutes === "number" ? row.observation_age_minutes : null,
    observationStatus: (row.observation_status as MetricObservationRow["observationStatus"]) ?? "unknown",
  }));
}

export async function fetchSourceFetchStatuses(
  ctx: RestContext,
  sourceKeys: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, "fresh" | "stale" | "failed" | "unknown">> {
  const map = new Map<string, "fresh" | "stale" | "failed" | "unknown">();
  if (sourceKeys.length === 0) return map;
  const uniqueKeys = Array.from(new Set(sourceKeys));
  const inList = uniqueKeys.map((k) => encodeURIComponent(k)).join(",");
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/v_mic_source_fetch_status?source_key=in.(${inList})`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!result.ok) {
    throw new Error(`SOURCE_FETCH_STATUS_FETCH_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<Record<string, unknown>>;
  for (const row of rows) {
    if (typeof row.source_key === "string") {
      map.set(row.source_key, (row.fetch_status as "fresh" | "stale" | "failed" | "unknown") ?? "unknown");
    }
  }
  return map;
}

export async function fetchPriorState(
  ctx: RestContext,
  domain: Domain,
  fetchImpl: typeof fetch = fetch,
): Promise<PriorState> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/market_state_current?domain=eq.${encodeURIComponent(domain)}` +
      `&select=domain,narrative,numeric_baseline_snapshot,source_event_ids,updated_at,ai_evaluated_at&limit=1`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!result.ok) {
    throw new Error(`PRIOR_STATE_FETCH_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<Record<string, unknown>>;
  const row = rows[0];
  return {
    domain,
    narrativeIsNull: !row || row.narrative === null || row.narrative === undefined,
    numericBaselineSnapshot:
      (row?.numeric_baseline_snapshot as PriorState["numericBaselineSnapshot"]) ?? null,
    sourceEventIds: Array.isArray(row?.source_event_ids)
      ? row.source_event_ids.filter((id): id is string => typeof id === "string")
      : [],
    updatedAt: typeof row?.updated_at === "string" ? row.updated_at : null,
    aiEvaluatedAt: typeof row?.ai_evaluated_at === "string" ? row.ai_evaluated_at : null,
  };
}

// Only new (not-yet-considered) high/critical events for this domain,
// published after the domain's last evaluated as_of. Phase 1B has no
// event-producing source wired to any domain yet (SEC EDGAR is BLOCKED,
// geopolitical/macro/rate-decision collection is unimplemented) so this
// will return an empty array in practice today -- the query itself is
// still implemented so it activates automatically once a source exists.
export async function fetchRecentDomainEvents(
  ctx: RestContext,
  domain: Domain,
  sinceIso: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<EventFact[]> {
  const eventTypes = eventTypesForDomain(domain);
  if (eventTypes.length === 0) return [];
  const inList = eventTypes.map((t) => encodeURIComponent(t)).join(",");
  const sinceFilter = sinceIso ? `&published_at=gt.${encodeURIComponent(sinceIso)}` : "";
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/market_events?event_type=in.(${inList})${sinceFilter}` +
      `&select=id,title,summary,importance,event_type,published_at,updated_at&order=published_at.desc&limit=50`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!result.ok) {
    throw new Error(`DOMAIN_EVENTS_FETCH_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    summary: String(row.summary),
    importance: (row.importance as EventFact["importance"]) ?? null,
    eventType: String(row.event_type),
    publishedAt: String(row.published_at),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  }));
}

// State Evidence Phase 2C1: resolves the mic_fed_statement_diffs row (if
// any) for each given central_bank_decision market_events.id, so
// evaluateDomain can pass a concrete, already-decided list of diff
// snapshots into apply_mic_state_material_update's evidence arguments -- this
// module makes the *decision* (including refusing to guess), the RPC only
// *persists* an already-resolved list.
//
// mic_fed_statement_diffs' own unique index is keyed on
// (current_event_id, coalesce(previous_event_id, ...), diff_hash,
// prompt_version) -- current_event_id alone is NOT unique, so a given Fed
// event could in principle have more than one diff row (e.g. a future
// prompt_version bump, or a historical reprocess that produced a new
// diff_hash without removing the old row, since this table is an
// append-only interpretation artifact). Per explicit instruction, this
// never picks "the latest by created_at" or any other implicit rule --
// 2+ matches for the same event fails closed with
// FedStatementDiffAmbiguousError, which the caller lets propagate (no
// catch-and-continue), so the whole evaluation run fails rather than
// silently recording a guessed diff as evidence.
export class FedStatementDiffAmbiguousError extends Error {
  readonly eventId: string;
  readonly matchCount: number;
  constructor(eventId: string, matchCount: number) {
    super(`FED_STATEMENT_DIFF_AMBIGUOUS:${eventId}:${matchCount} diffs`);
    this.name = "FedStatementDiffAmbiguousError";
    this.eventId = eventId;
    this.matchCount = matchCount;
  }
}

// Every mic_fed_statement_diffs column except created_at. The row is read
// once, here, and this exact content is what the evidence snapshot stores and
// what apply_mic_state_material_update re-verifies under lock.
export const FED_STATEMENT_DIFF_SNAPSHOT_FIELDS = [
  "id",
  "current_event_id",
  "previous_event_id",
  "current_document_hash",
  "previous_document_hash",
  "diff_hash",
  "meeting_date",
  "previous_meeting_date",
  "changed_paragraph_count",
  "material_change_count",
  "deterministic_diff",
  "semantic_buckets",
  "ai_interpretation",
  "model",
  "prompt_version",
  "generated_at",
  "ai_usage_receipt",
  "ai_usage_recorded_at",
  "updated_at",
] as const;

export type FedStatementDiffSnapshot =
  & Record<(typeof FED_STATEMENT_DIFF_SNAPSHOT_FIELDS)[number], unknown>
  & { id: string; current_event_id: string };

export type FedStatementDiffEvidence = { id: string; snapshot: FedStatementDiffSnapshot };

export async function resolveFedStatementDiffEvidence(
  ctx: RestContext,
  centralBankDecisionEventIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<FedStatementDiffEvidence[]> {
  const uniqueEventIds = [...new Set(centralBankDecisionEventIds)];
  if (uniqueEventIds.length === 0) return [];
  const inList = uniqueEventIds.map((id) => encodeURIComponent(id)).join(",");
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_fed_statement_diffs?current_event_id=in.(${inList})` +
      `&select=${FED_STATEMENT_DIFF_SNAPSHOT_FIELDS.join(",")}`,
    { headers: { ...restHeaders(ctx.secretKey), Prefer: "count=exact" } },
  );
  if (!result.ok) {
    throw new Error(`FED_STATEMENT_DIFF_LOOKUP_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as unknown;
  if (!Array.isArray(rows)) throw new Error("FED_STATEMENT_DIFF_LOOKUP_INVALID_RESPONSE");
  // PostgREST may cap a batched result. With an exact Content-Range total,
  // never mistake an omitted second diff for an unambiguous single match.
  const total = result.headers.get("Content-Range")?.match(/\/(\d+)$/)?.[1];
  if (total !== undefined && Number(total) > rows.length) {
    throw new Error("FED_STATEMENT_DIFF_LOOKUP_TRUNCATED");
  }
  const requestedEventIds = new Set(uniqueEventIds);
  const matchesByEvent = new Map<string, FedStatementDiffSnapshot[]>();
  for (const row of rows) {
    if (
      typeof row !== "object" || row === null || Array.isArray(row) ||
      Object.keys(row).length !== FED_STATEMENT_DIFF_SNAPSHOT_FIELDS.length ||
      !FED_STATEMENT_DIFF_SNAPSHOT_FIELDS.every((field) => field in row)
    ) {
      throw new Error("FED_STATEMENT_DIFF_LOOKUP_INVALID_RESPONSE");
    }
    const snapshot = row as FedStatementDiffSnapshot;
    if (typeof snapshot.id !== "string" || typeof snapshot.current_event_id !== "string" ||
      !requestedEventIds.has(snapshot.current_event_id)) {
      throw new Error("FED_STATEMENT_DIFF_LOOKUP_INVALID_RESPONSE");
    }
    const list = matchesByEvent.get(snapshot.current_event_id) ?? [];
    list.push(snapshot);
    matchesByEvent.set(snapshot.current_event_id, list);
  }

  const evidence: FedStatementDiffEvidence[] = [];
  for (const eventId of uniqueEventIds) {
    const matches = matchesByEvent.get(eventId) ?? [];
    if (matches.length === 0) continue; // no diff computed yet for this event -- fine, just no evidence for it
    if (matches.length > 1) {
      throw new FedStatementDiffAmbiguousError(eventId, matches.length);
    }
    evidence.push({ id: matches[0].id, snapshot: matches[0] });
  }
  return evidence;
}
