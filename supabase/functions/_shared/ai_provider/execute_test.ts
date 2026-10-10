// executeAiRequest end to end with fake fetch, fake clock and fake keys (required tests 1, 2, 4-28).
// No network: every response below is produced by the test.
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryBudgetGuard } from "./budget.ts";
import { upperBoundAttemptCostUsd } from "./cost.ts";
import { type AiAttemptEvent, executeAiRequest } from "./execute.ts";
import { findModelSpec } from "./model_catalog.ts";
import {
  anthropicBody,
  anthropicError,
  FAKE_ANTHROPIC_KEY,
  FAKE_OPENAI_KEY,
  fakeEnv,
  hangUntilAborted,
  jsonResponse,
  openAiBody,
  recordingFetch,
  type Responder,
  sampleRequest,
  testDeps,
  VALID_PAYLOAD,
} from "./test_support.ts";
import type { AiFailure, AiRequest, AiResult, AiSuccess } from "./types.ts";

function sequence(...responses: Array<Responder>): Responder {
  return (call, index, init) => responses[Math.min(index, responses.length - 1)](call, index, init);
}
const ok = (body: unknown, headers: Record<string, string> = {}): Responder => () => jsonResponse(200, body, headers);
const status = (code: number, body: unknown, headers: Record<string, string> = {}): Responder => () => jsonResponse(code, body, headers);

function success(result: AiResult): AiSuccess {
  assert.equal(result.ok, true, result.ok ? "" : `${(result as AiFailure).errorCode} ${(result as AiFailure).detail}`);
  return result as AiSuccess;
}
function failure(result: AiResult): AiFailure {
  assert.equal(result.ok, false);
  return result as AiFailure;
}

async function run(request: AiRequest, responder: Responder, overrides = {}) {
  const recorder = recordingFetch(responder);
  const harness = testDeps(recorder.fetch, overrides);
  const result = await executeAiRequest(request, harness.deps);
  return { result, calls: recorder.calls, sleeps: harness.sleeps, envReads: harness.envReads, deps: harness.deps };
}

test("1. OpenAI: parsed and schema-checked payload with usage, cache, cost and usage key", async () => {
  const { result, calls, envReads } = await run(sampleRequest("openai"), ok(openAiBody(VALID_PAYLOAD), { "x-request-id": "req_o1" }));
  const value = success(result);
  assert.deepEqual(value.parsedPayload, VALID_PAYLOAD);
  assert.equal(value.provider, "openai");
  assert.equal(value.configuredModel, "gpt-6.1-sol");
  assert.equal(value.actualModel, "gpt-6.1-sol-2026-09-01");
  assert.equal(value.inputTokens, 1_000);
  assert.equal(value.outputTokens, 300);
  assert.equal(value.reasoningOutputTokens, 120);
  assert.deepEqual(value.cacheUsage, { readInputTokens: 200, write5mInputTokens: 0, write1hInputTokens: 0 });
  assert.equal(value.estimatedCostUsd, (800 * 2 + 200 * 0.1 + 300 * 10) / 1_000_000);
  assert.equal(value.costBasis, "measured");
  assert.equal(value.transportAttempts, 1);
  assert.equal(value.requestId, "req_o1");
  assert.deepEqual(value.usageKey, { provider: "openai", model: "gpt-6.1-sol", application: "kabumori", feature: "provider_test", logicalRole: "test.provider.sample", month: "2026-10" });
  assert.equal(calls.length, 1);
  assert.deepEqual(envReads, ["OPENAI_API_KEY"]);
});

test("2. Anthropic: parsed and schema-checked payload with usage, thinking tokens and cost", async () => {
  const { result, calls, envReads } = await run(sampleRequest("anthropic"), ok(anthropicBody(VALID_PAYLOAD)));
  const value = success(result);
  assert.deepEqual(value.parsedPayload, VALID_PAYLOAD);
  assert.equal(value.actualModel, "claude-opus-5-5");
  assert.equal(value.inputTokens, 800);
  assert.equal(value.outputTokens, 400);
  assert.equal(value.reasoningOutputTokens, 150);
  assert.equal(value.estimatedCostUsd, (800 * 4 + 400 * 20) / 1_000_000);
  assert.equal(value.stopReason, "end_turn");
  assert.equal(calls.length, 1);
  assert.deepEqual(envReads, ["ANTHROPIC_API_KEY"]);
});

test("actualModel is null when the response does not name a model", async () => {
  const value = success((await run(sampleRequest("anthropic"), ok(anthropicBody(VALID_PAYLOAD, { model: null })))).result);
  assert.equal(value.actualModel, null);
  assert.equal(value.configuredModel, "claude-opus-5-5");
});

test("4-8. schema violations and invalid JSON are failures, never passed on, and never retried here", async () => {
  const cases: Array<[unknown, string]> = [
    [{ ...VALID_PAYLOAD, score: undefined }, "/score:required"],
    [{ ...VALID_PAYLOAD, score: "high" }, "/score:type"],
    [{ ...VALID_PAYLOAD, score: 7 }, "/score:maximum"],
    [{ ...VALID_PAYLOAD, tags: ["a", "a"] }, "/tags:uniqueItems"],
    [{ ...VALID_PAYLOAD, title: "x".repeat(21) }, "/title:maxLength"],
  ];
  for (const [payload, expected] of cases) {
    const { result, calls } = await run(sampleRequest("anthropic"), ok(anthropicBody(payload)));
    const value = failure(result);
    assert.equal(value.errorCode, "SCHEMA_VIOLATION");
    assert.ok(value.detail?.includes(expected), `${value.detail} should include ${expected}`);
    assert.equal(calls.length, 1);
    assert.ok(value.estimatedCostUsd > 0, "the call was billed even though the output is unusable");
    assert.equal(value.usage.outputTokens, 400);
    assert.equal("parsedPayload" in value, false);
  }
  const broken = failure((await run(sampleRequest("openai"), ok(openAiBody(null, { output: [{ type: "message", content: [{ type: "output_text", text: "{not json" }] }] })))).result);
  assert.equal(broken.errorCode, "INVALID_JSON");
});

test("9. 429 is retried after the provider's retry-after", async () => {
  const { result, calls, sleeps } = await run(
    sampleRequest("anthropic"),
    sequence(status(429, anthropicError(429, "rate_limit_error", "slow"), { "retry-after": "2" }), ok(anthropicBody(VALID_PAYLOAD))),
  );
  const value = success(result);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(value.transportAttempts, 2);
  assert.equal(value.attempts[0].errorCode, "RATE_LIMITED");
  assert.equal(value.attempts[0].estimatedCostUsd, 0, "a rejected request is not billed");
});

test("10. 529 is retried with backoff", async () => {
  const { result, calls, sleeps } = await run(sampleRequest("anthropic"), sequence(status(529, anthropicError(529, "overloaded_error", "busy")), ok(anthropicBody(VALID_PAYLOAD))));
  success(result);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1_000]);
});

test("11. transient 5xx are retried within the attempt limit", async () => {
  const { result, calls, sleeps } = await run(
    sampleRequest("openai"),
    sequence(status(502, { error: { message: "bad gateway" } }), status(503, { error: { message: "unavailable" } }), ok(openAiBody(VALID_PAYLOAD))),
  );
  success(result);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1_000, 2_000]);
});

test("12. authentication failure is not retried", async () => {
  const { result, calls } = await run(sampleRequest("anthropic"), status(401, anthropicError(401, "authentication_error", "invalid x-api-key")));
  const value = failure(result);
  assert.deepEqual([value.errorCode, value.retryable, value.httpStatus, calls.length], ["AUTH", false, 401, 1]);
});

test("13. exhausted credit is not retried (Anthropic and OpenAI)", async () => {
  const claude = await run(sampleRequest("anthropic"), status(400, anthropicError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.")));
  assert.deepEqual([failure(claude.result).errorCode, claude.calls.length], ["CREDIT_EXHAUSTED", 1]);
  const openai = await run(sampleRequest("openai"), status(429, { error: { type: "insufficient_quota", code: "insufficient_quota", message: "quota" } }));
  assert.deepEqual([failure(openai.result).errorCode, openai.calls.length], ["CREDIT_EXHAUSTED", 1]);
});

test("14./26. timeout: not retried by default, charged at the upper bound, usage marked unknown", async () => {
  const request = sampleRequest("anthropic", { timeoutMs: 1_000 });
  const budget = new InMemoryBudgetGuard([{ id: "all", scope: {}, maxEstimatedUsd: 10 }]);
  const { result, calls } = await run(request, (_call, _index, init) => hangUntilAborted(init), { budget });
  const value = failure(result);
  const upper = upperBoundAttemptCostUsd(findModelSpec("claude-opus-5-5")!, request);
  assert.deepEqual([value.errorCode, value.retryable, calls.length], ["TIMEOUT", true, 1]);
  assert.equal(value.costBasis, "includes_upper_bound");
  assert.equal(value.estimatedCostUsd, upper);
  assert.equal(value.usage.unknownUsageAttempts, 1);
  assert.equal(value.attempts[0].costIsUpperBound, true);
  assert.equal(value.attempts[0].usage, null);
  assert.equal(budget.state()[0].estimatedUsd, upper, "the guard keeps the upper bound for the unknown attempt");
});

test("14. timeout is retried only when the request opts in", async () => {
  const request = sampleRequest("openai", { timeoutMs: 1_000, transport: { maxAttempts: 2, retryOnTimeout: true } });
  const { result, calls } = await run(request, sequence((_c, _i, init) => hangUntilAborted(init), ok(openAiBody(VALID_PAYLOAD))));
  const value = success(result);
  assert.equal(calls.length, 2);
  assert.equal(value.costBasis, "includes_upper_bound");
  assert.equal(value.usage.unknownUsageAttempts, 1);
});

test("15. a network failure is retried; its attempt is charged at the upper bound", async () => {
  const { result, calls } = await run(sampleRequest("openai"), sequence(() => Promise.reject(new TypeError("connection reset")), ok(openAiBody(VALID_PAYLOAD))));
  const value = success(result);
  assert.equal(calls.length, 2);
  assert.equal(value.attempts[0].errorCode, "NETWORK");
  assert.equal(value.attempts[0].costIsUpperBound, true);
});

test("16. a refusal is returned as a failure and never re-run", async () => {
  const { result, calls } = await run(
    sampleRequest("anthropic"),
    ok(anthropicBody(null, { stopReason: "refusal", stopDetails: { type: "refusal", category: "general_harms", explanation: "x" }, text: "" })),
  );
  const value = failure(result);
  assert.deepEqual([value.errorCode, value.retryable, value.detail, calls.length], ["REFUSAL", false, "general_harms", 1]);
  assert.equal(value.costBasis, "measured");
  assert.equal(value.usage.outputTokens, 400);
});

test("17. an incomplete (cut-off) output is a failure with its usage", async () => {
  const { result, calls } = await run(sampleRequest("openai"), ok(openAiBody(null, { incomplete: "max_output_tokens" })));
  const value = failure(result);
  assert.deepEqual([value.errorCode, value.detail, calls.length], ["INCOMPLETE", "max_output_tokens", 1]);
  assert.ok(value.estimatedCostUsd > 0);
});

test("18. retries stop at the attempt limit, and more than 3 attempts cannot be requested", async () => {
  const { result, calls } = await run(sampleRequest("anthropic"), status(529, anthropicError(529, "overloaded_error", "busy")));
  const value = failure(result);
  assert.deepEqual([value.errorCode, value.retryable, value.transportAttempts, calls.length], ["OVERLOADED", true, 3, 3]);
  const tooMany = await run(sampleRequest("anthropic", { transport: { maxAttempts: 4 } }), ok(anthropicBody(VALID_PAYLOAD)));
  assert.deepEqual([failure(tooMany.result).errorCode, tooMany.calls.length], ["REQUEST_INVALID", 0]);
});

test("19. maxAttempts 1 means exactly one HTTP request (no SDK retry, no provider retry)", async () => {
  const { result, calls, sleeps } = await run(sampleRequest("anthropic", { transport: { maxAttempts: 1 } }), status(529, anthropicError(529, "overloaded_error", "busy"), { "retry-after": "0" }));
  assert.equal(failure(result).errorCode, "OVERLOADED");
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("20. no implicit fallback: a failing provider is never replaced by the other one", async () => {
  const claude = await run(sampleRequest("anthropic"), status(529, anthropicError(529, "overloaded_error", "busy")));
  assert.ok(claude.calls.every((call) => call.url.startsWith("https://api.anthropic.com/")));
  assert.deepEqual(claude.envReads, ["ANTHROPIC_API_KEY"], "the OpenAI key is not even read");
  assert.equal(failure(claude.result).provider, "anthropic");
  const openai = await run(sampleRequest("openai"), status(500, { error: { message: "x" } }));
  assert.ok(openai.calls.every((call) => call.url === "https://api.openai.com/v1/responses"));
  assert.deepEqual(openai.envReads, ["OPENAI_API_KEY"]);
});

test("21. usage totals add known attempts and count the unknown one; cost adds measured and upper bound", async () => {
  const request = sampleRequest("anthropic");
  const { result } = await run(
    request,
    sequence(status(529, anthropicError(529, "overloaded_error", "busy")), () => Promise.reject(new TypeError("reset")), ok(anthropicBody(VALID_PAYLOAD))),
  );
  const value = success(result);
  assert.equal(value.transportAttempts, 3);
  assert.equal(value.inputTokens, 800);
  assert.equal(value.usage.unknownUsageAttempts, 1);
  const upper = upperBoundAttemptCostUsd(findModelSpec("claude-opus-5-5")!, request);
  assert.equal(value.estimatedCostUsd, Math.round((upper + (800 * 4 + 400 * 20) / 1_000_000) * 1e8) / 1e8);
  assert.equal(value.costBasis, "includes_upper_bound");
});

test("22. cache usage is reported and priced (Anthropic reads / writes, OpenAI cached input)", async () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 }, output_tokens: 50 };
  const value = success((await run(sampleRequest("anthropic"), ok(anthropicBody(VALID_PAYLOAD, { usage })))).result);
  assert.equal(value.inputTokens, 2_600);
  assert.deepEqual(value.cacheUsage, { readInputTokens: 2_000, write5mInputTokens: 500, write1hInputTokens: 0 });
  assert.equal(value.estimatedCostUsd, (100 * 4 + 2_000 * 0.2 + 500 * 5 + 50 * 20) / 1_000_000);
});

test("24. budget: an exhausted guard stops the request before any HTTP call, and stops retries too", async () => {
  const tiny = new InMemoryBudgetGuard([{ id: "per-call", scope: { provider: "anthropic" }, maxUsdPerCall: 0.0001 }]);
  const denied = await run(sampleRequest("anthropic"), ok(anthropicBody(VALID_PAYLOAD)), { budget: tiny });
  const value = failure(denied.result);
  assert.deepEqual([value.errorCode, value.detail, denied.calls.length, value.costBasis, value.estimatedCostUsd], ["BUDGET_DENIED", "PER_CALL_LIMIT", 0, "no_request", 0]);
  const oneCall = new InMemoryBudgetGuard([{ id: "one", scope: {}, maxCalls: 1 }]);
  const retry = await run(sampleRequest("anthropic"), status(529, anthropicError(529, "overloaded_error", "busy")), { budget: oneCall });
  const stopped = failure(retry.result);
  assert.deepEqual([stopped.errorCode, stopped.detail, retry.calls.length, stopped.transportAttempts], ["BUDGET_DENIED", "CALL_LIMIT", 1, 1]);
  const noScope = new InMemoryBudgetGuard([{ id: "postona", scope: { application: "postona" }, maxCalls: 9 }]);
  assert.equal(failure((await run(sampleRequest("anthropic"), ok(anthropicBody(VALID_PAYLOAD)), { budget: noScope })).result).detail, "NO_MATCHING_LIMIT");
  const broken = { reserve: () => Promise.reject(new Error("store down")), settle: () => Promise.resolve() };
  const unavailable = await run(sampleRequest("anthropic"), ok(anthropicBody(VALID_PAYLOAD)), { budget: broken });
  assert.deepEqual([failure(unavailable.result).detail, unavailable.calls.length], ["GUARD_UNAVAILABLE", 0]);
});

test("25. concurrent calls sharing one guard never exceed its call cap", async () => {
  const shared = new InMemoryBudgetGuard([{ id: "two", scope: { provider: "anthropic" }, maxCalls: 2 }]);
  const recorder = recordingFetch(ok(anthropicBody(VALID_PAYLOAD)));
  const results = await Promise.all(Array.from({ length: 6 }, () => executeAiRequest(sampleRequest("anthropic"), testDeps(recorder.fetch, { budget: shared }).deps)));
  assert.equal(results.filter((result) => result.ok).length, 2);
  assert.equal(results.filter((result) => !result.ok && result.errorCode === "BUDGET_DENIED").length, 4);
  assert.equal(recorder.calls.length, 2);
});

test("27. no key, prompt text or provider message leaks into results or telemetry", async () => {
  const secretPrompt = "PROMPT-SENTINEL-個人メモ";
  const providerText = "PROVIDER-TEXT-SENTINEL";
  const events: AiAttemptEvent[] = [];
  const outputs: AiResult[] = [];
  const scenarios: Array<[AiRequest, Responder]> = [
    [sampleRequest("anthropic", { systemInstructions: secretPrompt, userContent: secretPrompt }), ok(anthropicBody({ ...VALID_PAYLOAD, title: "OUTPUT" }))],
    [sampleRequest("anthropic", { userContent: secretPrompt }), status(401, anthropicError(401, "authentication_error", `${providerText} ${FAKE_ANTHROPIC_KEY}`))],
    [sampleRequest("openai", { userContent: secretPrompt }), status(400, { error: { message: `${providerText} Bearer ${FAKE_OPENAI_KEY}`, type: "invalid_request_error", code: null } })],
    [sampleRequest("openai", { userContent: secretPrompt, timeoutMs: 1_000, transport: { maxAttempts: 1 } }), (_c, _i, init) => hangUntilAborted(init)],
  ];
  for (const [request, responder] of scenarios) {
    const recorder = recordingFetch(responder);
    outputs.push(await executeAiRequest(request, testDeps(recorder.fetch, { onAttempt: (event: AiAttemptEvent) => events.push(event) }).deps));
  }
  const rendered = [JSON.stringify(outputs), Deno.inspect(outputs, { depth: 10 }), JSON.stringify(events)].join("\n");
  for (const sentinel of [FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, secretPrompt, providerText]) assert.ok(!rendered.includes(sentinel), sentinel);
  assert.ok(!JSON.stringify(events).includes("OUTPUT"), "telemetry carries no output");
  assert.equal(events.length, 4);
});

test("28. unknown models and unsupported settings are rejected before any key read, reservation or request", async () => {
  const cases: Array<[Partial<AiRequest>, string]> = [
    [{ model: "gpt-9-imaginary" }, "MODEL_UNKNOWN"],
    [{ model: "claude-opus-5" }, "MODEL_UNKNOWN"],
    [{ model: "gpt-6.1-sol" }, "MODEL_PROVIDER_MISMATCH"],
    [{ reasoningEffort: "none" }, "CAPABILITY_UNSUPPORTED"],
    [{ maxOutputTokens: 200_000 }, "CAPABILITY_UNSUPPORTED"],
    [{ jsonSchema: { name: "x", schema: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string", format: "date" } } } } }, "SCHEMA_UNSUPPORTED"],
    [{ jsonSchema: { name: "bad name!", schema: { type: "object", additionalProperties: false, required: [], properties: {} } } }, "REQUEST_INVALID"],
    [{ timeoutMs: 10 }, "REQUEST_INVALID"],
    [{ userContent: "  " }, "REQUEST_INVALID"],
    [{ logicalRole: "has space" }, "REQUEST_INVALID"],
  ];
  for (const [override, code] of cases) {
    const budget = new InMemoryBudgetGuard([{ id: "all", scope: {}, maxCalls: 5 }]);
    const { result, calls, envReads } = await run(sampleRequest("anthropic", override), ok(anthropicBody(VALID_PAYLOAD)), { budget });
    const value = failure(result);
    assert.equal(value.errorCode, code, JSON.stringify(override));
    assert.deepEqual([calls.length, envReads.length, budget.state()[0].calls, value.costBasis], [0, 0, 0, "no_request"]);
  }
  const noKey = recordingFetch(ok(anthropicBody(VALID_PAYLOAD)));
  const missing = await executeAiRequest(sampleRequest("anthropic"), { ...testDeps(noKey.fetch).deps, readEnv: fakeEnv({}).readEnv });
  assert.deepEqual([failure(missing).errorCode, failure(missing).detail, noKey.calls.length], ["KEY_MISSING", "ANTHROPIC_API_KEY", 0]);
});

test("the deadline stops attempts that cannot fit, and a throwing telemetry hook changes nothing", async () => {
  const start = Date.UTC(2026, 9, 10, 3, 0, 0);
  const late = await run(sampleRequest("anthropic"), ok(anthropicBody(VALID_PAYLOAD)), { deadlineAtMs: start + 100 });
  assert.deepEqual([failure(late.result).errorCode, late.calls.length], ["DEADLINE_EXCEEDED", 0]);
  const retryAfterTooLong = await run(sampleRequest("anthropic"), status(429, anthropicError(429, "rate_limit_error", "x"), { "retry-after": "15" }), { deadlineAtMs: start + 18_000 });
  assert.deepEqual([failure(retryAfterTooLong.result).errorCode, retryAfterTooLong.calls.length], ["RATE_LIMITED", 1], "15 s wait + 5 s minimum attempt exceeds the deadline");
  const noisy = await run(sampleRequest("openai"), ok(openAiBody(VALID_PAYLOAD)), { onAttempt: () => { throw new Error("telemetry down"); } });
  success(noisy.result);
});
