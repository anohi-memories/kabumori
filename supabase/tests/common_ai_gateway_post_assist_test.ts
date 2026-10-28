// G6-20 (2026-10-28): POSTONA personal MVP post text + hashtag candidates, end to end OFFLINE through the REAL G6 code:
// handlePostAssistRequest -> createAiGateway (owner-held ledger, the default) -> the real G5 RPC transport and port ->
// shared execute -> the OpenAI adapter. Outside the process everything is a fake: G5's proposed verdict RPC (G5's own
// v1 "allow post_generation" sample), the call store / ledger / owner-held RPCs (common_ai_gateway_owner_held_fake.ts)
// and OpenAI (scripted replies). No network, fake keys, nothing is posted anywhere (no SNS endpoint exists here).
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY --allow-read=supabase/tests/fixtures \
//     supabase/tests/common_ai_gateway_post_assist_test.ts
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import { buildAppPolicySet } from "../ai_gateway/app_policies.ts";
import { createG5AuthorityPort } from "../ai_gateway/authority_port.ts";
import { createG5RpcTransport } from "../ai_gateway/g5_rpc_transport.ts";
import { handlePostAssistRequest, POST_ASSIST_SCHEMA_NAME, POSTONA_POST_ASSIST_CONTENT, xWeightedLength } from "../ai_gateway/postona_post_assist.ts";
import { type AiGateway, createAiGateway } from "../ai_gateway/runtime.ts";
import { OwnerHeldModel } from "./common_ai_gateway_owner_held_fake.ts";

type Sample = { name: string; scope: { brand_slug: string | null }; rpc_wire: Record<string, unknown> };
const SAMPLES = (JSON.parse(await Deno.readTextFile(new URL("./fixtures/g5_verdict_v1_rpc_samples.json", import.meta.url))) as { samples: Sample[] }).samples;
const ALLOW = SAMPLES.find((s) => s.name === "allow post_generation")!;
const BRAND = String(ALLOW.scope.brand_slug);
const SUPABASE = "http://127.0.0.1:54321";
const JWT = "eyG6P.payloadNOTREAL.signatureNOTREAL"; // JWT-shaped, not a token
const SET = buildAppPolicySet({
  "postona:post_generation": {
    enabled: true, revision: "test-mvp1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 800, timeoutMs: 20_000,
    maxAttempts: 1, maxCostUsdPerOperation: 0.1, maxInputBytes: 8_000, entitlements: ["postona:x_autopost"],
  },
}, { "postona:post_generation": POSTONA_POST_ASSIST_CONTENT });

type Wire = Record<string, unknown> | Response | Error;
function world(options: { gateway?: "off" } = {}) {
  const model = new OwnerHeldModel();
  const g5: { calls: number; script: Array<Wire | undefined> } = { calls: 0, script: [] };
  const g5Fetch: FetchLike = (_input, _init) => {
    const a = g5.script[g5.calls++] ?? ALLOW.rpc_wire;
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve(a instanceof Response ? a : jsonResponse(200, a));
  };
  const replies: unknown[] = [];
  const provider = recordingFetch(() => {
    const next = replies.shift();
    return next instanceof Response ? next : jsonResponse(200, openAiBody(next ?? { candidates: [{ text: "既定の候補", hashtags: [] }] }, { model: "gpt-6-luna" }));
  });
  const gateway: AiGateway | null = options.gateway === "off" ? null : createAiGateway({
    supabaseUrl: SUPABASE,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", "local-g6-20-service-NOT-A-SECRET"),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
    authority: createG5AuthorityPort({
      transport: createG5RpcTransport({ supabaseUrl: SUPABASE, publishableKey: "local-g6-20-publishable-NOT-A-SECRET", fetch: g5Fetch }),
      planAllowlist: SET.planAllowlist,
      timeoutMs: 200,
    }),
    policies: SET.registry,
    fetch: (input, init) => (String(input).startsWith(SUPABASE) ? model.fetchFor("app")(input, init) : provider.fetch(input, init)),
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  /** One person-facing request, as an app screen would send it. */
  const ask = async (body: Record<string, unknown>, key: string | null = "postassist-0001", headers: Record<string, string> = {}) => {
    const text = JSON.stringify({ brand_id: BRAND, ...body });
    const h: Record<string, string> = { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(text).length), Authorization: `Bearer ${JWT}`, ...headers };
    if (key) h["Idempotency-Key"] = key;
    const res = await handlePostAssistRequest(new Request("http://edge.local/postona-post-assist", { method: "POST", headers: h, body: text }), gateway);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { model, g5, replies, provider, ask };
}
const candidatesOf = (r: { body: Record<string, unknown> }) => r.body.candidates as Array<{ text: string; hashtags: string[]; length: number; limit: number; editable: boolean; requiresUserConfirmation: boolean; platform: string }>;

Deno.test("the person's flow on X: notes -> 3 draft candidates; the person edits one -> hashtag ideas for that exact text; then a refine with an instruction. Every answer is an editable candidate that needs the person's confirmation; one provider request per step; nothing posted", async () => {
  const w = world();
  w.replies.push(
    { candidates: [{ text: "新メニューのいちごタルトを始めました。週末限定です。", hashtags: ["#いちごタルト"] }, { text: "週末だけの、いちごタルト。", hashtags: [] }, { text: "いちごの季節が来ました。", hashtags: ["#週末限定"] }] },
    { candidates: [{ text: "週末だけの、いちごタルト。ぜひ。", hashtags: ["#いちごタルト", "#週末限定"] }] },
    { candidates: [{ text: "週末だけの特別ないちごタルト、ご用意しています。", hashtags: [] }, { text: "いちごタルト、週末限定でお待ちしています。", hashtags: ["#カフェ"] }] },
  );
  const draft = await w.ask({ mode: "draft", platform: "x", notes: "いちごタルトの新メニュー。週末限定。" }, "postassist-draft-0001");
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.equal(candidatesOf(draft).length, 3);
  assert.match(String(draft.body.notice), /確認・編集/);
  for (const c of candidatesOf(draft)) {
    assert.deepEqual([c.platform, c.editable, c.requiresUserConfirmation, c.limit], ["x", true, true, 280]);
    assert.ok(c.length <= 280 && c.length === xWeightedLength(c.hashtags.length ? `${c.text}\n\n${c.hashtags.join(" ")}` : c.text));
  }
  const edited = "週末だけの、いちごタルト。ぜひ。"; // the person's own edit of candidate 2
  const tags = await w.ask({ mode: "hashtags", platform: "x", draft: edited }, "postassist-tags-0001");
  assert.equal(tags.status, 200, JSON.stringify(tags.body));
  assert.deepEqual(candidatesOf(tags).map((c) => [c.text, c.hashtags]), [[edited, ["#いちごタルト", "#週末限定"]]]);
  const refine = await w.ask({ mode: "refine", platform: "x", draft: edited, instruction: "もう少し丁寧に" }, "postassist-refine-0001");
  assert.equal(refine.status, 200, JSON.stringify(refine.body));
  assert.equal(candidatesOf(refine).length, 2);
  // One provider request per step, all to OpenAI with this feature's schema; the owner-held ledger every time.
  assert.equal(w.provider.calls.length, 3);
  assert.ok(w.provider.calls.every((c) => c.url.startsWith("https://api.openai.com/") && JSON.stringify(c.body).includes(POST_ASSIST_SCHEMA_NAME)));
  assert.deepEqual(w.model.calls("app").filter((c) => c === "ai_calls_mark_sent_held").length, 3);
  assert.ok(!w.model.calls("app").includes("ai_ledger_mark_sent"), "never the plain ledger permit");
  assert.deepEqual(w.model.statuses(), ["settled", "settled", "settled"]);
});

Deno.test("Threads: one topic tag at most and 500 characters; a candidate that breaks the rule is dropped; when none is usable the answer is POST_ASSIST_AI_UNUSABLE (502, use a new key)", async () => {
  const w = world();
  w.replies.push(
    { candidates: [{ text: "今日のおすすめはチーズケーキです。", hashtags: ["#チーズケーキ"] }, { text: "二つのタグ", hashtags: ["#a", "#b"] }] },
    { candidates: [{ text: "あ".repeat(501), hashtags: [] }] },
  );
  const ok = await w.ask({ mode: "draft", platform: "threads", notes: "チーズケーキ" }, "postassist-th-0001");
  assert.deepEqual([ok.status, candidatesOf(ok).map((c) => c.hashtags.length), candidatesOf(ok)[0].limit], [200, [1], 500]);
  const none = await w.ask({ mode: "draft", platform: "threads", notes: "長い" }, "postassist-th-0002");
  assert.deepEqual([none.status, none.body.error, none.body.retry_same_key], [502, "POST_ASSIST_AI_UNUSABLE", false]);
});

Deno.test("output checks: X over 280 weighted (CJK counts 2) dropped; in hashtags mode a changed text is dropped (the person's text is never rewritten there); a malformed hashtag or a hashtag inside the text fails the gateway's check (OUTPUT_REJECTED -> 502)", async () => {
  const w = world();
  w.replies.push(
    { candidates: [{ text: "あ".repeat(141), hashtags: [] }, { text: "あ".repeat(140), hashtags: [] }] },
    { candidates: [{ text: "書き換えた文", hashtags: ["#x"] }] },
    { candidates: [{ text: "タグ", hashtags: ["#空白 あり"] }] },
    { candidates: [{ text: "本文に #タグ", hashtags: [] }] },
  );
  const long = await w.ask({ mode: "draft", platform: "x", notes: "a" }, "postassist-out-0001");
  assert.deepEqual([long.status, candidatesOf(long).map((c) => c.length)], [200, [280]]);
  const changed = await w.ask({ mode: "hashtags", platform: "x", draft: "元の文" }, "postassist-out-0002");
  assert.deepEqual([changed.status, changed.body.error], [502, "POST_ASSIST_AI_UNUSABLE"]);
  for (const key of ["postassist-out-0003", "postassist-out-0004"]) {
    const bad = await w.ask({ mode: "draft", platform: "x", notes: "b" }, key);
    assert.deepEqual([bad.status, bad.body.error], [502, "POST_ASSIST_AI_UNUSABLE"], key);
  }
});

Deno.test("retries never send twice: the same Idempotency-Key replays the stored candidates; a new key is a new request", async () => {
  const w = world();
  w.replies.push({ candidates: [{ text: "一回目", hashtags: [] }] }, { candidates: [{ text: "二回目", hashtags: [] }] });
  const first = await w.ask({ mode: "draft", platform: "x", notes: "c" }, "postassist-retry-0001");
  const again = await w.ask({ mode: "draft", platform: "x", notes: "c" }, "postassist-retry-0001");
  assert.deepEqual([first.status, again.status, candidatesOf(again)[0].text, w.provider.calls.length], [200, 200, "一回目", 1]);
  const fresh = await w.ask({ mode: "draft", platform: "x", notes: "c" }, "postassist-retry-0002");
  assert.deepEqual([candidatesOf(fresh)[0].text, w.provider.calls.length, w.model.calls("app").filter((c) => c === "ai_calls_reserve_held").length], ["二回目", 2, 2]);
});

Deno.test("who may call is G5's: a revoked session, no entitlement, G5 down, a revocation at the recheck, the gateway not configured -> refused with nothing sent (and nothing reserved before the recheck)", async () => {
  const denied = SAMPLES.find((s) => s.name === "session revoked")!.rpc_wire;
  const cases: Array<[string, Array<Wire | undefined>, number, string, boolean]> = [
    ["session revoked", [denied], 403, "POST_ASSIST_NOT_ENTITLED", false],
    ["no entitlement", [{ ...ALLOW.rpc_wire, entitlements: [] }], 403, "POST_ASSIST_NOT_ENTITLED", false],
    ["G5 down", [new TypeError("down")], 503, "POST_ASSIST_AUTH_UNAVAILABLE", true],
    ["revoked at the recheck", [undefined, denied], 403, "POST_ASSIST_NOT_ENTITLED", false],
  ];
  for (const [label, script, status, error, retry] of cases) {
    const w = world();
    w.g5.script = script;
    const r = await w.ask({ mode: "draft", platform: "x", notes: "d" }, "postassist-auth-0001");
    assert.deepEqual([r.status, r.body.error, r.body.retry_same_key, w.provider.calls.length], [status, error, retry, 0], label);
    assert.deepEqual(w.model.statuses(), label === "revoked at the recheck" ? ["released"] : [], label);
  }
  const off = world({ gateway: "off" });
  const r = await off.ask({ mode: "draft", platform: "x", notes: "d" });
  assert.deepEqual([r.status, r.body.error, off.provider.calls.length, off.g5.calls], [503, "POST_ASSIST_UNAVAILABLE", 0, 0]);
});

Deno.test("request checks before anything is asked: wrong method, no / oversized length, unknown keys, a bad workspace id, fields the mode does not take or lacks, over-long notes, no Idempotency-Key -> 4xx, G5 never asked, nothing sent", async () => {
  const w = world();
  const bad: Array<[Record<string, unknown>, string | null]> = [
    [{ mode: "draft", platform: "x", notes: "x", extra: 1 }, "postassist-bad-0001"],
    [{ mode: "draft", platform: "instagram", notes: "x" }, "postassist-bad-0002"],
    [{ mode: "draft", platform: "x" }, "postassist-bad-0003"],
    [{ mode: "draft", platform: "x", notes: "x", draft: "y" }, "postassist-bad-0004"],
    [{ mode: "refine", platform: "x", draft: "y" }, "postassist-bad-0005"],
    [{ mode: "hashtags", platform: "x", draft: "y", instruction: "z" }, "postassist-bad-0006"],
    [{ mode: "draft", platform: "x", notes: "あ".repeat(2001) }, "postassist-bad-0007"],
    [{ mode: "draft", platform: "x", notes: "   " }, "postassist-bad-0008"],
    [{ mode: "draft", platform: "x", notes: "x", brand_id: "Bad-Brand" }, "postassist-bad-0009"],
  ];
  for (const [body, key] of bad) assert.deepEqual([(await w.ask(body, key)).status], [400], JSON.stringify(body));
  const noKey = await w.ask({ mode: "draft", platform: "x", notes: "x" }, null);
  assert.deepEqual([noKey.status, noKey.body.error], [400, "POST_ASSIST_IDEMPOTENCY_KEY_REQUIRED"]);
  const get = await handlePostAssistRequest(new Request("http://edge.local/postona-post-assist", { method: "GET" }), null);
  assert.equal(get.status, 405);
  const noLength = await handlePostAssistRequest(new Request("http://edge.local/postona-post-assist", { method: "POST", body: "{}" }), null);
  assert.equal(noLength.status, 400);
  assert.deepEqual([w.g5.calls, w.provider.calls.length, w.model.log.length], [0, 0, 0]);
});
