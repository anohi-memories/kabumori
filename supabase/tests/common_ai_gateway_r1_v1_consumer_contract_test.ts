// G6-17 (2026-10-25): OFFLINE consumer contract of the G5 R1 v1 verdict as the G6 gateway uses it today. The REAL G6
// code end to end (createG5RpcTransport -> createG5AuthorityPort -> createAiGateway -> shared provider adapters, ledger
// guard, call store); outside the process everything is a fake: a PostgREST stand-in for G5's proposed RPC (the 8-key
// wire, G5's own v1 samples), an in-memory Supabase (ledger + ai_calls RPCs) and the providers. No network, fake keys.
// It pins what v1 already guarantees (a refusal, an unreadable answer or a lost G5 never reserves, sends or charges;
// retries never charge twice) and, separately, two KNOWN GAPS that v1 at this layer does NOT close (their tests assert
// today's behaviour so a change is noticed; they are not a PASS of a guarantee). G5's final IF, the real RPC and the
// owner-held wiring are not assumed. Contract table: docs/ai-provider/G6_R1_V1_CONSUMER_CONTRACT.md.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY --allow-read=supabase/tests/fixtures \
//     supabase/tests/common_ai_gateway_r1_v1_consumer_contract_test.ts
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody, type RecordedCall, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import { buildAppPolicySet, type FeatureConfig, type FeatureContent } from "../ai_gateway/app_policies.ts";
import { createG5AuthorityPort } from "../ai_gateway/authority_port.ts";
import { createG5RpcTransport, G5_VERDICT_RPC } from "../ai_gateway/g5_rpc_transport.ts";
import { createAiGateway } from "../ai_gateway/runtime.ts";

type Sample = { name: string; scope: { app: string; feature: string; brand_slug: string | null }; g5_decision: string; g5_reason: string | null; rpc_wire: Record<string, unknown> };
const SAMPLES = (JSON.parse(await Deno.readTextFile(new URL("./fixtures/g5_verdict_v1_rpc_samples.json", import.meta.url))) as { samples: Sample[] }).samples;
const ALLOW = SAMPLES.find((s) => s.name === "allow consult")!;
const V1_KEYS = ["decision", "entitlements", "owner_epoch", "reason", "scope", "session", "subject", "v"];

const SUPABASE = "http://127.0.0.1:54321";
const PUBLISHABLE = "local-g6-17-publishable-NOT-A-SECRET";
const SERVICE_KEY = "local-g6-17-service-NOT-A-SECRET";
const JWT_A = "eyG6A.payloadNOTREAL.signatureNOTREAL"; // JWT-shaped, not a token
const JWT_B = "eyG6B.payloadNOTREAL.signatureNOTREAL";
const BRAND = { app: "postona" as const, slug: String(ALLOW.scope.brand_slug) };
const OTHER_BRAND = "u_0b1c2d3e4f5061728394a5b6";
const USER_A = String((ALLOW.rpc_wire.subject as { user_id: string }).user_id);
const USER_B = "22222222-2222-4222-8222-222222222222";

const cfg = (over: Partial<FeatureConfig> = {}): FeatureConfig => ({
  enabled: true, revision: "test-r1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 300, timeoutMs: 20_000,
  maxAttempts: 1, maxCostUsdPerOperation: 0.05, maxInputBytes: 8_000, entitlements: ["postona:x_autopost"], ...over,
});
const content: FeatureContent = {
  systemInstructions: "Test instructions; answer JSON { reply }.",
  schema: { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } },
  validate: (p) => typeof (p as { reply?: unknown })?.reply === "string",
};
const SET = buildAppPolicySet({ "postona:consult": cfg(), "postona:post_generation": cfg() }, { "postona:consult": content, "postona:post_generation": content });

type Answer = Response | Error | "hang" | Record<string, unknown>;
/** PostgREST stand-in for G5's proposed RPC: the n-th call gets script[n] (else G5's allow for the caller); records each call. */
class FakeG5Rpc {
  calls: Array<{ jwt: string; body: unknown }> = [];
  script: Array<Answer | ((n: number) => Answer) | undefined> = [];
  readonly fetch: FetchLike = async (input, init) => {
    assert.ok(String(input).endsWith(`/rest/v1/rpc/${G5_VERDICT_RPC}`));
    const jwt = String(new Headers(init?.headers).get("Authorization")).replace(/^Bearer /u, "");
    this.calls.push({ jwt, body: JSON.parse(String(init?.body)) });
    const step = this.script[this.calls.length - 1];
    const a = typeof step === "function" ? step(this.calls.length) : step ?? allowFor(jwt);
    if (a === "hang") return await new Promise<Response>(() => {});
    if (a instanceof Error) throw a;
    if (a instanceof Response) return a;
    return jsonResponse(200, a);
  };
}
/** G5's v1 allow (8 keys, no times) for the person behind the JWT, from G5's own sample. */
function allowFor(jwt: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const w = structuredClone(ALLOW.rpc_wire);
  if (jwt === JWT_B) w.subject = { kind: "user", user_id: USER_B };
  return { ...w, ...over };
}

/** In-memory ledger + ai_calls RPCs (the shapes the real guard and store read). `onSecondClaim` runs before a claim of an existing row. */
class FakeSupabase {
  calls: string[] = [];
  reservations = new Map<string, string>();
  rows = new Map<string, { identity: string; owner: string; state: "acquired" | "complete"; result: unknown }>();
  fault: Record<string, "network" | number | "lost" | undefined> = {};
  onSecondClaim: ((callKey: string) => void) | null = null;
  private n = 0;
  // deno-lint-ignore require-await
  readonly fetch: FetchLike = async (input, init) => {
    const name = new URL(String(input)).pathname.replace("/rest/v1/rpc/", "");
    const p = (JSON.parse(String(init?.body)) as { p: Record<string, unknown> }).p;
    this.calls.push(name.replace(/^ai_(ledger|calls)_/u, ""));
    const f = this.fault[name];
    if (f === "network") throw new TypeError("unreachable");
    if (typeof f === "number") return jsonResponse(f, { code: "XX000" });
    const out = this.answer(name, p);
    return f === "lost" ? jsonResponse(504, {}) : jsonResponse(200, out);
  };
  count = (name: string) => this.calls.filter((c) => c === name).length;
  private answer(name: string, p: Record<string, unknown>): unknown {
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
        const key = String(p.call_key);
        const identity = JSON.stringify([p.tenant_tag, p.fingerprint, p.application, p.feature, p.subject_kind, p.user_id ?? null]);
        if (this.rows.has(key)) this.onSecondClaim?.(key);
        const row = this.rows.get(key);
        if (!row) {
          const owner = crypto.randomUUID();
          this.rows.set(key, { identity, owner, state: "acquired", result: null });
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

function world(options: { respond?: (call: RecordedCall) => Response | Promise<Response> } = {}) {
  const g5 = new FakeG5Rpc();
  const supabase = new FakeSupabase();
  const provider = recordingFetch((call) => options.respond?.(call) ?? jsonResponse(200, openAiBody({ reply: "ok" }, { model: "gpt-6-luna" })));
  const gateway = createAiGateway({
    supabaseUrl: SUPABASE,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
    // The real transport for G5's proposed RPC and the real port; G5 never answers for system work (acceptSystemSubject off).
    authority: createG5AuthorityPort({
      transport: createG5RpcTransport({ supabaseUrl: SUPABASE, publishableKey: PUBLISHABLE, fetch: g5.fetch }),
      planAllowlist: SET.planAllowlist,
      timeoutMs: 200,
    }),
    policies: SET.registry,
    fetch: (input, init) => (String(input).startsWith(SUPABASE) ? supabase.fetch(input, init) : provider.fetch(input, init)),
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  const run = (jwt: string, over: Record<string, unknown> = {}) =>
    gateway.execute(jwt, { app: "postona", feature: "consult", operationId: "op-g6-17-0001", input: "相談", brand: BRAND, ...over });
  /** Nothing claimed, reserved, sent or charged. */
  const untouched = () => [supabase.calls.length, provider.calls.length];
  return { g5, supabase, provider, run, untouched };
}
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "OK" : r.code);

Deno.test("R1 v1 pinned: exactly the 8 RPC keys of G5's samples; G5's allow sends once; every G5 refusal (deny / pending / unknown) maps to AUTH_DENIED / AUTH_PENDING / AUTH_UNKNOWN with nothing claimed, reserved, sent or charged", async () => {
  for (const s of SAMPLES) assert.deepEqual(Object.keys(s.rpc_wire).sort(), V1_KEYS, s.name);
  const expected: Record<string, string> = { allow: "OK", deny: "AUTH_DENIED", pending: "AUTH_PENDING", unknown: "AUTH_UNKNOWN" };
  for (const s of SAMPLES) {
    if (s.scope.app !== "postona" || !["consult", "post_generation"].includes(s.scope.feature)) continue; // not enabled here: refused before G5
    const w = world();
    w.g5.script = [s.rpc_wire, s.rpc_wire];
    const brand = s.scope.brand_slug ? { app: "postona", slug: s.scope.brand_slug } : null;
    const r = await w.run(JWT_A, { feature: s.scope.feature, brand });
    assert.equal(code(r), expected[s.g5_decision], s.name);
    if (s.g5_decision === "allow") {
      assert.deepEqual([w.provider.calls.length, w.supabase.count("reserve"), w.supabase.count("mark_sent"), w.supabase.count("settle")], [1, 1, 1, 1], s.name);
    } else assert.deepEqual(w.untouched(), [0, 0], `${s.name}: nothing claimed, reserved or sent`);
  }
  // Features no plan opens are refused without asking G5 (G5's FEATURE_NOT_ENABLED samples never reach it).
  const w = world();
  for (const feature of ["market_report", "unknown_feature"]) assert.equal(code(await w.run(JWT_A, { feature })), "AUTH_DENIED");
  assert.deepEqual([w.g5.calls.length, ...w.untouched()], [0, 0, 0]);
});

Deno.test("invalid, missing, unknown or tampered wire: an unreadable answer is AUTH_UNAVAILABLE, a readable one that is not exactly G5's allow is AUTH_UNKNOWN; never a claim, reservation, send or charge", async () => {
  const w8 = (over: Record<string, unknown>) => allowFor(JWT_A, over);
  const cases: Array<[string, Answer, string]> = [
    ["an extra key", w8({ is_anonymous: false }), "AUTH_UNAVAILABLE"],
    ["a missing key", (() => { const x = w8({}); delete x.entitlements; return x; })(), "AUTH_UNAVAILABLE"],
    ["times in the body", w8({ issued_at_ms: 1, expires_at_ms: 2 }), "AUTH_UNAVAILABLE"],
    ["not JSON", new Response("<html>", { status: 200 }), "AUTH_UNAVAILABLE"],
    ["an array", new Response("[]", { status: 200 }), "AUTH_UNAVAILABLE"],
    ["v 2", w8({ v: 2 }), "AUTH_UNKNOWN"],
    ["an unknown decision", w8({ decision: "maybe" }), "AUTH_UNKNOWN"],
    ["an allow with a reason", w8({ reason: "OK" }), "AUTH_UNKNOWN"],
    ["another feature", w8({ scope: { app: "postona", feature: "post_generation", brand_slug: BRAND.slug } }), "AUTH_UNKNOWN"],
    ["another workspace", w8({ scope: { app: "postona", feature: "consult", brand_slug: OTHER_BRAND } }), "AUTH_UNKNOWN"],
    ["no workspace", w8({ scope: { app: "postona", feature: "consult", brand_slug: null } }), "AUTH_UNKNOWN"],
    ["owner epoch missing", w8({ owner_epoch: null }), "AUTH_UNKNOWN"],
    ...["g5oe:0:1", "g5oe:7", "7:4", "g5oe:7:4:1", "G5OE:7:4", "g5oe:07:4", "g5oe:-7:4"].map((e): [string, Answer, string] => [`owner epoch ${e}`, w8({ owner_epoch: e }), "AUTH_UNKNOWN"]),
    ["entitlements as a string", w8({ entitlements: "postona:x_autopost" }), "AUTH_UNKNOWN"],
    ["a duplicated entitlement", w8({ entitlements: ["postona:x_autopost", "postona:x_autopost"] }), "AUTH_UNKNOWN"],
    ["an entitlement of another shape", w8({ entitlements: ["POSTONA:X_AUTOPOST"] }), "AUTH_UNKNOWN"],
    ["a user id that is not a uuid", w8({ subject: { kind: "user", user_id: "user-a" } }), "AUTH_UNKNOWN"],
    ["a user with an extra subject key", w8({ subject: { kind: "user", user_id: USER_A, anonymous: false } }), "AUTH_UNKNOWN"],
    ["a system subject (G5 never answers for one)", w8({ subject: { kind: "system" }, session: null, owner_epoch: null }), "AUTH_UNKNOWN"],
    ["no session for a person", w8({ session: null }), "AUTH_UNKNOWN"],
    ["a session with an extra key", w8({ session: { state: "active", ref: "s:1", expires: 1 } }), "AUTH_UNKNOWN"],
  ];
  for (const [label, answer, want] of cases) {
    const w = world();
    w.g5.script = [answer];
    assert.equal(code(await w.run(JWT_A)), want, label);
    assert.deepEqual(w.untouched(), [0, 0], `${label}: nothing claimed, reserved or sent`);
  }
});

Deno.test("who the person is stays G5's decision: no principal, 401 / 403, deleted, locked, missing account, a non-active session, no or another entitlement, a non-member -> refused before anything is claimed, reserved or sent", async () => {
  const sample = (name: string) => SAMPLES.find((s) => s.name === name)!.rpc_wire;
  const cases: Array<[string, Answer, string]> = [
    ["no principal (G5 AUTH_REQUIRED)", sample("no principal"), "AUTH_DENIED"],
    ["401 (JWT refused)", jsonResponse(401, { code: "PGRST301" }), "AUTH_DENIED"],
    ["403", jsonResponse(403, { code: "42501" }), "AUTH_DENIED"],
    ["account deleting", sample("account deleting"), "AUTH_DENIED"],
    ["account locked", sample("account locked"), "AUTH_DENIED"],
    ["account missing", sample("account missing"), "AUTH_DENIED"],
    ["session revoked (G5 deny)", sample("session revoked"), "AUTH_DENIED"],
    ["session expired (G5 deny)", sample("session expired"), "AUTH_DENIED"],
    ...["revoked", "expired", "unknown"].map((state): [string, Answer, string] => [`an allow naming a ${state} session`, allowFor(JWT_A, { session: { state, ref: "s:1" } }), "AUTH_DENIED"]),
    ["an allow without entitlements", allowFor(JWT_A, { entitlements: [] }), "AUTH_DENIED"],
    ["an allow with another service only", allowFor(JWT_A, { entitlements: ["postona:other_service"] }), "AUTH_DENIED"],
    ["service suspended", sample("service suspended"), "AUTH_DENIED"],
    ["service ended", sample("service ended"), "AUTH_DENIED"],
    ["not a member", sample("not a member"), "AUTH_DENIED"],
    ["admin, not owner", sample("admin, not owner"), "AUTH_DENIED"],
    ["two owners", sample("two owners"), "AUTH_UNKNOWN"],
    ["owner epoch unavailable", sample("owner epoch null"), "AUTH_UNKNOWN"],
  ];
  for (const [label, answer, want] of cases) {
    const w = world();
    w.g5.script = [answer];
    assert.equal(code(await w.run(JWT_A)), want, label);
    assert.deepEqual(w.untouched(), [0, 0], `${label}: nothing claimed, reserved or sent`);
  }
  // A credential that is not JWT-shaped is never sent to G5.
  const w = world();
  assert.equal(code(await w.run("not-a-jwt")), "AUTH_UNAVAILABLE");
  assert.deepEqual([w.g5.calls.length, ...w.untouched()], [0, 0, 0]);
});

Deno.test("G5 lost or slow at the verdict (network, 404 = not deployed, 5xx, a hang past the timeout) -> AUTH_UNAVAILABLE, nothing claimed, reserved or sent; a later retry of the same operation sends exactly once", async () => {
  for (const [label, answer] of [["network", new TypeError("down")], ["404", jsonResponse(404, { code: "PGRST202" })], ["500", jsonResponse(500, {})],
    ["502", jsonResponse(502, {})], ["hang", "hang"]] as Array<[string, Answer]>) {
    const w = world();
    w.g5.script = [answer];
    assert.equal(code(await w.run(JWT_A)), "AUTH_UNAVAILABLE", label);
    assert.deepEqual(w.untouched(), [0, 0], label);
    // Nothing was claimed, so the same operation id runs normally afterwards (verdict + recheck), and sends once.
    assert.equal(code(await w.run(JWT_A)), "OK", `${label}: retry`);
    assert.deepEqual([w.provider.calls.length, w.supabase.count("reserve"), w.supabase.count("settle"), w.g5.calls.length], [1, 1, 1, 3], label);
  }
});

Deno.test("the recheck right before the send: revoked or expired session, a stale or another owner epoch, the entitlement removed, another person on the JWT, 401, a lost / slow / unreadable answer -> AUTH_REVOKED_BEFORE_SEND: the reservation released, nothing sent or settled; a retry of the operation replays NOT_SENT without a second reservation", async () => {
  const cases: Array<[string, Answer]> = [
    ["session revoked", SAMPLES.find((s) => s.name === "session revoked")!.rpc_wire],
    ["session expired in an allow", allowFor(JWT_A, { session: { state: "expired", ref: "s:1" } })],
    ["a newer lifecycle (stale epoch)", allowFor(JWT_A, { owner_epoch: "g5oe:7:5" })],
    ["another owner epoch", allowFor(JWT_A, { owner_epoch: "g5oe:8:1" })],
    ["the entitlement removed", allowFor(JWT_A, { entitlements: [] })],
    ["another session ref", allowFor(JWT_A, { session: { state: "active", ref: "s:other" } })],
    ["another person on the same JWT", allowFor(JWT_B)],
    ["401", jsonResponse(401, {})],
    ["500", jsonResponse(500, {})],
    ["network", new TypeError("down")],
    ["hang", "hang"],
    ["an unreadable body", new Response("{", { status: 200 })],
    ["an allow for another workspace", allowFor(JWT_A, { scope: { app: "postona", feature: "consult", brand_slug: OTHER_BRAND } })],
  ];
  for (const [label, recheck] of cases) {
    const w = world();
    w.g5.script = [undefined, recheck];
    assert.equal(code(await w.run(JWT_A)), "AUTH_REVOKED_BEFORE_SEND", label);
    assert.deepEqual([w.provider.calls.length, w.supabase.count("reserve"), w.supabase.count("release"), w.supabase.count("mark_sent"), w.supabase.count("settle")], [0, 1, 1, 0, 0], label);
    assert.deepEqual([...w.supabase.reservations.values()], ["released"], label);
    assert.deepEqual(w.g5.calls.map((c) => c.jwt), [JWT_A, JWT_A], `${label}: the recheck carries the same JWT`);
    const again = await w.run(JWT_A);
    assert.equal(code(again), "NOT_SENT", `${label}: replay`);
    assert.deepEqual([w.provider.calls.length, w.supabase.count("reserve")], [0, 1], `${label}: no second reservation`);
  }
});

Deno.test("retries and duplicates never charge twice: the same operation id replays its stored answer; parallel duplicates send once; a lost provider answer is UNKNOWN at the upper bound, stored, and its retry replays UNKNOWN, never resent", async () => {
  const w = world();
  assert.equal(code(await w.run(JWT_A)), "OK");
  const replay = await w.run(JWT_A);
  assert.equal(code(replay), "OK");
  assert.deepEqual([w.provider.calls.length, w.supabase.count("reserve"), w.supabase.count("mark_sent"), w.supabase.count("settle")], [1, 1, 1, 1], "replayed, not resent");

  const p = world();
  const pair = await Promise.all([p.run(JWT_A), p.run(JWT_A)]);
  assert.deepEqual(pair.map(code).sort(), ["IN_PROGRESS", "OK"]);
  assert.deepEqual([p.provider.calls.length, p.supabase.count("reserve")], [1, 1]);

  const lost = world({ respond: () => jsonResponse(504, {}) });
  assert.equal(code(await lost.run(JWT_A)), "UNKNOWN");
  assert.equal(code(await lost.run(JWT_A)), "UNKNOWN", "the stored UNKNOWN is replayed");
  assert.deepEqual([lost.provider.calls.length, lost.supabase.count("reserve"), lost.supabase.count("mark_sent")], [1, 1, 1], "one attempt, never resent");
  assert.deepEqual([...lost.supabase.reservations.values()], ["unknown"], "settled as unknown at the upper bound");

  // Another person, or the same person in another workspace, with the same operation id is another call (no replay of A's answer).
  const x = world();
  assert.equal(code(await x.run(JWT_A)), "OK");
  assert.equal(code(await x.run(JWT_B)), "OK");
  assert.deepEqual([x.provider.calls.length, x.supabase.rows.size], [2, 2]);
});

Deno.test("KNOWN GAP 1 (pinned, not a guarantee): R1 v1 carries no anonymity field, so an allow G5 issues for an anonymous principal is sent; closing it is G5's (D1 strict claims, PR #486 / #488)", async () => {
  // The wire G5's R1 would return today for an anonymous JWT that the D1 hole lets through: indistinguishable from any allow.
  const w = world();
  w.g5.script = [allowFor(JWT_A), allowFor(JWT_A)];
  assert.equal(code(await w.run(JWT_A)), "OK");
  assert.equal(w.provider.calls.length, 1, "KNOWN GAP: G6 cannot refuse what the v1 wire does not say");
  // What G6 does guarantee: a wire that tries to SAY it (an extra key) is not v1 and is refused (AUTH_UNAVAILABLE, nothing sent).
  const v = world();
  v.g5.script = [allowFor(JWT_A, { is_anonymous: true })];
  assert.deepEqual([code(await v.run(JWT_A)), ...v.untouched()], ["AUTH_UNAVAILABLE", 0, 0]);
});

Deno.test("KNOWN GAP 2 (pinned, not a guarantee): the gateway's held check still reads 'busy' from ai_calls_claim; a row forgotten and re-claimed by another process between reserve and the send is not seen and this process sends; the fix is the owner-held RPC (ai_calls_claim_held, PR #409..#431), whose wiring is NO_GO", async () => {
  const w = world();
  let replaced = false;
  w.supabase.onSecondClaim = (key) => {
    if (replaced) return;
    replaced = true; // recovery closed A's row, forget_user deleted it, process B claimed the same key
    const row = w.supabase.rows.get(key)!;
    w.supabase.rows.set(key, { ...row, owner: crypto.randomUUID(), state: "acquired" });
  };
  assert.equal(code(await w.run(JWT_A)), "OK");
  assert.deepEqual([replaced, w.provider.calls.length], [true, 1], "KNOWN GAP: 'busy' is not proof of ownership (G6-08 R1)");
});
