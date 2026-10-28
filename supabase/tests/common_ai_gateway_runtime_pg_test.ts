// Disposable-PostgreSQL test of the G6 runtime candidate: createAiGateway (supabase/ai_gateway/runtime.ts) with its
// REAL SupabaseLedgerBudgetGuard and SupabaseAiCallsStore talking to the REAL ledger (20261010050613) and ai_calls
// (20261017120000) migrations. The only stand-ins: a fetch that turns the runtime's PostgREST requests into the same
// RPCs (psql AS service_role on the runner's local socket, with the same key check), the providers (fake fetch, fake
// keys, no network) and the authority (G5's verdict port). Run by common_ai_gateway_runtime_pg_run.sh.
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { anthropicBody, anthropicError, FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody, type RecordedCall, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import type { AuthorityPort, AuthVerdict, FeaturePolicy, GatewaySubject } from "../ai_gateway/gateway.ts";
import { definePolicyRegistry } from "../ai_gateway/policy_registry.ts";
import { createAiGateway } from "../ai_gateway/runtime.ts";

const HOST = Deno.env.get("GWR_PGHOST");
const PORT = Deno.env.get("GWR_PGPORT");
const SUPER = Deno.env.get("GWR_PGSUPER");
const DB = Deno.env.get("GWR_DB");
const enabled = !!HOST && !!PORT && !!SUPER && !!DB && /^\/(private\/)?tmp\//.test(HOST);
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };

const SUPABASE = "http://127.0.0.1:54321";
const SERVICE_KEY = "local-gateway-runtime-pg-key-NOT-A-SECRET";
const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
const BRAND_A = { app: "postona" as const, slug: "u_ae343f5caedb67d4af33fc7a" };
const BRAND_B = { app: "postona" as const, slug: "u_0b1c2d3e4f5061728394a5b6" };
const HOUR = 3_600_000;

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
async function rows(sql: string): Promise<string> {
  const r = await psql(sql);
  assert.ok(r.ok, r.err);
  return r.out;
}

/** Test faults: "down" refuses before the RPC runs; "lost" runs it (COMMITTED) and then loses the answer. */
const fault: { rpc: string; mode: "down" | "lost"; count: number } = { rpc: "", mode: "down", count: 0 };
/** The runtime's PostgREST requests -> the same RPC through psql AS service_role (never the network). */
const supabaseFetch: FetchLike = async (input, init) => {
  const headers = new Headers(init?.headers);
  if (headers.get("apikey") !== SERVICE_KEY || headers.get("authorization") !== `Bearer ${SERVICE_KEY}`) return jsonResponse(401, { code: "PGRST301" });
  const name = new URL(String(input)).pathname.match(/^\/rest\/v1\/rpc\/(ai_(?:ledger|calls)_[a-z_]+)$/)?.[1];
  if (!name || init?.method !== "POST") return jsonResponse(404, { code: "PGRST404" });
  const faulted = fault.count > 0 && fault.rpc === name;
  if (faulted) fault.count -= 1;
  if (faulted && fault.mode === "down") throw new TypeError("unreachable");
  const p = JSON.stringify((JSON.parse(String(init.body)) as { p: unknown }).p);
  if (p.includes("$gwr$")) throw new Error("quote tag in payload");
  const r = await psql(`set role service_role; select public.${name}($gwr$${p}$gwr$::jsonb)`);
  if (faulted) return jsonResponse(504, { code: "504" });
  if (!r.ok) return jsonResponse(400, { code: r.err.match(/ERROR:\s+([0-9A-Z]{5})/)?.[1] ?? "XX000" });
  return new Response(r.out, { status: 200, headers: { "content-type": "application/json" } });
};

const SCHEMA = { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } };
function policy(app: FeaturePolicy["app"], feature: string, provider: "openai" | "anthropic", over: Partial<FeaturePolicy> = {}): FeaturePolicy {
  return {
    app, feature, revision: "r1", ledgerFeature: feature, logicalRole: `${app}.${feature}`, provider,
    model: provider === "openai" ? "gpt-6-luna" : "claude-haiku-5-5", reasoningEffort: "low", maxOutputTokens: 300, timeoutMs: 20_000,
    maxAttempts: 1, maxCostUsdPerOperation: 0.05, maxInputBytes: 8_000, subjectKinds: ["user"], brandRequired: false,
    systemInstructions: `Answer for ${app} ${feature} as JSON { reply }.`, schema: SCHEMA,
    validate: (x) => typeof (x as { reply?: unknown })?.reply === "string", ...over,
  };
}
const REGISTRY = definePolicyRegistry([
  policy("postona", "ideas", "openai"),
  policy("postona", "consult", "anthropic", { brandRequired: true }),
  policy("postona", "quota", "openai"),
  policy("kabumori", "market_report", "anthropic", { subjectKinds: ["system"] }),
]);

const user = (userId: string, brand: typeof BRAND_A | null): GatewaySubject => ({ kind: "user", app: "postona", userId, brand });
const allow = (subject: GatewaySubject): AuthVerdict => ({ decision: "allow", subject, generation: "epoch-1", expiresAtMs: Date.now() + HOUR });
const VERDICTS: Record<string, AuthVerdict> = {
  "jwt-a": allow(user(USER_A, BRAND_A)),
  "jwt-a-b": allow(user(USER_A, BRAND_B)),
  "jwt-b": allow(user(USER_B, BRAND_A)),
  "cron-kabumori": allow({ kind: "system", app: "kabumori" }),
};
class Authority implements AuthorityPort {
  revoke = false;
  verdict(credential: unknown) {
    return Promise.resolve(structuredClone(VERDICTS[String(credential)]));
  }
  recheck(prior: AuthVerdict) {
    return Promise.resolve(this.revoke ? { ...prior, generation: "epoch-2" } : structuredClone(prior));
  }
}

const reply = (text: string) => (call: RecordedCall) =>
  call.url.includes("anthropic") ? jsonResponse(200, anthropicBody({ reply: text }, { model: "claude-haiku-5-5" })) : jsonResponse(200, openAiBody({ reply: text }, { model: "gpt-6-luna" }));
function world(options: { respond?: (call: RecordedCall) => Response | Promise<Response> } = {}) {
  const provider = recordingFetch((call) => (options.respond ?? reply("どうぞ"))(call));
  const authority = new Authority();
  const gateway = createAiGateway({
    // G6-20: this suite pins the legacy busy re-claim check; the owner-held default has its own suites.
    ledgerMode: "legacy_busy_check_unsafe",
    supabaseUrl: SUPABASE,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
    authority,
    policies: REGISTRY,
    fetch: (input, init) => (String(input).startsWith(SUPABASE) ? supabaseFetch(input, init) : provider.fetch(input, init)),
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  return { provider, authority, run: (credential: string, request: Record<string, unknown>) => gateway.execute(credential, request) };
}
const ideas = (operationId: string, over: Record<string, unknown> = {}) => ({ app: "postona", feature: "ideas", operationId, input: "アイデア", brand: BRAND_A, ...over });
const consult = (operationId: string, over: Record<string, unknown> = {}) => ({ app: "postona", feature: "consult", operationId, input: "相談", brand: BRAND_A, ...over });
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "OK" : r.code);

Deno.test({ name: "setup: fully scoped ledger policies", ...opts }, async () => {
  await rows(`insert into ai_ledger.budget_policies
    (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
    values ('gwr.postona.consult.user.daily', 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', true, 'day', 100, 1, 0.05),
           ('gwr.postona.ideas.user.daily', 'openai', 'gpt-6-luna', 'postona', 'ideas', 'user', true, 'day', 100, 1, 0.05),
           ('gwr.postona.quota.user.daily', 'openai', 'gpt-6-luna', 'postona', 'quota', 'user', true, 'day', 1, 1, 0.05),
           ('gwr.kabumori.market_report.system.daily', 'anthropic', 'claude-haiku-5-5', 'kabumori', 'market_report', 'system', false, 'day', 10, 1, 0.05)`);
});

Deno.test({ name: "runtime, both providers + system work: one ai_calls row and one ledger reservation per operation under the same key; a NEW runtime replays without sending", ...opts }, async () => {
  for (const [credential, req] of [["jwt-a", ideas("op-gwr-000001")], ["jwt-a", consult("op-gwr-000002")], ["cron-kabumori", { app: "kabumori", feature: "market_report", operationId: "run-2026-10-19-gwr", input: "市況", brand: null }]] as const) {
    const w = world();
    const r = await w.run(credential, req);
    assert.equal(r.ok, true, req.feature);
    const k = r.audit!.callKey;
    const system = credential === "cron-kabumori";
    assert.equal(
      await rows(`select state || '|' || feature || '|' || subject_kind || '|' || coalesce(user_id::text, '-') || '|' || coalesce(brand_ref, '-') || '|' || (audit ->> 'policyVersion') || '|' || (audit ->> 'role') from ai_calls.consumer_calls where call_key = '${k}'`),
      `complete|${req.app}:${req.feature}|${system ? "system" : "user"}|${system ? "-" : USER_A}|${system ? "-" : BRAND_A.slug}|r1|${req.app}.${req.feature}`,
    );
    assert.equal(await rows(`select count(*) || '|' || min(status) || '|' || coalesce(min(brand_id::text), '-') from ai_ledger.reservations where request_id = '${k}'`), "1|settled|-");
    const again = world();
    assert.deepEqual(await again.run(credential, req), r);
    assert.equal(w.provider.calls.length + again.provider.calls.length, 1);
  }
});

Deno.test({ name: "runtime: real parallel duplicates -> ONE request, the other IN_PROGRESS; other content -> OPERATION_REUSED; other person / brand -> own rows and charges", ...opts }, async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const w = world({ respond: async (call) => (await gate, reply("どうぞ")(call)) });
  const first = w.run("jwt-a", ideas("op-gwr-par-01"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const second = await world().run("jwt-a", ideas("op-gwr-par-01"));
  release();
  assert.deepEqual([code(second), code(await first), w.provider.calls.length], ["IN_PROGRESS", "OK", 1]);
  assert.equal(code(await world().run("jwt-a", ideas("op-gwr-par-01", { input: "別の内容" }))), "OPERATION_REUSED");
  const keys: string[] = [];
  for (const [credential, brand] of [["jwt-a", BRAND_A], ["jwt-a-b", BRAND_B], ["jwt-b", BRAND_A]] as const) {
    const r = await world().run(credential, consult("op-gwr-shared1", { brand }));
    assert.equal(r.ok, true, credential);
    keys.push(r.audit!.callKey);
  }
  assert.equal(new Set(keys).size, 3);
  assert.equal(await rows(`select count(distinct request_id) from ai_ledger.reservations where status = 'settled' and request_id in ('${keys.join("','")}')`), "3");
  assert.equal(await rows(`select string_agg(coalesce(brand_ref, '-') || ':' || user_id, ',' order by brand_ref, user_id) from ai_calls.consumer_calls where call_key in ('${keys.join("','")}')`), `${BRAND_B.slug}:${USER_A},${BRAND_A.slug}:${USER_A},${BRAND_A.slug}:${USER_B}`.split(",").sort().join(","));
});

Deno.test({ name: "runtime: the ledger's daily limit -> QUOTA_EXCEEDED with no reservation; an epoch change at recheck -> AUTH_REVOKED_BEFORE_SEND, reservation released, replay NOT_SENT", ...opts }, async () => {
  const q = world();
  assert.equal(code(await q.run("jwt-a", { app: "postona", feature: "quota", operationId: "op-gwr-quota1", input: "1", brand: BRAND_A })), "OK");
  const denied = await q.run("jwt-a", { app: "postona", feature: "quota", operationId: "op-gwr-quota2", input: "2", brand: BRAND_A });
  assert.deepEqual([code(denied), q.provider.calls.length], ["QUOTA_EXCEEDED", 1]);
  assert.equal(await rows(`select count(*) from ai_ledger.reservations where request_id = '${denied.audit!.callKey}'`), "0");
  const w = world();
  w.authority.revoke = true;
  const r = await w.run("jwt-a", ideas("op-gwr-revoke1"));
  assert.deepEqual([code(r), w.provider.calls.length], ["AUTH_REVOKED_BEFORE_SEND", 0]);
  assert.equal(await rows(`select status from ai_ledger.reservations where request_id = '${r.audit!.callKey}'`), "released");
  assert.equal(code(await world().run("jwt-a", ideas("op-gwr-revoke1"))), "NOT_SENT");
});

Deno.test({ name: "runtime: ledger unreachable -> UNKNOWN, nothing sent, nothing recorded (G6-10); mark_sent committed but lost -> nothing sent, UNKNOWN and nothing recorded (G6-09), the ledger keeps 'sent' (over-counts, never under-counts); settle lost -> answer OK, ledger 'sent' for recovery", ...opts }, async () => {
  Object.assign(fault, { rpc: "ai_ledger_reserve", mode: "down", count: 1 });
  const d = world();
  // G6-10: the ledger unreachable does not prove the operation unsent: UNKNOWN, the row left for recovery.
  assert.deepEqual([code(await d.run("jwt-a", ideas("op-gwr-ldown1"))), d.provider.calls.length], ["UNKNOWN", 0]);
  assert.deepEqual([code(await d.run("jwt-a", ideas("op-gwr-ldown1"))), code(await d.run("jwt-a", ideas("op-gwr-ldown2"))), d.provider.calls.length], ["IN_PROGRESS", "OK", 1]);
  Object.assign(fault, { rpc: "ai_ledger_mark_sent", mode: "lost", count: 1 });
  const m = world();
  const lost = await m.run("jwt-a", ideas("op-gwr-msent1"));
  // G6-09 (R1): mark_sent may have committed "sent", so nothing proves "not sent": UNKNOWN, no audit, the row left for recovery.
  assert.deepEqual([code(lost), lost.audit, m.provider.calls.length], ["UNKNOWN", null, 0]);
  const lostKey = await rows(`select call_key from ai_calls.consumer_calls order by created_at desc limit 1`);
  assert.equal(await rows(`select status from ai_ledger.reservations where request_id = '${lostKey}'`), "sent");
  assert.equal(await rows(`select state from ai_calls.consumer_calls where call_key = '${lostKey}'`), "acquired");
  Object.assign(fault, { rpc: "ai_ledger_settle", mode: "down", count: 1 });
  const s = world();
  const ok = await s.run("jwt-a", ideas("op-gwr-settle1"));
  assert.deepEqual([code(ok), s.provider.calls.length], ["OK", 1]);
  assert.equal(await rows(`select status || '|' || (select count(*) from ai_ledger.usage_events e where e.request_id = r.request_id) from ai_ledger.reservations r where request_id = '${ok.audit!.callKey}'`), "sent|0");
});

Deno.test({ name: "runtime, both providers: 504 -> UNKNOWN at the upper bound in the ledger AND the store; the completion lost before / after the write -> IN_PROGRESS / stored answer; never resent", ...opts }, async () => {
  for (const req of [ideas("op-gwr-504-oai"), consult("op-gwr-504-ant")]) {
    const w = world({ respond: (call) => call.url.includes("anthropic") ? jsonResponse(504, anthropicError(504, "timeout_error", "late")) : jsonResponse(504, { error: { type: "timeout" } }) });
    const r = await w.run("jwt-a", req);
    assert.deepEqual([code(r), r.audit?.costBasis], ["UNKNOWN", "includes_upper_bound"]);
    const k = r.audit!.callKey;
    assert.equal(await rows(`select r.status || '|' || e.cost_basis || '|' || (c.result ->> 'code') from ai_ledger.reservations r join ai_ledger.usage_events e using (request_id) join ai_calls.consumer_calls c on c.call_key = r.request_id where r.request_id = '${k}'`), "unknown|upper_bound|UNKNOWN");
    assert.deepEqual(await world().run("jwt-a", req), r);
    assert.equal(w.provider.calls.length, 1);
  }
  Object.assign(fault, { rpc: "ai_calls_complete", mode: "down", count: 1 });
  const before = world();
  assert.equal(code(await before.run("jwt-a", ideas("op-gwr-lost-01"))), "UNKNOWN");
  assert.deepEqual([code(await before.run("jwt-a", ideas("op-gwr-lost-01"))), before.provider.calls.length], ["IN_PROGRESS", 1]);
  Object.assign(fault, { rpc: "ai_calls_complete", mode: "lost", count: 1 });
  const after = world();
  assert.equal(code(await after.run("jwt-a", ideas("op-gwr-lost-02"))), "UNKNOWN");
  assert.deepEqual([code(await after.run("jwt-a", ideas("op-gwr-lost-02"))), after.provider.calls.length], ["OK", 1]);
});
