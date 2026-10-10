// Anthropic adapter through the real SDK with a fake fetch: exact request (URL, headers, body), parsing of thinking
// + text blocks, usage with cache breakdown, stop reasons, error mapping, and the SDK making exactly one attempt.
import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterCall } from "./adapter.ts";
import { anthropicUsage, buildAnthropicParams, callAnthropic } from "./anthropic_adapter.ts";
import { findModelSpec } from "./model_catalog.ts";
import { toProviderSchema } from "./schema.ts";
import { resolveProviderApiKey } from "./secrets.ts";
import { anthropicBody, anthropicError, FAKE_ANTHROPIC_KEY, fakeEnv, jsonResponse, recordingFetch, type Responder, sampleRequest, VALID_PAYLOAD } from "./test_support.ts";

function call(responder: Responder, overrides: Partial<AdapterCall> = {}) {
  const request = sampleRequest("anthropic");
  const key = resolveProviderApiKey("anthropic", fakeEnv().readEnv);
  assert.ok(key.ok);
  const recorder = recordingFetch(responder);
  const adapterCall: AdapterCall = {
    request,
    spec: findModelSpec(request.model)!,
    providerSchema: toProviderSchema("anthropic", request.jsonSchema.schema).schema,
    key: key.key,
    timeoutMs: 5_000,
    fetch: recorder.fetch,
    nowMs: () => 0,
    ...overrides,
  };
  return { adapterCall, recorder };
}

test("request: Messages API URL, x-api-key auth only, adaptive thinking, effort + json_schema, nothing else", async () => {
  const { adapterCall, recorder } = call(() => jsonResponse(200, anthropicBody(VALID_PAYLOAD), { "request-id": "req_ok_1" }));
  const outcome = await callAnthropic(adapterCall);
  assert.ok(outcome.ok);
  assert.equal(recorder.calls.length, 1);
  const sent = recorder.calls[0];
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers.get("x-api-key"), FAKE_ANTHROPIC_KEY);
  assert.equal(sent.headers.get("authorization"), null, "no bearer token is sent alongside the key");
  assert.ok(sent.headers.get("anthropic-version"));
  assert.deepEqual(sent.body, {
    model: "claude-opus-5-5",
    max_tokens: 2_000,
    system: "テスト用の指示です。",
    messages: [{ role: "user", content: "テスト入力" }],
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: adapterCall.providerSchema } },
  });
  const body = sent.body as Record<string, unknown>;
  for (const forbidden of ["temperature", "top_p", "top_k", "tool_choice", "tools", "stream"]) assert.equal(body[forbidden], undefined, forbidden);
  assert.deepEqual(buildAnthropicParams(adapterCall.request, adapterCall.providerSchema), body);
});

test("2. response: thinking block skipped, text kept, actual model and request id read", async () => {
  const { adapterCall } = call(() => jsonResponse(200, anthropicBody(VALID_PAYLOAD, { model: "claude-opus-5-5-20261001" }), { "request-id": "req_ok_2" }));
  const outcome = await callAnthropic(adapterCall);
  assert.ok(outcome.ok);
  assert.deepEqual(JSON.parse(outcome.text), VALID_PAYLOAD);
  assert.equal(outcome.actualModel, "claude-opus-5-5-20261001");
  assert.equal(outcome.requestId, "req_ok_2");
  assert.equal(outcome.stopReason, "end_turn");
  assert.deepEqual(outcome.usage, { inputTokens: 800, cacheReadInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 150 });
});

test("22. usage: total input = uncached + cache reads + cache writes, with the 5m / 1h split", () => {
  assert.deepEqual(anthropicUsage({ input_tokens: 50, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 }, output_tokens: 10 }), {
    inputTokens: 1_350,
    cacheReadInputTokens: 1_000,
    cacheWrite5mInputTokens: 200,
    cacheWrite1hInputTokens: 100,
    outputTokens: 10,
    reasoningOutputTokens: null,
  });
  const noSplit = anthropicUsage({ input_tokens: 1, cache_creation_input_tokens: 40, output_tokens: 2 });
  assert.equal(noSplit?.cacheWrite1hInputTokens, 40, "unattributed writes priced at the dearer 1h rate");
  assert.equal(anthropicUsage({ output_tokens: 2 }), null, "missing counts are unknown, not zero");
});

test("16. refusal and 17. incomplete stop reasons are failures that keep usage", async () => {
  const refusal = await callAnthropic(call(() => jsonResponse(200, anthropicBody(null, { stopReason: "refusal", stopDetails: { type: "refusal", category: "cyber", explanation: "x" }, text: "" }))).adapterCall);
  assert.equal(refusal.ok, false);
  if (!refusal.ok) {
    assert.deepEqual([refusal.error.code, refusal.error.retryable, refusal.error.detail], ["REFUSAL", false, "cyber"]);
    assert.equal(refusal.usage?.outputTokens, 400);
  }
  for (const stopReason of ["max_tokens", "model_context_window_exceeded", "pause_turn"]) {
    const cut = await callAnthropic(call(() => jsonResponse(200, anthropicBody(null, { stopReason, text: '{"title":' }))).adapterCall);
    assert.equal(cut.ok, false);
    if (!cut.ok) assert.deepEqual([cut.error.code, cut.error.retryable, cut.error.detail], ["INCOMPLETE", false, stopReason]);
  }
  const tool = await callAnthropic(call(() => jsonResponse(200, anthropicBody(null, { stopReason: "tool_use" }))).adapterCall);
  assert.ok(!tool.ok && tool.error.code === "PROTOCOL");
});

test("19. the SDK makes exactly one HTTP attempt on 529 / 429 / 500 (its retries are off)", async () => {
  for (const [status, type] of [[529, "overloaded_error"], [429, "rate_limit_error"], [500, "api_error"]] as const) {
    const { adapterCall, recorder } = call(() => jsonResponse(status, anthropicError(status, type, "x"), { "retry-after": "0", "x-should-retry": "true" }));
    const outcome = await callAnthropic(adapterCall);
    assert.equal(recorder.calls.length, 1, `${status}: one fetch`);
    assert.ok(!outcome.ok);
    if (!outcome.ok) {
      assert.equal(outcome.error.httpStatus, status);
      assert.deepEqual(outcome.usage, { inputTokens: 0, cacheReadInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0, outputTokens: 0, reasoningOutputTokens: null });
    }
  }
});

test("12./13. auth and credit errors are classified through the SDK error classes", async () => {
  const auth = await callAnthropic(call(() => jsonResponse(401, anthropicError(401, "authentication_error", "invalid x-api-key"), { "request-id": "req_auth" })).adapterCall);
  assert.ok(!auth.ok && auth.error.code === "AUTH" && auth.requestId === "req_auth");
  const credit = await callAnthropic(call(() => jsonResponse(400, anthropicError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."))).adapterCall);
  assert.ok(!credit.ok && credit.error.code === "CREDIT_EXHAUSTED");
  const billing = await callAnthropic(call(() => jsonResponse(402, anthropicError(402, "billing_error", "billing"))).adapterCall);
  assert.ok(!billing.ok && billing.error.code === "CREDIT_EXHAUSTED");
});

test("14. timeout and 15. network failure: possibly billed, usage unknown", async () => {
  const { adapterCall } = call((_call, _index, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
  , { timeoutMs: 1_000 });
  const timedOut = await callAnthropic(adapterCall);
  assert.ok(!timedOut.ok);
  if (!timedOut.ok) {
    assert.equal(timedOut.error.code, "TIMEOUT");
    assert.equal(timedOut.error.maybeBilled, true);
    assert.equal(timedOut.usage, null);
  }
  const network = await callAnthropic(call(() => Promise.reject(new TypeError("connection reset"))).adapterCall);
  assert.ok(!network.ok);
  if (!network.ok) {
    assert.equal(network.error.code, "NETWORK");
    assert.equal(network.usage, null);
  }
});

test("a non-JSON 200 body is a possibly-billed protocol failure", async () => {
  const outcome = await callAnthropic(call(() => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "application/json" } })).adapterCall);
  assert.ok(!outcome.ok);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "PROTOCOL");
    assert.equal(outcome.usage, null);
  }
});
