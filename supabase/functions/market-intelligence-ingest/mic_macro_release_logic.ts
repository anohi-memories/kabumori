// Macro Indicators Phase 1A: macro_release event decision logic. Pure --
// no network, no DB -- so it is fully unit-testable without a real
// database, matching mic_state_decision_logic.ts's own no-I/O convention.
//
// market_metrics stays the "latest known value" store exactly as before
// (upsertMarketMetric's plain merge-duplicates upsert, unchanged by this
// phase). market_events is the release/revision audit trail: a
// market_events row (event_type='macro_release') is written only when
// something genuinely new happened --
//   A. this (metric_key, observed_date) has never been seen before, or
//   B. the SAME observed_date now carries a different value (a revision)
// -- never on a plain re-fetch of an already-known (metric_key,
// observed_date, value) triple. The caller (index.ts) is responsible for
// reading the prior known value from market_metrics BEFORE calling
// upsertMarketMetric, and passing that prior value in here; this module
// never touches the DB itself.
//
// Idempotency against retries/duplicate Cron runs is NOT reinvented here
// -- it rides on the exact same content_hash unique-index mechanism
// mic_normalize_logic.ts/mic_writer_logic.ts already use for every other
// event type. buildMacroReleaseEvent bakes metric_key + observed_date +
// the NEW value into title/summary (which computeContentHash hashes), so
// two calls describing the exact same fact always hash identically and
// collide on market_events_content_hash_uidx -- writeMarketEvent already
// treats that as "duplicate", not a second row. A revision naturally gets
// a different hash (the new value is part of the hashed text), so it is
// correctly treated as a new, distinct event.
import type { MarketEventInput } from "./mic_normalize_logic.ts";

export type MacroReleaseDecision =
  | { kind: "unchanged" }
  | { kind: "new_release" }
  | { kind: "revision"; oldValue: number };

// priorValue is whatever upsertMarketMetric would be about to overwrite
// (null if this (metric_key, source_key, observed_date) has never been
// written before). newValue is the freshly-fetched value for the same
// triple.
export function decideMacroReleaseEvent(priorValue: number | null, newValue: number): MacroReleaseDecision {
  if (priorValue === null) return { kind: "new_release" };
  if (priorValue === newValue) return { kind: "unchanged" };
  return { kind: "revision", oldValue: priorValue };
}

export type MacroReleaseEventContext = {
  metricKey: string;
  observedDate: string;
  newValue: number;
  unit: string;
  seriesId: string;
  fredUnits: string | null;
  underlyingSource: string | null;
  sourceUrl: string;
  // When our system learned of this fact (i.e. this ingest run's
  // fetchedAt) -- NOT a claim about the real-world publication instant,
  // which FRED's date-only observations never give us. Mirrors
  // market_metrics' own observedAt=null/time_precision='date' choice: no
  // intraday time is fabricated anywhere in this pipeline for FRED data.
  fetchedAt: string;
};

// Returns null for "unchanged" (caller must not write anything -- this is
// the case that keeps a plain re-fetch of an already-known value from
// ever producing an event). For new_release/revision, returns a
// ready-to-finalize MarketEventInput; the caller still runs it through
// finalizeMarketEvent (content_hash/dedupe_key) and writeMarketEvent
// exactly like every other event source, unchanged.
export function buildMacroReleaseEvent(
  decision: MacroReleaseDecision,
  ctx: MacroReleaseEventContext,
): MarketEventInput | null {
  if (decision.kind === "unchanged") return null;

  const isRevision = decision.kind === "revision";
  const oldValue = isRevision ? decision.oldValue : null;

  const title = isRevision
    ? `${ctx.metricKey} revised for ${ctx.observedDate}`
    : `${ctx.metricKey} released for ${ctx.observedDate}`;

  const summary = isRevision
    ? `${ctx.metricKey} for ${ctx.observedDate} revised to ${ctx.newValue} ${ctx.unit} (was ${oldValue} ${ctx.unit}).`
    : `${ctx.metricKey} for ${ctx.observedDate}: ${ctx.newValue} ${ctx.unit} (first release).`;

  return {
    // Unknown real-world publication instant for a date-only source --
    // left null rather than fabricated, same principle as
    // market_metrics.observed_at for these same series.
    occurredAt: null,
    publishedAt: ctx.fetchedAt,
    eventType: "macro_release",
    category: "macro",
    entityType: "other",
    entityId: ctx.metricKey,
    title,
    summary,
    sourceName: "FRED",
    sourceUrl: ctx.sourceUrl,
    sourceKey: "fred",
    sourceTimestamp: null,
    importance: "medium",
    rawPayload: {
      metric_key: ctx.metricKey,
      observed_date: ctx.observedDate,
      new_value: ctx.newValue,
      old_value: oldValue,
      is_revision: isRevision,
      series_id: ctx.seriesId,
      fred_units: ctx.fredUnits,
      underlying_source: ctx.underlyingSource,
    },
  };
}

// The metric_keys this phase wires macro_release event generation onto.
// Deliberately explicit (not derived from domain, which the ingest
// function has no notion of) and deliberately scoped to exactly the 16
// FRED-sourced macro metrics this phase adds -- every other metric_key
// (US2Y/US10Y/equity_index/fx/commodities) is completely untouched by
// this new code path.
export const MACRO_RELEASE_METRIC_KEYS: ReadonlySet<string> = new Set([
  "US_CPI",
  "US_CPI_YOY",
  "US_CORE_CPI",
  "US_CORE_CPI_YOY",
  "US_PCE",
  "US_PCE_YOY",
  "US_CORE_PCE",
  "US_CORE_PCE_YOY",
  "US_NFP",
  "US_NFP_CHANGE",
  "US_UNEMPLOYMENT_RATE",
  "US_GDP",
  "US_GDP_GROWTH",
  "US_RETAIL_SALES",
  "US_RETAIL_SALES_MOM",
  "JP_GDP",
  // Macro Indicators Phase 1B (e-Stat): the same decision/event logic
  // above never referenced anything FRED-specific (it only ever looked at
  // metricKey/observedDate/value), so adding these 4 e-Stat-sourced
  // metric_keys needs no code change beyond this scope list.
  "JP_CPI",
  "JP_CPI_YOY",
  "JP_CORE_CPI",
  "JP_CORE_CPI_YOY",
]);
