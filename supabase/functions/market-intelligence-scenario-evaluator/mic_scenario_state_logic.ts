// Deterministic (no I/O, no AI) part of the Scenario evaluator: which States
// are usable, whether a new Scenario is warranted, the input fingerprint and
// the confidence cap. Everything that decides whether AI is called lives here;
// the State quality policy itself is shared with the read gate.
import {
  INDETERMINATE_CONFIDENCE_CAP,
  MIN_USABLE_DOMAINS,
  type StateClassification,
} from "../_shared/mic_scenario/policy.ts";
import type { ScenarioCurrentRow, ScenarioDomain, UsableState } from "./mic_scenario_types.ts";

export {
  classifyFreshness,
  classifyStates,
  confidenceCap,
  EXCLUDED_DOMAIN_PENALTY,
  FRESHNESS_HOURS,
  INDETERMINATE_CONFIDENCE_CAP,
  MIN_DATA_CONFIDENCE,
  MIN_USABLE_DOMAINS,
  RECENT_FRESHNESS_FACTOR,
  type StateClassification,
  STRONG_DATA_CONFIDENCE,
} from "../_shared/mic_scenario/policy.ts";

export const SCENARIO_PROMPT_VERSION = "mic-scenario-v1";

// Same string the RPC rebuilds from the snapshots: prompt version plus the
// sorted domain:source_evaluation_run_id pairs.
export function inputFingerprint(usable: readonly UsableState[]): string {
  const pairs = usable
    .map((state) => `${state.snapshot.domain}:${state.snapshot.source_evaluation_run_id}`)
    .sort();
  return [SCENARIO_PROMPT_VERSION, ...pairs].join("|");
}

export type ScenarioDecision =
  | { generate: false; reason: "insufficient_usable_states" | "no_new_state_evaluation"; fingerprint: string | null }
  | { generate: true; reason: string; fingerprint: string; newDomains: ScenarioDomain[] };

// AI runs only when at least one usable State carries a narrative the
// current Scenario was not built from (a new source_evaluation_run_id). A
// status-only refresh, a State aging out, or the identical State set never
// triggers AI.
export function decideScenarioRegeneration(
  classification: StateClassification,
  current: ScenarioCurrentRow,
): ScenarioDecision {
  if (classification.usable.length < MIN_USABLE_DOMAINS) {
    return { generate: false, reason: "insufficient_usable_states", fingerprint: null };
  }
  const fingerprint = inputFingerprint(classification.usable);
  const seen = new Set(current.sourceStateRunIds);
  const newDomains = classification.usable
    .filter((state) => !seen.has(state.snapshot.source_evaluation_run_id))
    .map((state) => state.snapshot.domain);
  const promptChanged = current.sourceScenarioRunId !== null && current.inputFingerprint !== null &&
    current.inputFingerprint.split("|")[0] !== SCENARIO_PROMPT_VERSION;
  if (fingerprint === current.inputFingerprint || (newDomains.length === 0 && !promptChanged)) {
    return { generate: false, reason: "no_new_state_evaluation", fingerprint };
  }
  const reason = promptChanged ? "prompt_version_changed" : current.sourceStateRunIds.length === 0
    ? "initial_scenario"
    : `new_state_evaluation:${[...newDomains].sort().join(",")}`;
  return { generate: true, reason, fingerprint, newDomains };
}

const floor3 = (value: number) => Math.floor(value * 1000) / 1000;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

// Returns {aiConfidence, confidence} ready for numeric(4,3) columns, with
// confidence <= aiConfidence and confidence <= cap guaranteed.
export function clampScenarioConfidence(
  aiConfidence: number,
  cap: number,
  assessmentStatus: "assessed" | "indeterminate",
): { aiConfidence: number; confidence: number } {
  if (![aiConfidence, cap].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error("SCENARIO_CONFIDENCE_INVALID");
  }
  const ai = round3(aiConfidence);
  let bounded = Math.min(aiConfidence, cap);
  if (assessmentStatus === "indeterminate") bounded = Math.min(bounded, INDETERMINATE_CONFIDENCE_CAP);
  return { aiConfidence: ai, confidence: Math.min(floor3(bounded), ai) };
}

// State as of which the Scenario holds: the oldest narrative it used.
export function stateAsOf(usable: readonly UsableState[]): string | null {
  const times = usable.map((state) => state.snapshot.ai_evaluated_at).sort((a, b) => Date.parse(a) - Date.parse(b));
  return times[0] ?? null;
}
