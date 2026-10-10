// Anthropic Messages API adapter (one HTTP attempt) through the official TypeScript SDK.
//
// Client: the API key is passed explicitly, `authToken: null` and a fixed `baseURL` (so no ANTHROPIC_AUTH_TOKEN /
// ANTHROPIC_BASE_URL environment value can redirect or double the credentials), `maxRetries: 0` (the SDK's own
// retries are OFF: execute.ts counts every attempt), an explicit timeout and `logLevel: "off"`.
//
// Request: model, max_tokens, system, one user message, thinking {type:"adaptive"} and output_config {effort,
// format: json_schema}. Adaptive thinking is the documented on-mode of all catalog Claude models (Claude Opus 5.5
// cannot turn thinking off); thinking tokens count toward max_tokens and are billed as output. No temperature,
// top_p, tool_choice or prefill is ever sent (they are rejected by these models).
//
// Response: text blocks form the text (thinking blocks are skipped); stop_reason end_turn / stop_sequence is a
// result, refusal / max_tokens / model_context_window_exceeded / pause_turn / tool_use are failures with usage kept.

import Anthropic from "npm:@anthropic-ai/sdk@0.132.1";
import { type AdapterCall, type AdapterOutcome, countField } from "./adapter.ts";
import { ZERO_USAGE } from "./cost.ts";
import { type ClassifiedError, classifyHttpError, classifyTransportError } from "./errors.ts";
import { safeToken } from "./redact.ts";
import type { AiRequest, AiTokenUsage, JsonSchema } from "./types.ts";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The exact Messages API parameters sent for a request. */
export function buildAnthropicParams(request: AiRequest, providerSchema: JsonSchema): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    system: request.systemInstructions,
    messages: [{ role: "user", content: request.userContent }],
    thinking: { type: "adaptive" },
    output_config: {
      effort: request.reasoningEffort as "low" | "medium" | "high" | "xhigh" | "max",
      format: { type: "json_schema", schema: providerSchema as { [key: string]: unknown } },
    },
  };
}

/**
 * Normalised usage, or null when unreadable. `input_tokens` from Anthropic is only the uncached remainder, so the
 * total prompt is input + cache writes + cache reads. A cache write without the 5m / 1h breakdown is counted as 1h
 * (the dearer rate) because this layer never asks for caching and cannot tell.
 */
export function anthropicUsage(raw: unknown): AiTokenUsage | null {
  const uncached = countField(raw, "input_tokens");
  const outputTokens = countField(raw, "output_tokens");
  if (uncached === undefined || outputTokens === undefined) return null;
  const record = raw as Record<string, unknown>;
  const cacheRead = countField(record, "cache_read_input_tokens") ?? 0;
  const cacheCreation = countField(record, "cache_creation_input_tokens") ?? 0;
  const write5m = countField(record.cache_creation, "ephemeral_5m_input_tokens");
  const write1h = countField(record.cache_creation, "ephemeral_1h_input_tokens");
  let cacheWrite5m = 0, cacheWrite1h = 0;
  if (write5m !== undefined || write1h !== undefined) {
    cacheWrite5m = write5m ?? 0;
    cacheWrite1h = write1h ?? 0;
    const unattributed = cacheCreation - cacheWrite5m - cacheWrite1h;
    if (unattributed > 0) cacheWrite1h += unattributed;
  } else {
    cacheWrite1h = cacheCreation;
  }
  const thinking = countField(record.output_tokens_details, "thinking_tokens");
  return {
    inputTokens: uncached + cacheRead + cacheWrite5m + cacheWrite1h,
    cacheReadInputTokens: cacheRead,
    cacheWrite5mInputTokens: cacheWrite5m,
    cacheWrite1hInputTokens: cacheWrite1h,
    outputTokens,
    reasoningOutputTokens: thinking ?? null,
  };
}

function failure(error: ClassifiedError, usage: AiTokenUsage | null, actualModel: string | null, requestId: string | null): AdapterOutcome {
  return { ok: false, error, usage, actualModel, requestId };
}

function notRetryable(code: ClassifiedError["code"], httpStatus: number, detail: string | null, usage: AiTokenUsage | null): ClassifiedError {
  return { code, retryable: false, httpStatus, retryAfterMs: null, maybeBilled: usage === null, detail };
}

/** Interpret a successful Messages API response body. */
export function parseAnthropicMessage(message: unknown, requestId: string | null): AdapterOutcome {
  const httpStatus = 200;
  if (!isRecord(message)) return failure(notRetryable("PROTOCOL", httpStatus, "body_not_object", null), null, null, requestId);
  const actualModel = safeToken(message.model, 128);
  const usage = anthropicUsage(message.usage);
  const stopReason = message.stop_reason;
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      break;
    case "refusal": {
      const category = isRecord(message.stop_details) ? safeToken(message.stop_details.category) : null;
      return failure(notRetryable("REFUSAL", httpStatus, category ?? "refusal", usage), usage, actualModel, requestId);
    }
    case "max_tokens":
    case "model_context_window_exceeded":
    case "pause_turn":
      return failure(notRetryable("INCOMPLETE", httpStatus, stopReason, usage), usage, actualModel, requestId);
    default:
      return failure(notRetryable("PROTOCOL", httpStatus, safeToken(stopReason) ?? "no_stop_reason", usage), usage, actualModel, requestId);
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => (block as { text: string }).text).join("");
  return { ok: true, text, stopReason: stopReason as string, usage, actualModel, requestId, httpStatus };
}

/** One Messages API request through the SDK. Never throws. */
export async function callAnthropic(call: AdapterCall): Promise<AdapterOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, call.timeoutMs);
  try {
    const client = new Anthropic({
      apiKey: call.key.reveal(),
      authToken: null,
      baseURL: ANTHROPIC_BASE_URL,
      maxRetries: 0,
      timeout: call.timeoutMs,
      fetch: call.fetch as unknown as typeof fetch,
      logLevel: "off",
    });
    const { data, request_id } = await client.messages
      .create(buildAnthropicParams(call.request, call.providerSchema), { signal: controller.signal, timeout: call.timeoutMs, maxRetries: 0 })
      .withResponse();
    return parseAnthropicMessage(data as unknown, safeToken(request_id, 128));
  } catch (error) {
    // Order matters: APIConnectionTimeoutError extends APIConnectionError, and both extend APIError.
    if (error instanceof Anthropic.APIConnectionTimeoutError) return failure(classifyTransportError(true), null, null, null);
    // Only our own signal aborts the request, and only our timer fires it.
    if (error instanceof Anthropic.APIUserAbortError) return failure(classifyTransportError(true), null, null, null);
    if (error instanceof Anthropic.APIConnectionError) return failure(classifyTransportError(timedOut), null, null, null);
    if (error instanceof Anthropic.APIError && typeof error.status === "number") {
      const classified = classifyHttpError("anthropic", error.status, error.error, (error.headers as Headers | undefined) ?? null, call.nowMs());
      return failure(classified, classified.maybeBilled ? null : ZERO_USAGE, null, safeToken(error.requestID, 128));
    }
    // A response that could not be read, or an SDK-side error after sending: treat as possibly billed.
    return failure({ code: "PROTOCOL", retryable: false, httpStatus: null, retryAfterMs: null, maybeBilled: true, detail: "sdk_error" }, null, null, null);
  } finally {
    clearTimeout(timer);
  }
}
