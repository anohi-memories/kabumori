// Test helpers: fake fetch, fake keys, sample requests and provider response bodies. No network is ever used.
// The keys below are obviously fake placeholders (never real credentials) and double as leak sentinels.

import type { FetchLike } from "./adapter.ts";
import { type BudgetLimit, InMemoryBudgetGuard } from "./budget.ts";
import type { ExecuteDeps } from "./execute.ts";
import type { AiProvider, AiRequest, JsonSchema } from "./types.ts";

export const FAKE_OPENAI_KEY = "test-openai-key-NOT-REAL-0000000000";
export const FAKE_ANTHROPIC_KEY = "test-anthropic-key-NOT-REAL-000000";

export function fakeEnv(values: Record<string, string | undefined> = { OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY }) {
  const reads: string[] = [];
  const readEnv = (name: string) => {
    reads.push(name);
    return values[name];
  };
  return { readEnv, reads };
}

export type RecordedCall = { url: string; method: string; headers: Headers; body: unknown };

export type Responder = (call: RecordedCall, index: number, init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch that records every request and answers from `responder`. */
export function recordingFetch(responder: Responder): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const headers = new Headers(init?.headers ?? request?.headers ?? undefined);
    const rawBody = init?.body ?? (request ? await request.text() : undefined);
    let body: unknown = undefined;
    if (typeof rawBody === "string") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const call: RecordedCall = { url, method: init?.method ?? request?.method ?? "GET", headers, body };
    calls.push(call);
    return await responder(call, calls.length - 1, init);
  };
  return { fetch: fetchImpl, calls };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A response that never arrives: settles only when the request's signal aborts. */
export function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}

/** A schema exercising nested objects, enums, numeric / string / array constraints, anyOf null and $defs. */
export const SAMPLE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "score", "tags", "kind", "detail"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 20, description: "Short title" },
    score: { type: "number", minimum: 0, maximum: 1 },
    tags: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["a", "b", "c", "d"] } },
    kind: { $ref: "#/$defs/kind" },
    detail: {
      type: "object",
      additionalProperties: false,
      required: ["note", "count"],
      properties: {
        note: { anyOf: [{ type: "string", pattern: "^[a-z ]+$" }, { type: "null" }] },
        count: { type: "integer", minimum: 0 },
      },
    },
  },
  $defs: { kind: { type: "string", enum: ["news", "report"] } },
};

export const VALID_PAYLOAD = { title: "見出し", score: 0.5, tags: ["a", "b"], kind: "news", detail: { note: "ok text", count: 2 } };

export function sampleRequest(provider: AiProvider, overrides: Partial<AiRequest> = {}): AiRequest {
  return {
    logicalRole: "test.provider.sample",
    provider,
    model: provider === "anthropic" ? "claude-opus-5-5" : "gpt-6.1-sol",
    systemInstructions: "テスト用の指示です。",
    userContent: "テスト入力",
    jsonSchema: { name: "sample_output", schema: SAMPLE_SCHEMA },
    reasoningEffort: "medium",
    maxOutputTokens: 2_000,
    timeoutMs: 30_000,
    transport: { maxAttempts: 3 },
    usageContext: { application: "kabumori", feature: "provider_test" },
    ...overrides,
  };
}

export function openAiBody(payload: unknown, options: { status?: string; usage?: unknown; model?: string | null; output?: unknown; incomplete?: string } = {}) {
  const body: Record<string, unknown> = {
    id: "resp_test",
    object: "response",
    status: options.status ?? (options.incomplete ? "incomplete" : "completed"),
    output: options.output ?? [
      { type: "reasoning", id: "rs_test", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(payload), annotations: [] }] },
    ],
    usage: options.usage ?? {
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 200 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 120 },
      total_tokens: 1_300,
    },
  };
  if (options.model !== null) body.model = options.model ?? "gpt-6.1-sol-2026-09-01";
  if (options.incomplete) body.incomplete_details = { reason: options.incomplete };
  return body;
}

export function anthropicBody(payload: unknown, options: { stopReason?: string; usage?: unknown; model?: string | null; stopDetails?: unknown; text?: string } = {}) {
  const body: Record<string, unknown> = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "sig_test" },
      { type: "text", text: options.text ?? JSON.stringify(payload) },
    ],
    stop_reason: options.stopReason ?? "end_turn",
    stop_sequence: null,
    stop_details: options.stopDetails ?? null,
    usage: options.usage ?? {
      input_tokens: 800,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      output_tokens: 400,
      output_tokens_details: { thinking_tokens: 150 },
      server_tool_use: null,
      service_tier: "standard",
      inference_geo: null,
    },
  };
  if (options.model !== null) body.model = options.model ?? "claude-opus-5-5";
  return body;
}

/** An Anthropic error body (the HTTP status is set on the response, not in the body). */
export function anthropicError(_status: number, type: string, message: string, extra: Record<string, unknown> = {}) {
  return { type: "error", error: { type, message, ...extra }, request_id: "req_test_error" };
}

export function guard(limits: BudgetLimit[] = [{ id: "test-all", scope: {}, maxCalls: 100, maxEstimatedUsd: 100 }]) {
  return new InMemoryBudgetGuard(limits);
}

/** Deps with fake time: sleep advances the clock instantly and is recorded. */
export function testDeps(fetchImpl: FetchLike, overrides: Partial<ExecuteDeps> = {}) {
  let clock = Date.UTC(2026, 9, 10, 3, 0, 0);
  const sleeps: number[] = [];
  const env = fakeEnv();
  const deps: ExecuteDeps = {
    readEnv: env.readEnv,
    budget: guard(),
    fetch: fetchImpl,
    nowMs: () => clock,
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    random: () => 1,
    ...overrides,
  };
  return { deps, sleeps, envReads: env.reads };
}
