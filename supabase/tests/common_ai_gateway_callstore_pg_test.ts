// Disposable-PostgreSQL conformance of the cross-app common AI gateway (PR284 reference, unchanged) against the REAL
// ledger migration (20261010050613) and the REAL call store migration (20261017120000, ai_calls), with the REAL
// SupabaseLedgerBudgetGuard and the REAL provider adapters (OpenAI and Anthropic). Test-only adapters: two CallStores
// over the public.ai_calls_* RPCs (a direct one and an audit-mapping one) and a fetch that turns the guard's PostgREST
// requests into the same RPCs; both run psql AS service_role on the local socket the runner gives. The providers are
// fake fetches: no network, fake keys. Tests named "GAP-n" pin a current behaviour recorded as a gap in
// docs/ai-provider/F6_GATEWAY_PROVIDER_LEDGER_CALLSTORE_CONFORMANCE.md.
// Run by supabase/tests/common_ai_gateway_callstore_pg_run.sh; skipped when its environment is absent.
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { resolveSecret, SupabaseLedgerBudgetGuard } from "../functions/_shared/ai_provider/mod.ts";
import { anthropicBody, FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody, recordingFetch, type Responder } from "../functions/_shared/ai_provider/test_support.ts";
import {
  type AppId,
  type AuthorityPort,
  type AuthVerdict,
  type CallClaim,
  type CallIdentity,
  type CallStore,
  type FeaturePolicy,
  gatewayExecute,
  type GatewayAudit,
  type GatewaySubject,
  policyKey,
  type StoredOutcome,
} from "./common_ai_cross_app_gateway_reference.ts";

const HOST = Deno.env.get("GWC_PGHOST");
const PORT = Deno.env.get("GWC_PGPORT");
const SUPER = Deno.env.get("GWC_PGSUPER");
const DB = Deno.env.get("GWC_DB");
const enabled = !!HOST && !!PORT && !!SUPER && !!DB && /^\/(private\/)?tmp\//.test(HOST);
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };

type Provider = "openai" | "anthropic";
const MODEL: Record<Provider, string> = { openai: "gpt-6-luna", anthropic: "claude-haiku-5-5" };
const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
const BRAND_A = { app: "postona" as const, slug: "u_ae343f5caedb67d4af33fc7a" };
const BRAND_A2 = { app: "postona" as const, slug: "u_0b1c2d3e4f5061728394a5b6" };
const HOUR = 3_600_000;
const POLICY_VERSION = "gateway-ref-2026-10-19";

async function psql(statement: string): Promise<{ ok: boolean; out: string; err: string }> {
  const output = await new Deno.Command("psql", {
    args: ["-X", "-h", HOST!, "-p", PORT!, "-U", SUPER!, "-d", DB!, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
  return { ok: output.success, out: decode(output.stdout), err: decode(output.stderr) };
}
function literal(json: unknown): string {
  const text = JSON.stringify(json);
  if (text.includes("$gwc$")) throw new Error("payload contains the quote tag");
  return `$gwc$${text}$gwc$::jsonb`;
}
/** A public RPC called AS service_role, as PostgREST would. */
async function rpc(name: string, p: unknown): Promise<unknown> {
  if (!/^ai_(calls|ledger)_[a-z_]+$/.test(name)) throw new Error("unexpected rpc");
  const result = await psql(`set role service_role; select public.${name}(${literal(p)})`);
  if (!result.ok) throw new Error(`RPC_FAILED:${name}:${result.err.split("\n")[0]}`);
  return JSON.parse(result.out);
}
async function rows(sql: string): Promise<string> {
  const result = await psql(sql);
  assert.ok(result.ok, result.err);
  return result.out;
}

/** The guard's PostgREST request -> the same RPC through psql (never a network request). */
const ledgerFetch: FetchLike = async (input, init) => {
  const match = new URL(String(input)).pathname.match(/^\/rest\/v1\/rpc\/(ai_ledger_[a-z_]+)$/);
  if (!match || init?.method !== "POST") return new Response("{}", { status: 404 });
  try {
    const body = JSON.parse(String(init.body)) as { p: unknown };
    return new Response(JSON.stringify(await rpc(match[1], body.p)), { status: 200, headers: { "content-type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ code: "P0001" }), { status: 400 });
  }
};

function claimParams(identity: CallIdentity, context: { app: AppId; feature: string; subject: GatewaySubject }) {
  const s = context.subject;
  return {
    call_key: identity.key,
    tenant_tag: identity.tenantTag,
    fingerprint: identity.fingerprint,
    application: context.app,
    feature: policyKey(context.app, context.feature),
    subject_kind: s.kind,
    ...(s.kind === "user" ? { user_id: s.userId, ...(s.brand ? { brand_ref: s.brand.slug } : {}) } : {}),
  };
}

/** GAP-3 probe: hands the gateway's own outcome to ai_calls unchanged. */
class DirectSqlStore implements CallStore {
  async claim(identity: CallIdentity, context: { app: AppId; feature: string; subject: GatewaySubject }): Promise<CallClaim> {
    const c = await rpc("ai_calls_claim", claimParams(identity, context)) as Record<string, unknown>;
    return c.kind === "complete" ? { kind: "complete", fingerprint: String(c.fingerprint), outcome: c.result as StoredOutcome } : c as CallClaim;
  }
  async complete(identity: CallIdentity, owner: string, outcome: StoredOutcome): Promise<void> {
    await rpc("ai_calls_complete", { call_key: identity.key, tenant_tag: identity.tenantTag, fingerprint: identity.fingerprint, owner, result: outcome });
  }
}

/**
 * Test adapter that makes the gateway outcome storable: GatewayAudit (8 keys) <-> the store's 9-key Audit. The store
 * needs role and policyVersion, which the gateway outcome does not carry; this adapter supplies them from the policy
 * registry and a fixed version (GAP-3). It is a proof of the SQL contract, not the store to ship.
 */
class MappedSqlStore implements CallStore {
  loseNextComplete: "before_write" | "after_write" | null = null;
  constructor(private readonly policies: ReadonlyMap<string, FeaturePolicy>) {}
  private context = new Map<string, { app: AppId; feature: string }>();
  static toStore(a: GatewayAudit, role: string, ledgerKey: string) {
    return {
      callId: a.callKey,
      tenantTag: a.tenantTag,
      feature: ledgerKey,
      role,
      model: a.model,
      policyVersion: POLICY_VERSION,
      attempts: a.attempts,
      estimatedCostUsd: a.estimatedCostUsd,
      costBasis: a.costBasis,
    };
  }
  async claim(identity: CallIdentity, context: { app: AppId; feature: string; subject: GatewaySubject }): Promise<CallClaim> {
    this.context.set(identity.key, { app: context.app, feature: context.feature });
    const c = await rpc("ai_calls_claim", claimParams(identity, context)) as Record<string, unknown>;
    if (c.kind !== "complete") return c as CallClaim;
    const r = c.result as { ok: boolean; data?: unknown; code?: string; audit: Record<string, unknown> };
    const audit: GatewayAudit = {
      callKey: String(r.audit.callId),
      tenantTag: String(r.audit.tenantTag),
      app: context.app,
      feature: context.feature,
      model: String(r.audit.model),
      attempts: Number(r.audit.attempts),
      estimatedCostUsd: Number(r.audit.estimatedCostUsd),
      costBasis: r.audit.costBasis as GatewayAudit["costBasis"],
    };
    const outcome = (r.ok ? { ok: true, data: r.data, audit } : { ok: false, code: r.code, audit }) as StoredOutcome;
    return { kind: "complete", fingerprint: String(c.fingerprint), outcome };
  }
  async complete(identity: CallIdentity, owner: string, outcome: StoredOutcome): Promise<void> {
    if (this.loseNextComplete === "before_write") {
      this.loseNextComplete = null;
      throw new Error("response_lost");
    }
    const ctx = this.context.get(identity.key)!;
    const key = policyKey(ctx.app, ctx.feature);
    const audit = MappedSqlStore.toStore(outcome.audit, this.policies.get(key)!.logicalRole, key);
    const result = outcome.ok ? { ok: true, data: outcome.data, audit } : { ok: false, code: outcome.code, audit };
    await rpc("ai_calls_complete", { call_key: identity.key, tenant_tag: identity.tenantTag, fingerprint: identity.fingerprint, owner, result });
    if (this.loseNextComplete === "after_write") {
      this.loseNextComplete = null;
      throw new Error("response_lost");
    }
  }
}

const SCHEMA = { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } };
function policy(app: AppId, feature: string, provider: Provider, over: Partial<FeaturePolicy> = {}): FeaturePolicy {
  return {
    app,
    feature,
    ledgerFeature: feature,
    logicalRole: `${app}.${feature}`,
    provider,
    model: MODEL[provider],
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
const POLICIES = new Map<string, FeaturePolicy>([
  [policyKey("postona", "consult"), policy("postona", "consult", "anthropic", { brandRequired: true })],
  [policyKey("postona", "ideas"), policy("postona", "ideas", "openai")],
  [policyKey("postona", "quota"), policy("postona", "quota", "openai")],
  [policyKey("kabumori", "market_report"), policy("kabumori", "market_report", "anthropic", { subjectKinds: ["system"] })],
]);

const user = (userId: string, brand: typeof BRAND_A | null): GatewaySubject => ({ kind: "user", app: "postona", userId, brand });
const allow = (subject: GatewaySubject): AuthVerdict => ({ decision: "allow", subject, generation: "epoch-1", expiresAtMs: Date.now() + HOUR });
const VERDICTS: Record<string, AuthVerdict> = {
  "jwt-a": allow(user(USER_A, BRAND_A)),
  "jwt-a2": allow(user(USER_A, BRAND_A2)),
  "jwt-b": allow(user(USER_B, BRAND_A)),
  "cron-kabumori": allow({ kind: "system", app: "kabumori" }),
};
class Authority implements AuthorityPort {
  revokeOnRecheck = false;
  verdict(credential: unknown): Promise<AuthVerdict> {
    return Promise.resolve(structuredClone(VERDICTS[String(credential)]));
  }
  recheck(prior: AuthVerdict): Promise<AuthVerdict> {
    return Promise.resolve(this.revokeOnRecheck ? { ...prior, decision: "deny" } : structuredClone(prior));
  }
}

const okBody = (reply: string): Responder => (call) =>
  String(call.url).includes("anthropic")
    ? jsonResponse(200, anthropicBody({ reply }, { model: MODEL.anthropic }))
    : jsonResponse(200, openAiBody({ reply }, { model: MODEL.openai }));

function world(options: { respond?: Responder; store?: "direct" | "mapped"; authority?: Authority } = {}) {
  const net = recordingFetch(options.respond ?? okBody("どうぞ"));
  const key = resolveSecret("GWC_LEDGER_KEY", () => "local-gwc-key-not-a-secret");
  assert.ok(key.ok);
  const store = options.store === "direct" ? new DirectSqlStore() : new MappedSqlStore(POLICIES);
  const authority = options.authority ?? new Authority();
  const deps = {
    authority,
    policies: POLICIES,
    provider: {
      readEnv: (name: string) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
      fetch: net.fetch,
      retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
      sleep: () => Promise.resolve(),
      random: () => 0,
    },
    budget: new SupabaseLedgerBudgetGuard({ supabaseUrl: "http://127.0.0.1:9", serviceKey: key.value, fetch: ledgerFetch }),
    store,
  };
  const run = (credential: string, request: Record<string, unknown>) => gatewayExecute(deps, credential, request);
  return { run, net, store, authority };
}
const consult = (over: Record<string, unknown> = {}) => ({ app: "postona", feature: "consult", operationId: "op-consult-0001", input: "今日何投稿しよう", brand: BRAND_A, ...over });
const ideas = (over: Record<string, unknown> = {}) => ({ app: "postona", feature: "ideas", operationId: "op-ideas-00001", input: "アイデア", brand: BRAND_A, ...over });

Deno.test({ name: "setup: fully scoped ledger policies per app / feature / provider / model / subject", ...opts }, async () => {
  await rows(`insert into ai_ledger.budget_policies
    (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
    values ('gwc.postona.consult.user.daily', 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', true, 'day', 100, 1, 0.05),
           ('gwc.postona.ideas.user.daily', 'openai', 'gpt-6-luna', 'postona', 'ideas', 'user', true, 'day', 100, 1, 0.05),
           ('gwc.postona.quota.user.daily', 'openai', 'gpt-6-luna', 'postona', 'quota', 'user', true, 'day', 1, 1, 0.05),
           ('gwc.kabumori.market_report.system.daily', 'anthropic', 'claude-haiku-5-5', 'kabumori', 'market_report', 'system', false, 'day', 10, 1, 0.05)`);
});

Deno.test({ name: "GAP-3: the gateway's own outcome is not a shape ai_calls stores -> UNKNOWN after ONE send, the row stays acquired (IN_PROGRESS) until recovery; never resent", ...opts }, async () => {
  const w = world({ store: "direct" });
  const first = await w.run("jwt-a", ideas({ operationId: "op-gap3-000001" }));
  assert.deepEqual([first.ok, !first.ok && first.code], [false, "UNKNOWN"]);
  const callKey = first.audit!.callKey;
  assert.equal(await rows(`select state from ai_calls.consumer_calls where call_key = '${callKey}'`), "acquired");
  assert.equal(await rows(`select status from ai_ledger.reservations where request_id = '${callKey}'`), "settled", "the ledger charged the one request");
  const again = await w.run("jwt-a", ideas({ operationId: "op-gap3-000001" }));
  assert.deepEqual([again.ok, !again.ok && again.code], [false, "IN_PROGRESS"]);
  assert.equal(w.net.calls.length, 1);
});

Deno.test({ name: "mapped store: one operation = one ai_calls row + one ledger reservation under the same key, for both providers; a new gateway instance replays without sending", ...opts }, async () => {
  for (const [label, req, credential] of [["openai ideas", ideas(), "jwt-a"], ["anthropic consult", consult(), "jwt-a"], ["anthropic kabumori system", { app: "kabumori", feature: "market_report", operationId: "run-2026-10-19-close", input: "市況", brand: null }, "cron-kabumori"]] as const) {
    const w = world();
    const r = await w.run(credential, req);
    assert.equal(r.ok, true, label);
    const k = r.audit!.callKey;
    assert.match(k, /^h5m2_[0-9a-f]{64}$/);
    const system = credential === "cron-kabumori";
    assert.equal(
      await rows(`select state || '|' || application || '|' || feature || '|' || subject_kind || '|' || coalesce(user_id::text, '-') || '|' || coalesce(brand_ref, '-') from ai_calls.consumer_calls where call_key = '${k}'`),
      `complete|${req.app}|${req.app}:${req.feature}|${system ? "system" : "user"}|${system ? "-" : USER_A}|${system ? "-" : BRAND_A.slug}`,
      label,
    );
    assert.equal(
      await rows(`select count(*) || '|' || min(status) || '|' || min(application) || '|' || min(feature) || '|' || coalesce(min(user_id::text), '-') || '|' || coalesce(min(brand_id::text), '-') from ai_ledger.reservations where request_id = '${k}'`),
      `1|settled|${req.app}|${req.feature}|${system ? "-" : USER_A}|-`,
      `${label}: ledger row under the same key, person only, no brand id`,
    );
    const replay = await world().run(credential, req);
    assert.deepEqual(replay, r, label);
    assert.equal(w.net.calls.length, 1, label);
    assert.equal(String(w.net.calls[0].url).includes(r.audit!.model.startsWith("claude") ? "anthropic" : "openai"), true, label);
  }
});

Deno.test({ name: "mapped store: other content under the same operation id -> OPERATION_REUSED; parallel duplicates -> ONE request, the other IN_PROGRESS", ...opts }, async () => {
  const w = world();
  assert.equal((await w.run("jwt-a", ideas({ operationId: "op-drift-00001" }))).ok, true);
  const drift = await w.run("jwt-a", ideas({ operationId: "op-drift-00001", input: "別の内容" }));
  assert.deepEqual([drift.ok, !drift.ok && drift.code, w.net.calls.length], [false, "OPERATION_REUSED", 1]);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const p = world({ respond: async (c, i, init) => (await gate, okBody("どうぞ")(c, i, init)) });
  const first = p.run("jwt-a", ideas({ operationId: "op-parallel-01" }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await p.run("jwt-a", ideas({ operationId: "op-parallel-01" }));
  release();
  assert.deepEqual([second.ok, !second.ok && second.code], [false, "IN_PROGRESS"]);
  assert.equal((await first).ok, true);
  assert.equal(p.net.calls.length, 1);
});

Deno.test({ name: "mapped store: the same operation id for another person / brand is another row, another ledger key, its own charge", ...opts }, async () => {
  const keys: string[] = [];
  for (const credential of ["jwt-a", "jwt-a2", "jwt-b"]) {
    const brand = credential === "jwt-a2" ? BRAND_A2 : BRAND_A;
    const r = await world().run(credential, consult({ operationId: "op-shared-0001", brand }));
    assert.equal(r.ok, true, credential);
    keys.push(r.audit!.callKey);
  }
  assert.equal(new Set(keys).size, 3);
  assert.equal(await rows(`select count(*) from ai_calls.consumer_calls where call_key in ('${keys.join("','")}')`), "3");
  assert.equal(await rows(`select count(distinct request_id) from ai_ledger.reservations where request_id in ('${keys.join("','")}') and status = 'settled'`), "3");
  assert.equal(await rows(`select user_id from ai_calls.consumer_calls where call_key = '${keys[2]}'`), USER_B);
});

Deno.test({ name: "mapped store: revoked before the send -> nothing sent, the ledger reservation is released (no usage row), POLICY_DENIED stored, replay NOT_SENT", ...opts }, async () => {
  const authority = new Authority();
  authority.revokeOnRecheck = true;
  const w = world({ authority });
  const r = await w.run("jwt-a", ideas({ operationId: "op-revoked-001" }));
  assert.deepEqual([r.ok, !r.ok && r.code, r.audit?.costBasis], [false, "AUTH_REVOKED_BEFORE_SEND", "no_request"]);
  const k = r.audit!.callKey;
  assert.equal(await rows(`select status from ai_ledger.reservations where request_id = '${k}'`), "released");
  assert.equal(await rows(`select count(*) from ai_ledger.usage_events where request_id = '${k}'`), "0");
  assert.equal(await rows(`select result ->> 'code' from ai_calls.consumer_calls where call_key = '${k}'`), "POLICY_DENIED");
  authority.revokeOnRecheck = false;
  const replay = await w.run("jwt-a", ideas({ operationId: "op-revoked-001" }));
  assert.deepEqual([replay.ok, !replay.ok && replay.code], [false, "NOT_SENT"]);
  assert.equal(w.net.calls.length, 0);
});

Deno.test({ name: "mapped store: the ledger's daily limit -> QUOTA_EXCEEDED before any request (no reservation), stored BUDGET_DENIED and replayed", ...opts }, async () => {
  const w = world();
  assert.equal((await w.run("jwt-a", { app: "postona", feature: "quota", operationId: "op-quota-00001", input: "1", brand: BRAND_A })).ok, true);
  const denied = await w.run("jwt-a", { app: "postona", feature: "quota", operationId: "op-quota-00002", input: "2", brand: BRAND_A });
  assert.deepEqual([denied.ok, !denied.ok && denied.code, denied.audit?.attempts], [false, "QUOTA_EXCEEDED", 0]);
  assert.equal(await rows(`select count(*) from ai_ledger.reservations where request_id = '${denied.audit!.callKey}'`), "0");
  assert.equal(await rows(`select result ->> 'code' from ai_calls.consumer_calls where call_key = '${denied.audit!.callKey}'`), "BUDGET_DENIED");
  const replay = await w.run("jwt-a", { app: "postona", feature: "quota", operationId: "op-quota-00002", input: "2", brand: BRAND_A });
  assert.deepEqual([replay.ok, !replay.ok && replay.code], [false, "QUOTA_EXCEEDED"]);
  assert.equal(w.net.calls.length, 1);
});

Deno.test({ name: "mapped store, both providers: 504 -> UNKNOWN at the upper bound in the ledger and the store; replay never resends", ...opts }, async () => {
  for (const req of [ideas({ operationId: "op-504-openai1" }), consult({ operationId: "op-504-claude1" })]) {
    const w = world({ respond: () => jsonResponse(504, { type: "error", error: { type: "timeout_error", message: "late" } }) });
    const first = await w.run("jwt-a", req);
    assert.deepEqual([first.ok, !first.ok && first.code, first.audit?.costBasis], [false, "UNKNOWN", "includes_upper_bound"]);
    const k = first.audit!.callKey;
    assert.equal(await rows(`select status from ai_ledger.reservations where request_id = '${k}'`), "unknown");
    assert.equal(await rows(`select cost_basis from ai_ledger.usage_events where request_id = '${k}'`), "upper_bound");
    assert.equal(await rows(`select (result ->> 'code') || '|' || (audit ->> 'costBasis') from ai_calls.consumer_calls where call_key = '${k}'`), "UNKNOWN|includes_upper_bound");
    assert.deepEqual(await w.run("jwt-a", req), first);
    assert.equal(w.net.calls.length, 1);
  }
});

Deno.test({ name: "mapped store: a lost completion stays IN_PROGRESS until recovery abandons it with an audit that agrees with the ledger; then UNKNOWN, never resent", ...opts }, async () => {
  const w = world();
  (w.store as MappedSqlStore).loseNextComplete = "before_write";
  const lost = await w.run("jwt-a", ideas({ operationId: "op-lost-000001" }));
  assert.deepEqual([lost.ok, !lost.ok && lost.code], [false, "UNKNOWN"]);
  const busy = await w.run("jwt-a", ideas({ operationId: "op-lost-000001" }));
  assert.deepEqual([busy.ok, !busy.ok && busy.code], [false, "IN_PROGRESS"]);
  const k = lost.audit!.callKey;
  await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set created_at = created_at - interval '1 hour' where call_key = '${k}'`);
  const cost = Number(await rows(`select sum(estimated_cost_usd) from ai_ledger.usage_events where request_id = '${k}'`));
  // The gateway's audit, mapped as the store adapter would: the store checks it against the ledger.
  const audit = MappedSqlStore.toStore({ ...lost.audit!, attempts: 1, estimatedCostUsd: cost, costBasis: "measured" }, "postona.ideas", "postona:ideas");
  await assert.rejects(rpc("ai_calls_abandon", { call_key: k, audit: { ...audit, attempts: 0, costBasis: "no_request", estimatedCostUsd: 0 } }), /AUDIT_LEDGER_MISMATCH/);
  assert.ok(cost > 0);
  await assert.rejects(rpc("ai_calls_abandon", { call_key: k, audit: { ...audit, estimatedCostUsd: 0 } }), /AUDIT_LEDGER_MISMATCH/, "never less cost than the ledger charged");
  assert.deepEqual(await rpc("ai_calls_abandon", { call_key: k, audit }), { abandoned: true });
  const replay = await w.run("jwt-a", ideas({ operationId: "op-lost-000001" }));
  assert.deepEqual([replay.ok, !replay.ok && replay.code, replay.audit?.attempts], [false, "UNKNOWN", 1]);
  assert.equal(w.net.calls.length, 1);

  const v = world();
  (v.store as MappedSqlStore).loseNextComplete = "after_write";
  const lostAfter = await v.run("jwt-a", ideas({ operationId: "op-lost-000002" }));
  assert.deepEqual([lostAfter.ok, !lostAfter.ok && lostAfter.code], [false, "UNKNOWN"]);
  assert.equal((await v.run("jwt-a", ideas({ operationId: "op-lost-000002" }))).ok, true, "written before the response was lost: served");
  assert.equal(v.net.calls.length, 1);
});

Deno.test({ name: "code map: the six codes the gateway stores are all accepted by ai_calls; its seventh (MODEL_UNAVAILABLE) is never produced; the gateway's public codes are refused", ...opts }, async () => {
  const stored = ["POLICY_DENIED", "COST_DENIED", "BUDGET_DENIED", "OUTPUT_REJECTED", "PROVIDER_FAILED", "UNKNOWN"];
  const refused = ["QUOTA_EXCEEDED", "NOT_SENT", "AUTH_REVOKED_BEFORE_SEND", "IN_PROGRESS", "OPERATION_REUSED", "AUTH_DENIED"];
  let n = 0;
  for (const [code, accepted] of [...stored.map((c) => [c, true] as const), ...refused.map((c) => [c, false] as const)]) {
    const key = "h5m2_" + (++n).toString(16).padStart(64, "0");
    const tenant = "a".repeat(64);
    const fingerprint = "b".repeat(64);
    const claim = await rpc("ai_calls_claim", { call_key: key, tenant_tag: tenant, fingerprint, application: "postona", feature: "postona:ideas", subject_kind: "user", user_id: USER_A }) as { owner: string };
    const audit = { callId: key, tenantTag: tenant, feature: "postona:ideas", role: "postona.ideas", model: "gpt-6-luna", policyVersion: POLICY_VERSION, attempts: 0, estimatedCostUsd: 0, costBasis: "no_request" };
    const done = rpc("ai_calls_complete", { call_key: key, tenant_tag: tenant, fingerprint, owner: claim.owner, result: { ok: false, code, audit } });
    if (accepted) assert.deepEqual(await done, { state: "complete", duplicate: false }, code);
    else await assert.rejects(done, /AI_CALLS_INVALID_INPUT/, code);
  }
  // The audit shape (GAP-3): the gateway's own audit, the same with only the key renamed, or the store audit with the
  // gateway's app field added are all refused; only the exact 9-key store audit is accepted.
  const key = "h5m2_" + "f".repeat(64);
  const tenant = "c".repeat(64);
  const fingerprint = "d".repeat(64);
  const claim = await rpc("ai_calls_claim", { call_key: key, tenant_tag: tenant, fingerprint, application: "postona", feature: "postona:ideas", subject_kind: "user", user_id: USER_A }) as { owner: string };
  const gatewayAudit: GatewayAudit = { callKey: key, tenantTag: tenant, app: "postona", feature: "ideas", model: "gpt-6-luna", attempts: 0, estimatedCostUsd: 0, costBasis: "no_request" };
  const storeAudit = MappedSqlStore.toStore(gatewayAudit, "postona.ideas", "postona:ideas");
  const { callKey: _k, ...rest } = gatewayAudit;
  for (const [label, audit] of [
    ["gateway audit as is", gatewayAudit],
    ["key renamed only", { ...rest, callId: key, feature: "postona:ideas" }],
    ["store audit + app", { ...storeAudit, app: "postona" }],
  ] as const) {
    await assert.rejects(
      rpc("ai_calls_complete", { call_key: key, tenant_tag: tenant, fingerprint, owner: claim.owner, result: { ok: false, code: "POLICY_DENIED", audit } }),
      /AI_CALLS_INVALID_INPUT/,
      label,
    );
  }
  assert.deepEqual(
    await rpc("ai_calls_complete", { call_key: key, tenant_tag: tenant, fingerprint, owner: claim.owner, result: { ok: false, code: "POLICY_DENIED", audit: storeAudit } }),
    { state: "complete", duplicate: false },
  );
});
