// G6-23 (2026-10-29): HTTP fake E2E of POSTONA's AI post assist Edge entry (supabase/ai_gateway/postona_post_assist_edge.ts):
// Request -> origin / method / content type / Bearer checks -> configuration from the Edge environment -> G6-21 personal
// MVP adapter (G5-47 R1 wire, fake) -> owner-held gateway (common_ai_gateway_owner_held_fake.ts, the SQL's semantics) ->
// fake OpenAI. The Supabase URL is production-SHAPED (https, sb_secret_-shaped key) and fake: nothing leaves the
// process. No network, no DB, fake keys, no real AI.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY supabase/tests/common_ai_gateway_post_assist_edge_test.ts
import assert from "node:assert/strict";
import { FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import { G5_VERDICT_RPC } from "../ai_gateway/g5_rpc_transport.ts";
import { createPostonaPostAssistEdgeHandler, parseAllowedOrigins, parseFeatureConfig, POST_ASSIST_EDGE_ENV } from "../ai_gateway/postona_post_assist_edge.ts";
import { OwnerHeldModel } from "./common_ai_gateway_owner_held_fake.ts";

const SUPABASE = "https://abcdefghijklmnopqrst.supabase.co";
const SERVICE_KEY = "sb_secret_" + "FAKE_G6_23_0000000000";
const PUBLISHABLE = "local-g6-23-publishable-NOT-A-SECRET";
const WEB = "https://app.postona.example";
const JWT = "eyG6E.payloadNOTREAL.signatureNOTREAL"; // JWT-shaped, not a token
const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "u_ae343f5caedb67d4af33fc7a";
const FEATURE = {
  enabled: true, revision: "edge-test-1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 800, timeoutMs: 20_000,
  maxAttempts: 1, maxCostUsdPerOperation: 0.1, maxInputBytes: 8_000, entitlements: ["postona:x_autopost"],
};
const ENV: Record<string, string> = {
  [POST_ASSIST_EDGE_ENV.supabaseUrl]: SUPABASE,
  [POST_ASSIST_EDGE_ENV.publishableKey]: PUBLISHABLE,
  [POST_ASSIST_EDGE_ENV.serviceKey]: SERVICE_KEY,
  [POST_ASSIST_EDGE_ENV.feature]: JSON.stringify(FEATURE),
  [POST_ASSIST_EDGE_ENV.allowedOrigins]: WEB,
  OPENAI_API_KEY: FAKE_OPENAI_KEY,
  ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
};

/** G5-47's R1-MVP wire, allow by default. */
const mvp = (over: Record<string, unknown> = {}) => ({
  v: 1, decision: "allow", reason: null, scope: { app: "postona", feature: "post_generation", brand_slug: WORKSPACE },
  subject: { kind: "user", user_id: USER }, session: { state: "active", ref: "s:ae902d0683d3d9c2b8d02af5d2175195" },
  owner_epoch: "g5pv:7", entitlements: ["postona:x_autopost"], ...over,
});
const deny = (reason: string, decision = "deny") => mvp({ decision, reason, owner_epoch: null, entitlements: [], session: null, subject: { kind: "system" } });

type G5Answer = Record<string, unknown> | Response | Error;
function world(env: Record<string, string | undefined> = ENV) {
  const model = new OwnerHeldModel();
  const g5 = { calls: 0, jwts: [] as string[], script: [] as Array<G5Answer | undefined> };
  const replies: unknown[] = [];
  const envReads: string[] = [];
  const provider = recordingFetch(() => {
    const next = replies.shift();
    return next instanceof Response ? next : jsonResponse(200, openAiBody(next ?? { candidates: [{ text: "候補", hashtags: [] }] }, { model: "gpt-6-luna" }));
  });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `${SUPABASE}/rest/v1/rpc/${G5_VERDICT_RPC}`) {
      g5.jwts.push(String(new Headers(init?.headers).get("Authorization")));
      const a = g5.script[g5.calls++] ?? mvp();
      if (a instanceof Error) throw a;
      return a instanceof Response ? a : jsonResponse(200, a);
    }
    if (url.startsWith(SUPABASE)) return await model.fetchFor("app")(input, init);
    return await provider.fetch(input, init);
  };
  const handler = createPostonaPostAssistEdgeHandler({
    readEnv: (name) => (envReads.push(name), env[name]),
    fetch,
    g5TimeoutMs: 200,
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  const bodies: string[] = [];
  const send = async (init: { method?: string; body?: Record<string, unknown> | string | null; headers?: Record<string, string> } = {}) => {
    const text = init.body === null ? null : typeof init.body === "string" ? init.body : JSON.stringify({ brand_id: WORKSPACE, mode: "draft", platform: "x", notes: "x", ...(init.body ?? {}) });
    const headers: Record<string, string> = {
      "Content-Type": "application/json", Authorization: `Bearer ${JWT}`, "Idempotency-Key": "edge-assist-0001",
      ...(text === null ? {} : { "Content-Length": String(new TextEncoder().encode(text).length) }),
      ...(init.headers ?? {}),
    };
    for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];
    const res = await handler(new Request("https://edge.example/functions/v1/postona-post-assist", { method: init.method ?? "POST", body: text, headers }));
    const raw = res.status === 204 ? "" : await res.text();
    bodies.push(raw);
    return { status: res.status, headers: res.headers, body: (raw ? JSON.parse(raw) : null) as Record<string, unknown> | null };
  };
  const nothing = () => [g5.calls, model.log.length, provider.calls.length];
  return { model, g5, replies, provider, send, nothing, bodies, envReads };
}
const cands = (r: { body: Record<string, unknown> | null }) =>
  r.body!.candidates as Array<{ text: string; hashtags: string[]; editable: boolean; requiresUserConfirmation: boolean }>;

Deno.test("the person's flow over HTTP (X draft -> refine -> hashtags for the edited text; Threads draft): 200, editable candidates to be confirmed, the notice, no-store; G5 asked twice per step with the person's token; one send per step; the owner-held RPCs only (legacy unreachable)", async () => {
  const w = world();
  w.replies.push(
    { candidates: [{ text: "週末限定のいちごタルトを始めました。", hashtags: ["#いちごタルト"] }, { text: "いちごの季節です。", hashtags: [] }] },
    { candidates: [{ text: "週末限定、いちごタルトあります。", hashtags: [] }] },
    { candidates: [{ text: "週末限定のいちごタルト、どうぞ。", hashtags: ["#週末限定"] }] },
    { candidates: [{ text: "今日のおすすめはチーズケーキです。", hashtags: ["#チーズケーキ"] }] },
  );
  const steps = [
    [{ mode: "draft", platform: "x", notes: "いちごタルト 週末限定" }, "edge-x-draft-0001"],
    [{ mode: "refine", platform: "x", notes: undefined, draft: "週末限定のいちごタルトを始めました。", instruction: "短く" }, "edge-x-refine-0001"],
    [{ mode: "hashtags", platform: "x", notes: undefined, draft: "週末限定のいちごタルト、どうぞ。" }, "edge-x-tags-0001"],
    [{ mode: "draft", platform: "threads", notes: "チーズケーキ" }, "edge-th-draft-0001"],
  ] as const;
  for (const [body, key] of steps) {
    const r = await w.send({ body: { ...body }, headers: { "Idempotency-Key": key, Origin: WEB } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(cands(r).length > 0 && cands(r).every((c) => c.editable === true && c.requiresUserConfirmation === true), key);
    assert.equal(typeof r.body!.notice, "string");
    assert.deepEqual([r.headers.get("Cache-Control"), r.headers.get("X-Content-Type-Options"), r.headers.get("Access-Control-Allow-Origin")], ["no-store", "nosniff", WEB]);
  }
  assert.deepEqual([w.provider.calls.length, w.model.statuses()], [4, ["settled", "settled", "settled", "settled"]]);
  assert.equal(w.g5.calls, 8, "a verdict and a recheck per step");
  assert.ok(w.g5.jwts.every((h) => h === `Bearer ${JWT}`));
  const rpcs = new Set(w.model.calls());
  assert.ok(rpcs.has("ai_calls_reserve_held") && rpcs.has("ai_calls_mark_sent_held"), [...rpcs].join(","));
  assert.ok(!rpcs.has("ai_ledger_reserve") && !rpcs.has("ai_ledger_mark_sent"), "the legacy ledger path is never used");
  assert.ok(w.provider.calls.every((c) => c.url.includes("openai")), "OpenAI only");
});

Deno.test("refused before anything is asked (no G5 call, no ledger, no send): no / non-Bearer token, wrong method, wrong content type, a browser origin not on the list, a bad body, no Idempotency-Key; OPTIONS answers CORS for a listed origin only", async () => {
  const cases: Array<[string, Parameters<ReturnType<typeof world>["send"]>[0], number, string | null]> = [
    ["no Authorization", { headers: { Authorization: "" } }, 401, "POST_ASSIST_AUTH_REQUIRED"],
    ["Basic auth", { headers: { Authorization: "Basic dXNlcjpwYXNz" } }, 401, "POST_ASSIST_AUTH_REQUIRED"],
    ["Bearer without a token", { headers: { Authorization: "Bearer " } }, 401, "POST_ASSIST_AUTH_REQUIRED"],
    ["GET", { method: "GET", body: null }, 405, "POST_ASSIST_REQUEST_INVALID"],
    ["PUT", { method: "PUT" }, 405, "POST_ASSIST_REQUEST_INVALID"],
    ["text/plain", { headers: { "Content-Type": "text/plain" } }, 415, "POST_ASSIST_REQUEST_INVALID"],
    ["form", { headers: { "Content-Type": "application/x-www-form-urlencoded" } }, 415, "POST_ASSIST_REQUEST_INVALID"],
    ["origin not listed", { headers: { Origin: "https://evil.example" } }, 403, "POST_ASSIST_ORIGIN_REFUSED"],
    ["origin look-alike", { headers: { Origin: `${WEB}.evil.example` } }, 403, "POST_ASSIST_ORIGIN_REFUSED"],
    ["origin null", { headers: { Origin: "null" } }, 403, "POST_ASSIST_ORIGIN_REFUSED"],
    ["unknown platform", { body: { platform: "instagram" } }, 400, "POST_ASSIST_REQUEST_INVALID"],
    ["refine without instruction", { body: { mode: "refine", draft: "y", notes: undefined } }, 400, "POST_ASSIST_REQUEST_INVALID"],
    ["extra key (user_id)", { body: { user_id: USER } }, 400, "POST_ASSIST_REQUEST_INVALID"],
    ["not JSON", { body: "{not json" }, 400, "POST_ASSIST_REQUEST_INVALID"],
    ["too large", { body: { notes: "あ".repeat(20_000) } }, 400, "POST_ASSIST_REQUEST_INVALID"],
    ["no Idempotency-Key", { headers: { "Idempotency-Key": "" } }, 400, "POST_ASSIST_IDEMPOTENCY_KEY_REQUIRED"],
    ["OPTIONS from a listed origin", { method: "OPTIONS", body: null, headers: { Origin: WEB } }, 204, null],
    ["OPTIONS from another origin", { method: "OPTIONS", body: null, headers: { Origin: "https://evil.example" } }, 403, "POST_ASSIST_ORIGIN_REFUSED"],
  ];
  for (const [label, init, status, error] of cases) {
    const w = world();
    const r = await w.send(init);
    assert.deepEqual([r.status, r.body?.error ?? null, ...w.nothing()], [status, error, 0, 0, 0], label);
    if (status !== 204 && r.body) assert.equal(r.body.retry_same_key, false, label);
    const allowOrigin = r.headers.get("Access-Control-Allow-Origin");
    assert.equal(allowOrigin, label.includes("listed origin") ? WEB : null, `${label}: CORS only for a listed origin`);
    if (status === 401) assert.equal(r.headers.get("WWW-Authenticate"), "Bearer");
    if (status === 405) assert.equal(r.headers.get("Allow"), "POST, OPTIONS");
  }
  const pre = await world().send({ method: "OPTIONS", body: null, headers: { Origin: WEB } });
  assert.match(pre.headers.get("Access-Control-Allow-Headers") ?? "", /authorization.*content-type.*idempotency-key/u);
});

Deno.test("configuration from the Edge environment: anything missing or invalid answers 503 POST_ASSIST_UNAVAILABLE with no detail and nothing asked; a production-shaped URL needs an sb_secret_ key; the feature must be OpenAI-only, enabled and opened by postona:x_autopost alone; origins must be exact", async () => {
  const feature = (over: Record<string, unknown>) => JSON.stringify({ ...FEATURE, ...over });
  const cases: Array<[string, Record<string, string | undefined>]> = [
    ["no feature", { [POST_ASSIST_EDGE_ENV.feature]: undefined }],
    ["feature not JSON", { [POST_ASSIST_EDGE_ENV.feature]: "{model:" }],
    ["feature extra key", { [POST_ASSIST_EDGE_ENV.feature]: feature({ fallback: "anthropic" }) }],
    ["feature missing key", { [POST_ASSIST_EDGE_ENV.feature]: JSON.stringify({ ...FEATURE, maxCostUsdPerOperation: undefined }) }],
    ["feature wrong type", { [POST_ASSIST_EDGE_ENV.feature]: feature({ maxOutputTokens: "800" }) }],
    ["feature disabled", { [POST_ASSIST_EDGE_ENV.feature]: feature({ enabled: false }) }],
    ["Anthropic (personal data: OpenAI only)", { [POST_ASSIST_EDGE_ENV.feature]: feature({ provider: "anthropic", model: "claude-haiku-5-5" }) }],
    ["another entitlement", { [POST_ASSIST_EDGE_ENV.feature]: feature({ entitlements: ["postona:threads_autopost"] }) }],
    ["no entitlement", { [POST_ASSIST_EDGE_ENV.feature]: feature({ entitlements: [] }) }],
    ["no Supabase URL", { [POST_ASSIST_EDGE_ENV.supabaseUrl]: undefined }],
    ["plain-http non-local URL", { [POST_ASSIST_EDGE_ENV.supabaseUrl]: "http://abcdefghijklmnopqrst.supabase.co" }],
    ["no publishable key", { [POST_ASSIST_EDGE_ENV.publishableKey]: undefined }],
    ["no service key", { [POST_ASSIST_EDGE_ENV.serviceKey]: undefined }],
    ["legacy JWT service key", { [POST_ASSIST_EDGE_ENV.serviceKey]: ["e", "yJhbGciOiJIUzI1NiJ9", ".", "e", "yJyb2xlIjoic2VydmljZV9yb2xlIn0", ".c2ln"].join("") }],
    ["non-secret key on a production-shaped URL", { [POST_ASSIST_EDGE_ENV.serviceKey]: "plain-not-a-secret-key-000000" }],
    ["origin wildcard", { [POST_ASSIST_EDGE_ENV.allowedOrigins]: "*" }],
    ["origin with a path", { [POST_ASSIST_EDGE_ENV.allowedOrigins]: `${WEB}/app` }],
    ["plain-http non-local origin", { [POST_ASSIST_EDGE_ENV.allowedOrigins]: "http://app.postona.example" }],
  ];
  for (const [label, over] of cases) {
    const w = world({ ...ENV, ...over });
    const r = await w.send();
    assert.deepEqual([r.status, r.body, ...w.nothing()], [503, { error: "POST_ASSIST_UNAVAILABLE", retry_same_key: false }, 0, 0, 0], label);
  }
  // No origin list at all: the native app (no Origin header) works; every browser origin is refused.
  const native = world({ ...ENV, [POST_ASSIST_EDGE_ENV.allowedOrigins]: undefined });
  assert.equal((await native.send()).status, 200);
  assert.equal((await native.send({ headers: { Origin: WEB, "Idempotency-Key": "edge-assist-0002" } })).status, 403);
  // Parsers: exact shapes only.
  assert.deepEqual(parseAllowedOrigins(" https://a.example , http://localhost:8081 "), ["https://a.example", "http://localhost:8081"]);
  assert.equal(parseAllowedOrigins("https://a.example/"), null);
  assert.equal(parseAllowedOrigins("https://user@a.example"), null);
  assert.equal(parseFeatureConfig(JSON.stringify([FEATURE])), null);
  assert.equal(parseFeatureConfig(JSON.stringify({ ...FEATURE, fallback: "anthropic" })), null, "exactly FeatureConfig's keys");
  assert.equal(parseFeatureConfig(JSON.stringify({ ...FEATURE, enabled: "true" })), null);
  assert.deepEqual(parseFeatureConfig(JSON.stringify(FEATURE)), FEATURE);
  // The configuration is read once it is valid; secrets never appear in any answer.
  const w = world();
  await w.send();
  await w.send({ headers: { "Idempotency-Key": "edge-assist-0003" } });
  assert.equal(w.envReads.filter((n) => n === POST_ASSIST_EDGE_ENV.serviceKey).length, 1, "built once");
  for (const body of w.bodies) for (const secret of [SERVICE_KEY, PUBLISHABLE, FAKE_OPENAI_KEY, FAKE_ANTHROPIC_KEY, JWT]) assert.ok(!body.includes(secret), body);
  assert.throws(() => createPostonaPostAssistEdgeHandler({} as never), /POST_ASSIST_EDGE_CONFIG_INVALID:read_env/u);
});

Deno.test("G5 / session / generation / entitlement over HTTP are fail-closed: anonymous, expired or revoked session, another workspace, a second member, suspended, the R1-MVP ACL not granted (403, BLOCKED_G5_AUTH_EXECUTE), not applied (404), G5 down; a changed generation between the verdict and the recheck releases the hold; none sends or charges", async () => {
  const cases: Array<[string, G5Answer[], number, string, string[]]> = [
    ["anonymous", [deny("AUTH_REQUIRED")], 403, "POST_ASSIST_NOT_ENTITLED", []],
    ["session expired", [deny("SESSION_EXPIRED")], 403, "POST_ASSIST_NOT_ENTITLED", []],
    ["session revoked", [deny("SESSION_REVOKED")], 403, "POST_ASSIST_NOT_ENTITLED", []],
    ["another workspace (deny)", [deny("BRAND_ACCESS_DENIED")], 403, "POST_ASSIST_NOT_ENTITLED", []],
    ["an allow for another workspace", [mvp({ scope: { app: "postona", feature: "post_generation", brand_slug: "u_0b1c2d3e4f5061728394a5b6" } })], 403, "POST_ASSIST_NOT_ENTITLED", []],
    ["a second member", [deny("OWN_WORKSPACE_CONFLICT")], 403, "POST_ASSIST_NOT_ENTITLED", []],
    ["suspended", [deny("SERVICE_SUSPENDED")], 403, "POST_ASSIST_NOT_ENTITLED", []],
    ["no entitlement", [mvp({ entitlements: [] })], 403, "POST_ASSIST_NOT_ENTITLED", []],
    ["full-profile token (pinned)", [mvp({ owner_epoch: "g5oe:7:4" })], 403, "POST_ASSIST_NOT_ENTITLED", []],
    ["R1-MVP ACL not granted (403)", [jsonResponse(403, { code: "42501" })], 403, "POST_ASSIST_NOT_ENTITLED", []],
    ["JWT refused (401)", [jsonResponse(401, { code: "PGRST301" })], 403, "POST_ASSIST_NOT_ENTITLED", []],
    ["R1-MVP not applied (404)", [jsonResponse(404, { code: "PGRST202" })], 503, "POST_ASSIST_AUTH_UNAVAILABLE", []],
    ["G5 down", [new TypeError("down")], 503, "POST_ASSIST_AUTH_UNAVAILABLE", []],
    ["generation +1 at the recheck", [mvp(), mvp({ owner_epoch: "g5pv:8" })], 403, "POST_ASSIST_NOT_ENTITLED", ["released"]],
    ["session ended at the recheck", [mvp(), deny("SESSION_EXPIRED")], 403, "POST_ASSIST_NOT_ENTITLED", ["released"]],
  ];
  for (const [label, script, status, error, statuses] of cases) {
    const w = world();
    w.g5.script = script;
    const r = await w.send();
    assert.deepEqual([r.status, r.body?.error, w.provider.calls.length, w.model.statuses()], [status, error, 0, statuses], label);
  }
});

Deno.test("the same request is charged once: a replay with the same Idempotency-Key answers the stored result (one send); a concurrent duplicate is IN_PROGRESS (retry_same_key) or the replay, never a second send; OpenAI 429 is stored for that key and never resent; a new key is a new request", async () => {
  const w = world();
  w.replies.push({ candidates: [{ text: "一回目", hashtags: [] }] }, { candidates: [{ text: "二回目", hashtags: [] }] });
  const a = await w.send({ headers: { "Idempotency-Key": "edge-once-0001" } });
  const b = await w.send({ headers: { "Idempotency-Key": "edge-once-0001" } });
  assert.deepEqual([a.status, b.status, cands(b)[0].text, w.provider.calls.length], [200, 200, "一回目", 1]);
  const c = await w.send({ headers: { "Idempotency-Key": "edge-once-0002" } });
  assert.deepEqual([c.status, cands(c)[0].text, w.provider.calls.length], [200, "二回目", 2]);

  const race = world();
  const [r1, r2] = await Promise.all([race.send({ headers: { "Idempotency-Key": "edge-race-0001" } }), race.send({ headers: { "Idempotency-Key": "edge-race-0001" } })]);
  const outcomes = [r1, r2].map((r) => r.status === 200 ? "OK" : `${r.body?.error}:${r.body?.retry_same_key}`).sort();
  assert.ok(JSON.stringify(outcomes) === JSON.stringify(["OK", "OK"]) || JSON.stringify(outcomes) === JSON.stringify(["OK", "POST_ASSIST_IN_PROGRESS:true"]), outcomes.join(","));
  assert.equal(race.provider.calls.length, 1, "one send");

  const limited = world();
  limited.replies.push(jsonResponse(429, { error: { type: "rate_limit_exceeded", message: "slow down" } }, { "retry-after": "1" }));
  const x = await limited.send({ headers: { "Idempotency-Key": "edge-429-0001" } });
  const y = await limited.send({ headers: { "Idempotency-Key": "edge-429-0001" } });
  assert.deepEqual([x.status, y.status, y.body?.error, x.body?.retry_same_key, limited.provider.calls.length], [502, 502, x.body?.error, false, 1]);
  assert.equal(limited.model.statuses().length, 1);
});
