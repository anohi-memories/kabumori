import type { Usage } from "./types.ts";

// Price table. Every row says where the number comes from:
//   official        read from the vendor's public pricing page on RETRIEVED_AT
//   ledger_assumption  the rate production's own ledger uses (usage_ledger.ts / social_ai_model_policy.ts);
//                   NOT checked against an OpenAI invoice from here, so treat OpenAI costs as estimates.

export const RETRIEVED_AT = "2026-10-09";
export const ANTHROPIC_PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
export const ANTHROPIC_WEB_SEARCH_SOURCE = "https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool";

export type LongContextTier = {
  /** A request whose prompt (input + cache read + cache write) is OVER this many tokens uses this tier. */
  overPromptTokens: number;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
};

export type ModelPrice = {
  provider: "openai" | "anthropic";
  inputPerMTok: number;
  outputPerMTok: number;
  /** 5-minute cache write. Absent: cache writes are charged at the input rate. */
  cacheWritePerMTok?: number;
  /** Absent: cache reads are charged at the input rate (conservative for OpenAI, whose rate is unknown here). */
  cacheReadPerMTok?: number;
  longContext?: LongContextTier;
  /** USD per 1,000 web searches. */
  webSearchPer1000: number;
  verified: "official" | "ledger_assumption";
  note?: string;
};

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // --- Anthropic (official) -------------------------------------------------------------------------------
  "claude-fable-5-1": {
    provider: "anthropic", inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheReadPerMTok: 0.25,
    webSearchPer1000: 10, verified: "official",
  },
  "claude-opus-5-5": {
    provider: "anthropic", inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2,
    webSearchPer1000: 10, verified: "official", note: "thinking cannot be disabled; default effort medium",
  },
  "claude-sonnet-5-5": {
    provider: "anthropic", inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.1,
    webSearchPer1000: 10, verified: "official",
  },
  "claude-haiku-5-5": {
    provider: "anthropic", inputPerMTok: 0.1, outputPerMTok: 0.5, cacheWritePerMTok: 0.125, cacheReadPerMTok: 0.01,
    longContext: {
      overPromptTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5, cacheWritePerMTok: 0.625, cacheReadPerMTok: 0.05,
    },
    webSearchPer1000: 10, verified: "official",
    note: "web search support for this model is not stated on the docs page; probe capabilities.server_tools first",
  },
  "claude-haiku-4-5": {
    provider: "anthropic", inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1,
    webSearchPer1000: 10, verified: "official",
  },
  // --- OpenAI (ledger assumptions) ------------------------------------------------------------------------
  "gpt-6-luna": { provider: "openai", inputPerMTok: 0.1, outputPerMTok: 0.5, webSearchPer1000: 10, verified: "ledger_assumption" },
  "gpt-6-sol": { provider: "openai", inputPerMTok: 2, outputPerMTok: 10, webSearchPer1000: 10, verified: "ledger_assumption" },
  "gpt-5.6-luna": { provider: "openai", inputPerMTok: 0.2, outputPerMTok: 1.2, webSearchPer1000: 10, verified: "ledger_assumption" },
  "gpt-5.6-sol": { provider: "openai", inputPerMTok: 4, outputPerMTok: 20, webSearchPer1000: 10, verified: "ledger_assumption" },
  "gpt-6.1-sol": {
    provider: "openai", inputPerMTok: 2, outputPerMTok: 10, webSearchPer1000: 10, verified: "ledger_assumption",
    note: "social_ai_model_policy.ts says verified 2026-10-07",
  },
};

export class UnknownModelError extends Error {
  constructor(model: string) {
    super(`PRICE_UNKNOWN_MODEL:${model}`);
    this.name = "UnknownModelError";
  }
}

export function priceOf(model: string): ModelPrice {
  const price = MODEL_PRICES[model];
  if (!price) throw new UnknownModelError(model);
  return price;
}

function whole(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Tokens the prompt side of one request counts for tier selection (cache reads and writes included). */
export function promptTokens(usage: Usage): number {
  return whole(usage.inputTokens) + whole(usage.cacheReadTokens) + whole(usage.cacheWriteTokens);
}

/** USD for one request. Thinking tokens are already inside outputTokens (both vendors bill them as output). */
export function costUsd(model: string, usage: Usage): number {
  const price = priceOf(model);
  const tier = price.longContext && promptTokens(usage) > price.longContext.overPromptTokens ? price.longContext : null;
  const input = tier?.inputPerMTok ?? price.inputPerMTok;
  const output = tier?.outputPerMTok ?? price.outputPerMTok;
  const cacheWrite = tier?.cacheWritePerMTok ?? price.cacheWritePerMTok ?? input;
  const cacheRead = tier?.cacheReadPerMTok ?? price.cacheReadPerMTok ?? input;
  const tokens = (whole(usage.inputTokens) * input + whole(usage.outputTokens) * output +
    whole(usage.cacheWriteTokens) * cacheWrite + whole(usage.cacheReadTokens) * cacheRead) / 1_000_000;
  const search = (whole(usage.webSearchRequests) * price.webSearchPer1000) / 1000;
  return Number((tokens + search).toFixed(8));
}

/**
 * A deliberately pessimistic pre-call estimate used by the budget guard: Japanese text is counted at 1 token per
 * character (real tokenizers land between ~0.6 and ~1.0), and the whole output allowance is assumed to be used.
 */
export function estimateRequestUsd(model: string, inputChars: number, maxOutputTokens: number, webSearches = 0): number {
  return costUsd(model, {
    inputTokens: Math.ceil(inputChars),
    outputTokens: maxOutputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearchRequests: webSearches,
  });
}
