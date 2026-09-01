import test from "node:test";
import assert from "node:assert/strict";
import {
  collectVoiceResponseDiagnostics,
  parseVoiceEvaluationOutput,
  VoiceEvaluationOutputError,
  voiceEvaluationFailureNotes,
} from "./voice_evaluation_logic.ts";

const validOutput = JSON.stringify({
  fact_check_status: "passed",
  factual_concerns: [],
  human_likeness: 4,
  ai_article_likeness: 2,
  emoji_count: 3,
  emoji_naturalness: 4,
  natural_without_emoji: true,
  passed: true,
  notes: ["自然です", "事実中心です"],
});

const diagnostics = collectVoiceResponseDiagnostics({
  status: "completed",
  output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: validOutput }] }],
}, validOutput, 200);

test("valid voice JSON passes without changing the schema", () => {
  const parsed = parseVoiceEvaluationOutput(validOutput, diagnostics);
  assert.equal(parsed.fact_check_status, "passed");
  assert.equal(parsed.passed, true);
});

test("invalid JSON gets the dedicated parse error", () => {
  assert.throws(
    () => parseVoiceEvaluationOutput("{not-json", diagnostics),
    (error) => error instanceof VoiceEvaluationOutputError &&
      error.message === "VOICE_EVALUATION_JSON_PARSE_FAILED" && error.schemaDiagnostics === null,
  );
});

test("missing and invalid fields get schema diagnostics", () => {
  const invalid = JSON.stringify({ fact_check_status: "unknown", factual_concerns: "none" });
  assert.throws(() => parseVoiceEvaluationOutput(invalid, diagnostics), (error) => {
    assert.ok(error instanceof VoiceEvaluationOutputError);
    assert.equal(error.message, "VOICE_EVALUATION_SCHEMA_INVALID");
    assert.ok(error.schemaDiagnostics?.missing_fields.includes("passed"));
    assert.ok(error.schemaDiagnostics?.invalid_types.some((item) => item.field === "factual_concerns"));
    assert.ok(error.schemaDiagnostics?.enum_mismatches.some((item) => item.field === "fact_check_status"));
    return true;
  });
});

test("array count and integer range violations are collected together", () => {
  const invalid = JSON.stringify({
    ...JSON.parse(validOutput),
    notes: ["1件だけ"],
    emoji_count: 11,
  });
  assert.throws(() => parseVoiceEvaluationOutput(invalid, diagnostics), (error) => {
    assert.ok(error instanceof VoiceEvaluationOutputError);
    assert.ok(error.schemaDiagnostics?.array_count_violations.some((item) => item.field === "notes"));
    assert.ok(error.schemaDiagnostics?.integer_range_violations.some((item) => item.field === "emoji_count"));
    return true;
  });
});

test("response diagnostics store status and lengths but not raw text", () => {
  const responseDiagnostics = collectVoiceResponseDiagnostics({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", status: "incomplete", content: [{ type: "output_text", text: "secret body" }] }],
  }, "secret body", 200);
  assert.equal(responseDiagnostics.finish_state, "max_output_tokens");
  assert.equal(responseDiagnostics.extracted_text_character_count, 11);
  assert.equal(JSON.stringify(responseDiagnostics).includes("secret body"), false);
});

test("safe failure notes contain diagnostics without the raw output", () => {
  const error = new VoiceEvaluationOutputError(
    "VOICE_EVALUATION_JSON_PARSE_FAILED",
    diagnostics,
  );
  const notes = voiceEvaluationFailureNotes(error);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^VOICE_RESPONSE_DIAGNOSTICS:/);
  assert.equal(notes[0].includes(validOutput), false);
});
