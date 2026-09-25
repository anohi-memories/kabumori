// Writes one row to the shared ai_usage_events ledger per AI call this
// evaluator makes. Mirrors market-intelligence-ingest/mic_ai_usage_logic.ts;
// duplicated locally rather than imported across function directories,
// consistent with this codebase's existing per-function convention.
//
// The primary relation is the evaluation run (related_table =
// 'mic_state_evaluation_runs', related_id = run id), so every Luna/Sol call
// -- including calls made by a run that later failed -- is attributable to
// exactly one run. The domain stays in feature.
import { restHeaders } from "./mic_state_run_logic.ts";
import type { RestContext } from "./mic_state_run_logic.ts";

export type StateAiUsageEvent = {
  runId: string;
  domain: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export async function recordStateAiUsageEvent(
  ctx: RestContext,
  event: StateAiUsageEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number | null }> {
  const result = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/ai_usage_events`, {
    method: "POST",
    headers: restHeaders(ctx.secretKey, "return=representation"),
    body: JSON.stringify({
      feature: `mic_state_evaluation_${event.domain}`,
      model: event.model,
      input_tokens: event.inputTokens,
      output_tokens: event.outputTokens,
      web_search_calls: 0,
      cost_usd: event.costUsd,
      related_table: "mic_state_evaluation_runs",
      related_id: event.runId,
    }),
  });
  if (!result.ok) {
    throw new Error(`STATE_AI_USAGE_INSERT_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<{ id?: unknown }>;
  const id = rows[0]?.id;
  return { id: typeof id === "number" ? id : null };
}
