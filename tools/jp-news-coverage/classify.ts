// Phase J0 offline classifier. Four INDEPENDENT axes, evaluated in order, each with its own failure reason:
//   discovered        - did a legal source deliver the event at all?
//   relevant          - is it a Japan-relevant event that is confirmed enough to treat as news (not rumour / retraction / reprint)?
//   eligible_for_app  - may it be listed in the app (independent of the X posting threshold)?
//   urgent_push       - may it interrupt the user (emergency / critical + primary-confirmed only; current push policy is NOT loosened)?
// Pure functions; no I/O. Rules restate docs/news-coverage + news_source_catalog rights conclusions; they are a model for
// measurement, not production logic.
import type { EventFixture, MissReason } from "./fixtures.ts";

export type Classified = {
  discovered: boolean;
  relevant: boolean;
  eligible_for_app: boolean;
  urgent_push: boolean;
  miss_reason: MissReason | null;
};

export function classify(event: EventFixture): Classified {
  const out: Classified = { discovered: false, relevant: false, eligible_for_app: false, urgent_push: false, miss_reason: null };
  if (!event.feed_available) return { ...out, miss_reason: "no_source" };
  if (!event.rights_ok) return { ...out, miss_reason: "terms_excluded" };
  out.discovered = true;
  if (event.verification === "old_republish") return { ...out, miss_reason: "duplicate_event" };
  if (event.verification === "rumor" || event.verification === "retracted") return { ...out, miss_reason: "judgement_rejected" };
  if (!event.passes_rule_filter || event.locality === "foreign_only") return { ...out, miss_reason: "filtered_rule" };
  out.relevant = true;
  // App listing is wider than X: any confirmed relevant event is listable; unconfirmed single-source items are not.
  const confirmed = event.verification === "primary_confirmed" || event.verification === "multi_source";
  if (!confirmed) return { ...out, miss_reason: "app_display_gate" };
  out.eligible_for_app = true;
  if ((event.severity === "emergency" || event.severity === "critical") && event.verification === "primary_confirmed") {
    out.urgent_push = true;
  }
  return out;
}

export type Metrics = {
  events: number;
  discovered: number;
  relevantEvents: number;
  /** Event recall: of the relevant-by-truth events, how many were discovered. */
  eventRecall: number | "NOT_AVAILABLE";
  /** Of the discovered relevant events, how many reached app eligibility. */
  appReach: number | "NOT_AVAILABLE";
  missReasons: Record<string, number>;
  latencyP50S: number | "NOT_AVAILABLE";
  latencyP90S: number | "NOT_AVAILABLE";
};

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/**
 * `truth` marks the events a human would call relevant news (ground truth), independent of what the pipeline did. Latency
 * = first public -> display eligible, only where all three timestamps are observed; otherwise NOT_AVAILABLE.
 */
export function computeMetrics(events: EventFixture[], truth: ReadonlySet<string>): Metrics {
  const results = events.map((event) => ({ event, result: classify(event) }));
  const relevant = results.filter(({ event }) => truth.has(event.id));
  const discoveredRelevant = relevant.filter(({ result }) => result.discovered);
  const reached = discoveredRelevant.filter(({ result }) => result.eligible_for_app);
  const missReasons: Record<string, number> = {};
  for (const { result } of relevant) {
    if (result.eligible_for_app) continue;
    const reason = result.miss_reason ?? "unknown";
    missReasons[reason] = (missReasons[reason] ?? 0) + 1;
  }
  const latencies = results
    .filter(({ event, result }) => result.eligible_for_app && event.first_public_to_fetched_s !== null && event.fetched_to_judged_s !== null && event.judged_to_display_s !== null)
    .map(({ event }) => (event.first_public_to_fetched_s ?? 0) + (event.fetched_to_judged_s ?? 0) + (event.judged_to_display_s ?? 0));
  return {
    events: events.length,
    discovered: results.filter(({ result }) => result.discovered).length,
    relevantEvents: relevant.length,
    eventRecall: relevant.length === 0 ? "NOT_AVAILABLE" : discoveredRelevant.length / relevant.length,
    appReach: discoveredRelevant.length === 0 ? "NOT_AVAILABLE" : reached.length / discoveredRelevant.length,
    missReasons,
    latencyP50S: latencies.length === 0 ? "NOT_AVAILABLE" : percentile(latencies, 0.5),
    latencyP90S: latencies.length === 0 ? "NOT_AVAILABLE" : percentile(latencies, 0.9),
  };
}
