// Kabumori AI model registry: the one place that says which OpenAI model, reasoning setting and output cap the
// Kabumori shared market-report pipeline uses, and what a call costs.
//
// Scope (2026-10-07): the shared morning / closing market report that the Kabumori app and the Kabumori X
// morning / closing posts both read: its generation call and its Fact-check call. Nothing else. The social
// auto-post product (POSTONA) keeps its own policy (_shared/social_ai_model_policy.ts); important-news-monitor,
// MIC and the personalized reports are not governed here.
//
// The registry is source code on purpose: a model change is a reviewed change with a new `KABUMORI_AI_CONFIG_VERSION`.
// There is no environment or database override that could bypass review. Callers ask for a LOGICAL ROLE and never
// write a model id themselves (market-report-analysis/model_literal_guard_test.ts fails if a new literal appears).
//
// Verified against the official OpenAI API documentation on 2026-10-07:
//   - developers.openai.com/api/docs/models/gpt-6.1-sol: the model id, Responses API and Structured Outputs
//     supported, context window 1,050,000 tokens, max output 128,000 tokens, standard price per 1M tokens
//     input $2 / cached input $0.10 / output $10.
//   - developers.openai.com/api/docs/pricing: short context is up to 272K input tokens; above that, per 1M
//     tokens input $4 / cached input $0.20 / output $15 (batch, flex: half of those).
//   - developers.openai.com/api/docs/guides/reasoning: Responses API syntax `"reasoning": { "effort": "<value>" }`;
//     this model supports low, medium (the default), high, xhigh and max, and does NOT support none or minimal.
//     Reasoning tokens are billed as output tokens and count against max_output_tokens.

export const KABUMORI_AI_CONFIG_VERSION = "kabumori-ai-models/2026-10-07.1";

export const MARKET_REPORT_GENERATE_ROLE = "kabumori.market_report.generate";
export const MARKET_REPORT_FACT_ROLE = "kabumori.market_report.fact";
export type KabumoriAiRole = typeof MARKET_REPORT_GENERATE_ROLE | typeof MARKET_REPORT_FACT_ROLE;

/** The values the Responses API accepts for the model in use here (none / minimal are rejected by it). */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type TokenPrice = { inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number };
export type ModelPricing = {
  /** Standard processing, requests up to `longContextAboveInputTokens` input tokens. */
  standard: TokenPrice;
  /** Standard processing, requests above that many input tokens. */
  longContext: TokenPrice;
  longContextAboveInputTokens: number;
  /** Where and when the numbers were read. */
  source: string;
  verifiedOn: string;
};

export type KabumoriAiRoleConfig = {
  role: KabumoriAiRole;
  /** What the call is for, in words (shown by the inventory). */
  workload: string;
  model: string;
  reasoning: { effort: ReasoningEffort };
  /** `max_output_tokens` of the request. Reasoning tokens count against it, so it is larger than the answer. */
  maxOutputTokens: number;
};

const SOL = "gpt-6.1-sol";

/** Prices of the models the roles can resolve to, per 1M tokens, standard processing. */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  [SOL]: Object.freeze({
    standard: Object.freeze({ inputPerMillion: 2, cachedInputPerMillion: 0.1, outputPerMillion: 10 }),
    longContext: Object.freeze({ inputPerMillion: 4, cachedInputPerMillion: 0.2, outputPerMillion: 15 }),
    longContextAboveInputTokens: 272_000,
    source: "developers.openai.com/api/docs/pricing and /api/docs/models/gpt-6.1-sol",
    verifiedOn: "2026-10-07",
  }),
});

function frozenRole(config: KabumoriAiRoleConfig): Readonly<KabumoriAiRoleConfig> {
  return Object.freeze({ ...config, reasoning: Object.freeze({ ...config.reasoning }) });
}

/**
 * The assignments. Generation: medium reasoning (the model's default; the report is written once and judged by
 * the Fact check and the local guards). Fact: low reasoning (a comparison against the input, small output).
 * Output caps: 16,000 / 4,000 tokens; they include reasoning tokens, and the previous caps (10,000 / 1,500) were
 * sized for a smaller model at low effort. A cap only limits cost, it does not add any.
 */
export const KABUMORI_AI_MODELS: Readonly<Record<KabumoriAiRole, Readonly<KabumoriAiRoleConfig>>> = Object.freeze({
  [MARKET_REPORT_GENERATE_ROLE]: frozenRole({
    role: MARKET_REPORT_GENERATE_ROLE,
    workload: "Market report generation (Kabumori app and X morning / closing reports)",
    model: SOL,
    reasoning: { effort: "medium" },
    maxOutputTokens: 16_000,
  }),
  [MARKET_REPORT_FACT_ROLE]: frozenRole({
    role: MARKET_REPORT_FACT_ROLE,
    workload: "Market report Fact check (same pipeline as the generation call)",
    model: SOL,
    reasoning: { effort: "low" },
    maxOutputTokens: 4_000,
  }),
});

export class KabumoriAiRoleError extends Error {
  constructor(role: string) {
    super(`KABUMORI_AI_ROLE_UNKNOWN:${role.replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, 80)}`);
  }
}

/** The configuration of a logical role. An unknown role throws: there is no silent default model. */
export function resolveKabumoriAiRole(role: string): Readonly<KabumoriAiRoleConfig> {
  const config = (KABUMORI_AI_MODELS as Record<string, Readonly<KabumoriAiRoleConfig>>)[role];
  if (!config) throw new KabumoriAiRoleError(role);
  return config;
}

/** The model / reasoning / output-cap part of a Responses API request body for a role. */
export function responsesApiParams(role: KabumoriAiRole): { model: string; reasoning: { effort: ReasoningEffort }; max_output_tokens: number } {
  const config = resolveKabumoriAiRole(role);
  return { model: config.model, reasoning: { effort: config.reasoning.effort }, max_output_tokens: config.maxOutputTokens };
}

/**
 * Estimated cost of one request on a model, in USD rounded to 6 decimals, from that model's official price.
 * Every input token is priced as uncached (cached-input discounts are not counted: an upper bound), and a request
 * above the long-context threshold uses the long-context price. A model without a published price throws: an
 * unpriced model never costs "nothing".
 */
export function estimateModelCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) throw new Error(`KABUMORI_AI_PRICE_UNKNOWN:${model.replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, 60)}`);
  const price = inputTokens > pricing.longContextAboveInputTokens ? pricing.longContext : pricing.standard;
  return Number(((inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000).toFixed(6));
}

/** Estimated cost of one request of a logical role (see estimateModelCostUsd). */
export function estimateCallCostUsd(role: KabumoriAiRole, inputTokens: number, outputTokens: number): number {
  return estimateModelCostUsd(resolveKabumoriAiRole(role).model, inputTokens, outputTokens);
}

/** The audit tuple of a role: which logical role ran, on which actual model, under which configuration. */
export function auditTuple(role: KabumoriAiRole): { logical_role: KabumoriAiRole; actual_model: string; config_version: string } {
  return { logical_role: role, actual_model: resolveKabumoriAiRole(role).model, config_version: KABUMORI_AI_CONFIG_VERSION };
}

/**
 * The audit tuple of every role in this pipeline as flat strings for `report_diagnostics` (a jsonb of text values,
 * so no migration is needed). `model` stays the generation model for existing readers.
 */
export function auditDiagnostics(): Record<string, string> {
  const generate = auditTuple(MARKET_REPORT_GENERATE_ROLE);
  const fact = auditTuple(MARKET_REPORT_FACT_ROLE);
  return {
    ai_config_version: KABUMORI_AI_CONFIG_VERSION,
    ai_generate_role: generate.logical_role,
    ai_generate_model: generate.actual_model,
    ai_generate_reasoning: resolveKabumoriAiRole(MARKET_REPORT_GENERATE_ROLE).reasoning.effort,
    ai_fact_role: fact.logical_role,
    ai_fact_model: fact.actual_model,
    ai_fact_reasoning: resolveKabumoriAiRole(MARKET_REPORT_FACT_ROLE).reasoning.effort,
  };
}

/** One-line-per-role description for the developer inventory. Pure: no network, no environment. */
export function describeKabumoriAiModels(): string {
  const title = (role: KabumoriAiRole) => role === MARKET_REPORT_GENERATE_ROLE ? "Market Report Generate" : "Market Report Fact";
  const lines = ([MARKET_REPORT_GENERATE_ROLE, MARKET_REPORT_FACT_ROLE] as KabumoriAiRole[]).map((role) => {
    const config = resolveKabumoriAiRole(role);
    return `${title(role)}: ${config.model} / reasoning ${config.reasoning.effort} / max output ${config.maxOutputTokens} tokens  [${role}]`;
  });
  const models = [...new Set(Object.values(KABUMORI_AI_MODELS).map((config) => config.model))];
  const prices = models.map((model) => {
    const pricing = MODEL_PRICING[model];
    return pricing
      ? `${model}: $${pricing.standard.inputPerMillion} in / $${pricing.standard.cachedInputPerMillion} cached / $${pricing.standard.outputPerMillion} out per 1M tokens (above ${pricing.longContextAboveInputTokens} input tokens: $${pricing.longContext.inputPerMillion} / $${pricing.longContext.cachedInputPerMillion} / $${pricing.longContext.outputPerMillion}); verified ${pricing.verifiedOn}`
      : `${model}: NO PRICE DEFINED`;
  });
  return [`Kabumori AI models (config ${KABUMORI_AI_CONFIG_VERSION})`, ...lines, "Prices:", ...prices.map((line) => `  ${line}`)].join("\n");
}
