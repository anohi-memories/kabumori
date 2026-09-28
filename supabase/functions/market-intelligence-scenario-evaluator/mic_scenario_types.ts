// Shared types for the MIC Scenario evaluator (Phase 3A). Types only.

export type ScenarioDomain = "rates" | "macro" | "equity_index";

// Phase 3A inputs. fx / commodities / geopolitical can be added in a later
// phase once their States are mature; the DB CHECKs list the same three.
export const SCENARIO_DOMAINS: readonly ScenarioDomain[] = ["rates", "macro", "equity_index"];

export const SCENARIO_KEY = "market" as const;

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

export type ScenarioCurrentRow = {
  updatedAt: string;
  sourceStateRunIds: string[];
  inputFingerprint: string | null;
  sourceScenarioRunId: string | null;
};
