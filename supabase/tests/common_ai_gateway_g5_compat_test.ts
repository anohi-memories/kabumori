// OFFLINE tests of G6-04: G6's G5 authority port and the transport for G5's PROPOSED verdict RPC, against wire samples
// produced by G5's own reference code (fixtures/g5_verdict_v1_rpc_samples.json, from PR #340 head 80b90bd9; the G5 code was
// run in a scratch directory only). The RPC does not exist: every test uses a fake PostgREST; no network, fake keys.
// Mock PASS only: the real G5 RPC, managed Supabase and the deployed consult handler are NOT_VERIFIED.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net --deny-write \
//     --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY --allow-read=supabase/tests/fixtures supabase/tests/common_ai_gateway_g5_compat_test.ts
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { FAKE_OPENAI_KEY, jsonResponse, openAiBody, type RecordedCall, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import type { ConsultDependencies } from "../functions/social-mobile-consult/logic.ts";
import { buildAppPolicySet } from "../functions/_shared/ai_gateway/app_policies.ts";
import { createG5AuthorityPort, G5_ALLOW_TTL_MS, type G5Transport, type VerdictScope } from "../functions/_shared/ai_gateway/authority_port.ts";
import { createG5RpcTransport, G5_VERDICT_RPC } from "../functions/_shared/ai_gateway/g5_rpc_transport.ts";
import { handleConsultViaGateway, POSTONA_CONSULT_CONTENT } from "../functions/_shared/ai_gateway/postona_consult_adapter.ts";
import { createAiGateway } from "../functions/_shared/ai_gateway/runtime.ts";

type Sample = { name: string; scope: { app: string; feature: string; brand_slug: string | null }; g5_decision: string; g5_reason: string | null; rpc_wire: Record<string, unknown> };
const FIXTURE = JSON.parse(await Deno.readTextFile(new URL("./fixtures/g5_verdict_v1_rpc_samples.json", import.meta.url))) as { provenance: Record<string, string>; samples: Sample[] };
const SAMPLES = FIXTURE.samples;
const ALLOW = SAMPLES.find((s) => s.name === "allow consult")!;

const SUPABASE = "http://127.0.0.1:54321";
const PUBLISHABLE = "local-g6-04-publishable-NOT-A-SECRET";
const SERVICE_KEY = "local-g6-04-service-NOT-A-SECRET";
const USER = "11111111-1111-4111-8111-111111111111";
const BRAND = "u_ae343f5caedb67d4af33fc7a";
const JWT = "eyFAKE0.payloadNOTREAL.signatureNOTREAL"; // JWT-shaped, not a token
const PLAN = new Map<string, readonly string[]>([["postona:consult", ["postona:x_autopost"]], ["postona:post_generation", ["postona:x_autopost"]], ["kabumori:market_report", []]]);
const scopeOf = (s: Sample["scope"]): VerdictScope => ({ app: s.app as VerdictScope["app"], feature: s.feature, brand: s.brand_slug ? { app: "postona", slug: s.brand_slug } : null });

/** A fake PostgREST for the proposed RPC: answers a queue of bodies (or a status) and records every request. */
class FakeRpc {
  requests: RecordedCall[] = [];
  redirects: string[] = [];
  answers: Array<{ status: number; body: unknown } | Error> = [];
  readonly fetch: FetchLike = async (input, init) => {
    const call: RecordedCall = { url: String(input), method: String(init?.method), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    this.requests.push(call);
    this.redirects.push(String(init?.redirect));
    const next = this.answers.length > 1 ? this.answers.shift()! : this.answers[0];
    if (!next) return jsonResponse(404, { code: "PGRST202" }); // the RPC does not exist (today)
    if (next instanceof Error) throw next;
    return await Promise.resolve(jsonResponse(next.status, next.body));
  };
}
const transport = (rpc: FakeRpc, now = () => 1_760_000_000_000) => createG5RpcTransport({ supabaseUrl: SUPABASE, publishableKey: PUBLISHABLE, fetch: rpc.fetch, nowMs: now });

Deno.test("fixture provenance: produced by G5's own reference (PR #340), RPC-shaped (no times), 20 samples incl. 2 allows", () => {
  assert.equal(FIXTURE.provenance.head, "80b90bd9d4030873f876a1d3d60c621f9a6173a2");
  assert.equal(SAMPLES.length, 20);
  assert.deepEqual(SAMPLES.filter((s) => s.g5_decision === "allow").map((s) => s.name), ["allow consult", "allow post_generation"]);
  for (const s of SAMPLES) assert.deepEqual(Object.keys(s.rpc_wire).sort(), ["decision", "entitlements", "owner_epoch", "reason", "scope", "session", "subject", "v"], s.name);
  assert.match(String(ALLOW.rpc_wire.owner_epoch), /^g5oe:7:4$/);
});

Deno.test("every G5 sample through the RPC transport and the port: G5's allows are allows; every G5 refusal stays a refusal with G5's decision and reason", async () => {
  const now = 1_760_000_000_000;
  for (const s of SAMPLES) {
    const rpc = new FakeRpc();
    rpc.answers = [{ status: 200, body: s.rpc_wire }];
    const port = createG5AuthorityPort({ transport: transport(rpc, () => now), planAllowlist: PLAN, nowMs: () => now });
    const v = await port.verdict(JWT, scopeOf(s.scope));
    if (s.g5_decision === "allow") {
      assert.deepEqual([v.decision, v.expiresAtMs, v.subject], ["allow", now + G5_ALLOW_TTL_MS, { kind: "user", app: "postona", userId: USER, brand: { app: "postona", slug: BRAND } }], s.name);
    } else if (rpc.requests.length === 0) {
      // Scopes with no G6 plan are refused before G5 is asked (G5 would refuse them too).
      assert.deepEqual([v.decision, v.reason], ["deny", "FEATURE_NOT_ENABLED"], s.name);
    } else {
      assert.deepEqual([v.decision, v.reason], [s.g5_decision, s.g5_reason], s.name);
    }
  }
});

Deno.test("transport request: the proposed RPC, publishable key + the caller's JWT in headers only, body exactly {p_app, p_feature, p_brand_id}; a non-JWT credential is never sent", async () => {
  const rpc = new FakeRpc();
  rpc.answers = [{ status: 200, body: ALLOW.rpc_wire }];
  const t = transport(rpc);
  await t.fetchVerdict(JWT, scopeOf(ALLOW.scope));
  const [req] = rpc.requests;
  assert.equal(req.url, `${SUPABASE}/rest/v1/rpc/${G5_VERDICT_RPC}`);
  assert.deepEqual([req.method, req.headers.get("apikey"), req.headers.get("authorization")], ["POST", PUBLISHABLE, `Bearer ${JWT}`]);
  assert.deepEqual(req.body, { p_app: "postona", p_feature: "consult", p_brand_id: BRAND });
  assert.equal(JSON.stringify(req.body).includes(JWT) || JSON.stringify(req.body).includes(USER), false, "no token or user id in the body");
  for (const bad of [undefined, null, 42, "", "not-a-jwt", "a.b", `${JWT} extra`]) {
    await assert.rejects(t.fetchVerdict(bad, scopeOf(ALLOW.scope)), /G5_VERDICT_RPC_FAILED:network:NO_JWT/, String(bad));
  }
  assert.equal(rpc.requests.length, 1);
  for (const [url, key] of [["http://example.com", PUBLISHABLE], [SUPABASE, "short"], [SUPABASE, "has a space in it 0000"]]) {
    assert.throws(() => createG5RpcTransport({ supabaseUrl: url, publishableKey: key, fetch: rpc.fetch }));
  }
});

Deno.test("transport answers: times added by the Edge (allow 60 s, refusal expires at once); 401/403 -> deny AUTH_REQUIRED; G6-27: RPC missing (404 PGRST202) / ambiguous (300) -> deny G5_RPC_NOT_ADOPTED, any other 4xx or a redirect (never followed) -> deny G5_RPC_REFUSED; 5xx, 408, 429, network, bad JSON, a body with times or extra keys -> unavailable (throws)", async () => {
  const now = 1_760_000_000_000;
  const rpc = new FakeRpc();
  rpc.answers = [{ status: 200, body: ALLOW.rpc_wire }];
  const allow = await transport(rpc, () => now).fetchVerdict(JWT, scopeOf(ALLOW.scope)) as Record<string, number>;
  assert.deepEqual([allow.issued_at_ms, allow.expires_at_ms], [now, now + 60_000]);
  const revoked = SAMPLES.find((s) => s.name === "session revoked")!;
  rpc.answers = [{ status: 200, body: revoked.rpc_wire }];
  const refusal = await transport(rpc, () => now).fetchVerdict(JWT, scopeOf(revoked.scope)) as Record<string, number>;
  assert.deepEqual([refusal.issued_at_ms, refusal.expires_at_ms], [now, now]);
  for (const status of [401, 403]) {
    rpc.answers = [{ status, body: { code: "PGRST301" } }];
    const port = createG5AuthorityPort({ transport: transport(rpc), planAllowlist: PLAN });
    const v = await port.verdict(JWT, scopeOf(ALLOW.scope));
    assert.deepEqual([v.decision, v.reason], ["deny", "AUTH_REQUIRED"], String(status));
  }
  // G6-27: PostgREST refused the call itself; the same key cannot succeed, so the port refuses (never AUTH_UNAVAILABLE = retry).
  const refused: Array<[string, { status: number; body: unknown } | undefined, string]> = [
    ["rpc missing (the fake's default)", undefined, "G5_RPC_NOT_ADOPTED"],
    ["404 PGRST202", { status: 404, body: { code: "PGRST202", message: "Could not find the function public.common_account_authorization_verdict(p_app, p_brand_id, p_feature) in the schema cache" } }, "G5_RPC_NOT_ADOPTED"],
    ["404 without a body", { status: 404, body: "" }, "G5_RPC_NOT_ADOPTED"],
    ["404 with an allow-shaped body", { status: 404, body: ALLOW.rpc_wire }, "G5_RPC_NOT_ADOPTED"],
    ["300 PGRST203", { status: 300, body: { code: "PGRST203" } }, "G5_RPC_NOT_ADOPTED"],
    ["302 (a redirect is not followed)", { status: 302, body: ALLOW.rpc_wire }, "G5_RPC_REFUSED"],
    ["400 P0001", { status: 400, body: { code: "P0001" } }, "G5_RPC_REFUSED"],
    ["400 PGRST100", { status: 400, body: { code: "PGRST100" } }, "G5_RPC_REFUSED"],
    ["406 PGRST106", { status: 406, body: { code: "PGRST106" } }, "G5_RPC_REFUSED"],
    ["409 23505", { status: 409, body: { code: "23505" } }, "G5_RPC_REFUSED"],
  ];
  for (const [label, answer, reason] of refused) {
    const r = new FakeRpc();
    r.answers = answer === undefined ? [] : [answer];
    const wire = await transport(r, () => now).fetchVerdict(JWT, scopeOf(ALLOW.scope)) as Record<string, unknown>;
    assert.deepEqual([wire.decision, wire.reason, wire.owner_epoch, wire.expires_at_ms], ["deny", reason, null, now], label);
    const v = await createG5AuthorityPort({ transport: transport(r), planAllowlist: PLAN }).verdict(JWT, scopeOf(ALLOW.scope));
    assert.deepEqual([v.decision, v.reason], ["deny", reason], label);
    assert.deepEqual(r.redirects, ["manual", "manual"], `${label}: the JWT never follows a redirect`);
  }
  const unavailable: Array<[string, { status: number; body: unknown } | Error | undefined]> = [
    ["500", { status: 500, body: { code: "XX000" } }],
    ["502", { status: 502, body: "" }],
    ["503 PGRST001", { status: 503, body: { code: "PGRST001" } }],
    ["504 PGRST003", { status: 504, body: { code: "PGRST003" } }],
    ["408", { status: 408, body: "" }],
    ["429", { status: 429, body: "" }],
    ["500 with an allow-shaped body", { status: 500, body: ALLOW.rpc_wire }],
    ["network", new TypeError("down")],
    ["not JSON", { status: 200, body: "not json" }],
    ["with times", { status: 200, body: { ...ALLOW.rpc_wire, issued_at_ms: now, expires_at_ms: now + 600_000 } }],
    ["extra key", { status: 200, body: { ...ALLOW.rpc_wire, plan: "gold" } }],
  ];
  for (const [label, answer] of unavailable) {
    const r = new FakeRpc();
    r.answers = answer === undefined ? [] : [answer];
    await assert.rejects(transport(r).fetchVerdict(JWT, scopeOf(ALLOW.scope)), /G5_VERDICT_RPC_FAILED/, label);
  }
});

Deno.test("port alignment with G5 v1: the recheck carries the SAME JWT; an allow lives at most 60 s; owner_epoch is g5oe:<n>:<n>; an allow with a reason or a system subject is not a G5 allow; any entitlement change is a new generation", async () => {
  const rpc = new FakeRpc();
  rpc.answers = [{ status: 200, body: ALLOW.rpc_wire }];
  const live = () => Date.now();
  const port = createG5AuthorityPort({ transport: transport(rpc, live), planAllowlist: PLAN });
  const first = await port.verdict(JWT, scopeOf(ALLOW.scope));
  assert.equal(first.decision, "allow");
  const again = await port.recheck(first);
  assert.deepEqual([rpc.requests.length, rpc.requests[1].headers.get("authorization"), again.generation === first.generation], [2, `Bearer ${JWT}`, true]);
  const second = await createG5AuthorityPort({ transport: transport(rpc, live), planAllowlist: PLAN }).verdict("eyOTHER0.user.token", scopeOf(ALLOW.scope));
  assert.equal(rpc.requests[2].headers.get("authorization"), "Bearer eyOTHER0.user.token", "each verdict keeps its own caller's JWT");
  assert.equal(second.decision, "allow");
  assert.throws(() => createG5AuthorityPort({ transport: transport(rpc), planAllowlist: PLAN, maxTtlMs: 300_000 }), /MAX_TTL/);
  const direct = (wire: Record<string, unknown>, options: Record<string, unknown> = {}) => {
    const t: G5Transport = { fetchVerdict: () => Promise.resolve(wire), fetchRecheck: () => Promise.resolve(wire) };
    return createG5AuthorityPort({ transport: t, planAllowlist: PLAN, ...options }).verdict(JWT, scopeOf(ALLOW.scope));
  };
  const now = Date.now();
  const timed = { ...ALLOW.rpc_wire, issued_at_ms: now, expires_at_ms: now + 60_000 };
  for (const [label, w, reason] of [
    ["ttl 61 s", { ...timed, expires_at_ms: now + 61_000 }, "TTL_TOO_LONG"],
    ["plain epoch", { ...timed, owner_epoch: "7" }, "OWNER_EPOCH_SHAPE"],
    ["epoch zero", { ...timed, owner_epoch: "g5oe:0:4" }, "OWNER_EPOCH_SHAPE"],
    ["epoch three parts", { ...timed, owner_epoch: "g5oe:7:4:1" }, "OWNER_EPOCH_SHAPE"],
    ["allow with a reason", { ...timed, reason: "OK" }, "WIRE_REASON"],
    ["system allow on a brand", { ...timed, subject: { kind: "system" }, session: null, owner_epoch: null }, "SYSTEM_SUBJECT_NOT_FROM_G5"],
  ] as const) {
    const v = await direct(w as Record<string, unknown>);
    assert.deepEqual([v.decision, v.reason], ["unknown", reason], label);
  }
  const base = await direct(timed);
  const moreEnt = await direct({ ...timed, entitlements: ["postona:other_service", "postona:x_autopost"] });
  const otherEpoch = await direct({ ...timed, owner_epoch: "g5oe:7:5" });
  assert.equal(new Set([base.generation, moreEnt.generation, otherEpoch.generation]).size, 3, "an entitlement or lifecycle change is a new generation");
  // A system job is a separate (non-G5) authority: accepted only when explicitly configured as such.
  const sys = { ...timed, scope: { app: "kabumori", feature: "market_report", brand_slug: null }, subject: { kind: "system" }, session: null, owner_epoch: null, entitlements: [] };
  const sysScope: VerdictScope = { app: "kabumori", feature: "market_report", brand: null };
  const t: G5Transport = { fetchVerdict: () => Promise.resolve(sys), fetchRecheck: () => Promise.resolve(sys) };
  assert.equal((await createG5AuthorityPort({ transport: t, planAllowlist: PLAN }).verdict("job", sysScope)).reason, "SYSTEM_SUBJECT_NOT_FROM_G5");
  assert.equal((await createG5AuthorityPort({ transport: t, planAllowlist: PLAN, acceptSystemSubject: true }).verdict("job", sysScope)).decision, "allow");
});

// ---- POSTONA consult end to end on the proposed RPC transport (fake PostgREST for everything) ----------------------
const ANSWER = {
  kind: "chat", reply: "いいですね。", follow_up_questions: [],
  settings_delta: { preferredTone: null, themes: null, objective: null, frequencyTargetPerWeek: null, optionalNgWords: null, notes: null },
  persona_delta: { toneSignals: null, sentenceLength: null, punctuationEmoji: null, recurringVocabulary: null, topicSignals: null, hashtagHabits: null, ctaStyle: null, openingClosingPatterns: null },
  confidence: "high", uncertainty: [], history_learning_requested: false,
};
class FakeProject {
  rpc = new FakeRpc();
  gatewayRpc: string[] = [];
  reservations = new Map<string, string>();
  rows = new Map<string, { owner: string; state: string; result: unknown }>();
  private n = 0;
  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname === `/rest/v1/rpc/${G5_VERDICT_RPC}`) return await this.rpc.fetch(input, init);
    if (url.pathname.startsWith("/rest/v1/rpc/ai_")) {
      if (headers.get("apikey") !== SERVICE_KEY) return jsonResponse(401, {});
      const name = url.pathname.slice("/rest/v1/rpc/".length);
      this.gatewayRpc.push(name.replace(/^ai_(ledger|calls)_/, ""));
      const p = (JSON.parse(String(init?.body)) as { p: Record<string, unknown> }).p;
      switch (name) {
        case "ai_ledger_reserve": {
          const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
          this.reservations.set(id, "reserved");
          return jsonResponse(200, { allowed: true, reservation_id: id });
        }
        case "ai_ledger_mark_sent":
          this.reservations.set(String(p.reservation_id), "sent");
          return jsonResponse(200, { may_send: true, status: "sent" });
        case "ai_ledger_settle":
          this.reservations.set(String(p.reservation_id), "settled");
          return jsonResponse(200, { settled: true });
        case "ai_ledger_release":
          this.reservations.set(String(p.reservation_id), "released");
          return jsonResponse(200, { released: true });
        case "ai_calls_claim": {
          const row = this.rows.get(String(p.call_key));
          if (!row) {
            const owner = crypto.randomUUID();
            this.rows.set(String(p.call_key), { owner, state: "acquired", result: null });
            return jsonResponse(200, { kind: "acquired", owner });
          }
          return jsonResponse(200, row.state === "acquired" ? { kind: "busy" } : { kind: "complete", fingerprint: p.fingerprint, result: row.result });
        }
        case "ai_calls_complete": {
          const row = this.rows.get(String(p.call_key))!;
          Object.assign(row, { state: "complete", result: p.result });
          return jsonResponse(200, { state: "complete", duplicate: false });
        }
      }
      return jsonResponse(404, {});
    }
    // The handler's own reads (publishable key + the caller's JWT).
    if (headers.get("apikey") !== PUBLISHABLE || headers.get("authorization") !== `Bearer ${JWT}`) return jsonResponse(401, {});
    if (url.pathname === "/auth/v1/user") return jsonResponse(200, { id: USER });
    if (url.pathname === "/rest/v1/brand_memberships") return jsonResponse(200, [{ brand_id: BRAND, role: "owner", user_id: USER }]);
    if (url.pathname === "/rest/v1/brands") return jsonResponse(200, [{ id: BRAND, code_profile_key: "social_mobile_user_v1" }]);
    if (url.pathname === "/rest/v1/social_mobile_content_settings") return jsonResponse(200, []);
    return jsonResponse(404, {});
  };
}
function consultWorld(project: FakeProject) {
  const openai = recordingFetch(() => jsonResponse(200, openAiBody(ANSWER, { model: "gpt-6-luna" })));
  const fetch: FetchLike = (input, init) => (String(input).startsWith(SUPABASE) ? project.fetch(input, init) : openai.fetch(input, init));
  const set = buildAppPolicySet({
    "postona:consult": { enabled: true, revision: "test-consult-r1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 900, timeoutMs: 25_000, maxAttempts: 1, maxCostUsdPerOperation: 0.2, maxInputBytes: 40_000, entitlements: ["postona:x_autopost"] },
  }, { "postona:consult": POSTONA_CONSULT_CONTENT });
  const gateway = createAiGateway({
    // G6-20: this suite pins the legacy busy re-claim check; the owner-held default has its own suites.
    ledgerMode: "legacy_busy_check_unsafe",
    supabaseUrl: SUPABASE,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : undefined),
    authority: createG5AuthorityPort({ transport: createG5RpcTransport({ supabaseUrl: SUPABASE, publishableKey: PUBLISHABLE, fetch }), planAllowlist: set.planAllowlist }),
    policies: set.registry,
    fetch,
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  const deps: ConsultDependencies = { supabaseUrl: SUPABASE, publishableKey: PUBLISHABLE, openAiApiKey: "", fetchImpl: fetch as typeof globalThis.fetch, log: () => {} };
  const send = async (key: string) => {
    const text = JSON.stringify({ brand_id: BRAND, message: "今日は何を書こう", history: [] });
    const headers = { "Authorization": `Bearer ${JWT}`, "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(text).length), "Idempotency-Key": key };
    const response = await handleConsultViaGateway(new Request("https://edge.example/social-mobile-consult", { method: "POST", headers, body: text }), deps, gateway);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { openai, send };
}

Deno.test("fail closed today: the RPC is not deployed (404) -> the consult answers CONSULT_NOT_ENTITLED (G6-27: a refusal, not a same-key retry) with nothing claimed, reserved or sent", async () => {
  const project = new FakeProject();
  const w = consultWorld(project);
  const r = await w.send("consult-g5-0001");
  assert.deepEqual([r.status, r.body.error, w.openai.calls.length, project.gatewayRpc.length, project.rpc.requests.length], [403, "CONSULT_NOT_ENTITLED", 0, 0, 1]);
});

Deno.test("with G5's own allow on the RPC: the consult goes through once; verdict and recheck both carry the caller's JWT; a moved owner epoch at the recheck -> 403, reservation released, nothing sent", async () => {
  const ok = new FakeProject();
  ok.rpc.answers = [{ status: 200, body: ALLOW.rpc_wire }];
  const w = consultWorld(ok);
  const r = await w.send("consult-g5-0002");
  assert.deepEqual([r.status, r.body.success, w.openai.calls.length], [200, true, 1]);
  assert.deepEqual(ok.rpc.requests.map((q) => q.headers.get("authorization")), [`Bearer ${JWT}`, `Bearer ${JWT}`], "verdict + recheck, same JWT");
  assert.deepEqual(ok.gatewayRpc, ["claim", "reserve", "claim", "mark_sent", "settle", "complete"]);
  const moved = new FakeProject();
  moved.rpc.answers = [{ status: 200, body: ALLOW.rpc_wire }, { status: 200, body: { ...ALLOW.rpc_wire, owner_epoch: "g5oe:8:4" } }];
  const m = consultWorld(moved);
  const denied = await m.send("consult-g5-0003");
  assert.deepEqual([denied.status, denied.body.error, m.openai.calls.length, [...moved.reservations.values()]], [403, "CONSULT_NOT_ENTITLED", 0, ["released"]]);
  const revoked = new FakeProject();
  revoked.rpc.answers = [{ status: 200, body: ALLOW.rpc_wire }, { status: 200, body: SAMPLES.find((s) => s.name === "session revoked")!.rpc_wire }];
  const v = consultWorld(revoked);
  assert.deepEqual([(await v.send("consult-g5-0004")).body.error, v.openai.calls.length], ["CONSULT_NOT_ENTITLED", 0]);
});
