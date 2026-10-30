// G6-21 (2026-10-28): POSTONA post assist on G5-47's R1-MVP verdict (personal profile, g5pv token), end to end OFFLINE
// through the REAL G6 code: createPostonaPostAssistMvp -> the real G5 RPC transport pinned to the personal profile -> the
// unchanged strict port -> createAiGateway (owner-held ledger) -> the OpenAI adapter. Outside: a PostgREST stand-in for
// the R1-MVP RPC answering G5-47's documented wire (allow owner_epoch = g5pv:<n>, entitlements ["postona:x_autopost"]),
// the call store / ledger model (common_ai_gateway_owner_held_fake.ts) and OpenAI (scripted). No network, fake keys,
// nothing posted. The R1-MVP ACL for `authenticated` is undecided: 401 / 403 / 404 are tested as what a real call
// answers today (BLOCKED_G5_AUTH_EXECUTE), never as a connection.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY --allow-read=supabase/tests/fixtures \
//     supabase/tests/common_ai_gateway_post_assist_mvp_test.ts
import assert from "node:assert/strict";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import type { FeatureConfig } from "../functions/_shared/ai_gateway/app_policies.ts";
import { G5_VERDICT_RPC } from "../functions/_shared/ai_gateway/g5_rpc_transport.ts";
import {
  createPostonaPostAssistMvp,
  G5_R1_PERSONAL_MVP_PROFILE,
  pinPersonalMvpWire,
  PostonaPostAssistMvpConfigError,
} from "../functions/_shared/ai_gateway/postona_post_assist_mvp.ts";
import { OwnerHeldModel } from "./common_ai_gateway_owner_held_fake.ts";

const SUPABASE = "http://127.0.0.1:54321";
const JWT = "eyG6M.payloadNOTREAL.signatureNOTREAL"; // JWT-shaped, not a token
const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "u_ae343f5caedb67d4af33fc7a"; // the person's own workspace id (G5 derives it from the person)
const FEATURE: FeatureConfig = {
  enabled: true, revision: "mvp-test-1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 800, timeoutMs: 20_000,
  maxAttempts: 1, maxCostUsdPerOperation: 0.1, maxInputBytes: 8_000, entitlements: ["postona:x_autopost"],
};

/** G5-47's R1-MVP wire (8 keys, no times), allow by default. */
const mvp = (over: Record<string, unknown> = {}) => ({
  v: 1, decision: "allow", reason: null, scope: { app: "postona", feature: "post_generation", brand_slug: WORKSPACE },
  subject: { kind: "user", user_id: USER }, session: { state: "active", ref: "s:ae902d0683d3d9c2b8d02af5d2175195" },
  owner_epoch: "g5pv:7", entitlements: ["postona:x_autopost"], ...over,
});
const deny = (reason: string, decision = "deny") => mvp({ decision, reason, owner_epoch: null, entitlements: [], session: null, subject: { kind: "system" } });

type G5Answer = Record<string, unknown> | Response | Error | "hang";
function world(config: Partial<{ feature: FeatureConfig; profile: string }> = {}) {
  const model = new OwnerHeldModel();
  const g5 = { calls: 0, jwts: [] as string[], script: [] as Array<G5Answer | undefined> };
  const replies: unknown[] = [];
  const provider = recordingFetch(() => {
    const next = replies.shift();
    return next instanceof Response ? next : jsonResponse(200, openAiBody(next ?? { candidates: [{ text: "候補", hashtags: [] }] }, { model: "gpt-6-luna" }));
  });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `${SUPABASE}/rest/v1/rpc/${G5_VERDICT_RPC}`) {
      g5.jwts.push(String(new Headers(init?.headers).get("Authorization")));
      const a = g5.script[g5.calls++] ?? mvp();
      if (a === "hang") return await new Promise<Response>(() => {});
      if (a instanceof Error) throw a;
      return a instanceof Response ? a : jsonResponse(200, a);
    }
    if (url.startsWith(SUPABASE)) return await model.fetchFor("app")(input, init);
    return await provider.fetch(input, init);
  };
  const app = createPostonaPostAssistMvp({
    profile: config.profile ?? G5_R1_PERSONAL_MVP_PROFILE,
    supabaseUrl: SUPABASE,
    publishableKey: "local-g6-21-publishable-NOT-A-SECRET",
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", "local-g6-21-service-NOT-A-SECRET"),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
    feature: config.feature ?? FEATURE,
    fetch,
    g5TimeoutMs: 200,
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  const ask = async (body: Record<string, unknown>, key = "mvp-assist-0001") => {
    const text = JSON.stringify({ brand_id: WORKSPACE, ...body });
    const res = await app.handle(new Request("http://edge.local/postona-post-assist", {
      method: "POST", body: text,
      headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(text).length), Authorization: `Bearer ${JWT}`, "Idempotency-Key": key },
    }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const nothing = () => [provider.calls.length, model.log.length];
  return { model, g5, replies, provider, ask, nothing };
}
const cands = (r: { body: Record<string, unknown> }) => r.body.candidates as Array<{ text: string; hashtags: string[]; editable: boolean; requiresUserConfirmation: boolean }>;

Deno.test("profile pin: only g5pv:<n> passes (as g5oe:1:<n> for the port); g5oe, malformed or other tokens are refused; refusals and non-token wires pass through unchanged", () => {
  assert.equal((pinPersonalMvpWire(mvp()) as { owner_epoch: string }).owner_epoch, "g5oe:1:7");
  assert.equal((pinPersonalMvpWire(mvp({ owner_epoch: "g5pv:9223372036854775807" })) as { owner_epoch: string }).owner_epoch, "g5oe:1:9223372036854775807");
  for (const bad of ["g5oe:7:4", "g5pv:0", "g5pv:07", "g5pv:-1", "g5pv:1:2", "G5PV:7", "g5pv:", "g5pv:12345678901234567890", 7, true]) {
    assert.equal((pinPersonalMvpWire(mvp({ owner_epoch: bad })) as { owner_epoch: string }).owner_epoch, "g6-personal-mvp-token-refused", String(bad));
  }
  const d = deny("SESSION_REVOKED");
  assert.equal(pinPersonalMvpWire(d), d);
  assert.equal(pinPersonalMvpWire(null), null);
  const noToken = mvp({ owner_epoch: null });
  assert.equal(pinPersonalMvpWire(noToken), noToken, "a null token is left for the port (OWNER_EPOCH_MISSING)");
});

Deno.test("the person's flow on X and Threads with G5-47's allow (g5pv): notes -> drafts; hashtags for the person's edited text; a refine; every candidate editable and to be confirmed; one send per step; the verdict and the recheck both carry the person's JWT", async () => {
  const w = world();
  w.replies.push(
    { candidates: [{ text: "週末限定のいちごタルトを始めました。", hashtags: ["#いちごタルト"] }, { text: "いちごの季節です。", hashtags: [] }] },
    { candidates: [{ text: "週末限定のいちごタルト、どうぞ。", hashtags: ["#週末限定"] }] },
    { candidates: [{ text: "今日のおすすめはチーズケーキです。", hashtags: ["#チーズケーキ"] }] },
  );
  const draft = await w.ask({ mode: "draft", platform: "x", notes: "いちごタルト 週末限定" }, "mvp-x-draft-0001");
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.ok(cands(draft).every((c) => c.editable && c.requiresUserConfirmation));
  const tags = await w.ask({ mode: "hashtags", platform: "x", draft: "週末限定のいちごタルト、どうぞ。" }, "mvp-x-tags-0001");
  assert.deepEqual([tags.status, cands(tags)[0].hashtags], [200, ["#週末限定"]]);
  const threads = await w.ask({ mode: "draft", platform: "threads", notes: "チーズケーキ" }, "mvp-th-draft-0001");
  assert.deepEqual([threads.status, cands(threads)[0].hashtags.length], [200, 1]);
  assert.deepEqual([w.provider.calls.length, w.model.statuses()], [3, ["settled", "settled", "settled"]]);
  assert.equal(w.g5.calls, 6, "a verdict and a recheck per step");
  assert.ok(w.g5.jwts.every((h) => h === `Bearer ${JWT}`));
});

Deno.test("generation: a different g5pv between the verdict and the recheck (stop / resume, any account or entitlement change: +1) stops the send — reservation released, nothing sent; the same token sends once", async () => {
  for (const [label, recheck, status] of [["same token", mvp(), 200], ["token +1", mvp({ owner_epoch: "g5pv:8" })], ["token reused lower", mvp({ owner_epoch: "g5pv:6" })], ["g5oe at the recheck", mvp({ owner_epoch: "g5oe:7:7" })]] as Array<[string, Record<string, unknown>, number?]>) {
    const w = world();
    w.g5.script = [mvp(), recheck];
    const r = await w.ask({ mode: "draft", platform: "x", notes: "x" });
    if (status === 200) {
      assert.deepEqual([r.status, w.provider.calls.length, w.model.statuses()], [200, 1, ["settled"]], label);
    } else {
      assert.deepEqual([r.status, r.body.error, w.provider.calls.length, w.model.statuses()], [403, "POST_ASSIST_NOT_ENTITLED", 0, ["released"]], label);
    }
  }
});

Deno.test("G5-47's refusals and the profile pin are fail-closed: no reservation, no send, no charge", async () => {
  const cases: Array<[string, G5Answer, number, string]> = [
    ["anonymous / no is_anonymous (AUTH_REQUIRED)", deny("AUTH_REQUIRED"), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["session expired", deny("SESSION_EXPIRED"), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["unknown session (SESSION_REVOKED)", deny("SESSION_REVOKED"), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["another / missing workspace", deny("BRAND_ACCESS_DENIED"), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["a second member (OWN_WORKSPACE_CONFLICT, new in G5-47)", deny("OWN_WORKSPACE_CONFLICT"), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["two owners", deny("WORKSPACE_OWNER_UNKNOWN", "unknown"), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["service suspended (stop)", deny("SERVICE_SUSPENDED"), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["service being ended", deny("SERVICE_DELETION_IN_PROGRESS"), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["trigger tampered (SERVICE_GENERATION_UNAVAILABLE, new in G5-47)", deny("SERVICE_GENERATION_UNAVAILABLE", "unknown"), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["an allow with the full profile's g5oe token (pinned)", mvp({ owner_epoch: "g5oe:7:4" }), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["an allow with no token", mvp({ owner_epoch: null }), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["an allow without the entitlement", mvp({ entitlements: [] }), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["an allow for another workspace", mvp({ scope: { app: "postona", feature: "post_generation", brand_slug: "u_0b1c2d3e4f5061728394a5b6" } }), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["an allow with an extra key (not v1)", mvp({ is_anonymous: false }), 503, "POST_ASSIST_AUTH_UNAVAILABLE"],
    ["R1-MVP ACL not granted yet: 403 (BLOCKED_G5_AUTH_EXECUTE)", jsonResponse(403, { code: "42501" }), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["JWT refused: 401", jsonResponse(401, { code: "PGRST301" }), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["R1-MVP not applied: 404 PGRST202 (G6-27: not available, not a same-key retry)", jsonResponse(404, { code: "PGRST202" }), 403, "POST_ASSIST_NOT_ENTITLED"],
    ["G5 5xx", jsonResponse(500, {}), 503, "POST_ASSIST_AUTH_UNAVAILABLE"],
    ["G5 down", new TypeError("down"), 503, "POST_ASSIST_AUTH_UNAVAILABLE"],
    ["G5 timeout", "hang", 503, "POST_ASSIST_AUTH_UNAVAILABLE"],
  ];
  for (const [label, answer, status, error] of cases) {
    const w = world();
    w.g5.script = [answer];
    const r = await w.ask({ mode: "draft", platform: "x", notes: "x" });
    assert.deepEqual([r.status, r.body.error, ...w.nothing()], [status, error, 0, 0], label);
  }
});

Deno.test("retries, rate limits and bad input: the same Idempotency-Key replays (one send); OpenAI 429 is a failure stored for that key (no resend, settled as failed or unknown, never twice); invalid input is refused before G5", async () => {
  const w = world();
  w.replies.push({ candidates: [{ text: "一回目", hashtags: [] }] });
  const a = await w.ask({ mode: "draft", platform: "x", notes: "x" }, "mvp-retry-0001");
  const b = await w.ask({ mode: "draft", platform: "x", notes: "x" }, "mvp-retry-0001");
  assert.deepEqual([a.status, b.status, cands(b)[0].text, w.provider.calls.length], [200, 200, "一回目", 1]);

  const limited = world();
  limited.replies.push(jsonResponse(429, { error: { type: "rate_limit_exceeded", message: "slow down" } }, { "retry-after": "1" }));
  const r429 = await limited.ask({ mode: "draft", platform: "x", notes: "x" }, "mvp-429-0001");
  const again = await limited.ask({ mode: "draft", platform: "x", notes: "x" }, "mvp-429-0001");
  assert.equal(r429.status, 502, JSON.stringify(r429.body));
  assert.deepEqual([again.status, again.body.error, limited.provider.calls.length], [502, r429.body.error, 1], "replayed, not resent");
  assert.equal(limited.model.statuses().length, 1);
  assert.ok(["failed", "unknown"].includes(limited.model.statuses()[0]), limited.model.statuses()[0]);

  const bad = world();
  for (const body of [{ mode: "draft", platform: "instagram", notes: "x" }, { mode: "refine", platform: "x", draft: "y" }, { mode: "draft", platform: "x", notes: "x", brand_id: "UPPER" }]) {
    assert.equal((await bad.ask(body, "mvp-bad-0001")).status, 400, JSON.stringify(body));
  }
  assert.deepEqual([bad.g5.calls, ...bad.nothing()], [0, 0, 0]);
});

Deno.test("configuration: the profile must be G5-47's, the feature OpenAI-only and opened by postona:x_autopost alone; a disabled feature is refused at startup", () => {
  const base = { profile: G5_R1_PERSONAL_MVP_PROFILE, supabaseUrl: SUPABASE, publishableKey: "local-g6-21-publishable-NOT-A-SECRET", serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", "local-g6-21-service-NOT-A-SECRET"), readEnv: () => undefined, feature: FEATURE };
  for (const [label, over] of [
    ["full profile", { profile: "g5-r1-full-v1" }],
    ["anthropic", { feature: { ...FEATURE, provider: "anthropic" as const, model: "claude-haiku-5-5" } }],
    ["another entitlement", { feature: { ...FEATURE, entitlements: ["postona:other"] } }],
    ["two entitlements", { feature: { ...FEATURE, entitlements: ["postona:x_autopost", "postona:other"] } }],
    ["disabled", { feature: { ...FEATURE, enabled: false } }],
  ] as Array<[string, Record<string, unknown>]>) {
    assert.throws(() => createPostonaPostAssistMvp({ ...base, ...over } as never), (e: unknown) => e instanceof PostonaPostAssistMvpConfigError, label);
  }
});
