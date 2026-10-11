import type { CaseFixture } from "../fixtures.ts";
import type { NeutralRequest, Provider, ProviderResult, Usage } from "../types.ts";
import { costUsd } from "../pricing.ts";
import { emptyResult } from "./common.ts";
import { recordedDraftText } from "../tasks.ts";

// "recorded" replays what production actually decided and wrote for a fixture case. It is the OpenAI side of the
// comparison for every task that production already ran, so no OpenAI call is repeated. Tokens are the ledger's
// per-call averages for that task (production stores one token total per candidate, not per step), which is why the
// usage is labelled as an average, never as the true usage of that single call.

export type LedgerAverages = Readonly<Record<string, { model: string; avgInputTokens: number; avgOutputTokens: number }>>;

const LEDGER_FEATURE_FOR_TASK: Readonly<Record<string, string>> = {
  judgement_primary: "judgement_luna",
  judgement_detail: "judgement_sol",
  generation_draft: "generation_draft",
  generation_fact: "generation_fact",
  generation_voice: "generation_voice",
  web_search: "breaking_search",
};

function usageFor(taskId: string, averages: LedgerAverages): { model: string; usage: Usage } {
  const entry = averages[LEDGER_FEATURE_FOR_TASK[taskId] ?? ""];
  if (!entry) return { model: "gpt-6-luna", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 } };
  return {
    model: entry.model,
    usage: {
      inputTokens: entry.avgInputTokens,
      outputTokens: entry.avgOutputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchRequests: taskId === "web_search" ? 1 : 0,
    },
  };
}

export function recordedOutput(taskId: string, fixture: CaseFixture): string | null {
  const judgement = fixture.recorded.judgement;
  const generation = fixture.recorded.generation;
  switch (taskId) {
    case "judgement_primary":
    case "judgement_detail":
      return JSON.stringify({
        importance: judgement.importance,
        category: judgement.category,
        affected_entities: judgement.affectedEntities,
        japan_market_relevance: judgement.japanMarketRelevance,
        reason: judgement.reason,
        confidence: judgement.confidence,
        needs_sol: judgement.needsSol,
        fact_check_status: judgement.factCheckStatus,
      });
    case "generation_draft": {
      const post = recordedDraftText(fixture);
      return post === null ? null : JSON.stringify({ text: post, sufficient_information: true, notes: [] });
    }
    case "generation_fact":
      return generation === null || generation.factStatus === null
        ? null
        : JSON.stringify({ passed: generation.factStatus === "passed", issues: generation.factIssues });
    case "generation_voice":
      return generation === null || generation.voiceStatus === null || generation.voiceStatus === "not_run"
        ? null
        : JSON.stringify({ passed: generation.voiceStatus === "passed", issues: generation.voiceIssues });
    default:
      return null;
  }
}

export function createRecordedProvider(cases: readonly CaseFixture[], averages: LedgerAverages): Provider {
  const byId = new Map(cases.map((fixture) => [fixture.caseId, fixture]));
  return {
    name: "recorded",
    model: "openai-recorded",
    label: "openai (recorded production result)",
    run(request: NeutralRequest): Promise<ProviderResult> {
      const result = emptyResult("recorded", "openai-recorded", "openai (recorded production result)");
      const fixture = byId.get(request.caseId);
      const text = fixture ? recordedOutput(request.taskId, fixture) : null;
      if (!fixture || text === null) {
        // Same label as a successful replay of this task, so a missing record does not split the summary row.
        const { model } = usageFor(request.taskId, averages);
        return Promise.resolve({
          ...result,
          model,
          label: `${model} (recorded)`,
          error: { code: "NO_RECORDED_RESULT", status: null, retryable: false, message: `no recorded ${request.taskId} for ${request.caseId}` },
        });
      }
      const { model, usage } = usageFor(request.taskId, averages);
      return Promise.resolve({
        ...result,
        model,
        label: `${model} (recorded)`,
        ok: true,
        text,
        parsed: JSON.parse(text),
        usage,
        costUsd: costUsd(model, usage),
        stopReason: "recorded",
        attempts: 0,
      });
    },
  };
}
