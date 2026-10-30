import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiProvider, openAiRequestBody, parseOpenAiResponse } from "./openai.ts";
import type { NeutralRequest } from "../types.ts";
import type { RetryOptions } from "../retry.ts";

const FAKE_KEY = "sk-proj-FAKEFAKE0123456789";
const FAST: RetryOptions = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: () => Promise.resolve() };

const request: NeutralRequest = {
  taskId: "judgement_primary",
  caseId: "c1",
  system: "SYSTEM TEXT",
  user: "{\"candidate\":1}",
  schema: { name: "important_news_judgement", schema: { type: "object", properties: { importance: { type: "string" } }, additionalProperties: false } },
  maxOutputTokens: 1000,
  effort: "low",
};

const okBody = (overrides: Record<string, unknown> = {}) => ({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "{\"importance\":\"important\"}" }] }],
  usage: { input_tokens: 1800, output_tokens: 170, input_tokens_details: { cached_tokens: 300 } },
  ...overrides,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("request body uses the OpenAI Responses shape and none of the Claude fields", () => {
  const body = openAiRequestBody("gpt-6-luna", request);
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.instructions, "SYSTEM TEXT");
  assert.equal(body.input, "{\"candidate\":1}");
  assert.equal(body.max_output_tokens, 1000);
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(body.store, false);
  assert.deepEqual(body.text, { format: { type: "json_schema", name: "important_news_judgement", strict: true, schema: request.schema!.schema } });
  for (const claudeOnly of ["messages", "system", "output_config", "max_tokens", "thinking"]) {
    assert.ok(!(claudeOnly in body), claudeOnly);
  }
});

test("web search request carries the tool, domain filter, tool-call limit and sources include", () => {
  const body = openAiRequestBody("gpt-5.6-luna", { ...request, webSearch: { allowedDomains: ["reuters.com"], maxUses: 1 } });
  assert.deepEqual(body.tools, [{ type: "web_search", filters: { allowed_domains: ["reuters.com"] }, search_context_size: "low" }]);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.max_tool_calls, 1);
  assert.deepEqual(body.include, ["web_search_call.action.sources"]);
});

test("a successful call is parsed, priced and never carries the key", async () => {
  let seenAuth = "";
  const provider = createOpenAiProvider({
    apiKey: FAKE_KEY, model: "gpt-6-luna", retry: FAST,
    fetch: ((_url: string, init: RequestInit) => {
      seenAuth = new Headers(init.headers).get("authorization") ?? "";
      return Promise.resolve(json(okBody()));
    }) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(seenAuth, `Bearer ${FAKE_KEY}`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, { importance: "important" });
  assert.deepEqual(result.usage, { inputTokens: 1500, outputTokens: 170, cacheReadTokens: 300, cacheWriteTokens: 0, webSearchRequests: 0 });
  assert.equal(result.attempts, 1);
  assert.ok(result.costUsd > 0);
  assert.ok(!JSON.stringify(result).includes("FAKEFAKE"));
});

test("429 with retry-after is retried and the retry is counted", async () => {
  let calls = 0;
  const hooks: string[] = [];
  const provider = createOpenAiProvider({
    apiKey: FAKE_KEY, model: "gpt-6-luna", retry: FAST,
    fetch: (() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? json({ error: { message: "slow down" } }, 429, { "retry-after": "1" }) : json(okBody()));
    }) as unknown as typeof fetch,
  });
  const result = await provider.run(request, {
    beforeAttempt: () => hooks.push("before"),
    afterAttempt: (usd) => hooks.push(`after:${usd > 0 ? "paid" : "free"}`),
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(hooks, ["before", "after:free", "before", "after:paid"]);
});

test("a 400 is not retried", async () => {
  let calls = 0;
  const provider = createOpenAiProvider({
    apiKey: FAKE_KEY, model: "gpt-6-luna", retry: FAST,
    fetch: (() => { calls += 1; return Promise.resolve(json({ error: { message: "bad schema" } }, 400)); }) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error?.status, 400);
  assert.equal(result.error?.retryable, false);
});

test("insufficient_quota (balance exhausted) is not retried", async () => {
  let calls = 0;
  const provider = createOpenAiProvider({
    apiKey: FAKE_KEY, model: "gpt-6-luna", retry: FAST,
    fetch: (() => { calls += 1; return Promise.resolve(json({ error: { code: "insufficient_quota", message: "quota" } }, 429)); }) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(calls, 1);
  assert.equal(result.error?.retryable, false);
});

test("a timeout is retried up to maxAttempts, and every timed-out attempt keeps its pessimistic reservation", async () => {
  const reservations: number[] = [];
  const settled: number[] = [];
  const provider = createOpenAiProvider({
    apiKey: FAKE_KEY, model: "gpt-6-luna", retry: FAST,
    fetch: (() => Promise.reject(new DOMException("timed out", "TimeoutError"))) as unknown as typeof fetch,
  });
  const result = await provider.run(request, {
    beforeAttempt: (usd) => reservations.push(usd),
    afterAttempt: (usd) => settled.push(usd),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "TIMEOUT");
  assert.equal(result.attempts, 3);
  assert.equal(reservations.length, 3);
  assert.deepEqual(settled, reservations, "a timeout may have been billed, so the estimate is kept as the cost");
});

test("a network error is retried but reserves nothing", async () => {
  const settled: number[] = [];
  const provider = createOpenAiProvider({
    apiKey: FAKE_KEY, model: "gpt-6-luna", retry: FAST,
    fetch: (() => Promise.reject(new TypeError("connection reset"))) as unknown as typeof fetch,
  });
  const result = await provider.run(request, { afterAttempt: (usd) => settled.push(usd) });
  assert.equal(result.error?.code, "NETWORK");
  assert.deepEqual(settled, [0, 0, 0]);
});

test("a 200 whose body is not JSON becomes INVALID_RESPONSE", async () => {
  const provider = createOpenAiProvider({
    apiKey: FAKE_KEY, model: "gpt-6-luna", retry: FAST,
    fetch: (() => Promise.resolve(new Response("<html>gateway</html>", { status: 200 }))) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "INVALID_RESPONSE");
});

test("an error body that echoes the key is redacted before it is stored", async () => {
  const provider = createOpenAiProvider({
    apiKey: FAKE_KEY, model: "gpt-6-luna", retry: FAST,
    fetch: (() => Promise.resolve(new Response(`Incorrect API provided: ${FAKE_KEY}`, { status: 401 }))) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(result.error?.status, 401);
  assert.ok(!JSON.stringify(result).includes("FAKEFAKE"));
  assert.match(result.error!.message, /\[REDACTED\]/);
});

test("output that is not the requested JSON is data (parseError), not an exception", async () => {
  const provider = createOpenAiProvider({
    apiKey: FAKE_KEY, model: "gpt-6-luna", retry: FAST,
    fetch: (() => Promise.resolve(json(okBody({
      status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", content: [{ type: "output_text", text: "{\"importance\":" }] }],
    })))) as unknown as typeof fetch,
  });
  const result = await provider.run(request);
  assert.equal(result.ok, true);
  assert.equal(result.parseError, "INVALID_JSON");
  assert.equal(result.stopReason, "incomplete:max_output_tokens");
  assert.equal(result.parsed, null);
});

test("web search calls and their sources are counted from the output items", () => {
  const parsed = parseOpenAiResponse({
    status: "completed",
    output: [
      { type: "web_search_call", action: { sources: [{ url: "https://a.com/x/y" }, { url: "https://a.com/x/y" }, { url: "https://b.com/p/q" }] } },
      { type: "web_search_call", action: { sources: [] } },
      { type: "message", content: [{ type: "output_text", text: "{}" }] },
    ],
    usage: { input_tokens: 13000, output_tokens: 200 },
  });
  assert.equal(parsed.usage.webSearchRequests, 2);
  assert.deepEqual(parsed.sourceUrls, ["https://a.com/x/y", "https://b.com/p/q"]);
});

test("a response with no usage block is treated as zero usage, not a crash", () => {
  const parsed = parseOpenAiResponse({ output: [] });
  assert.deepEqual(parsed.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 });
  assert.equal(parsed.text, null);
});
