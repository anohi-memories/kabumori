// Provider-neutral shapes for the OpenAI / Claude comparison harness.
//
// Nothing here is imported by production code: the harness lives under tools/ (outside supabase/functions, so
// it is never part of an Edge Function bundle) and only READS production prompt builders.

export type ProviderName = "openai" | "anthropic" | "recorded" | "mock";

export type Effort = "low" | "medium" | "high";

/** One model call, independent of the provider's wire format. */
export type NeutralRequest = {
  taskId: string;
  caseId: string;
  /** System / developer instructions (OpenAI `instructions`, Anthropic `system`). */
  system: string;
  /** The single user turn (production sends one JSON string as `input`). */
  user: string;
  /** Strict JSON output (OpenAI `text.format`, Anthropic `output_config.format`). */
  schema?: { name: string; schema: Record<string, unknown> };
  /** Hosted web search. `maxUses` mirrors OpenAI `max_tool_calls`. */
  webSearch?: { allowedDomains?: string[]; maxUses?: number };
  /** The visible-answer budget production asked for (OpenAI `max_output_tokens`). */
  maxOutputTokens: number;
  effort?: Effort;
};

export type Usage = {
  /** Uncached input tokens. */
  inputTokens: number;
  /** Output tokens, including reasoning / thinking tokens (both vendors bill them as output). */
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchRequests: number;
};

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  webSearchRequests: 0,
};

export type ProviderError = {
  code: string;
  status: number | null;
  retryable: boolean;
  /** Already passed through redactSecrets. */
  message: string;
};

export type ProviderResult = {
  provider: ProviderName;
  model: string;
  /** model plus the settings that change cost / behaviour, e.g. "claude-haiku-5-5 effort=low". */
  label: string;
  ok: boolean;
  text: string | null;
  parsed: unknown | null;
  /** Set when text came back but was not the JSON the schema asked for. */
  parseError: string | null;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  stopReason: string | null;
  /** HTTP attempts made (each one is counted against the budget). */
  attempts: number;
  /** URLs the search surfaced (web search tasks only). */
  sourceUrls: string[];
  error: ProviderError | null;
};

/** Hooks the runner passes so that every HTTP attempt, retries included, is budgeted. */
export type CallContext = {
  signal?: AbortSignal;
  beforeAttempt?: (estimatedUsd: number) => void;
  afterAttempt?: (costUsd: number) => void;
};

export interface Provider {
  readonly name: ProviderName;
  readonly model: string;
  readonly label: string;
  run(request: NeutralRequest, context?: CallContext): Promise<ProviderResult>;
}

/** Where a usage row comes from, so one Claude credit pool can serve several apps (Kabumori, POSTONA). */
export type UsageRecord = {
  provider: "openai" | "anthropic";
  app: string;
  feature: string;
  model: string;
  /** ISO month, e.g. "2026-10" (credits and spend caps are monthly). */
  month: string;
  usage: Usage;
  costUsd: number;
};
