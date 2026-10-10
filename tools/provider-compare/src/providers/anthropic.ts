import Anthropic from "npm:@anthropic-ai/sdk@0.132.1";
import type { CallContext, NeutralRequest, Provider, ProviderResult, Usage } from "../types.ts";
import { costUsd, estimateRequestUsd } from "../pricing.ts";
import { redactSecrets } from "../redact.ts";
import { sanitizeSchemaForClaude, type SchemaChange } from "../schema.ts";
import { DEFAULT_RETRY, ProviderFailure, type RetryOptions, toProviderError, withRetry } from "../retry.ts";
import {
  DEFAULT_TIMEOUT_MS,
  emptyResult,
  nonNegativeInt,
  parseJsonText,
  requestChars,
  retryAfterMsFrom,
} from "./common.ts";

// Claude Messages API client for the comparison harness, built on the official SDK (npm:@anthropic-ai/sdk).
// The SDK's own retries are switched off (maxRetries: 0) so that every HTTP attempt passes through this harness's
// retry policy and budget guard. Request shapes follow the Anthropic docs retrieved 2026-10-09.

export type ThinkingMode = "default" | "off";

export type AnthropicProviderOptions = {
  apiKey: string;
  model: string;
  /** Overrides the task's effort (production: low for Luna-class work, medium for Sol-class work). */
  effort?: "low" | "medium" | "high";
  /** "off" asks the model to skip thinking where the API allows it (see thinkingParam). */
  thinking?: ThinkingMode;
  /** Extra max_tokens on top of the visible answer budget: thinking tokens share max_tokens. */
  thinkingHeadroomTokens?: number;
  /** web_search tool type; docs list web_search_20250305 / 20260209 / 20260318. */
  webSearchToolType?: string;
  /** "direct": no code-execution dynamic filtering (closest to OpenAI's plain search). */
  webSearchCaller?: "direct" | "default";
  fetch?: typeof fetch;
  retry?: RetryOptions;
  timeoutMs?: number;
};

export const DEFAULT_WEB_SEARCH_TOOL = "web_search_20260318";
export const DEFAULT_THINKING_HEADROOM = 3000;

/** How each current model turns thinking off, per the models docs (null: it cannot be turned off). */
export function thinkingParam(model: string, mode: ThinkingMode): Record<string, unknown> | null {
  if (mode !== "off") return null;
  if (model === "claude-haiku-5-5") return { type: "disabled" };
  if (model === "claude-sonnet-5-5") return { type: "between_tools" };
  return null;
}

export function thinkingCanBeDisabled(model: string): boolean {
  return thinkingParam(model, "off") !== null;
}

export type AnthropicBuild = {
  params: Record<string, unknown>;
  schemaChanges: SchemaChange[];
  thinkingDisabled: boolean;
};

export function anthropicRequestParams(options: AnthropicProviderOptions, request: NeutralRequest): AnthropicBuild {
  const thinking = thinkingParam(options.model, options.thinking ?? "default");
  const headroom = thinking ? 0 : options.thinkingHeadroomTokens ?? DEFAULT_THINKING_HEADROOM;
  const effort = options.effort ?? request.effort;
  const outputConfig: Record<string, unknown> = {};
  if (effort) outputConfig.effort = effort;
  let schemaChanges: SchemaChange[] = [];
  if (request.schema) {
    const sanitized = sanitizeSchemaForClaude(request.schema.schema);
    schemaChanges = sanitized.changes;
    outputConfig.format = { type: "json_schema", schema: sanitized.schema };
  }
  const params: Record<string, unknown> = {
    model: options.model,
    max_tokens: request.maxOutputTokens + headroom + (request.webSearch ? 2000 : 0),
    system: request.system,
    messages: [{ role: "user", content: request.user }],
  };
  if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;
  if (thinking) params.thinking = thinking;
  if (request.webSearch) {
    params.tools = [{
      type: options.webSearchToolType ?? DEFAULT_WEB_SEARCH_TOOL,
      name: "web_search",
      ...(request.webSearch.allowedDomains ? { allowed_domains: request.webSearch.allowedDomains } : {}),
      ...(request.webSearch.maxUses !== undefined ? { max_uses: request.webSearch.maxUses } : {}),
      ...((options.webSearchCaller ?? "direct") === "direct" ? { allowed_callers: ["direct"] } : {}),
    }];
  }
  return { params, schemaChanges, thinkingDisabled: thinking !== null };
}

type ContentBlock = {
  type?: string;
  text?: string;
  content?: unknown;
};

export function parseAnthropicMessage(message: unknown): {
  text: string | null;
  usage: Usage;
  stopReason: string | null;
  sourceUrls: string[];
} {
  const record = (typeof message === "object" && message !== null ? message : {}) as {
    content?: ContentBlock[];
    stop_reason?: string | null;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      server_tool_use?: { web_search_requests?: unknown };
    };
  };
  const blocks = Array.isArray(record.content) ? record.content : [];
  const text = blocks.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string).join("") || null;
  const urls: string[] = [];
  for (const block of blocks) {
    if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const hit of block.content as Array<{ url?: unknown }>) {
        if (typeof hit?.url === "string") urls.push(hit.url);
      }
    }
  }
  return {
    text,
    usage: {
      inputTokens: nonNegativeInt(record.usage?.input_tokens),
      outputTokens: nonNegativeInt(record.usage?.output_tokens),
      cacheReadTokens: nonNegativeInt(record.usage?.cache_read_input_tokens),
      cacheWriteTokens: nonNegativeInt(record.usage?.cache_creation_input_tokens),
      webSearchRequests: nonNegativeInt(record.usage?.server_tool_use?.web_search_requests),
    },
    stopReason: record.stop_reason ?? null,
    sourceUrls: [...new Set(urls)],
  };
}

function failureFromError(error: unknown, secrets: readonly string[]): ProviderFailure {
  const text = redactSecrets(String((error as Error | null)?.message ?? error), secrets);
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ProviderFailure("TIMEOUT", null, text);
  if (error instanceof Anthropic.APIConnectionError) return new ProviderFailure("NETWORK", null, text);
  const status = typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : null;
  if (status !== null) {
    const headers = (error as { headers?: { get?(name: string): string | null } | Record<string, string> }).headers;
    const header = typeof (headers as { get?: unknown } | undefined)?.get === "function"
      ? (headers as { get(name: string): string | null }).get("retry-after")
      : (headers as Record<string, string> | undefined)?.["retry-after"];
    return new ProviderFailure(`HTTP_${status}`, status, text, retryAfterMsFrom(header));
  }
  const name = (error as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return new ProviderFailure("TIMEOUT", null, text);
  return new ProviderFailure("UNKNOWN", null, text);
}

export function createAnthropicProvider(options: AnthropicProviderOptions): Provider {
  const retry = options.retry ?? DEFAULT_RETRY;
  const secrets = [options.apiKey];
  const settings = [
    options.effort ? `effort=${options.effort}` : null,
    options.thinking === "off" ? "thinking=off" : null,
  ].filter((part): part is string => part !== null);
  const label = settings.length > 0 ? `${options.model} ${settings.join(" ")}` : options.model;
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 0,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    name: "anthropic",
    model: options.model,
    label,
    async run(request: NeutralRequest, context: CallContext = {}): Promise<ProviderResult> {
      const result = emptyResult("anthropic", options.model, label);
      const started = performance.now();
      const build = anthropicRequestParams(options, request);
      const estimate = estimateRequestUsd(
        options.model,
        requestChars(request.system, request.user),
        build.params.max_tokens as number,
        request.webSearch ? (request.webSearch.maxUses ?? 1) : 0,
      );

      const outcome = await withRetry(async () => {
        context.beforeAttempt?.(estimate);
        let message: unknown;
        try {
          // deno-lint-ignore no-explicit-any
          message = await client.messages.create(build.params as any, context.signal ? { signal: context.signal } : undefined);
        } catch (error) {
          const failure = failureFromError(error, secrets);
          // A timeout may still have been billed; every other failed attempt is treated as free.
          context.afterAttempt?.(failure.code === "TIMEOUT" ? estimate : 0);
          throw failure;
        }
        const parsed = parseAnthropicMessage(message);
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
      const usageCost = costUsd(options.model, usage);
      if (stopReason === "refusal") {
        return {
          ...result,
          usage,
          costUsd: usageCost,
          stopReason,
          error: { code: "REFUSAL", status: 200, retryable: false, message: "the model declined the request" },
        };
      }
      const { parsed, parseError } = parseJsonText(text, request.schema !== undefined);
      return {
        ...result,
        ok: true,
        text,
        parsed,
        parseError: stopReason === "max_tokens" && parseError ? `TRUNCATED:${parseError}` : parseError,
        usage,
        costUsd: usageCost,
        stopReason,
        sourceUrls,
      };
    },
  };
}
