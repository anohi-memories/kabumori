import {
  FED_STATEMENT_DIFF_PROMPT_VERSION,
  computeFedStatementDiffHash,
  validateFedStatementAiOutput,
  type FedPolicyDecisionChange,
  type FedStatementAiInput,
  type FedStatementParagraphChange,
  type FedStatementSemanticBucket,
} from "./mic_fed_statement_diff.ts";
import {
  FED_STATEMENT_DIFF_TABLE,
  persistFedStatementAiInterpretation,
  persistFedStatementAiUsage,
} from "./mic_fed_statement_diff_persistence.ts";
import {
  FED_STATEMENT_LUNA_MODEL,
  requestFedStatementInterpretation,
  type FedStatementAiRequestResult,
} from "./mic_fed_statement_ai_logic.ts";
import { restHeaders, type RestContext } from "./mic_writer_logic.ts";

export const INTERPRET_FED_STATEMENT_DIFF_ACTION = "interpret_fed_statement_diff" as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const CLAIM_PREFIX = "fed-ai-claim:";
const MAX_AI_CHANGE_TEXT_CHARS = 12_000;
const ALLOWED_BUCKETS = new Set<FedStatementSemanticBucket>([
  "inflation", "labor", "growth/activity", "policy stance", "forward guidance", "balance_sheet",
  "financial_conditions", "risks", "other",
]);

type JsonRecord = Record<string, unknown>;
type FedDecision = "hike" | "cut" | "hold" | "mixed" | "non_rate";
type FedTargetRange = { lower: number; upper: number };
type DiffRow = {
  id: string;
  current_event_id: string;
  previous_event_id: string | null;
  current_document_hash: string;
  previous_document_hash: string | null;
  diff_hash: string;
  meeting_date: string;
  previous_meeting_date: string | null;
  changed_paragraph_count: number;
  material_change_count: number;
  deterministic_diff: JsonRecord;
  semantic_buckets: string[];
  ai_interpretation: unknown;
  model: string | null;
  prompt_version: string;
  generated_at: string | null;
};
type EventRow = {
  id: string;
  event_type: string;
  source_key: string;
  source_name: string;
  source_url: string;
  raw_payload: JsonRecord;
};

export class FedStatementAiActionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 409) {
    super(code);
    this.name = "FedStatementAiActionError";
    this.code = code;
    this.status = status;
  }
}

export type FedStatementAiActionResult =
  | { status: "interpreted"; diff_id: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number; usage_event_id: number | null }
  | { status: "already_interpreted"; diff_id: string }
  | { status: "in_progress"; diff_id: string };

type ActionDependencies = {
  fetchImpl?: typeof fetch;
  requestAi?: (input: FedStatementAiInput) => Promise<FedStatementAiRequestResult>;
  now?: () => Date;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFedDecision(value: unknown): value is FedDecision {
  return value === "hike" || value === "cut" || value === "hold" || value === "mixed" || value === "non_rate";
}

function readRange(ratesValue: unknown): FedTargetRange | null {
  if (!isRecord(ratesValue)) return null;
  const lowerFact = ratesValue.FED_FUNDS_TARGET_LOWER;
  const upperFact = ratesValue.FED_FUNDS_TARGET_UPPER;
  if (!isRecord(lowerFact) || !isRecord(upperFact)) return null;
  if (!isFiniteNumber(lowerFact.new_rate) || !isFiniteNumber(upperFact.new_rate)) return null;
  if (lowerFact.new_rate > upperFact.new_rate) return null;
  return { lower: lowerFact.new_rate, upper: upperFact.new_rate };
}

function rangesEqual(left: FedTargetRange | null, right: FedTargetRange): boolean {
  return left !== null && left.lower === right.lower && left.upper === right.upper;
}

function officialStatementUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.federalreserve.gov" &&
      /^\/newsevents\/pressreleases\/monetary\d{8}a\.htm$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function readEvent(rowValue: unknown, expectedId: string): EventRow {
  if (!isRecord(rowValue) || rowValue.id !== expectedId || rowValue.event_type !== "central_bank_decision" ||
    rowValue.source_key !== "fed" || rowValue.source_name !== "Federal Reserve" || !officialStatementUrl(rowValue.source_url) ||
    !isRecord(rowValue.raw_payload)) {
    throw new FedStatementAiActionError("FED_AI_EVENT_INVALID");
  }
  const raw = rowValue.raw_payload;
  if (raw.central_bank !== "Fed" || raw.source_key !== "fed" || raw.statement_url !== rowValue.source_url ||
    typeof raw.meeting_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.meeting_date) ||
    !isFedDecision(raw.decision) || typeof raw.document_hash !== "string" || !HEX_HASH_PATTERN.test(raw.document_hash)) {
    throw new FedStatementAiActionError("FED_AI_EVENT_PAYLOAD_INVALID");
  }
  return rowValue as unknown as EventRow;
}

function validatePolicyChange(value: unknown): value is FedPolicyDecisionChange {
  if (!isRecord(value)) return false;
  const validRange = (candidate: unknown): candidate is FedTargetRange | null => candidate === null ||
    (isRecord(candidate) && isFiniteNumber(candidate.lower) && isFiniteNumber(candidate.upper) && candidate.lower <= candidate.upper);
  const validDecision = (candidate: unknown): candidate is FedDecision | null => candidate === null || isFedDecision(candidate);
  return validDecision(value.previousDecision) && validDecision(value.currentDecision) &&
    validRange(value.previousRange) && validRange(value.currentRange) &&
    (value.lowerChangeBps === null || isFiniteNumber(value.lowerChangeBps)) &&
    (value.upperChangeBps === null || isFiniteNumber(value.upperChangeBps)) && typeof value.material === "boolean";
}

function materialChanges(value: unknown): Array<{ previous: string | null; current: string | null; buckets: FedStatementSemanticBucket[] }> {
  if (!Array.isArray(value)) throw new FedStatementAiActionError("FED_AI_DIFF_CHANGES_INVALID");
  const selected: Array<{ previous: string | null; current: string | null; buckets: FedStatementSemanticBucket[] }> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.material !== "boolean") throw new FedStatementAiActionError("FED_AI_DIFF_CHANGES_INVALID");
    const previous = item.previous;
    const current = item.current;
    const buckets = item.buckets;
    if ((item.type !== "added" && item.type !== "removed" && item.type !== "modified") ||
      (previous !== null && typeof previous !== "string") || (current !== null && typeof current !== "string") ||
      !Array.isArray(buckets) || !buckets.every((bucket) => typeof bucket === "string" && ALLOWED_BUCKETS.has(bucket as FedStatementSemanticBucket))) {
      throw new FedStatementAiActionError("FED_AI_DIFF_CHANGES_INVALID");
    }
    if (item.material) selected.push({ previous: previous as string | null, current: current as string | null, buckets: buckets as FedStatementSemanticBucket[] });
  }
  return selected;
}

async function readOne<T>(ctx: RestContext, table: string, query: string, fetchImpl: typeof fetch): Promise<T | null> {
  const result = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/${table}?${query}`, { headers: restHeaders(ctx.secretKey) });
  if (!result.ok) throw new FedStatementAiActionError(`FED_AI_READ_FAILED:${table}:${result.status}`, 502);
  const rows = await result.json() as unknown;
  if (!Array.isArray(rows)) throw new FedStatementAiActionError(`FED_AI_READ_MALFORMED:${table}`, 502);
  if (rows.length > 1) throw new FedStatementAiActionError(`FED_AI_READ_NOT_UNIQUE:${table}`);
  return (rows[0] ?? null) as T | null;
}

async function releaseClaim(ctx: RestContext, diffId: string, marker: string, fetchImpl: typeof fetch): Promise<void> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/${FED_STATEMENT_DIFF_TABLE}?id=eq.${encodeURIComponent(diffId)}&model=eq.${encodeURIComponent(marker)}&ai_interpretation=is.null&generated_at=is.null`,
    {
      method: "PATCH",
      headers: restHeaders(ctx.secretKey, "return=minimal"),
      body: JSON.stringify({ model: null }),
    },
  );
  if (!result.ok) throw new FedStatementAiActionError(`FED_AI_CLAIM_RELEASE_FAILED:${result.status}`, 502);
}

export async function executeFedStatementAiAction(
  ctx: RestContext,
  diffId: string,
  apiKey: string,
  dependencies: ActionDependencies = {},
): Promise<FedStatementAiActionResult> {
  if (!UUID_PATTERN.test(diffId)) throw new FedStatementAiActionError("FED_AI_DIFF_ID_INVALID", 400);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const diff = await readOne<DiffRow>(
    ctx,
    FED_STATEMENT_DIFF_TABLE,
    `id=eq.${encodeURIComponent(diffId)}&select=id,current_event_id,previous_event_id,current_document_hash,previous_document_hash,diff_hash,meeting_date,previous_meeting_date,changed_paragraph_count,material_change_count,deterministic_diff,semantic_buckets,ai_interpretation,model,prompt_version,generated_at&limit=2`,
    fetchImpl,
  );
  if (!diff) throw new FedStatementAiActionError("FED_AI_DIFF_NOT_FOUND", 404);
  if (diff.id !== diffId) throw new FedStatementAiActionError("FED_AI_DIFF_ID_MISMATCH");
  if (diff.prompt_version !== FED_STATEMENT_DIFF_PROMPT_VERSION) throw new FedStatementAiActionError("FED_AI_PROMPT_VERSION_MISMATCH");
  if (!HEX_HASH_PATTERN.test(diff.diff_hash) || !isRecord(diff.deterministic_diff) || diff.deterministic_diff.diffHash !== diff.diff_hash) {
    throw new FedStatementAiActionError("FED_AI_DIFF_HASH_INVALID");
  }
  if (diff.ai_interpretation !== null && diff.ai_interpretation !== undefined) {
    if (diff.generated_at === null || diff.generated_at === undefined || diff.model !== FED_STATEMENT_LUNA_MODEL) {
      throw new FedStatementAiActionError("FED_AI_INTERPRETATION_STATE_INCONSISTENT");
    }
    return { status: "already_interpreted", diff_id: diffId };
  }
  if (diff.generated_at !== null && diff.generated_at !== undefined) throw new FedStatementAiActionError("FED_AI_GENERATION_STATE_INCONSISTENT");
  if (diff.model?.startsWith(CLAIM_PREFIX)) return { status: "in_progress", diff_id: diffId };
  if (diff.model !== null && diff.model !== undefined) throw new FedStatementAiActionError("FED_AI_MODEL_STATE_INCONSISTENT");
  if (!diff.current_event_id || !diff.previous_event_id) throw new FedStatementAiActionError("FED_AI_PREVIOUS_EVENT_REQUIRED");
  if (!UUID_PATTERN.test(diff.current_event_id) || !UUID_PATTERN.test(diff.previous_event_id)) throw new FedStatementAiActionError("FED_AI_EVENT_ID_INVALID");
  const deterministic = diff.deterministic_diff;
  if (deterministic.comparisonStatus !== "compared" || deterministic.skipReason !== null ||
    !Array.isArray(deterministic.unchangedParagraphs) || !deterministic.unchangedParagraphs.every((text) => typeof text === "string") ||
    !Array.isArray(deterministic.addedParagraphs) || !deterministic.addedParagraphs.every((text) => typeof text === "string") ||
    !Array.isArray(deterministic.removedParagraphs) || !deterministic.removedParagraphs.every((text) => typeof text === "string") ||
    !Array.isArray(deterministic.modifiedParagraphs) || !deterministic.modifiedParagraphs.every((entry) =>
      isRecord(entry) && typeof entry.previous === "string" && typeof entry.current === "string"
    ) || !Array.isArray(diff.semantic_buckets) || diff.semantic_buckets.length === 0 ||
    !Number.isInteger(diff.material_change_count) || diff.material_change_count <= 0 || deterministic.material !== true) {
    throw new FedStatementAiActionError("FED_AI_MATERIAL_DIFF_REQUIRED");
  }
  if (!validatePolicyChange(deterministic.policyDecisionChange)) throw new FedStatementAiActionError("FED_AI_POLICY_CHANGE_INVALID");
  const policyChange = deterministic.policyDecisionChange;
  const changes = materialChanges(deterministic.changes);
  const allChanges = deterministic.changes as Array<{ material: boolean }>;
  const deterministicBuckets = deterministic.buckets;
  if (!Array.isArray(deterministicBuckets) || !deterministicBuckets.every((bucket) => typeof bucket === "string" && ALLOWED_BUCKETS.has(bucket as FedStatementSemanticBucket)) ||
    !diff.semantic_buckets.every((bucket) => typeof bucket === "string" && ALLOWED_BUCKETS.has(bucket as FedStatementSemanticBucket)) ||
    diff.changed_paragraph_count !== allChanges.length ||
    diff.material_change_count !== allChanges.filter((change) => change.material).length + (policyChange.material ? 1 : 0) ||
    JSON.stringify([...new Set(diff.semantic_buckets)]) !== JSON.stringify(deterministicBuckets)) {
    throw new FedStatementAiActionError("FED_AI_DIFF_METADATA_MISMATCH");
  }
  const recomputedHash = await computeFedStatementDiffHash({
    comparisonStatus: "compared",
    skipReason: null,
    unchangedParagraphs: deterministic.unchangedParagraphs as string[],
    addedParagraphs: deterministic.addedParagraphs as string[],
    removedParagraphs: deterministic.removedParagraphs as string[],
    modifiedParagraphs: deterministic.modifiedParagraphs as Array<{ previous: string; current: string }>,
    changes: deterministic.changes as FedStatementParagraphChange[],
    policyDecisionChange: policyChange,
    buckets: deterministicBuckets as FedStatementSemanticBucket[],
    material: deterministic.material as boolean,
  });
  if (recomputedHash !== diff.diff_hash) throw new FedStatementAiActionError("FED_AI_DIFF_HASH_INVALID");
  if (!policyChange.material && changes.length === 0) throw new FedStatementAiActionError("FED_AI_NO_MATERIAL_CHANGE");
  if (policyChange.material && !diff.semantic_buckets.includes("policy stance")) {
    throw new FedStatementAiActionError("FED_AI_SEMANTIC_BUCKETS_INVALID");
  }

  const [currentRaw, previousRaw] = await Promise.all([
    readOne<unknown>(ctx, "market_events", `id=eq.${encodeURIComponent(diff.current_event_id)}&select=id,event_type,source_key,source_name,source_url,raw_payload&limit=2`, fetchImpl),
    readOne<unknown>(ctx, "market_events", `id=eq.${encodeURIComponent(diff.previous_event_id)}&select=id,event_type,source_key,source_name,source_url,raw_payload&limit=2`, fetchImpl),
  ]);
  const current = readEvent(currentRaw, diff.current_event_id);
  const previous = readEvent(previousRaw, diff.previous_event_id);
  const currentPayload = current.raw_payload;
  const previousPayload = previous.raw_payload;
  const currentRange = readRange(currentPayload.rates);
  const previousRange = readRange(previousPayload.rates);
  if (!currentRange || !previousRange || currentPayload.meeting_date !== diff.meeting_date ||
    previousPayload.meeting_date !== diff.previous_meeting_date || currentPayload.document_hash !== diff.current_document_hash ||
    previousPayload.document_hash !== diff.previous_document_hash) {
    throw new FedStatementAiActionError("FED_AI_EVENT_DIFF_MISMATCH");
  }
  if (policyChange.previousDecision !== previousPayload.decision || policyChange.currentDecision !== currentPayload.decision ||
    !rangesEqual(policyChange.previousRange, previousRange) ||
    !rangesEqual(policyChange.currentRange, currentRange) ||
    policyChange.lowerChangeBps !== Math.round((currentRange.lower - previousRange.lower) * 100) ||
    policyChange.upperChangeBps !== Math.round((currentRange.upper - previousRange.upper) * 100)) {
    throw new FedStatementAiActionError("FED_AI_POLICY_FACTS_MISMATCH");
  }

  const aiInput: FedStatementAiInput = {
    previous: {
      eventId: previous.id,
      meetingDate: String(previousPayload.meeting_date),
      statementUrl: previous.source_url,
      decision: previousPayload.decision as FedDecision,
      targetRange: previousRange,
    },
    current: {
      eventId: current.id,
      meetingDate: String(currentPayload.meeting_date),
      statementUrl: current.source_url,
      decision: currentPayload.decision as FedDecision,
      targetRange: currentRange,
    },
    semanticBuckets: diff.semantic_buckets as FedStatementSemanticBucket[],
    policyDecisionChange: policyChange,
    changes,
  };
  const changedTextChars = changes.reduce((total, change) => total + (change.previous?.length ?? 0) + (change.current?.length ?? 0), 0);
  if (changedTextChars > MAX_AI_CHANGE_TEXT_CHARS) throw new FedStatementAiActionError("FED_AI_CHANGED_TEXT_TOO_LARGE");
  if (!apiKey) throw new FedStatementAiActionError("FED_AI_SECRET_MISSING", 503);

  const marker = `${CLAIM_PREFIX}${crypto.randomUUID()}`;
  const claimResponse = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/${FED_STATEMENT_DIFF_TABLE}?id=eq.${encodeURIComponent(diffId)}&diff_hash=eq.${encodeURIComponent(diff.diff_hash)}&prompt_version=eq.${encodeURIComponent(FED_STATEMENT_DIFF_PROMPT_VERSION)}&ai_interpretation=is.null&generated_at=is.null&model=is.null`,
    {
      method: "PATCH",
      headers: restHeaders(ctx.secretKey, "return=representation"),
      body: JSON.stringify({ model: marker }),
    },
  );
  if (!claimResponse.ok) throw new FedStatementAiActionError(`FED_AI_CLAIM_FAILED:${claimResponse.status}`, 502);
  const claimed = await claimResponse.json() as Array<{ id?: unknown }>;
  if (claimed.length !== 1 || claimed[0]?.id !== diffId) {
    const latest = await readOne<DiffRow>(
      ctx,
      FED_STATEMENT_DIFF_TABLE,
      `id=eq.${encodeURIComponent(diffId)}&select=id,ai_interpretation,model,generated_at&limit=2`,
      fetchImpl,
    );
    if (latest?.ai_interpretation !== null && latest?.ai_interpretation !== undefined && latest.generated_at) {
      return { status: "already_interpreted", diff_id: diffId };
    }
    return { status: "in_progress", diff_id: diffId };
  }

  try {
    const generated = await (dependencies.requestAi ?? ((input) => requestFedStatementInterpretation({ apiKey, input })))(aiInput);
    if (!validateFedStatementAiOutput(generated.output)) throw new FedStatementAiActionError("FED_AI_OUTPUT_INVALID", 502);
    if (generated.model !== FED_STATEMENT_LUNA_MODEL || !Number.isInteger(generated.inputTokens) || generated.inputTokens < 0 ||
      !Number.isInteger(generated.outputTokens) || generated.outputTokens < 0 || !Number.isFinite(generated.costUsd) || generated.costUsd < 0) {
      throw new FedStatementAiActionError("FED_AI_USAGE_INVALID", 502);
    }
    const saved = await persistFedStatementAiInterpretation(ctx, {
      diffId,
      diffHash: diff.diff_hash,
      promptVersion: FED_STATEMENT_DIFF_PROMPT_VERSION,
      claimMarker: marker,
      interpretation: generated.output,
      generatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    }, fetchImpl);
    if (!saved) throw new FedStatementAiActionError("FED_AI_RESULT_NOT_PERSISTED", 502);
    const usage = await persistFedStatementAiUsage(ctx, generated.inputTokens, generated.outputTokens, generated.costUsd, diffId, fetchImpl);
    return {
      status: "interpreted",
      diff_id: diffId,
      model: generated.model,
      input_tokens: generated.inputTokens,
      output_tokens: generated.outputTokens,
      cost_usd: generated.costUsd,
      usage_event_id: usage.id,
    };
  } catch (error) {
    await releaseClaim(ctx, diffId, marker, fetchImpl);
    if (error instanceof FedStatementAiActionError) throw error;
    throw new FedStatementAiActionError("FED_AI_EXECUTION_FAILED", 502);
  }
}
