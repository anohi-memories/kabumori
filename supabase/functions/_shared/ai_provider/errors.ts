// Error classification: provider HTTP / transport failures -> one neutral code.
//
// Only the provider's error TYPE and CODE (enumerations) are kept, after sanitising. The provider's free-text
// message is read for the few documented signals below and then dropped: it can echo request content, so it never
// leaves this module. Sources (read 2026-10-10):
//   - Anthropic platform.claude.com/docs/en/api/errors and /api/rate-limits: 400 invalid_request_error (also a
//     spend limit you set: message "You have reached your specified (workspace )API usage limits"), 401
//     authentication_error, 402 billing_error, 403 permission_error, 404 not_found_error, 413 request_too_large,
//     429 rate_limit_error (retry-after) or the tier spend cap (no retry-after, error.details.error_code
//     "enforced_spend_limit_reached"), 500 api_error, 504 timeout_error, 529 overloaded_error.
//     /about-claude/api-credits-for-subscribers: an exhausted credit balance answers "Your credit balance is too
//     low to access the Anthropic API...".
//   - OpenAI: 429 with error code "insufficient_quota" is an exhausted balance, not a rate limit (the existing
//     market-report-analysis/transport_retry.ts treats it the same way).

import { safeToken } from "./redact.ts";
import type { AiErrorCode, AiProvider } from "./types.ts";

export type ClassifiedError = {
  readonly code: AiErrorCode;
  /** The provider layer may send the same request again (subject to the transport policy). */
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  /** Delay the provider asked for, if any. */
  readonly retryAfterMs: number | null;
  /** The request may have been processed and billed although no usage is known (timeouts, lost connections). */
  readonly maybeBilled: boolean;
  /** Sanitised provider error type / code, refusal category or reason. Never free text. */
  readonly detail: string | null;
};

const FIXED_MESSAGES: Readonly<Record<AiErrorCode, string>> = Object.freeze({
  REQUEST_INVALID: "The request does not satisfy the provider contract.",
  MODEL_UNKNOWN: "The model is not in the provider catalog.",
  MODEL_PROVIDER_MISMATCH: "The model does not belong to the requested provider.",
  CAPABILITY_UNSUPPORTED: "The model does not support a requested setting.",
  SCHEMA_UNSUPPORTED: "The JSON Schema uses a feature that cannot be sent or verified.",
  KEY_MISSING: "The provider API key is not configured.",
  KEY_INVALID: "The provider API key is not usable.",
  BUDGET_DENIED: "The budget guard refused the call.",
  DEADLINE_EXCEEDED: "Not enough time left for another attempt.",
  RATE_LIMITED: "The provider rate limit was reached.",
  OVERLOADED: "The provider is temporarily overloaded.",
  SERVER_ERROR: "The provider returned a server error.",
  NETWORK: "The connection to the provider failed.",
  TIMEOUT: "The request timed out; it may still have been billed.",
  AUTH: "The provider rejected the credentials or permissions.",
  CREDIT_EXHAUSTED: "The provider account has no usable credit or billing.",
  SPEND_LIMIT: "A provider spend limit was reached.",
  INVALID_REQUEST: "The provider rejected the request.",
  REFUSAL: "The model declined the request.",
  INCOMPLETE: "The model output was cut off.",
  PROTOCOL: "The provider response had an unexpected shape.",
  INVALID_JSON: "The model output is not valid JSON.",
  SCHEMA_VIOLATION: "The model output does not satisfy the JSON Schema.",
});

/** A fixed, non-sensitive message for a code. */
export function messageFor(code: AiErrorCode): string {
  return FIXED_MESSAGES[code];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `retry-after` (seconds or HTTP date) or `retry-after-ms`, in milliseconds. */
export function retryAfterMsFrom(headers: Headers | null | undefined, nowMs: number = Date.now()): number | null {
  if (!headers) return null;
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\d+(\.\d+)?$/u.test(ms.trim())) return Math.round(Number(ms));
  const value = headers.get("retry-after");
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/u.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

function classified(code: AiErrorCode, retryable: boolean, httpStatus: number | null, detail: string | null, extra: Partial<ClassifiedError> = {}): ClassifiedError {
  return { code, retryable, httpStatus, retryAfterMs: null, maybeBilled: false, detail, ...extra };
}

function anthropicError(status: number, body: unknown, headers: Headers | null, nowMs: number): ClassifiedError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const type = typeof error.type === "string" ? error.type : null;
  const message = typeof error.message === "string" ? error.message : "";
  const details = isRecord(error.details) ? error.details : {};
  const errorCode = typeof details.error_code === "string" ? details.error_code : null;
  const detail = safeToken(errorCode ?? type);
  const retryAfterMs = retryAfterMsFrom(headers, nowMs);

  if (/^Your credit balance is too low/u.test(message)) return classified("CREDIT_EXHAUSTED", false, status, "credit_balance_too_low");
  if (status === 402 || type === "billing_error") return classified("CREDIT_EXHAUSTED", false, status, detail);
  if (errorCode === "enforced_spend_limit_reached") return classified("SPEND_LIMIT", false, status, detail);
  if (status === 400 && /^You have reached your specified (workspace )?API usage limits/u.test(message)) {
    return classified("SPEND_LIMIT", false, status, "specified_spend_limit");
  }
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") return classified("AUTH", false, status, detail);
  if (status === 429 || type === "rate_limit_error") return classified("RATE_LIMITED", true, status, detail, { retryAfterMs });
  if (status === 529 || type === "overloaded_error") return classified("OVERLOADED", true, status, detail, { retryAfterMs });
  if (status === 504 || type === "timeout_error") {
    return classified("SERVER_ERROR", true, status, detail, { retryAfterMs, maybeBilled: true });
  }
  if (status >= 500) return classified("SERVER_ERROR", true, status, detail, { retryAfterMs });
  return classified("INVALID_REQUEST", false, status, detail);
}

function openAiError(status: number, body: unknown, headers: Headers | null, nowMs: number): ClassifiedError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const type = typeof error.type === "string" ? error.type : null;
  const code = typeof error.code === "string" ? error.code : null;
  const detail = safeToken(code ?? type);
  const retryAfterMs = retryAfterMsFrom(headers, nowMs);

  if (code === "insufficient_quota" || type === "insufficient_quota") return classified("CREDIT_EXHAUSTED", false, status, "insufficient_quota");
  if (status === 401 || status === 403) return classified("AUTH", false, status, detail);
  if (status === 429) return classified("RATE_LIMITED", true, status, detail, { retryAfterMs });
  if (status === 503) return classified("OVERLOADED", true, status, detail, { retryAfterMs });
  if (status === 504) return classified("SERVER_ERROR", true, status, detail, { retryAfterMs, maybeBilled: true });
  if (status >= 500) return classified("SERVER_ERROR", true, status, detail, { retryAfterMs });
  return classified("INVALID_REQUEST", false, status, detail);
}

/** Classify a non-2xx HTTP response from a provider. `body` is the parsed JSON body, or null if unreadable. */
export function classifyHttpError(provider: AiProvider, status: number, body: unknown, headers: Headers | null, nowMs: number = Date.now()): ClassifiedError {
  return provider === "anthropic" ? anthropicError(status, body, headers, nowMs) : openAiError(status, body, headers, nowMs);
}

/**
 * Classify a failure before any HTTP response. `timedOut` is true when our own per-attempt timer fired. Both a
 * timeout and a lost connection may have reached the provider, so their cost is treated as possibly billed.
 */
export function classifyTransportError(timedOut: boolean): ClassifiedError {
  if (timedOut) return classified("TIMEOUT", true, null, "client_timeout", { maybeBilled: true });
  return classified("NETWORK", true, null, "connection_failed", { maybeBilled: true });
}
