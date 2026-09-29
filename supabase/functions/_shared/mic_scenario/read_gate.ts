// MIC Phase 3B: read-time validity gate for mic_scenario_current.
//
// "Is this stored Scenario still usable right now?" A Scenario was correct
// when it was written, but its source States can since have aged, lost
// quality, been replaced by a new evaluation run, or had their observation /
// coverage status refreshed by a no_change run. The stored row alone is never
// trusted: the gate cross-checks current, its source run, its evidence and
// the live market_state_current rows, and recomputes freshness and the
// confidence cap with the same shared policy the evaluator used.
//
// Pure: no I/O, no AI, no DB writes, never regenerates anything. Expired or
// invalid Scenarios only get a status; regeneration is a separate phase.
//
// Determination order (first match wins; exactly one status is returned):
//   1. unavailable  no Scenario has been generated (seed row).
//   2. invalid      the stored artifact is not self-consistent: current row
//                   missing / malformed, source run missing / not evaluated /
//                   fingerprint mismatch, evidence missing / malformed /
//                   disagreeing with current, valid_until inconsistent.
//   3. expired      now >= valid_until (the earlier of the stored value and
//                   the value re-derived from the evidence).
//   4. invalid      live State revalidation failed: a source State row is
//                   gone, its source evaluation run or narrative timestamp
//                   differs from what the Scenario AI saw (identity drift), or
//                   it is no longer usable for Scenarios (stale / unknown /
//                   future narrative, coverage unavailable, data too weak) --
//                   including fewer than two usable source States.
//   5. degraded     still usable, but weaker than a clean read: a target
//                   domain is missing, a source State is weak now (recent
//                   narrative, stale/unknown observation, partial coverage,
//                   low data confidence), quality fell since generation, the
//                   confidence cap dropped, or the assessment is indeterminate.
//   6. usable       none of the above.
//
// Three notions of age are reported separately and never merged (a Phase 3A
// smoke output called the rates State "stale" when only one of its
// observations was): narrative_freshness (State interpretation age),
// observation_status (the State's own data points) and the Scenario status.
import {
  classifyFreshness,
  classifyStates,
  confidenceCap,
  FRESHNESS_HOURS,
  INDETERMINATE_CONFIDENCE_CAP,
  isStringArray,
  MIN_USABLE_DOMAINS,
  SCENARIO_DOMAINS,
  type ScenarioDomain,
  type StateRow,
  type StateSnapshot,
  type UsableState,
  UUID_PATTERN,
} from "./policy.ts";

export type ScenarioReadStatus = "usable" | "degraded" | "expired" | "invalid" | "unavailable";

export type ScenarioBaseCase = {
  title: string;
  description: string;
  supporting_state_domains: string[];
  confirmation_conditions: string[];
  invalidation_conditions: string[];
  watch_items: string[];
};

export type ScenarioDirectionalCase = {
  title: string;
  description: string;
  triggers: string[];
  implications: string[];
  invalidation_conditions: string[];
  watch_items: string[];
};

// Only the Scenario content itself; run ids, fingerprints, model, tokens and
// cost stay internal.
export type ScenarioContent = {
  assessment_status: "assessed" | "indeterminate";
  base_case: ScenarioBaseCase;
  upside_case: ScenarioDirectionalCase;
  downside_case: ScenarioDirectionalCase;
  state_conflicts: string[];
};

export type ScenarioSourceDomainView = {
  domain: ScenarioDomain;
  // Age of the State narrative (ai_evaluated_at), not of its data points.
  narrative_freshness: "fresh" | "recent" | "stale" | "unknown";
  // The State's own observation quality, reported as-is.
  observation_status: string | null;
  coverage_status: string | null;
  data_confidence: number | null;
  state_evaluated_at: string | null;
  quality_changed_since_generation: boolean;
};

export type ScenarioReadResult = {
  status: ScenarioReadStatus;
  reason_codes: string[];
  scenario: ScenarioContent | null; // only when usable / degraded
  effective_confidence: number | null; // only when usable / degraded
  stored_confidence: number | null;
  valid_until: string | null;
  evaluated_at: string | null;
  source_domains: ScenarioSourceDomainView[];
  excluded_or_invalid_domains: Array<{ domain: string; reason: string }>;
};

// Raw rows as read from PostgREST. Everything is unknown until validated.
export type ScenarioReadInput = {
  current: Record<string, unknown> | null; // null: the row does not exist
  run: Record<string, unknown> | null; // null: not found / not readable
  evidence: Record<string, unknown>[];
  states: StateRow[];
  // Adapter detected a change during its optimistic read validation.
  readRace?: boolean;
};

const SNAPSHOT_KEYS = [
  "domain", "narrative", "bullish_factors", "bearish_factors", "key_risks", "ai_confidence",
  "data_confidence", "coverage_status", "observation_status", "ai_evaluated_at", "source_evaluation_run_id",
] as const;
const BASE_KEYS = [
  "title", "description", "supporting_state_domains", "confirmation_conditions", "invalidation_conditions", "watch_items",
] as const;
const DIRECTIONAL_KEYS = ["title", "description", "triggers", "implications", "invalidation_conditions", "watch_items"] as const;
const CONTENT_FIELDS = [
  "assessment_status", "base_case", "upside_case", "downside_case", "state_conflicts", "confidence", "ai_confidence",
  "state_as_of", "valid_until", "source_state_run_ids", "source_state_domains", "input_fingerprint", "ai_evaluated_at",
  "prompt_version",
] as const;
const OBSERVATION_RANK: Record<string, number> = { fresh: 0, delayed_expected: 0, stale: 1, unknown: 2 };
const COVERAGE_RANK: Record<string, number> = { full: 0, partial: 1, unavailable: 2 };
const HOUR_MS = 60 * 60 * 1000;
const EPSILON = 1e-9;

const floor3 = (value: number) => Math.floor(value * 1000) / 1000;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isConfidence = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const isTime = (value: unknown): value is string => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60 &&
  Number(value.slice(8, 10)) <= new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 0)).getUTCDate();
const isDomain = (value: unknown): value is ScenarioDomain =>
  typeof value === "string" && (SCENARIO_DOMAINS as readonly string[]).includes(value);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function result(
  status: ScenarioReadStatus,
  reasons: string[],
  extra: Partial<ScenarioReadResult> = {},
): ScenarioReadResult {
  return {
    status,
    reason_codes: [...new Set(reasons)],
    scenario: null,
    effective_confidence: null,
    stored_confidence: null,
    valid_until: null,
    evaluated_at: null,
    source_domains: [],
    excluded_or_invalid_domains: [],
    ...extra,
  };
}

function parseBaseCase(value: unknown, sourceDomains: readonly string[]): ScenarioBaseCase | null {
  if (!isObject(value) || !hasExactKeys(value, BASE_KEYS)) return null;
  const { title, description, supporting_state_domains, confirmation_conditions, invalidation_conditions, watch_items } = value;
  if (typeof title !== "string" || title.trim() === "" || typeof description !== "string" || description.trim() === "") return null;
  if (!isStringArray(supporting_state_domains) || !supporting_state_domains.every((d) => sourceDomains.includes(d))) return null;
  if (!isStringArray(confirmation_conditions) || !isStringArray(invalidation_conditions) || !isStringArray(watch_items)) return null;
  return {
    title, description, supporting_state_domains: [...supporting_state_domains],
    confirmation_conditions: [...confirmation_conditions], invalidation_conditions: [...invalidation_conditions],
    watch_items: [...watch_items],
  };
}

function parseDirectionalCase(value: unknown, required: boolean): ScenarioDirectionalCase | null {
  if (!isObject(value) || !hasExactKeys(value, DIRECTIONAL_KEYS)) return null;
  const { title, description, triggers, implications, invalidation_conditions, watch_items } = value;
  if (typeof title !== "string" || typeof description !== "string") return null;
  if (!isStringArray(triggers) || !isStringArray(implications) || !isStringArray(invalidation_conditions) || !isStringArray(watch_items)) {
    return null;
  }
  if (required && (title.trim() === "" || description.trim() === "" || triggers.length === 0)) return null;
  return {
    title, description, triggers: [...triggers], implications: [...implications],
    invalidation_conditions: [...invalidation_conditions], watch_items: [...watch_items],
  };
}

type ParsedCurrent = {
  runId: string;
  content: ScenarioContent;
  confidence: number;
  validUntil: number;
  evaluatedAt: string;
  domains: ScenarioDomain[];
  runIdsByDomain: Map<ScenarioDomain, string>;
  inputFingerprint: string;
};

function parseCurrent(current: Record<string, unknown>): ParsedCurrent | null {
  const runId = current.source_scenario_run_id;
  if (typeof runId !== "string" || !UUID_PATTERN.test(runId)) return null;
  const domains = current.source_state_domains;
  const runIds = current.source_state_run_ids;
  if (!Array.isArray(domains) || !domains.every(isDomain) || new Set(domains).size !== domains.length) return null;
  if (domains.length < MIN_USABLE_DOMAINS) return null;
  if (!Array.isArray(runIds) || runIds.length !== domains.length ||
    !runIds.every((id) => typeof id === "string" && UUID_PATTERN.test(id)) || new Set(runIds).size !== runIds.length) {
    return null;
  }
  const status = current.assessment_status;
  if (status !== "assessed" && status !== "indeterminate") return null;
  const { confidence, ai_confidence } = current;
  if (!isConfidence(confidence) || !isConfidence(ai_confidence) || confidence > ai_confidence + EPSILON) return null;
  if (status === "indeterminate" && confidence > INDETERMINATE_CONFIDENCE_CAP + EPSILON) return null;
  if (!isTime(current.valid_until) || !isTime(current.state_as_of) || !isTime(current.ai_evaluated_at)) return null;
  if (Date.parse(current.valid_until) <= Date.parse(current.state_as_of)) return null;
  if (typeof current.input_fingerprint !== "string") return null;
  const baseCase = parseBaseCase(current.base_case, domains);
  const assessed = status === "assessed";
  if (!baseCase || (assessed && baseCase.supporting_state_domains.length === 0)) return null;
  const upside = parseDirectionalCase(current.upside_case, assessed);
  const downside = parseDirectionalCase(current.downside_case, assessed);
  if (!upside || !downside || !isStringArray(current.state_conflicts)) return null;
  return {
    runId,
    content: {
      assessment_status: status, base_case: baseCase, upside_case: upside, downside_case: downside,
      state_conflicts: [...current.state_conflicts],
    },
    confidence,
    validUntil: Date.parse(current.valid_until),
    evaluatedAt: current.ai_evaluated_at,
    domains: [...domains],
    runIdsByDomain: new Map(domains.map((domain, index) => [domain, runIds[index] as string])),
    inputFingerprint: current.input_fingerprint,
  };
}

type ParsedEvidence = { domain: ScenarioDomain; freshness: "fresh" | "recent"; snapshot: StateSnapshot };

function parseEvidence(row: Record<string, unknown>, runId: string): ParsedEvidence | null {
  if (!isObject(row) || row.scenario_run_id !== runId) return null;
  const { domain, state_evaluation_run_id: stateRunId, freshness, state_snapshot: snap } = row;
  if (!isDomain(domain) || typeof stateRunId !== "string" || !UUID_PATTERN.test(stateRunId)) return null;
  if (freshness !== "fresh" && freshness !== "recent") return null;
  if (!isObject(snap) || !hasExactKeys(snap, SNAPSHOT_KEYS)) return null;
  if (snap.domain !== domain || snap.source_evaluation_run_id !== stateRunId) return null;
  if (!isConfidence(snap.data_confidence) || !isTime(snap.ai_evaluated_at)) return null;
  if (typeof snap.narrative !== "string" || snap.narrative.trim() === "" ||
    !isStringArray(snap.bullish_factors) || !isStringArray(snap.bearish_factors) || !isStringArray(snap.key_risks) ||
    (snap.ai_confidence !== null && !isConfidence(snap.ai_confidence))) return null;
  if (typeof snap.coverage_status !== "string" || !Object.hasOwn(COVERAGE_RANK, snap.coverage_status)) return null;
  if (typeof snap.observation_status !== "string" || !Object.hasOwn(OBSERVATION_RANK, snap.observation_status)) return null;
  if (row.usability !== "strong" && row.usability !== "weak") return null;
  return { domain, freshness, snapshot: snap as unknown as StateSnapshot };
}

// The Scenario AI saw each snapshot; valid_until can never be later than
// the moment its oldest source narrative stops being usable.
function derivedValidUntil(evidence: readonly ParsedEvidence[]): number {
  return Math.min(
    ...evidence.map((item) => Date.parse(item.snapshot.ai_evaluated_at) + FRESHNESS_HOURS[item.domain].recent * HOUR_MS),
  );
}

export function evaluateScenarioRead(input: ScenarioReadInput, now: number): ScenarioReadResult {
  if (!Number.isFinite(now)) return result("invalid", ["invalid_read_time"]);
  if (input.readRace) return result("invalid", ["read_race_detected"]);
  if (!Array.isArray(input.evidence)) return result("invalid", ["evidence_malformed"]);
  if (!Array.isArray(input.states) || !input.states.every(isObject)) return result("invalid", ["state_rows_malformed"]);
  // 1. unavailable / missing row
  const current = input.current;
  if (!current) return result("invalid", ["current_row_missing"]);
  if (!isObject(current)) return result("invalid", ["current_malformed"]);
  if (current.source_scenario_run_id === null || current.source_scenario_run_id === undefined) {
    const partial = CONTENT_FIELDS.some((field) => current[field] !== null && current[field] !== undefined);
    return partial ? result("invalid", ["current_malformed"]) : result("unavailable", ["scenario_not_generated"]);
  }

  // 2. stored artifact integrity
  const parsed = parseCurrent(current);
  const storedConfidence = isConfidence(current.confidence) ? current.confidence : null;
  if (!parsed) return result("invalid", ["current_malformed"], { stored_confidence: storedConfidence });
  const base = { stored_confidence: parsed.confidence, evaluated_at: parsed.evaluatedAt };

  const run = input.run;
  if (!isObject(run) || run.id !== parsed.runId) return result("invalid", ["source_run_missing"], base);
  if (run.status !== "evaluated") return result("invalid", ["source_run_not_evaluated"], base);
  if (run.input_fingerprint !== parsed.inputFingerprint) return result("invalid", ["fingerprint_mismatch"], base);

  if (input.evidence.length === 0) return result("invalid", ["evidence_missing"], base);
  const evidence: ParsedEvidence[] = [];
  for (const row of input.evidence) {
    const item = parseEvidence(row, parsed.runId);
    if (!item) return result("invalid", ["evidence_malformed"], base);
    evidence.push(item);
  }
  const evidenceDomains = evidence.map((item) => item.domain);
  if (new Set(evidenceDomains).size !== evidence.length || evidence.length !== parsed.domains.length ||
    !parsed.domains.every((domain) => evidenceDomains.includes(domain))) {
    return result("invalid", ["evidence_domain_mismatch"], base);
  }
  const identityMismatch = evidence
    .filter((item) => parsed.runIdsByDomain.get(item.domain) !== item.snapshot.source_evaluation_run_id)
    .map((item) => `evidence_current_run_mismatch:${item.domain}`);
  if (identityMismatch.length > 0) return result("invalid", identityMismatch, base);
  const expectedPairs = evidence.map((item) => `${item.domain}:${item.snapshot.source_evaluation_run_id}`).sort().join("|");
  if (typeof current.prompt_version !== "string" || !current.prompt_version || current.prompt_version.includes("|") ||
    parsed.inputFingerprint !== `${current.prompt_version}|${expectedPairs}`) {
    return result("invalid", ["fingerprint_mismatch"], base);
  }
  // Validate generation evidence independently of the live rows. Otherwise
  // malformed/future inputs can be masked by valid live State replacements.
  const atGeneration = classifyStates(evidence.map((item) => item.snapshot), Date.parse(parsed.evaluatedAt));
  if (atGeneration.usable.length !== evidence.length || evidence.some((item, index) => {
    const classified = atGeneration.usable.find((state) => state.snapshot.domain === item.domain);
    return !classified || classified.freshness !== item.freshness || classified.usability !== input.evidence[index].usability;
  })) return result("invalid", ["evidence_malformed"], base);
  if (Date.parse(current.state_as_of as string) !== Math.min(...evidence.map((item) => Date.parse(item.snapshot.ai_evaluated_at)))) {
    return result("invalid", ["state_as_of_inconsistent"], base);
  }
  const derived = derivedValidUntil(evidence);
  if (parsed.validUntil > derived) return result("invalid", ["valid_until_inconsistent"], base);
  const validUntil = Math.min(parsed.validUntil, derived);
  const withValidity = { ...base, valid_until: new Date(validUntil).toISOString() };

  // 3. expired
  if (now >= validUntil) return result("expired", ["valid_until_passed"], withValidity);

  // 4. live State revalidation
  const classification = classifyStates(input.states, now);
  const usableByDomain = new Map(classification.usable.map((state) => [state.snapshot.domain, state]));
  const excludedByDomain = new Map(classification.excluded.map((item) => [item.domain, item.reason]));
  const invalidReasons: string[] = [];
  const invalidDomains: Array<{ domain: string; reason: string }> = [];
  const liveSources: UsableState[] = [];
  const views: ScenarioSourceDomainView[] = [];

  for (const item of evidence) {
    const domain = item.domain;
    const rows = input.states.filter((row) => row.domain === domain);
    const row = rows.length === 1 ? rows[0] : null;
    views.push({
      domain,
      narrative_freshness: classifyFreshness(domain, row?.ai_evaluated_at, now),
      observation_status: typeof row?.observation_status === "string" && Object.hasOwn(OBSERVATION_RANK, row.observation_status)
        ? row.observation_status : null,
      coverage_status: typeof row?.coverage_status === "string" && Object.hasOwn(COVERAGE_RANK, row.coverage_status)
        ? row.coverage_status : null,
      data_confidence: isConfidence(row?.data_confidence) ? row.data_confidence : null,
      state_evaluated_at: isTime(row?.ai_evaluated_at) ? row.ai_evaluated_at : null,
      quality_changed_since_generation: false,
    });
    if (!row) {
      invalidReasons.push(`state_row_missing:${domain}`);
      invalidDomains.push({ domain, reason: rows.length === 0 ? "state_row_missing" : "state_row_duplicated" });
      continue;
    }
    // Same-run identical re-saves are safe; changed AI content is not. The
    // service role can write these fields without advancing the run identity.
    if (row.source_evaluation_run_id !== item.snapshot.source_evaluation_run_id ||
      !isTime(row.ai_evaluated_at) || Date.parse(row.ai_evaluated_at) !== Date.parse(item.snapshot.ai_evaluated_at)) {
      invalidReasons.push(`state_identity_drift:${domain}`);
      invalidDomains.push({ domain, reason: "state_identity_drift" });
      continue;
    }
    if (["narrative", "bullish_factors", "bearish_factors", "key_risks", "ai_confidence"].some((key) =>
      JSON.stringify(row[key as keyof StateRow]) !== JSON.stringify(item.snapshot[key as keyof StateSnapshot])
    )) {
      invalidReasons.push(`state_content_drift:${domain}`);
      invalidDomains.push({ domain, reason: "state_content_drift" });
      continue;
    }
    const live = usableByDomain.get(domain);
    if (!live) {
      const reason = excludedByDomain.get(domain) ?? "state_unusable";
      invalidReasons.push(`state_unusable:${domain}:${reason}`);
      invalidDomains.push({ domain, reason });
      continue;
    }
    liveSources.push(live);
  }
  if (liveSources.length < MIN_USABLE_DOMAINS) invalidReasons.push("insufficient_usable_states");
  if (invalidReasons.length > 0) {
    return result("invalid", invalidReasons, { ...withValidity, source_domains: views, excluded_or_invalid_domains: invalidDomains });
  }

  // 5 / 6. degraded or usable
  const degraded: string[] = [];
  const excluded: Array<{ domain: string; reason: string }> = [];
  for (const domain of SCENARIO_DOMAINS) {
    if (parsed.domains.includes(domain)) continue;
    degraded.push(`missing_domain:${domain}`);
    excluded.push({ domain, reason: "not_in_scenario" });
    // A usable State the Scenario was not built from means the Scenario lags
    // the available data; reported, never auto-regenerated here.
    if (usableByDomain.has(domain)) degraded.push(`state_available_not_in_scenario:${domain}`);
  }
  for (const live of liveSources) {
    const domain = live.snapshot.domain;
    const snap = evidence.find((item) => item.domain === domain)!;
    for (const weak of live.weakReasons) degraded.push(`${weak}:${domain}`);
    const changed: string[] = [];
    if (live.freshness === "recent" && snap.freshness === "fresh") changed.push(`narrative_aged:${domain}`);
    if (OBSERVATION_RANK[live.snapshot.observation_status] > OBSERVATION_RANK[snap.snapshot.observation_status]) {
      changed.push(`observation_worsened:${domain}`);
    }
    if (COVERAGE_RANK[live.snapshot.coverage_status] > COVERAGE_RANK[snap.snapshot.coverage_status]) {
      changed.push(`coverage_worsened:${domain}`);
    }
    if (live.snapshot.data_confidence < snap.snapshot.data_confidence - EPSILON) changed.push(`data_confidence_decreased:${domain}`);
    degraded.push(...changed);
    const view = views.find((v) => v.domain === domain);
    if (view) view.quality_changed_since_generation = changed.length > 0;
  }

  const missingCount = SCENARIO_DOMAINS.length - liveSources.length;
  const dynamicCap = confidenceCap(liveSources, missingCount);
  const generationCap = confidenceCap(
    evidence.map((item) => ({ snapshot: item.snapshot, freshness: item.freshness, usability: "strong", weakReasons: [] })),
    SCENARIO_DOMAINS.length - evidence.length,
  );
  if (dynamicCap < generationCap - EPSILON) degraded.push("confidence_cap_lowered");
  if (parsed.content.assessment_status === "indeterminate") degraded.push("assessment_indeterminate");

  let effective = Math.min(parsed.confidence, dynamicCap);
  if (parsed.content.assessment_status === "indeterminate") effective = Math.min(effective, INDETERMINATE_CONFIDENCE_CAP);
  effective = Math.max(0, Math.min(1, floor3(effective)));

  return result(degraded.length > 0 ? "degraded" : "usable", degraded, {
    ...withValidity,
    scenario: parsed.content,
    effective_confidence: effective,
    source_domains: views,
    excluded_or_invalid_domains: excluded,
  });
}
