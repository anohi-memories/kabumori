// OFFLINE tests of G6-03: the REAL, unchanged POSTONA consult handler (handleSocialMobileConsult) served through the
// G6 gateway adapter (handleConsultViaGateway) on the G6 runtime (app policies + G5 port + createAiGateway -> real
// OpenAI adapter, real SupabaseLedgerBudgetGuard, SupabaseAiCallsStore). Fakes: Supabase (Auth user, RLS reads the
// handler makes, ledger + ai_calls RPCs, in memory), a synthetic G5, OpenAI. No network, fake keys. Mock PASS only:
// the deployed handler, real G5, real OpenAI and managed Supabase are NOT_VERIFIED.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY supabase/tests/common_ai_gateway_postona_consult_test.ts
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { FAKE_OPENAI_KEY, jsonResponse, openAiBody, type RecordedCall, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import { CONSULT_SYSTEM_PROMPT, type ConsultDependencies } from "../functions/social-mobile-consult/logic.ts";
import { SOCIAL_MOBILE_USER_DEFAULTS } from "../functions/_shared/brand/social_mobile_content_settings.ts";
import { buildAppPolicySet, type FeatureConfig } from "../functions/_shared/ai_gateway/app_policies.ts";
import { createG5AuthorityPort, type G5Transport, type VerdictScope } from "../functions/_shared/ai_gateway/authority_port.ts";
import type { GatewayCode } from "../functions/_shared/ai_gateway/gateway.ts";
import { consultErrorFor, consultGatewayInput, consultModelCallViaGateway, G5_NOT_CONNECTED, handleConsultViaGateway, POSTONA_CONSULT_CONTENT } from "../functions/_shared/ai_gateway/postona_consult_adapter.ts";
import { createAiGateway } from "../functions/_shared/ai_gateway/runtime.ts";

const SUPABASE = "http://127.0.0.1:54321";
const SERVICE_KEY = "local-g6-03-service-key-NOT-A-SECRET";
const PUBLISHABLE = "local-g6-03-publishable-NOT-A-SECRET";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const BRAND_A = "u_ae343f5caedb67d4af33fc7a";
const BRAND_A2 = "u_0b1c2d3e4f5061728394a5b6";
const BRAND_B = "u_9f8e7d6c5b4a39281706f5e4";
const JWT = { a: "jwt-user-a-NOT-A-REAL-TOKEN", b: "jwt-user-b-NOT-A-REAL-TOKEN" } as const;
const USERS: Record<string, string> = { [JWT.a]: USER_A, [JWT.b]: USER_B };
const OWNS: Record<string, string[]> = { [USER_A]: [BRAND_A, BRAND_A2], [USER_B]: [BRAND_B] };

/** The only model answer shape the consult schema allows. */
const answer = (reply = "どんな発信をしたいですか？", over: Record<string, unknown> = {}) => ({
  kind: "question",
  reply,
  follow_up_questions: ["誰に向けて発信したいですか？"],
  settings_delta: { preferredTone: null, themes: null, objective: null, frequencyTargetPerWeek: null, optionalNgWords: null, notes: null },
  persona_delta: { toneSignals: null, sentenceLength: null, punctuationEmoji: null, recurringVocabulary: null, topicSignals: null, hashtagHabits: null, ctaStyle: null, openingClosingPatterns: null },
  confidence: "medium",
  uncertainty: [],
  history_learning_requested: false,
  ...over,
});
const openAiOk = (payload: unknown = answer()) => () => jsonResponse(200, openAiBody(payload, { model: "gpt-6-luna" }));

// Test values only (no plan, price or production model is decided here).
const CONFIG: FeatureConfig = {
  enabled: true,
  revision: "test-consult-r1",
  provider: "openai",
  model: "gpt-6-luna",
  reasoningEffort: "low",
  maxOutputTokens: 900,
  timeoutMs: 25_000,
  maxAttempts: 1,
  maxCostUsdPerOperation: 0.2,
  maxInputBytes: 40_000,
  entitlements: ["postona:x_autopost"],
};

class FakeG5 implements G5Transport {
  calls = 0;
  session: Record<string, string> = { [USER_A]: "active", [USER_B]: "active" };
  entitlements: Record<string, string[]> = { [USER_A]: ["postona:x_autopost"], [USER_B]: ["postona:x_autopost"] };
  revokeOnRecheck = false;
  private wire(userId: string | undefined, scope: VerdictScope, recheck: boolean) {
    const now = Date.now();
    const scopeEcho = { app: scope.app, feature: scope.feature, brand_slug: scope.brand?.slug ?? null };
    if (!userId) return { v: 1, decision: "deny", reason: "NO_SESSION", scope: scopeEcho, subject: { kind: "system" }, session: null, owner_epoch: null, entitlements: [], issued_at_ms: now, expires_at_ms: now + 60_000 };
    const owns = scope.brand ? OWNS[userId]?.includes(scope.brand.slug) : true;
    const state = recheck && this.revokeOnRecheck ? "revoked" : this.session[userId];
    return {
      v: 1, decision: owns ? "allow" : "deny", reason: owns ? null : "NOT_BRAND_OWNER", scope: scopeEcho, subject: { kind: "user", user_id: userId },
      session: { state, ref: `s-${userId.slice(-1)}` }, owner_epoch: owns && scope.brand ? "g5oe:5:1" : null, entitlements: this.entitlements[userId], issued_at_ms: now, expires_at_ms: now + 60_000,
    };
  }
  fetchVerdict(credential: unknown, scope: VerdictScope) {
    this.calls++;
    return Promise.resolve(this.wire(USERS[String(credential)], scope, false));
  }
  fetchRecheck(_credential: unknown, scope: VerdictScope, subject: { kind: "user"; userId: string } | { kind: "system" }) {
    this.calls++;
    return Promise.resolve(this.wire(subject.kind === "user" ? subject.userId : undefined, scope, true));
  }
}

/** In-memory Supabase: the handler's Auth / RLS reads (publishable key + the user's JWT) and the gateway's RPCs (service key). */
class FakeSupabase {
  rpc: string[] = [];
  userReads = 0;
  reservations = new Map<string, string>();
  rows = new Map<string, { identity: string; owner: string; state: string; result: unknown; brandRef: unknown; userId: unknown }>();
  ledgerDown = false;
  private n = 0;
  // deno-lint-ignore require-await
  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      if (headers.get("apikey") !== SERVICE_KEY) return jsonResponse(401, { code: "PGRST301" });
      const name = url.pathname.slice("/rest/v1/rpc/".length);
      this.rpc.push(name.replace(/^ai_(ledger|calls)_/, ""));
      if (this.ledgerDown && name === "ai_ledger_reserve") throw new TypeError("ledger unreachable");
      return jsonResponse(200, this.answerRpc(name, (JSON.parse(String(init?.body)) as { p: Record<string, unknown> }).p));
    }
    // The handler's reads: publishable key + the caller's JWT only (never the service key).
    if (headers.get("apikey") !== PUBLISHABLE) return jsonResponse(401, {});
    this.userReads++;
    const user = USERS[(headers.get("authorization") ?? "").replace(/^Bearer /u, "")];
    if (url.pathname === "/auth/v1/user") return user ? jsonResponse(200, { id: user }) : jsonResponse(401, {});
    const brandId = (url.searchParams.get("brand_id") ?? url.searchParams.get("id") ?? "").replace(/^eq\./u, "");
    if (url.pathname === "/rest/v1/brand_memberships") return jsonResponse(200, user && OWNS[user]?.includes(brandId) ? [{ brand_id: brandId, role: "owner", user_id: user }] : []);
    if (url.pathname === "/rest/v1/brands") return jsonResponse(200, [{ id: brandId, code_profile_key: "social_mobile_user_v1" }]);
    if (url.pathname === "/rest/v1/social_mobile_content_settings") return jsonResponse(200, []);
    return jsonResponse(404, {});
  };
  private answerRpc(name: string, p: Record<string, unknown>): unknown {
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
          this.rows.set(String(p.call_key), { identity, owner, state: "acquired", result: null, brandRef: p.brand_ref, userId: p.user_id });
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

function world(options: { respond?: (call: RecordedCall) => Response | Promise<Response>; transport?: G5Transport; supabase?: FakeSupabase; gateway?: "off"; config?: FeatureConfig } = {}) {
  const supabase = options.supabase ?? new FakeSupabase();
  const g5 = new FakeG5();
  const openai = recordingFetch((call) => (options.respond ?? openAiOk())(call));
  const fetch: FetchLike = (input, init) => (String(input).startsWith(SUPABASE) ? supabase.fetch(input, init) : openai.fetch(input, init));
  const set = buildAppPolicySet({ "postona:consult": options.config ?? CONFIG }, { "postona:consult": POSTONA_CONSULT_CONTENT });
  const gateway = options.gateway === "off" ? null : createAiGateway({
    // G6-20: this suite pins the legacy busy re-claim check; the owner-held default has its own suites.
    ledgerMode: "legacy_busy_check_unsafe",
    supabaseUrl: SUPABASE,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : undefined),
    authority: createG5AuthorityPort({ transport: options.transport ?? g5, planAllowlist: set.planAllowlist }),
    policies: set.registry,
    fetch,
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  const logs: unknown[] = [];
  const deps: ConsultDependencies = { supabaseUrl: SUPABASE, publishableKey: PUBLISHABLE, openAiApiKey: "sk-test-direct-openai-NOT-USED", fetchImpl: fetch as typeof globalThis.fetch, log: (e) => logs.push(e) };
  const send = async (jwt: string, body: Record<string, unknown>, key: string | null = "consult-op-0001", length: "declared" | "missing" = "declared") => {
    const text = JSON.stringify(body);
    const headers: Record<string, string> = { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" };
    if (length === "declared") headers["Content-Length"] = String(new TextEncoder().encode(text).length);
    if (key !== null) headers["Idempotency-Key"] = key;
    const response = await handleConsultViaGateway(new Request("https://edge.example/social-mobile-consult", { method: "POST", headers, body: text }), deps, gateway);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { supabase, g5, openai, send, logs, set };
}
const ask = (brand = BRAND_A, message = "今日は何を投稿しようかな", history: unknown[] = []) => ({ brand_id: brand, message, history });

Deno.test("the unchanged handler through the gateway: one OpenAI request with the handler's own prompt and schema, the sanitized result; a replay with the same Idempotency-Key sends nothing", async () => {
  const w = world();
  const first = await w.send(JWT.a, ask(BRAND_A, "誰向けに書けばいい？", [{ role: "user", text: "こんにちは" }, { role: "assistant", text: "こんにちは！" }]));
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.equal((first.body.result as Record<string, unknown>).kind, "question");
  assert.deepEqual([first.body.settings_saved, first.body.publish_attempted, first.body.x_api_called], [false, false, false]);
  assert.equal(w.openai.calls.length, 1);
  const req = w.openai.calls[0];
  assert.equal(req.url, "https://api.openai.com/v1/responses");
  assert.equal(req.headers.get("authorization"), `Bearer ${FAKE_OPENAI_KEY}`, "the gateway's provider key, never the handler's direct key");
  const body = req.body as Record<string, unknown>;
  const sent = JSON.stringify(body);
  assert.equal(sent.includes(JSON.stringify(CONSULT_SYSTEM_PROMPT).slice(1, -1)), true, "the handler's prompt, verbatim");
  assert.equal(sent.includes("social_mobile_consult"), true, "the handler's schema name");
  assert.equal(sent.includes("誰向けに書けばいい？") && sent.includes("こんにちは！"), true, "message and history are sent as data");
  assert.equal(sent.includes("saved_settings") && sent.includes("read_only"), true, "the saved state the handler builds is sent as data");
  for (const secret of [JWT.a, USER_A, BRAND_A, SERVICE_KEY, PUBLISHABLE, "sk-test-direct-openai-NOT-USED"]) assert.equal(sent.includes(secret), false, `not in the provider request: ${secret}`);
  assert.deepEqual(w.supabase.rpc, ["claim", "reserve", "claim", "mark_sent", "settle", "complete"]);
  const [row] = [...w.supabase.rows.values()];
  assert.deepEqual([row.brandRef, row.userId], [BRAND_A, USER_A]);
  const replay = await w.send(JWT.a, ask(BRAND_A, "誰向けに書けばいい？", [{ role: "user", text: "こんにちは" }, { role: "assistant", text: "こんにちは！" }]));
  assert.deepEqual(replay, first);
  assert.equal(w.openai.calls.length, 1, "replayed, not resent");
  assert.ok(w.logs.every((e) => !JSON.stringify(e).includes("誰向けに書けばいい？")), "the handler's logs stay metadata only");
});

Deno.test("default deny: no gateway, G5 not connected, no Idempotency-Key, or a brand id the gateway cannot carry -> nothing sent (and never the direct OpenAI path)", async () => {
  const off = world({ gateway: "off" });
  const r1 = await off.send(JWT.a, ask());
  assert.deepEqual([r1.status, r1.body.error, off.openai.calls.length, off.supabase.rpc.length], [503, "CONSULT_AI_UNAVAILABLE", 0, 0]);
  const g5 = world({ transport: G5_NOT_CONNECTED });
  const r2 = await g5.send(JWT.a, ask());
  assert.deepEqual([r2.status, r2.body.error, r2.body.retryable, g5.openai.calls.length, g5.supabase.rpc.length], [503, "CONSULT_AUTH_UNAVAILABLE", true, 0, 0]);
  const nokey = world();
  for (const key of [null, "short", "has space key 1"]) {
    const r = await nokey.send(JWT.a, ask(), key);
    assert.deepEqual([r.status, r.body.error], [400, "CONSULT_IDEMPOTENCY_KEY_REQUIRED"], String(key));
  }
  assert.deepEqual([nokey.openai.calls.length, nokey.supabase.rpc.length, nokey.g5.calls], [0, 0, 0]);
  // Without a declared body size the adapter does not read the body before the handler: nothing is sent.
  const nolen = world();
  const r3 = await nolen.send(JWT.a, ask(), "consult-op-0001", "missing");
  assert.deepEqual([r3.status, r3.body.error, nolen.openai.calls.length, nolen.g5.calls], [503, "CONSULT_AI_UNAVAILABLE", 0, 0]);
  // The handler accepts brand ids the gateway's brand slug cannot carry: refused before G5.
  OWNS[USER_A].push("Legacy-Brand-01");
  try {
    const odd = world();
    const r = await odd.send(JWT.a, ask("Legacy-Brand-01"));
    assert.deepEqual([r.status, r.body.error, odd.openai.calls.length, odd.g5.calls], [503, "CONSULT_AI_UNAVAILABLE", 0, 0]);
  } finally {
    OWNS[USER_A].pop();
  }
});

Deno.test("authority: the handler's own checks still run first (no JWT / foreign brand -> refused before G5); G5 deny, no plan, revoked at the recheck -> CONSULT_NOT_ENTITLED with nothing sent", async () => {
  const w = world();
  const anonymous = await w.send("not-a-user", ask());
  assert.deepEqual([anonymous.status, anonymous.body.error, w.g5.calls], [401, "AUTH_REQUIRED", 0]);
  const foreign = await w.send(JWT.a, ask(BRAND_B));
  assert.deepEqual([foreign.status, foreign.body.error, w.g5.calls, w.openai.calls.length], [404, "OWNED_WORKSPACE_NOT_FOUND", 0, 0]);
  const noPlan = world();
  noPlan.g5.entitlements[USER_A] = [];
  const r1 = await noPlan.send(JWT.a, ask());
  assert.deepEqual([r1.status, r1.body.error, r1.body.retryable, noPlan.openai.calls.length, noPlan.supabase.rpc.length], [403, "CONSULT_NOT_ENTITLED", false, 0, 0]);
  const revoked = world();
  revoked.g5.revokeOnRecheck = true;
  const r2 = await revoked.send(JWT.a, ask());
  assert.deepEqual([r2.status, r2.body.error, revoked.openai.calls.length], [403, "CONSULT_NOT_ENTITLED", 0]);
  assert.deepEqual([...revoked.supabase.reservations.values()], ["released"]);
  revoked.g5.revokeOnRecheck = false;
  const replay = await revoked.send(JWT.a, ask());
  assert.deepEqual([replay.status, replay.body.error, revoked.openai.calls.length], [503, "CONSULT_NOT_SENT", 0]);
});

Deno.test("idempotency is per person, brand and content: same key for another person / brand is another call; same key with another message is CONSULT_OPERATION_REUSED; parallel same key sends once", async () => {
  const w = world();
  const a = await w.send(JWT.a, ask(BRAND_A));
  const a2 = await w.send(JWT.a, ask(BRAND_A2));
  const b = await w.send(JWT.b, ask(BRAND_B));
  assert.deepEqual([a.status, a2.status, b.status, w.openai.calls.length, w.supabase.rows.size], [200, 200, 200, 3, 3]);
  const reused = await w.send(JWT.a, ask(BRAND_A, "別の話をしたい"));
  assert.deepEqual([reused.status, reused.body.error, reused.body.retryable, w.openai.calls.length], [409, "CONSULT_OPERATION_REUSED", false, 3]);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const p = world({ respond: async () => (await gate, openAiOk()()) });
  const first = p.send(JWT.a, ask(), "consult-op-par-1");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await p.send(JWT.a, ask(), "consult-op-par-1");
  release();
  assert.deepEqual([second.status, second.body.error, second.body.retryable, (await first).status, p.openai.calls.length], [409, "CONSULT_IN_PROGRESS", true, 200, 1]);
});

Deno.test("money and failures: 504 -> CONSULT_AI_UNKNOWN (never resent, upper bound in the ledger); provider 400 -> CONSULT_AI_FAILED; ledger down -> CONSULT_AI_UNKNOWN (G6-10: not provably unsent); a schema-breaking answer -> CONSULT_AI_MALFORMED", async () => {
  const u = world({ respond: () => jsonResponse(504, { error: { type: "timeout" } }) });
  const unknown = await u.send(JWT.a, ask());
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.retryable, [...u.supabase.reservations.values()]], [502, "CONSULT_AI_UNKNOWN", false, ["unknown"]]);
  assert.deepEqual([(await u.send(JWT.a, ask())).body.error, u.openai.calls.length], ["CONSULT_AI_UNKNOWN", 1]);
  const f = world({ respond: () => jsonResponse(400, { error: { type: "invalid_request_error" } }) });
  assert.deepEqual([(await f.send(JWT.a, ask())).body.error, f.openai.calls.length], ["CONSULT_AI_FAILED", 1]);
  const l = world();
  l.supabase.ledgerDown = true;
  const down = await l.send(JWT.a, ask());
  assert.deepEqual([down.status, down.body.error, down.body.retryable, l.openai.calls.length], [502, "CONSULT_AI_UNKNOWN", false, 0]);
  l.supabase.ledgerDown = false;
  assert.equal((await l.send(JWT.a, ask(), "consult-op-0002")).status, 200, "a new key works after recovery");
  const bad = world({ respond: openAiOk({ ...answer(), kind: "post_now" }) });
  const malformed = await bad.send(JWT.a, ask());
  assert.deepEqual([malformed.status, malformed.body.error, bad.openai.calls.length], [502, "CONSULT_AI_MALFORMED", 1]);
});

Deno.test("sanitize boundary: what the handler's sanitizer refuses is refused at the gateway too (stored OUTPUT_REJECTED, never resent); what it normalises per request (truncation, a no-op proposal) stays the handler's job after the gateway", async () => {
  // Refusals are shape-only, so the gateway's check (the same sanitizer, neutral saved state) refuses the same answers.
  for (const [label, payload] of [
    ["blank reply", answer("   ")],
    ["unknown settings field", { ...answer(), settings_delta: { ...answer().settings_delta, autoPost: true } }],
    ["frequency out of range", { ...answer(), kind: "proposal", settings_delta: { ...answer().settings_delta, frequencyTargetPerWeek: 99 } }],
  ] as const) {
    const w = world({ respond: openAiOk(payload) });
    const r = await w.send(JWT.a, ask());
    assert.deepEqual([r.status, r.body.error, r.body.retryable], [502, "CONSULT_AI_MALFORMED", false], label);
    const stored = [...w.supabase.rows.values()][0].result as { code?: string };
    assert.equal(stored.code, "OUTPUT_REJECTED", `${label}: final at the gateway`);
    assert.deepEqual([(await w.send(JWT.a, ask())).body.error, w.openai.calls.length], ["CONSULT_AI_MALFORMED", 1], `${label}: never resent`);
  }
  // Normalisation needs the request's own saved state and message: the gateway stores the raw answer, the handler
  // shapes it on every answer (first and replay alike).
  const long = world({ respond: openAiOk(answer("あ".repeat(1300))) });
  const r = await long.send(JWT.a, ask());
  assert.equal(r.status, 200);
  assert.equal(((r.body.result as Record<string, unknown>).assistantReply as string).length, 1200, "truncated by the handler");
  const stored = [...long.supabase.rows.values()][0].result as { data: { reply: string } };
  assert.equal(stored.data.reply.length, 1300, "the gateway keeps the model's answer as given");
  const noop = world({ respond: openAiOk({ ...answer(), kind: "proposal", follow_up_questions: [], settings_delta: { ...answer().settings_delta, frequencyTargetPerWeek: SOCIAL_MOBILE_USER_DEFAULTS.frequencyTargetPerWeek } }) });
  const n = await noop.send(JWT.a, ask());
  assert.deepEqual([n.status, (n.body.result as Record<string, unknown>).kind, (n.body.result as Record<string, unknown>).proposedSettingsDelta], [200, "chat", {}], "a 'change' equal to the saved value is not a proposal");
  const history = world();
  const h = await history.send(JWT.a, ask(BRAND_A, "過去の投稿を読んで学んで"));
  assert.equal(((h.body.result as Record<string, unknown>).historyLearningIntent as Record<string, unknown>).explicitConsent, true, "the user's own words, checked by the handler");
});

Deno.test("the adapter refuses a body that drifted from the handler's prompt / schema / shape, before any gateway call; every gateway code has a consult error", async () => {
  let executed = 0;
  const gateway = { execute: () => (executed++, Promise.resolve({ ok: true as const, data: answer(), audit: {} as never })) };
  const call = consultModelCallViaGateway({ gateway, credential: JWT.a, operationId: "consult-op-0001", brandSlug: BRAND_A });
  const good = { model: "gpt-6-luna", input: [{ role: "system", content: CONSULT_SYSTEM_PROMPT }, { role: "system", content: "現在保存されている内容（データ）:\n{}" }, { role: "user", content: "やあ" }], text: { format: { type: "json_schema", name: "social_mobile_consult", strict: true, schema: POSTONA_CONSULT_CONTENT.schema.schema } } };
  assert.ok(consultGatewayInput(good));
  const drifts: Array<[string, Record<string, unknown>]> = [
    ["prompt", { ...good, input: [{ role: "system", content: CONSULT_SYSTEM_PROMPT + "追加" }, ...good.input.slice(1)] }],
    ["schema", { ...good, text: { format: { ...good.text.format, schema: { type: "object" } } } }],
    ["schema name", { ...good, text: { format: { ...good.text.format, name: "other" } } }],
    ["saved state", { ...good, input: [good.input[0], { role: "system", content: "other" }, good.input[2]] }],
    ["last turn not the user", { ...good, input: [...good.input, { role: "assistant", content: "x" }] }],
    ["turn with extra keys", { ...good, input: [good.input[0], good.input[1], { role: "user", content: "a", name: "x" }, good.input[2]] }],
  ];
  for (const [label, body] of drifts) {
    assert.equal(consultGatewayInput(body), null, label);
    await assert.rejects(call({ openAiApiKey: "", body, timeoutMs: 1, fetchImpl: fetch }), (e: unknown) => (e as { code?: string }).code === "CONSULT_AI_UNAVAILABLE", label);
  }
  assert.equal(executed, 0);
  const codes: GatewayCode[] = ["REQUEST_INVALID", "AUTH_UNAVAILABLE", "AUTH_DENIED", "AUTH_UNKNOWN", "AUTH_PENDING", "AUTH_EXPIRED", "AUTH_SCOPE_MISMATCH", "POLICY_MISSING", "POLICY_SUBJECT_DENIED", "COST_DENIED", "QUOTA_EXCEEDED", "LEDGER_UNAVAILABLE", "STORE_UNAVAILABLE", "IN_PROGRESS", "OPERATION_REUSED", "AUTH_REVOKED_BEFORE_SEND", "NOT_SENT", "PROVIDER_FAILED", "OUTPUT_REJECTED", "UNKNOWN"];
  const table = Object.fromEntries(codes.map((c) => {
    const e = consultErrorFor(c);
    return [c, `${e.code}:${e.status}:${e.retryable}`];
  }));
  assert.deepEqual(table, {
    REQUEST_INVALID: "CONSULT_AI_UNAVAILABLE:503:false",
    AUTH_UNAVAILABLE: "CONSULT_AUTH_UNAVAILABLE:503:true",
    AUTH_DENIED: "CONSULT_NOT_ENTITLED:403:false",
    AUTH_UNKNOWN: "CONSULT_NOT_ENTITLED:403:false",
    AUTH_PENDING: "CONSULT_NOT_ENTITLED:403:false",
    AUTH_EXPIRED: "CONSULT_NOT_ENTITLED:403:false",
    AUTH_SCOPE_MISMATCH: "CONSULT_NOT_ENTITLED:403:false",
    POLICY_MISSING: "CONSULT_NOT_ENTITLED:403:false",
    POLICY_SUBJECT_DENIED: "CONSULT_NOT_ENTITLED:403:false",
    COST_DENIED: "CONSULT_AI_UNAVAILABLE:503:false",
    QUOTA_EXCEEDED: "CONSULT_QUOTA_EXCEEDED:429:false",
    LEDGER_UNAVAILABLE: "CONSULT_NOT_SENT:503:false",
    STORE_UNAVAILABLE: "CONSULT_AI_UNAVAILABLE:503:true",
    IN_PROGRESS: "CONSULT_IN_PROGRESS:409:true",
    OPERATION_REUSED: "CONSULT_OPERATION_REUSED:409:false",
    AUTH_REVOKED_BEFORE_SEND: "CONSULT_NOT_ENTITLED:403:false",
    NOT_SENT: "CONSULT_NOT_SENT:503:false",
    PROVIDER_FAILED: "CONSULT_AI_FAILED:502:false",
    OUTPUT_REJECTED: "CONSULT_AI_MALFORMED:502:false",
    UNKNOWN: "CONSULT_AI_UNKNOWN:502:false",
  });
});

Deno.test("the consult content is the handler's own prompt and schema; it passes the G6 catalog (OpenAI only) and the registry checks", () => {
  assert.equal(POSTONA_CONSULT_CONTENT.systemInstructions, CONSULT_SYSTEM_PROMPT);
  const set = buildAppPolicySet({ "postona:consult": CONFIG }, { "postona:consult": POSTONA_CONSULT_CONTENT });
  assert.equal(set.registry.get("postona:consult")?.schema.name, "social_mobile_consult");
  const claude = buildAppPolicySet({ "postona:consult": { ...CONFIG, provider: "anthropic", model: "claude-haiku-5-5" } }, { "postona:consult": POSTONA_CONSULT_CONTENT });
  assert.equal(claude.registry.has("postona:consult"), false);
  assert.equal(POSTONA_CONSULT_CONTENT.validate(answer()), true);
  assert.equal(POSTONA_CONSULT_CONTENT.validate({ ...answer(), publish: true }), false);
});
