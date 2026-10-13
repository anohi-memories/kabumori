// F6 M1: Claude multimodel routing through model policies. Fake provider (recordingFetch) and in-memory budget only:
// no network, no real key, no paid call.
//   deno test --no-config --allow-env --allow-read supabase/functions/_shared/ai_provider/model_policy_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { type BudgetCallContext, type BudgetDecision, InMemoryBudgetGuard } from "./budget.ts";
import { findModelSpec, listModelAliases, priceTierFor, resolveModelName } from "./model_catalog.ts";
import {
  type AnthropicModelPolicy,
  defineAnthropicModelPolicies,
  executeWithModelPolicy,
  type ModelPolicyCall,
  ModelPolicyError,
  type ModelPolicyOutcome,
  resolveModelChoice,
} from "./model_policy.ts";
import { anthropicBody, anthropicError, FAKE_ANTHROPIC_KEY, fakeEnv, hangUntilAborted, jsonResponse, recordingFetch, type Responder, testDeps } from "./test_support.ts";
import type { JsonSchema } from "./types.ts";

const SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "score"],
  properties: { label: { type: "string" }, score: { type: "number" } },
};
const PAYLOAD = { label: "ok", score: 0.5 };

const BASE: Omit<AnthropicModelPolicy, "role" | "allowedModels" | "defaultModel" | "allowedEfforts" | "defaultEffort"> = {
  application: "kabumori",
  feature: "test_feature",
  maxOutputTokens: 4_000,
  timeoutMs: 30_000,
  maxTransportAttempts: 1,
};

const POLICIES: AnthropicModelPolicy[] = [
  {
    ...BASE,
    role: "test.classify.haiku",
    allowedModels: ["anthropic.haiku@2026-10", "anthropic.sonnet@2026-10"],
    defaultModel: "anthropic.haiku@2026-10",
    allowedEfforts: ["low", "medium"],
    defaultEffort: "low",
    maxTransportAttempts: 2,
  },
  {
    ...BASE,
    role: "test.analysis.sonnet",
    allowedModels: ["claude-sonnet-5-5", "anthropic.opus@2026-10"],
    defaultModel: "claude-sonnet-5-5",
    allowedEfforts: ["medium", "high"],
    defaultEffort: "medium",
    maxOutputTokens: 16_000,
    timeoutMs: 90_000,
  },
  {
    ...BASE,
    role: "test.report.opus",
    allowedModels: ["anthropic.opus@2026-10"],
    defaultModel: "anthropic.opus@2026-10",
    allowedEfforts: ["medium", "high"],
    defaultEffort: "medium",
    maxOutputTokens: 16_000,
  },
  {
    ...BASE,
    role: "test.capped",
    allowedModels: ["anthropic.sonnet@2026-10"],
    defaultModel: "anthropic.sonnet@2026-10",
    allowedEfforts: ["low"],
    defaultEffort: "low",
    maxUpperBoundUsdPerAttempt: 0.0001,
  },
];
const REGISTRY = defineAnthropicModelPolicies("kabumori-model-policy/test-1", POLICIES);

const call = (role: string, extra: Partial<ModelPolicyCall> = {}): ModelPolicyCall => ({
  role,
  systemInstructions: "Classify the text.",
  userContent: "sample text",
  jsonSchema: { name: "classification", schema: SCHEMA },
  ...extra,
});

const ok: Responder = () => jsonResponse(200, anthropicBody(PAYLOAD));

/** An in-memory budget that also records what each reservation was for (callId, attempt, role). */
class RecordingGuard extends InMemoryBudgetGuard {
  readonly reserves: Array<{ callId: string | undefined; attempt: number | undefined; role: string }> = [];
  override reserve(context: BudgetCallContext, upperBoundUsd: number): Promise<BudgetDecision> {
    this.reserves.push({ callId: context.callId, attempt: context.attempt, role: context.logicalRole });
    return super.reserve(context, upperBoundUsd);
  }
}

function executed(outcome: ModelPolicyOutcome) {
  assert.equal(outcome.kind, "executed", JSON.stringify(outcome));
  return outcome as Extract<ModelPolicyOutcome, { kind: "executed" }>;
}

test("each role sends its default model (resolved from the versioned alias) with its effort, cap and timeout", async () => {
  for (const [role, model, effort, maxTokens] of [
    ["test.classify.haiku", "claude-haiku-5-5", "low", 4_000],
    ["test.analysis.sonnet", "claude-sonnet-5-5", "medium", 16_000],
    ["test.report.opus", "claude-opus-5-5", "medium", 16_000],
  ] as const) {
    const net = recordingFetch(ok);
    const { deps } = testDeps(net.fetch);
    const out = executed(await executeWithModelPolicy(REGISTRY, call(role), deps));
    assert.equal(out.result.ok, true, role);
    assert.equal(net.calls.length, 1);
    const body = net.calls[0].body as Record<string, unknown>;
    assert.equal(body.model, model, role);
    assert.equal(body.max_tokens, maxTokens);
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.equal((body.output_config as { effort: string }).effort, effort);
    assert.equal(net.calls[0].headers.get("x-api-key"), FAKE_ANTHROPIC_KEY);
    assert.deepEqual(out.result.ok && out.result.parsedPayload, PAYLOAD, "structured output parsed and schema-checked");
    assert.deepEqual(
      [out.attribution.role, out.attribution.model, out.attribution.application, out.attribution.feature, out.attribution.policyVersion],
      [role, model, "kabumori", "test_feature", "kabumori-model-policy/test-1"],
    );
    assert.equal(out.modelUnavailable, false);
  }
});

test("a caller can only narrow the policy: another allowed model or effort, a smaller cap", async () => {
  const net = recordingFetch(ok);
  const { deps } = testDeps(net.fetch);
  const out = executed(await executeWithModelPolicy(REGISTRY, call("test.classify.haiku", { model: "anthropic.sonnet@2026-10", effort: "medium", maxOutputTokens: 1_000 }), deps));
  const body = net.calls[0].body as Record<string, unknown>;
  assert.deepEqual([body.model, body.max_tokens, (body.output_config as { effort: string }).effort], ["claude-sonnet-5-5", 1_000, "medium"]);
  assert.equal(out.choice.requestedAs, "anthropic.sonnet@2026-10");
  const byId = resolveModelChoice(REGISTRY, { role: "test.analysis.sonnet", model: "claude-opus-5-5" });
  assert.ok(byId.ok && byId.choice.model === "claude-opus-5-5" && byId.choice.requestedAs === null);
});

test("anything the policy does not allow is refused before any key read, reservation or request", async () => {
  const cases: Array<[ModelPolicyCall, string]> = [
    [call("test.unknown.role"), "ROLE_UNKNOWN"],
    [call("test.classify.haiku", { model: "claude-opus-5-5" }), "MODEL_NOT_ALLOWED"],
    [call("test.classify.haiku", { model: "anthropic.opus@2026-10" }), "MODEL_NOT_ALLOWED"],
    [call("test.classify.haiku", { model: "anthropic.haiku@latest" }), "MODEL_UNKNOWN"],
    [call("test.classify.haiku", { model: "claude-haiku-5-5-20261001" }), "MODEL_UNKNOWN"],
    [call("test.classify.haiku", { model: "gpt-6.1-sol" }), "MODEL_NOT_ALLOWED"],
    [call("test.classify.haiku", { effort: "high" }), "EFFORT_NOT_ALLOWED"],
    [call("test.classify.haiku", { maxOutputTokens: 4_001 }), "OUTPUT_CAP_EXCEEDED"],
    [call("test.classify.haiku", { maxOutputTokens: 0 }), "OUTPUT_CAP_EXCEEDED"],
    [call("test.capped"), "COST_CAP_EXCEEDED"],
  ];
  for (const [c, code] of cases) {
    const net = recordingFetch(ok);
    const env = fakeEnv();
    const budget = new InMemoryBudgetGuard([{ id: "all", scope: {}, maxCalls: 100, maxEstimatedUsd: 100 }]);
    const out = await executeWithModelPolicy(REGISTRY, c, { readEnv: env.readEnv, budget, fetch: net.fetch });
    assert.deepEqual([out.kind, out.kind === "refused" ? out.code : null], ["refused", code], `${c.role} ${c.model ?? ""}`);
    assert.deepEqual([net.calls.length, env.reads.length], [0, 0]);
    assert.deepEqual(budget.state().map((state) => state.calls), [0], "nothing reserved");
  }
});

test("missing key and budget refusals fail closed with no request; a role without its own budget cannot run", async () => {
  const net = recordingFetch(ok);
  const noKey = executed(await executeWithModelPolicy(REGISTRY, call("test.analysis.sonnet"), testDeps(net.fetch, { readEnv: fakeEnv({}).readEnv }).deps));
  assert.deepEqual([noKey.result.ok, !noKey.result.ok && noKey.result.errorCode], [false, "KEY_MISSING"]);

  // The budget is scoped per role: another role's limit does not admit this one.
  const otherRoleOnly = new InMemoryBudgetGuard([{ id: "news", scope: { logicalRole: "kabumori.news.summary" }, maxCalls: 100, maxEstimatedUsd: 100 }]);
  const unbudgeted = executed(await executeWithModelPolicy(REGISTRY, call("test.analysis.sonnet"), testDeps(net.fetch, { budget: otherRoleOnly }).deps));
  assert.deepEqual([!unbudgeted.result.ok && unbudgeted.result.errorCode, !unbudgeted.result.ok && unbudgeted.result.detail], ["BUDGET_DENIED", "NO_MATCHING_LIMIT"]);

  const exhausted = new InMemoryBudgetGuard([{ id: "role", scope: { logicalRole: "test.analysis.sonnet" }, maxCalls: 0, maxEstimatedUsd: 100 }]);
  const denied = executed(await executeWithModelPolicy(REGISTRY, call("test.analysis.sonnet"), testDeps(net.fetch, { budget: exhausted }).deps));
  assert.deepEqual([!denied.result.ok && denied.result.errorCode, !denied.result.ok && denied.result.detail], ["BUDGET_DENIED", "CALL_LIMIT"]);
  assert.equal(net.calls.length, 0);
});

test("transient failures retry within the policy's attempt cap under one callId; timeouts and 4xx do not", async () => {
  const flaky = recordingFetch((_c, i) => i === 0 ? jsonResponse(529, anthropicError(529, "overloaded_error", "busy")) : jsonResponse(200, anthropicBody(PAYLOAD)));
  const ledger = new RecordingGuard([{ id: "all", scope: {}, maxCalls: 100, maxEstimatedUsd: 100 }]);
  const retried = executed(await executeWithModelPolicy(REGISTRY, call("test.classify.haiku", { callId: "job-42:classify" }),
    testDeps(flaky.fetch, { budget: ledger }).deps));
  assert.equal(retried.result.ok, true);
  assert.deepEqual(ledger.reserves, [
    { callId: "job-42:classify", attempt: 1, role: "test.classify.haiku" },
    { callId: "job-42:classify", attempt: 2, role: "test.classify.haiku" },
  ], "one reservation per attempt, under the caller's idempotency key and the role");

  const busy = recordingFetch(() => jsonResponse(529, anthropicError(529, "overloaded_error", "busy")));
  const oneAttempt = executed(await executeWithModelPolicy(REGISTRY, call("test.analysis.sonnet"), testDeps(busy.fetch).deps));
  assert.deepEqual([!oneAttempt.result.ok && oneAttempt.result.errorCode, busy.calls.length], ["OVERLOADED", 1], "policy cap 1: no retry");

  // A role with a short per-attempt timeout (kept above execute.ts's 5 s minimum attempt window), real clock.
  const fast = defineAnthropicModelPolicies("t", [{ ...POLICIES[0], role: "test.fast", timeoutMs: 6_000 }]);
  const slow = recordingFetch((_c, _i, init) => hangUntilAborted(init));
  const t0 = Date.now();
  const timedOut = executed(await executeWithModelPolicy(fast, call("test.fast"), testDeps(slow.fetch, { nowMs: Date.now, sleep: undefined }).deps));
  assert.ok(Date.now() - t0 < 10_000, "bounded by the policy timeout");
  assert.deepEqual([!timedOut.result.ok && timedOut.result.errorCode, slow.calls.length], ["TIMEOUT", 1], "a timeout is never retried");
});

test("a model the API does not serve is reported as unavailable; no other model or provider is tried", async () => {
  const gone = recordingFetch(() => jsonResponse(404, anthropicError(404, "not_found_error", "model: claude-sonnet-5-5")));
  const out = executed(await executeWithModelPolicy(REGISTRY, call("test.analysis.sonnet"), testDeps(gone.fetch).deps));
  assert.deepEqual([out.modelUnavailable, !out.result.ok && out.result.errorCode, gone.calls.length], [true, "INVALID_REQUEST", 1]);
  assert.ok(gone.calls.every((c) => (c.body as { model: string }).model === "claude-sonnet-5-5"));
});

test("spend is attributed per role and model, with the Haiku long-prompt price tier", async () => {
  const usage = (input: number, output: number) => ({
    input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null,
    output_tokens: output, output_tokens_details: { thinking_tokens: 0 }, server_tool_use: null, service_tier: "standard", inference_geo: null,
  });
  const haiku = findModelSpec("claude-haiku-5-5")!;
  for (const [input, output] of [[20_000, 1_000], [150_000, 1_000]] as const) {
    const net = recordingFetch(() => jsonResponse(200, anthropicBody(PAYLOAD, { usage: usage(input, output), model: "claude-haiku-5-5" })));
    const out = executed(await executeWithModelPolicy(REGISTRY, call("test.classify.haiku"), testDeps(net.fetch).deps));
    const tier = priceTierFor(haiku, input);
    const expected = Number(((input * tier.inputPer1M + output * tier.outputPer1M) / 1_000_000).toFixed(6));
    assert.equal(out.attribution.estimatedCostUsd, expected, `${input} prompt tokens`);
    assert.deepEqual([out.attribution.role, out.attribution.model, out.attribution.costBasis], ["test.classify.haiku", "claude-haiku-5-5", "measured"]);
  }
});

test("a schema violation is a failure, not a result", async () => {
  const net = recordingFetch(() => jsonResponse(200, anthropicBody({ label: 3 })));
  const out = executed(await executeWithModelPolicy(REGISTRY, call("test.report.opus"), testDeps(net.fetch).deps));
  assert.deepEqual([out.result.ok, !out.result.ok && out.result.errorCode], [false, "SCHEMA_VIOLATION"]);
});

test("a wrong policy is refused when the registry is built", () => {
  const good = POLICIES[0];
  const bad: Array<[Partial<AnthropicModelPolicy>, string]> = [
    [{ allowedModels: [] }, "allowed_models"],
    [{ allowedModels: ["gpt-6.1-sol"] }, "model_not_anthropic_catalog:gpt-6.1-sol"],
    [{ allowedModels: ["claude-haiku-latest"] }, "model_not_anthropic_catalog:claude-haiku-latest"],
    [{ defaultModel: "anthropic.opus@2026-10" }, "default_model_not_allowed"],
    [{ allowedEfforts: ["none"] as AnthropicModelPolicy["allowedEfforts"], defaultEffort: "none" }, "effort_unsupported:claude-haiku-5-5:none"],
    [{ defaultEffort: "max" }, "default_effort_not_allowed"],
    [{ maxOutputTokens: 128_001 }, "max_output_tokens:claude-haiku-5-5"],
    [{ timeoutMs: 999 }, "timeout_ms"],
    [{ maxTransportAttempts: 4 }, "max_transport_attempts"],
    [{ maxUpperBoundUsdPerAttempt: 0 }, "max_upper_bound_usd"],
    [{ role: "bad role" }, "role"],
    [{ feature: "" }, "usage_context"],
  ];
  for (const [patch, reason] of bad) {
    assert.throws(() => defineAnthropicModelPolicies("v1", [{ ...good, ...patch }]), (e: unknown) => e instanceof ModelPolicyError && e.reason === reason, reason);
  }
  assert.throws(() => defineAnthropicModelPolicies("v1", [good, good]), (e: unknown) => e instanceof ModelPolicyError && e.reason === "duplicate_role");
  assert.throws(() => defineAnthropicModelPolicies("bad version", [good]), ModelPolicyError);
  // Frozen: a registered policy cannot be widened afterwards.
  const policy = REGISTRY.get("test.classify.haiku")!;
  assert.throws(() => (policy.allowedModels as string[]).push("claude-opus-5-5"));
  assert.deepEqual(REGISTRY.roles(), ["test.analysis.sonnet", "test.capped", "test.classify.haiku", "test.report.opus"]);
});

test("aliases are versioned, name exactly the three Anthropic catalog models, and there is no 'latest'", () => {
  const aliases = listModelAliases();
  assert.deepEqual(aliases.map((a) => [a.alias, a.model]), [
    ["anthropic.opus@2026-10", "claude-opus-5-5"],
    ["anthropic.sonnet@2026-10", "claude-sonnet-5-5"],
    ["anthropic.haiku@2026-10", "claude-haiku-5-5"],
  ]);
  for (const { alias, model } of aliases) {
    assert.match(alias, /^anthropic\.(opus|sonnet|haiku)@\d{4}-\d{2}$/u);
    assert.equal(findModelSpec(model)?.provider, "anthropic");
    assert.equal(resolveModelName(alias), model);
  }
  for (const name of ["anthropic.opus", "anthropic.opus@latest", "latest", "opus", ""]) assert.equal(resolveModelName(name), undefined, name);
  assert.equal(resolveModelName("claude-haiku-5-5"), "claude-haiku-5-5");
});

test("outcomes carry no key, prompt or output text", async () => {
  const net = recordingFetch(ok);
  const out = await executeWithModelPolicy(REGISTRY, call("test.classify.haiku", { systemInstructions: "SECRET-PROMPT-TEXT", userContent: "SECRET-USER-TEXT" }), testDeps(net.fetch).deps);
  const rendered = JSON.stringify({ ...out, result: out.kind === "executed" ? { ...out.result, parsedPayload: undefined } : null });
  for (const secret of [FAKE_ANTHROPIC_KEY, "SECRET-PROMPT-TEXT", "SECRET-USER-TEXT"]) assert.ok(!rendered.includes(secret), secret);
});
