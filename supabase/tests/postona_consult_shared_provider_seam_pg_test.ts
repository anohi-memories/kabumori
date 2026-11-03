// The POSTONA consult seam against the REAL cost ledger (20261010050613) and the REAL call store (20261017120000)
// in a disposable local PostgreSQL: the real SupabaseLedgerBudgetGuard (its PostgREST requests turned into psql
// calls AS service_role) and a call-store adapter over the ai_calls RPCs. Supabase Auth / REST and OpenAI stay fake;
// nothing leaves the machine. Run by supabase/tests/postona_consult_shared_provider_seam_run.sh.
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { type AiSubject, resolveSecret, SupabaseLedgerBudgetGuard } from "../functions/_shared/ai_provider/mod.ts";
import { jsonResponse, openAiBody, recordingFetch, type Responder } from "../functions/_shared/ai_provider/test_support.ts";
import type { BridgeResult, CallClaim, CallIdentity, ConsumerCallStore } from "../functions/_shared/ai_consumer_bridge/types.ts";
import { createConsultSeam } from "./postona_consult_shared_provider_seam.ts";

const HOST = Deno.env.get("ACS_PGHOST");
const PORT = Deno.env.get("ACS_PGPORT");
const SUPER = Deno.env.get("ACS_PGSUPER");
const DB = Deno.env.get("ACS_DB");
const enabled = !!HOST && !!PORT && !!SUPER && !!DB && /^\/(private\/)?tmp\//.test(HOST);
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };

async function psql(statement: string): Promise<{ ok: boolean; out: string; err: string }> {
  const output = await new Deno.Command("psql", {
    args: ["-X", "-h", HOST!, "-p", PORT!, "-U", SUPER!, "-d", DB!, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const t = (b: Uint8Array) => new TextDecoder().decode(b).trim();
  return { ok: output.success, out: t(output.stdout), err: t(output.stderr) };
}
async function rows(sql: string): Promise<string> {
  const r = await psql(sql);
  assert.ok(r.ok, r.err);
  return r.out;
}
async function rpc(name: string, p: unknown): Promise<unknown> {
  if (!/^ai_(calls|ledger)_[a-z_]+$/.test(name)) throw new Error("unexpected rpc");
  const json = JSON.stringify(p);
  if (json.includes("$acs$")) throw new Error("payload contains the quote tag");
  const r = await psql(`set role service_role; select public.${name}($acs$${json}$acs$::jsonb)`);
  if (!r.ok) throw new Error(`RPC_FAILED:${name}`);
  return JSON.parse(r.out);
}
/** The guard's PostgREST request -> the same RPC through psql. */
const ledgerFetch: FetchLike = async (input, init) => {
  const match = new URL(String(input)).pathname.match(/^\/rest\/v1\/rpc\/(ai_ledger_[a-z_]+)$/);
  if (!match || init?.method !== "POST") return new Response("{}", { status: 404 });
  try {
    return new Response(JSON.stringify(await rpc(match[1], (JSON.parse(String(init.body)) as { p: unknown }).p)), { status: 200 });
  } catch {
    return new Response(JSON.stringify({ code: "P0001" }), { status: 400 });
  }
};
/** ConsumerCallStore over the ai_calls RPCs, bound to one request's verified subject. */
function sqlStore(context: Readonly<{ application: string; feature: string; subject: AiSubject }>): ConsumerCallStore {
  return {
    async claim(identity: CallIdentity) {
      return await rpc("ai_calls_claim", {
        call_key: identity.key,
        tenant_tag: identity.tenantTag,
        fingerprint: identity.fingerprint,
        application: context.application,
        feature: context.feature,
        subject_kind: context.subject.kind,
        ...(context.subject.kind === "user" ? { user_id: context.subject.userId } : {}),
      }) as CallClaim;
    },
    async complete(identity: CallIdentity, owner: string, result: BridgeResult) {
      await rpc("ai_calls_complete", { call_key: identity.key, tenant_tag: identity.tenantTag, fingerprint: identity.fingerprint, owner, result });
    },
  };
}

const SUPABASE = "https://example.supabase.co";
const USERS: Record<string, { id: string; brand: string }> = {
  "jwt-a": { id: "11111111-1111-4111-8111-111111111111", brand: "u_ae343f5caedb67d4af33fc7a" },
  "jwt-b": { id: "22222222-2222-4222-8222-222222222222", brand: "u_0b1c2d3e4f5061728394a5b6" },
};
const supabaseFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const user = USERS[(new Headers(init?.headers).get("Authorization") ?? "").replace(/^Bearer /u, "")];
  if (!user) return Promise.resolve(jsonResponse(401, {}));
  const q = url.searchParams;
  switch (url.pathname) {
    case "/auth/v1/user":
      return Promise.resolve(jsonResponse(200, { id: user.id }));
    case "/rest/v1/common_accounts":
    case "/rest/v1/service_entitlements":
      return Promise.resolve(jsonResponse(200, [{ status: "active" }]));
    case "/rest/v1/brand_memberships":
      return Promise.resolve(jsonResponse(200, q.get("brand_id") === `eq.${user.brand}` ? [{ brand_id: user.brand, role: "owner", user_id: user.id }] : []));
    case "/rest/v1/brands":
      return Promise.resolve(jsonResponse(200, [{ id: q.get("id")?.replace(/^eq\./u, ""), code_profile_key: "social_mobile_user_v1" }]));
    case "/rest/v1/social_mobile_content_settings":
      return Promise.resolve(jsonResponse(200, []));
    default:
      return Promise.resolve(jsonResponse(404, {}));
  }
}) as typeof fetch;

const output = {
  kind: "chat",
  reply: "今日は小さな失敗談はどうでしょう。",
  follow_up_questions: [],
  settings_delta: { preferredTone: null, themes: null, objective: null, frequencyTargetPerWeek: null, optionalNgWords: null, notes: null },
  persona_delta: { toneSignals: null, sentenceLength: null, punctuationEmoji: null, recurringVocabulary: null, topicSignals: null, hashtagHabits: null, ctaStyle: null, openingClosingPatterns: null },
  confidence: "medium",
  uncertainty: [],
  history_learning_requested: false,
};
function seam(respond: Responder = () => jsonResponse(200, openAiBody(output, { model: "gpt-6-luna-2026-09-01" }))) {
  const openai = recordingFetch(respond);
  const key = resolveSecret("ACS_LEDGER_KEY", () => "local-ledger-key-not-a-secret");
  assert.ok(key.ok);
  const handler = createConsultSeam({
    supabaseUrl: SUPABASE,
    publishableKey: "publishable-fixture",
    fetchImpl: supabaseFetch,
    provider: {
      readEnv: (name: string) => (name === "OPENAI_API_KEY" ? "test-openai-key-NOT-REAL-0000000000" : undefined),
      fetch: openai.fetch,
      retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
      sleep: () => Promise.resolve(),
      random: () => 0,
    },
    budget: new SupabaseLedgerBudgetGuard({ supabaseUrl: "http://127.0.0.1:9", serviceKey: key.value, fetch: ledgerFetch }),
    storeFor: sqlStore,
    log: () => {},
  });
  return { handler, openai };
}
const consult = (token: string, operationId: string, message = "今日何投稿しようかな") =>
  new Request(`${SUPABASE}/functions/v1/social-mobile-consult`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": operationId, "Content-Type": "application/json" },
    body: JSON.stringify({ brand_id: USERS[token].brand, message }),
  });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

Deno.test({ name: "setup: a fully scoped per-user daily cap of 1 for OpenAI postona / consult", ...opts }, async () => {
  await rows(`insert into ai_ledger.budget_policies (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_usd_per_call)
              values ('openai.postona.consult.user.daily', 'openai', 'gpt-6-luna', 'postona', 'consult', 'user', true, 'day', 1, 0.05)`);
});

Deno.test({ name: "one consultation lands in the real ledger (settled, request_id = call key) and the real call store; a replay sends and reserves nothing", ...opts }, async () => {
  const s = seam();
  const first = await json(await s.handler(consult("jwt-a", "op-a-0000000001")));
  assert.equal(first.status, 200);
  assert.equal(first.body.result.assistantReply, "今日は小さな失敗談はどうでしょう。");
  const key = await rows(`select call_key from ai_calls.consumer_calls where user_id = '${USERS["jwt-a"].id}'`);
  assert.match(key, /^h5m2_[0-9a-f]{64}$/);
  assert.equal(await rows(`select state || '|' || (result ->> 'ok') || '|' || feature from ai_calls.consumer_calls where call_key = '${key}'`), "complete|true|postona.consult");
  assert.equal(await rows(`select count(*) || '|' || min(status) || '|' || min(model) || '|' || min(feature) from ai_ledger.reservations where request_id = '${key}'`), "1|settled|gpt-6-luna|consult");
  assert.equal(await rows(`select cost_basis || '|' || input_tokens || '|' || output_tokens from ai_ledger.usage_events where request_id = '${key}'`), "measured|1000|300");
  const replay = await json(await s.handler(consult("jwt-a", "op-a-0000000001")));
  assert.deepEqual(replay, first);
  assert.equal(s.openai.calls.length, 1);
  assert.equal(await rows(`select count(*) from ai_ledger.reservations where user_id = '${USERS["jwt-a"].id}'`), "1");
});

Deno.test({ name: "the per-user cap: the next message of the day is CONSULT_QUOTA_EXCEEDED before any request, stored and replayed as such", ...opts }, async () => {
  const s = seam();
  const denied = await json(await s.handler(consult("jwt-a", "op-a-0000000002", "もう一つ相談")));
  assert.deepEqual([denied.status, denied.body.error], [429, "CONSULT_QUOTA_EXCEEDED"]);
  assert.equal(s.openai.calls.length, 0);
  assert.equal(await rows(`select count(*) from ai_ledger.reservations where user_id = '${USERS["jwt-a"].id}'`), "1", "no reservation for the denied message");
  assert.equal(await rows(`select count(*) from ai_calls.consumer_calls where user_id = '${USERS["jwt-a"].id}' and result ->> 'code' = 'BUDGET_DENIED'`), "1");
  assert.deepEqual(await json(await s.handler(consult("jwt-a", "op-a-0000000002", "もう一つ相談"))), denied);
});

Deno.test({ name: "no matching policy (the cap disabled) fails closed: CONSULT_QUOTA_EXCEEDED, nothing sent", ...opts }, async () => {
  await rows("update ai_ledger.budget_policies set enabled = false where policy_key = 'openai.postona.consult.user.daily'");
  try {
    const s = seam();
    const answer = await json(await s.handler(consult("jwt-b", "op-b-0000000001")));
    assert.deepEqual([answer.status, answer.body.error], [429, "CONSULT_QUOTA_EXCEEDED"]);
    assert.equal(s.openai.calls.length, 0);
  } finally {
    await rows("update ai_ledger.budget_policies set enabled = true where policy_key = 'openai.postona.consult.user.daily'");
  }
});

Deno.test({ name: "connection lost after sending: the real ledger keeps the attempt unknown at its upper bound, the store UNKNOWN; never resent", ...opts }, async () => {
  const s = seam(() => Promise.reject(new TypeError("connection reset")));
  const first = await json(await s.handler(consult("jwt-b", "op-b-0000000002")));
  assert.deepEqual([first.status, first.body.error], [502, "CONSULT_AI_UNKNOWN"]);
  const key = await rows(`select call_key from ai_calls.consumer_calls where user_id = '${USERS["jwt-b"].id}' and result ->> 'code' = 'UNKNOWN'`);
  assert.equal(await rows(`select status from ai_ledger.reservations where request_id = '${key}'`), "unknown");
  assert.equal(await rows(`select cost_basis from ai_ledger.usage_events where request_id = '${key}'`), "upper_bound");
  assert.deepEqual(await json(await s.handler(consult("jwt-b", "op-b-0000000002"))), first);
  assert.equal(s.openai.calls.length, 1);
});
