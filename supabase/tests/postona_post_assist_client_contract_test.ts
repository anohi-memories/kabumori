// G6-25 (2026-10-29): the screen consumer contract of POSTONA's AI post assist, executed. The REFERENCE caller G1 copies
// (postona_post_assist_client_reference.ts) -> a supabase-js FunctionsClient.invoke stand-in (JSON body, apikey, non-2xx = an
// error whose context is the Response) -> the REAL Edge entry handler (postona_post_assist_edge.ts) -> G6-21 adapter -> owner-held
// gateway (common_ai_gateway_owner_held_fake.ts, the SQL's semantics) -> fake OpenAI. G5's R1-MVP wire is faked here; the
// real R1-MVP is common_ai_gateway_post_assist_g5_48_pg_test.ts. No network, no DB, fake keys, no real AI. The app is not touched.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY supabase/tests/postona_post_assist_client_contract_test.ts
import assert from "node:assert/strict";
import { FAKE_OPENAI_KEY, jsonResponse, openAiBody } from "../functions/_shared/ai_provider/test_support.ts";
import { G5_VERDICT_RPC } from "../functions/_shared/ai_gateway/g5_rpc_transport.ts";
import { createPostonaPostAssistEdgeHandler, POST_ASSIST_EDGE_ENV } from "../functions/_shared/ai_gateway/postona_post_assist_edge.ts";
import { OwnerHeldModel } from "./common_ai_gateway_owner_held_fake.ts";
import {
  buildPostAssistBody,
  newPostAssistKey,
  POST_ASSIST_FUNCTION,
  type PostAssistFunctionsClient,
  type PostAssistInput,
  postAssistStateOf,
  requestPostAssist,
} from "./postona_post_assist_client_reference.ts";

const SUPABASE = "https://abcdefghijklmnopqrst.supabase.co";
const SERVICE_KEY = "sb_secret_" + "FAKE_G6_25_CLIENT_000";
const PUBLISHABLE = "sb_publishable_" + "FAKE_G6_25_CLIENT";
const TOKEN = "eyG6CLIENT.payloadNOTREAL.signatureNOTREAL"; // JWT-shaped, not a token
const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "u_ae343f5caedb67d4af33fc7a";
const FEATURE = {
  enabled: true, revision: "client-test-1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 800, timeoutMs: 20_000,
  maxAttempts: 1, maxCostUsdPerOperation: 0.1, maxInputBytes: 8_000, entitlements: ["postona:x_autopost"],
};
const ENV: Record<string, string> = {
  [POST_ASSIST_EDGE_ENV.supabaseUrl]: SUPABASE,
  [POST_ASSIST_EDGE_ENV.publishableKey]: PUBLISHABLE,
  [POST_ASSIST_EDGE_ENV.serviceKey]: SERVICE_KEY,
  [POST_ASSIST_EDGE_ENV.feature]: JSON.stringify(FEATURE),
  [POST_ASSIST_EDGE_ENV.allowedOrigins]: "",
  OPENAI_API_KEY: FAKE_OPENAI_KEY,
};
const allow = () => ({
  v: 1, decision: "allow", reason: null, scope: { app: "postona", feature: "post_generation", brand_slug: WORKSPACE },
  subject: { kind: "user", user_id: USER }, session: { state: "active", ref: "s:ae902d0683d3d9c2b8d02af5d2175195" },
  owner_epoch: "g5pv:7", entitlements: ["postona:x_autopost"],
});
const deny = (reason: string) => ({ ...allow(), decision: "deny", reason, owner_epoch: null, entitlements: [], session: null, subject: { kind: "system" } });

function world() {
  const model = new OwnerHeldModel();
  const g5: Array<Record<string, unknown> | Error> = [];
  const replies: unknown[] = [];
  const sent = { g5: 0, provider: 0 };
  const invoked: Array<{ name: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `${SUPABASE}/rest/v1/rpc/${G5_VERDICT_RPC}`) {
      sent.g5++;
      const a = g5.shift() ?? allow();
      if (a instanceof Error) throw a;
      return jsonResponse(200, a);
    }
    if (url.startsWith(SUPABASE)) return await model.fetchFor("app")(input, init);
    sent.provider++;
    return jsonResponse(200, openAiBody(replies.shift() ?? { candidates: [{ text: "週末限定のいちごタルトです。", hashtags: ["#いちごタルト"] }] }, { model: "gpt-6-luna" }));
  };
  const handler = createPostonaPostAssistEdgeHandler({
    readEnv: (name) => ENV[name],
    fetch,
    g5TimeoutMs: 200,
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  // supabase-js FunctionsClient.invoke as the app uses it: a JSON body, the client's apikey + JSON content type (+ the length the
  // network adds), then 2xx -> data, otherwise an error whose context is the Response.
  const client: PostAssistFunctionsClient = {
    functions: {
      invoke: async (name, options) => {
        invoked.push({ name, body: options.body, headers: options.headers });
        const text = JSON.stringify(options.body);
        const res = await handler(new Request(`${SUPABASE}/functions/v1/${name}`, {
          method: "POST",
          body: text,
          headers: { apikey: PUBLISHABLE, "x-client-info": "supabase-js/2", "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(text).length), ...options.headers },
        }));
        if (res.ok) return { data: await res.json(), error: null };
        return { data: null, error: Object.assign(new Error("Edge Function returned a non-2xx status code"), { name: "FunctionsHttpError", context: res }) };
      },
    },
  };
  return { model, g5, replies, sent, invoked, client };
}

const X_DRAFT: PostAssistInput = { brandId: WORKSPACE, mode: "draft", platform: "x", notes: "いちごタルト 週末限定" };

Deno.test("the reference caller over the real Edge entry: X draft -> refine -> hashtags and Threads draft show editable candidates to be confirmed; exactly the mode's fields, the person's token and one key per press; nothing is posted", async () => {
  const w = world();
  w.replies.push(
    { candidates: [{ text: "週末限定のいちごタルトを始めました。", hashtags: ["#いちごタルト"] }] },
    { candidates: [{ text: "週末限定、いちごタルトあります。", hashtags: [] }] },
    { candidates: [{ text: "週末限定、いちごタルトあります。", hashtags: ["#週末限定"] }] },
    { candidates: [{ text: "今日のおすすめはチーズケーキです。", hashtags: ["#チーズケーキ"] }] },
  );
  const steps: PostAssistInput[] = [
    X_DRAFT,
    { brandId: WORKSPACE, mode: "refine", platform: "x", draft: "週末限定のいちごタルトを始めました。", instruction: "短く" },
    { brandId: WORKSPACE, mode: "hashtags", platform: "x", draft: "週末限定、いちごタルトあります。" },
    { brandId: WORKSPACE, mode: "draft", platform: "threads", notes: "チーズケーキ" },
  ];
  let n = 0;
  for (const input of steps) {
    const key = newPostAssistKey(() => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`);
    const s = await requestPostAssist(w.client, TOKEN, key, input);
    assert.equal(s.kind, "candidates", `${input.mode}/${input.platform}: ${JSON.stringify(s)}`);
    if (s.kind !== "candidates") continue;
    assert.ok(s.candidates.every((c) => c.platform === input.platform && c.editable && c.requiresUserConfirmation && c.length <= c.limit));
    assert.equal(typeof s.notice, "string");
  }
  assert.deepEqual(w.invoked.map((i) => [i.name, Object.keys(i.body).sort().join(","), Object.keys(i.headers).sort().join(",")]), [
    [POST_ASSIST_FUNCTION, "brand_id,mode,notes,platform", "Authorization,Idempotency-Key"],
    [POST_ASSIST_FUNCTION, "brand_id,draft,instruction,mode,platform", "Authorization,Idempotency-Key"],
    [POST_ASSIST_FUNCTION, "brand_id,draft,mode,platform", "Authorization,Idempotency-Key"],
    [POST_ASSIST_FUNCTION, "brand_id,mode,notes,platform", "Authorization,Idempotency-Key"],
  ]);
  assert.ok(w.invoked.every((i) => i.headers.Authorization === `Bearer ${TOKEN}`));
  assert.equal(new Set(w.invoked.map((i) => i.headers["Idempotency-Key"])).size, 4, "one key per press");
  assert.deepEqual([w.sent.provider, w.model.statuses()], [4, ["settled", "settled", "settled", "settled"]]);
});

Deno.test("the reference caller's states from the real entry: same key + same input = the stored candidates (no new send); same key + other input = new_key_needed; G5 deny = not_available; G5 unreachable = retry_same_key (nothing sent); no or non-JWT token = relogin; a bad key = invalid_input without a request; an unusable answer = new_key_needed", async () => {
  const w = world();
  const key = "pa-client-0001";
  const first = await requestPostAssist(w.client, TOKEN, key, X_DRAFT);
  const again = await requestPostAssist(w.client, TOKEN, key, X_DRAFT);
  assert.deepEqual([first.kind, again.kind, w.sent.provider], ["candidates", "candidates", 1]);
  assert.deepEqual(again, first, "the stored answer");
  assert.deepEqual(await requestPostAssist(w.client, TOKEN, key, { ...X_DRAFT, notes: "別の内容" }), { kind: "new_key_needed", code: "POST_ASSIST_OPERATION_REUSED" });
  w.g5.push(deny("SERVICE_SUSPENDED"));
  assert.deepEqual(await requestPostAssist(w.client, TOKEN, "pa-client-0002", X_DRAFT), { kind: "not_available" });
  w.g5.push(new TypeError("unreachable"));
  assert.deepEqual(await requestPostAssist(w.client, TOKEN, "pa-client-0003", X_DRAFT), { kind: "retry_same_key" });
  assert.deepEqual(await requestPostAssist(w.client, "", "pa-client-0004", X_DRAFT), { kind: "relogin" });
  assert.deepEqual(await requestPostAssist(w.client, SERVICE_KEY, "pa-client-0005", X_DRAFT), { kind: "relogin" }, "an sb_secret_ key is not the person's token");
  const before = w.invoked.length;
  assert.deepEqual(await requestPostAssist(w.client, TOKEN, "short", X_DRAFT), { kind: "invalid_input" });
  assert.equal(w.invoked.length, before, "no request with a bad key");
  w.replies.push({ candidates: [{ text: "あ".repeat(200), hashtags: [] }] }); // over X's weighted 280: no usable candidate
  assert.deepEqual(await requestPostAssist(w.client, TOKEN, "pa-client-0006", X_DRAFT), { kind: "new_key_needed", code: "POST_ASSIST_AI_UNUSABLE" });
  assert.equal(w.sent.provider, 2, "one send for the first key, one for the unusable answer; none for the refusals");
});

Deno.test("the screen mapping covers every documented answer, and anything off-contract is unavailable (never shown as a candidate)", () => {
  const e = (error: string, retry = false) => ({ error, retry_same_key: retry });
  const table: Array<[number, unknown, string]> = [
    [400, e("POST_ASSIST_REQUEST_INVALID"), "invalid_input"],
    [400, e("POST_ASSIST_IDEMPOTENCY_KEY_REQUIRED"), "invalid_input"],
    [401, e("POST_ASSIST_AUTH_REQUIRED"), "relogin"],
    // G6-26: Supabase's gateway (verify_jwt) answers a broken / expired / missing token itself, with its own body (seen on the local runtime)
    [401, { code: "UNAUTHORIZED_INVALID_JWT_FORMAT", message: "Invalid JWT format", msg: "Invalid JWT format" }, "relogin"],
    [401, null, "relogin"],
    [403, e("POST_ASSIST_NOT_ENTITLED"), "not_available"],
    [403, e("POST_ASSIST_ORIGIN_REFUSED"), "unavailable"],
    [405, e("POST_ASSIST_REQUEST_INVALID"), "invalid_input"],
    [415, e("POST_ASSIST_REQUEST_INVALID"), "invalid_input"],
    [409, e("POST_ASSIST_IN_PROGRESS", true), "retry_same_key"],
    [409, e("POST_ASSIST_OPERATION_REUSED"), "new_key_needed"],
    [429, e("POST_ASSIST_QUOTA_EXCEEDED"), "quota"],
    [502, e("POST_ASSIST_AI_UNKNOWN"), "new_key_needed"],
    [502, e("POST_ASSIST_AI_FAILED"), "new_key_needed"],
    [502, e("POST_ASSIST_AI_UNUSABLE"), "new_key_needed"],
    [503, e("POST_ASSIST_AUTH_UNAVAILABLE", true), "retry_same_key"],
    [503, e("POST_ASSIST_UNAVAILABLE", true), "retry_same_key"],
    [503, e("POST_ASSIST_UNAVAILABLE"), "unavailable"],
    [503, e("POST_ASSIST_NOT_SENT"), "unavailable"],
    // off-contract
    [409, e("POST_ASSIST_IN_PROGRESS"), "unavailable"],
    [403, { error: "POST_ASSIST_NOT_ENTITLED" }, "unavailable"],
    [500, e("POST_ASSIST_AI_FAILED"), "unavailable"],
    [502, "Bad Gateway", "unavailable"],
  ];
  for (const [status, body, kind] of table) assert.equal(postAssistStateOf(status, body, "x").kind, kind, `${status} ${JSON.stringify(body)}`);
  const good = { platform: "x", text: "本文", hashtags: [], length: 4, limit: 280, editable: true, requiresUserConfirmation: true };
  assert.equal(postAssistStateOf(200, { candidates: [good], notice: "n" }, "x").kind, "candidates");
  for (const [label, body] of [
    ["editable false", { candidates: [{ ...good, editable: false }], notice: "n" }],
    ["confirmation false", { candidates: [{ ...good, requiresUserConfirmation: false }], notice: "n" }],
    ["another platform", { candidates: [{ ...good, platform: "threads" }], notice: "n" }],
    ["an extra key", { candidates: [{ ...good, autoPost: true }], notice: "n" }],
    ["over the limit", { candidates: [{ ...good, length: 281 }], notice: "n" }],
    ["no candidates", { candidates: [], notice: "n" }],
    ["no notice", { candidates: [good] }],
    ["an extra top-level key", { candidates: [good], notice: "n", posted: true }],
  ] as Array<[string, unknown]>) {
    assert.equal(postAssistStateOf(200, body, "x").kind, "unavailable", label);
  }
  assert.deepEqual(buildPostAssistBody({ brandId: WORKSPACE, mode: "hashtags", platform: "threads", draft: "d" }), { brand_id: WORKSPACE, mode: "hashtags", platform: "threads", draft: "d" });
  assert.throws(() => newPostAssistKey(() => "x"), /POST_ASSIST_KEY_INVALID/u);
});
