export type VoiceEvaluationValue = {
  fact_check_status: "passed" | "needs_review";
  factual_concerns: string[];
  human_likeness: number;
  ai_article_likeness: number;
  emoji_count: number;
  emoji_naturalness: number;
  natural_without_emoji: boolean;
  passed: boolean;
  notes: string[];
};

export type VoiceResponseDiagnostics = {
  http_status: number;
  response_status: string | null;
  incomplete_details: { reason: string | null } | null;
  finish_state: string | null;
  output_character_count: number;
  extracted_text_character_count: number;
  output_item_types: string[];
  output_item_statuses: string[];
};

export type VoiceSchemaDiagnostics = {
  missing_fields: string[];
  invalid_fields: string[];
  invalid_types: Array<{ field: string; expected: string; actual: string }>;
  enum_mismatches: Array<{ field: string; actual: string }>;
  array_count_violations: Array<{ field: string; minimum: number; maximum: number; actual: number }>;
  integer_range_violations: Array<{ field: string; minimum: number; maximum: number; actual: number }>;
  unexpected_fields: string[];
};

export class VoiceEvaluationOutputError extends Error {
  readonly responseDiagnostics: VoiceResponseDiagnostics;
  readonly schemaDiagnostics: VoiceSchemaDiagnostics | null;

  constructor(
    code: "VOICE_EVALUATION_EMPTY_OUTPUT" | "VOICE_EVALUATION_JSON_PARSE_FAILED" |
      "VOICE_EVALUATION_SCHEMA_INVALID",
    responseDiagnostics: VoiceResponseDiagnostics,
    schemaDiagnostics: VoiceSchemaDiagnostics | null = null,
  ) {
    super(code);
    this.name = "VoiceEvaluationOutputError";
    this.responseDiagnostics = responseDiagnostics;
    this.schemaDiagnostics = schemaDiagnostics;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, 80) : null;
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function collectVoiceResponseDiagnostics(
  rawResponse: unknown,
  extractedText: string | null,
  httpStatus: number,
): VoiceResponseDiagnostics {
  const response = typeof rawResponse === "object" && rawResponse !== null
    ? rawResponse as Record<string, unknown>
    : {};
  const output = Array.isArray(response.output) ? response.output : [];
  const incomplete = typeof response.incomplete_details === "object" && response.incomplete_details !== null
    ? response.incomplete_details as Record<string, unknown>
    : null;
  const responseStatus = stringValue(response.status);
  const incompleteReason = incomplete ? stringValue(incomplete.reason) : null;
  const itemTypes = output.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const value = stringValue((item as Record<string, unknown>).type);
    return value ? [value] : [];
  });
  const itemStatuses = output.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const value = stringValue((item as Record<string, unknown>).status);
    return value ? [value] : [];
  });
  return {
    http_status: httpStatus,
    response_status: responseStatus,
    incomplete_details: incomplete ? { reason: incompleteReason } : null,
    finish_state: responseStatus === "incomplete" ? incompleteReason ?? "incomplete" : responseStatus,
    output_character_count: serializedLength(response.output),
    extracted_text_character_count: extractedText?.length ?? 0,
    output_item_types: itemTypes,
    output_item_statuses: itemStatuses,
  };
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function emptySchemaDiagnostics(): VoiceSchemaDiagnostics {
  return {
    missing_fields: [],
    invalid_fields: [],
    invalid_types: [],
    enum_mismatches: [],
    array_count_violations: [],
    integer_range_violations: [],
    unexpected_fields: [],
  };
}

function hasSchemaIssues(value: VoiceSchemaDiagnostics): boolean {
  return Object.values(value).some((items) => items.length > 0);
}

export function parseVoiceEvaluationOutput(
  output: string | null,
  responseDiagnostics: VoiceResponseDiagnostics,
): VoiceEvaluationValue {
  if (!output) {
    throw new VoiceEvaluationOutputError("VOICE_EVALUATION_EMPTY_OUTPUT", responseDiagnostics);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new VoiceEvaluationOutputError("VOICE_EVALUATION_JSON_PARSE_FAILED", responseDiagnostics);
  }

  const diagnostics = emptySchemaDiagnostics();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    diagnostics.invalid_fields.push("$");
    diagnostics.invalid_types.push({ field: "$", expected: "object", actual: actualType(parsed) });
    throw new VoiceEvaluationOutputError(
      "VOICE_EVALUATION_SCHEMA_INVALID",
      responseDiagnostics,
      diagnostics,
    );
  }

  const value = parsed as Record<string, unknown>;
  const requiredFields = [
    "fact_check_status", "factual_concerns", "human_likeness", "ai_article_likeness",
    "emoji_count", "emoji_naturalness", "natural_without_emoji", "passed", "notes",
  ];
  diagnostics.missing_fields.push(...requiredFields.filter((field) => !(field in value)));
  diagnostics.unexpected_fields.push(...Object.keys(value).filter((field) => !requiredFields.includes(field)));

  const enumValue = value.fact_check_status;
  if ("fact_check_status" in value) {
    if (typeof enumValue !== "string") {
      diagnostics.invalid_types.push({ field: "fact_check_status", expected: "string", actual: actualType(enumValue) });
    } else if (!["passed", "needs_review"].includes(enumValue)) {
      diagnostics.enum_mismatches.push({ field: "fact_check_status", actual: enumValue.slice(0, 80) });
    }
  }

  const validateStringArray = (field: "factual_concerns" | "notes", minimum: number, maximum: number) => {
    if (!(field in value)) return;
    const fieldValue = value[field];
    if (!Array.isArray(fieldValue)) {
      diagnostics.invalid_types.push({ field, expected: "array", actual: actualType(fieldValue) });
      return;
    }
    if (fieldValue.length < minimum || fieldValue.length > maximum) {
      diagnostics.array_count_violations.push({ field, minimum, maximum, actual: fieldValue.length });
    }
    fieldValue.forEach((item, index) => {
      if (typeof item !== "string") {
        diagnostics.invalid_types.push({ field: `${field}[${index}]`, expected: "string", actual: actualType(item) });
      }
    });
  };
  validateStringArray("factual_concerns", 0, 5);
  validateStringArray("notes", 2, 4);

  const validateInteger = (field: string, minimum: number, maximum: number) => {
    if (!(field in value)) return;
    const fieldValue = value[field];
    if (typeof fieldValue !== "number" || !Number.isInteger(fieldValue)) {
      diagnostics.invalid_types.push({ field, expected: "integer", actual: actualType(fieldValue) });
      return;
    }
    if (fieldValue < minimum || fieldValue > maximum) {
      diagnostics.integer_range_violations.push({ field, minimum, maximum, actual: fieldValue });
    }
  };
  validateInteger("human_likeness", 1, 5);
  validateInteger("ai_article_likeness", 1, 5);
  validateInteger("emoji_count", 0, 10);
  validateInteger("emoji_naturalness", 1, 5);

  for (const field of ["natural_without_emoji", "passed"]) {
    if (field in value && typeof value[field] !== "boolean") {
      diagnostics.invalid_types.push({ field, expected: "boolean", actual: actualType(value[field]) });
    }
  }

  diagnostics.invalid_fields.push(...new Set([
    ...diagnostics.missing_fields,
    ...diagnostics.invalid_types.map((item) => item.field),
    ...diagnostics.enum_mismatches.map((item) => item.field),
    ...diagnostics.array_count_violations.map((item) => item.field),
    ...diagnostics.integer_range_violations.map((item) => item.field),
    ...diagnostics.unexpected_fields,
  ]));

  if (hasSchemaIssues(diagnostics)) {
    throw new VoiceEvaluationOutputError(
      "VOICE_EVALUATION_SCHEMA_INVALID",
      responseDiagnostics,
      diagnostics,
    );
  }
  return value as VoiceEvaluationValue;
}

export function voiceEvaluationFailureNotes(error: unknown): string[] {
  if (!(error instanceof VoiceEvaluationOutputError)) return [];
  const notes = [`VOICE_RESPONSE_DIAGNOSTICS:${JSON.stringify(error.responseDiagnostics)}`];
  if (error.schemaDiagnostics) {
    notes.push(`VOICE_SCHEMA_DIAGNOSTICS:${JSON.stringify(error.schemaDiagnostics)}`);
  }
  return notes;
}
