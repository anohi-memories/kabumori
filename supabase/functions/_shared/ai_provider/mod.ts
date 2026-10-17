// Public entry point of the shared AI provider (Phase 1a + 1b, F6 M1 model policies). Import from here, not from the individual files.
// Contracts: docs/ai-provider/PROVIDER_CONTRACT.md, docs/ai-provider/PHASE1B_LEDGER_DESIGN.md.

export type {
  AiAttemptRecord,
  AiCacheUsage,
  AiCostBasis,
  AiErrorCode,
  AiFailure,
  AiProvider,
  AiReasoningEffort,
  AiRequest,
  AiResult,
  AiSubject,
  AiSuccess,
  AiTokenUsage,
  AiTransportPolicy,
  AiUsageContext,
  AiUsageKey,
  AiUsageTotals,
  JsonSchema,
} from "./types.ts";
export { type AiAttemptEvent, executeAiRequest, type ExecuteDeps, validateAiRequest } from "./execute.ts";
export {
  type BudgetCallContext,
  type BudgetDecision,
  type BudgetDenyReason,
  type BudgetGuard,
  type BudgetLimit,
  type BudgetLimitState,
  type BudgetReservation,
  type BudgetScope,
  type BudgetSettlement,
  InMemoryBudgetGuard,
} from "./budget.ts";
export { LedgerRpcError, type LedgerGuardOptions, SupabaseLedgerBudgetGuard } from "./ledger_guard.ts";
export {
  AI_PROVIDER_CATALOG_VERSION,
  findModelSpec,
  listModelAliases,
  listModelSpecs,
  type ModelSpec,
  type PriceTier,
  resolveModelName,
} from "./model_catalog.ts";
export {
  type AnthropicModelPolicy,
  defineAnthropicModelPolicies,
  executeWithModelPolicy,
  MODEL_POLICY_PROVIDER,
  type ModelPolicyAttribution,
  type ModelPolicyCall,
  type ModelPolicyDenial,
  ModelPolicyError,
  type ModelPolicyOutcome,
  type ModelPolicyRegistry,
  modelPolicyRequest,
  type ModelPolicySelection,
  type ResolvedModelChoice,
  type ResolvedModelPolicy,
  resolveModelChoice,
} from "./model_policy.ts";
export { attemptCostUsd, upperBoundAttemptCostUsd, upperBoundInputTokens, usageMonthJst } from "./cost.ts";
export { assertSchemaSupported, SchemaUnsupportedError, toProviderSchema } from "./schema.ts";
export { type SchemaIssue, validateAgainstSchema } from "./validate.ts";
export { type EnvReader, PROVIDER_API_KEY_ENV, type ProviderApiKey, resolveProviderApiKey, resolveSecret, type SecretValue } from "./secrets.ts";
export { DEFAULT_RETRY_TIMING, MAX_TRANSPORT_ATTEMPTS, type RetryTiming } from "./retry.ts";
export { messageFor } from "./errors.ts";
