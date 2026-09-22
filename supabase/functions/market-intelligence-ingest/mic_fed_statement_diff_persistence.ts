import {
  buildFedStatementAiInput,
  buildFedStatementDiff,
  FED_STATEMENT_DIFF_PROMPT_VERSION,
  type FedStatementAiOutput,
  type FedStatementDeterministicDiff,
  type FedStatementRecord,
} from "./mic_fed_statement_diff.ts";
import { recordAiUsageEvent, type AiUsageEvent } from "./mic_ai_usage_logic.ts";
import { restHeaders, type RestContext } from "./mic_writer_logic.ts";

export const FED_STATEMENT_DIFF_TABLE = "mic_fed_statement_diffs" as const;
export const FED_STATEMENT_DIFF_FEATURE = "mic_fed_statement_diff" as const;

export type FedStatementDiffRow = {
  current_event_id: string;
  previous_event_id: string | null;
  current_document_hash: string;
  previous_document_hash: string | null;
  diff_hash: string;
  meeting_date: string;
  previous_meeting_date: string | null;
  changed_paragraph_count: number;
  material_change_count: number;
  deterministic_diff: FedStatementDeterministicDiff;
  semantic_buckets: string[];
  ai_interpretation: FedStatementAiOutput | null;
  model: string | null;
  prompt_version: string;
  generated_at: string | null;
};

export function buildFedStatementDiffRow(
  current: FedStatementRecord,
  previous: FedStatementRecord | null,
  diff: FedStatementDeterministicDiff,
  aiInterpretation: FedStatementAiOutput | null = null,
  generatedAt: string | null = null,
): FedStatementDiffRow {
  const changed = diff.addedParagraphs.length + diff.removedParagraphs.length + diff.modifiedParagraphs.length;
  return {
    current_event_id: current.eventId,
    previous_event_id: previous?.eventId ?? null,
    current_document_hash: current.documentHash,
    previous_document_hash: previous?.documentHash ?? null,
    diff_hash: diff.diffHash,
    meeting_date: current.meetingDate,
    previous_meeting_date: previous?.meetingDate ?? null,
    changed_paragraph_count: changed,
    material_change_count: diff.changes.filter((change) => change.material).length,
    deterministic_diff: diff,
    semantic_buckets: diff.buckets,
    ai_interpretation: aiInterpretation,
    model: aiInterpretation ? "luna" : null,
    prompt_version: FED_STATEMENT_DIFF_PROMPT_VERSION,
    generated_at: generatedAt,
  };
}

export type FedStatementDiffPipeline = {
  diff: FedStatementDeterministicDiff;
  row: FedStatementDiffRow;
  aiInput: ReturnType<typeof buildFedStatementAiInput>;
  aiSkippedReason: "first_statement_no_baseline" | "no_material_change" | null;
};

export async function buildFedStatementDiffPipeline(
  current: FedStatementRecord,
  previous: FedStatementRecord | null,
): Promise<FedStatementDiffPipeline> {
  const diff = await buildFedStatementDiff(previous, current);
  const aiInput = previous ? buildFedStatementAiInput(previous, current, diff) : null;
  return {
    diff,
    row: buildFedStatementDiffRow(current, previous, diff),
    aiInput,
    aiSkippedReason: !previous ? "first_statement_no_baseline" : !diff.material ? "no_material_change" : null,
  };
}

// Candidate-only mock: it validates the Phase 2B4 contract without making a
// network request. Real Luna transport is intentionally a later phase.
export function mockLunaInterpretation(input: NonNullable<ReturnType<typeof buildFedStatementAiInput>>): FedStatementAiOutput {
  return {
    summary: `Deterministic statement wording changes across ${input.changes.length} material paragraph(s).`,
    changes: input.changes.map((change) => ({
      bucket: change.buckets[0] ?? "other",
      direction: "neutral" as const,
      previous: change.previous ?? "",
      current: change.current ?? "",
      interpretation: "Wording change only; no market prediction or external context added.",
      confidence: 0.5,
    })),
    overall_bias_change: "neutral",
    confidence: 0.5,
  };
}

export function buildFedStatementAiUsageEvent(
  diffId: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): AiUsageEvent {
  return {
    feature: FED_STATEMENT_DIFF_FEATURE,
    model: "luna",
    inputTokens,
    outputTokens,
    webSearchCalls: 0,
    costUsd,
    relatedTable: FED_STATEMENT_DIFF_TABLE,
    relatedId: diffId,
  };
}

export async function persistFedStatementDiff(
  ctx: RestContext,
  row: FedStatementDiffRow,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string | null; duplicate: boolean }> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/${FED_STATEMENT_DIFF_TABLE}`,
    {
      method: "POST",
      headers: restHeaders(ctx.secretKey, "return=representation,resolution=ignore-duplicates"),
      body: JSON.stringify(row),
    },
  );
  if (!result.ok) throw new Error(`FED_STATEMENT_DIFF_INSERT_FAILED:${result.status}`);
  const rows = await result.json() as Array<{ id?: unknown }>;
  return { id: typeof rows[0]?.id === "string" ? rows[0].id : null, duplicate: rows.length === 0 };
}

export async function persistFedStatementAiUsage(
  ctx: RestContext,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  diffId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number | null }> {
  return await recordAiUsageEvent(ctx, buildFedStatementAiUsageEvent(diffId, inputTokens, outputTokens, costUsd), fetchImpl);
}
