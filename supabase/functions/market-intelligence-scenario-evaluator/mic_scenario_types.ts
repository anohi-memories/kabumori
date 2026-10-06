// Shared types for the MIC Scenario evaluator (Phase 3A). Types only.
// State-level types and the domain list live in the shared policy module so
// the evaluator and the read gate use one definition.
export {
  type ExcludedState,
  type Freshness,
  SCENARIO_DOMAINS,
  type ScenarioDomain,
  type StateRow,
  type StateSnapshot,
  type Usability,
  type UsableState,
} from "../_shared/mic_scenario/policy.ts";

export const SCENARIO_KEY = "market" as const;

export type ScenarioCurrentRow = {
  updatedAt: string;
  sourceStateRunIds: string[];
  inputFingerprint: string | null;
  sourceScenarioRunId: string | null;
};
