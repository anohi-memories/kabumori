import {
  buildFedStatementAiInput,
  buildFedStatementDiff,
  FED_STATEMENT_DIFF_PROMPT_VERSION,
  type FedStatementAiOutput,
  type FedStatementDeterministicDiff,
  type FedStatementRecord,
} from "./mic_fed_statement_diff.ts";
import { FED_STATEMENT_LUNA_MODEL } from "./mic_fed_statement_ai_logic.ts";
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
  const changed = previous
    ? diff.addedParagraphs.length + diff.removedParagraphs.length + diff.modifiedParagraphs.length
    : 0;
  return {
    current_event_id: current.eventId,
    previous_event_id: previous?.eventId ?? null,
    current_document_hash: current.documentHash,
    previous_document_hash: previous?.documentHash ?? null,
    diff_hash: diff.diffHash,
    meeting_date: current.meetingDate,
    previous_meeting_date: previous?.meetingDate ?? null,
    changed_paragraph_count: changed,
    material_change_count: previous
      ? diff.changes.filter((change) => change.material).length + (diff.policyDecisionChange.material ? 1 : 0)
      : 0,
    deterministic_diff: diff,
    semantic_buckets: previous ? diff.buckets : [],
    ai_interpretation: aiInterpretation,
    model: aiInterpretation ? FED_STATEMENT_LUNA_MODEL : null,
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

// Mock-only helper for deterministic unit tests; production uses
// requestFedStatementInterpretation from mic_fed_statement_ai_logic.ts.
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
    model: FED_STATEMENT_LUNA_MODEL,
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
): Promise<{ id: string | null; outcome: "inserted" | "duplicate" | "replaced_baseline" | "recomputed" }> {
  const lookupUrl = `${ctx.supabaseUrl}/rest/v1/${FED_STATEMENT_DIFF_TABLE}` +
    `?current_event_id=eq.${encodeURIComponent(row.current_event_id)}` +
    `&select=id,previous_event_id,diff_hash,prompt_version&limit=2`;
  const lookup = await fetchImpl(lookupUrl, { headers: restHeaders(ctx.secretKey) });
  if (!lookup.ok) throw new Error(`FED_STATEMENT_DIFF_LOOKUP_FAILED:${lookup.status}`);
  const existing = await lookup.json() as Array<{ id?: unknown; previous_event_id?: unknown; diff_hash?: unknown; prompt_version?: unknown }>;
  if (existing.length > 1) throw new Error("FED_STATEMENT_DIFF_MULTIPLE_ACTIVE_ROWS");
  const current = existing[0];
  if (current) {
    const id = typeof current.id === "string" ? current.id : null;
    if (!id) throw new Error("FED_STATEMENT_DIFF_LOOKUP_MISSING_ID");
    const previousEventId = typeof current.previous_event_id === "string" ? current.previous_event_id : null;
    if (previousEventId === row.previous_event_id && current.diff_hash === row.diff_hash && current.prompt_version === row.prompt_version) {
      return { id, outcome: "duplicate" };
    }
    const replacement = await fetchImpl(
      `${ctx.supabaseUrl}/rest/v1/${FED_STATEMENT_DIFF_TABLE}?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: restHeaders(ctx.secretKey, "return=minimal"),
        body: JSON.stringify(row),
      },
    );
    if (!replacement.ok) throw new Error(`FED_STATEMENT_DIFF_UPDATE_FAILED:${replacement.status}`);
    return { id, outcome: previousEventId === null && row.previous_event_id !== null ? "replaced_baseline" : "recomputed" };
  }

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
  const id = typeof rows[0]?.id === "string" ? rows[0].id : null;
  return { id, outcome: rows.length === 0 ? "duplicate" : "inserted" };
}

export async function hasFedStatementAiInterpretation(
  ctx: RestContext,
  diffId: string,
  diffHash: string,
  promptVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/${FED_STATEMENT_DIFF_TABLE}` +
      `?id=eq.${encodeURIComponent(diffId)}&select=id,diff_hash,prompt_version,ai_interpretation&limit=2`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!result.ok) throw new Error(`FED_STATEMENT_AI_STATE_LOOKUP_FAILED:${result.status}`);
  const rows = await result.json() as Array<{ id?: unknown; diff_hash?: unknown; prompt_version?: unknown; ai_interpretation?: unknown }>;
  if (rows.length !== 1 || rows[0]?.id !== diffId) throw new Error("FED_STATEMENT_AI_DIFF_ROW_MISSING_OR_DUPLICATE");
  if (rows[0].diff_hash !== diffHash || rows[0].prompt_version !== promptVersion) {
    throw new Error("FED_STATEMENT_AI_DIFF_IDENTITY_MISMATCH");
  }
  return rows[0].ai_interpretation !== null && rows[0].ai_interpretation !== undefined;
}

export async function persistFedStatementAiInterpretation(
  ctx: RestContext,
  params: {
    diffId: string;
    diffHash: string;
    promptVersion: string;
    interpretation: FedStatementAiOutput;
    generatedAt: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/${FED_STATEMENT_DIFF_TABLE}` +
      `?id=eq.${encodeURIComponent(params.diffId)}` +
      `&diff_hash=eq.${encodeURIComponent(params.diffHash)}` +
      `&prompt_version=eq.${encodeURIComponent(params.promptVersion)}` +
      `&ai_interpretation=is.null`,
    {
      method: "PATCH",
      headers: restHeaders(ctx.secretKey, "return=representation"),
      body: JSON.stringify({
        ai_interpretation: params.interpretation,
        model: FED_STATEMENT_LUNA_MODEL,
        prompt_version: params.promptVersion,
        generated_at: params.generatedAt,
      }),
    },
  );
  if (!result.ok) throw new Error(`FED_STATEMENT_AI_UPDATE_FAILED:${result.status}`);
  const rows = await result.json() as Array<{ id?: unknown }>;
  return rows.length === 1 && rows[0]?.id === params.diffId;
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
