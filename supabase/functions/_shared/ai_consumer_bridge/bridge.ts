import {
  type AiReasoningEffort,
  type AiSubject,
  assertSchemaSupported,
  type BudgetGuard,
  defineAnthropicModelPolicies,
  executeWithModelPolicy,
  findModelSpec,
  type ModelPolicyRegistry,
  modelPolicyRequest,
  resolveModelChoice,
  upperBoundAttemptCostUsd,
  validateAgainstSchema,
  validateAiRequest,
} from "../ai_provider/mod.ts";
import type {
  Audit,
  AuthorizedConsumer,
  BridgeCode,
  BridgeResult,
  CallIdentity,
  ConsumerDeps,
  ConsumerFeature,
  ConsumerRequest,
} from "./types.ts";
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const codes = new Set([
  "REQUEST_INVALID",
  "FEATURE_DENIED",
  "AUTHORITY_DENIED",
  "POLICY_DENIED",
  "COST_DENIED",
  "BUDGET_DENIED",
  "OUTPUT_REJECTED",
  "MODEL_UNAVAILABLE",
  "PROVIDER_FAILED",
  "UNKNOWN",
  "IN_PROGRESS",
  "CONTENT_DRIFT",
]);
const ownKeys = (v: object, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.freeze(v);
    for (const value of Object.values(v)) freeze(value);
  }
  return v;
}
async function digest(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function subjectOf(
  a: AuthorizedConsumer | null,
  now: number,
): AiSubject | null {
  if (
    !a || !Number.isFinite(a.expiresAtMs) || a.expiresAtMs <= now ||
    !plain(a.subject)
  ) return null;
  const s = a.subject;
  if (s.kind === "system" && ownKeys(s, ["kind"])) {
    return Object.freeze({ kind: "system" });
  }
  if (
    s.kind === "user" && ownKeys(s, ["kind", "userId", "brandId"]) &&
    typeof s.userId === "string" && uuid.test(s.userId) &&
    (s.brandId === undefined || s.brandId === null ||
      typeof s.brandId === "string" && uuid.test(s.brandId))
  ) {
    return Object.freeze({
      kind: "user",
      userId: s.userId.toLowerCase(),
      brandId: typeof s.brandId === "string" ? s.brandId.toLowerCase() : null,
    });
  }
  return null;
}
/** Unwired server library. No env/native fetch, HTTP router, DB mutation or feature activation. */
export function createConsumerBridge(
  version: string,
  features: readonly ConsumerFeature[],
  deps: ConsumerDeps,
) {
  let registry: ModelPolicyRegistry;
  const byId = new Map<string, ConsumerFeature>();
  try {
    if (
      typeof deps.authorize !== "function" ||
      typeof deps.store?.claim !== "function" ||
      typeof deps.store?.complete !== "function" ||
      typeof deps.provider?.fetch !== "function" ||
      typeof deps.provider.readEnv !== "function" ||
      ["reserve", "markSent", "settle", "release"].some((k) =>
        typeof (deps.provider.budget as unknown as Record<string, unknown>)
          ?.[k] !== "function"
      )
    ) throw new Error();
    for (const f of features) {
      if (
        !f || !identifier.test(f.id) || byId.has(f.id) ||
        !identifier.test(f.revision) || typeof f.validateFacts !== "function" ||
        typeof f.systemInstructions !== "string" ||
        !f.systemInstructions.trim() || f.systemInstructions.length > 16384 ||
        !Number.isInteger(f.maxInputBytes) || f.maxInputBytes < 1 ||
        f.maxInputBytes > 65536 ||
        !Number.isInteger(f.maxResultBytes) || f.maxResultBytes < 1 ||
        f.maxResultBytes > 65536 ||
        !Number.isFinite(f.maxTotalCostUsd) || f.maxTotalCostUsd <= 0 ||
        f.maxTotalCostUsd > 1 ||
        !Number.isInteger(f.deadlineMs) || f.deadlineMs < 1000 ||
        f.deadlineMs > 60000
      ) throw new Error();
      assertSchemaSupported(f.schema.schema);
      byId.set(
        f.id,
        Object.freeze({
          ...f,
          policy: freeze(clone(f.policy)),
          schema: freeze(clone(f.schema)),
        }),
      );
    }
    registry = defineAnthropicModelPolicies(
      version,
      [...byId.values()].map((f) => f.policy),
    );
  } catch {
    throw new Error("CONSUMER_BRIDGE_CONFIG_INVALID");
  }
  const now = deps.nowMs ?? Date.now;
  return Object.freeze({
    async execute(credential: unknown, body: unknown): Promise<BridgeResult> {
      let audit: Audit | null = null,
        identity: CallIdentity | undefined,
        owner: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ctl = new AbortController();
      let stopped = false;
      const fail = (code: BridgeCode): BridgeResult => ({
        ok: false,
        code,
        audit,
      });
      const observe = (r: BridgeResult) => {
        const immutable = freeze(clone(r));
        try {
          deps.audit?.(
            Object.freeze({
              code: immutable.ok ? "OK" : immutable.code,
              audit: immutable.audit,
            }),
          );
        } catch { /*no logging/raw hook error*/ }
        return immutable;
      };
      try {
        if (
          !plain(body) ||
          !ownKeys(body, ["feature", "operationId", "input", "selection"]) ||
          typeof body.feature !== "string" ||
          typeof body.operationId !== "string" ||
          !identifier.test(body.operationId) ||
          typeof body.input !== "string" || !body.input.trim()
        ) return observe(fail("REQUEST_INVALID"));
        const f = byId.get(body.feature);
        if (!f) return observe(fail("FEATURE_DENIED"));
        if (
          body.input.length > f.maxInputBytes ||
          new TextEncoder().encode(body.input).length > f.maxInputBytes
        ) return observe(fail("REQUEST_INVALID"));
        const selection = body.selection;
        if (
          selection !== undefined &&
          (!plain(selection) ||
            !ownKeys(selection, ["model", "effort", "maxOutputTokens"]) ||
            selection.model !== undefined &&
              typeof selection.model !== "string" ||
            selection.effort !== undefined &&
              typeof selection.effort !== "string" ||
            selection.maxOutputTokens !== undefined &&
              typeof selection.maxOutputTokens !== "number")
        ) return observe(fail("REQUEST_INVALID"));
        const request = freeze(clone(body)) as ConsumerRequest;
        const started = now();
        if (!Number.isFinite(started)) return observe(fail("UNKNOWN"));
        const deadline = started + f.deadlineMs;
        const end = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            stopped = true;
            ctl.abort();
            reject(new Error("DEADLINE"));
          }, f.deadlineMs);
        });
        const bounded = <T>(p: Promise<T>) => Promise.race([p, end]);
        const authority = await bounded(deps.authorize(credential, f.id));
        const subject = subjectOf(authority, now());
        if (!subject) return observe(fail("AUTHORITY_DENIED"));
        const validUntil = authority!.expiresAtMs;
        const active = () =>
          !stopped && Number.isFinite(now()) && now() < deadline &&
          validUntil > now();
        const resolved = resolveModelChoice(registry, {
          role: f.policy.role,
          model: request.selection?.model,
          effort: request.selection?.effort as AiReasoningEffort | undefined,
          maxOutputTokens: request.selection?.maxOutputTokens,
        });
        if (!resolved.ok) return observe(fail("POLICY_DENIED"));
        const choice = resolved.choice;
        const tenantTag = await digest(
          JSON.stringify([choice.policy.application, subject]),
        );
        const callId = "h5m2_" +
          await digest(JSON.stringify([tenantTag, f.id, request.operationId]));
        const call = {
          role: choice.role,
          model: choice.model,
          effort: choice.effort,
          maxOutputTokens: choice.maxOutputTokens,
          systemInstructions: f.systemInstructions,
          userContent: request.input,
          jsonSchema: f.schema,
          subject,
          callId,
        };
        const providerRequest = modelPolicyRequest(choice, call);
        if ("code" in validateAiRequest(providerRequest)) {
          return observe(fail("POLICY_DENIED"));
        }
        const upper = upperBoundAttemptCostUsd(
          findModelSpec(choice.model)!,
          providerRequest,
        );
        if (
          !Number.isFinite(upper) ||
          upper * choice.policy.maxTransportAttempts > f.maxTotalCostUsd
        ) return observe(fail("COST_DENIED"));
        const fingerprint = await digest(
          JSON.stringify([
            version,
            f.revision,
            choice.policy,
            choice.model,
            choice.effort,
            choice.maxOutputTokens,
            f.maxInputBytes,
            f.maxResultBytes,
            f.maxTotalCostUsd,
            f.deadlineMs,
            f.systemInstructions,
            f.schema,
            request.input,
          ]),
        );
        audit = {
          callId,
          tenantTag,
          feature: f.id,
          role: choice.role,
          model: choice.model,
          policyVersion: version,
          attempts: 0,
          estimatedCostUsd: 0,
          costBasis: "no_request",
        };
        identity = Object.freeze({ key: callId, tenantTag, fingerprint });
        const claim = await bounded(deps.store.claim(identity));
        if (claim.kind === "conflict") return observe(fail("CONTENT_DRIFT"));
        if (claim.kind === "busy") return observe(fail("IN_PROGRESS"));
        if (claim.kind === "complete") {
          const r = clone(claim.result);
          if (
            !plain(r) || ![true, false].includes(r.ok) ||
            !ownKeys(
              r,
              r.ok ? ["ok", "data", "audit"] : ["ok", "code", "audit"],
            ) ||
            (!r.ok && !codes.has(r.code)) || !plain(r.audit) ||
            !ownKeys(r.audit, [
              "callId",
              "tenantTag",
              "feature",
              "role",
              "model",
              "policyVersion",
              "attempts",
              "estimatedCostUsd",
              "costBasis",
            ]) ||
            !Number.isInteger(r.audit.attempts) || r.audit.attempts < 0 ||
            r.audit.attempts > choice.policy.maxTransportAttempts ||
            !Number.isFinite(r.audit.estimatedCostUsd) ||
            r.audit.estimatedCostUsd < 0 ||
            r.audit.estimatedCostUsd > f.maxTotalCostUsd ||
            !["measured", "includes_upper_bound", "no_request"].includes(
              r.audit.costBasis,
            ) || r.audit.role !== choice.role ||
            claim.fingerprint !== fingerprint || r.audit?.callId !== callId ||
            r.audit.tenantTag !== tenantTag || r.audit.feature !== f.id ||
            r.audit.model !== choice.model || r.audit.policyVersion !== version
          ) return observe(fail("UNKNOWN"));
          if (
            r.ok &&
            (new TextEncoder().encode(JSON.stringify(r.data)).length >
                f.maxResultBytes ||
              validateAgainstSchema(r.data, f.schema.schema).length !== 0 ||
              await bounded(
                  Promise.resolve(
                    f.validateFacts(freeze(clone(r.data)), request.input),
                  ),
                ) !== true)
          ) return observe(fail("OUTPUT_REJECTED"));
          if (!active()) return observe(fail("AUTHORITY_DENIED"));
          return observe(r);
        }
        if (
          claim.kind !== "acquired" || typeof claim.owner !== "string" ||
          !identifier.test(claim.owner)
        ) return observe(fail("UNKNOWN"));
        owner = claim.owner;
        const base = deps.provider.budget;
        let networkAttempts = 0;
        const budget: BudgetGuard = {
          reserve: async (c, cost) => {
            if (
              !active() || c.callId !== callId ||
              c.logicalRole !== choice.role || c.model !== choice.model ||
              c.application !== choice.policy.application ||
              c.feature !== choice.policy.feature ||
              JSON.stringify(c.subject) !== JSON.stringify(subject) ||
              !Number.isFinite(cost) || cost < 0 || cost > upper + 1e-9
            ) {
              return {
                allowed: false,
                reason: "GUARD_UNAVAILABLE",
                limitId: null,
              };
            }
            return await bounded(base.reserve(c, cost));
          },
          markSent: async (r) => {
            if (!active()) throw new Error("STOPPED");
            await bounded(base.markSent!(r));
            if (!active()) throw new Error("STOPPED");
          },
          // Late provider accounting must settle to the ledger even when bridge output deadline is unknown.
          settle: (r, c, s) => base.settle(r, c, s),
          release: (r) => base.release!(r),
        };
        const outcome = await bounded(
          executeWithModelPolicy(registry, call, {
            ...deps.provider,
            budget,
            nowMs: now,
            deadlineAtMs: deadline,
            onAttempt: undefined,
            fetch: async (url, init) => {
              if (!active()) throw new Error("STOPPED");
              networkAttempts++;
              audit = {
                ...audit!,
                attempts: networkAttempts,
                estimatedCostUsd: upper * networkAttempts,
                costBasis: "includes_upper_bound",
              };
              return await deps.provider.fetch(url, {
                ...init,
                signal: AbortSignal.any([
                  ctl.signal,
                  ...(init?.signal ? [init.signal] : []),
                ]),
              });
            },
          }),
        );
        let result: BridgeResult;
        if (outcome.kind === "refused") {
          result = fail(
            outcome.code === "COST_CAP_EXCEEDED"
              ? "COST_DENIED"
              : "POLICY_DENIED",
          );
        } else {
          const r = outcome.result;
          audit = {
            ...audit,
            attempts: r.transportAttempts,
            estimatedCostUsd: r.estimatedCostUsd,
            costBasis: r.costBasis,
          };
          if (
            !active() || !Number.isFinite(r.estimatedCostUsd) ||
            r.estimatedCostUsd < 0 ||
            r.estimatedCostUsd > f.maxTotalCostUsd + 1e-9
          ) result = fail("UNKNOWN");
          else if (!r.ok) {
            result = fail(
              outcome.modelUnavailable
                ? "MODEL_UNAVAILABLE"
                : r.errorCode === "BUDGET_DENIED"
                ? "BUDGET_DENIED"
                : r.costBasis === "includes_upper_bound"
                ? "UNKNOWN"
                : "PROVIDER_FAILED",
            );
          } else if (
            new TextEncoder().encode(JSON.stringify(r.parsedPayload)).length >
              f.maxResultBytes ||
            validateAgainstSchema(r.parsedPayload, f.schema.schema).length !==
              0 ||
            await bounded(
                Promise.resolve(
                  f.validateFacts(
                    freeze(clone(r.parsedPayload)),
                    request.input,
                  ),
                ),
              ) !== true
          ) result = fail("OUTPUT_REJECTED");
          else result = { ok: true, data: clone(r.parsedPayload), audit };
        }
        if (!active()) return observe(fail("UNKNOWN"));
        // A successful response is usable only AFTER the durable application claim records the validated outcome.
        await bounded(
          deps.store.complete(identity, owner, freeze(clone(result))),
        );
        if (!active()) return observe(fail("UNKNOWN"));
        return observe(result);
      } catch {
        return observe(fail("UNKNOWN"));
      } finally {
        stopped = true;
        ctl.abort();
        if (timer) clearTimeout(timer);
      }
    },
  });
}
