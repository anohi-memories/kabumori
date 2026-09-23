import {
  buildFedStatementAiInput,
  buildFedStatementDiff,
  FED_STATEMENT_DIFF_PROMPT_VERSION,
  type FedStatementAiOutput,
  type FedStatementDeterministicDiff,
  type FedStatementRecord,
} from "./mic_fed_statement_diff.ts";
import { FED_STATEMENT_LUNA_MODEL } from "./mic_fed_statement_ai_logic.ts";
import type { AiUsageEvent } from "./mic_ai_usage_logic.ts";
import { restHeaders, type RestContext } from "./mic_writer_logic.ts";

export const FED_STATEMENT_DIFF_TABLE = "mic_fed_statement_diffs" as const;
export const FED_STATEMENT_DIFF_FEATURE = "mic_fed_statement_diff" as const;

export type FedStatementAiUsageReceipt = {
  feature: typeof FED_STATEMENT_DIFF_FEATURE;
  diff_id: string;
  diff_hash: string;
  prompt_version: string;
  model: typeof FED_STATEMENT_LUNA_MODEL;
  input_tokens: number;
  output_tokens: number;
  web_search_calls: 0;
  cost_usd: number;
  generated_at: string;
  usage_event_key: string;
};

export function fedStatementAiUsageEventKey(diffId: string, promptVersion: string, diffHash: string): string {
  return `${FED_STATEMENT_DIFF_FEATURE}:${diffId}:${promptVersion}:${diffHash}:${FED_STATEMENT_LUNA_MODEL}`;
}

export function buildFedStatementAiUsageReceipt(params: {
  diffId: string;
  diffHash: string;
  promptVersion: string;
  generatedAt: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}): FedStatementAiUsageReceipt {
  return {
    feature: FED_STATEMENT_DIFF_FEATURE,
    diff_id: params.diffId,
    diff_hash: params.diffHash,
    prompt_version: params.promptVersion,
    model: FED_STATEMENT_LUNA_MODEL,
    input_tokens: params.inputTokens,
    output_tokens: params.outputTokens,
    web_search_calls: 0,
    cost_usd: params.costUsd,
    generated_at: params.generatedAt,
    usage_event_key: fedStatementAiUsageEventKey(params.diffId, params.promptVersion, params.diffHash),
  };
}

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
  ai_usage_receipt: FedStatementAiUsageReceipt | null;
  ai_usage_recorded_at: string | null;
};

export function buildFedStatementDiffRow(
  current: FedStatementRecord,
  previous: FedStatementRecord | null,
  diff: FedStatementDeterministicDiff,
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
    ai_interpretation: null,
    model: null,
    prompt_version: FED_STATEMENT_DIFF_PROMPT_VERSION,
    generated_at: null,
    ai_usage_receipt: null,
    ai_usage_recorded_at: null,
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
    `&select=id,previous_event_id,diff_hash,prompt_version,ai_interpretation,ai_usage_receipt,ai_usage_recorded_at&limit=2`;
  const lookup = await fetchImpl(lookupUrl, { headers: restHeaders(ctx.secretKey) });
  if (!lookup.ok) throw new Error(`FED_STATEMENT_DIFF_LOOKUP_FAILED:${lookup.status}`);
  const existing = await lookup.json() as Array<{
    id?: unknown;
    previous_event_id?: unknown;
    diff_hash?: unknown;
    prompt_version?: unknown;
    ai_interpretation?: unknown;
    ai_usage_receipt?: unknown;
    ai_usage_recorded_at?: unknown;
  }>;
  if (existing.length > 1) throw new Error("FED_STATEMENT_DIFF_MULTIPLE_ACTIVE_ROWS");
  const current = existing[0];
  if (current) {
    const id = typeof current.id === "string" ? current.id : null;
    if (!id) throw new Error("FED_STATEMENT_DIFF_LOOKUP_MISSING_ID");
    const previousEventId = typeof current.previous_event_id === "string" ? current.previous_event_id : null;
    if (previousEventId === row.previous_event_id && current.diff_hash === row.diff_hash && current.prompt_version === row.prompt_version) {
      return { id, outcome: "duplicate" };
    }
    if (current.ai_usage_receipt !== null && current.ai_usage_receipt !== undefined &&
      (current.ai_usage_recorded_at === null || current.ai_usage_recorded_at === undefined)) {
      throw new Error("FED_STATEMENT_DIFF_PENDING_AI_USAGE");
    }
    if (current.ai_interpretation !== null && current.ai_interpretation !== undefined &&
      (current.ai_usage_receipt === null || current.ai_usage_receipt === undefined)) {
      throw new Error("FED_STATEMENT_DIFF_AI_RECEIPT_MISSING");
    }
    const previouslyInterpreted = current.ai_interpretation !== null && current.ai_interpretation !== undefined;
    const aiStateFilter = previouslyInterpreted
      ? "ai_interpretation=not.is.null&ai_usage_receipt=not.is.null&ai_usage_recorded_at=not.is.null"
      : "ai_interpretation=is.null&ai_usage_receipt=is.null";
    const previousFilter = previousEventId === null
      ? "previous_event_id=is.null"
      : `previous_event_id=eq.${encodeURIComponent(previousEventId)}`;
    const replacement = await fetchImpl(
      `${ctx.supabaseUrl}/rest/v1/${FED_STATEMENT_DIFF_TABLE}` +
        `?id=eq.${encodeURIComponent(id)}` +
        `&diff_hash=eq.${encodeURIComponent(String(current.diff_hash))}` +
        `&prompt_version=eq.${encodeURIComponent(String(current.prompt_version))}` +
        `&${previousFilter}&${aiStateFilter}`,
      {
        method: "PATCH",
        headers: restHeaders(ctx.secretKey, "return=representation"),
        body: JSON.stringify(row),
      },
    );
    if (!replacement.ok) throw new Error(`FED_STATEMENT_DIFF_UPDATE_FAILED:${replacement.status}`);
    const replacedRows = await replacement.json() as Array<{ id?: unknown }>;
    if (replacedRows.length !== 1 || replacedRows[0]?.id !== id) {
      throw new Error("FED_STATEMENT_DIFF_CONCURRENT_UPDATE");
    }
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
    claimMarker: string;
    interpretation: FedStatementAiOutput;
    generatedAt: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/${FED_STATEMENT_DIFF_TABLE}` +
      `?id=eq.${encodeURIComponent(params.diffId)}` +
      `&diff_hash=eq.${encodeURIComponent(params.diffHash)}` +
      `&prompt_version=eq.${encodeURIComponent(params.promptVersion)}` +
      `&model=eq.${encodeURIComponent(params.claimMarker)}` +
      `&ai_interpretation=is.null&generated_at=is.null` +
      `&ai_usage_receipt=is.null&ai_usage_recorded_at=is.null`,
    {
      method: "PATCH",
      headers: restHeaders(ctx.secretKey, "return=representation"),
      body: JSON.stringify({
        ai_interpretation: params.interpretation,
        model: FED_STATEMENT_LUNA_MODEL,
        prompt_version: params.promptVersion,
        generated_at: params.generatedAt,
        ai_usage_receipt: buildFedStatementAiUsageReceipt(params),
        ai_usage_recorded_at: null,
      }),
    },
  );
  if (!result.ok) throw new Error(`FED_STATEMENT_AI_UPDATE_FAILED:${result.status}`);
  const rows = await result.json() as Array<{ id?: unknown }>;
  return rows.length === 1 && rows[0]?.id === params.diffId;
}

export async function persistFedStatementAiUsage(
  ctx: RestContext,
  diffId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number; status: "recorded" | "already_recorded" }> {
  const result = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/rpc/record_mic_fed_statement_diff_usage`, {
    method: "POST",
    headers: restHeaders(ctx.secretKey),
    body: JSON.stringify({ p_diff_id: diffId }),
  });
  if (!result.ok) throw new Error(`FED_STATEMENT_AI_USAGE_RPC_FAILED:${result.status}`);
  const rows = await result.json() as unknown;
  if (!Array.isArray(rows) || rows.length !== 1 ||
    !Number.isSafeInteger(rows[0]?.usage_event_id) || rows[0].usage_event_id <= 0 ||
    (rows[0]?.result_status !== "recorded" && rows[0]?.result_status !== "already_recorded")) {
    throw new Error("FED_STATEMENT_AI_USAGE_RPC_MALFORMED");
  }
  return { id: rows[0].usage_event_id, status: rows[0].result_status };
}
