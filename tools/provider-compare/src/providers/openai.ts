import type { CallContext, NeutralRequest, Provider, ProviderResult, Usage } from "../types.ts";
import { costUsd, estimateRequestUsd } from "../pricing.ts";
import { redactSecrets } from "../redact.ts";
import { DEFAULT_RETRY, ProviderFailure, type RetryOptions, toProviderError, withRetry } from "../retry.ts";
import {
  DEFAULT_TIMEOUT_MS,
  emptyResult,
  nonNegativeInt,
  parseJsonText,
  requestChars,
  retryAfterMsFrom,
} from "./common.ts";

// OpenAI Responses API client for the comparison harness. Same wire format production uses (raw fetch, no SDK),
// kept separate from production code on purpose: nothing here is imported by an Edge Function.

const RESPONSES_URL = "https://api.openai.com/v1/responses";

export type OpenAiProviderOptions = {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  retry?: RetryOptions;
  timeoutMs?: number;
};

export function openAiRequestBody(model: string, request: NeutralRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    store: false,
    instructions: request.system,
    input: request.user,
    max_output_tokens: request.maxOutputTokens,
  };
  if (request.effort) body.reasoning = { effort: request.effort };
  if (request.schema) {
    body.text = { format: { type: "json_schema", name: request.schema.name, strict: true, schema: request.schema.schema } };
  }
  if (request.webSearch) {
    body.tools = [{
      type: "web_search",
      ...(request.webSearch.allowedDomains ? { filters: { allowed_domains: request.webSearch.allowedDomains } } : {}),
      search_context_size: "low",
    }];
    body.tool_choice = "required";
    body.include = ["web_search_call.action.sources"];
    if (request.webSearch.maxUses !== undefined) body.max_tool_calls = request.webSearch.maxUses;
  }
  return body;
}

type OutputItem = {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
  action?: { sources?: Array<{ url?: string }> };
};

export function parseOpenAiResponse(raw: unknown): { text: string | null; usage: Usage; stopReason: string | null; sourceUrls: string[] } {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as {
    output?: OutputItem[];
    usage?: { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown } };
    status?: string;
    incomplete_details?: { reason?: string };
  };
  const items = Array.isArray(record.output) ? record.output : [];
  const text = items
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("") || null;
  const searches = items.filter((item) => item?.type === "web_search_call");
  const sourceUrls = searches.flatMap((item) => item.action?.sources ?? [])
    .map((source) => source?.url)
    .filter((url): url is string => typeof url === "string");
  const cached = nonNegativeInt(record.usage?.input_tokens_details?.cached_tokens);
  const totalInput = nonNegativeInt(record.usage?.input_tokens);
  const usage: Usage = {
    inputTokens: Math.max(0, totalInput - cached),
    outputTokens: nonNegativeInt(record.usage?.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    webSearchRequests: searches.length,
  };
  const stopReason = record.status === "incomplete"
    ? `incomplete:${record.incomplete_details?.reason ?? "unknown"}`
    : record.status ?? null;
  return { text, usage, stopReason, sourceUrls: [...new Set(sourceUrls)] };
}

export function createOpenAiProvider(options: OpenAiProviderOptions): Provider {
  const fetchImpl = options.fetch ?? fetch;
  const retry = options.retry ?? DEFAULT_RETRY;
  const label = options.model;
  const secrets = [options.apiKey];

  return {
    name: "openai",
    model: options.model,
    label,
    async run(request: NeutralRequest, context: CallContext = {}): Promise<ProviderResult> {
      const result = emptyResult("openai", options.model, label);
      const started = performance.now();
      const body = JSON.stringify(openAiRequestBody(options.model, request));
      const estimate = estimateRequestUsd(
        options.model,
        requestChars(request.system, request.user),
        request.maxOutputTokens,
        request.webSearch ? (request.webSearch.maxUses ?? 1) : 0,
      );

      const outcome = await withRetry(async () => {
        context.beforeAttempt?.(estimate);
        let response: Response;
        try {
          response = await fetchImpl(RESPONSES_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
            body,
            signal: context.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          });
        } catch (error) {
          const name = (error as { name?: string } | null)?.name;
          const timedOut = name === "TimeoutError" || name === "AbortError";
          // A timed-out request may still have been billed, so it keeps its pessimistic reservation.
          context.afterAttempt?.(timedOut ? estimate : 0);
          throw new ProviderFailure(
            timedOut ? "TIMEOUT" : "NETWORK",
            null,
            redactSecrets(String((error as Error | null)?.message ?? error), secrets),
          );
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          context.afterAttempt?.(0);
          throw new ProviderFailure(
            `HTTP_${response.status}`,
            response.status,
            redactSecrets(detail.slice(0, 400) || `HTTP ${response.status}`, secrets),
            retryAfterMsFrom(response.headers.get("retry-after")),
          );
        }
        let raw: unknown;
        try {
          raw = await response.json();
        } catch {
          context.afterAttempt?.(0);
          throw new ProviderFailure("INVALID_RESPONSE", response.status, "response body was not JSON");
        }
        const parsed = parseOpenAiResponse(raw);
        context.afterAttempt?.(costUsd(options.model, parsed.usage));
        return parsed;
      }, retry);

      result.latencyMs = Math.round(performance.now() - started);
      result.attempts = outcome.attempts;
      if (!outcome.ok) {
        result.error = toProviderError(outcome.failure, secrets);
        return result;
      }
      const { text, usage, stopReason, sourceUrls } = outcome.value;
      const { parsed, parseError } = parseJsonText(text, request.schema !== undefined);
      return {
        ...result,
        ok: true,
        text,
        parsed,
        parseError,
        usage,
        costUsd: costUsd(options.model, usage),
        stopReason,
        sourceUrls,
      };
    },
  };
}
