// Disposable-PostgreSQL E2E of the G6-06 recovery coordinator on the REAL ledger and ai_calls migrations: the G6 runtime
// (createAiGateway, real ledger guard + call store) is made to crash at each step, which leaves real stuck rows; then the
// coordinator (service RPCs through psql AS service_role) reconciles them. Providers and the authority are fakes; no network.
// Run by common_ai_gateway_recovery_pg_run.sh.
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { FAKE_OPENAI_KEY, jsonResponse, openAiBody, type RecordedCall, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import type { AuthorityPort, AuthVerdict, FeaturePolicy, GatewaySubject } from "../ai_gateway/gateway.ts";
import { definePolicyRegistry } from "../ai_gateway/policy_registry.ts";
import { reconcileUnknownCalls, type RecoveryRpc } from "../ai_gateway/recovery.ts";
import { createAiGateway } from "../ai_gateway/runtime.ts";

const HOST = Deno.env.get("GWV_PGHOST");
const PORT = Deno.env.get("GWV_PGPORT");
const SUPER = Deno.env.get("GWV_PGSUPER");
const DB = Deno.env.get("GWV_DB");
const enabled = !!HOST && !!PORT && !!SUPER && !!DB && /^\/(private\/)?tmp\//.test(HOST);
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };

const SUPABASE = "http://127.0.0.1:54321";
const SERVICE_KEY = "local-g6-06-key-NOT-A-SECRET";
const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
const BRAND = { app: "postona" as const, slug: "u_ae343f5caedb67d4af33fc7a" };

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
async function rpcCall(name: string, p: unknown): Promise<unknown> {
  const text = JSON.stringify(p);
  if (text.includes("$gwv$")) throw new Error("quote tag in payload");
  const r = await psql(`set role service_role; select public.${name}($gwv$${text}$gwv$::jsonb)`);
  if (!r.ok) throw new Error(`RPC_FAILED:${name}:${r.err.split("\n")[0]}`);
  return JSON.parse(r.out);
}
/** The coordinator's port: the real service RPCs through psql. */
const serviceRpc: RecoveryRpc = (name, p) => rpcCall(name, p);

/** Crash points: "down" = the RPC never runs (crash before it); "lost" = it COMMITS, then the process loses the answer. */
let faults: Record<string, "down" | "lost"> = {};
const supabaseFetch: FetchLike = async (input, init) => {
  if (new Headers(init?.headers).get("apikey") !== SERVICE_KEY) return jsonResponse(401, {});
  const name = new URL(String(input)).pathname.match(/^\/rest\/v1\/rpc\/(ai_(?:ledger|calls)_[a-z_]+)$/)?.[1];
  if (!name) return jsonResponse(404, {});
  const mode = faults[name];
  if (mode === "down") throw new TypeError("process gone");
  try {
    const answer = await rpcCall(name, (JSON.parse(String(init?.body)) as { p: unknown }).p);
    if (mode === "lost") return jsonResponse(504, {});
    return jsonResponse(200, answer);
  } catch {
    return jsonResponse(400, { code: "P0001" });
  }
};

const SCHEMA = { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } };
const policy = (feature: string, over: Partial<FeaturePolicy> = {}): FeaturePolicy => ({
  app: "postona", feature, revision: "r1", ledgerFeature: feature, logicalRole: `postona.${feature}`, provider: "openai", model: "gpt-6-luna",
  reasoningEffort: "low", maxOutputTokens: 300, timeoutMs: 20_000, maxAttempts: 1, maxCostUsdPerOperation: 0.05, maxInputBytes: 8_000,
  subjectKinds: ["user"], brandRequired: false, systemInstructions: "JSON { reply }.", schema: SCHEMA,
  validate: (p) => typeof (p as { reply?: unknown })?.reply === "string", ...over,
});
const REGISTRY = definePolicyRegistry([policy("ideas"), policy("long", { timeoutMs: 600_000, maxAttempts: 3, maxCostUsdPerOperation: 0.2 })]);

const user = (userId: string): GatewaySubject => ({ kind: "user", app: "postona", userId, brand: BRAND });
class Authority implements AuthorityPort {
  verdict(credential: unknown): Promise<AuthVerdict> {
    const userId = credential === "jwt-b" ? USER_B : USER_A;
    return Promise.resolve({ decision: "allow", subject: user(userId), generation: "g1", expiresAtMs: Date.now() + 60_000 });
  }
  recheck(prior: AuthVerdict): Promise<AuthVerdict> {
    return Promise.resolve(structuredClone(prior));
  }
}
const reply = (_call: RecordedCall) => jsonResponse(200, openAiBody({ reply: "ok" }, { model: "gpt-6-luna" }));
function gateway(respond: (call: RecordedCall) => Response = reply) {
  const provider = recordingFetch((call) => respond(call));
  const g = createAiGateway({
    // G6-20: this suite pins the legacy busy re-claim check; the owner-held default has its own suites.
    ledgerMode: "legacy_busy_check_unsafe",
    supabaseUrl: SUPABASE,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : undefined),
    authority: new Authority(),
    policies: REGISTRY,
    fetch: (input, init) => (String(input).startsWith(SUPABASE) ? supabaseFetch(input, init) : provider.fetch(input, init)),
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  return { provider, run: (op: string, feature = "ideas", credential = "jwt-a") => g.execute(credential, { app: "postona", feature, operationId: op, input: "やあ", brand: BRAND }) };
}
/** Leave one stuck operation behind by crashing at the given points; returns its call key. */
async function stuck(op: string, crash: Record<string, "down" | "lost">, respond?: (call: RecordedCall) => Response, feature = "ideas", credential = "jwt-a") {
  faults = crash;
  const g = gateway(respond);
  const r = await g.run(op, feature, credential);
  faults = {};
  assert.equal(r.ok, false, op);
  const k = r.audit?.callKey ?? await rows(`select call_key from ai_calls.consumer_calls order by created_at desc limit 1`);
  assert.equal(await rows(`select state from ai_calls.consumer_calls where call_key = '${k}'`), "acquired", `${op} is stuck`);
  return { key: k, sends: g.provider.calls.length };
}
const age = (key: string, seconds: number) => rows(`set session_replication_role = replica; update ai_calls.consumer_calls set created_at = created_at - interval '${seconds} seconds' where call_key = '${key}'`);
const ageSent = (key: string, seconds: number) => rows(`set session_replication_role = replica; update ai_ledger.reservations set sent_at = sent_at - interval '${seconds} seconds' where request_id = '${key}' and status = 'sent'`);
const snapshot = () => rows(`select coalesce(string_agg(call_key || ':' || state, ',' order by call_key), '-') || '|' || (select coalesce(string_agg(request_id || ':' || status, ',' order by request_id, attempt), '-') from ai_ledger.reservations) from ai_calls.consumer_calls`);

const S: Record<string, { key: string; sends: number }> = {};

Deno.test({ name: "setup: ledger policies", ...opts }, async () => {
  await rows(`insert into ai_ledger.budget_policies
    (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
    values ('gwv.postona.ideas', 'openai', 'gpt-6-luna', 'postona', 'ideas', 'user', true, 'day', 100, 5, 0.05),
           ('gwv.postona.long', 'openai', 'gpt-6-luna', 'postona', 'long', 'user', true, 'day', 100, 5, 0.2)`);
});

Deno.test({ name: "real crashes leave real stuck rows: before reserve, before mark_sent, after a committed mark_sent, after a 504, after success, after a lost settle", ...opts }, async () => {
  // The store's complete is always lost ("down"): the process died before recording the outcome.
  S.beforeReserve = await stuck("op-gwv-s1-reserve", { ai_ledger_reserve: "down", ai_calls_complete: "down" });
  S.beforeMarkSent = await stuck("op-gwv-s2-marksent", { ai_ledger_mark_sent: "down", ai_calls_complete: "down" });
  S.markSentLost = await stuck("op-gwv-s3-sentlost", { ai_ledger_mark_sent: "lost", ai_calls_complete: "down" });
  S.timeout504 = await stuck("op-gwv-s4-504", { ai_calls_complete: "down" }, () => jsonResponse(504, { error: { type: "timeout" } }));
  S.success = await stuck("op-gwv-s5-success", { ai_calls_complete: "down" });
  S.settleLost = await stuck("op-gwv-s6-settle", { ai_ledger_settle: "down", ai_calls_complete: "down" });
  S.longRunning = await stuck("op-gwv-s7-long", { ai_calls_complete: "down" }, undefined, "long");
  assert.deepEqual(Object.values(S).map((s) => s.sends), [0, 0, 0, 1, 1, 1, 1], "sends per crash point");
  const ledger = async (k: string) => await rows(`select coalesce(string_agg(status, ',' order by attempt), '-') from ai_ledger.reservations where request_id = '${k}'`);
  assert.deepEqual(await Promise.all(Object.values(S).map((s) => ledger(s.key))), ["-", "released", "sent", "unknown", "settled", "sent", "settled"]);
  // A row of a feature the gateway has no policy for (claimed directly, as another job might).
  await rpcCall("ai_calls_claim", { call_key: "h5m2_" + "e".repeat(64), tenant_tag: "e".repeat(64), fingerprint: "e".repeat(64), application: "miseiro", feature: "miseiro:assistant", subject_kind: "user", user_id: USER_B });
  S.unregistered = { key: "h5m2_" + "e".repeat(64), sends: 0 };
  for (const s of Object.values(S)) await age(s.key, 1900); // older than the SQL age (1800 s); "long" may still run (1960 s)
});

Deno.test({ name: "advise mode: the plan per row (ledger-open waits, may-be-running waits, unregistered left), and NOTHING changes in either store", ...opts }, async () => {
  const before = await snapshot();
  const r = await reconcileUnknownCalls(serviceRpc, REGISTRY, { mode: "advise" });
  assert.equal(await snapshot(), before, "advise wrote nothing");
  const by = Object.fromEntries(r.candidates.map((c) => [c.callKey, `${c.classification}:${c.outcome}`]));
  assert.deepEqual([by[S.beforeReserve.key], by[S.beforeMarkSent.key], by[S.markSentLost.key], by[S.timeout504.key], by[S.success.key], by[S.settleLost.key], by[S.longRunning.key], by[S.unregistered.key]], [
    "NOT_SENT_PROVEN:WOULD_ABANDON",
    "NOT_SENT_PROVEN:WOULD_ABANDON",
    "null:WAIT_LEDGER_OPEN",
    "POSSIBLY_SENT:WOULD_ABANDON",
    "RESULT_LOST:WOULD_ABANDON",
    "null:WAIT_LEDGER_OPEN",
    "RESULT_LOST:WAIT_MAY_BE_RUNNING",
    "null:UNREGISTERED",
  ]);
});

Deno.test({ name: "apply: two coordinators in parallel after the sent grace: the ledger finalises the open attempts (upper bound), every closable row is closed exactly once, the rest is untouched", ...opts }, async () => {
  await ageSent(S.markSentLost.key, 1000);
  await ageSent(S.settleLost.key, 1000);
  const [a, b] = await Promise.all([
    reconcileUnknownCalls(serviceRpc, REGISTRY, { mode: "apply" }),
    reconcileUnknownCalls(serviceRpc, REGISTRY, { mode: "apply" }),
  ]);
  const outcomes = [...a.candidates, ...b.candidates];
  const closedKeys = outcomes.filter((c) => c.outcome === "ABANDONED").map((c) => c.callKey).sort();
  const expected = [S.beforeReserve.key, S.beforeMarkSent.key, S.markSentLost.key, S.timeout504.key, S.success.key, S.settleLost.key].sort();
  assert.deepEqual(closedKeys, expected, "each closed once, across both runs");
  assert.ok(outcomes.filter((c) => expected.includes(c.callKey) && c.outcome !== "ABANDONED").every((c) => ["ALREADY_CLOSED", "RETRY_LATER", "WAIT_LEDGER_OPEN"].includes(c.outcome)));
  assert.equal((a.recovered!.marked_unknown + b.recovered!.marked_unknown), 2, "the two long-sent attempts became unknown at the upper bound");
  assert.equal(await rows(`select state from ai_calls.consumer_calls where call_key = '${S.longRunning.key}'`), "acquired", "a call that may still be running is not fenced");
  assert.equal(await rows(`select state from ai_calls.consumer_calls where call_key = '${S.unregistered.key}'`), "acquired", "an unregistered row is left to an operator");
  // The audit each close wrote agrees with the ledger: attempts = finalised attempts, cost never below the ledger, basis.
  for (const [name, s] of Object.entries(S).filter(([n]) => !["longRunning", "unregistered"].includes(n))) {
    const audit = JSON.parse(await rows(`select audit::text from ai_calls.consumer_calls where call_key = '${s.key}'`));
    const ledgerCost = Number(await rows(`select coalesce(sum(estimated_cost_usd), 0) from ai_ledger.usage_events where request_id = '${s.key}'`));
    const finalised = Number(await rows(`select count(*) from ai_ledger.reservations where request_id = '${s.key}' and status in ('settled', 'unknown')`));
    assert.ok(audit.estimatedCostUsd >= ledgerCost - 1e-9, `${name}: audit cost never below the ledger`);
    assert.equal(audit.attempts, finalised, name);
    assert.equal(await rows(`select state || '|' || (result ->> 'code') from ai_calls.consumer_calls where call_key = '${s.key}'`), "abandoned|UNKNOWN", name);
  }
  const basis = async (k: string) => JSON.parse(await rows(`select audit::text from ai_calls.consumer_calls where call_key = '${k}'`)).costBasis;
  assert.deepEqual(await Promise.all([S.beforeReserve, S.beforeMarkSent, S.markSentLost, S.timeout504, S.success, S.settleLost].map((s) => basis(s.key))),
    ["no_request", "no_request", "includes_upper_bound", "includes_upper_bound", "measured", "includes_upper_bound"]);
});

Deno.test({ name: "after recovery: a replay of every closed operation answers UNKNOWN and sends nothing; a third run changes nothing; the dead owner's late complete is fenced", ...opts }, async () => {
  for (const [op, s] of [["op-gwv-s1-reserve", S.beforeReserve], ["op-gwv-s3-sentlost", S.markSentLost], ["op-gwv-s5-success", S.success]] as const) {
    const g = gateway();
    const r = await g.run(op);
    assert.deepEqual([r.ok, !r.ok && r.code, r.audit?.callKey, g.provider.calls.length], [false, "UNKNOWN", s.key, 0], op);
  }
  const before = await snapshot();
  const third = await reconcileUnknownCalls(serviceRpc, REGISTRY, { mode: "apply" });
  assert.equal(third.candidates.filter((c) => c.outcome === "ABANDONED").length, 0);
  assert.equal(await snapshot(), before, "idempotent");
  const owner = await rows(`select claim_token from ai_calls.consumer_calls where call_key = '${S.success.key}'`);
  const tenant = await rows(`select tenant_tag || '|' || fingerprint from ai_calls.consumer_calls where call_key = '${S.success.key}'`);
  const [tenantTag, fingerprint] = tenant.split("|");
  await assert.rejects(rpcCall("ai_calls_complete", { call_key: S.success.key, tenant_tag: tenantTag, fingerprint, owner, result: { ok: false, code: "UNKNOWN", audit: {} } }), /FENCED|INVALID_INPUT/);
});

Deno.test({ name: "tenant isolation: another person's same operation id is its own row; recovering one never touches the other", ...opts }, async () => {
  const a = await stuck("op-gwv-shared-1", { ai_calls_complete: "down" }, undefined, "ideas", "jwt-a");
  const b = await stuck("op-gwv-shared-1", { ai_calls_complete: "down" }, undefined, "ideas", "jwt-b");
  assert.notEqual(a.key, b.key);
  await age(a.key, 1900); // only A is old enough
  await reconcileUnknownCalls(serviceRpc, REGISTRY, { mode: "apply" });
  assert.deepEqual([await rows(`select state from ai_calls.consumer_calls where call_key = '${a.key}'`), await rows(`select state from ai_calls.consumer_calls where call_key = '${b.key}'`)], ["abandoned", "acquired"]);
  assert.equal(await rows(`select user_id from ai_calls.consumer_calls where call_key = '${b.key}'`), USER_B);
});
