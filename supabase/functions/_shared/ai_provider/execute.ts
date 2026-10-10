// executeAiRequest: one logical model call, safely.
//
// Order of operations (nothing is sent until every local check passed):
//   1. validate the request against the catalog (model, provider, effort, output cap) and the schema policy;
//   2. resolve the provider key from the caller's environment reader;
//   3. per attempt: reserve the attempt's upper-bound cost in the budget guard, send ONE HTTP request through the
//      provider's adapter, price its usage (or charge the upper bound when usage is unknown), settle the guard;
//   4. a response is a result only if its text parses as JSON AND passes the ORIGINAL schema;
//   5. retry only transient transport failures, within the request's transport policy and the deadline.
//
// There is no fallback: the request's provider is the only provider called. A refusal is returned as a failure and
// never retried. Business regeneration (rewriting after a content rejection) belongs to the caller.

import type { AdapterCall, AdapterOutcome, FetchLike } from "./adapter.ts";
import { callAnthropic } from "./anthropic_adapter.ts";
import type { BudgetDecision, BudgetGuard } from "./budget.ts";
import { attemptCostUsd, costBasisOf, sumCostUsd, sumUsage, upperBoundAttemptCostUsd, usageMonthJst } from "./cost.ts";
import { type ClassifiedError, messageFor } from "./errors.ts";
import { findModelSpec, type ModelSpec } from "./model_catalog.ts";
import { callOpenAi } from "./openai_adapter.ts";
import { DEFAULT_RETRY_TIMING, isValidTransportPolicy, nextRetryDelayMs, type RetryTiming } from "./retry.ts";
import { isValidSchemaName, SchemaUnsupportedError, toProviderSchema } from "./schema.ts";
import { type EnvReader, resolveProviderApiKey } from "./secrets.ts";
import type { AiAttemptRecord, AiErrorCode, AiFailure, AiRequest, AiResult, AiSuccess, AiUsageKey, JsonSchema } from "./types.ts";
import { validateAgainstSchema } from "./validate.ts";

export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

export type AiAttemptEvent = AiAttemptRecord & { readonly usageKey: AiUsageKey };

export type ExecuteDeps = {
  /** Reads ONE environment variable; in an Edge Function `(name) => Deno.env.get(name)`. */
  readonly readEnv: EnvReader;
  /** Required: every attempt reserves budget first. */
  readonly budget: BudgetGuard;
  readonly fetch?: FetchLike;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly retryTiming?: RetryTiming;
  /**
   * Absolute time (epoch ms) after which no new attempt starts. Default: start + timeoutMs x maxAttempts plus the
   * longest allowed waits. Pass the caller's own run deadline to fit inside an Edge Function time limit.
   */
  readonly deadlineAtMs?: number;
  /** Telemetry hook, called after every attempt. Receives counts and identifiers only (no prompt, output or key). */
  readonly onAttempt?: (event: AiAttemptEvent) => void;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

type Validated = { readonly spec: ModelSpec; readonly providerSchema: JsonSchema };
type Rejection = { readonly code: AiErrorCode; readonly detail: string };

/** Local checks; nothing has been sent when this rejects. */
export function validateAiRequest(request: AiRequest): Validated | Rejection {
  if (request === null || typeof request !== "object") return { code: "REQUEST_INVALID", detail: "request" };
  if (typeof request.logicalRole !== "string" || !IDENTIFIER.test(request.logicalRole)) return { code: "REQUEST_INVALID", detail: "logicalRole" };
  const context = request.usageContext;
  if (!context || typeof context.application !== "string" || !IDENTIFIER.test(context.application)) return { code: "REQUEST_INVALID", detail: "usageContext.application" };
  if (typeof context.feature !== "string" || !IDENTIFIER.test(context.feature)) return { code: "REQUEST_INVALID", detail: "usageContext.feature" };
  if (request.provider !== "openai" && request.provider !== "anthropic") return { code: "REQUEST_INVALID", detail: "provider" };
  if (typeof request.model !== "string") return { code: "REQUEST_INVALID", detail: "model" };
  const spec = findModelSpec(request.model);
  if (!spec) return { code: "MODEL_UNKNOWN", detail: "model" };
  if (spec.provider !== request.provider) return { code: "MODEL_PROVIDER_MISMATCH", detail: "model" };
  if (typeof request.systemInstructions !== "string" || request.systemInstructions.trim() === "") return { code: "REQUEST_INVALID", detail: "systemInstructions" };
  if (typeof request.userContent !== "string" || request.userContent.trim() === "") return { code: "REQUEST_INVALID", detail: "userContent" };
  if (!spec.reasoningEfforts.includes(request.reasoningEffort)) return { code: "CAPABILITY_UNSUPPORTED", detail: "reasoningEffort" };
  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) return { code: "REQUEST_INVALID", detail: "maxOutputTokens" };
  if (request.maxOutputTokens > spec.maxOutputTokens) return { code: "CAPABILITY_UNSUPPORTED", detail: "maxOutputTokens" };
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < MIN_TIMEOUT_MS || request.timeoutMs > MAX_TIMEOUT_MS) return { code: "REQUEST_INVALID", detail: "timeoutMs" };
  if (!isValidTransportPolicy(request.transport)) return { code: "REQUEST_INVALID", detail: "transport" };
  if (!request.jsonSchema || typeof request.jsonSchema.name !== "string" || !isValidSchemaName(request.jsonSchema.name)) {
    return { code: "REQUEST_INVALID", detail: "jsonSchema.name" };
  }
  try {
    return { spec, providerSchema: toProviderSchema(spec.provider, request.jsonSchema.schema).schema };
  } catch (error) {
    if (error instanceof SchemaUnsupportedError) return { code: "SCHEMA_UNSUPPORTED", detail: `${error.reason}@${error.path || "/"}` };
    return { code: "SCHEMA_UNSUPPORTED", detail: "schema" };
  }
}

function adapterFor(spec: ModelSpec): (call: AdapterCall) => Promise<AdapterOutcome> {
  return spec.provider === "anthropic" ? callAnthropic : callOpenAi;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usageKeyOf(request: AiRequest, startedAtMs: number): AiUsageKey {
  return {
    provider: request.provider,
    model: String(request.model),
    application: String(request.usageContext?.application ?? ""),
    feature: String(request.usageContext?.feature ?? ""),
    logicalRole: String(request.logicalRole ?? ""),
    month: usageMonthJst(startedAtMs),
  };
}

function lastActualModel(attempts: readonly AiAttemptRecord[]): string | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index].actualModel !== null) return attempts[index].actualModel;
  }
  return null;
}

function failureResult(
  request: AiRequest,
  usageKey: AiUsageKey,
  attempts: readonly AiAttemptRecord[],
  latencyMs: number,
  code: AiErrorCode,
  retryable: boolean,
  httpStatus: number | null,
  detail: string | null,
): AiFailure {
  return {
    ok: false,
    errorCode: code,
    retryable,
    httpStatus,
    provider: request.provider,
    configuredModel: String(request.model),
    actualModel: lastActualModel(attempts),
    usage: sumUsage(attempts.map((attempt) => attempt.usage)),
    estimatedCostUsd: sumCostUsd(attempts.map((attempt) => attempt.estimatedCostUsd)),
    costBasis: costBasisOf(attempts),
    transportAttempts: attempts.length,
    attempts,
    latencyMs,
    usageKey,
    message: messageFor(code),
    detail,
  };
}

/** Run one logical call. Never throws; every outcome is an AiResult. */
export async function executeAiRequest(request: AiRequest, deps: ExecuteDeps): Promise<AiResult> {
  const now = deps.nowMs ?? (() => Date.now());
  const startedAt = now();
  const usageKey = usageKeyOf(request, startedAt);
  const attempts: AiAttemptRecord[] = [];
  const elapsed = () => Math.max(0, now() - startedAt);

  const validated = validateAiRequest(request);
  if ("code" in validated) return failureResult(request, usageKey, attempts, elapsed(), validated.code, false, null, validated.detail);
  const { spec, providerSchema } = validated;

  const key = resolveProviderApiKey(spec.provider, deps.readEnv);
  if (!key.ok) return failureResult(request, usageKey, attempts, elapsed(), key.code, false, null, key.envName);

  const timing = deps.retryTiming ?? DEFAULT_RETRY_TIMING;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const deadline = deps.deadlineAtMs ??
    startedAt + request.timeoutMs * request.transport.maxAttempts + timing.maxRetryAfterMs * (request.transport.maxAttempts - 1);
  const upperBoundUsd = upperBoundAttemptCostUsd(spec, request);
  const budgetContext = {
    provider: spec.provider,
    model: spec.id,
    application: request.usageContext.application,
    feature: request.usageContext.feature,
    logicalRole: request.logicalRole,
  };
  const adapter = adapterFor(spec);

  for (let attempt = 1;; attempt += 1) {
    const remaining = deadline - now();
    if (remaining < Math.min(timing.minAttemptMs, request.timeoutMs)) {
      return failureResult(request, usageKey, attempts, elapsed(), "DEADLINE_EXCEEDED", true, null, "deadline");
    }

    let decision: BudgetDecision;
    try {
      decision = await deps.budget.reserve(budgetContext, upperBoundUsd);
    } catch {
      decision = { allowed: false, reason: "GUARD_UNAVAILABLE", limitId: null };
    }
    if (!decision.allowed) {
      return failureResult(request, usageKey, attempts, elapsed(), "BUDGET_DENIED", false, null, decision.reason);
    }

    const attemptStart = now();
    const outcome = await adapter({
      request,
      spec,
      providerSchema,
      key: key.key,
      timeoutMs: Math.min(request.timeoutMs, Math.max(1, Math.floor(remaining))),
      fetch: fetchImpl,
      nowMs: now,
    });
    const usage = outcome.usage;
    // Unknown usage on a request that may have been processed is charged at its upper bound, never at zero.
    const costIsUpperBound = usage === null;
    const estimatedCostUsd = usage ? attemptCostUsd(spec, usage) : upperBoundUsd;
    try {
      await deps.budget.settle(decision.reservation, estimatedCostUsd);
    } catch {
      // The reservation stays counted at its upper bound: the safe side.
    }

    let errorCode: AiErrorCode | null = outcome.ok ? null : outcome.error.code;
    let parsed: unknown = undefined;
    let invalidDetail: string | null = null;
    if (outcome.ok) {
      try {
        parsed = JSON.parse(outcome.text);
      } catch {
        errorCode = "INVALID_JSON";
      }
      if (errorCode === null) {
        const issues = validateAgainstSchema(parsed, request.jsonSchema.schema);
        if (issues.length > 0) {
          errorCode = "SCHEMA_VIOLATION";
          invalidDetail = issues.slice(0, 5).map((issue) => `${issue.path}:${issue.keyword}`).join(";");
        }
      }
    }

    const record: AiAttemptRecord = {
      attempt,
      ok: errorCode === null,
      errorCode,
      httpStatus: outcome.ok ? outcome.httpStatus : outcome.error.httpStatus,
      actualModel: outcome.actualModel,
      usage: usage ?? null,
      estimatedCostUsd,
      costIsUpperBound,
      requestId: outcome.requestId,
      latencyMs: Math.max(0, now() - attemptStart),
    };
    attempts.push(record);
    try {
      deps.onAttempt?.({ ...record, usageKey });
    } catch {
      // Telemetry must never change the outcome.
    }

    if (outcome.ok) {
      if (errorCode !== null) {
        return failureResult(request, usageKey, attempts, elapsed(), errorCode, false, outcome.httpStatus, invalidDetail ?? "json_parse");
      }
      const totals = sumUsage(attempts.map((item) => item.usage));
      const success: AiSuccess = {
        ok: true,
        parsedPayload: parsed,
        provider: request.provider,
        configuredModel: spec.id,
        actualModel: lastActualModel(attempts),
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        reasoningOutputTokens: totals.reasoningOutputTokens,
        cacheUsage: {
          readInputTokens: totals.cacheReadInputTokens,
          write5mInputTokens: totals.cacheWrite5mInputTokens,
          write1hInputTokens: totals.cacheWrite1hInputTokens,
        },
        usage: totals,
        estimatedCostUsd: sumCostUsd(attempts.map((item) => item.estimatedCostUsd)),
        costBasis: costBasisOf(attempts),
        transportAttempts: attempts.length,
        attempts,
        latencyMs: elapsed(),
        usageKey,
        stopReason: outcome.stopReason,
        requestId: outcome.requestId,
      };
      return success;
    }

    const error: ClassifiedError = outcome.error;
    const delay = nextRetryDelayMs(request.transport, timing, attempt, error, random);
    if (delay === null || now() + delay + Math.min(timing.minAttemptMs, request.timeoutMs) > deadline) {
      return failureResult(request, usageKey, attempts, elapsed(), error.code, error.retryable, error.httpStatus, error.detail);
    }
    await sleep(delay);
  }
}
