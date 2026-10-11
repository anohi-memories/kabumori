import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicRequestParams,
  createAnthropicProvider,
  DEFAULT_THINKING_HEADROOM,
  parseAnthropicMessage,
  thinkingCanBeDisabled,
  thinkingParam,
} from "./anthropic.ts";
import type { NeutralRequest } from "../types.ts";
import type { RetryOptions } from "../retry.ts";

const FAKE_KEY = "sk-ant-FAKEFAKE0123456789";
const FAST: RetryOptions = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: () => Promise.resolve() };

const request: NeutralRequest = {
  taskId: "judgement_primary",
  caseId: "c1",
  system: "SYSTEM TEXT",
  user: "{\"candidate\":1}",
  schema: {
    name: "important_news_judgement",
    schema: {
      type: "object",
      properties: { importance: { type: "string", enum: ["no_post", "important"] }, confidence: { type: "number", minimum: 0, maximum: 1 } },
      required: ["importance", "confidence"],
      additionalProperties: false,
    },
  },
  maxOutputTokens: 1000,
  effort: "low",
};

const message = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_test", type: "message", role: "assistant", model: "claude-haiku-5-5",
  content: [{ type: "text", text: "{\"importance\":\"important\",\"confidence\":0.9}" }],
  stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...overrides,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const apiError = (status: number, type: string, text: string) =>
  json({ type: "error", error: { type, message: text } }, status);

// --- request shape --------------------------------------------------------------------------------------------

test("params use the Messages API shape, never the OpenAI fields, and never set sampling parameters", () => {
  const { params } = anthropicRequestParams({ apiKey: FAKE_KEY, model: "claude-opus-5-5" }, request);
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.system, "SYSTEM TEXT");
  assert.deepEqual(params.messages, [{ role: "user", content: "{\"candidate\":1}" }]);
  for (const openaiOnly of ["instructions", "input", "text", "reasoning", "max_output_tokens", "store"]) {
    assert.ok(!(openaiOnly in params), openaiOnly);
  }
  for (const removed of ["temperature", "top_p", "top_k"]) assert.ok(!(removed in params), `${removed} is rejected on the 5.5 models`);
});

test("effort and the Claude-acceptable schema go in output_config", () => {
  const { params, schemaChanges } = anthropicRequestParams({ apiKey: FAKE_KEY, model: "claude-sonnet-5-5" }, request);
  const outputConfig = params.output_config as { effort: string; format: { type: string; schema: { properties: Record<string, { description?: string }> } } };
  assert.equal(outputConfig.effort, "low");
  assert.equal(outputConfig.format.type, "json_schema");
  assert.match(outputConfig.format.schema.properties.confidence.description ?? "", /minimum: 0/);
  assert.deepEqual(schemaChanges.map((c) => c.keyword).sort(), ["maximum", "minimum"]);
});

test("an explicit effort overrides the task's effort", () => {
  const { params } = anthropicRequestParams({ apiKey: FAKE_KEY, model: "claude-opus-5-5", effort: "high" }, request);
  assert.equal((params.output_config as { effort: string }).effort, "high");
});

test("thinking tokens share max_tokens, so the answer budget gets headroom unless thinking is off", () => {
  const on = anthropicRequestParams({ apiKey: FAKE_KEY, model: "claude-haiku-5-5" }, request).params;
  assert.equal(on.max_tokens, 1000 + DEFAULT_THINKING_HEADROOM);
  assert.ok(!("thinking" in on));
  const off = anthropicRequestParams({ apiKey: FAKE_KEY, model: "claude-haiku-5-5", thinking: "off" }, request).params;
  assert.equal(off.max_tokens, 1000);
  assert.deepEqual(off.thinking, { type: "disabled" });
});

test("each model turns thinking off the way the docs say, and Opus 5.5 cannot", () => {
  assert.deepEqual(thinkingParam("claude-haiku-5-5", "off"), { type: "disabled" });
  assert.deepEqual(thinkingParam("claude-sonnet-5-5", "off"), { type: "between_tools" });
  assert.equal(thinkingParam("claude-opus-5-5", "off"), null);
  assert.equal(thinkingParam("claude-fable-5-1", "off"), null);
  assert.equal(thinkingParam("claude-haiku-5-5", "default"), null);
  assert.equal(thinkingCanBeDisabled("claude-opus-5-5"), false);
  const opus = anthropicRequestParams({ apiKey: FAKE_KEY, model: "claude-opus-5-5", thinking: "off" }, request);
  assert.ok(!("thinking" in opus.params), "never send a thinking value the model rejects with a 400");
  assert.equal(opus.thinkingDisabled, false);
});

test("web search is declared with the domain filter, the use limit and direct calling", () => {
  const { params } = anthropicRequestParams(
    { apiKey: FAKE_KEY, model: "claude-sonnet-5-5" },
    { ...request, schema: undefined, webSearch: { allowedDomains: ["reuters.com", "apnews.com"], maxUses: 1 } },
  );
  assert.deepEqual(params.tools, [{
    type: "web_search_20260318", name: "web_search", allowed_domains: ["reuters.com", "apnews.com"], max_uses: 1, allowed_callers: ["direct"],
  }]);
  assert.equal(params.max_tokens, 1000 + DEFAULT_THINKING_HEADROOM + 2000);
});

// --- responses -----------------------------------------------------------------------------------------------

test("usage, cache fields, search count and source URLs are read from the message", () => {
  const parsed = parseAnthropicMessage(message({
    content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://a.com/x/y", title: "t" }] },
      { type: "text", text: "{\"candidates\":[]}" },
    ],
    usage: {
      input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40,
      server_tool_use: { web_search_requests: 2 },
    },
  }));
  assert.deepEqual(parsed.usage, { inputTokens: 100, outputTokens: 20, cacheWriteTokens: 30, cacheReadTokens: 40, webSearchRequests: 2 });
  assert.deepEqual(parsed.sourceUrls, ["https://a.com/x/y"]);
  assert.equal(parsed.text, "{\"candidates\":[]}");
});

test("a web search error block (HTTP 200) contributes no URLs and does not crash", () => {
  const parsed = parseAnthropicMessage(message({
    content: [
      { type: "web_search_tool_result", tool_use_id: "s1", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
      { type: "text", text: "{}" },
    ],
  }));
  assert.deepEqual(parsed.sourceUrls, []);
});

test("a malformed message becomes zero usage and no text, never an exception", () => {
  for (const bad of [null, "x", {}, { content: "no" }, { usage: "no" }]) {
    const parsed = parseAnthropicMessage(bad);
    assert.equal(parsed.text, null);
    assert.equal(parsed.usage.inputTokens, 0);
  }
});

// --- calls through the official SDK (mock fetch, no network) --------------------------------------------------

test("a successful call: the key travels only in the request header, the result is parsed and priced", async () => {
  let sentKey = "";
  let sentBody: Record<string, unknown> = {};
  const provider = createAnthropicProvider({
    apiKey: FAKE_KEY, model: "claude-haiku-5-5", effort: "low", thinking: "off", retry: FAST,
    fetch: ((_url: string, init: RequestInit) => {
      sentKey = new Headers(init.headers).get("x-api-key") ?? "";
      sentBody = JSON.parse(String(init.body));
      return Promise.resolve(json(message()));
    }) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(sentKey, FAKE_KEY);
  assert.deepEqual(sentBody.thinking, { type: "disabled" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, { importance: "important", confidence: 0.9 });
  assert.equal(result.label, "claude-haiku-5-5 effort=low thinking=off");
  assert.equal(result.costUsd, (1200 * 0.1 + 150 * 0.5) / 1e6);
  assert.ok(!JSON.stringify(result).includes("FAKEFAKE"));
});

test("529 overloaded then success: the retry happens through the harness policy and is counted", async () => {
  let calls = 0;
  const events: string[] = [];
  const provider = createAnthropicProvider({
    apiKey: FAKE_KEY, model: "claude-haiku-5-5", retry: FAST,
    fetch: (() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? apiError(529, "overloaded_error", "Overloaded") : json(message()));
    }) as unknown as typeof fetch,
  });
  const result = await provider.run(request, { beforeAttempt: () => events.push("b"), afterAttempt: () => events.push("a") });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2, "the SDK's own retries are off, so there is exactly one HTTP request per harness attempt");
  assert.deepEqual(events, ["b", "a", "b", "a"]);
});

test("429 with retry-after is retried", async () => {
  let calls = 0;
  const provider = createAnthropicProvider({
    apiKey: FAKE_KEY, model: "claude-haiku-5-5", retry: FAST,
    fetch: (() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? new Response(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate" } }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } },
      ) : json(message()));
    }) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test("an empty credit balance (400) and a monthly spend cap (429) are not retried", async () => {
  for (const [status, type, text] of [
    [400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing."],
    [429, "rate_limit_error", "You have reached your API usage limits: enforced_spend_limit_reached"],
  ] as const) {
    let calls = 0;
    const provider = createAnthropicProvider({
      apiKey: FAKE_KEY, model: "claude-haiku-5-5", retry: FAST,
      fetch: (() => { calls += 1; return Promise.resolve(apiError(status, type, text)); }) as unknown as typeof fetch,
    });
    const result = await provider.run(request);
    assert.equal(calls, 1, text);
    assert.equal(result.ok, false);
    assert.equal(result.error?.retryable, false);
  }
});

test("a refusal is reported as an error result with its usage, and is not retried", async () => {
  let calls = 0;
  const provider = createAnthropicProvider({
    apiKey: FAKE_KEY, model: "claude-opus-5-5", retry: FAST,
    fetch: (() => { calls += 1; return Promise.resolve(json(message({ stop_reason: "refusal", content: [] }))); }) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "REFUSAL");
  assert.equal(result.usage.inputTokens, 1200);
});

test("output cut off by max_tokens is flagged as truncated, not accepted as valid JSON", async () => {
  const provider = createAnthropicProvider({
    apiKey: FAKE_KEY, model: "claude-opus-5-5", retry: FAST,
    fetch: (() => Promise.resolve(json(message({
      stop_reason: "max_tokens", content: [{ type: "text", text: "{\"importance\":\"imp" }],
    })))) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(result.ok, true);
  assert.equal(result.parsed, null);
  assert.equal(result.parseError, "TRUNCATED:INVALID_JSON");
});

test("plain text where JSON was requested is a parse failure recorded as data", async () => {
  const provider = createAnthropicProvider({
    apiKey: FAKE_KEY, model: "claude-haiku-5-5", retry: FAST,
    fetch: (() => Promise.resolve(json(message({ content: [{ type: "text", text: "Sure! Here is the answer" }] })))) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(result.parseError, "INVALID_JSON");
});

test("a request that exceeds the timeout is retried as TIMEOUT and keeps its reservation", async () => {
  const settled: number[] = [];
  const provider = createAnthropicProvider({
    apiKey: FAKE_KEY, model: "claude-haiku-5-5", retry: { ...FAST, maxAttempts: 2 }, timeoutMs: 20,
    fetch: ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch,
  });
  const result = await provider.run(request, { afterAttempt: (usd) => settled.push(usd) });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "TIMEOUT");
  assert.equal(result.attempts, 2);
  assert.ok(settled.every((usd) => usd > 0), "a timed-out attempt may have been billed");
});

test("a server error body that echoes the key is redacted in the stored error", async () => {
  const provider = createAnthropicProvider({
    apiKey: FAKE_KEY, model: "claude-haiku-5-5", retry: FAST,
    fetch: (() => Promise.resolve(apiError(401, "authentication_error", `invalid x-api-key ${FAKE_KEY}`))) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(result.error?.status, 401);
  assert.ok(!JSON.stringify(result).includes("FAKEFAKE"));
});

test("a 200 with an unreadable body does not throw out of run()", async () => {
  const provider = createAnthropicProvider({
    apiKey: FAKE_KEY, model: "claude-haiku-5-5", retry: { ...FAST, maxAttempts: 1 },
    fetch: (() => Promise.resolve(new Response("not json at all", { status: 200, headers: { "content-type": "application/json" } }))) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});
