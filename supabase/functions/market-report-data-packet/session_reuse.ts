// Reuse of an already-confirmed value for the same session (K1 follow-up,
// 2026-09-18): Yahoo published ^N225's 2026-09-17 close, we stored it in that
// day's close packet, and the next morning Yahoo returned the same bar with a
// null close, which blocked the whole morning cycle.
//
// A reused value is never a guess: it must be the same metric key and the same
// session_date, taken from a usable (ok / partial) packet where that metric was
// fresh. Nothing is carried across sessions, and the lineage of the source
// packet stays on the metric.

import { type Metric, REUSE_PROVIDER, type ReusedFrom } from "./packet_schema.ts";

/** Gaps a stored value may fill: Yahoo lost or could not return the session. */
const REUSABLE_GAPS = new Set(["expected_session_not_available", "fetch_failed", "invalid_value"]);

export type StoredPacketRow = {
  id: string;
  content_hash: string;
  data_quality_status: string;
  payload: { metrics?: Metric[] } | null;
};

export type ReuseCandidate = { value: Metric; source: ReusedFrom };

/** The newest confirmed value per "key@session_date" in the given packets. */
export function buildReuseIndex(rows: readonly StoredPacketRow[]): Map<string, ReuseCandidate> {
  const index = new Map<string, ReuseCandidate>();
  for (const row of rows) {
    if (!row.payload || !["ok", "partial"].includes(row.data_quality_status)) continue;
    if (!/^[0-9a-f]{64}$/.test(row.content_hash ?? "")) continue;
    for (const metric of row.payload.metrics ?? []) {
      if (metric.freshness !== "fresh" || metric.value === null || !metric.session_date) continue;
      if (metric.reused_from) continue; // never chain a reuse
      const key = `${metric.key}@${metric.session_date}`;
      if (index.has(key)) continue; // rows are newest first
      index.set(key, {
        value: metric,
        source: {
          data_packet_id: row.id,
          content_hash: row.content_hash,
          session_date: metric.session_date,
          provider: metric.provider ?? "unknown",
          observed_at: metric.observed_at,
        },
      });
    }
  }
  return index;
}

/**
 * The metric with a stored same-session value applied, or the metric unchanged.
 * Only an unavailable metric whose expected session Yahoo failed to deliver is
 * eligible; a session that has simply not closed yet is left alone.
 */
export function applySessionReuse(metric: Metric, index: ReadonlyMap<string, ReuseCandidate>): Metric {
  if (metric.freshness !== "unavailable" || !metric.gap_reason || !REUSABLE_GAPS.has(metric.gap_reason)) return metric;
  if (!metric.expected_session_date) return metric;
  const candidate = index.get(`${metric.key}@${metric.expected_session_date}`);
  if (!candidate) return metric;
  const stored = candidate.value;
  if (stored.session_date !== metric.expected_session_date || stored.value === null) return metric;
  return {
    ...metric,
    value: stored.value,
    previous_close: stored.previous_close,
    change: stored.change,
    change_pct: stored.change_pct,
    session_date: stored.session_date,
    observed_at: stored.observed_at,
    fetched_at: stored.fetched_at,
    provider: REUSE_PROVIDER,
    source_url: stored.source_url,
    basis: stored.basis,
    freshness: "fresh",
    quality: stored.quality,
    gap_reason: null,
    reused_from: candidate.source,
  };
}
