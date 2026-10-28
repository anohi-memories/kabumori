// G6-19 (2026-10-25): more OFFLINE fail-closed negatives for the G5 R1 v1 verdict as the gateway reads it today, on top
// of G6-17 (common_ai_gateway_r1_v1_consumer_contract_test.ts) and G6-18 (common_ai_gateway_busy_aba_offline_test.ts).
// The REAL G6 code end to end (createG5RpcTransport -> createG5AuthorityPort -> createAiGateway -> shared execute, ledger
// guard, call store) against fakes: a PostgREST stand-in for G5's proposed RPC (G5's own v1 samples), an in-memory call
// store and a ledger that follows the SQL's documented semantics (one reservation per (request_id, attempt), an unsent one
// is REUSED, mark_sent once, release only reserved), fake providers. No network, no DB, fake keys, no real JWT.
// What is new here: reason tokens, clocks (expired / issued in the future), owner epoch rollback, the recheck before EVERY
// attempt of a retried call, the same operation in another workspace, revoked concurrent duplicates, lost answers at
// the verdict for duplicates. Only guarantees are asserted; the three KNOWN GAPS stay pinned where G6-17 / G6-18 pinned
// them (anonymous allow; busy-check ABA; ledger attempts not bound to the claim owner) and are not re-counted as PASS.
// G5's final IF (personal workspace, session verdict, v2) is not assumed. Write-up: docs/ai-provider/G6_R1_V1_FAILCLOSED_EXTENSION.md.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY --allow-read=supabase/tests/fixtures \
//     supabase/tests/common_ai_gateway_r1_v1_failclosed_extension_test.ts
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import { buildAppPolicySet, type FeatureContent } from "../ai_gateway/app_policies.ts";
import { createG5AuthorityPort } from "../ai_gateway/authority_port.ts";
import { createG5RpcTransport } from "../ai_gateway/g5_rpc_transport.ts";
import { createAiGateway } from "../ai_gateway/runtime.ts";

type Sample = { name: string; scope: { brand_slug: string | null }; rpc_wire: Record<string, unknown> };
const SAMPLES = (JSON.parse(await Deno.readTextFile(new URL("./fixtures/g5_verdict_v1_rpc_samples.json", import.meta.url))) as { samples: Sample[] }).samples;
const ALLOW = SAMPLES.find((s) => s.name === "allow consult")!;

const SUPABASE = "http://127.0.0.1:54321";
const PUBLISHABLE = "local-g6-19-publishable-NOT-A-SECRET";
const SERVICE_KEY = "local-g6-19-service-NOT-A-SECRET";
const JWT = "eyG6C.payloadNOTREAL.signatureNOTREAL"; // JWT-shaped, not a token
const BRAND = String(ALLOW.scope.brand_slug);
const BRAND_2 = "u_0b1c2d3e4f5061728394a5b6";
const content: FeatureContent = {
  systemInstructions: "Test instructions; answer JSON { reply }.",
  schema: { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } },
  validate: (p) => typeof (p as { reply?: unknown })?.reply === "string",
};
const policySet = (maxAttempts: number) =>
  buildAppPolicySet({
    "postona:consult": {
      enabled: true, revision: "test-r1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 300, timeoutMs: 20_000,
      maxAttempts, maxCostUsdPerOperation: 0.2, maxInputBytes: 8_000, entitlements: ["postona:x_autopost"],
    },
  }, { "postona:consult": content });

/** G5's v1 allow (8 keys, no times) from G5's own sample, for a workspace, with overrides. */
function allow(over: Record<string, unknown> = {}, brand = BRAND): Record<string, unknown> {
  const w = structuredClone(ALLOW.rpc_wire);
  w.scope = { app: "postona", feature: "consult", brand_slug: brand };
  return { ...w, ...over };
}

type Answer = Response | Error | "hang" | Record<string, unknown>;
class FakeG5Rpc {
  calls = 0;
  script: Array<Answer | undefined> = [];
  /** Default answer when the script has nothing for this call. */
  fallback: (body: { p_brand_id: string | null }) => Answer = (b) => allow({}, b.p_brand_id ?? BRAND);
  readonly fetch: FetchLike = async (_input, init) => {
    const a = this.script[this.calls++] ?? this.fallback(JSON.parse(String(init?.body)));
    if (a === "hang") return await new Promise<Response>(() => {});
    if (a instanceof Error) throw a;
    return a instanceof Response ? a : jsonResponse(200, a);
  };
}

/** Call store + ledger with the SQL's documented semantics (see the header). */
class FakeSupabase {
  calls: string[] = [];
  rows = new Map<string, { identity: string; owner: string; state: "acquired" | "complete"; result: unknown }>();
  reservations = new Map<string, { key: string; status: string }>();
  private n = 0;
  // deno-lint-ignore require-await
  readonly fetch: FetchLike = async (input, init) => {
    const name = new URL(String(input)).pathname.replace("/rest/v1/rpc/", "");
    const p = (JSON.parse(String(init?.body)) as { p: Record<string, unknown> }).p;
    this.calls.push(name.replace(/^ai_(ledger|calls)_/u, ""));
    const [status, body] = this.answer(name, p);
    return jsonResponse(status, body);
  };
  count = (name: string) => this.calls.filter((c) => c === name).length;
  statuses = () => [...this.reservations.values()].map((r) => `${r.key.split("#")[1]}:${r.status}`);
  private answer(name: string, p: Record<string, unknown>): [number, unknown] {
    switch (name) {
      case "ai_calls_claim": {
        const key = String(p.call_key);
        const identity = JSON.stringify([p.tenant_tag, p.fingerprint, p.application, p.feature, p.subject_kind, p.user_id ?? null]);
        const row = this.rows.get(key);
        if (!row) {
          const owner = crypto.randomUUID();
          this.rows.set(key, { identity, owner, state: "acquired", result: null });
          return [200, { kind: "acquired", owner }];
        }
        if (row.identity !== identity) return [200, { kind: "conflict" }];
        return [200, row.state === "acquired" ? { kind: "busy" } : { kind: "complete", fingerprint: p.fingerprint, result: row.result }];
      }
      case "ai_calls_complete": {
        const row = this.rows.get(String(p.call_key));
        if (!row || row.owner !== p.owner || row.state !== "acquired") return [400, { code: "P0001" }];
        row.state = "complete";
        row.result = structuredClone(p.result);
        return [200, { state: "complete", duplicate: false }];
      }
      case "ai_ledger_reserve": {
        const key = `${p.request_id}#${p.attempt}`;
        const found = [...this.reservations.entries()].find(([, r]) => r.key === key);
        if (found) {
          const [id, r] = found;
          if (r.status === "reserved") return [200, { allowed: true, reservation_id: id, status: "reserved", reused: true }];
          return [200, { allowed: false, reservation_id: id, status: r.status, reused: true, reason: r.status === "sent" ? "ATTEMPT_IN_FLIGHT" : "ATTEMPT_FINALIZED" }];
        }
        const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
        this.reservations.set(id, { key, status: "reserved" });
        return [200, { allowed: true, reservation_id: id, status: "reserved", reused: false }];
      }
      case "ai_ledger_mark_sent": {
        const r = this.reservations.get(String(p.reservation_id))!;
        if (r.status !== "reserved") return [200, { status: r.status, may_send: false }];
        r.status = "sent";
        return [200, { status: "sent", may_send: true }];
      }
      case "ai_ledger_settle": {
        const r = this.reservations.get(String(p.reservation_id))!;
        r.status = p.outcome === "unknown" ? "unknown" : p.outcome === "failed" ? "failed" : "settled";
        return [200, { settled: true }];
      }
      case "ai_ledger_release": {
        const r = this.reservations.get(String(p.reservation_id))!;
        if (r.status === "reserved") r.status = "released";
        return [200, { released: true }];
      }
    }
    throw new Error(`unexpected ${name}`);
  }
}

function world(options: { maxAttempts?: number; transportNow?: () => number; respond?: (i: number) => Response } = {}) {
  const set = policySet(options.maxAttempts ?? 1);
  const g5 = new FakeG5Rpc();
  const supabase = new FakeSupabase();
  const provider = recordingFetch((_c, i) => options.respond?.(i) ?? jsonResponse(200, openAiBody({ reply: "ok" }, { model: "gpt-6-luna" })));
  const gateway = createAiGateway({
    // G6-20: this suite pins the legacy busy re-claim check; the owner-held default has its own suites.
    ledgerMode: "legacy_busy_check_unsafe",
    supabaseUrl: SUPABASE,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
    authority: createG5AuthorityPort({
      transport: createG5RpcTransport({ supabaseUrl: SUPABASE, publishableKey: PUBLISHABLE, fetch: g5.fetch, nowMs: options.transportNow }),
      planAllowlist: set.planAllowlist,
      timeoutMs: 200,
    }),
    policies: set.registry,
    fetch: (input, init) => (String(input).startsWith(SUPABASE) ? supabase.fetch(input, init) : provider.fetch(input, init)),
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  const run = (over: Record<string, unknown> = {}) =>
    gateway.execute(JWT, { app: "postona", feature: "consult", operationId: "op-g6-19-0001", input: "相談", brand: { app: "postona", slug: BRAND }, ...over });
  const untouched = () => [supabase.calls.length, provider.calls.length];
  return { g5, supabase, provider, run, untouched };
}
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "OK" : r.code);

Deno.test("reason tokens: a refusal's reason must be a token (or null) — an invalid, empty or over-long reason is not a G5 answer (AUTH_UNKNOWN); a null reason keeps the decision; nothing claimed, reserved or sent", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["deny, null reason", allow({ decision: "deny", reason: null }), "AUTH_DENIED"],
    ["pending, null reason", allow({ decision: "pending", reason: null }), "AUTH_PENDING"],
    ["unknown, null reason", allow({ decision: "unknown", reason: null }), "AUTH_UNKNOWN"],
    ["deny, a reason with a space", allow({ decision: "deny", reason: "SESSION REVOKED" }), "AUTH_UNKNOWN"],
    ["deny, an empty reason", allow({ decision: "deny", reason: "" }), "AUTH_UNKNOWN"],
    ["deny, a 65-character reason", allow({ decision: "deny", reason: "A".repeat(65) }), "AUTH_UNKNOWN"],
    ["deny, a numeric reason", allow({ decision: "deny", reason: 403 }), "AUTH_UNKNOWN"],
    ["allow, an empty reason", allow({ reason: "" }), "AUTH_UNKNOWN"],
  ];
  for (const [label, wire, want] of cases) {
    const w = world();
    w.g5.script = [wire];
    assert.equal(code(await w.run()), want, label);
    assert.deepEqual(w.untouched(), [0, 0], label);
  }
});

Deno.test("clocks: an Edge clock behind by more than G5's 60 s (the allow is already expired) is refused; one ahead by more than the 30 s skew (issued in the future) is AUTH_UNKNOWN; within the skew it goes through once", async () => {
  const cases: Array<[string, number, string, number]> = [
    ["expired: transport clock 61 s behind", -61_000, "AUTH_DENIED", 0],
    ["issued 31 s in the future", 31_000, "AUTH_UNKNOWN", 0],
    ["issued 25 s in the future (within the skew)", 25_000, "OK", 1],
    ["transport clock 30 s behind (still 30 s to live)", -30_000, "OK", 1],
  ];
  for (const [label, offset, want, sends] of cases) {
    const w = world({ transportNow: () => Date.now() + offset });
    assert.equal(code(await w.run()), want, label);
    assert.equal(w.provider.calls.length, sends, label);
    if (sends === 0) assert.deepEqual(w.untouched(), [0, 0], label);
  }
});

Deno.test("owner epoch at the recheck: a rollback (lower lifecycle or owner epoch), a jump, or the same epoch for another workspace answer -> AUTH_REVOKED_BEFORE_SEND, the reservation released, nothing sent; the identical epoch sends once", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["lifecycle rolled back g5oe:7:3", allow({ owner_epoch: "g5oe:7:3" }), "AUTH_REVOKED_BEFORE_SEND"],
    ["owner epoch rolled back g5oe:6:4", allow({ owner_epoch: "g5oe:6:4" }), "AUTH_REVOKED_BEFORE_SEND"],
    ["owner epoch jumped g5oe:70:4", allow({ owner_epoch: "g5oe:70:4" }), "AUTH_REVOKED_BEFORE_SEND"],
    ["the same epoch, answered for another workspace", allow({}, BRAND_2), "AUTH_REVOKED_BEFORE_SEND"],
    ["identical", allow(), "OK"],
  ];
  for (const [label, recheck, want] of cases) {
    const w = world();
    w.g5.script = [allow(), recheck];
    assert.equal(code(await w.run()), want, label);
    if (want === "OK") assert.deepEqual([w.provider.calls.length, w.supabase.statuses()], [1, ["1:settled"]], label);
    else assert.deepEqual([w.provider.calls.length, w.supabase.statuses(), w.supabase.count("mark_sent")], [0, ["1:released"], 0], label);
  }
});

Deno.test("a retried call rechecks before EVERY attempt: attempt 1 fails retryably (503), G5 revokes before attempt 2 -> attempt 2 released and never sent (AUTH_REVOKED_BEFORE_SEND); with G5 unchanged attempt 2 is its own reservation and the call is charged per attempt, once each", async () => {
  const revoked = world({ maxAttempts: 2, respond: (i) => (i === 0 ? jsonResponse(503, {}) : jsonResponse(200, openAiBody({ reply: "ok" }, { model: "gpt-6-luna" }))) });
  revoked.g5.script = [allow(), allow(), allow({ entitlements: [] })];
  assert.equal(code(await revoked.run()), "AUTH_REVOKED_BEFORE_SEND");
  assert.deepEqual([revoked.provider.calls.length, revoked.g5.calls, revoked.supabase.statuses()], [1, 3, ["1:failed", "2:released"]], "G5 asked: verdict + a recheck per attempt");

  const fine = world({ maxAttempts: 2, respond: (i) => (i === 0 ? jsonResponse(503, {}) : jsonResponse(200, openAiBody({ reply: "ok" }, { model: "gpt-6-luna" }))) });
  assert.equal(code(await fine.run()), "OK");
  assert.deepEqual([fine.provider.calls.length, fine.g5.calls, fine.supabase.statuses(), fine.supabase.count("mark_sent")], [2, 3, ["1:failed", "2:settled"], 2]);
  // Replaying the finished operation adds nothing.
  assert.equal(code(await fine.run()), "OK");
  assert.deepEqual([fine.provider.calls.length, fine.supabase.count("reserve")], [2, 2]);
});

Deno.test("the same person and operation id in another workspace is another call: separate claim, reservation and send; neither replays the other's answer", async () => {
  const w = world();
  assert.equal(code(await w.run()), "OK");
  assert.equal(code(await w.run({ brand: { app: "postona", slug: BRAND_2 } })), "OK");
  assert.deepEqual([w.provider.calls.length, w.supabase.rows.size, w.supabase.reservations.size], [2, 2, 2]);
  // Each replays only its own.
  assert.equal(code(await w.run()), "OK");
  assert.equal(code(await w.run({ brand: { app: "postona", slug: BRAND_2 } })), "OK");
  assert.equal(w.provider.calls.length, 2);
});

Deno.test("duplicates under refusal and loss: concurrent duplicates whose first recheck is revoked send nothing (one released reservation, the twin IN_PROGRESS or NOT_SENT, a retry NOT_SENT); duplicates while G5 is down claim nothing; a G5 that answers only one of two duplicates sends once", async () => {
  const r = world();
  r.g5.script = [allow(), allow(), allow({ session: { state: "revoked", ref: "s:x" } })];
  const pair = await Promise.all([r.run(), r.run()]);
  // The twin either meets the acquired row (IN_PROGRESS) or, if it claims after the first finished, replays its NOT_SENT.
  assert.equal(pair.map(code).filter((c) => c === "AUTH_REVOKED_BEFORE_SEND").length, 1);
  assert.ok(pair.map(code).every((c) => ["AUTH_REVOKED_BEFORE_SEND", "IN_PROGRESS", "NOT_SENT"].includes(c!)), pair.map(code).join());
  assert.equal(code(await r.run()), "NOT_SENT");
  assert.deepEqual([r.provider.calls.length, r.supabase.statuses(), r.supabase.count("reserve")], [0, ["1:released"], 1]);

  const down = world();
  down.g5.fallback = () => new TypeError("down");
  const both = await Promise.all([down.run(), down.run()]);
  assert.deepEqual(both.map(code), ["AUTH_UNAVAILABLE", "AUTH_UNAVAILABLE"]);
  assert.deepEqual(down.untouched(), [0, 0]);

  const half = world();
  half.g5.script = [allow(), "hang", allow()];
  const one = await Promise.all([half.run(), half.run()]);
  assert.deepEqual(one.map(code).sort(), ["AUTH_UNAVAILABLE", "OK"]);
  assert.deepEqual([half.provider.calls.length, half.supabase.statuses()], [1, ["1:settled"]]);
});

Deno.test("a finished operation asked again (a lost answer at the client) replays: no second reservation, mark_sent, settle or send (a reused unsent reservation is sent once: G6-18 SAFE)", async () => {
  const w = world();
  assert.equal(code(await w.run()), "OK");
  // A second gateway process with the same operation (a lost first answer at the client): replay, no second reservation.
  assert.equal(code(await w.run()), "OK");
  assert.deepEqual([w.provider.calls.length, w.supabase.count("reserve"), w.supabase.count("mark_sent"), w.supabase.count("settle"), w.supabase.statuses()], [1, 1, 1, 1, ["1:settled"]]);
});
