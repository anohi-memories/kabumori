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
  us_session_date: string;
  candidates: Array<Omit<MorningCandidate, "lane">>;
  conditional_factors: MorningLaneConditionalFactor[];
  source_urls: string[];
  date_consistency_passed: boolean;
  fact_check_notes: string[];
};

export type MorningLaneFailureCategory =
  | "EMPTY_OUTPUT"
  | "INCOMPLETE"
  | "REFUSAL"
  | "JSON_PARSE_FAILED"
  | "SCHEMA_INVALID";

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

function isTimestamp(value: unknown, precision: unknown): boolean {
  if (typeof value !== "string") return false;
  if (precision === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value);
  return precision === "datetime" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function validateCandidate(value: unknown, path: string, issues: string[]): boolean {
  const keys = [
    "title", "summary", "publisher", "source_url", "supporting_source_urls", "timestamp",
    "timestamp_precision", "material_type", "japan_relevance", "japan_relevance_level",
    "market_impact", "importance_class", "causal_claim_strength", "affected_sectors", "what_to_watch",
  ];
  if (!isRecord(value)) {
    issues.push(`${path}:not_object`);
    return false;
  }
  if (!hasOnlyKeys(value, keys)) issues.push(`${path}:additional_property`);
  for (const key of ["title", "summary", "publisher", "japan_relevance", "what_to_watch"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) issues.push(`${path}.${key}:invalid_string`);
  }
  if (!isHttpUrl(value.source_url)) issues.push(`${path}.source_url:invalid_url`);
  if (!isStringArray(value.supporting_source_urls, 0, 3) || !value.supporting_source_urls.every(isHttpUrl)) {
    issues.push(`${path}.supporting_source_urls:invalid_urls`);
  }
  if (value.timestamp_precision !== "date" && value.timestamp_precision !== "datetime") {
    issues.push(`${path}.timestamp_precision:invalid_enum`);
  }
  if (!isTimestamp(value.timestamp, value.timestamp_precision)) issues.push(`${path}.timestamp:invalid`);
  if (!MATERIAL_TYPES.has(value.material_type as ReportMaterialType)) issues.push(`${path}.material_type:invalid_enum`);
  if (!LEVELS.has(value.japan_relevance_level as string)) issues.push(`${path}.japan_relevance_level:invalid_enum`);
  if (!LEVELS.has(value.market_impact as string)) issues.push(`${path}.market_impact:invalid_enum`);
  if (!IMPORTANCE.has(value.importance_class as string)) issues.push(`${path}.importance_class:invalid_enum`);
  if (!CAUSAL_STRENGTH.has(value.causal_claim_strength as string)) issues.push(`${path}.causal_claim_strength:invalid_enum`);
  if (!isStringArray(value.affected_sectors, 1, 6)) issues.push(`${path}.affected_sectors:invalid_array`);
  return issues.length === 0;
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
): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  const keys = [
    "lane", "us_session_date", "candidates", "conditional_factors", "source_urls",
    "date_consistency_passed", "fact_check_notes",
  ];
  if (!isRecord(value)) return { passed: false, issues: ["root:not_object"] };
  if (!hasOnlyKeys(value, keys)) issues.push("root:additional_property");
  if (value.lane !== lane) issues.push("lane:mismatch");
  if (typeof value.us_session_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.us_session_date)) {
    issues.push("us_session_date:invalid");
  }
  const maxCandidates = lane === "lane_c_supplement" ? 2 : 3;
  if (!Array.isArray(value.candidates) || value.candidates.length > maxCandidates) {
    issues.push("candidates:invalid_array");
  } else {
    value.candidates.forEach((candidate, index) => validateCandidate(candidate, `candidates[${index}]`, issues));
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
  if (typeof value.date_consistency_passed !== "boolean") issues.push("date_consistency_passed:invalid_boolean");
  if (!isStringArray(value.fact_check_notes, 1, 5)) issues.push("fact_check_notes:invalid_array");
  return { passed: issues.length === 0, issues };
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
  if (!validation.passed) throw new MorningLaneResponseError("SCHEMA_INVALID", diagnostics);
  return { packet: parsed as MorningLanePacket, diagnostics };
}

export function attachMorningLaneFailureContext(
  error: unknown,
  context: Record<string, unknown>,
): unknown {
  if (error instanceof MorningLaneResponseError) error.context = context;
  return error;
}
