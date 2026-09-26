// Wraps the important-news OpenAI call sites so each call leaves one
// ai_usage_events row (cost optimisation Phase 0). The wrapped functions are
// the same runners/requesters the pipeline already injects, so judgement,
// generation and app-copy behaviour is unchanged; recording is best effort.

import type { AppCopyRequester } from "./app_copy_logic.ts";
import type { BreakingMarketQueryDiagnostics } from "./breaking_market_source_fetchers.ts";
import type { FinalJudgement } from "./importance_judgement_logic.ts";
import type { GenerationRunner, GenerationStep } from "./post_generation_logic.ts";
import { APP_COPY_MODEL } from "./app_copy_logic.ts";
import { type UsageEvent, usageEvent, type UsageFeature, type UsageWriter } from "./usage_ledger.ts";

const CANDIDATES = "important_news_candidates";
const RUNS = "important_news_monitor_runs";

const GENERATION_FEATURE: Record<GenerationStep, UsageFeature> = {
  draft: "news_generation_draft",
  fact: "news_generation_fact",
  fact_retry: "news_generation_fact_retry",
  voice: "news_generation_voice",
  voice_retry: "news_generation_voice_retry",
};

/** Records every generation step (draft / Fact / Voice / retries) against its candidate. */
export function meteredGenerationRunner(runner: GenerationRunner, write: UsageWriter): GenerationRunner {
  return async (step, candidate, generatedText, voiceIssues) => {
    const result = await runner(step, candidate, generatedText, voiceIssues);
    await write([usageEvent({
      feature: GENERATION_FEATURE[step],
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      relatedTable: CANDIDATES,
      relatedId: candidate.id ?? null,
    })]);
    return result;
  };
}

/** Records the app-copy draft and Fact calls against their candidate. */
export function meteredAppCopyRequester(
  requester: AppCopyRequester,
  write: UsageWriter,
  candidateId: string,
): AppCopyRequester {
  return async (step, body) => {
    const result = await requester(step, body);
    await write([usageEvent({
      feature: step === "draft" ? "news_app_copy_draft" : "news_app_copy_fact",
      model: APP_COPY_MODEL,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      relatedTable: CANDIDATES,
      relatedId: candidateId,
    })]);
    return result;
  };
}

/** One Luna row, plus one Sol row carrying the escalation reasons when Sol ran. */
export function judgementUsageEvents(judgement: FinalJudgement, candidateId: string | null): UsageEvent[] {
  const events = [usageEvent({
    feature: "news_judgement_luna",
    model: judgement.luna.model,
    inputTokens: judgement.luna.inputTokens,
    outputTokens: judgement.luna.outputTokens,
    relatedTable: CANDIDATES,
    relatedId: candidateId,
  })];
  if (judgement.sol) {
    events.push(usageEvent({
      feature: "news_judgement_sol",
      detail: judgement.escalationReasons.join("+") || null,
      model: judgement.sol.model,
      inputTokens: judgement.sol.inputTokens,
      outputTokens: judgement.sol.outputTokens,
      relatedTable: CANDIDATES,
      relatedId: candidateId,
    }));
  }
  return events;
}

/** One row per breaking_market query that reached OpenAI (a 429 before any response costs nothing). */
export function breakingSearchUsageEvents(
  diagnostics: readonly BreakingMarketQueryDiagnostics[],
  runId: string | null,
): UsageEvent[] {
  return diagnostics
    .filter((item) => item.webSearchCallCount > 0 || item.inputTokens > 0 || item.outputTokens > 0)
    .map((item) => usageEvent({
      feature: "news_breaking_search",
      detail: item.queryKey,
      model: item.model,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      webSearchCalls: item.webSearchCallCount,
      relatedTable: RUNS,
      relatedId: runId,
    }));
}

/** One row for the headline-trigger triage call (a batch of headlines) against its run. */
export function triggerTriageUsageEvents(
  usage: { model: string; inputTokens: number; outputTokens: number } | null,
  runId: string | null,
): UsageEvent[] {
  if (!usage || (usage.inputTokens <= 0 && usage.outputTokens <= 0)) return [];
  return [usageEvent({
    feature: "news_trigger_triage_luna",
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    relatedTable: RUNS,
    relatedId: runId,
  })];
}

/** One row per headline verification search that reached OpenAI, detailed by the triaged category. */
export function triggerVerifyUsageEvents(
  verifications: ReadonlyArray<{ category: string; diagnostics: BreakingMarketQueryDiagnostics }>,
  runId: string | null,
): UsageEvent[] {
  return verifications
    .filter(({ diagnostics }) => diagnostics.webSearchCallCount > 0 || diagnostics.inputTokens > 0 || diagnostics.outputTokens > 0)
    .map(({ category, diagnostics }) => usageEvent({
      feature: "news_trigger_verify_search",
      detail: category,
      model: diagnostics.model,
      inputTokens: diagnostics.inputTokens,
      outputTokens: diagnostics.outputTokens,
      webSearchCalls: diagnostics.webSearchCallCount,
      relatedTable: RUNS,
      relatedId: runId,
    }));
}
