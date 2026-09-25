// MIC Phase 2C-2: turns the Fed statement diff snapshots that index.ts already
// resolved before the AI call (resolveFedStatementDiffEvidence) into an
// optional, AI-visible context for the rates State evaluation.
//
// No I/O and no AI call here. The input is exactly the snapshot set that the
// material RPC later re-verifies under lock and stores as evidence, so what
// the State AI sees is always a subset of the verified snapshots -- never a
// separate query.
//
// ai_interpretation is a secondary AI interpretation of an FOMC statement
// diff, not a Fact. Only the fields the State AI needs are exposed; hashes,
// the usage receipt and DB timestamps stay in the evidence snapshot.
import type { Domain } from "./mic_state_types.ts";
import type { FedStatementDiffSnapshot } from "./mic_state_query_logic.ts";

// Mirrors the generator contract (market-intelligence-ingest
// mic_fed_statement_diff.ts validateFedStatementAiOutput). Duplicated rather
// than imported across function directories, per this codebase's convention.
const CHANGE_BUCKETS = new Set([
  "inflation", "labor", "growth/activity", "policy stance", "forward guidance",
  "balance_sheet", "financial_conditions", "risks", "other",
]);
const CHANGE_DIRECTIONS = new Set(["more_hawkish", "more_dovish", "neutral", "unclear"]);
const OVERALL_BIAS = new Set(["more_hawkish", "more_dovish", "neutral", "mixed", "unclear"]);

// The generator caps output at 2000 tokens, but the stored jsonb column has no
// size constraint. An interpretation over any of these limits is excluded as a
// whole -- never truncated mid-text -- so a bad row cannot inflate the State
// prompt. The largest production interpretation (2026-09-25) was 1,408 chars
// in total: summary 113, 5 changes, longest change interpretation 82.
export const FED_INTERPRETATION_LIMITS = {
  summaryChars: 1000,
  changeInterpretationChars: 500,
  maxChanges: 12,
  maxEntries: 3,
} as const;

export type FedStatementInterpretationChange = {
  bucket: string;
  direction: string;
  interpretation: string;
  confidence: number;
};

export type FedStatementInterpretationContext = {
  meeting_date: string;
  previous_meeting_date: string | null;
  // Deterministic (code-computed) diff metadata.
  changed_paragraph_count: number | null;
  material_change_count: number | null;
  semantic_buckets: string[];
  // Secondary AI interpretation.
  interpretation: {
    summary: string;
    overall_bias_change: string;
    confidence: number;
    changes: FedStatementInterpretationChange[];
  };
  interpretation_model: string;
  interpretation_prompt_version: string | null;
  interpretation_generated_at: string;
};

const charLength = (value: string) => Array.from(value).length;

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseInterpretation(value: unknown): FedStatementInterpretationContext["interpretation"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) return null;
  if (charLength(raw.summary) > FED_INTERPRETATION_LIMITS.summaryChars) return null;
  if (typeof raw.overall_bias_change !== "string" || !OVERALL_BIAS.has(raw.overall_bias_change)) return null;
  if (!isConfidence(raw.confidence)) return null;
  if (!Array.isArray(raw.changes) || raw.changes.length > FED_INTERPRETATION_LIMITS.maxChanges) return null;

  const changes: FedStatementInterpretationChange[] = [];
  for (const item of raw.changes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const change = item as Record<string, unknown>;
    if (typeof change.bucket !== "string" || !CHANGE_BUCKETS.has(change.bucket)) return null;
    if (typeof change.direction !== "string" || !CHANGE_DIRECTIONS.has(change.direction)) return null;
    if (typeof change.interpretation !== "string") return null;
    if (charLength(change.interpretation) > FED_INTERPRETATION_LIMITS.changeInterpretationChars) return null;
    if (!isConfidence(change.confidence)) return null;
    // previous/current (the generator's quotes of the statement wording) are
    // intentionally not passed on: the per-change interpretation already says
    // what changed, and the quotes are the bulk of the free text.
    changes.push({
      bucket: change.bucket,
      direction: change.direction,
      interpretation: change.interpretation,
      confidence: change.confidence,
    });
  }
  return {
    summary: raw.summary,
    overall_bias_change: raw.overall_bias_change,
    confidence: raw.confidence,
    changes,
  };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function toContext(snapshot: FedStatementDiffSnapshot): FedStatementInterpretationContext | null {
  if (snapshot.ai_interpretation === null || snapshot.ai_interpretation === undefined) return null;
  if (typeof snapshot.meeting_date !== "string") return null;
  // An interpretation is only complete once it was written together with its
  // model and generated_at (the explicit AI action stores all three at once).
  if (typeof snapshot.model !== "string" || snapshot.model.length === 0) return null;
  if (typeof snapshot.generated_at !== "string" || snapshot.generated_at.length === 0) return null;
  const interpretation = parseInterpretation(snapshot.ai_interpretation);
  if (!interpretation) return null;
  return {
    meeting_date: snapshot.meeting_date,
    previous_meeting_date: typeof snapshot.previous_meeting_date === "string" ? snapshot.previous_meeting_date : null,
    changed_paragraph_count: nonNegativeInteger(snapshot.changed_paragraph_count),
    material_change_count: nonNegativeInteger(snapshot.material_change_count),
    semantic_buckets: Array.isArray(snapshot.semantic_buckets)
      ? snapshot.semantic_buckets.filter((bucket): bucket is string => typeof bucket === "string")
      : [],
    interpretation,
    interpretation_model: snapshot.model,
    interpretation_prompt_version: typeof snapshot.prompt_version === "string" ? snapshot.prompt_version : null,
    interpretation_generated_at: snapshot.generated_at,
  };
}

function compareSnapshots(a: FedStatementDiffSnapshot, b: FedStatementDiffSnapshot): number {
  // Newest meeting first; the older statements are superseded context. Ties
  // (not expected: one diff per event is enforced upstream) fall back to ids
  // so the order never depends on the DB response order.
  const dateA = typeof a.meeting_date === "string" ? a.meeting_date : "";
  const dateB = typeof b.meeting_date === "string" ? b.meeting_date : "";
  if (dateA !== dateB) return dateA < dateB ? 1 : -1;
  if (a.current_event_id !== b.current_event_id) return a.current_event_id < b.current_event_id ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Only rates carries Fed context. Snapshots without a complete, valid, bounded
// interpretation are skipped (never an error): the Fed event and the diff
// evidence are unaffected, only the extra AI context is omitted.
export function buildFedStatementInterpretationContext(
  domain: Domain,
  snapshots: readonly FedStatementDiffSnapshot[],
): FedStatementInterpretationContext[] {
  if (domain !== "rates") return [];
  return [...snapshots]
    .sort(compareSnapshots)
    .map(toContext)
    .filter((entry): entry is FedStatementInterpretationContext => entry !== null)
    .slice(0, FED_INTERPRETATION_LIMITS.maxEntries);
}
