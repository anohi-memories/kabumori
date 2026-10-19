// OFFLINE tests of the G6 runtime candidate (supabase/ai_gateway/): createAiGateway wires the PR302 gateway core to
// the REAL shared provider (OpenAI / Anthropic adapters), the REAL SupabaseLedgerBudgetGuard and the new
// SupabaseAiCallsStore. Everything outside the process is a fake fetch: the providers and an in-memory "Supabase"
// that answers the ledger and ai_calls RPCs (the real SQL is exercised by common_ai_gateway_runtime_pg_test.ts).
// No network, fake keys. Every PASS is a mock PASS.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY --allow-read=supabase/ai_gateway \
//     supabase/tests/common_ai_gateway_runtime_test.ts
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import {
  anthropicBody,
  anthropicError,
  FAKE_ANTHROPIC_KEY,
  FAKE_OPENAI_KEY,
  jsonResponse,
  openAiBody,
  type RecordedCall,
  recordingFetch,
} from "../functions/_shared/ai_provider/test_support.ts";
import { type AuthorityPort, type AuthVerdict, type FeaturePolicy, type GatewaySubject, policyKey } from "../ai_gateway/gateway.ts";
import { definePolicyRegistry, PolicyRegistryError } from "../ai_gateway/policy_registry.ts";
import { AiGatewayConfigError, createAiGateway } from "../ai_gateway/runtime.ts";

const SUPABASE = "http://127.0.0.1:54321";
const SERVICE_KEY = "local-gateway-runtime-key-NOT-A-SECRET";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const BRAND_A = { app: "postona" as const, slug: "u_ae343f5caedb67d4af33fc7a" };
const BRAND_B = { app: "postona" as const, slug: "u_0b1c2d3e4f5061728394a5b6" };
const HOUR = 3_600_000;
const SCHEMA = { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } };

function policy(app: FeaturePolicy["app"], feature: string, provider: "openai" | "anthropic", over: Partial<FeaturePolicy> = {}): FeaturePolicy {
  return {
    app,
    feature,
    revision: "r1",
    ledgerFeature: feature,
    logicalRole: `${app}.${feature}`,
    provider,
    model: provider === "openai" ? "gpt-6-luna" : "claude-haiku-5-5",
    reasoningEffort: "low",
    maxOutputTokens: 300,
    timeoutMs: 20_000,
    maxAttempts: 1,
    maxCostUsdPerOperation: 0.05,
    maxInputBytes: 8_000,
    subjectKinds: ["user"],
    brandRequired: false,
    systemInstructions: `Answer for ${app} ${feature} as JSON { reply }.`,
    schema: SCHEMA,
    validate: (p) => typeof (p as { reply?: unknown })?.reply === "string",
    ...over,
  };
}
const POLICIES = [
  policy("postona", "ideas", "openai"),
  policy("postona", "consult", "anthropic", { brandRequired: true }),
  policy("postona", "retry", "openai", { maxAttempts: 2, maxCostUsdPerOperation: 0.1 }),
  policy("kabumori", "market_report", "anthropic", { subjectKinds: ["system"] }),
];

const user = (userId: string, brand: typeof BRAND_A | null): GatewaySubject => ({ kind: "user", app: "postona", userId, brand });
const allow = (subject: GatewaySubject, over: Partial<AuthVerdict> = {}): AuthVerdict => ({ decision: "allow", subject, generation: "epoch-1", expiresAtMs: Date.now() + HOUR, ...over });
class Authority implements AuthorityPort {
  verdicts: Record<string, AuthVerdict | Error> = {
    "jwt-a": allow(user(USER_A, BRAND_A)),
    "jwt-a-b": allow(user(USER_A, BRAND_B)),
    "jwt-b": allow(user(USER_B, BRAND_A)),
    "cron-kabumori": allow({ kind: "system", app: "kabumori" }),
    "jwt-expired": allow(user(USER_A, BRAND_A), { expiresAtMs: Date.now() - 1 }),
    "jwt-denied": allow(user(USER_A, BRAND_A), { decision: "deny" }),
    "jwt-down": new Error("authority unreachable"),
  };
  recheckAnswer: (prior: AuthVerdict) => AuthVerdict | Error = (prior) => prior;
  verdict(credential: unknown): Promise<AuthVerdict> {
    const v = this.verdicts[String(credential)];
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(structuredClone(v));
  }
  recheck(prior: AuthVerdict): Promise<AuthVerdict> {
    const v = this.recheckAnswer(prior);
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(structuredClone(v));
  }
}

/** "error-ok": the RPC runs and its well-formed answer comes back with HTTP 500 (it must still count as a failure). */
type Fault = "network" | "bad" | "lost" | "error-ok" | number | `deny:${string}`;
/** In-memory Supabase: the ledger RPCs and the ai_calls RPCs, with injectable faults. */
class FakeSupabase {
  readonly calls: string[] = [];
  readonly requests: RecordedCall[] = [];
  readonly reservations = new Map<string, string>();
  readonly rows = new Map<string, { identity: string; owner: string; state: "acquired" | "complete"; result: unknown }>();
  fault: Record<string, Fault | undefined> = {};
  private n = 0;
  // deno-lint-ignore require-await
  readonly fetch: FetchLike = async (input, init) => {
    const name = new URL(String(input)).pathname.replace("/rest/v1/rpc/", "");
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { p: Record<string, unknown> };
    this.requests.push({ url: String(input), method: String(init?.method), headers, body });
    if (headers.get("apikey") !== SERVICE_KEY || headers.get("authorization") !== `Bearer ${SERVICE_KEY}`) return jsonResponse(401, { code: "PGRST301" });
    this.calls.push(name.replace(/^ai_(ledger|calls)_/, ""));
    const f = this.fault[name];
    if (f === "network") throw new TypeError("unreachable");
    if (typeof f === "number") return jsonResponse(f, { code: "XX000" });
    if (f === "bad") return jsonResponse(200, { surprise: true });
    const answer = this.answer(name, body.p, f);
    if (f === "error-ok") return jsonResponse(500, answer);
    return f === "lost" ? jsonResponse(504, { code: "504" }) : jsonResponse(200, answer);
  };
  private answer(name: string, p: Record<string, unknown>, f: Fault | undefined): unknown {
    switch (name) {
      case "ai_ledger_reserve": {
        if (typeof f === "string" && f.startsWith("deny:")) return { allowed: false, reason: f.slice(5), policy_key: "gwc" };
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
        if (row.state === "acquired") return { kind: "busy" };
        return { kind: "complete", fingerprint: p.fingerprint, result: row.result };
      }
      case "ai_calls_complete": {
        const row = this.rows.get(String(p.call_key));
        if (!row || row.owner !== p.owner) throw new Error("fenced");
        row.state = "complete";
        row.result = structuredClone(p.result);
        return { state: "complete", duplicate: false };
      }
    }
    throw new Error(`unexpected rpc ${name}`);
  }
}

const reply = (text: string) => (call: RecordedCall) =>
  call.url.includes("anthropic") ? jsonResponse(200, anthropicBody({ reply: text }, { model: "claude-haiku-5-5" })) : jsonResponse(200, openAiBody({ reply: text }, { model: "gpt-6-luna" }));

function world(options: { respond?: (call: RecordedCall, i: number) => Response | Promise<Response>; registry?: ReturnType<typeof definePolicyRegistry>; supabase?: FakeSupabase } = {}) {
  const supabase = options.supabase ?? new FakeSupabase();
  const provider = recordingFetch((call, i) => (options.respond ?? reply("どうぞ"))(call, i));
  const envReads: string[] = [];
  const authority = new Authority();
  const fetch: FetchLike = (input, init) => String(input).startsWith(SUPABASE) ? supabase.fetch(input, init) : provider.fetch(input, init);
  const gateway = createAiGateway({
    supabaseUrl: SUPABASE,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY),
    readEnv: (name) => {
      envReads.push(name);
      return name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : "SHOULD-NEVER-BE-READ";
    },
    authority,
    policies: options.registry ?? definePolicyRegistry(POLICIES),
    fetch,
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  return { gateway, supabase, provider, authority, envReads, run: (credential: string, request: Record<string, unknown>) => gateway.execute(credential, request) };
}
const ideas = (over: Record<string, unknown> = {}) => ({ app: "postona", feature: "ideas", operationId: "op-runtime-0001", input: "アイデア", brand: BRAND_A, ...over });
const consult = (over: Record<string, unknown> = {}) => ({ app: "postona", feature: "consult", operationId: "op-runtime-0002", input: "相談", brand: BRAND_A, ...over });
const report = { app: "kabumori", feature: "market_report", operationId: "run-2026-10-19-close", input: "市況", brand: null };
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "OK" : r.code);

Deno.test("configuration is refused before any request: URL, legacy / non-secret service key, key type, authority, an unchecked registry", () => {
  const base = { supabaseUrl: SUPABASE, serviceKey: new SecretValue("k", SERVICE_KEY), readEnv: () => undefined, authority: new Authority(), policies: definePolicyRegistry(POLICIES) };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["supabase_url", { supabaseUrl: "http://example.com" }],
    ["supabase_url", { supabaseUrl: "ftp://127.0.0.1" }],
    ["supabase_url", { supabaseUrl: "not a url" }],
    ["legacy_service_key", { serviceKey: new SecretValue("k", ["e", "yJ", "hbGciOiJIUzI1NiJ9", ".", "e", "yJ", "yb2xlIjoic2VydmljZV9yb2xlIn0", ".c2ln"].join("")) }],
    ["service_key_kind", { supabaseUrl: "https://abc.supabase.co", serviceKey: new SecretValue("k", "plain-not-a-secret-key-000000") }],
    ["service_key_type", { serviceKey: SERVICE_KEY }],
    ["read_env", { readEnv: "OPENAI_API_KEY" }],
    ["authority", { authority: { verdict: () => Promise.resolve(null) } }],
    ["policies", { policies: new Map(POLICIES.map((p) => [policyKey(p.app, p.feature), p])) }],
  ];
  for (const [reason, over] of cases) {
    assert.throws(() => createAiGateway({ ...base, ...over } as never), (e: unknown) => e instanceof AiGatewayConfigError && e.message === `AI_GATEWAY_CONFIG_INVALID:${reason}`, reason);
  }
  assert.doesNotThrow(() => createAiGateway({ ...base, supabaseUrl: "https://abc.supabase.co", serviceKey: new SecretValue("k", "sb_secret_FAKE_0000000000") }));
});

Deno.test("policy registry: every policy the gateway, ledger or call store would refuse later is refused at startup", () => {
  const ok = policy("postona", "ideas", "openai");
  const cases: Array<[string, Partial<FeaturePolicy>]> = [
    ["app", { app: "other" as never }],
    ["feature", { feature: "Bad Feature" }],
    ["revision", { revision: "" }],
    ["revision", { revision: "r 1" }],
    ["logical_role", { logicalRole: "bad role" }],
    ["ledger_feature", { ledgerFeature: "" }],
    ["model", { model: "claude-haiku-5-5" }],
    ["model", { model: "gpt-unknown" }],
    ["reasoning_effort", { reasoningEffort: "turbo" as never }],
    ["max_output_tokens", { maxOutputTokens: 0 }],
    ["timeout", { timeoutMs: 10 }],
    ["max_attempts", { maxAttempts: 4 as never }],
    ["max_input_bytes", { maxInputBytes: 0 }],
    ["subject_kinds", { subjectKinds: [] }],
    ["subject_kinds", { subjectKinds: ["user", "user"] }],
    ["brand_required", { subjectKinds: ["system"], brandRequired: true }],
    ["system_instructions", { systemInstructions: " " }],
    ["validate", { validate: undefined as never }],
    ["schema", { schema: { name: "x", schema: { type: "string" } } }],
    ["max_cost", { maxCostUsdPerOperation: 0 }],
    ["max_cost", { maxCostUsdPerOperation: 1.5 }],
    ["cost_bound", { maxCostUsdPerOperation: 0.000001 }],
    ["cost_bound", { maxAttempts: 3, maxCostUsdPerOperation: 0.002 }],
  ];
  for (const [reason, over] of cases) {
    assert.throws(() => definePolicyRegistry([{ ...ok, ...over }]), (e: unknown) => e instanceof PolicyRegistryError && e.message.endsWith(`:${reason}`), `${reason} ${JSON.stringify(over)}`);
  }
  assert.throws(() => definePolicyRegistry([ok, { ...ok, revision: "r2" }]), /:duplicate$/);
  const registry = definePolicyRegistry([ok]);
  assert.equal(registry.size, 1);
  assert.equal(Object.isFrozen(registry.get("postona:ideas")), true);
  assert.equal(registry.get("postona:ideas") === ok, false, "a frozen copy, not the caller's object");
});

Deno.test("end to end, both providers: claim -> reserve -> mark_sent -> ONE request -> settle -> complete; replay from a NEW runtime sends nothing; only the provider key name is read", async () => {
  for (const [label, credential, request, provider] of [["openai", "jwt-a", ideas(), "openai"], ["anthropic", "jwt-a", consult(), "anthropic"], ["kabumori system", "cron-kabumori", report, "anthropic"]] as const) {
    const w = world();
    const r = await w.run(credential, request);
    assert.equal(r.ok, true, label);
    assert.deepEqual(w.supabase.calls, ["claim", "reserve", "mark_sent", "settle", "complete"], label);
    assert.equal(w.provider.calls.length, 1, label);
    assert.equal(w.provider.calls[0].url.includes(provider), true, label);
    assert.deepEqual([...new Set(w.envReads)], [provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"], `${label}: least privilege`);
    const again = world({ supabase: w.supabase });
    assert.deepEqual(await again.run(credential, request), r, label);
    assert.equal(again.provider.calls.length, 0, `${label}: replay sends nothing`);
    assert.deepEqual(w.supabase.calls.slice(5), ["claim"], label);
    // Keys stay where they belong: the service key only in Supabase requests, the provider key never there.
    const providerText = JSON.stringify(w.provider.calls.map((c) => [c.body, [...c.headers]]));
    assert.equal(providerText.includes(SERVICE_KEY), false, label);
    const supabaseText = JSON.stringify(w.supabase.requests.map((c) => [c.body, [...c.headers]]));
    assert.equal(supabaseText.includes(FAKE_OPENAI_KEY) || supabaseText.includes(FAKE_ANTHROPIC_KEY), false, label);
  }
});

Deno.test("the call store row carries the claim identity (app, app:feature, subject, brand slug as display only) and the nine-key audit", async () => {
  const w = world();
  const r = await w.run("jwt-a", consult());
  assert.equal(r.ok, true);
  const claim = w.supabase.requests.find((q) => q.url.endsWith("ai_calls_claim"))!.body as { p: Record<string, unknown> };
  assert.deepEqual(Object.keys(claim.p).sort(), ["application", "brand_ref", "call_key", "feature", "fingerprint", "subject_kind", "tenant_tag", "user_id"]);
  assert.deepEqual([claim.p.application, claim.p.feature, claim.p.subject_kind, claim.p.user_id, claim.p.brand_ref], ["postona", "postona:consult", "user", USER_A, BRAND_A.slug]);
  const complete = w.supabase.requests.find((q) => q.url.endsWith("ai_calls_complete"))!.body as { p: { result: { audit: Record<string, unknown> } } };
  assert.deepEqual(Object.keys(complete.p.result.audit).sort(), ["attempts", "callId", "costBasis", "estimatedCostUsd", "feature", "model", "policyVersion", "role", "tenantTag"]);
  const reserve = w.supabase.requests.find((q) => q.url.endsWith("ai_ledger_reserve"))!.body as { p: Record<string, unknown> };
  assert.deepEqual([reserve.p.request_id, reserve.p.user_id, "brand_id" in reserve.p], [r.audit!.callKey, USER_A, false]);
  const system = world();
  assert.equal((await system.run("cron-kabumori", report)).ok, true);
  const sysClaim = system.supabase.requests.find((q) => q.url.endsWith("ai_calls_claim"))!.body as { p: Record<string, unknown> };
  assert.deepEqual([sysClaim.p.subject_kind, "user_id" in sysClaim.p, "brand_ref" in sysClaim.p], ["system", false, false]);
});

Deno.test("the authority port: expired, denied, unreachable, revoked at recheck, a new epoch or another subject -> nothing sent", async () => {
  for (const credential of ["jwt-expired", "jwt-denied", "jwt-down"]) {
    const w = world();
    const r = await w.run(credential, ideas());
    assert.deepEqual([code(r), w.provider.calls.length, w.supabase.calls.length], [{ "jwt-expired": "AUTH_EXPIRED", "jwt-denied": "AUTH_DENIED", "jwt-down": "AUTH_UNAVAILABLE" }[credential], 0, 0], credential);
  }
  const rechecks: Array<[string, (p: AuthVerdict) => AuthVerdict | Error]> = [
    ["revoked", (p) => ({ ...p, decision: "deny" })],
    ["expired", (p) => ({ ...p, expiresAtMs: Date.now() - 1 })],
    ["epoch", (p) => ({ ...p, generation: "epoch-2" })],
    ["subject", (p) => ({ ...p, subject: user(USER_B, BRAND_A) })],
    ["unreachable", () => new Error("down")],
  ];
  for (const [label, answer] of rechecks) {
    const w = world();
    w.authority.recheckAnswer = answer;
    const r = await w.run("jwt-a", ideas());
    assert.deepEqual([code(r), w.provider.calls.length], ["AUTH_REVOKED_BEFORE_SEND", 0], label);
    assert.deepEqual(w.supabase.calls, ["claim", "reserve", "release", "complete"], label);
    assert.deepEqual([...w.supabase.reservations.values()], ["released"], label);
  }
});

Deno.test("call store failures: claim unreachable / failing / answering nonsense -> STORE_UNAVAILABLE before any reservation or send; complete failing -> UNKNOWN after ONE send, never resent", async () => {
  for (const fault of ["network", 500, "bad", "error-ok"] as const) {
    const w = world();
    w.supabase.fault = { ai_calls_claim: fault };
    const r = await w.run("jwt-a", ideas());
    assert.deepEqual([code(r), w.provider.calls.length, w.supabase.calls], ["STORE_UNAVAILABLE", 0, ["claim"]], String(fault));
  }
  for (const fault of ["network", 500, "bad", "lost", "error-ok"] as const) {
    const w = world();
    w.supabase.fault = { ai_calls_complete: fault };
    const r = await w.run("jwt-a", ideas());
    assert.deepEqual([code(r), w.provider.calls.length], ["UNKNOWN", 1], String(fault));
    w.supabase.fault = {};
    const again = await w.run("jwt-a", ideas());
    assert.equal(w.provider.calls.length, 1, `${fault}: never resent`);
    // "lost": the row WAS written and only the answer was lost -> the stored answer is served; otherwise in progress.
    assert.equal(code(again), fault === "lost" || fault === "error-ok" ? "OK" : "IN_PROGRESS", String(fault));
  }
});

Deno.test("the ledger: a budget limit is QUOTA_EXCEEDED, an outage LEDGER_UNAVAILABLE (nothing sent either way); a failed settle keeps the ledger 'sent' (it stays the source of truth)", async () => {
  const q = world();
  q.supabase.fault = { ai_ledger_reserve: "deny:CALL_LIMIT" };
  assert.deepEqual([code(await q.run("jwt-a", ideas())), q.provider.calls.length], ["QUOTA_EXCEEDED", 0]);
  for (const fault of ["network", 503] as const) {
    const w = world();
    w.supabase.fault = { ai_ledger_reserve: fault };
    assert.deepEqual([code(await w.run("jwt-a", ideas())), w.provider.calls.length], ["LEDGER_UNAVAILABLE", 0], String(fault));
    w.supabase.fault = {};
    assert.deepEqual([code(await w.run("jwt-a", ideas())), w.provider.calls.length], ["NOT_SENT", 0], `${fault}: the same operation never sends`);
    assert.deepEqual([code(await w.run("jwt-a", ideas({ operationId: "op-runtime-0003" }))), w.provider.calls.length], ["OK", 1], `${fault}: a new one does`);
  }
  const m = world();
  m.supabase.fault = { ai_ledger_mark_sent: "lost" };
  assert.deepEqual([code(await m.run("jwt-a", ideas())), m.provider.calls.length], ["LEDGER_UNAVAILABLE", 0]);
  assert.deepEqual([...m.supabase.reservations.values()], ["released"], "the fake applies release; the real ledger refuses it on a sent row (PG test)");
  const s = world();
  s.supabase.fault = { ai_ledger_settle: 500 };
  const r = await s.run("jwt-a", ideas());
  assert.deepEqual([code(r), s.provider.calls.length, [...s.supabase.reservations.values()]], ["OK", 1, ["sent"]]);
});

Deno.test("idempotency and separation: parallel duplicates send once, other content is OPERATION_REUSED, another person / brand / app is another call, a new policy revision is not replayed", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const p = world({ respond: async (call) => (await gate, reply("どうぞ")(call)) });
  const first = p.run("jwt-a", ideas());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await p.run("jwt-a", ideas());
  release();
  assert.deepEqual([code(second), code(await first), p.provider.calls.length], ["IN_PROGRESS", "OK", 1]);
  assert.equal(code(await p.run("jwt-a", ideas({ input: "別の内容" }))), "OPERATION_REUSED");
  const keys = new Set<string>();
  const s = world();
  for (const credential of ["jwt-a", "jwt-a-b", "jwt-b"]) {
    const brand = credential === "jwt-a-b" ? BRAND_B : BRAND_A;
    const r = await s.run(credential, consult({ operationId: "op-shared-0001", brand }));
    assert.equal(r.ok, true, credential);
    keys.add(r.audit!.callKey);
  }
  assert.deepEqual([keys.size, s.provider.calls.length], [3, 3]);
  const bumped = world({ supabase: s.supabase, registry: definePolicyRegistry(POLICIES.map((x) => x.feature === "consult" ? { ...x, revision: "r2" } : x)) });
  assert.deepEqual([code(await bumped.run("jwt-a", consult({ operationId: "op-shared-0001" }))), bumped.provider.calls.length], ["OPERATION_REUSED", 0]);
  // A request for another app's feature with this verdict is refused before anything (the verdict is for postona).
  const x = world();
  assert.deepEqual([code(await x.run("jwt-a", report)), x.supabase.calls.length, x.provider.calls.length], ["AUTH_SCOPE_MISMATCH", 0, 0]);
});

Deno.test("provider behaviour through the runtime: a refused attempt is retried with a new reservation; 504 is UNKNOWN once; 400 is final", async () => {
  const r = world({ respond: (call, i) => i === 0 ? jsonResponse(429, { error: { type: "rate_limit_error" } }) : reply("どうぞ")(call) });
  const ok = await r.run("jwt-a", { app: "postona", feature: "retry", operationId: "op-retry-00001", input: "x", brand: BRAND_A });
  assert.deepEqual([code(ok), r.provider.calls.length, r.supabase.calls], ["OK", 2, ["claim", "reserve", "mark_sent", "settle", "reserve", "mark_sent", "settle", "complete"]]);
  const u = world({ respond: (call) => call.url.includes("anthropic") ? jsonResponse(504, anthropicError(504, "timeout_error", "late")) : jsonResponse(504, { error: { type: "timeout" } }) });
  const unknown = await u.run("jwt-a", consult());
  assert.deepEqual([code(unknown), unknown.audit?.costBasis, u.provider.calls.length, [...u.supabase.reservations.values()]], ["UNKNOWN", "includes_upper_bound", 1, ["unknown"]]);
  const f = world({ respond: () => jsonResponse(400, { error: { type: "invalid_request_error" } }) });
  assert.deepEqual([code(await f.run("jwt-a", ideas())), f.provider.calls.length], ["PROVIDER_FAILED", 1]);
  assert.deepEqual([code(await f.run("jwt-a", ideas())), f.provider.calls.length], ["PROVIDER_FAILED", 1]);
});

Deno.test("runtime sources are Edge-compatible and least-privilege: no Deno / console / node / process.env, imports only the gateway, the store, the registry and named provider files", async () => {
  const allowed = new Set([
    "./gateway.ts",
    "./ai_calls_store.ts",
    "./policy_registry.ts",
    "../functions/_shared/ai_provider/mod.ts",
    "../functions/_shared/ai_provider/adapter.ts",
    "../functions/_shared/ai_provider/redact.ts",
    "../functions/_shared/ai_provider/secrets.ts",
  ]);
  const dir = new URL("../ai_gateway/", import.meta.url);
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) files.push(e.name);
  // G6-02 adds the app policy catalog and the G5 authority port (same rules: no runtime API, named imports only).
  assert.deepEqual(files.sort(), ["ai_calls_store.ts", "app_policies.ts", "authority_port.ts", "gateway.ts", "policy_registry.ts", "runtime.ts"]);
  for (const name of files) {
    const text = await Deno.readTextFile(new URL(name, dir));
    assert.doesNotMatch(text, /\bDeno\.|\bprocess\.env|\bconsole\.|from\s+["']node:|import\(/u, name);
    assert.doesNotMatch(text, /sk-ant-|sk-proj-|sb_secret_[A-Za-z0-9]{8}/u, `${name}: no key-shaped literal`);
    for (const m of text.matchAll(/(?:import|export)[^;]*?from\s+["']([^"']+)["']/gu)) assert.ok(allowed.has(m[1]), `${name}: ${m[1]}`);
  }
});
