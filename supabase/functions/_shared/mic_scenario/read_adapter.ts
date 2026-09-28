// MIC Phase 3B: server-side read path for the Scenario read gate.
//
// GET-only PostgREST reads of the four authoritative inputs, then the pure
// gate. Never writes, never calls AI, never invokes an evaluator. Intended for
// a future server-side consumer holding a service key; not wired to any
// consumer yet.
//
// Read order: current first, then the run and evidence it points to (both
// immutable once evaluated), then the live States. The reads are not one
// snapshot: if a new Scenario commits or a State changes in between, the gate
// sees an identity mismatch and fails closed (invalid) for that read; the
// next read is consistent again.
import { SCENARIO_DOMAINS, type StateRow, UUID_PATTERN } from "./policy.ts";
import { evaluateScenarioRead, type ScenarioReadInput, type ScenarioReadResult } from "./read_gate.ts";

export type ScenarioReadContext = { supabaseUrl: string; secretKey: string };

const CURRENT_SELECT = "source_scenario_run_id,assessment_status,base_case,upside_case,downside_case,state_conflicts," +
  "confidence,ai_confidence,state_as_of,valid_until,source_state_run_ids,source_state_domains,input_fingerprint,ai_evaluated_at";
const RUN_SELECT = "id,status,input_fingerprint";
const EVIDENCE_SELECT = "scenario_run_id,domain,state_evaluation_run_id,freshness,usability,state_snapshot";
const STATE_SELECT = "domain,narrative,bullish_factors,bearish_factors,key_risks,ai_confidence,data_confidence," +
  "coverage_status,observation_status,ai_evaluated_at,source_evaluation_run_id";

async function getRows(ctx: ScenarioReadContext, path: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>[]> {
  const response = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/${path}`, {
    method: "GET",
    headers: { apikey: ctx.secretKey, Authorization: `Bearer ${ctx.secretKey}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`SCENARIO_READ_FAILED:${response.status}`);
  const rows = await response.json() as unknown;
  if (!Array.isArray(rows)) throw new Error("SCENARIO_READ_INVALID_RESPONSE");
  return rows as Record<string, unknown>[];
}

export async function fetchScenarioReadInput(
  ctx: ScenarioReadContext,
  fetchImpl: typeof fetch = fetch,
): Promise<ScenarioReadInput> {
  const currentRows = await getRows(ctx, `mic_scenario_current?scenario_key=eq.market&select=${CURRENT_SELECT}`, fetchImpl);
  if (currentRows.length > 1) throw new Error("SCENARIO_READ_DUPLICATE_CURRENT");
  const current = currentRows[0] ?? null;
  const runId = current?.source_scenario_run_id;
  let run: Record<string, unknown> | null = null;
  let evidence: Record<string, unknown>[] = [];
  if (typeof runId === "string" && UUID_PATTERN.test(runId)) {
    const runs = await getRows(ctx, `mic_scenario_evaluation_runs?id=eq.${runId}&select=${RUN_SELECT}`, fetchImpl);
    run = runs.length === 1 ? runs[0] : null;
    evidence = await getRows(
      ctx,
      `mic_scenario_evidence?scenario_run_id=eq.${runId}&select=${EVIDENCE_SELECT}&order=domain.asc`,
      fetchImpl,
    );
  }
  const states = await getRows(
    ctx,
    `market_state_current?domain=in.(${SCENARIO_DOMAINS.join(",")})&select=${STATE_SELECT}`,
    fetchImpl,
  ) as StateRow[];
  return { current, run, evidence, states };
}

// A read failure is reported as unavailable (no Scenario could be
// established), never as a usable Scenario.
export async function readScenarioForConsumer(
  ctx: ScenarioReadContext,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<ScenarioReadResult> {
  let input: ScenarioReadInput;
  try {
    input = await fetchScenarioReadInput(ctx, fetchImpl);
  } catch {
    return {
      status: "unavailable",
      reason_codes: ["read_failed"],
      scenario: null,
      effective_confidence: null,
      stored_confidence: null,
      valid_until: null,
      evaluated_at: null,
      source_domains: [],
      excluded_or_invalid_domains: [],
    };
  }
  return evaluateScenarioRead(input, now.getTime());
}
