// OpenAI Responses API adapter (one HTTP attempt).
//
// Request: model, store:false, instructions (system), input (user content), reasoning.effort, max_output_tokens and
// text.format = strict json_schema. Nothing else is sent (no temperature, tools or metadata).
// Response: output_text parts form the text; a "refusal" content part, status "incomplete" (max_output_tokens or
// content_filter) and status "failed" are failures with their usage kept. Usage: input_tokens includes cached
// tokens (input_tokens_details.cached_tokens); output_tokens includes reasoning
// (output_tokens_details.reasoning_tokens).

import { type AdapterCall, type AdapterOutcome, countField } from "./adapter.ts";
import { ZERO_USAGE } from "./cost.ts";
import { classifyHttpError, classifyTransportError, type ClassifiedError } from "./errors.ts";
import { safeToken } from "./redact.ts";
import type { AiRequest, AiTokenUsage, JsonSchema } from "./types.ts";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The exact JSON body sent to the Responses API. */
export function buildOpenAiResponsesBody(request: AiRequest, providerSchema: JsonSchema): Record<string, unknown> {
  return {
    model: request.model,
    store: false,
    instructions: request.systemInstructions,
    input: request.userContent,
    reasoning: { effort: request.reasoningEffort },
    max_output_tokens: request.maxOutputTokens,
    text: { format: { type: "json_schema", name: request.jsonSchema.name, strict: true, schema: providerSchema } },
  };
}

/** Normalised usage, or null when the response carries no readable input / output counts. */
export function openAiUsage(raw: unknown): AiTokenUsage | null {
  const inputTokens = countField(raw, "input_tokens");
  const outputTokens = countField(raw, "output_tokens");
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const record = raw as Record<string, unknown>;
  const cached = countField(record.input_tokens_details, "cached_tokens") ?? 0;
  const reasoning = countField(record.output_tokens_details, "reasoning_tokens");
  return {
    inputTokens,
    cacheReadInputTokens: Math.min(cached, inputTokens),
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: reasoning ?? null,
  };
}

function failure(error: ClassifiedError, usage: AiTokenUsage | null, actualModel: string | null, requestId: string | null): AdapterOutcome {
  return { ok: false, error, usage, actualModel, requestId };
}

function contentParts(body: Record<string, unknown>): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const item of Array.isArray(body.output) ? body.output : []) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) if (isRecord(part)) parts.push(part);
  }
  return parts;
}

/** Interpret a 2xx Responses API body. */
export function parseOpenAiResponse(body: unknown, httpStatus: number, requestId: string | null): AdapterOutcome {
  if (!isRecord(body)) {
    return failure({ code: "PROTOCOL", retryable: false, httpStatus, retryAfterMs: null, maybeBilled: true, detail: "body_not_object" }, null, null, requestId);
  }
  const actualModel = safeToken(body.model, 128);
  const usage = openAiUsage(body.usage);
  const status = body.status;
  const parts = contentParts(body);

  if (parts.some((part) => part.type === "refusal")) {
    return failure({ code: "REFUSAL", retryable: false, httpStatus, retryAfterMs: null, maybeBilled: usage === null, detail: "refusal" }, usage, actualModel, requestId);
  }
  if (status === "incomplete") {
    const reason = isRecord(body.incomplete_details) ? body.incomplete_details.reason : null;
    const code = reason === "content_filter" ? "REFUSAL" : "INCOMPLETE";
    return failure({ code, retryable: false, httpStatus, retryAfterMs: null, maybeBilled: usage === null, detail: safeToken(reason) ?? "incomplete" }, usage, actualModel, requestId);
  }
  if (status === "failed") {
    const error = isRecord(body.error) ? body.error : {};
    return failure(
      { code: "SERVER_ERROR", retryable: true, httpStatus, retryAfterMs: null, maybeBilled: usage === null, detail: safeToken(error.code) ?? "failed" },
      usage,
      actualModel,
      requestId,
    );
  }
  if (status !== "completed") {
    return failure({ code: "PROTOCOL", retryable: false, httpStatus, retryAfterMs: null, maybeBilled: usage === null, detail: safeToken(status) ?? "no_status" }, usage, actualModel, requestId);
  }
  const text = parts.filter((part) => part.type === "output_text" && typeof part.text === "string").map((part) => part.text as string).join("");
  return { ok: true, text, stopReason: "completed", usage, actualModel, requestId, httpStatus };
}

/** One POST to the Responses API. Never throws. */
export async function callOpenAi(call: AdapterCall): Promise<AdapterOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, call.timeoutMs);
  try {
    const response = await call.fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${call.key.reveal()}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildOpenAiResponsesBody(call.request, call.providerSchema)),
      signal: controller.signal,
    });
    const requestId = safeToken(response.headers.get("x-request-id"), 128);
    const raw = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = classifyHttpError("openai", response.status, body, response.headers, call.nowMs());
      return failure(error, error.maybeBilled ? null : ZERO_USAGE, null, requestId);
    }
    if (body === null) {
      return failure({ code: "PROTOCOL", retryable: false, httpStatus: response.status, retryAfterMs: null, maybeBilled: true, detail: "body_not_json" }, null, null, requestId);
    }
    return parseOpenAiResponse(body, response.status, requestId);
  } catch {
    return failure(classifyTransportError(timedOut), null, null, null);
  } finally {
    clearTimeout(timer);
  }
}
