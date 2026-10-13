// F6 M1 (2026-10-13): which Claude model a use case may call. Contract: docs/ai-provider/F6_M1_ANTHROPIC_MULTIMODEL.md.
//
// A model policy binds one logical role (one use case, e.g. "kabumori.news.summary") to:
//   - the Anthropic models it may use (catalog ids or versioned aliases) and the one it uses by default;
//   - the effort levels it may use and its default; an output-token cap; a per-attempt timeout; a transport attempt cap;
//   - optionally a per-call cost ceiling checked locally, before anything is reserved or sent;
//   - the usage context (application / feature) its spend is attributed to.
// A caller may only NARROW a policy per call (pick another allowed model, an allowed effort, a smaller output cap);
// anything else is refused before any request (ROLE_UNKNOWN, MODEL_NOT_ALLOWED, EFFORT_NOT_ALLOWED, ...).
//
// The call itself goes through executeAiRequest unchanged: the same key (ANTHROPIC_API_KEY via the injected reader),
// the same budget ledger (reserve -> mark_sent -> settle, keyed by callId + attempt), the same validation, timeout,
// retry and cost rules. The role is the request's logicalRole, so every attempt is recorded and priced per role and
// model. There is NO automatic fallback to another model or provider: a model the API does not serve (404
// not_found_error) is reported as MODEL_UNAVAILABLE and nothing else is tried.
//
// This module does not change the live market report (market_report_primary.ts keeps its own env-driven model).

import { upperBoundAttemptCostUsd } from "./cost.ts";
import { executeAiRequest, type ExecuteDeps } from "./execute.ts";
import { findModelSpec, type ModelSpec, resolveModelName } from "./model_catalog.ts";
import { MAX_TRANSPORT_ATTEMPTS } from "./retry.ts";
import type { AiReasoningEffort, AiRequest, AiResult, AiSubject, AiUsageKey, JsonSchema } from "./types.ts";

export const MODEL_POLICY_PROVIDER = "anthropic";

export type AnthropicModelPolicy = {
  /** The logical role (one use case). Also the ledger's logical_role and the cost attribution key. */
  readonly role: string;
  readonly application: string;
  readonly feature: string;
  /** Catalog ids or versioned aliases; at least one. */
  readonly allowedModels: readonly string[];
  /** Must be one of allowedModels (after alias resolution). */
  readonly defaultModel: string;
  readonly allowedEfforts: readonly AiReasoningEffort[];
  readonly defaultEffort: AiReasoningEffort;
  /** Cap on max_tokens (thinking counts against it); at most every allowed model's catalog maximum. */
  readonly maxOutputTokens: number;
  /** Per HTTP attempt. */
  readonly timeoutMs: number;
  /** 1..3; transient failures only, within the deadline; timeouts are never retried. */
  readonly maxTransportAttempts: number;
  /** Optional local ceiling on one attempt's upper-bound cost (USD); above it nothing is reserved or sent. */
  readonly maxUpperBoundUsdPerAttempt?: number;
};

export type ResolvedModelPolicy = Readonly<Omit<AnthropicModelPolicy, "allowedModels" | "defaultModel">> & {
  readonly allowedModels: readonly string[];
  readonly defaultModel: string;
};

export class ModelPolicyError extends Error {
  constructor(readonly role: string, readonly reason: string) {
    super(`MODEL_POLICY_INVALID:${role}:${reason}`);
  }
}

export type ModelPolicyRegistry = {
  readonly version: string;
  get(role: string): ResolvedModelPolicy | undefined;
  roles(): readonly string[];
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/u;

function anthropicSpec(name: string): ModelSpec | undefined {
  const id = resolveModelName(name);
  const spec = id === undefined ? undefined : findModelSpec(id);
  return spec && spec.provider === MODEL_POLICY_PROVIDER ? spec : undefined;
}

/**
 * Validates and freezes a set of policies. A wrong policy is a programming error: it throws (ModelPolicyError) when
 * the registry is built, never at call time.
 */
export function defineAnthropicModelPolicies(version: string, policies: readonly AnthropicModelPolicy[]): ModelPolicyRegistry {
  if (typeof version !== "string" || !VERSION.test(version)) throw new ModelPolicyError("-", "version");
  const byRole = new Map<string, ResolvedModelPolicy>();
  for (const policy of policies) {
    const role = policy?.role;
    if (typeof role !== "string" || !IDENTIFIER.test(role)) throw new ModelPolicyError(String(role), "role");
    if (byRole.has(role)) throw new ModelPolicyError(role, "duplicate_role");
    if (!IDENTIFIER.test(policy.application) || !IDENTIFIER.test(policy.feature)) throw new ModelPolicyError(role, "usage_context");
    if (!Array.isArray(policy.allowedModels) || policy.allowedModels.length === 0) throw new ModelPolicyError(role, "allowed_models");
    const allowed: string[] = [];
    for (const name of policy.allowedModels) {
      const spec = anthropicSpec(name);
      if (!spec) throw new ModelPolicyError(role, `model_not_anthropic_catalog:${name}`);
      if (!allowed.includes(spec.id)) allowed.push(spec.id);
    }
    const defaultSpec = anthropicSpec(policy.defaultModel);
    if (!defaultSpec || !allowed.includes(defaultSpec.id)) throw new ModelPolicyError(role, "default_model_not_allowed");
    if (!Array.isArray(policy.allowedEfforts) || policy.allowedEfforts.length === 0) throw new ModelPolicyError(role, "allowed_efforts");
    if (!policy.allowedEfforts.includes(policy.defaultEffort)) throw new ModelPolicyError(role, "default_effort_not_allowed");
    for (const id of allowed) {
      const spec = findModelSpec(id)!;
      for (const effort of policy.allowedEfforts) {
        if (!spec.reasoningEfforts.includes(effort)) throw new ModelPolicyError(role, `effort_unsupported:${id}:${effort}`);
      }
      if (!Number.isInteger(policy.maxOutputTokens) || policy.maxOutputTokens < 1 || policy.maxOutputTokens > spec.maxOutputTokens) {
        throw new ModelPolicyError(role, `max_output_tokens:${id}`);
      }
    }
    if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 1_000 || policy.timeoutMs > 600_000) throw new ModelPolicyError(role, "timeout_ms");
    if (!Number.isInteger(policy.maxTransportAttempts) || policy.maxTransportAttempts < 1 || policy.maxTransportAttempts > MAX_TRANSPORT_ATTEMPTS) {
      throw new ModelPolicyError(role, "max_transport_attempts");
    }
    if (policy.maxUpperBoundUsdPerAttempt !== undefined &&
      !(Number.isFinite(policy.maxUpperBoundUsdPerAttempt) && policy.maxUpperBoundUsdPerAttempt > 0)) {
      throw new ModelPolicyError(role, "max_upper_bound_usd");
    }
    byRole.set(role, Object.freeze({
      ...policy,
      allowedModels: Object.freeze([...allowed]),
      defaultModel: defaultSpec.id,
      allowedEfforts: Object.freeze([...policy.allowedEfforts]),
    }));
  }
  const roles = Object.freeze([...byRole.keys()].sort());
  return Object.freeze({ version, get: (role: string) => byRole.get(role), roles: () => roles });
}

export type ModelPolicyDenial =
  | "ROLE_UNKNOWN"
  | "MODEL_UNKNOWN"
  | "MODEL_NOT_ALLOWED"
  | "EFFORT_NOT_ALLOWED"
  | "OUTPUT_CAP_EXCEEDED"
  | "COST_CAP_EXCEEDED";

export type ModelPolicySelection = {
  readonly role: string;
  /** A catalog id or versioned alias; default: the policy's defaultModel. */
  readonly model?: string;
  readonly effort?: AiReasoningEffort;
  /** At most the policy cap; default: the policy cap. */
  readonly maxOutputTokens?: number;
};

export type ResolvedModelChoice = {
  readonly role: string;
  readonly model: string;
  /** The alias the caller named, or null when it named the id (or took the default). */
  readonly requestedAs: string | null;
  readonly effort: AiReasoningEffort;
  readonly maxOutputTokens: number;
  readonly policy: ResolvedModelPolicy;
  readonly policyVersion: string;
};

/** Resolves a per-call selection against the role's policy; refuses anything the policy does not allow. */
export function resolveModelChoice(
  registry: ModelPolicyRegistry,
  selection: ModelPolicySelection,
): { readonly ok: true; readonly choice: ResolvedModelChoice } | { readonly ok: false; readonly code: ModelPolicyDenial; readonly detail: string } {
  const policy = typeof selection?.role === "string" ? registry.get(selection.role) : undefined;
  if (!policy) return { ok: false, code: "ROLE_UNKNOWN", detail: "role" };
  let model = policy.defaultModel;
  let requestedAs: string | null = null;
  if (selection.model !== undefined) {
    const id = resolveModelName(selection.model);
    if (id === undefined) return { ok: false, code: "MODEL_UNKNOWN", detail: "model" };
    if (!policy.allowedModels.includes(id)) return { ok: false, code: "MODEL_NOT_ALLOWED", detail: "model" };
    model = id;
    requestedAs = id === selection.model ? null : selection.model;
  }
  const effort = selection.effort ?? policy.defaultEffort;
  if (!policy.allowedEfforts.includes(effort)) return { ok: false, code: "EFFORT_NOT_ALLOWED", detail: "effort" };
  const maxOutputTokens = selection.maxOutputTokens ?? policy.maxOutputTokens;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > policy.maxOutputTokens) {
    return { ok: false, code: "OUTPUT_CAP_EXCEEDED", detail: "maxOutputTokens" };
  }
  return { ok: true, choice: { role: policy.role, model, requestedAs, effort, maxOutputTokens, policy, policyVersion: registry.version } };
}

export type ModelPolicyCall = ModelPolicySelection & {
  readonly systemInstructions: string;
  readonly userContent: string;
  readonly jsonSchema: { readonly name: string; readonly schema: JsonSchema };
  /** Default: system. A per-user call passes { kind: "user", userId, brandId? } (validated by executeAiRequest). */
  readonly subject?: AiSubject;
  /** Stable id for a call that may be repeated (idempotency in the ledger). */
  readonly callId?: string;
};

/** Spend attribution of one call: the ledger and usage key name the same role, model and feature. */
export type ModelPolicyAttribution = {
  readonly role: string;
  readonly model: string;
  readonly application: string;
  readonly feature: string;
  readonly month: string;
  readonly estimatedCostUsd: number;
  readonly costBasis: AiResult["costBasis"];
  readonly policyVersion: string;
};

export type ModelPolicyOutcome =
  | { readonly kind: "refused"; readonly code: ModelPolicyDenial; readonly detail: string; readonly sent: false }
  | {
    readonly kind: "executed";
    readonly result: AiResult;
    readonly choice: ResolvedModelChoice;
    readonly attribution: ModelPolicyAttribution;
    /** True when the API does not serve this model (404 not_found_error); nothing else was tried. */
    readonly modelUnavailable: boolean;
  };

/** Builds the provider request for a resolved choice (nothing is sent). */
export function modelPolicyRequest(choice: ResolvedModelChoice, call: ModelPolicyCall): AiRequest {
  return {
    logicalRole: choice.role,
    provider: MODEL_POLICY_PROVIDER,
    model: choice.model,
    systemInstructions: call.systemInstructions,
    userContent: call.userContent,
    jsonSchema: call.jsonSchema,
    reasoningEffort: choice.effort,
    maxOutputTokens: choice.maxOutputTokens,
    timeoutMs: choice.policy.timeoutMs,
    transport: { maxAttempts: choice.policy.maxTransportAttempts, retryOnTimeout: false },
    usageContext: { application: choice.policy.application, feature: choice.policy.feature, subject: call.subject ?? { kind: "system" } },
    ...(call.callId === undefined ? {} : { callId: call.callId }),
  };
}

function attributionOf(usageKey: AiUsageKey, result: AiResult, policyVersion: string): ModelPolicyAttribution {
  return {
    role: usageKey.logicalRole,
    model: usageKey.model,
    application: usageKey.application,
    feature: usageKey.feature,
    month: usageKey.month,
    estimatedCostUsd: result.estimatedCostUsd,
    costBasis: result.costBasis,
    policyVersion,
  };
}

/**
 * Resolves the role's policy, checks the optional per-attempt cost ceiling, then calls executeAiRequest with the
 * caller's deps (key reader, budget ledger, fetch, clock). Refusals happen before anything is reserved or sent.
 */
export async function executeWithModelPolicy(
  registry: ModelPolicyRegistry,
  call: ModelPolicyCall,
  deps: ExecuteDeps,
): Promise<ModelPolicyOutcome> {
  const resolved = resolveModelChoice(registry, call);
  if (!resolved.ok) return { kind: "refused", code: resolved.code, detail: resolved.detail, sent: false };
  const choice = resolved.choice;
  const request = modelPolicyRequest(choice, call);
  const ceiling = choice.policy.maxUpperBoundUsdPerAttempt;
  if (ceiling !== undefined && upperBoundAttemptCostUsd(findModelSpec(choice.model)!, request) > ceiling) {
    return { kind: "refused", code: "COST_CAP_EXCEEDED", detail: "maxUpperBoundUsdPerAttempt", sent: false };
  }
  const result = await executeAiRequest(request, deps);
  const modelUnavailable = !result.ok && result.httpStatus === 404 && result.detail === "not_found_error";
  return { kind: "executed", result, choice, attribution: attributionOf(result.usageKey, result, registry.version), modelUnavailable };
}
