// MIC Phase 3B: server-side read path for the Scenario read gate.
//
// GET-only PostgREST reads of the four authoritative inputs, then the pure
// gate. Never writes, never calls AI, never invokes an evaluator. Intended for
// a future server-side consumer holding a service key; not wired to any
// consumer yet.
//
// Optimistic read validation: current + States before and after immutable
// run/evidence reads. Compare the selected content AND updated_at (ABA guard).
// This is not a DB snapshot/lock: validity is point-in-time, never a lease for
// later consumer work. Updates after the validation boundary require a new read.
import { SCENARIO_DOMAINS, type StateRow, UUID_PATTERN } from "./policy.ts";
import { evaluateScenarioRead, type ScenarioReadInput, type ScenarioReadResult } from "./read_gate.ts";

export type ScenarioReadContext = { supabaseUrl: string; secretKey: string };

const CURRENT_SELECT = "updated_at,prompt_version,source_scenario_run_id,assessment_status,base_case,upside_case,downside_case,state_conflicts," +
  "confidence,ai_confidence,state_as_of,valid_until,source_state_run_ids,source_state_domains,input_fingerprint,ai_evaluated_at";
const RUN_SELECT = "id,status,input_fingerprint";
const EVIDENCE_SELECT = "scenario_run_id,domain,state_evaluation_run_id,freshness,usability,state_snapshot";
const STATE_SELECT = "updated_at,domain,narrative,bullish_factors,bearish_factors,key_risks,ai_confidence,data_confidence," +
  "coverage_status,observation_status,ai_evaluated_at,source_evaluation_run_id";

async function getRows(ctx: ScenarioReadContext, path: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>[]> {
  const response = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/${path}`, {
    method: "GET",
    headers: { apikey: ctx.secretKey, Authorization: `Bearer ${ctx.secretKey}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`SCENARIO_READ_FAILED:${response.status}`);
  const rows = await response.json() as unknown;
  if (!Array.isArray(rows)) throw new Error("SCENARIO_READ_INVALID_RESPONSE");
  if (!rows.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) {
    throw new Error("SCENARIO_READ_INVALID_ROW");
  }
  return rows as Record<string, unknown>[];
}

// JSONB key order and REST row order do not carry meaning.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const canonicalStates = (rows: Record<string, unknown>[]) => rows.map(canonical).sort().join("|");
const hasVersion = (row: Record<string, unknown>) =>
  typeof row.updated_at === "string" && Number.isFinite(Date.parse(row.updated_at));

export async function fetchScenarioReadInput(
  ctx: ScenarioReadContext,
  fetchImpl: typeof fetch = fetch,
): Promise<ScenarioReadInput> {
  const currentRows = await getRows(ctx, `mic_scenario_current?scenario_key=eq.market&select=${CURRENT_SELECT}`, fetchImpl);
  if (currentRows.length > 1) throw new Error("SCENARIO_READ_DUPLICATE_CURRENT");
  const current = currentRows[0] ?? null;
  const statePath = `market_state_current?domain=in.(${SCENARIO_DOMAINS.join(",")})&select=${STATE_SELECT}`;
  const states = await getRows(ctx, statePath, fetchImpl) as StateRow[];
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
  const finalStates = await getRows(ctx, statePath, fetchImpl);
  const finalCurrent = await getRows(ctx, `mic_scenario_current?scenario_key=eq.market&select=${CURRENT_SELECT}`, fetchImpl);
  if (finalCurrent.length > 1) throw new Error("SCENARIO_READ_DUPLICATE_CURRENT");
  const readRace = canonical(current) !== canonical(finalCurrent[0] ?? null) ||
    canonicalStates(states as Record<string, unknown>[]) !== canonicalStates(finalStates) ||
    (current !== null && !hasVersion(current)) || !finalStates.every(hasVersion);
  return { current, run, evidence, states: finalStates, readRace };
}

// A read failure is reported as unavailable (no Scenario could be
// established), never as a usable Scenario.
export async function readScenarioForConsumer(
  ctx: ScenarioReadContext,
  now?: Date,
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
  // Read completion time, not request start: a slow GET cannot extend expiry.
  return evaluateScenarioRead(input, (now ?? new Date()).getTime());
}
