// MIC Scenario quality policy, shared by the Scenario evaluator (generation
// time, Phase 3A) and the Scenario read gate (read time, Phase 3B). Pure: no
// I/O, no AI. Keep every freshness / quality / confidence rule here so the two
// sides cannot drift. The DB RPC apply_mic_scenario_update mirrors the same
// numbers in SQL (migration 20260928120000); change both together.
//
// Three different notions of "old" are kept apart on purpose:
//   - narrative freshness (fresh / recent / stale): age of the State's AI
//     interpretation (ai_evaluated_at) against the domain limits below;
//   - observation_status: whether the State's own underlying data points are
//     current (a fresh narrative can contain a stale observation);
//   - Scenario validity (valid_until / read gate status).

export type ScenarioDomain = "rates" | "macro" | "equity_index";

// Phase 3A inputs. fx / commodities / geopolitical can be added in a later
// phase once their States are mature; the DB CHECKs list the same three.
export const SCENARIO_DOMAINS: readonly ScenarioDomain[] = ["rates", "macro", "equity_index"];

// One market_state_current row as PostgREST returns it for our select list.
export type StateRow = {
  domain?: unknown;
  narrative?: unknown;
  bullish_factors?: unknown;
  bearish_factors?: unknown;
  key_risks?: unknown;
  ai_confidence?: unknown;
  data_confidence?: unknown;
  coverage_status?: unknown;
  observation_status?: unknown;
  ai_evaluated_at?: unknown;
  source_evaluation_run_id?: unknown;
};

// Exactly the fields the Scenario AI sees for one State, in the same shape
// that mic_scenario_evidence.state_snapshot stores and the RPC re-verifies.
export type StateSnapshot = {
  domain: ScenarioDomain;
  narrative: string;
  bullish_factors: unknown;
  bearish_factors: unknown;
  key_risks: unknown;
  ai_confidence: number | null;
  data_confidence: number;
  coverage_status: string;
  observation_status: string;
  ai_evaluated_at: string;
  source_evaluation_run_id: string;
};

export type Freshness = "fresh" | "recent" | "stale" | "unknown";
export type Usability = "strong" | "weak";

export type UsableState = {
  snapshot: StateSnapshot;
  freshness: "fresh" | "recent";
  usability: Usability;
  weakReasons: string[];
};

export type ExcludedState = { domain: ScenarioDomain; reason: string };

// A Scenario is a cross-domain synthesis; with a single usable State it would
// only restate that State, so at least two are required.
export const MIN_USABLE_DOMAINS = 2;

const HOUR_MS = 60 * 60 * 1000;

// Freshness of the State *narrative* (ai_evaluated_at), per domain. The State
// evaluator only rewrites a narrative on a material change, so this measures
// how old the interpretation the Scenario would build on is. Data quality
// (observation/coverage/data_confidence) is judged separately below.
//   rates / equity_index: daily markets. fresh <= 36h (one trading day plus
//     scheduling slack); recent <= 96h (a weekend plus a holiday).
//   macro: monthly releases, so a narrative legitimately stays the latest
//     picture for weeks. fresh <= 7 days; recent <= 35 days (one release
//     cycle plus slack); older means a release was missed.
export const FRESHNESS_HOURS: Record<ScenarioDomain, { fresh: number; recent: number }> = {
  rates: { fresh: 36, recent: 96 },
  equity_index: { fresh: 36, recent: 96 },
  macro: { fresh: 7 * 24, recent: 35 * 24 },
};

// A narrative dated slightly in the future (clock skew) is tolerated; beyond
// this it is treated as unknown.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

// data_confidence below this means the State's own inputs failed
// (computeDataConfidence gives 0.2 for a failed fetch, 0 for no coverage).
export const MIN_DATA_CONFIDENCE = 0.3;
// Below this (or with stale/unknown observations, partial coverage, or a
// recent-but-not-fresh narrative) a State is still used but marked weak.
export const STRONG_DATA_CONFIDENCE = 0.7;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function classifyFreshness(domain: ScenarioDomain, aiEvaluatedAt: unknown, now: number): Freshness {
  if (typeof aiEvaluatedAt !== "string") return "unknown";
  const evaluated = Date.parse(aiEvaluatedAt);
  if (!Number.isFinite(evaluated)) return "unknown";
  const age = now - evaluated;
  if (age < -FUTURE_SKEW_MS) return "unknown";
  const limits = FRESHNESS_HOURS[domain];
  if (age <= limits.fresh * HOUR_MS) return "fresh";
  if (age <= limits.recent * HOUR_MS) return "recent";
  return "stale";
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export type StateClassification = { usable: UsableState[]; excluded: ExcludedState[] };

// Classifies the target domains' market_state_current rows. Rows are matched
// by domain; a missing row, a duplicated row or an unknown domain never
// produces usable input.
export function classifyStates(rows: readonly StateRow[], now: number): StateClassification {
  const usable: UsableState[] = [];
  const excluded: ExcludedState[] = [];
  for (const domain of SCENARIO_DOMAINS) {
    const matches = rows.filter((row) => row.domain === domain);
    if (matches.length !== 1) {
      excluded.push({ domain, reason: matches.length === 0 ? "state_row_missing" : "state_row_duplicated" });
      continue;
    }
    const row = matches[0];
    if (typeof row.narrative !== "string" || row.narrative.trim().length === 0) {
      excluded.push({ domain, reason: "no_narrative" });
      continue;
    }
    if (typeof row.source_evaluation_run_id !== "string" || !UUID_PATTERN.test(row.source_evaluation_run_id)) {
      // Pre-Phase-2C-1 narratives have no run link, so their provenance and
      // identity (the fingerprint) cannot be established.
      excluded.push({ domain, reason: "no_source_evaluation_run" });
      continue;
    }
    if (!isStringArray(row.bullish_factors) || !isStringArray(row.bearish_factors) || !isStringArray(row.key_risks)) {
      excluded.push({ domain, reason: "malformed_state" });
      continue;
    }
    if (row.ai_confidence !== null && (typeof row.ai_confidence !== "number" || !Number.isFinite(row.ai_confidence) ||
      row.ai_confidence < 0 || row.ai_confidence > 1)) {
      excluded.push({ domain, reason: "malformed_state" });
      continue;
    }
    const dataConfidence = row.data_confidence;
    if (typeof dataConfidence !== "number" || !Number.isFinite(dataConfidence) || dataConfidence < 0 || dataConfidence > 1) {
      excluded.push({ domain, reason: "invalid_data_confidence" });
      continue;
    }
    if (typeof row.coverage_status !== "string" || typeof row.observation_status !== "string" ||
      !["full", "partial", "unavailable"].includes(row.coverage_status) ||
      !["fresh", "delayed_expected", "stale", "unknown"].includes(row.observation_status)) {
      excluded.push({ domain, reason: "malformed_state" });
      continue;
    }
    const freshness = classifyFreshness(domain, row.ai_evaluated_at, now);
    if (freshness === "unknown") {
      excluded.push({ domain, reason: "freshness_unknown" });
      continue;
    }
    if (freshness === "stale") {
      excluded.push({ domain, reason: "narrative_stale" });
      continue;
    }
    if (row.coverage_status === "unavailable") {
      excluded.push({ domain, reason: "coverage_unavailable" });
      continue;
    }
    if (dataConfidence < MIN_DATA_CONFIDENCE) {
      excluded.push({ domain, reason: "data_confidence_too_low" });
      continue;
    }

    const weakReasons: string[] = [];
    if (freshness === "recent") weakReasons.push("narrative_recent");
    if (row.observation_status === "stale" || row.observation_status === "unknown") {
      weakReasons.push(`observation_${row.observation_status}`);
    }
    if (row.coverage_status === "partial") weakReasons.push("coverage_partial");
    if (dataConfidence < STRONG_DATA_CONFIDENCE) weakReasons.push("data_confidence_low");

    usable.push({
      snapshot: {
        domain,
        narrative: row.narrative,
        bullish_factors: row.bullish_factors,
        bearish_factors: row.bearish_factors,
        key_risks: row.key_risks,
        ai_confidence: row.ai_confidence as number | null,
        data_confidence: dataConfidence,
        coverage_status: row.coverage_status,
        observation_status: row.observation_status,
        ai_evaluated_at: row.ai_evaluated_at as string,
        source_evaluation_run_id: row.source_evaluation_run_id,
      },
      freshness,
      usability: weakReasons.length > 0 ? "weak" : "strong",
      weakReasons,
    });
  }
  return { usable, excluded };
}

export const RECENT_FRESHNESS_FACTOR = 0.8;
export const EXCLUDED_DOMAIN_PENALTY = 0.1;
export const INDETERMINATE_CONFIDENCE_CAP = 0.3;

// The Scenario AI's own confidence is never trusted on its own. Cap:
//   min over used States of (data_confidence x freshness factor)
//   minus 0.1 for each target domain that could not be used.
// The weakest input bounds the synthesis (a Scenario can never be more
// certain than the least reliable State it combines), an older narrative
// counts for less, and missing domains make the picture incomplete.
export function confidenceCap(usable: readonly UsableState[], excludedCount: number): number {
  if (usable.length === 0) return 0;
  const weakest = Math.min(
    ...usable.map((state) => state.snapshot.data_confidence * (state.freshness === "recent" ? RECENT_FRESHNESS_FACTOR : 1)),
  );
  return Math.max(0, Math.min(1, weakest - EXCLUDED_DOMAIN_PENALTY * excludedCount));
}
