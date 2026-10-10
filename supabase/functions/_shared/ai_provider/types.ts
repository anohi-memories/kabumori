// Provider-neutral contract of the shared AI provider (Phase 1a).
//
// One request = one logical model call with a JSON Schema output. The provider and the model are chosen by the
// caller and stated explicitly; this layer never picks a model for a business purpose and never switches between
// OpenAI and Anthropic on its own (no implicit fallback). It owns transport retries only: business regeneration
// stays with the caller.

export type AiProvider = "openai" | "anthropic";

/** Reasoning / thinking effort. Each model accepts only the values listed for it in model_catalog.ts. */
export type AiReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** A JSON Schema object (the subset documented in schema.ts). */
export type JsonSchema = { readonly [key: string]: unknown };

/**
 * On whose behalf the call runs (Phase 1b). System work (market report, news) carries no user or brand; user work
 * carries the user id and, when it is about one brand, the brand id. Both ids must come from the server's own
 * verification (the authenticated user, the brand's ownership checked in the database), never from a request
 * body alone.
 */
export type AiSubject =
  | { readonly kind: "system" }
  | { readonly kind: "user"; readonly userId: string; readonly brandId?: string | null };

/** Who used the call, for usage and budget attribution. Free text identifiers, never personal data. */
export type AiUsageContext = {
  /** The product, e.g. "kabumori" or "postona". */
  readonly application: string;
  /** The feature inside the product, e.g. "market_report". */
  readonly feature: string;
  /** Default: { kind: "system" }. */
  readonly subject?: AiSubject;
};

/**
 * Transport retry contract. The caller states how many HTTP attempts this layer may make, so a caller that keeps
 * its own transport retry (for example market-report-analysis/transport_retry.ts) passes `maxAttempts: 1` and the
 * two retry layers can never multiply.
 */
export type AiTransportPolicy = {
  /** Total HTTP attempts, 1 to 3. 1 means no retry in this layer. */
  readonly maxAttempts: number;
  /**
   * Retry after a client-side timeout. Off by default: a timed-out request may still have been billed, so a
   * retry can pay twice. Every timed-out attempt is charged at its upper-bound cost either way.
   */
  readonly retryOnTimeout?: boolean;
};

export type AiRequest = {
  /** What the call is for, e.g. "kabumori.market_report.generate". Identification only: it selects nothing. */
  readonly logicalRole: string;
  readonly provider: AiProvider;
  /** A model id from model_catalog.ts. It must belong to `provider`. */
  readonly model: string;
  readonly systemInstructions: string;
  readonly userContent: string;
  readonly jsonSchema: { readonly name: string; readonly schema: JsonSchema };
  readonly reasoningEffort: AiReasoningEffort;
  /** Output cap. Reasoning / thinking tokens count against it on both providers. */
  readonly maxOutputTokens: number;
  /** Per HTTP attempt. */
  readonly timeoutMs: number;
  readonly transport: AiTransportPolicy;
  readonly usageContext: AiUsageContext;
  /**
   * Idempotency key of this logical call (Phase 1b). The ledger keys every attempt by (callId, attempt), so a caller
   * that may repeat the same call after a crash passes a stable id (for example derived from its run id). Default:
   * a fresh random UUID.
   */
  readonly callId?: string;
};

export type AiErrorCode =
  // Rejected before any HTTP request (nothing can have been billed).
  | "REQUEST_INVALID"
  | "MODEL_UNKNOWN"
  | "MODEL_PROVIDER_MISMATCH"
  | "CAPABILITY_UNSUPPORTED"
  | "SCHEMA_UNSUPPORTED"
  | "KEY_MISSING"
  | "KEY_INVALID"
  | "BUDGET_DENIED"
  | "DEADLINE_EXCEEDED"
  // From the provider or the transport.
  | "RATE_LIMITED"
  | "OVERLOADED"
  | "SERVER_ERROR"
  | "NETWORK"
  | "TIMEOUT"
  | "AUTH"
  | "CREDIT_EXHAUSTED"
  | "SPEND_LIMIT"
  | "INVALID_REQUEST"
  | "REFUSAL"
  | "INCOMPLETE"
  | "PROTOCOL"
  // The response arrived but is not a valid result.
  | "INVALID_JSON"
  | "SCHEMA_VIOLATION";

/**
 * Token usage of one HTTP attempt. `inputTokens` is the TOTAL prompt (uncached + cache reads + cache writes), so it
 * means the same thing for both providers; the cached parts are broken out in the cache fields.
 */
export type AiTokenUsage = {
  readonly inputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWrite5mInputTokens: number;
  readonly cacheWrite1hInputTokens: number;
  /** Includes reasoning / thinking tokens. */
  readonly outputTokens: number;
  /** The part of outputTokens the provider reported as reasoning / thinking, or null when not reported. */
  readonly reasoningOutputTokens: number | null;
};

export type AiCacheUsage = {
  readonly readInputTokens: number;
  readonly write5mInputTokens: number;
  readonly write1hInputTokens: number;
};

/**
 * How `estimatedCostUsd` was obtained:
 *   - "measured": every HTTP attempt reported usage and was priced from it;
 *   - "includes_upper_bound": at least one attempt has unknown usage (timeout, connection lost, unreadable body) and
 *     was charged at its maximum possible cost instead of zero;
 *   - "no_request": no HTTP request was sent, so nothing can have been billed.
 * Always an ESTIMATE from model_catalog.ts prices, never the provider invoice or the Claude credit balance.
 */
export type AiCostBasis = "measured" | "includes_upper_bound" | "no_request";

export type AiAttemptRecord = {
  readonly attempt: number;
  readonly ok: boolean;
  readonly errorCode: AiErrorCode | null;
  readonly httpStatus: number | null;
  /** The model the provider says answered, or null when the response did not say. */
  readonly actualModel: string | null;
  /** null when the attempt's usage is unknown. */
  readonly usage: AiTokenUsage | null;
  readonly estimatedCostUsd: number;
  readonly costIsUpperBound: boolean;
  readonly requestId: string | null;
  readonly latencyMs: number;
};

/** The six identifiers every usage record is keyed by. `month` is the JST calendar month the call started in. */
export type AiUsageKey = {
  readonly provider: AiProvider;
  readonly model: string;
  readonly application: string;
  readonly feature: string;
  readonly logicalRole: string;
  readonly month: string;
};

/** Sum over the attempts whose usage is known. `unknownUsageAttempts` counts the others (see AiCostBasis). */
export type AiUsageTotals = AiTokenUsage & { readonly unknownUsageAttempts: number };

type AiResultCommon = {
  /** The logical call id the attempts were reserved and recorded under (see AiRequest.callId). */
  readonly callId: string;
  readonly provider: AiProvider;
  readonly configuredModel: string;
  /** From the last response that named its model; null when none did (never the configured model). */
  readonly actualModel: string | null;
  readonly estimatedCostUsd: number;
  readonly costBasis: AiCostBasis;
  readonly transportAttempts: number;
  readonly attempts: readonly AiAttemptRecord[];
  readonly latencyMs: number;
  readonly usageKey: AiUsageKey;
};

export type AiSuccess = AiResultCommon & {
  readonly ok: true;
  /** JSON that parsed AND passed the original schema. Narrow it with the caller's own types. */
  readonly parsedPayload: unknown;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number | null;
  readonly cacheUsage: AiCacheUsage;
  readonly usage: AiUsageTotals;
  readonly stopReason: string;
  readonly requestId: string | null;
};

export type AiFailure = AiResultCommon & {
  readonly ok: false;
  readonly errorCode: AiErrorCode;
  /** True when trying the same request again later may succeed (the caller decides; this layer already stopped). */
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly usage: AiUsageTotals;
  /** A fixed, non-sensitive explanation (never provider text, prompt, output, key or personal data). */
  readonly message: string;
  /** Machine-readable extra: refusal category, incomplete reason, provider error type, or schema issue paths. */
  readonly detail: string | null;
};

export type AiResult = AiSuccess | AiFailure;
