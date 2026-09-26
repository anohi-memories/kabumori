// Cost visibility for the important-news pipeline (cost optimisation Phase 0).
//
// Every OpenAI call made by this Function is written, best effort, to the
// existing public.ai_usage_events table (no schema change): one row per call,
// with tokens, web_search calls and an estimated cost. Before this, the
// breaking_market web_search calls, app-copy calls and the per-step split of
// judgement/generation were not recorded at all, so the account balance and
// the database disagreed (docs/news-cost-optimization/AUDIT_AND_PLAN.md).
//
// Recording never blocks or fails the pipeline: a failed write is logged and
// ignored. Rates live here only, and every row keeps the raw token/call counts
// so the estimate can be recomputed once billing confirms the real prices.

export type PricedModel = "gpt-5.6-luna" | "gpt-6-luna" | "gpt-5.6-sol" | "gpt-6-sol";

/** USD per 1M tokens. */
export const MODEL_RATES: Record<PricedModel, { input: number; output: number }> = {
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-5.6-sol": { input: 4, output: 20 },
  "gpt-6-sol": { input: 2, output: 10 },
};

/** USD per web_search tool call (same assumption as x-test-post's morningApiCostUsd). */
export const WEB_SEARCH_CALL_USD = 0.01;

export type UsageFeature =
  | "news_breaking_search"
  | "news_judgement_luna"
  | "news_judgement_sol"
  | "news_generation_draft"
  | "news_generation_fact"
  | "news_generation_fact_retry"
  | "news_generation_voice"
  | "news_generation_voice_retry"
  | "news_app_copy_draft"
  | "news_app_copy_fact"
  | "news_trigger_triage_luna"
  | "news_trigger_verify_search";

export type UsageEvent = {
  /** A UsageFeature, optionally followed by "|detail" (e.g. Sol escalation reasons). */
  feature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  webSearchCalls: number;
  costUsd: number;
  relatedTable: string | null;
  relatedId: string | null;
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number, webSearchCalls = 0): number {
  // Keep 5.6 rates for historical rows; unknown active models use current GPT-6 Luna rates.
  const rates = MODEL_RATES[model as PricedModel] ?? MODEL_RATES["gpt-6-luna"];
  const tokens = (count(inputTokens) * rates.input + count(outputTokens) * rates.output) / 1_000_000;
  return Number((tokens + count(webSearchCalls) * WEB_SEARCH_CALL_USD).toFixed(8));
}

/** input/output token counts from a raw Responses API payload (0 when absent). */
export function usageFromResponse(raw: unknown): { inputTokens: number; outputTokens: number } {
  const usage = (raw as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage;
  return { inputTokens: count(usage?.input_tokens), outputTokens: count(usage?.output_tokens) };
}

export function usageEvent(input: {
  feature: UsageFeature;
  detail?: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  webSearchCalls?: number;
  relatedTable?: string | null;
  relatedId?: string | null;
}): UsageEvent {
  const webSearchCalls = count(input.webSearchCalls ?? 0);
  return {
    feature: input.detail ? `${input.feature}|${input.detail}` : input.feature,
    model: input.model,
    inputTokens: count(input.inputTokens),
    outputTokens: count(input.outputTokens),
    webSearchCalls,
    costUsd: estimateCostUsd(input.model, input.inputTokens, input.outputTokens, webSearchCalls),
    relatedTable: input.relatedTable ?? null,
    relatedId: input.relatedId ?? null,
  };
}

export type UsageSummary = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  webSearchCalls: number;
  estimatedCostUsd: number;
};

export function summarizeUsage(events: readonly UsageEvent[]): UsageSummary {
  const summary = events.reduce(
    (total, event) => ({
      calls: total.calls + 1,
      inputTokens: total.inputTokens + event.inputTokens,
      outputTokens: total.outputTokens + event.outputTokens,
      webSearchCalls: total.webSearchCalls + event.webSearchCalls,
      estimatedCostUsd: total.estimatedCostUsd + event.costUsd,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedCostUsd: 0 },
  );
  return { ...summary, estimatedCostUsd: Number(summary.estimatedCostUsd.toFixed(6)) };
}

export type UsageWriter = (events: readonly UsageEvent[]) => Promise<void>;

/** Writes rows to public.ai_usage_events. Never throws. */
export function supabaseUsageWriter(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
): UsageWriter {
  return async (events) => {
    if (events.length === 0) return;
    try {
      const result = await fetchImpl(`${supabaseUrl}/rest/v1/ai_usage_events`, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(events.map((event) => ({
          feature: event.feature,
          model: event.model,
          input_tokens: event.inputTokens,
          output_tokens: event.outputTokens,
          web_search_calls: event.webSearchCalls,
          cost_usd: event.costUsd,
          related_table: event.relatedTable,
          related_id: event.relatedId,
        }))),
      });
      if (!result.ok) {
        console.error("Important news usage write failed", { code: "NEWS_USAGE_WRITE_FAILED", status: result.status });
      }
    } catch {
      console.error("Important news usage write failed", { code: "NEWS_USAGE_WRITE_FAILED" });
    }
  };
}
