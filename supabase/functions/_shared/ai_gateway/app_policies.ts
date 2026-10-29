// G6 runtime candidate (2026-10-19, G6-02): which AI features each app may have, and how a feature becomes a
// gateway FeaturePolicy. Three owners meet here, and nothing is enabled unless all three agree:
//   1. G6 (this file): the catalog — the app's features, who may call them, which providers may receive their data,
//      which service entitlements could open them (the AI plan rule), the hard caps. Miseiro has no feature yet.
//   2. The operator (config, at startup): per feature, enabled or not, the policy revision, provider / model / effort
//      and the numeric limits, and which of the catalog's entitlements open it. Nothing here invents a price, a plan
//      or a production amount: a feature without explicit config stays disabled.
//   3. The app (content): the instructions, the output schema and the mandatory output check.
// The result is a registry built by definePolicyRegistry (startup checks, frozen) plus the plan allowlist the
// authority port enforces. NOT deployed; not wired into any app.
import { findModelSpec } from "../ai_provider/mod.ts";
import type { AiReasoningEffort, JsonSchema } from "../ai_provider/mod.ts";
import { type AppId, type FeaturePolicy, policyKey, type PolicyRegistry } from "./gateway.ts";
import { definePolicyRegistry, MAX_COST_USD_PER_OPERATION } from "./policy_registry.ts";

export type Provider = "openai" | "anthropic";

export type AppFeatureDeclaration = Readonly<{
  app: AppId;
  feature: string;
  ledgerFeature: string;
  logicalRole: string;
  subjectKinds: readonly ("system" | "user")[];
  brandRequired: boolean;
  /** Providers that may receive this feature's input (a privacy decision, not a quality one). */
  allowedProviders: readonly Provider[];
  /** Entitlements ("<app>:<service>") that could open the feature for a person; empty = no person may use it. */
  knownEntitlements: readonly string[];
  /** Why the default is what it is; shown in the disabled list. */
  note: string;
}>;

/**
 * The catalog (G6). Grounded in what exists today:
 * - kabumori:market_report: system work only (the live close / morning report runs on Claude through its own
 *   primary path; this entry lets the gateway carry the same kind of job). No person, no entitlement.
 * - postona:consult and postona:post_generation: a person's text about their brand. Only OpenAI may receive it:
 *   sending personal data to Anthropic still waits for the formal rule change and the privacy notice. Only the
 *   x_autopost service is known; which AI plan opens which feature is NOT decided, so the default is disabled.
 * - miseiro: nothing approved, nothing declared: every call is POLICY_MISSING.
 */
export const APP_FEATURE_CATALOG: readonly AppFeatureDeclaration[] = Object.freeze([
  Object.freeze({
    app: "kabumori",
    feature: "market_report",
    ledgerFeature: "market_report",
    logicalRole: "kabumori.market_report.gateway",
    subjectKinds: Object.freeze(["system"] as const),
    brandRequired: false,
    allowedProviders: Object.freeze(["anthropic", "openai"] as const),
    knownEntitlements: Object.freeze([]),
    note: "system job only",
  }),
  Object.freeze({
    app: "postona",
    feature: "consult",
    ledgerFeature: "consult",
    logicalRole: "postona.consult.reply",
    subjectKinds: Object.freeze(["user"] as const),
    brandRequired: true,
    allowedProviders: Object.freeze(["openai"] as const),
    knownEntitlements: Object.freeze(["postona:x_autopost"]),
    note: "AI plan for consult not decided; personal data to OpenAI only",
  }),
  Object.freeze({
    app: "postona",
    feature: "post_generation",
    ledgerFeature: "post_generation",
    logicalRole: "postona.post.generate",
    subjectKinds: Object.freeze(["user"] as const),
    brandRequired: true,
    allowedProviders: Object.freeze(["openai"] as const),
    knownEntitlements: Object.freeze(["postona:x_autopost"]),
    note: "AI plan for post generation not decided; personal data to OpenAI only",
  }),
] satisfies AppFeatureDeclaration[]);

/** Operator settings for one feature (config). Every field is required to enable it. */
export type FeatureConfig = Readonly<{
  enabled: boolean;
  revision: string;
  provider: Provider;
  model: string;
  reasoningEffort: AiReasoningEffort;
  maxOutputTokens: number;
  timeoutMs: number;
  maxAttempts: 1 | 2 | 3;
  maxCostUsdPerOperation: number;
  maxInputBytes: number;
  /** For a feature a person can call: which of the catalog's knownEntitlements open it (none = disabled). */
  entitlements: readonly string[];
}>;

/** App-owned content for one feature. */
export type FeatureContent = Readonly<{
  systemInstructions: string;
  schema: Readonly<{ name: string; schema: JsonSchema }>;
  validate: (payload: unknown) => boolean;
}>;

export type DisabledFeature = Readonly<{ key: string; reason: string }>;

export type AppPolicySet = Readonly<{
  registry: PolicyRegistry;
  /** app:feature -> the entitlements that open it for a person (system-only features map to []). */
  planAllowlist: ReadonlyMap<string, readonly string[]>;
  /** Every catalog feature that is NOT enabled, with the reason (startup report; nothing here is callable). */
  disabled: readonly DisabledFeature[];
}>;

export class AppPolicyConfigError extends Error {
  constructor(key: string, reason: string) {
    super(`AI_GATEWAY_APP_POLICY_CONFIG:${key}:${reason}`);
  }
}

const CONFIG_KEYS = "enabled,entitlements,maxAttempts,maxCostUsdPerOperation,maxInputBytes,maxOutputTokens,model,provider,reasoningEffort,revision,timeoutMs";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Build the registry from the catalog, the operator config and the apps' content. Config for a feature the catalog
 * does not declare (a typo, a Miseiro feature) is a startup error, so nothing can be enabled by accident; a declared
 * feature without complete config / content, with a provider its data may not go to, or (for people) without an
 * allowed entitlement stays disabled and is listed. Policies that pass go through definePolicyRegistry's checks.
 */
export function buildAppPolicySet(
  config: Readonly<Record<string, unknown>>,
  content: Readonly<Record<string, FeatureContent | undefined>>,
  catalog: readonly AppFeatureDeclaration[] = APP_FEATURE_CATALOG,
): AppPolicySet {
  const declared = new Map(catalog.map((d) => [policyKey(d.app, d.feature), d]));
  for (const key of [...Object.keys(config), ...Object.keys(content)]) {
    if (!declared.has(key)) throw new AppPolicyConfigError(key, "not_in_catalog");
  }
  const policies: FeaturePolicy[] = [];
  const planAllowlist = new Map<string, readonly string[]>();
  const disabled: DisabledFeature[] = [];
  for (const [key, d] of declared) {
    const c = config[key];
    const body = content[key];
    const off = (reason: string) => disabled.push(Object.freeze({ key, reason }));
    if (c === undefined) {
      off(`no_config (${d.note})`);
      continue;
    }
    if (!isRecord(c) || Object.keys(c).sort().join(",") !== CONFIG_KEYS) throw new AppPolicyConfigError(key, "config_shape");
    const cfg = c as unknown as FeatureConfig;
    if (cfg.enabled !== true) {
      off("disabled_by_config");
      continue;
    }
    if (!body || typeof body.validate !== "function") {
      off("no_app_content");
      continue;
    }
    if (!d.allowedProviders.includes(cfg.provider)) {
      off(`provider_not_allowed_for_this_data:${cfg.provider}`);
      continue;
    }
    const spec = findModelSpec(cfg.model);
    if (!spec || spec.provider !== cfg.provider) throw new AppPolicyConfigError(key, "model");
    if (!(cfg.maxCostUsdPerOperation <= MAX_COST_USD_PER_OPERATION)) throw new AppPolicyConfigError(key, "max_cost");
    const ents = Array.isArray(cfg.entitlements) ? cfg.entitlements : null;
    if (!ents || ents.some((e) => typeof e !== "string" || !d.knownEntitlements.includes(e)) || new Set(ents).size !== ents.length) {
      throw new AppPolicyConfigError(key, "entitlements");
    }
    if (d.subjectKinds.includes("user") && ents.length === 0) {
      off("no_plan_entitlement");
      continue;
    }
    if (!d.subjectKinds.includes("user") && ents.length > 0) throw new AppPolicyConfigError(key, "entitlements_on_system_feature");
    policies.push({
      app: d.app,
      feature: d.feature,
      revision: cfg.revision,
      ledgerFeature: d.ledgerFeature,
      logicalRole: d.logicalRole,
      provider: cfg.provider,
      model: cfg.model,
      reasoningEffort: cfg.reasoningEffort,
      maxOutputTokens: cfg.maxOutputTokens,
      timeoutMs: cfg.timeoutMs,
      maxAttempts: cfg.maxAttempts,
      maxCostUsdPerOperation: cfg.maxCostUsdPerOperation,
      maxInputBytes: cfg.maxInputBytes,
      subjectKinds: d.subjectKinds,
      brandRequired: d.brandRequired,
      systemInstructions: body.systemInstructions,
      schema: body.schema,
      validate: body.validate,
    });
    planAllowlist.set(key, Object.freeze([...ents].sort()));
  }
  // definePolicyRegistry re-checks every enabled policy (revision, model, caps, worst-case cost, schema, ...).
  const registry = definePolicyRegistry(policies);
  return Object.freeze({ registry, planAllowlist, disabled: Object.freeze(disabled) });
}
