// OpenAI Responses adapter with a fake fetch: exact request, output_text parsing, cached / reasoning usage, refusal,
// incomplete and failed statuses, HTTP and transport errors.
import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterCall } from "./adapter.ts";
import { findModelSpec } from "./model_catalog.ts";
import { buildOpenAiResponsesBody, callOpenAi, openAiUsage, parseOpenAiResponse } from "./openai_adapter.ts";
import { toProviderSchema } from "./schema.ts";
import { resolveProviderApiKey } from "./secrets.ts";
import { FAKE_OPENAI_KEY, fakeEnv, jsonResponse, openAiBody, recordingFetch, type Responder, sampleRequest, VALID_PAYLOAD } from "./test_support.ts";

function call(responder: Responder, overrides: Partial<AdapterCall> = {}) {
  const request = sampleRequest("openai");
  const key = resolveProviderApiKey("openai", fakeEnv().readEnv);
  assert.ok(key.ok);
  const recorder = recordingFetch(responder);
  const adapterCall: AdapterCall = {
    request,
    spec: findModelSpec(request.model)!,
    providerSchema: toProviderSchema("openai", request.jsonSchema.schema).schema,
    key: key.key,
    timeoutMs: 5_000,
    fetch: recorder.fetch,
    nowMs: () => 0,
    ...overrides,
  };
  return { adapterCall, recorder };
}

test("request: Responses API, bearer key, store:false, strict json_schema, effort and output cap only", async () => {
  const { adapterCall, recorder } = call(() => jsonResponse(200, openAiBody(VALID_PAYLOAD), { "x-request-id": "req_openai_1" }));
  const outcome = await callOpenAi(adapterCall);
  assert.ok(outcome.ok);
  const sent = recorder.calls[0];
  assert.equal(sent.url, "https://api.openai.com/v1/responses");
  assert.equal(sent.headers.get("authorization"), `Bearer ${FAKE_OPENAI_KEY}`);
  assert.deepEqual(sent.body, {
    model: "gpt-6.1-sol",
    store: false,
    instructions: "テスト用の指示です。",
    input: "テスト入力",
    reasoning: { effort: "medium" },
    max_output_tokens: 2_000,
    text: { format: { type: "json_schema", name: "sample_output", strict: true, schema: adapterCall.providerSchema } },
  });
  assert.deepEqual(buildOpenAiResponsesBody(adapterCall.request, adapterCall.providerSchema), sent.body);
  assert.equal((sent.body as Record<string, unknown>).temperature, undefined);
});

test("1. response: output_text joined, actual model, request id and usage normalised", async () => {
  const outcome = await callOpenAi(call(() => jsonResponse(200, openAiBody(VALID_PAYLOAD), { "x-request-id": "req_openai_2" })).adapterCall);
  assert.ok(outcome.ok);
  assert.deepEqual(JSON.parse(outcome.text), VALID_PAYLOAD);
  assert.equal(outcome.actualModel, "gpt-6.1-sol-2026-09-01");
  assert.equal(outcome.requestId, "req_openai_2");
  assert.deepEqual(outcome.usage, { inputTokens: 1_000, cacheReadInputTokens: 200, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 120 });
});

test("a response without a model name gives actualModel null (never the configured model)", () => {
  const outcome = parseOpenAiResponse(openAiBody(VALID_PAYLOAD, { model: null }), 200, null);
  assert.ok(outcome.ok);
  assert.equal(outcome.actualModel, null);
});

test("22. usage without counts is unknown; cached tokens never exceed input", () => {
  assert.equal(openAiUsage({ total_tokens: 3 }), null);
  assert.equal(openAiUsage({ input_tokens: 10, input_tokens_details: { cached_tokens: 99 }, output_tokens: 1 })?.cacheReadInputTokens, 10);
  assert.equal(openAiUsage({ input_tokens: 10, output_tokens: 1 })?.reasoningOutputTokens, null);
});

test("16. refusal content and content_filter, 17. max_output_tokens, and failed status keep usage", () => {
  const refusalOutput = [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that." }] }];
  const refusal = parseOpenAiResponse(openAiBody(null, { output: refusalOutput }), 200, null);
  assert.ok(!refusal.ok && refusal.error.code === "REFUSAL" && refusal.error.retryable === false && refusal.usage?.outputTokens === 300);
  const filtered = parseOpenAiResponse(openAiBody(null, { incomplete: "content_filter" }), 200, null);
  assert.ok(!filtered.ok && filtered.error.code === "REFUSAL" && filtered.error.detail === "content_filter");
  const cut = parseOpenAiResponse(openAiBody(null, { incomplete: "max_output_tokens" }), 200, null);
  assert.ok(!cut.ok && cut.error.code === "INCOMPLETE" && cut.error.detail === "max_output_tokens" && cut.usage !== null);
  const failed = parseOpenAiResponse({ ...openAiBody(null), status: "failed", error: { code: "server_error", message: "x" } }, 200, null);
  assert.ok(!failed.ok && failed.error.code === "SERVER_ERROR" && failed.error.retryable);
});

test("HTTP errors carry no usage charge; transport failures are possibly billed", async () => {
  const limited = await callOpenAi(call(() => jsonResponse(429, { error: { type: "rate_limit_exceeded", code: "rate_limit_exceeded", message: "x" } }, { "retry-after": "2" })).adapterCall);
  assert.ok(!limited.ok && limited.error.code === "RATE_LIMITED" && limited.error.retryAfterMs === 2_000 && limited.usage?.inputTokens === 0);
  const quota = await callOpenAi(call(() => jsonResponse(429, { error: { type: "insufficient_quota", code: "insufficient_quota", message: "x" } })).adapterCall);
  assert.ok(!quota.ok && quota.error.code === "CREDIT_EXHAUSTED");
  const network = await callOpenAi(call(() => Promise.reject(new TypeError("dns"))).adapterCall);
  assert.ok(!network.ok && network.error.code === "NETWORK" && network.usage === null);
  const garbage = await callOpenAi(call(() => new Response("oops", { status: 200 })).adapterCall);
  assert.ok(!garbage.ok && garbage.error.code === "PROTOCOL" && garbage.usage === null);
  const timedOut = await callOpenAi(call((_c, _i, init) => new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("a", "AbortError")))), { timeoutMs: 1_000 }).adapterCall);
  assert.ok(!timedOut.ok && timedOut.error.code === "TIMEOUT" && timedOut.error.maybeBilled && timedOut.usage === null);
});
