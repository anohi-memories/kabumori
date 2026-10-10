import type { CaseFixture } from "./fixtures.ts";
import type { NeutralRequest } from "./types.ts";
import { captureOpenAiRequest } from "./capture.ts";
import { fromOpenAiResponsesBody } from "./neutral.ts";
import {
  type JudgementCandidate,
  type ModelJudgement,
  requestImportantNewsJudgement,
} from "../../../supabase/functions/important-news-monitor/importance_judgement_logic.ts";
import {
  type GenerationCandidate,
  requestGenerationStep,
} from "../../../supabase/functions/important-news-monitor/post_generation_logic.ts";
import { breakingMarketRequestBody } from "../../../supabase/functions/important-news-monitor/breaking_market_source_fetchers.ts";
import {
  DAILY_BREAKING_MARKET_QUERIES,
} from "../../../supabase/functions/important-news-monitor/breaking_market_daily_schedule.ts";

// The comparison tasks. Each one asks a PRODUCTION request builder for the exact prompt and schema it would send
// (via captureOpenAiRequest), so the harness never carries a copy of a prompt that could drift from production.

export const TASK_IDS = [
  "judgement_primary",   // B: the first-pass importance judgement (production: gpt-6-luna, effort low)
  "judgement_detail",    // C: the escalation judgement (production: gpt-6-sol, effort medium)
  "generation_draft",    // D: news post generation
  "generation_fact",     // E: Fact check of a generated post
  "generation_voice",    // E: Voice check of a generated post
  "web_search",          // A: the daily generic web-search topics
] as const;

export type TaskId = typeof TASK_IDS[number];

const FAKE_KEY = "capture-only";

export function judgementCandidate(fixture: CaseFixture): JudgementCandidate {
  const c = fixture.candidate;
  return {
    id: fixture.caseId,
    sourceType: c.sourceType,
    sourceUrl: c.sourceUrl,
    sourceName: c.sourceName,
    title: c.title,
    bodySummary: c.bodySummary,
    companyName: c.companyName,
    companyCode: c.companyCode,
    entityKey: c.entityKey,
    category: c.category,
    publishedAt: c.publishedAt,
  };
}

export function generationCandidate(fixture: CaseFixture): GenerationCandidate {
  const c = fixture.candidate;
  const judgement = fixture.recorded.judgement;
  return {
    id: fixture.caseId,
    sourceType: c.sourceType,
    sourceUrl: c.sourceUrl,
    sourceName: c.sourceName,
    title: c.title,
    bodySummary: c.bodySummary,
    companyName: c.companyName,
    companyCode: c.companyCode,
    entityKey: c.entityKey,
    category: c.category,
    publishedAt: c.publishedAt,
    importance: judgement.importance === "no_post" ? "important" : judgement.importance,
    affectedEntities: judgement.affectedEntities,
    japanMarketRelevance: judgement.japanMarketRelevance,
    judgementReason: judgement.reason,
    judgementFactStatus: judgement.factCheckStatus,
    status: "ready_for_generation",
  };
}

function priorLuna(fixture: CaseFixture): ModelJudgement {
  const j = fixture.recorded.judgement;
  return {
    importance: j.importance,
    category: j.category,
    affectedEntities: j.affectedEntities,
    japanMarketRelevance: j.japanMarketRelevance,
    reason: j.reason,
    confidence: j.confidence,
    needsSol: true,
    factCheckStatus: j.factCheckStatus,
    model: "gpt-6-luna",
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
  };
}

/** The post exactly as production stored it: headline label, body and the appended source line. Fact / Voice check this. */
export function recordedFinalText(fixture: CaseFixture): string | null {
  return fixture.recorded.generation?.text ?? null;
}

/** The draft body production's draft step returned, i.e. the stored post minus the label and source line it adds later. */
export function recordedDraftText(fixture: CaseFixture): string | null {
  const text = recordedFinalText(fixture);
  return text === null
    ? null
    : text.replace(/\n*出典:\s*\S+\s*$/u, "").replace(/^(?:【(?:重大)?速報】\s*)+/u, "").trim();
}

/** Builds the neutral request for one task/case, or null when the case has nothing to run it on. */
export async function buildTaskRequest(taskId: Exclude<TaskId, "web_search">, fixture: CaseFixture): Promise<NeutralRequest | null> {
  const meta = { taskId, caseId: fixture.caseId };
  if (taskId === "judgement_primary") {
    const captured = await captureOpenAiRequest((fetchImpl) =>
      requestImportantNewsJudgement(FAKE_KEY, judgementCandidate(fixture), "gpt-6-luna", undefined, fetchImpl)
    );
    return fromOpenAiResponsesBody(captured.body, meta);
  }
  if (taskId === "judgement_detail") {
    const captured = await captureOpenAiRequest((fetchImpl) =>
      requestImportantNewsJudgement(FAKE_KEY, judgementCandidate(fixture), "gpt-6-sol", priorLuna(fixture), fetchImpl)
    );
    return fromOpenAiResponsesBody(captured.body, meta);
  }
  const post = recordedFinalText(fixture);
  if (taskId === "generation_draft") {
    if (fixture.recorded.judgement.importance === "no_post") return null;
    const captured = await captureOpenAiRequest((fetchImpl) =>
      requestGenerationStep(FAKE_KEY, "draft", generationCandidate(fixture), undefined, fetchImpl)
    );
    return fromOpenAiResponsesBody(captured.body, meta);
  }
  if (post === null) return null;
  const step = taskId === "generation_fact" ? "fact" : "voice";
  const captured = await captureOpenAiRequest((fetchImpl) =>
    requestGenerationStep(FAKE_KEY, step, generationCandidate(fixture), post, fetchImpl)
  );
  return fromOpenAiResponsesBody(captured.body, meta);
}

/** A fixed reference time so the recency terms in the search prompt do not change between runs. */
export const SEARCH_REFERENCE_TIME = new Date("2026-10-09T04:00:00Z");

export function buildWebSearchRequests(): NeutralRequest[] {
  return DAILY_BREAKING_MARKET_QUERIES.map((query) =>
    fromOpenAiResponsesBody(breakingMarketRequestBody(query, SEARCH_REFERENCE_TIME), {
      taskId: "web_search",
      caseId: `topic:${query.key}`,
    })
  );
}

/** Production's model class for each task, i.e. what Claude has to beat on the same job. */
export const PRODUCTION_MODEL_FOR_TASK: Readonly<Record<TaskId, string>> = {
  judgement_primary: "gpt-6-luna",
  judgement_detail: "gpt-6-sol",
  generation_draft: "gpt-6-luna",
  generation_fact: "gpt-6-luna",
  generation_voice: "gpt-6-luna",
  web_search: "gpt-5.6-luna",
};
