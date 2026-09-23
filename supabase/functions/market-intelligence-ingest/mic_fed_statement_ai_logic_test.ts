import assert from "node:assert/strict";
import test from "node:test";
import { buildFedStatementDiffPipeline } from "./mic_fed_statement_diff_persistence.ts";
import type { FedStatementRecord } from "./mic_fed_statement_diff.ts";
import {
  buildFedStatementAiRequestBody,
  fedStatementLunaCost,
  requestFedStatementInterpretation,
} from "./mic_fed_statement_ai_logic.ts";

const previous: FedStatementRecord = {
  eventId: "previous-event",
  centralBank: "Fed",
  meetingDate: "2026-07-29",
  documentHash: "a".repeat(64),
  statementUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm",
  normalizedText: "The Committee maintained the target range for the federal funds rate at 3-1/2 to 3-3/4 percent.",
  decision: "hold",
  targetRange: { lower: 3.5, upper: 3.75 },
};
const current: FedStatementRecord = {
  ...previous,
  eventId: "current-event",
  meetingDate: "2026-09-16",
  documentHash: "b".repeat(64),
  statementUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm",
  normalizedText: "The Committee decided to raise the target range for the federal funds rate to 3-3/4 to 4 percent.",
  decision: "hike",
  targetRange: { lower: 3.75, upper: 4 },
};
const validOutput = {
  summary: "政策金利の誘導目標が25bp引き上げられました。",
  changes: [{
    bucket: "policy stance",
    direction: "more_hawkish",
    previous: "3.50–3.75%",
    current: "3.75–4.00%",
    interpretation: "目標レンジの引き上げを示します。",
    confidence: 0.98,
  }],
  overall_bias_change: "more_hawkish",
  confidence: 0.98,
};

test("Luna request contains compact changes and structured decision facts only", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, previous);
  assert.ok(pipeline.aiInput);
  const body = buildFedStatementAiRequestBody(pipeline.aiInput!);
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(Object.hasOwn(body, "tools"), false);
  const input = JSON.stringify(body.input);
  assert.match(input, /policyDecisionChange/);
  assert.match(input, /lowerChangeBps/);
  assert.doesNotMatch(input, /normalizedText/);
  assert.match(input, /changes/);
});

test("Responses API structured output and usage are validated", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, previous);
  assert.ok(pipeline.aiInput);
  const captured: { requestBody: Record<string, unknown> | null } = { requestBody: null };
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://api.openai.com/v1/responses");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
    captured.requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(validOutput) }] }],
      usage: { input_tokens: 321, output_tokens: 45 },
    }), { status: 200 }));
  }) as typeof fetch;
  const result = await requestFedStatementInterpretation({ apiKey: "test-key", input: pipeline.aiInput! }, fetchImpl);
  assert.equal(result.model, "gpt-6-luna");
  assert.equal(result.inputTokens, 321);
  assert.equal(result.outputTokens, 45);
  assert.equal(result.costUsd, fedStatementLunaCost(321, 45));
  assert.equal(captured.requestBody?.store, false);
  assert.equal(Object.hasOwn(captured.requestBody ?? {}, "tools"), false);
});

test("invalid structured output fails closed", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, previous);
  assert.ok(pipeline.aiInput);
  const fetchImpl = (() => Promise.resolve(new Response(JSON.stringify({
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ ...validOutput, changes: [{ ...validOutput.changes[0], bucket: "untrusted" }] }) }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200 }))) as typeof fetch;
  await assert.rejects(
    () => requestFedStatementInterpretation({ apiKey: "test-key", input: pipeline.aiInput! }, fetchImpl),
    /FED_STATEMENT_AI_MALFORMED_RESPONSE/,
  );
});

test("cost estimate uses exact model token rates", () => {
  assert.equal(fedStatementLunaCost(1_000_000, 1_000_000), 0.6);
});
