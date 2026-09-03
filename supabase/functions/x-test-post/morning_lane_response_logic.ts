import {
  type MorningCandidate,
  type MorningSearchLane,
} from "./morning_candidate_logic.ts";
import type { ReportMaterialType } from "./report_material_logic.ts";

export type MorningLaneConditionalFactor = {
  category: "fx" | "rates" | "oil" | "china" | "geopolitics" | "economic_indicator" | "central_bank" | "crypto" | "other";
  headline: string;
  value: string;
  japan_relevance: string;
  timestamp: string;
  source_url: string;
  material_type: ReportMaterialType;
};

export type MorningLanePacket = {
  lane: MorningSearchLane;
  candidates: Array<Omit<MorningCandidate, "lane">>;
  conditional_factors: MorningLaneConditionalFactor[];
  source_urls: string[];
  fact_check_notes: string[];
};

export type MorningLaneFailureCategory =
  | "EMPTY_OUTPUT"
  | "INCOMPLETE"
  | "REFUSAL"
  | "JSON_PARSE_FAILED"
  | "SCHEMA_INVALID";

// One candidate could not be safely normalized and was dropped; the rest of the lane continues.
export type MorningLaneCandidateExclusion = {
  index: number;
  reasons: string[];
};

// A candidate's field value was rewritten into a valid equivalent (e.g. timestamp separator), not fabricated.
export type MorningLaneCandidateNormalization = {
  index: number;
  fields: string[];
};

export type MorningLaneResponseDiagnostics = {
  lane: MorningSearchLane;
  responseStatus: string | null;
  incomplete: boolean;
  incompleteReason: string | null;
  refusal: boolean;
  outputTextItemCount: number;
  outputTextItemLengths: number[];
  parseTargetLength: number;
  jsonParsePassed: boolean;
  schemaValidationPassed: boolean;
  failureCategory: MorningLaneFailureCategory | null;
  schemaIssues: string[];
  candidateReturnedCount: number;
  candidateExclusions: MorningLaneCandidateExclusion[];
  candidateNormalizations: MorningLaneCandidateNormalization[];
};

export class MorningLaneResponseError extends Error {
  readonly diagnostics: MorningLaneResponseDiagnostics;
  context: Record<string, unknown> | null = null;

  constructor(category: MorningLaneFailureCategory, diagnostics: MorningLaneResponseDiagnostics) {
    super(`MORNING_REPORT_${diagnostics.lane.toUpperCase()}_${category}`);
    this.name = "MorningLaneResponseError";
    this.diagnostics = { ...diagnostics, failureCategory: category };
  }
}

const MATERIAL_TYPES = new Set<ReportMaterialType>([
  "realtime_market", "market_session", "central_bank_policy", "economic_indicator",
  "corporate", "geopolitics", "other",
]);
const LEVELS = new Set(["high", "medium", "low"]);
const IMPORTANCE = new Set(["major", "standard", "administrative"]);
const CAUSAL_STRENGTH = new Set(["none", "qualified", "strong"]);
const CONDITIONAL_CATEGORIES = new Set([
  "fx", "rates", "oil", "china", "geopolitics", "economic_indicator", "central_bank", "crypto", "other",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key));
}

function isStringArray(value: unknown, min: number, max: number): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= max &&
    value.every((item) => typeof item === "string");
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T/;

// Format variants that unambiguously mean the same instant (space/slash separators, missing seconds) are
// rewritten to the canonical form. Nothing here invents a date, time, or precision the model did not supply.
function normalizeCandidateTimestamp(
  rawValue: unknown,
  precision: unknown,
): { value: string; normalized: boolean } | null {
  if (typeof rawValue !== "string") return null;
  const trimmed = rawValue.trim();
  const slashFixed = trimmed.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, "$1-$2-$3");
  if (precision === "date") {
    if (DATE_ONLY.test(slashFixed)) return { value: slashFixed, normalized: slashFixed !== trimmed };
    const datePart = slashFixed.slice(0, 10);
    if (DATE_ONLY.test(datePart) && /^[T ]/.test(slashFixed.slice(10))) {
      return { value: datePart, normalized: true };
    }
    return null;
  }
  if (precision === "datetime") {
    if (DATE_TIME.test(trimmed) && Number.isFinite(Date.parse(trimmed))) {
      return { value: trimmed, normalized: false };
    }
    const separatorFixed = slashFixed.replace(
      /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)$/,
      "$1T$2",
    );
    if (DATE_TIME.test(separatorFixed) && Number.isFinite(Date.parse(separatorFixed))) {
      return { value: separatorFixed, normalized: separatorFixed !== trimmed };
    }
    return null;
  }
  return null;
}

const CANDIDATE_KEYS = [
  "title", "summary", "publisher", "source_url", "supporting_source_urls", "timestamp",
  "timestamp_precision", "material_type", "japan_relevance", "japan_relevance_level",
  "market_impact", "importance_class", "causal_claim_strength", "affected_sectors", "what_to_watch",
] as const;

type NormalizedCandidate = Omit<MorningCandidate, "lane">;

// A single candidate's problems never take down the rest of the lane: fields with a safe, unambiguous
// rewrite are normalized in place, everything else falls back to excluding just this candidate with reasons.
function normalizeCandidateEntry(
  value: unknown,
): { candidate: NormalizedCandidate; normalizedFields: string[] } | { excludedReasons: string[] } {
  if (!isRecord(value)) return { excludedReasons: ["not_object"] };
  // Unknown keys are ignored rather than rejected: they carry no data this pipeline reads.
  const reasons: string[] = [];
  const normalizedFields: string[] = [];

  const stringField = (key: (typeof CANDIDATE_KEYS)[number]): string => {
    const raw = value[key];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) reasons.push(key);
    return trimmed;
  };
  const title = stringField("title");
  const summary = stringField("summary");
  const publisher = stringField("publisher");
  const japanRelevance = stringField("japan_relevance");
  const whatToWatch = stringField("what_to_watch");

  const sourceUrl = typeof value.source_url === "string" ? value.source_url.trim() : "";
  if (!isHttpUrl(sourceUrl)) reasons.push("source_url");

  let supportingSourceUrls: string[] = [];
  if (Array.isArray(value.supporting_source_urls)) {
    const validUrls = value.supporting_source_urls.filter(
      (item): item is string => typeof item === "string" && isHttpUrl(item),
    );
    if (validUrls.length !== value.supporting_source_urls.length) normalizedFields.push("supporting_source_urls");
    supportingSourceUrls = validUrls.slice(0, 3);
  } else {
    reasons.push("supporting_source_urls");
  }

  const precision = value.timestamp_precision;
  if (precision !== "date" && precision !== "datetime") reasons.push("timestamp_precision");
  let timestamp = "";
  if (precision === "date" || precision === "datetime") {
    const normalized = normalizeCandidateTimestamp(value.timestamp, precision);
    if (!normalized) {
      reasons.push("timestamp");
    } else {
      timestamp = normalized.value;
      if (normalized.normalized) normalizedFields.push("timestamp");
    }
  }

  const materialType = value.material_type;
  if (!MATERIAL_TYPES.has(materialType as ReportMaterialType)) reasons.push("material_type");
  const japanRelevanceLevel = value.japan_relevance_level;
  if (!LEVELS.has(japanRelevanceLevel as string)) reasons.push("japan_relevance_level");
  const marketImpact = value.market_impact;
  if (!LEVELS.has(marketImpact as string)) reasons.push("market_impact");
  const importanceClass = value.importance_class;
  if (!IMPORTANCE.has(importanceClass as string)) reasons.push("importance_class");
  const causalClaimStrength = value.causal_claim_strength;
  if (!CAUSAL_STRENGTH.has(causalClaimStrength as string)) reasons.push("causal_claim_strength");

  let affectedSectors: string[] = [];
  if (Array.isArray(value.affected_sectors) && value.affected_sectors.every((item) => typeof item === "string")) {
    if (value.affected_sectors.length === 0) {
      reasons.push("affected_sectors");
    } else if (value.affected_sectors.length > 6) {
      affectedSectors = value.affected_sectors.slice(0, 6);
      normalizedFields.push("affected_sectors");
    } else {
      affectedSectors = value.affected_sectors;
    }
  } else {
    reasons.push("affected_sectors");
  }

  if (reasons.length > 0) return { excludedReasons: reasons };
  return {
    candidate: {
      title, summary, publisher, source_url: sourceUrl, supporting_source_urls: supportingSourceUrls,
      timestamp, timestamp_precision: precision, material_type: materialType as ReportMaterialType,
      japan_relevance: japanRelevance, japan_relevance_level: japanRelevanceLevel as MorningCandidate["japan_relevance_level"],
      market_impact: marketImpact as MorningCandidate["market_impact"],
      importance_class: importanceClass as MorningCandidate["importance_class"],
      causal_claim_strength: causalClaimStrength as MorningCandidate["causal_claim_strength"],
      affected_sectors: affectedSectors, what_to_watch: whatToWatch,
    },
    normalizedFields,
  };
}

function validateConditionalFactor(value: unknown, path: string, issues: string[]): boolean {
  const keys = ["category", "headline", "value", "japan_relevance", "timestamp", "source_url", "material_type"];
  if (!isRecord(value)) {
    issues.push(`${path}:not_object`);
    return false;
  }
  if (!hasOnlyKeys(value, keys)) issues.push(`${path}:additional_property`);
  if (!CONDITIONAL_CATEGORIES.has(value.category as string)) issues.push(`${path}.category:invalid_enum`);
  for (const key of ["headline", "value", "japan_relevance", "timestamp"] as const) {
    if (typeof value[key] !== "string") issues.push(`${path}.${key}:invalid_string`);
  }
  if (!isHttpUrl(value.source_url)) issues.push(`${path}.source_url:invalid_url`);
  if (!MATERIAL_TYPES.has(value.material_type as ReportMaterialType)) issues.push(`${path}.material_type:invalid_enum`);
  return issues.length === 0;
}

export function validateMorningLanePacket(
  value: unknown,
  lane: MorningSearchLane,
): {
  passed: boolean;
  issues: string[];
  candidates: NormalizedCandidate[];
  candidateReturnedCount: number;
  candidateExclusions: MorningLaneCandidateExclusion[];
  candidateNormalizations: MorningLaneCandidateNormalization[];
} {
  const issues: string[] = [];
  const candidateExclusions: MorningLaneCandidateExclusion[] = [];
  const candidateNormalizations: MorningLaneCandidateNormalization[] = [];
  const candidates: NormalizedCandidate[] = [];
  const keys = ["lane", "candidates", "conditional_factors", "source_urls", "fact_check_notes"];
  if (!isRecord(value)) {
    return { passed: false, issues: ["root:not_object"], candidates, candidateReturnedCount: 0, candidateExclusions, candidateNormalizations };
  }
  if (!hasOnlyKeys(value, keys)) issues.push("root:additional_property");
  if (value.lane !== lane) issues.push("lane:mismatch");
  // Packet-level structure (candidates must be an array within the lane's cap) is still a hard failure —
  // only what happens *inside* each candidate is now handled per-item below.
  const maxCandidates = lane === "lane_c_supplement" ? 2 : 3;
  let candidateReturnedCount = 0;
  if (!Array.isArray(value.candidates) || value.candidates.length > maxCandidates) {
    issues.push("candidates:invalid_array");
  } else {
    candidateReturnedCount = value.candidates.length;
    value.candidates.forEach((item, index) => {
      const result = normalizeCandidateEntry(item);
      if ("excludedReasons" in result) {
        candidateExclusions.push({
          index,
          reasons: result.excludedReasons.map((field) => `LANE_CANDIDATE_SCHEMA_INVALID:${field}`),
        });
      } else {
        candidates.push(result.candidate);
        if (result.normalizedFields.length > 0) {
          candidateNormalizations.push({ index, fields: result.normalizedFields });
        }
      }
    });
  }
  if (!Array.isArray(value.conditional_factors) || value.conditional_factors.length > 2) {
    issues.push("conditional_factors:invalid_array");
  } else {
    value.conditional_factors.forEach((factor, index) =>
      validateConditionalFactor(factor, `conditional_factors[${index}]`, issues)
    );
  }
  if (!isStringArray(value.source_urls, 0, 8) || !value.source_urls.every(isHttpUrl)) {
    issues.push("source_urls:invalid_urls");
  }
  if (!isStringArray(value.fact_check_notes, 1, 5)) issues.push("fact_check_notes:invalid_array");
  return { passed: issues.length === 0, issues, candidates, candidateReturnedCount, candidateExclusions, candidateNormalizations };
}

function baseDiagnostics(response: unknown, lane: MorningSearchLane): MorningLaneResponseDiagnostics {
  const record = isRecord(response) ? response : {};
  const status = typeof record.status === "string" ? record.status : null;
  const incompleteDetails = isRecord(record.incomplete_details) ? record.incomplete_details : {};
  const incompleteReason = typeof incompleteDetails.reason === "string" ? incompleteDetails.reason : null;
  const output = Array.isArray(record.output) ? record.output : [];
  const contentItems = output.flatMap((item) => {
    if (!isRecord(item) || item.type !== "message" || item.role !== "assistant") return [];
    return Array.isArray(item.content) ? item.content : [];
  }).filter(isRecord);
  const texts = contentItems.filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text as string);
  const refusal = contentItems.some((item) => item.type === "refusal" || typeof item.refusal === "string");
  return {
    lane,
    responseStatus: status,
    incomplete: status === "incomplete",
    incompleteReason,
    refusal,
    outputTextItemCount: texts.length,
    outputTextItemLengths: texts.map((text) => text.length),
    parseTargetLength: texts.length === 1 ? texts[0].trim().length : 0,
    jsonParsePassed: false,
    schemaValidationPassed: false,
    failureCategory: null,
    schemaIssues: [],
    candidateReturnedCount: 0,
    candidateExclusions: [],
    candidateNormalizations: [],
  };
}

export function parseMorningLaneResponse(
  response: unknown,
  lane: MorningSearchLane,
): { packet: MorningLanePacket; diagnostics: MorningLaneResponseDiagnostics } {
  const diagnostics = baseDiagnostics(response, lane);
  if (diagnostics.incomplete || (diagnostics.responseStatus !== null && diagnostics.responseStatus !== "completed")) {
    throw new MorningLaneResponseError("INCOMPLETE", diagnostics);
  }
  if (diagnostics.refusal) throw new MorningLaneResponseError("REFUSAL", diagnostics);
  if (diagnostics.outputTextItemCount === 0) throw new MorningLaneResponseError("EMPTY_OUTPUT", diagnostics);
  if (diagnostics.outputTextItemCount !== 1) {
    diagnostics.schemaIssues = ["response:multiple_output_text_items"];
    throw new MorningLaneResponseError("SCHEMA_INVALID", diagnostics);
  }
  const record = response as Record<string, unknown>;
  const output = record.output as unknown[];
  const assistantContent = output.flatMap((item) => {
    if (!isRecord(item) || item.type !== "message" || item.role !== "assistant") return [];
    return Array.isArray(item.content) ? item.content : [];
  }).filter(isRecord);
  const outputText = assistantContent.find((item) => item.type === "output_text") as Record<string, unknown>;
  const parseTarget = (outputText.text as string).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(parseTarget);
    diagnostics.jsonParsePassed = true;
  } catch {
    throw new MorningLaneResponseError("JSON_PARSE_FAILED", diagnostics);
  }
  const validation = validateMorningLanePacket(parsed, lane);
  diagnostics.schemaIssues = validation.issues;
  diagnostics.schemaValidationPassed = validation.passed;
  diagnostics.candidateReturnedCount = validation.candidateReturnedCount;
  diagnostics.candidateExclusions = validation.candidateExclusions;
  diagnostics.candidateNormalizations = validation.candidateNormalizations;
  if (!validation.passed) throw new MorningLaneResponseError("SCHEMA_INVALID", diagnostics);
  const parsedRecord = parsed as Record<string, unknown>;
  const packet: MorningLanePacket = {
    lane: parsedRecord.lane as MorningSearchLane,
    candidates: validation.candidates,
    conditional_factors: parsedRecord.conditional_factors as MorningLanePacket["conditional_factors"],
    source_urls: parsedRecord.source_urls as string[],
    fact_check_notes: parsedRecord.fact_check_notes as string[],
  };
  return { packet, diagnostics };
}

export function attachMorningLaneFailureContext(
  error: unknown,
  context: Record<string, unknown>,
): unknown {
  if (error instanceof MorningLaneResponseError) error.context = context;
  return error;
}
