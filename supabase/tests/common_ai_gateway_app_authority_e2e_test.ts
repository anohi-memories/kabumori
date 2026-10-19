// OFFLINE end-to-end tests of G6-02: the app policy catalog (buildAppPolicySet) and the G5 authority port
// (createG5AuthorityPort) in front of the G6 runtime (createAiGateway -> real shared provider adapters, real
// SupabaseLedgerBudgetGuard, SupabaseAiCallsStore). Outside the process everything is a fake: a synthetic G5 that
// answers the proposed verdict wire, the providers and an in-memory Supabase (ledger + ai_calls RPCs). No network,
// fake keys. Every PASS is a mock PASS; G5's real verdict does not exist yet.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY \
//     supabase/tests/common_ai_gateway_app_authority_e2e_test.ts
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { anthropicBody, FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody, type RecordedCall, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import { AppPolicyConfigError, buildAppPolicySet, type FeatureConfig, type FeatureContent } from "../ai_gateway/app_policies.ts";
import { createG5AuthorityPort, type G5Transport, type VerdictScope } from "../ai_gateway/authority_port.ts";
import type { AuthVerdict } from "../ai_gateway/gateway.ts";
import { PolicyRegistryError } from "../ai_gateway/policy_registry.ts";
import { createAiGateway } from "../ai_gateway/runtime.ts";

const SUPABASE = "http://127.0.0.1:54321";
const SERVICE_KEY = "local-g6-02-key-NOT-A-SECRET";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const BRAND_A = { app: "postona" as const, slug: "u_ae343f5caedb67d4af33fc7a" };
const BRAND_B = { app: "postona" as const, slug: "u_0b1c2d3e4f5061728394a5b6" };
const SCHEMA = { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } };

// Test values only: the real limits, models and plans are operator / product decisions not made here.
const cfg = (over: Partial<FeatureConfig> = {}): FeatureConfig => ({
  enabled: true,
  revision: "test-r1",
  provider: "openai",
  model: "gpt-6-luna",
  reasoningEffort: "low",
  maxOutputTokens: 300,
  timeoutMs: 20_000,
  maxAttempts: 1,
  maxCostUsdPerOperation: 0.05,
  maxInputBytes: 8_000,
  entitlements: ["postona:x_autopost"],
  ...over,
});
const content = (label: string): FeatureContent => ({
  systemInstructions: `Test instructions for ${label}; answer JSON { reply }.`,
  schema: SCHEMA,
  validate: (p) => typeof (p as { reply?: unknown })?.reply === "string",
});
const CONFIG = {
  "postona:consult": cfg(),
  "kabumori:market_report": cfg({ provider: "anthropic", model: "claude-haiku-5-5", entitlements: [] }),
};
const CONTENT = { "postona:consult": content("consult"), "kabumori:market_report": content("market report") };

/** Synthetic G5: answers the proposed verdict wire from per-user state. */
class FakeG5 implements G5Transport {
  calls: string[] = [];
  users = new Map<string, { userId: string; session: "active" | "revoked" | "expired" | "unknown"; sessionRef: string; entitlements: string[]; epochs: Record<string, string> }>([
    ["jwt-a", { userId: USER_A, session: "active", sessionRef: "s-a1", entitlements: ["postona:x_autopost"], epochs: { [BRAND_A.slug]: "g5oe:7:1", [BRAND_B.slug]: "g5oe:3:1" } }],
    ["jwt-b", { userId: USER_B, session: "active", sessionRef: "s-b1", entitlements: ["postona:x_autopost"], epochs: { [BRAND_A.slug]: "g5oe:7:2" } }],
    ["jwt-free", { userId: USER_B, session: "active", sessionRef: "s-f1", entitlements: [], epochs: { [BRAND_A.slug]: "g5oe:9:1" } }],
  ]);
  down = false;
  hang = false;
  /** Rewrites the next wire (one-shot) to probe the port's strictness. */
  tamper: ((w: Record<string, unknown>) => void) | null = null;
  private wire(credential: string, scope: VerdictScope): Record<string, unknown> {
    const now = Date.now();
    const base = { v: 1, reason: null, scope: { app: scope.app, feature: scope.feature, brand_slug: scope.brand?.slug ?? null }, issued_at_ms: now, expires_at_ms: now + 60_000 };
    if (credential === "cron-kabumori") {
      return { ...base, decision: "allow", subject: { kind: "system" }, session: null, owner_epoch: null, entitlements: [] };
    }
    const u = this.users.get(credential);
    if (!u) return { ...base, decision: "deny", reason: "NO_SESSION", subject: { kind: "system" }, session: null, owner_epoch: null, entitlements: [] };
    const epoch = scope.brand ? u.epochs[scope.brand.slug] : null;
    if (scope.brand && !epoch) return { ...base, decision: "deny", reason: "NOT_BRAND_OWNER", subject: { kind: "user", user_id: u.userId }, session: { state: u.session, ref: u.sessionRef }, owner_epoch: null, entitlements: u.entitlements };
    return { ...base, decision: "allow", subject: { kind: "user", user_id: u.userId }, session: { state: u.session, ref: u.sessionRef }, owner_epoch: epoch ?? null, entitlements: [...u.entitlements] };
  }
  private answer(credential: string, scope: VerdictScope): Promise<unknown> {
    if (this.down) return Promise.reject(new Error("G5 unreachable"));
    if (this.hang) return new Promise(() => {});
    const w = this.wire(credential, scope);
    if (this.tamper) {
      this.tamper(w);
      this.tamper = null;
    }
    return Promise.resolve(w);
  }
  fetchVerdict(credential: unknown, scope: VerdictScope) {
    this.calls.push(`verdict:${scope.app}:${scope.feature}`);
    return this.answer(String(credential), scope);
  }
  fetchRecheck(_credential: unknown, scope: VerdictScope, subject: { kind: "user"; userId: string } | { kind: "system" }) {
    this.calls.push(`recheck:${scope.app}:${scope.feature}`);
    const credential = subject.kind === "system" ? "cron-kabumori" : [...this.users.entries()].find(([, u]) => u.userId === subject.userId)?.[0] ?? "-";
    return this.answer(credential, scope);
  }
}

type Fault = "network" | number | "lost";
class FakeSupabase {
  calls: string[] = [];
  reservations = new Map<string, string>();
  rows = new Map<string, { identity: string; owner: string; state: "acquired" | "complete"; result: unknown }>();
  fault: Record<string, Fault | undefined> = {};
  private n = 0;
  // deno-lint-ignore require-await
  readonly fetch: FetchLike = async (input, init) => {
    const name = new URL(String(input)).pathname.replace("/rest/v1/rpc/", "");
    const p = (JSON.parse(String(init?.body)) as { p: Record<string, unknown> }).p;
    this.calls.push(name.replace(/^ai_(ledger|calls)_/, ""));
    const f = this.fault[name];
    if (f === "network") throw new TypeError("unreachable");
    if (typeof f === "number") return jsonResponse(f, { code: "XX000" });
    const out = this.answer(name, p);
    return f === "lost" ? jsonResponse(504, {}) : jsonResponse(200, out);
  };
  private answer(name: string, p: Record<string, unknown>): unknown {
    switch (name) {
      case "ai_ledger_reserve": {
        const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
        this.reservations.set(id, "reserved");
        return { allowed: true, reservation_id: id };
      }
      case "ai_ledger_mark_sent":
        this.reservations.set(String(p.reservation_id), "sent");
        return { may_send: true, status: "sent" };
      case "ai_ledger_settle":
        this.reservations.set(String(p.reservation_id), p.outcome === "unknown" ? "unknown" : "settled");
        return { settled: true };
      case "ai_ledger_release":
        this.reservations.set(String(p.reservation_id), "released");
        return { released: true };
      case "ai_calls_claim": {
        const identity = JSON.stringify([p.tenant_tag, p.fingerprint, p.application, p.feature, p.subject_kind, p.user_id ?? null]);
        const row = this.rows.get(String(p.call_key));
        if (!row) {
          const owner = crypto.randomUUID();
          this.rows.set(String(p.call_key), { identity, owner, state: "acquired", result: null });
          return { kind: "acquired", owner };
        }
        if (row.identity !== identity) return { kind: "conflict" };
        return row.state === "acquired" ? { kind: "busy" } : { kind: "complete", fingerprint: p.fingerprint, result: row.result };
      }
      case "ai_calls_complete": {
        const row = this.rows.get(String(p.call_key))!;
        row.state = "complete";
        row.result = structuredClone(p.result);
        return { state: "complete", duplicate: false };
      }
    }
    throw new Error(`unexpected ${name}`);
  }
}

const reply = (call: RecordedCall) =>
  call.url.includes("anthropic") ? jsonResponse(200, anthropicBody({ reply: "ok" }, { model: "claude-haiku-5-5" })) : jsonResponse(200, openAiBody({ reply: "ok" }, { model: "gpt-6-luna" }));

function world(options: { respond?: (call: RecordedCall) => Response | Promise<Response>; g5?: FakeG5; supabase?: FakeSupabase; config?: Record<string, unknown> } = {}) {
  const set = buildAppPolicySet(options.config ?? CONFIG, CONTENT);
  const g5 = options.g5 ?? new FakeG5();
  const supabase = options.supabase ?? new FakeSupabase();
  const provider = recordingFetch((call) => (options.respond ?? reply)(call));
  const gateway = createAiGateway({
    supabaseUrl: SUPABASE,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
    // This test transport also answers the Kabumori system job (G5 never does): a stand-in for a job authority.
    authority: createG5AuthorityPort({ transport: g5, planAllowlist: set.planAllowlist, timeoutMs: 200, acceptSystemSubject: true }),
    policies: set.registry,
    fetch: (input, init) => (String(input).startsWith(SUPABASE) ? supabase.fetch(input, init) : provider.fetch(input, init)),
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  return { set, g5, supabase, provider, run: (credential: string, request: Record<string, unknown>) => gateway.execute(credential, request) };
}
const consult = (over: Record<string, unknown> = {}) => ({ app: "postona", feature: "consult", operationId: "op-g6-02-0001", input: "相談", brand: BRAND_A, ...over });
const report = (over: Record<string, unknown> = {}) => ({ app: "kabumori", feature: "market_report", operationId: "run-g6-02-close", input: "市況", brand: null, ...over });
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "OK" : r.code);

Deno.test("catalog + config: nothing is enabled without explicit config, app content and (for people) a plan entitlement; Miseiro and typos are startup errors", () => {
  const none = buildAppPolicySet({}, {});
  assert.equal(none.registry.size, 0);
  assert.deepEqual(none.disabled.map((d) => d.key), ["kabumori:market_report", "postona:consult", "postona:post_generation"]);
  assert.ok(none.disabled.every((d) => d.reason.startsWith("no_config")));
  const set = buildAppPolicySet(CONFIG, CONTENT);
  assert.deepEqual([...set.registry.keys()].sort(), ["kabumori:market_report", "postona:consult"]);
  assert.deepEqual([...set.planAllowlist.entries()], [["kabumori:market_report", []], ["postona:consult", ["postona:x_autopost"]]]);
  assert.deepEqual(set.disabled, [{ key: "postona:post_generation", reason: "no_config (AI plan for post generation not decided; personal data to OpenAI only)" }]);
  const disabledCases: Array<[string, Record<string, unknown>, Record<string, FeatureContent>]> = [
    ["disabled_by_config", { "postona:consult": cfg({ enabled: false }) }, CONTENT],
    ["no_app_content", { "postona:consult": cfg() }, {}],
    ["provider_not_allowed_for_this_data:anthropic", { "postona:consult": cfg({ provider: "anthropic", model: "claude-haiku-5-5" }) }, CONTENT],
    ["no_plan_entitlement", { "postona:consult": cfg({ entitlements: [] }) }, CONTENT],
  ];
  for (const [reason, config, body] of disabledCases) {
    const s = buildAppPolicySet(config, body);
    assert.equal(s.registry.has("postona:consult"), false, reason);
    assert.deepEqual(s.disabled.find((d) => d.key === "postona:consult")?.reason, reason);
  }
  const errors: Array<[string, Record<string, unknown>, Record<string, FeatureContent>]> = [
    ["miseiro:assistant:not_in_catalog", { "miseiro:assistant": cfg() }, {}],
    ["postona:consul:not_in_catalog", { "postona:consul": cfg() }, {}],
    ["miseiro:assistant:not_in_catalog", {}, { "miseiro:assistant": content("x") }],
    ["postona:consult:config_shape", { "postona:consult": { ...cfg(), extra: 1 } }, CONTENT],
    ["postona:consult:model", { "postona:consult": cfg({ model: "claude-haiku-5-5" }) }, CONTENT],
    ["postona:consult:max_cost", { "postona:consult": cfg({ maxCostUsdPerOperation: 2 }) }, CONTENT],
    ["postona:consult:entitlements", { "postona:consult": cfg({ entitlements: ["postona:premium"] }) }, CONTENT],
    ["postona:consult:entitlements", { "postona:consult": cfg({ entitlements: ["postona:x_autopost", "postona:x_autopost"] }) }, CONTENT],
    ["kabumori:market_report:entitlements", { "kabumori:market_report": cfg({ provider: "anthropic", model: "claude-haiku-5-5", entitlements: ["postona:x_autopost"] }) }, CONTENT],
  ];
  for (const [message, config, body] of errors) {
    assert.throws(() => buildAppPolicySet(config, body), (e: unknown) => e instanceof AppPolicyConfigError && e.message === `AI_GATEWAY_APP_POLICY_CONFIG:${message}`, message);
  }
  // Even if a catalog declared an entitlement on a system-only feature, config cannot attach a plan to system work.
  const sysCatalog = [{ app: "kabumori" as const, feature: "digest", ledgerFeature: "digest", logicalRole: "kabumori.digest", subjectKinds: ["system" as const], brandRequired: false, allowedProviders: ["anthropic" as const], knownEntitlements: ["kabumori:pro"], note: "test" }];
  assert.throws(
    () => buildAppPolicySet({ "kabumori:digest": cfg({ provider: "anthropic", model: "claude-haiku-5-5", entitlements: ["kabumori:pro"] }) }, { "kabumori:digest": content("digest") }, sysCatalog),
    (e: unknown) => e instanceof AppPolicyConfigError && e.message === "AI_GATEWAY_APP_POLICY_CONFIG:kabumori:digest:entitlements_on_system_feature",
  );
  // definePolicyRegistry's own checks still apply to what the catalog lets through.
  assert.throws(() => buildAppPolicySet({ "postona:consult": cfg({ maxCostUsdPerOperation: 0.000001 }) }, CONTENT), (e: unknown) => e instanceof PolicyRegistryError && /cost_bound$/.test(e.message));
  assert.throws(() => buildAppPolicySet({ "postona:consult": cfg({ revision: "" }) }, CONTENT), (e: unknown) => e instanceof PolicyRegistryError && /revision$/.test(e.message));
});

Deno.test("G5 port strictness: only a complete, in-scope, live, owned, plan-allowed answer is 'allow'; everything else is deny / unknown / pending; unreachable or slow G5 throws", async () => {
  const set = buildAppPolicySet(CONFIG, CONTENT);
  const scope: VerdictScope = { app: "postona", feature: "consult", brand: BRAND_A };
  const cases: Array<[string, (w: Record<string, unknown>) => void, string, string | null]> = [
    ["as is", () => {}, "allow", null],
    ["deny passes through", (w) => Object.assign(w, { decision: "deny", reason: "ACCOUNT_FROZEN" }), "deny", "ACCOUNT_FROZEN"],
    ["pending", (w) => Object.assign(w, { decision: "pending" }), "pending", "G5_PENDING"],
    ["unknown", (w) => Object.assign(w, { decision: "unknown" }), "unknown", "G5_UNKNOWN"],
    ["odd decision", (w) => Object.assign(w, { decision: "maybe" }), "unknown", "WIRE_DECISION"],
    ["version", (w) => Object.assign(w, { v: 2 }), "unknown", "WIRE_SHAPE"],
    ["extra key", (w) => Object.assign(w, { plan: "gold" }), "unknown", "WIRE_SHAPE"],
    ["missing key", (w) => delete w.entitlements, "unknown", "WIRE_SHAPE"],
    ["free-text reason", (w) => Object.assign(w, { reason: "not allowed because ..." }), "unknown", "WIRE_REASON"],
    ["other app", (w) => Object.assign(w, { scope: { app: "kabumori", feature: "consult", brand_slug: BRAND_A.slug } }), "unknown", "SCOPE_MISMATCH"],
    ["other feature", (w) => Object.assign(w, { scope: { app: "postona", feature: "post_generation", brand_slug: BRAND_A.slug } }), "unknown", "SCOPE_MISMATCH"],
    ["other brand", (w) => Object.assign(w, { scope: { app: "postona", feature: "consult", brand_slug: BRAND_B.slug } }), "unknown", "SCOPE_MISMATCH"],
    ["expired", (w) => Object.assign(w, { expires_at_ms: Date.now() - 1 }), "deny", "EXPIRED"],
    ["ttl too long", (w) => Object.assign(w, { expires_at_ms: (w.issued_at_ms as number) + 3_600_000 }), "unknown", "TTL_TOO_LONG"],
    ["issued in the future", (w) => Object.assign(w, { issued_at_ms: Date.now() + 120_000, expires_at_ms: Date.now() + 130_000 }), "unknown", "ISSUED_IN_FUTURE"],
    ["non-integer time", (w) => Object.assign(w, { expires_at_ms: "soon" }), "unknown", "WIRE_TIME"],
    ["session revoked", (w) => Object.assign(w, { session: { state: "revoked", ref: "s-a1" } }), "deny", "SESSION_REVOKED"],
    ["session expired", (w) => Object.assign(w, { session: { state: "expired", ref: "s-a1" } }), "deny", "SESSION_EXPIRED"],
    ["session unknown", (w) => Object.assign(w, { session: { state: "unknown", ref: "s-a1" } }), "deny", "SESSION_UNKNOWN"],
    ["no session for a person", (w) => Object.assign(w, { session: null }), "unknown", "SESSION_SHAPE"],
    ["owner epoch missing", (w) => Object.assign(w, { owner_epoch: null }), "unknown", "OWNER_EPOCH_MISSING"],
    ["slug as user id", (w) => Object.assign(w, { subject: { kind: "user", user_id: BRAND_A.slug } }), "unknown", "SUBJECT_SHAPE"],
    ["system subject for a brand", (w) => Object.assign(w, { subject: { kind: "system" }, session: null, owner_epoch: null }), "unknown", "SYSTEM_SUBJECT_NOT_FROM_G5"],
    ["entitlements malformed", (w) => Object.assign(w, { entitlements: ["x_autopost"] }), "unknown", "WIRE_ENTITLEMENTS"],
    ["entitlements duplicated", (w) => Object.assign(w, { entitlements: ["postona:x_autopost", "postona:x_autopost"] }), "unknown", "WIRE_ENTITLEMENTS"],
    ["no plan entitlement", (w) => Object.assign(w, { entitlements: ["postona:other"] }), "deny", "PLAN_NOT_ALLOWED"],
  ];
  for (const [label, tamper, decision, reason] of cases) {
    const g5 = new FakeG5();
    g5.tamper = tamper;
    const port = createG5AuthorityPort({ transport: g5, planAllowlist: set.planAllowlist });
    const v: AuthVerdict = await port.verdict("jwt-a", scope);
    assert.deepEqual([v.decision, v.reason ?? null], [decision, reason], label);
    if (decision === "allow") {
      assert.deepEqual(v.subject, { kind: "user", app: "postona", userId: USER_A, brand: BRAND_A });
      assert.match(v.generation, /^g5v1:[0-9a-f]{64}$/);
    }
  }
  const g5 = new FakeG5();
  const port = createG5AuthorityPort({ transport: g5, planAllowlist: set.planAllowlist, timeoutMs: 100 });
  const off = await port.verdict("jwt-a", { app: "postona", feature: "post_generation", brand: BRAND_A });
  assert.deepEqual([off.decision, off.reason, g5.calls.length], ["deny", "FEATURE_NOT_ENABLED", 0], "a disabled feature never asks G5");
  const mis = await port.verdict("jwt-a", { app: "miseiro", feature: "assistant", brand: null });
  assert.deepEqual([mis.decision, g5.calls.length], ["deny", 0]);
  g5.down = true;
  await assert.rejects(port.verdict("jwt-a", scope), /G5 unreachable/);
  g5.down = false;
  g5.hang = true;
  await assert.rejects(port.verdict("jwt-a", scope), /G5_TIMEOUT/);
  const stranger = await port.recheck({ decision: "allow", subject: { kind: "system", app: "postona" }, generation: "x", expiresAtMs: Date.now() + 1000 });
  assert.deepEqual([stranger.decision, stranger.reason], ["unknown", "RECHECK_UNKNOWN_VERDICT"], "a verdict the port did not issue is never rechecked to allow");
  for (const bad of [{ maxTtlMs: 10 }, { skewMs: -1 }, { timeoutMs: 5 }]) assert.throws(() => createG5AuthorityPort({ transport: g5, planAllowlist: set.planAllowlist, ...bad }));
});

Deno.test("E2E both apps: a POSTONA person with the plan (OpenAI) and Kabumori system work (Anthropic) go through; G5 asked once plus once per attempt; Miseiro and disabled features never reach G5, the ledger or a provider", async () => {
  const w = world();
  const p = await w.run("jwt-a", consult());
  const k = await w.run("cron-kabumori", report());
  assert.deepEqual([code(p), code(k), w.provider.calls.length], ["OK", "OK", 2]);
  assert.deepEqual(w.provider.calls.map((c) => c.url.includes("openai") ? "openai" : "anthropic"), ["openai", "anthropic"]);
  assert.deepEqual(w.g5.calls, ["verdict:postona:consult", "recheck:postona:consult", "verdict:kabumori:market_report", "recheck:kabumori:market_report"]);
  for (const [request, expected] of [
    [{ app: "miseiro", feature: "assistant", operationId: "op-miseiro-0001", input: "x", brand: null }, "AUTH_DENIED"],
    [consult({ feature: "post_generation", operationId: "op-g6-02-post1" }), "AUTH_DENIED"],
  ] as const) {
    const before = [w.g5.calls.length, w.supabase.calls.length, w.provider.calls.length];
    assert.equal(code(await w.run("jwt-a", request)), expected, request.feature);
    assert.deepEqual([w.g5.calls.length, w.supabase.calls.length, w.provider.calls.length], before, `${request.feature}: nothing happened`);
  }
  const free = await w.run("jwt-free", consult({ operationId: "op-g6-02-free1" }));
  assert.deepEqual([code(free), w.provider.calls.length], ["AUTH_DENIED", 2], "no plan entitlement: refused, nothing sent");
});

Deno.test("E2E recheck (G5 changes right before the send): session revoked, owner epoch moved, plan entitlement removed, G5 unreachable or slow -> AUTH_REVOKED_BEFORE_SEND, reservation released, nothing sent; replay NOT_SENT", async () => {
  const changes: Array<[string, (g5: FakeG5) => void]> = [
    ["session revoked", (g5) => g5.users.get("jwt-a")!.session = "revoked"],
    ["owner epoch moved (A -> B -> A)", (g5) => g5.users.get("jwt-a")!.epochs[BRAND_A.slug] = "g5oe:8:1"],
    ["plan entitlement removed", (g5) => g5.users.get("jwt-a")!.entitlements = []],
    ["new session", (g5) => g5.users.get("jwt-a")!.sessionRef = "s-a2"],
    ["brand no longer owned", (g5) => delete g5.users.get("jwt-a")!.epochs[BRAND_A.slug]],
    ["G5 unreachable", (g5) => g5.down = true],
    ["G5 slow", (g5) => g5.hang = true],
  ];
  for (const [label, change] of changes) {
    const g5 = new FakeG5();
    const supabase = new FakeSupabase();
    let changed = false;
    const original = g5.fetchRecheck.bind(g5);
    g5.fetchRecheck = (credential, scope, subject) => {
      if (!changed) {
        change(g5);
        changed = true;
      }
      return original(credential, scope, subject);
    };
    const w = world({ g5, supabase });
    const r = await w.run("jwt-a", consult());
    assert.deepEqual([code(r), r.audit?.costBasis, w.provider.calls.length], ["AUTH_REVOKED_BEFORE_SEND", "no_request", 0], label);
    assert.deepEqual(supabase.calls, ["claim", "reserve", "release", "complete"], label);
    assert.deepEqual([...supabase.reservations.values()], ["released"], label);
    g5.down = false;
    g5.hang = false;
    const again = await world({ supabase }).run("jwt-b", consult());
    assert.notEqual(code(again), "NOT_SENT", `${label}: another person's same operation id is another call`);
    // The stored answer is replayed (with a G5 that allows again): nothing was sent, nothing is sent now.
    const replay = await world({ supabase }).run("jwt-a", consult());
    assert.deepEqual([code(replay), replay.audit?.attempts], ["NOT_SENT", 0], label);
  }
});

Deno.test("E2E separation and misuse: same operation id across person / brand / app is another call; a person on a system feature, a brand on a system feature, a missing brand: refused before any spend", async () => {
  const w = world();
  const a = await w.run("jwt-a", consult({ operationId: "op-g6-02-share" }));
  const ab = await w.run("jwt-a", consult({ operationId: "op-g6-02-share", brand: BRAND_B }));
  const b = await w.run("jwt-b", consult({ operationId: "op-g6-02-share" }));
  assert.deepEqual([code(a), code(ab), code(b)], ["OK", "OK", "OK"]);
  assert.equal(new Set([a, ab, b].map((r) => r.audit!.callKey)).size, 3);
  assert.equal(w.provider.calls.length, 3);
  const spend = () => [w.supabase.calls.length, w.provider.calls.length];
  const before = spend();
  // The port refuses first: no plan entitlement opens a system-only feature for a person.
  assert.equal(code(await w.run("jwt-a", report({ operationId: "run-g6-02-person" }))), "AUTH_DENIED", "a person cannot run the system-only report");
  assert.equal(code(await w.run("cron-kabumori", report({ operationId: "run-g6-02-brand", brand: BRAND_A }))), "REQUEST_INVALID", "a POSTONA brand on a Kabumori request");
  assert.equal(code(await w.run("jwt-a", consult({ operationId: "op-g6-02-nobrand", brand: null }))), "POLICY_SUBJECT_DENIED", "consult needs the brand");
  assert.equal(code(await w.run("jwt-a", consult({ operationId: "op-g6-02-kbrand", brand: { app: "kabumori", slug: "u_ae343f5caedb67d4af33fc7a" } }))), "REQUEST_INVALID", "a brand of another app");
  assert.deepEqual(spend(), before, "none of them reached the ledger, the call store or a provider");
});

Deno.test("E2E money: parallel duplicates send once; 504 is UNKNOWN at the upper bound and never resent; the ledger down is LEDGER_UNAVAILABLE; a lost settlement keeps the ledger 'sent' (source of truth)", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const p = world({ respond: async (call) => (await gate, reply(call)) });
  const first = p.run("jwt-a", consult({ operationId: "op-g6-02-par01" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await p.run("jwt-a", consult({ operationId: "op-g6-02-par01" }));
  release();
  assert.deepEqual([code(second), code(await first), p.provider.calls.length], ["IN_PROGRESS", "OK", 1]);
  const u = world({ respond: () => jsonResponse(504, { error: { type: "timeout" } }) });
  const unknown = await u.run("jwt-a", consult());
  assert.deepEqual([code(unknown), unknown.audit?.costBasis, [...u.supabase.reservations.values()]], ["UNKNOWN", "includes_upper_bound", ["unknown"]]);
  assert.deepEqual([code(await u.run("jwt-a", consult())), u.provider.calls.length], ["UNKNOWN", 1]);
  const l = world();
  l.supabase.fault = { ai_ledger_reserve: "network" };
  assert.deepEqual([code(await l.run("jwt-a", consult())), l.provider.calls.length], ["LEDGER_UNAVAILABLE", 0]);
  const s = world();
  s.supabase.fault = { ai_ledger_settle: 500 };
  assert.deepEqual([code(await s.run("jwt-a", consult())), [...s.supabase.reservations.values()]], ["OK", ["sent"]]);
});
