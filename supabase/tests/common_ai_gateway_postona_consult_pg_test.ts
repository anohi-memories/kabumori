// Disposable-PostgreSQL E2E of G6-03: the REAL, unchanged POSTONA consult handler through the G6 gateway adapter,
// with the gateway's ledger and call store on the REAL ledger and ai_calls migrations (psql AS service_role on the
// runner's local socket). The handler's own Auth / RLS reads, G5 and OpenAI are fakes (no network, fake keys).
// Run by common_ai_gateway_postona_consult_pg_run.sh.
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { FAKE_OPENAI_KEY, jsonResponse, openAiBody, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import type { ConsultDependencies } from "../functions/social-mobile-consult/logic.ts";
import { buildAppPolicySet } from "../functions/_shared/ai_gateway/app_policies.ts";
import { createG5AuthorityPort, type G5Transport, type VerdictScope } from "../functions/_shared/ai_gateway/authority_port.ts";
import { handleConsultViaGateway, POSTONA_CONSULT_CONTENT } from "../functions/_shared/ai_gateway/postona_consult_adapter.ts";
import { createAiGateway } from "../functions/_shared/ai_gateway/runtime.ts";

const HOST = Deno.env.get("GWP_PGHOST");
const PORT = Deno.env.get("GWP_PGPORT");
const SUPER = Deno.env.get("GWP_PGSUPER");
const DB = Deno.env.get("GWP_DB");
const enabled = !!HOST && !!PORT && !!SUPER && !!DB && /^\/(private\/)?tmp\//.test(HOST);
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };

const SUPABASE = "http://127.0.0.1:54321";
const SERVICE_KEY = "local-g6-03-pg-service-NOT-A-SECRET";
const PUBLISHABLE = "local-g6-03-pg-publishable-NOT-A-SECRET";
const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
const BRAND_A = "u_ae343f5caedb67d4af33fc7a";
const BRAND_A2 = "u_0b1c2d3e4f5061728394a5b6";
const BRAND_B = "u_9f8e7d6c5b4a39281706f5e4";
const USERS: Record<string, string> = { "jwt-a-NOT-REAL": USER_A, "jwt-b-NOT-REAL": USER_B };
const OWNS: Record<string, string[]> = { [USER_A]: [BRAND_A, BRAND_A2], [USER_B]: [BRAND_B] };

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

/** Handler reads (publishable key + JWT) answered in memory; gateway RPCs (service key) run in the real database. */
const supabaseFetch: FetchLike = async (input, init) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  if (url.pathname.startsWith("/rest/v1/rpc/")) {
    if (headers.get("apikey") !== SERVICE_KEY) return jsonResponse(401, { code: "PGRST301" });
    const name = url.pathname.slice("/rest/v1/rpc/".length);
    if (!/^ai_(ledger|calls)_[a-z_]+$/.test(name)) return jsonResponse(404, {});
    const p = JSON.stringify((JSON.parse(String(init?.body)) as { p: unknown }).p);
    if (p.includes("$gwp$")) throw new Error("quote tag in payload");
    const r = await psql(`set role service_role; select public.${name}($gwp$${p}$gwp$::jsonb)`);
    if (!r.ok) return jsonResponse(400, { code: r.err.match(/ERROR:\s+([0-9A-Z]{5})/)?.[1] ?? "XX000" });
    return new Response(r.out, { status: 200, headers: { "content-type": "application/json" } });
  }
  if (headers.get("apikey") !== PUBLISHABLE) return jsonResponse(401, {});
  const user = USERS[(headers.get("authorization") ?? "").replace(/^Bearer /u, "")];
  if (url.pathname === "/auth/v1/user") return user ? jsonResponse(200, { id: user }) : jsonResponse(401, {});
  const brandId = (url.searchParams.get("brand_id") ?? url.searchParams.get("id") ?? "").replace(/^eq\./u, "");
  if (url.pathname === "/rest/v1/brand_memberships") return jsonResponse(200, user && OWNS[user]?.includes(brandId) ? [{ brand_id: brandId, role: "owner", user_id: user }] : []);
  if (url.pathname === "/rest/v1/brands") return jsonResponse(200, [{ id: brandId, code_profile_key: "social_mobile_user_v1" }]);
  if (url.pathname === "/rest/v1/social_mobile_content_settings") return jsonResponse(200, []);
  return jsonResponse(404, {});
};

class G5 implements G5Transport {
  revokeOnRecheck = false;
  private wire(userId: string | undefined, scope: VerdictScope, recheck: boolean) {
    const now = Date.now();
    const owns = !!userId && !!scope.brand && OWNS[userId]?.includes(scope.brand.slug);
    return {
      v: 1, decision: owns ? "allow" : "deny", reason: owns ? null : "NOT_BRAND_OWNER",
      scope: { app: scope.app, feature: scope.feature, brand_slug: scope.brand?.slug ?? null },
      subject: userId ? { kind: "user", user_id: userId } : { kind: "system" },
      session: userId ? { state: recheck && this.revokeOnRecheck ? "revoked" : "active", ref: "s-1" } : null,
      owner_epoch: owns ? "g5oe:5:1" : null, entitlements: ["postona:x_autopost"], issued_at_ms: now, expires_at_ms: now + 60_000,
    };
  }
  fetchVerdict(credential: unknown, scope: VerdictScope) {
    return Promise.resolve(this.wire(USERS[String(credential)], scope, false));
  }
  fetchRecheck(_credential: unknown, scope: VerdictScope, subject: { kind: "user"; userId: string } | { kind: "system" }) {
    return Promise.resolve(this.wire(subject.kind === "user" ? subject.userId : undefined, scope, true));
  }
}

const SET = buildAppPolicySet({
  "postona:consult": {
    enabled: true, revision: "test-consult-r1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 900, timeoutMs: 25_000,
    maxAttempts: 1, maxCostUsdPerOperation: 0.2, maxInputBytes: 40_000, entitlements: ["postona:x_autopost"],
  },
}, { "postona:consult": POSTONA_CONSULT_CONTENT });

const answer = {
  kind: "chat", reply: "いいですね。", follow_up_questions: [],
  settings_delta: { preferredTone: null, themes: null, objective: null, frequencyTargetPerWeek: null, optionalNgWords: null, notes: null },
  persona_delta: { toneSignals: null, sentenceLength: null, punctuationEmoji: null, recurringVocabulary: null, topicSignals: null, hashtagHabits: null, ctaStyle: null, openingClosingPatterns: null },
  confidence: "high", uncertainty: [], history_learning_requested: false,
};
function world(options: { respond?: () => Response | Promise<Response>; g5?: G5 } = {}) {
  const openai = recordingFetch(() => (options.respond ?? (() => jsonResponse(200, openAiBody(answer, { model: "gpt-6-luna" }))))());
  const fetch: FetchLike = (input, init) => (String(input).startsWith(SUPABASE) ? supabaseFetch(input, init) : openai.fetch(input, init));
  const gateway = createAiGateway({
    // G6-20: this suite pins the legacy busy re-claim check; the owner-held default has its own suites.
    ledgerMode: "legacy_busy_check_unsafe",
    supabaseUrl: SUPABASE,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : undefined),
    authority: createG5AuthorityPort({ transport: options.g5 ?? new G5(), planAllowlist: SET.planAllowlist }),
    policies: SET.registry,
    fetch,
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  const deps: ConsultDependencies = { supabaseUrl: SUPABASE, publishableKey: PUBLISHABLE, openAiApiKey: "", fetchImpl: fetch as typeof globalThis.fetch, log: () => {} };
  const send = async (jwt: string, brand: string, key: string, message = "今日は何を書こう") => {
    const text = JSON.stringify({ brand_id: brand, message, history: [] });
    const headers = { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(text).length), "Idempotency-Key": key };
    const response = await handleConsultViaGateway(new Request("https://edge.example/social-mobile-consult", { method: "POST", headers, body: text }), deps, gateway);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { openai, send };
}
const callRow = async (userId: string, brand: string) =>
  await rows(`select coalesce(string_agg(c.state || '|' || (c.result ->> 'ok') || '|' || coalesce(c.result ->> 'code', '-') || '|' || r.status, ',' order by c.created_at), '-') from ai_calls.consumer_calls c left join ai_ledger.reservations r on r.request_id = c.call_key where c.user_id = '${userId}' and c.brand_ref = '${brand}'`);

Deno.test({ name: "setup: the consult ledger policy", ...opts }, async () => {
  await rows(`insert into ai_ledger.budget_policies
    (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
    values ('gwp.postona.consult.user.daily', 'openai', 'gpt-6-luna', 'postona', 'consult', 'user', true, 'day', 100, 5, 0.2)`);
});

Deno.test({ name: "consult E2E on real SQL: one ai_calls row (brand_ref, user, catalog role, test revision) + one settled reservation; replay from a new runtime sends nothing", ...opts }, async () => {
  const w = world();
  const first = await w.send("jwt-a-NOT-REAL", BRAND_A, "consult-pg-0001");
  assert.deepEqual([first.status, first.body.success], [200, true]);
  assert.equal(await callRow(USER_A, BRAND_A), "complete|true|-|settled");
  assert.equal(await rows(`select (audit ->> 'role') || '|' || (audit ->> 'policyVersion') || '|' || feature from ai_calls.consumer_calls where user_id = '${USER_A}' and brand_ref = '${BRAND_A}'`), "postona.consult.reply|test-consult-r1|postona:consult");
  const again = world();
  assert.deepEqual(await again.send("jwt-a-NOT-REAL", BRAND_A, "consult-pg-0001"), first);
  assert.equal(w.openai.calls.length + again.openai.calls.length, 1);
});

Deno.test({ name: "consult E2E on real SQL: the same key for another brand / person is its own row and charge; another message under the key is CONSULT_OPERATION_REUSED; parallel duplicates send once", ...opts }, async () => {
  const w = world();
  assert.equal((await w.send("jwt-a-NOT-REAL", BRAND_A2, "consult-pg-0001")).status, 200);
  assert.equal((await w.send("jwt-b-NOT-REAL", BRAND_B, "consult-pg-0001")).status, 200);
  assert.deepEqual([await callRow(USER_A, BRAND_A2), await callRow(USER_B, BRAND_B)], ["complete|true|-|settled", "complete|true|-|settled"]);
  const reused = await w.send("jwt-a-NOT-REAL", BRAND_A, "consult-pg-0001", "全然違う話");
  assert.deepEqual([reused.status, reused.body.error], [409, "CONSULT_OPERATION_REUSED"]);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const p = world({ respond: async () => (await gate, jsonResponse(200, openAiBody(answer, { model: "gpt-6-luna" }))) });
  const first = p.send("jwt-a-NOT-REAL", BRAND_A, "consult-pg-par1");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const second = await world().send("jwt-a-NOT-REAL", BRAND_A, "consult-pg-par1");
  release();
  assert.deepEqual([second.status, second.body.error, (await first).status, p.openai.calls.length], [409, "CONSULT_IN_PROGRESS", 200, 1]);
  assert.equal(w.openai.calls.length, 2);
});

Deno.test({ name: "consult E2E on real SQL: revoked at the recheck -> 403, reservation released, POLICY_DENIED stored, replay CONSULT_NOT_SENT; 504 -> CONSULT_AI_UNKNOWN at the upper bound in both stores", ...opts }, async () => {
  const g5 = new G5();
  g5.revokeOnRecheck = true;
  const w = world({ g5 });
  const r = await w.send("jwt-a-NOT-REAL", BRAND_A, "consult-pg-rev1");
  assert.deepEqual([r.status, r.body.error, w.openai.calls.length], [403, "CONSULT_NOT_ENTITLED", 0]);
  assert.equal(await rows(`select c.result ->> 'code' || '|' || r.status from ai_calls.consumer_calls c join ai_ledger.reservations r on r.request_id = c.call_key where c.result ->> 'code' = 'POLICY_DENIED'`), "POLICY_DENIED|released");
  assert.equal((await world().send("jwt-a-NOT-REAL", BRAND_A, "consult-pg-rev1")).body.error, "CONSULT_NOT_SENT");
  const u = world({ respond: () => jsonResponse(504, { error: { type: "timeout" } }) });
  const unknown = await u.send("jwt-a-NOT-REAL", BRAND_A, "consult-pg-504a");
  assert.deepEqual([unknown.status, unknown.body.error], [502, "CONSULT_AI_UNKNOWN"]);
  assert.equal(await rows(`select c.result ->> 'code' || '|' || r.status || '|' || e.cost_basis from ai_calls.consumer_calls c join ai_ledger.reservations r on r.request_id = c.call_key join ai_ledger.usage_events e on e.request_id = c.call_key where c.result ->> 'code' = 'UNKNOWN'`), "UNKNOWN|unknown|upper_bound");
  assert.equal((await u.send("jwt-a-NOT-REAL", BRAND_A, "consult-pg-504a")).body.error, "CONSULT_AI_UNKNOWN");
  assert.equal(u.openai.calls.length, 1);
});
