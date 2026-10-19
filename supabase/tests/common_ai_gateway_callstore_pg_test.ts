// Disposable-PostgreSQL conformance of the cross-app common AI gateway (PR284 reference, unchanged) against the REAL
// ledger migration (20261010050613) and the REAL call store migration (20261017120000, ai_calls), with the REAL
// SupabaseLedgerBudgetGuard and the REAL provider adapters (OpenAI and Anthropic). Test-only adapters: a CallStore that
// hands the gateway's stored outcome to the public.ai_calls_* RPCs UNCHANGED (the gateway maps its audit to the store's
// nine keys itself since the GAP-3 fix) and a fetch that turns the guard's PostgREST requests into the same RPCs; both
// run psql AS service_role on the local socket the runner gives. The providers are fake fetches: no network, fake keys.
// "GAP-n fixed" tests assert the fixes of docs/ai-provider/F6_GATEWAY_GAP_FIXES.md against the real SQL.
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
  type ClaimContext,
  type FeaturePolicy,
  gatewayExecute,
  type GatewayAudit,
  type GatewaySubject,
  policyKey,
  type StoredOutcome,
  toStoreAudit,
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
const REVISION = "r2026-10-19";

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

/**
 * Test-only ledger faults: "down" fails an RPC before it runs; "lost" runs it (COMMITTED) and then loses the
 * response. Each fault applies to the named RPC `count` times.
 */
const ledgerFault: { rpc: string; mode: "down" | "lost"; count: number } = { rpc: "", mode: "down", count: 0 };
/** The guard's PostgREST request -> the same RPC through psql (never a network request). */
const ledgerFetch: FetchLike = async (input, init) => {
  const match = new URL(String(input)).pathname.match(/^\/rest\/v1\/rpc\/(ai_ledger_[a-z_]+)$/);
  if (!match || init?.method !== "POST") return new Response("{}", { status: 404 });
  const faulted = ledgerFault.count > 0 && ledgerFault.rpc === match[1];
  if (faulted) ledgerFault.count -= 1;
  if (faulted && ledgerFault.mode === "down") throw new TypeError("ledger unreachable");
  try {
    if (faulted) {
      await rpc(match[1], (JSON.parse(String(init.body)) as { p: unknown }).p);
      return new Response(JSON.stringify({ code: "504" }), { status: 504 });
    }
    const body = JSON.parse(String(init.body)) as { p: unknown };
    return new Response(JSON.stringify(await rpc(match[1], body.p)), { status: 200, headers: { "content-type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ code: "P0001" }), { status: 400 });
  }
};

function claimParams(identity: CallIdentity, context: ClaimContext) {
  const s = context.subject;
  return {
    call_key: identity.key,
    tenant_tag: identity.tenantTag,
    fingerprint: identity.fingerprint,
    application: context.app,
    feature: context.storeFeature,
    subject_kind: s.kind,
    ...(s.kind === "user" ? { user_id: s.userId, ...(s.brand ? { brand_ref: s.brand.slug } : {}) } : {}),
  };
}

/** The gateway's stored outcome goes to ai_calls unchanged; what the store returns goes back unchanged. */
class SqlCallStore implements CallStore {
  loseNextComplete: "before_write" | "after_write" | null = null;
  async claim(identity: CallIdentity, context: ClaimContext): Promise<CallClaim> {
    const c = await rpc("ai_calls_claim", claimParams(identity, context)) as Record<string, unknown>;
    return c.kind === "complete" ? { kind: "complete", fingerprint: String(c.fingerprint), outcome: c.result as StoredOutcome } : c as CallClaim;
  }
  async complete(identity: CallIdentity, owner: string, outcome: StoredOutcome): Promise<void> {
    if (this.loseNextComplete === "before_write") {
      this.loseNextComplete = null;
      throw new Error("response_lost");
    }
    await rpc("ai_calls_complete", { call_key: identity.key, tenant_tag: identity.tenantTag, fingerprint: identity.fingerprint, owner, result: outcome });
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
    revision: REVISION,
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
  /** Revoke from this recheck on (1-based); 0 = never. */
  revokeFrom = 0;
  private rechecks = 0;
  verdict(credential: unknown): Promise<AuthVerdict> {
    return Promise.resolve(structuredClone(VERDICTS[String(credential)]));
  }
  recheck(prior: AuthVerdict): Promise<AuthVerdict> {
    const n = ++this.rechecks;
    const revoke = this.revokeOnRecheck || (this.revokeFrom > 0 && n >= this.revokeFrom);
    return Promise.resolve(revoke ? { ...prior, decision: "deny" } : structuredClone(prior));
  }
}

const okBody = (reply: string): Responder => (call) =>
  String(call.url).includes("anthropic")
    ? jsonResponse(200, anthropicBody({ reply }, { model: MODEL.anthropic }))
    : jsonResponse(200, openAiBody({ reply }, { model: MODEL.openai }));

function world(options: { respond?: Responder; authority?: Authority; policies?: Map<string, FeaturePolicy> } = {}) {
  const net = recordingFetch(options.respond ?? okBody("どうぞ"));
  const key = resolveSecret("GWC_LEDGER_KEY", () => "local-gwc-key-not-a-secret");
  assert.ok(key.ok);
  const store = new SqlCallStore();
  const authority = options.authority ?? new Authority();
  const deps = {
    authority,
    policies: options.policies ?? POLICIES,
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

Deno.test({ name: "GAP-3 fixed (both providers): the gateway's stored outcome is accepted by ai_calls as is -> complete row with the nine-key audit; no UNKNOWN, nothing left in progress; replay rebuilds the same answer without sending", ...opts }, async () => {
  for (const [req, role, model] of [[ideas({ operationId: "op-gap3-000001" }), "postona.ideas", MODEL.openai], [consult({ operationId: "op-gap3-000002" }), "postona.consult", MODEL.anthropic]] as const) {
    const w = world();
    const first = await w.run("jwt-a", req);
    assert.equal(first.ok, true, model);
    const k = first.audit!.callKey;
    assert.equal(await rows(`select state from ai_calls.consumer_calls where call_key = '${k}'`), "complete");
    const audit = JSON.parse(await rows(`select audit::text from ai_calls.consumer_calls where call_key = '${k}'`));
    assert.deepEqual(audit, {
      callId: k,
      tenantTag: first.audit!.tenantTag,
      feature: `postona:${req.feature}`,
      role,
      model,
      policyVersion: REVISION,
      attempts: 1,
      estimatedCostUsd: first.audit!.estimatedCostUsd,
      costBasis: "measured",
    }, model);
    assert.ok(Number(await rows(`select sum(estimated_cost_usd) from ai_ledger.usage_events where request_id = '${k}'`)) <= audit.estimatedCostUsd + 1e-6, "the audit never shows less than the ledger");
    assert.deepEqual(await world().run("jwt-a", req), first, model);
    assert.equal(w.net.calls.length, 1);
  }
  assert.equal(await rows(`select count(*) from ai_calls.consumer_calls where state = 'acquired' and call_key in (select request_id from ai_ledger.reservations)`), "0");
});

Deno.test({ name: "GAP-3 fixed: a stored audit changed in the database (role / version / feature) replays as UNKNOWN, never resent; a new policy revision is OPERATION_REUSED", ...opts }, async () => {
  const w = world();
  const first = await w.run("jwt-a", ideas({ operationId: "op-gap3-tamper1" }));
  assert.equal(first.ok, true);
  const k = first.audit!.callKey;
  for (const [field, value] of [["role", "postona.consult"], ["policyVersion", "r0"]]) {
    await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set result = jsonb_set(result, '{audit,${field}}', '"${value}"') where call_key = '${k}'`);
    const r = await w.run("jwt-a", ideas({ operationId: "op-gap3-tamper1" }));
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "UNKNOWN"], field);
    await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set result = jsonb_set(result, '{audit}', audit) where call_key = '${k}'`);
  }
  assert.deepEqual(await w.run("jwt-a", ideas({ operationId: "op-gap3-tamper1" })), first, "restored row replays again");
  const bumped = new Map(POLICIES);
  bumped.set(policyKey("postona", "ideas"), { ...POLICIES.get(policyKey("postona", "ideas"))!, revision: "r2026-10-20" });
  const r = await world({ policies: bumped }).run("jwt-a", ideas({ operationId: "op-gap3-tamper1" }));
  assert.deepEqual([r.ok, !r.ok && r.code], [false, "OPERATION_REUSED"]);
  assert.equal(w.net.calls.length, 1);
});

Deno.test({ name: "GAP-1 fixed (real SQL, both providers): revoked before the second attempt -> AUTH_REVOKED_BEFORE_SEND; first reservation settled at 0, second released; POLICY_DENIED stored with attempts 1; replay NOT_SENT", ...opts }, async () => {
  const twoAttempts = new Map(POLICIES);
  for (const key of [policyKey("postona", "ideas"), policyKey("postona", "consult")]) twoAttempts.set(key, { ...POLICIES.get(key)!, maxAttempts: 2 });
  for (const req of [ideas({ operationId: "op-gap1-openai1" }), consult({ operationId: "op-gap1-claude1" })]) {
    const authority = new Authority();
    authority.revokeFrom = 2;
    const w = world({
      authority,
      policies: twoAttempts,
      respond: (call) => String(call.url).includes("anthropic") ? jsonResponse(429, { type: "error", error: { type: "rate_limit_error", message: "x" } }) : jsonResponse(429, { error: { type: "rate_limit_error" } }),
    });
    const r = await w.run("jwt-a", req);
    assert.deepEqual([r.ok, !r.ok && r.code, r.audit?.attempts, r.audit?.costBasis], [false, "AUTH_REVOKED_BEFORE_SEND", 1, "measured"], req.feature);
    const k = r.audit!.callKey;
    assert.equal(await rows(`select string_agg(attempt || ':' || status, ',' order by attempt) from ai_ledger.reservations where request_id = '${k}'`), "1:settled,2:released");
    assert.equal(await rows(`select (result ->> 'code') || '|' || (audit ->> 'attempts') from ai_calls.consumer_calls where call_key = '${k}'`), "POLICY_DENIED|1");
    const replay = await world({ policies: twoAttempts }).run("jwt-a", req);
    assert.deepEqual([replay.ok, !replay.ok && replay.code], [false, "NOT_SENT"]);
    assert.equal(w.net.calls.length, 1);
  }
});

Deno.test({ name: "GAP-2 fixed (real SQL): the ledger unreachable -> LEDGER_UNAVAILABLE, nothing sent, no reservation; same operation NOT_SENT after recovery; a new operation goes through", ...opts }, async () => {
  for (const rpcName of ["ai_ledger_reserve", "ai_ledger_mark_sent"]) {
    Object.assign(ledgerFault, { rpc: rpcName, mode: "down", count: 1 });
    const w = world();
    const op = `op-gap2-${rpcName.slice(10, 16)}1`;
    const r = await w.run("jwt-a", ideas({ operationId: op }));
    assert.deepEqual([r.ok, !r.ok && r.code, r.audit?.costBasis, w.net.calls.length], [false, "LEDGER_UNAVAILABLE", "no_request", 0], rpcName);
    const k = r.audit!.callKey;
    assert.equal(await rows(`select coalesce(string_agg(status, ','), '-') from ai_ledger.reservations where request_id = '${k}'`), rpcName === "ai_ledger_reserve" ? "-" : "released", rpcName);
    assert.equal(await rows(`select result ->> 'code' from ai_calls.consumer_calls where call_key = '${k}'`), "POLICY_DENIED");
    const again = await w.run("jwt-a", ideas({ operationId: op }));
    assert.deepEqual([again.ok, !again.ok && again.code, w.net.calls.length], [false, "NOT_SENT", 0], rpcName);
    const fresh = await w.run("jwt-a", ideas({ operationId: `${op}-new` }));
    assert.deepEqual([fresh.ok, w.net.calls.length], [true, 1], rpcName);
  }
});

Deno.test({ name: "GAP-2 / GAP-4 (real SQL): mark_sent COMMITTED but its answer lost -> nothing sent, LEDGER_UNAVAILABLE; the ledger keeps the attempt 'sent' (release refused) for recovery at the upper bound: the ledger may over-count, never under-count", ...opts }, async () => {
  Object.assign(ledgerFault, { rpc: "ai_ledger_mark_sent", mode: "lost", count: 1 });
  const w = world();
  const r = await w.run("jwt-a", ideas({ operationId: "op-gap2-lostms1" }));
  assert.deepEqual([r.ok, !r.ok && r.code, r.audit?.costBasis, w.net.calls.length], [false, "LEDGER_UNAVAILABLE", "no_request", 0]);
  const k = r.audit!.callKey;
  assert.equal(await rows(`select status from ai_ledger.reservations where request_id = '${k}'`), "sent");
  assert.equal(await rows(`select count(*) from ai_ledger.usage_events where request_id = '${k}'`), "0");
  assert.equal(await rows(`select result ->> 'code' from ai_calls.consumer_calls where call_key = '${k}'`), "POLICY_DENIED");
});

Deno.test({ name: "real SQL: one operation = one ai_calls row + one ledger reservation under the same key, for both providers; a new gateway instance replays without sending", ...opts }, async () => {
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

Deno.test({ name: "real SQL: other content under the same operation id -> OPERATION_REUSED; parallel duplicates -> ONE request, the other IN_PROGRESS", ...opts }, async () => {
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

Deno.test({ name: "real SQL: the same operation id for another person / brand is another row, another ledger key, its own charge", ...opts }, async () => {
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

Deno.test({ name: "real SQL: revoked before the send -> nothing sent, the ledger reservation is released (no usage row), POLICY_DENIED stored, replay NOT_SENT", ...opts }, async () => {
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

Deno.test({ name: "real SQL: the ledger's daily limit -> QUOTA_EXCEEDED before any request (no reservation), stored BUDGET_DENIED and replayed", ...opts }, async () => {
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

Deno.test({ name: "real SQL, both providers: 504 -> UNKNOWN at the upper bound in the ledger and the store; replay never resends", ...opts }, async () => {
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

Deno.test({ name: "real SQL: a lost completion stays IN_PROGRESS until recovery abandons it with an audit that agrees with the ledger; then UNKNOWN, never resent", ...opts }, async () => {
  const w = world();
  (w.store as SqlCallStore).loseNextComplete = "before_write";
  const lost = await w.run("jwt-a", ideas({ operationId: "op-lost-000001" }));
  assert.deepEqual([lost.ok, !lost.ok && lost.code], [false, "UNKNOWN"]);
  const busy = await w.run("jwt-a", ideas({ operationId: "op-lost-000001" }));
  assert.deepEqual([busy.ok, !busy.ok && busy.code], [false, "IN_PROGRESS"]);
  const k = lost.audit!.callKey;
  await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set created_at = created_at - interval '1 hour' where call_key = '${k}'`);
  const cost = Number(await rows(`select sum(estimated_cost_usd) from ai_ledger.usage_events where request_id = '${k}'`));
  // The gateway's audit, mapped as the store adapter would: the store checks it against the ledger.
  const audit = toStoreAudit({ ...lost.audit!, attempts: 1, estimatedCostUsd: cost, costBasis: "measured" }, POLICIES.get(policyKey("postona", "ideas"))!);
  await assert.rejects(rpc("ai_calls_abandon", { call_key: k, audit: { ...audit, attempts: 0, costBasis: "no_request", estimatedCostUsd: 0 } }), /AUDIT_LEDGER_MISMATCH/);
  assert.ok(cost > 0);
  await assert.rejects(rpc("ai_calls_abandon", { call_key: k, audit: { ...audit, estimatedCostUsd: 0 } }), /AUDIT_LEDGER_MISMATCH/, "never less cost than the ledger charged");
  assert.deepEqual(await rpc("ai_calls_abandon", { call_key: k, audit }), { abandoned: true });
  const replay = await w.run("jwt-a", ideas({ operationId: "op-lost-000001" }));
  assert.deepEqual([replay.ok, !replay.ok && replay.code, replay.audit?.attempts], [false, "UNKNOWN", 1]);
  assert.equal(w.net.calls.length, 1);

  const v = world();
  (v.store as SqlCallStore).loseNextComplete = "after_write";
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
    const audit = { callId: key, tenantTag: tenant, feature: "postona:ideas", role: "postona.ideas", model: "gpt-6-luna", policyVersion: REVISION, attempts: 0, estimatedCostUsd: 0, costBasis: "no_request" };
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
  const storeAudit = toStoreAudit(gatewayAudit, POLICIES.get(policyKey("postona", "ideas"))!);
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
