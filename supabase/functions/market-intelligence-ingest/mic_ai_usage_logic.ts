// A single writer for the ai_usage_events cost ledger. Nothing in Phase 1A
// calls OpenAI, so nothing calls recordAiUsageEvent yet -- this exists so
// Phase 2 (Market State AI evaluation) has one ledger to write to from day
// one, per docs/market-intelligence/ARCHITECTURE.md section 9, instead of
// adding a fourth ad-hoc copy of the token/cost columns already duplicated
// across important_news_candidates / *_report_runs / useful_tip_verifications
// / post_execution_logs.
import { restHeaders } from "./mic_writer_logic.ts";
import type { RestContext } from "./mic_writer_logic.ts";

export type AiUsageEvent = {
  feature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  webSearchCalls?: number;
  costUsd: number;
  relatedTable?: string | null;
  relatedId?: string | null;
};

export function buildAiUsageEventInsertBody(event: AiUsageEvent): Record<string, unknown> {
  return {
    feature: event.feature,
    model: event.model,
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    web_search_calls: event.webSearchCalls ?? 0,
    cost_usd: event.costUsd,
    related_table: event.relatedTable ?? null,
    related_id: event.relatedId ?? null,
  };
}

export async function recordAiUsageEvent(
  ctx: RestContext,
  event: AiUsageEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number | null }> {
  const result = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/ai_usage_events`, {
    method: "POST",
    headers: restHeaders(ctx.secretKey, "return=representation"),
    body: JSON.stringify(buildAiUsageEventInsertBody(event)),
  });
  if (!result.ok) {
    throw new Error(`AI_USAGE_EVENT_INSERT_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<{ id?: unknown }>;
  const id = rows[0]?.id;
  return { id: typeof id === "number" ? id : null };
}
