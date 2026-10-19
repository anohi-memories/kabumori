// G6 runtime candidate (2026-10-19, G6-01): the feature policy registry the runtime accepts. Each app defines its
// policies; this checks them ONCE, at startup, so a misconfigured policy fails before any request instead of after a
// paid send (for example a cost bound the call store cannot record). The gateway still re-checks every call.
import { assertSchemaSupported, findModelSpec, upperBoundAttemptCostUsd } from "../functions/_shared/ai_provider/mod.ts";
import type { AiRequest } from "../functions/_shared/ai_provider/mod.ts";
import { type AppId, type FeaturePolicy, policyKey, type PolicyRegistry } from "./gateway.ts";

const APPS: readonly AppId[] = ["kabumori", "postona", "miseiro"];
const FEATURE = /^[a-z][a-z0-9_.]{1,63}$/u;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;
/** ai_calls.audit_ok accepts an operation's estimatedCostUsd up to 1 USD; a larger bound could not be recorded. */
export const MAX_COST_USD_PER_OPERATION = 1;
const MAX_INPUT_BYTES = 200_000;

export class PolicyRegistryError extends Error {
  constructor(key: string, reason: string) {
    super(`AI_GATEWAY_POLICY_INVALID:${key}:${reason}`);
  }
}

const registries = new WeakSet<object>();

/** True only for a registry built (and frozen) by definePolicyRegistry. */
export function isDefinedRegistry(value: unknown): value is PolicyRegistry {
  return typeof value === "object" && value !== null && registries.has(value);
}

function problem(p: FeaturePolicy): string | null {
  if (!APPS.includes(p.app)) return "app";
  if (typeof p.feature !== "string" || !FEATURE.test(p.feature)) return "feature";
  if (!IDENTIFIER.test(policyKey(p.app, p.feature))) return "store_feature";
  if (typeof p.revision !== "string" || !REVISION.test(p.revision)) return "revision";
  if (typeof p.logicalRole !== "string" || !IDENTIFIER.test(p.logicalRole)) return "logical_role";
  if (typeof p.ledgerFeature !== "string" || !IDENTIFIER.test(p.ledgerFeature)) return "ledger_feature";
  const spec = findModelSpec(p.model);
  if (!spec || spec.provider !== p.provider) return "model";
  if (!spec.reasoningEfforts.includes(p.reasoningEffort)) return "reasoning_effort";
  if (!Number.isInteger(p.maxOutputTokens) || p.maxOutputTokens < 1 || p.maxOutputTokens > spec.maxOutputTokens) return "max_output_tokens";
  if (!Number.isInteger(p.timeoutMs) || p.timeoutMs < 1_000 || p.timeoutMs > 600_000) return "timeout";
  if (p.maxAttempts !== 1 && p.maxAttempts !== 2 && p.maxAttempts !== 3) return "max_attempts";
  if (!Number.isInteger(p.maxInputBytes) || p.maxInputBytes < 1 || p.maxInputBytes > MAX_INPUT_BYTES) return "max_input_bytes";
  if (!Array.isArray(p.subjectKinds) || p.subjectKinds.length === 0 || new Set(p.subjectKinds).size !== p.subjectKinds.length ||
    !p.subjectKinds.every((k) => k === "system" || k === "user")) return "subject_kinds";
  if (typeof p.brandRequired !== "boolean" || (p.brandRequired && !p.subjectKinds.includes("user"))) return "brand_required";
  if (typeof p.systemInstructions !== "string" || p.systemInstructions.trim() === "") return "system_instructions";
  if (typeof p.validate !== "function") return "validate";
  if (!p.schema || typeof p.schema.name !== "string") return "schema";
  try {
    assertSchemaSupported(p.schema.schema);
  } catch {
    return "schema";
  }
  if (!Number.isFinite(p.maxCostUsdPerOperation) || p.maxCostUsdPerOperation <= 0 || p.maxCostUsdPerOperation > MAX_COST_USD_PER_OPERATION) {
    return "max_cost";
  }
  // The worst case the gateway can meet: the largest input the policy accepts, every attempt.
  const worst: AiRequest = {
    logicalRole: p.logicalRole,
    provider: p.provider,
    model: p.model,
    systemInstructions: p.systemInstructions,
    userContent: "x".repeat(p.maxInputBytes),
    jsonSchema: p.schema,
    reasoningEffort: p.reasoningEffort,
    maxOutputTokens: p.maxOutputTokens,
    timeoutMs: p.timeoutMs,
    transport: { maxAttempts: p.maxAttempts },
    usageContext: { application: p.app, feature: p.ledgerFeature },
  };
  if (!(upperBoundAttemptCostUsd(spec, worst) * p.maxAttempts <= p.maxCostUsdPerOperation)) return "cost_bound";
  return null;
}

/**
 * The registry of every app's feature policies. Refuses a duplicate app:feature, and any policy the gateway, the
 * ledger or the call store would refuse later. The result is frozen; only registries made here are accepted by
 * createAiGateway.
 */
export function definePolicyRegistry(policies: readonly FeaturePolicy[]): PolicyRegistry {
  const map = new Map<string, FeaturePolicy>();
  for (const raw of policies) {
    const p = Object.freeze({ ...raw, subjectKinds: Object.freeze([...(raw.subjectKinds ?? [])]) }) as FeaturePolicy;
    const key = typeof p.app === "string" && typeof p.feature === "string" ? policyKey(p.app, p.feature) : "?";
    if (map.has(key)) throw new PolicyRegistryError(key, "duplicate");
    const reason = problem(p);
    if (reason) throw new PolicyRegistryError(key, reason);
    map.set(key, p);
  }
  const registry: PolicyRegistry = Object.freeze({
    get: (key: string) => map.get(key),
    has: (key: string) => map.has(key),
    get size() {
      return map.size;
    },
    keys: () => map.keys(),
    values: () => map.values(),
    entries: () => map.entries(),
    forEach: (fn: (value: FeaturePolicy, key: string, m: ReadonlyMap<string, FeaturePolicy>) => void) => map.forEach((v, k) => fn(v, k, registry)),
    [Symbol.iterator]: () => map[Symbol.iterator](),
  });
  registries.add(registry);
  return registry;
}
