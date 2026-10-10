// The single price and capability table of the shared AI provider.
//
// Every model the provider can call is listed here with its official price and the capabilities that were
// confirmed in the official documentation. A model that is not listed is rejected before any request (MODEL_UNKNOWN),
// so an unpriced model can never be treated as free. A capability that is not listed is rejected
// (CAPABILITY_UNSUPPORTED) instead of being sent and hoped for.
//
// Sources, read on 2026-10-10:
//   - Anthropic: platform.claude.com/docs/en/about-claude/pricing (model pricing table, prompt caching multipliers,
//     Claude Haiku 5.5 long-context pricing: a prompt over 100,000 tokens, counting cache reads and writes, is priced
//     at the higher rates for the whole request).
//   - OpenAI: developers.openai.com/api/docs/models/gpt-6.1-sol and /gpt-6-luna (Responses API, Structured Outputs,
//     reasoning effort values, 128,000 max output tokens, prices; gpt-6.1-sol prompts over 272K input tokens are
//     priced at 2x input and cache rates and 1.5x output for the full request).
//
// The prices are list prices. A cost computed from them is an ESTIMATE: it is not the provider invoice and not the
// Claude credit balance (see cost.ts).

import type { AiProvider, AiReasoningEffort } from "./types.ts";

export const AI_PROVIDER_CATALOG_VERSION = "ai-provider-catalog/2026-10-10.1";

/** USD per 1M tokens. */
export type PriceTier = {
  /** This tier applies when the request's total prompt tokens are ABOVE this value (0 = from the first token). */
  readonly promptTokensAbove: number;
  readonly inputPer1M: number;
  readonly cacheReadPer1M: number;
  /** OpenAI does not bill cache writes; its adapter never reports them, and the input price is kept here. */
  readonly cacheWrite5mPer1M: number;
  readonly cacheWrite1hPer1M: number;
  readonly outputPer1M: number;
};

export type ModelSpec = {
  readonly id: string;
  readonly provider: AiProvider;
  /** Ascending by promptTokensAbove; the first tier starts at 0. */
  readonly priceTiers: readonly PriceTier[];
  readonly maxOutputTokens: number;
  /** Only the values the official documentation lists for this model. */
  readonly reasoningEfforts: readonly AiReasoningEffort[];
  /** JSON Schema constrained output (OpenAI Structured Outputs / Anthropic output_config.format). */
  readonly structuredOutput: true;
  readonly source: string;
  readonly verifiedOn: string;
};

const ANTHROPIC_PRICING = "platform.claude.com/docs/en/about-claude/pricing";
const ALL_ANTHROPIC_EFFORTS: readonly AiReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

function freezeSpec(spec: ModelSpec): ModelSpec {
  return Object.freeze({
    ...spec,
    priceTiers: Object.freeze(spec.priceTiers.map((tier) => Object.freeze({ ...tier }))),
    reasoningEfforts: Object.freeze([...spec.reasoningEfforts]),
  });
}

const SPECS: readonly ModelSpec[] = [
  {
    id: "claude-opus-5-5",
    provider: "anthropic",
    // Thinking is always on for this model; the effort level is the only control (default medium, sent explicitly).
    priceTiers: [{ promptTokensAbove: 0, inputPer1M: 4, cacheReadPer1M: 0.2, cacheWrite5mPer1M: 5, cacheWrite1hPer1M: 8, outputPer1M: 20 }],
    maxOutputTokens: 128_000,
    reasoningEfforts: ALL_ANTHROPIC_EFFORTS,
    structuredOutput: true,
    source: ANTHROPIC_PRICING,
    verifiedOn: "2026-10-10",
  },
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    priceTiers: [{ promptTokensAbove: 0, inputPer1M: 2, cacheReadPer1M: 0.1, cacheWrite5mPer1M: 2.5, cacheWrite1hPer1M: 4, outputPer1M: 10 }],
    maxOutputTokens: 128_000,
    reasoningEfforts: ALL_ANTHROPIC_EFFORTS,
    structuredOutput: true,
    source: ANTHROPIC_PRICING,
    verifiedOn: "2026-10-10",
  },
  {
    id: "claude-haiku-5-5",
    provider: "anthropic",
    priceTiers: [
      { promptTokensAbove: 0, inputPer1M: 0.1, cacheReadPer1M: 0.01, cacheWrite5mPer1M: 0.125, cacheWrite1hPer1M: 0.2, outputPer1M: 0.5 },
      { promptTokensAbove: 100_000, inputPer1M: 0.5, cacheReadPer1M: 0.05, cacheWrite5mPer1M: 0.625, cacheWrite1hPer1M: 1, outputPer1M: 2.5 },
    ],
    maxOutputTokens: 128_000,
    reasoningEfforts: ALL_ANTHROPIC_EFFORTS,
    structuredOutput: true,
    source: ANTHROPIC_PRICING,
    verifiedOn: "2026-10-10",
  },
  {
    id: "gpt-6.1-sol",
    provider: "openai",
    priceTiers: [
      { promptTokensAbove: 0, inputPer1M: 2, cacheReadPer1M: 0.1, cacheWrite5mPer1M: 2, cacheWrite1hPer1M: 2, outputPer1M: 10 },
      { promptTokensAbove: 272_000, inputPer1M: 4, cacheReadPer1M: 0.2, cacheWrite5mPer1M: 4, cacheWrite1hPer1M: 4, outputPer1M: 15 },
    ],
    maxOutputTokens: 128_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    structuredOutput: true,
    source: "developers.openai.com/api/docs/models/gpt-6.1-sol",
    verifiedOn: "2026-10-10",
  },
  {
    id: "gpt-6-luna",
    provider: "openai",
    priceTiers: [{ promptTokensAbove: 0, inputPer1M: 0.1, cacheReadPer1M: 0.01, cacheWrite5mPer1M: 0.1, cacheWrite1hPer1M: 0.1, outputPer1M: 0.5 }],
    maxOutputTokens: 128_000,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    structuredOutput: true,
    source: "developers.openai.com/api/docs/models/gpt-6-luna",
    verifiedOn: "2026-10-10",
  },
].map((spec) => freezeSpec(spec as ModelSpec));

const BY_ID: ReadonlyMap<string, ModelSpec> = new Map(SPECS.map((spec) => [spec.id, spec]));

/** The catalog entry of a model, or undefined when it is not in the catalog. */
export function findModelSpec(model: string): ModelSpec | undefined {
  return BY_ID.get(model);
}

/** All catalog entries (frozen). */
export function listModelSpecs(): readonly ModelSpec[] {
  return SPECS;
}

/** The price tier of a request with this many total prompt tokens. */
export function priceTierFor(spec: ModelSpec, promptTokens: number): PriceTier {
  let selected = spec.priceTiers[0];
  for (const tier of spec.priceTiers) {
    if (promptTokens > tier.promptTokensAbove) selected = tier;
  }
  return selected;
}
