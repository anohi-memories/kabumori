// Disposable-PostgreSQL E2E of G6-02: app policy catalog + G5 authority port + the G6 runtime, against the REAL ledger
// and ai_calls migrations (psql AS service_role on the runner's local socket). Stand-ins: a synthetic G5 answering the
// proposed verdict wire, fake providers (no network, fake keys). Run by common_ai_gateway_app_authority_pg_run.sh.
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { anthropicBody, FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody, type RecordedCall, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import { buildAppPolicySet, type FeatureConfig, type FeatureContent } from "../ai_gateway/app_policies.ts";
import { createG5AuthorityPort, type G5Transport, type VerdictScope } from "../ai_gateway/authority_port.ts";
import { createAiGateway } from "../ai_gateway/runtime.ts";

const HOST = Deno.env.get("GWA_PGHOST");
const PORT = Deno.env.get("GWA_PGPORT");
const SUPER = Deno.env.get("GWA_PGSUPER");
const DB = Deno.env.get("GWA_DB");
const enabled = !!HOST && !!PORT && !!SUPER && !!DB && /^\/(private\/)?tmp\//.test(HOST);
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };

const SUPABASE = "http://127.0.0.1:54321";
const SERVICE_KEY = "local-g6-02-pg-key-NOT-A-SECRET";
const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
const BRAND_A = { app: "postona" as const, slug: "u_ae343f5caedb67d4af33fc7a" };

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
const down = { rpc: "", count: 0 };
const supabaseFetch: FetchLike = async (input, init) => {
  const headers = new Headers(init?.headers);
  if (headers.get("apikey") !== SERVICE_KEY) return jsonResponse(401, { code: "PGRST301" });
  const name = new URL(String(input)).pathname.match(/^\/rest\/v1\/rpc\/(ai_(?:ledger|calls)_[a-z_]+)$/)?.[1];
  if (!name) return jsonResponse(404, { code: "PGRST404" });
  if (down.count > 0 && down.rpc === name) {
    down.count -= 1;
    throw new TypeError("unreachable");
  }
  const p = JSON.stringify((JSON.parse(String(init?.body)) as { p: unknown }).p);
  if (p.includes("$gwa$")) throw new Error("quote tag in payload");
  const r = await psql(`set role service_role; select public.${name}($gwa$${p}$gwa$::jsonb)`);
  if (!r.ok) return jsonResponse(400, { code: r.err.match(/ERROR:\s+([0-9A-Z]{5})/)?.[1] ?? "XX000" });
  return new Response(r.out, { status: 200, headers: { "content-type": "application/json" } });
};

const SCHEMA = { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } };
const content = (label: string): FeatureContent => ({ systemInstructions: `Test instructions for ${label}; JSON { reply }.`, schema: SCHEMA, validate: (p) => typeof (p as { reply?: unknown })?.reply === "string" });
const base: FeatureConfig = {
  enabled: true, revision: "test-r1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 300, timeoutMs: 20_000,
  maxAttempts: 1, maxCostUsdPerOperation: 0.05, maxInputBytes: 8_000, entitlements: ["postona:x_autopost"],
};
const SET = buildAppPolicySet(
  { "postona:consult": base, "kabumori:market_report": { ...base, provider: "anthropic", model: "claude-haiku-5-5", entitlements: [] } },
  { "postona:consult": content("consult"), "kabumori:market_report": content("report") },
);

class G5 implements G5Transport {
  session: Record<string, string> = { [USER_A]: "active", [USER_B]: "active" };
  entitlements: Record<string, string[]> = { [USER_A]: ["postona:x_autopost"], [USER_B]: [] };
  revokeOnRecheck = false;
  private wire(userId: string | null, scope: VerdictScope, recheck: boolean): unknown {
    const now = Date.now();
    const common = { v: 1, decision: "allow", reason: null, scope: { app: scope.app, feature: scope.feature, brand_slug: scope.brand?.slug ?? null }, issued_at_ms: now, expires_at_ms: now + 60_000 };
    if (!userId) return { ...common, subject: { kind: "system" }, session: null, owner_epoch: null, entitlements: [] };
    const state = recheck && this.revokeOnRecheck ? "revoked" : this.session[userId];
    return { ...common, subject: { kind: "user", user_id: userId }, session: { state, ref: `s-${userId.slice(-2)}` }, owner_epoch: scope.brand ? "g5oe:7:1" : null, entitlements: this.entitlements[userId] };
  }
  fetchVerdict(credential: unknown, scope: VerdictScope) {
    const userId = credential === "jwt-a" ? USER_A : credential === "jwt-b" ? USER_B : null;
    return Promise.resolve(this.wire(userId, scope, false));
  }
  fetchRecheck(_credential: unknown, scope: VerdictScope, subject: { kind: "user"; userId: string } | { kind: "system" }) {
    return Promise.resolve(this.wire(subject.kind === "user" ? subject.userId : null, scope, true));
  }
}

const reply = (call: RecordedCall) =>
  call.url.includes("anthropic") ? jsonResponse(200, anthropicBody({ reply: "ok" }, { model: "claude-haiku-5-5" })) : jsonResponse(200, openAiBody({ reply: "ok" }, { model: "gpt-6-luna" }));
function world(options: { respond?: (call: RecordedCall) => Response | Promise<Response>; g5?: G5 } = {}) {
  const provider = recordingFetch((call) => (options.respond ?? reply)(call));
  const g5 = options.g5 ?? new G5();
  const gateway = createAiGateway({
    // G6-20: this suite pins the legacy busy re-claim check; the owner-held default has its own suites.
    ledgerMode: "legacy_busy_check_unsafe",
    supabaseUrl: SUPABASE,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
    // This test transport also answers the Kabumori system job (G5 never does): a stand-in for a job authority.
    authority: createG5AuthorityPort({ transport: g5, planAllowlist: SET.planAllowlist, acceptSystemSubject: true }),
    policies: SET.registry,
    fetch: (input, init) => (String(input).startsWith(SUPABASE) ? supabaseFetch(input, init) : provider.fetch(input, init)),
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  return { g5, provider, run: (credential: string, request: Record<string, unknown>) => gateway.execute(credential, request) };
}
const consult = (operationId: string, over: Record<string, unknown> = {}) => ({ app: "postona", feature: "consult", operationId, input: "相談", brand: BRAND_A, ...over });
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "OK" : r.code);
const counts = async () => await rows(`select (select count(*) from ai_calls.consumer_calls) || '|' || (select count(*) from ai_ledger.reservations)`);

Deno.test({ name: "setup: ledger policies for the two enabled features only", ...opts }, async () => {
  await rows(`insert into ai_ledger.budget_policies
    (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
    values ('gwa.postona.consult.user.daily', 'openai', 'gpt-6-luna', 'postona', 'consult', 'user', true, 'day', 100, 1, 0.05),
           ('gwa.kabumori.market_report.system.daily', 'anthropic', 'claude-haiku-5-5', 'kabumori', 'market_report', 'system', false, 'day', 10, 1, 0.05)`);
});

Deno.test({ name: "E2E real SQL: POSTONA person with the plan and Kabumori system work -> one ai_calls row (catalog role, test revision) and one settled ledger reservation each", ...opts }, async () => {
  const w = world();
  const p = await w.run("jwt-a", consult("op-gwa-000001"));
  const k = await w.run("cron-kabumori", { app: "kabumori", feature: "market_report", operationId: "run-gwa-close-1", input: "市況", brand: null });
  assert.deepEqual([code(p), code(k), w.provider.calls.length], ["OK", "OK", 2]);
  assert.equal(
    await rows(`select string_agg(application || '|' || feature || '|' || subject_kind || '|' || coalesce(brand_ref, '-') || '|' || (audit ->> 'role') || '|' || (audit ->> 'policyVersion'), ',' order by application) from ai_calls.consumer_calls where call_key in ('${p.audit!.callKey}', '${k.audit!.callKey}')`),
    `kabumori|kabumori:market_report|system|-|kabumori.market_report.gateway|test-r1,postona|postona:consult|user|${BRAND_A.slug}|postona.consult.reply|test-r1`,
  );
  assert.equal(await rows(`select string_agg(status || ':' || provider, ',' order by provider) from ai_ledger.reservations where request_id in ('${p.audit!.callKey}', '${k.audit!.callKey}')`), "settled:anthropic,settled:openai");
});

Deno.test({ name: "E2E real SQL: no plan, a disabled feature, Miseiro -> nothing in ai_calls or the ledger, nothing sent", ...opts }, async () => {
  const before = await counts();
  const w = world();
  assert.equal(code(await w.run("jwt-b", consult("op-gwa-noplan1"))), "AUTH_DENIED");
  assert.equal(code(await w.run("jwt-a", consult("op-gwa-postgen", { feature: "post_generation" }))), "AUTH_DENIED");
  assert.equal(code(await w.run("jwt-a", { app: "miseiro", feature: "assistant", operationId: "op-gwa-miseiro", input: "x", brand: null })), "AUTH_DENIED");
  assert.deepEqual([await counts(), w.provider.calls.length], [before, 0]);
});

Deno.test({ name: "E2E real SQL: session revoked at the recheck -> reservation released, POLICY_DENIED stored, nothing sent; replay NOT_SENT", ...opts }, async () => {
  const g5 = new G5();
  g5.revokeOnRecheck = true;
  const w = world({ g5 });
  const r = await w.run("jwt-a", consult("op-gwa-revoke1"));
  assert.deepEqual([code(r), w.provider.calls.length], ["AUTH_REVOKED_BEFORE_SEND", 0]);
  assert.equal(await rows(`select r.status || '|' || (c.result ->> 'code') from ai_ledger.reservations r join ai_calls.consumer_calls c on c.call_key = r.request_id where r.request_id = '${r.audit!.callKey}'`), "released|POLICY_DENIED");
  assert.equal(code(await world().run("jwt-a", consult("op-gwa-revoke1"))), "NOT_SENT");
});

Deno.test({ name: "E2E real SQL: parallel duplicates send once; the ledger unreachable is UNKNOWN (G6-10) with no reservation; 504 is UNKNOWN at the upper bound in both stores", ...opts }, async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const p = world({ respond: async (call) => (await gate, reply(call)) });
  const first = p.run("jwt-a", consult("op-gwa-par-001"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const second = await world().run("jwt-a", consult("op-gwa-par-001"));
  release();
  assert.deepEqual([code(second), code(await first), p.provider.calls.length], ["IN_PROGRESS", "OK", 1]);
  Object.assign(down, { rpc: "ai_ledger_reserve", count: 1 });
  const l = world();
  const ledgerDown = await l.run("jwt-a", consult("op-gwa-ldown01"));
  assert.deepEqual([code(ledgerDown), ledgerDown.audit, l.provider.calls.length], ["UNKNOWN", null, 0]);
  const downKey = await rows(`select call_key from ai_calls.consumer_calls order by created_at desc limit 1`);
  assert.equal(await rows(`select count(*) from ai_ledger.reservations where request_id = '${downKey}'`), "0");
  assert.equal(await rows(`select state from ai_calls.consumer_calls where call_key = '${downKey}'`), "acquired");
  const u = world({ respond: () => jsonResponse(504, { error: { type: "timeout" } }) });
  const unknown = await u.run("jwt-a", consult("op-gwa-504-001"));
  assert.deepEqual([code(unknown), unknown.audit?.costBasis], ["UNKNOWN", "includes_upper_bound"]);
  assert.equal(await rows(`select r.status || '|' || (c.result ->> 'code') from ai_ledger.reservations r join ai_calls.consumer_calls c on c.call_key = r.request_id where r.request_id = '${unknown.audit!.callKey}'`), "unknown|UNKNOWN");
});
