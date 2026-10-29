// G6-20 (2026-10-28): the owner-held ledger (createAiGateway's DEFAULT since G6-20) in G6-18's exact interleavings, OFFLINE.
// Two or three REAL gateways (createAiGateway -> shared execute -> SupabaseLedgerBudgetGuard bound to each claim) share
// the in-memory model of common_ai_gateway_owner_held_fake.ts (the SQL's semantics; the real SQL is proven in
// common_ai_gateway_owner_held_ledger_pg_test.ts). G6-18's KNOWN GAPS S2 / S3 / S5 / S8b are expected SAFE here; the
// legacy mode keeps them (common_ai_gateway_busy_aba_offline_test.ts pins that). No network, no DB, fake keys.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY supabase/tests/common_ai_gateway_owner_held_offline_test.ts
import assert from "node:assert/strict";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import { buildAppPolicySet, type FeatureContent } from "../functions/_shared/ai_gateway/app_policies.ts";
import { type AuthorityPort, type AuthVerdict, gatewayExecute } from "../functions/_shared/ai_gateway/gateway.ts";
import { AiGatewayConfigError, createAiGateway } from "../functions/_shared/ai_gateway/runtime.ts";
import { OwnerHeldModel } from "./common_ai_gateway_owner_held_fake.ts";

const SUPABASE = "http://127.0.0.1:54321";
const SERVICE_KEY = "local-g6-20-service-NOT-A-SECRET";
const USER = "11111111-1111-4111-8111-111111111111";
const BRAND = { app: "postona" as const, slug: "u_ae343f5caedb67d4af33fc7a" };
const content: FeatureContent = {
  systemInstructions: "Test instructions; answer JSON { reply }.",
  schema: { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } },
  validate: (p) => typeof (p as { reply?: unknown })?.reply === "string",
};
const SET = buildAppPolicySet({
  "postona:consult": {
    enabled: true, revision: "test-r1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 300, timeoutMs: 20_000,
    maxAttempts: 1, maxCostUsdPerOperation: 0.05, maxInputBytes: 8_000, entitlements: ["postona:x_autopost"],
  },
}, { "postona:consult": content });
const ALLOW: AuthorityPort = {
  verdict: () => Promise.resolve({ decision: "allow", subject: { kind: "user", app: "postona", userId: USER, brand: BRAND }, generation: "g", expiresAtMs: Date.now() + 60_000 } as AuthVerdict),
  recheck: (prior) => Promise.resolve(prior),
};

type Proc = "A" | "B" | "C";
function world(respond?: () => Response) {
  const model = new OwnerHeldModel();
  const sendsOf = {} as Record<Proc, () => number>;
  const runOf = {} as Record<Proc, () => Promise<{ ok: boolean; code?: string }>>;
  for (const proc of ["A", "B", "C"] as Proc[]) {
    const provider = recordingFetch(() => respond?.() ?? jsonResponse(200, openAiBody({ reply: `from ${proc}` }, { model: "gpt-6-luna" })));
    // The runtime's default ledger mode (owner_held): no ledgerMode option is passed.
    const gateway = createAiGateway({
      supabaseUrl: SUPABASE,
      serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY),
      readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
      authority: ALLOW,
      policies: SET.registry,
      fetch: (input, init) => (String(input).startsWith(SUPABASE) ? model.fetchFor(proc)(input, init) : provider.fetch(input, init)),
      retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    runOf[proc] = () => gateway.execute("credential", { app: "postona", feature: "consult", operationId: "op-g6-20-0001", input: "相談", brand: BRAND });
    sendsOf[proc] = () => provider.calls.length;
  }
  const code = (r: { ok: boolean; code?: string }) => (r.ok ? "OK" : r.code);
  const sends = () => ({ A: sendsOf.A(), B: sendsOf.B(), C: sendsOf.C() });
  const total = () => sendsOf.A() + sendsOf.B() + sendsOf.C();
  return { model, A: runOf.A, B: runOf.B, C: runOf.C, code, sends, total };
}

/** A stalls right before its reserve; recovery closes and forgets its row; B claims the key anew. */
async function staleA(w: ReturnType<typeof world>) {
  const gate = w.model.pause("A", "ai_calls_reserve_held");
  const a = w.A();
  await gate.arrived;
  const key = w.model.onlyKey();
  assert.deepEqual([w.model.abandon(key), w.model.forget(key)], ["ABANDONED", "DELETED"]);
  return { a, gate, key };
}

Deno.test("owner path: one claim, reserve_held, mark_sent_held, settle, complete — no busy re-claim; the attempt recorded for its claim", async () => {
  const w = world();
  assert.equal(w.code(await w.A()), "OK");
  assert.deepEqual(w.model.calls("A"), ["ai_calls_claim", "ai_calls_reserve_held", "ai_calls_mark_sent_held", "ai_ledger_settle", "ai_calls_complete"]);
  assert.deepEqual([w.total(), w.model.statuses(), w.model.attemptOwners.size], [1, ["settled"], 1]);
});

Deno.test("SAFE S2 (was KNOWN GAP): stale A resumes after B reserved, before B's mark_sent -> A is refused at reserve_held (never touches B's reservation); B sends ONCE and gets OK", async () => {
  const w = world();
  const { a, gate } = await staleA(w);
  const gb = w.model.pause("B", "ai_calls_mark_sent_held");
  const b = w.B();
  await gb.arrived;
  gate.release();
  assert.equal(w.code(await a), "UNKNOWN");
  gb.release();
  assert.equal(w.code(await b), "OK");
  assert.deepEqual([w.sends(), w.model.statuses()], [{ A: 0, B: 1, C: 0 }, ["settled"]]);
  assert.ok(w.model.log.some((l) => l.startsWith("A ai_calls_reserve_held") && l.includes('"held":false') && l.includes("OWNER_MISMATCH")));
  assert.ok(!w.model.calls("A").includes("ai_calls_release_held"), "A releases nothing");
});

Deno.test("SAFE S3 (was KNOWN GAP): stale A resumes before B reserves -> A is refused at reserve_held (no reservation made); B reserves attempt 1 fresh, sends ONCE, OK", async () => {
  const w = world();
  const { a, gate } = await staleA(w);
  const gb = w.model.pause("B", "ai_calls_reserve_held");
  const b = w.B();
  await gb.arrived;
  gate.release();
  assert.equal(w.code(await a), "UNKNOWN");
  assert.deepEqual(w.model.statuses(), [], "A made no reservation");
  gb.release();
  assert.equal(w.code(await b), "OK");
  assert.deepEqual([w.sends(), w.model.statuses()], [{ A: 0, B: 1, C: 0 }, ["settled"]]);
});

Deno.test("SAFE S5 (was KNOWN GAP): the row was forgotten and nobody re-claimed it -> stale A is refused (NOT_FOUND) and the erased row is NOT re-created; nothing sent or reserved", async () => {
  const w = world();
  const { a, gate, key } = await staleA(w);
  gate.release();
  assert.equal(w.code(await a), "UNKNOWN");
  assert.deepEqual([w.total(), w.model.statuses(), w.model.rows.has(key)], [0, [], false]);
});

Deno.test("SAFE S8b (was KNOWN GAP, both modes): recovery on a snapshot older than the reservation closes the row AFTER A's reserve and B re-claims -> the send permit itself checks ownership: A gets none (its own reservation released), B's reserve meets A's open attempt of another claim (ATTEMPT_OWNER_MISMATCH -> UNKNOWN); nobody sends", async () => {
  const w = world();
  const ga = w.model.pause("A", "ai_calls_mark_sent_held");
  const a = w.A();
  await ga.arrived;
  const key = w.model.onlyKey();
  assert.deepEqual([w.model.abandon(key, true), w.model.forget(key)], ["ABANDONED", "DELETED"]);
  const b = w.B();
  assert.equal(w.code(await b), "UNKNOWN", "B: the attempt is another claim's");
  ga.release();
  assert.equal(w.code(await a), "UNKNOWN", "A: no permit for a row it no longer owns");
  assert.deepEqual([w.sends(), w.model.statuses()], [{ A: 0, B: 0, C: 0 }, ["released"]]);
});

Deno.test("SAFE as before: B finished first (A meets a finalized attempt), the same operation retried while A is stalled (IN_PROGRESS), a READ COMMITTED recovery after A's reserve (refused), a lost provider answer (UNKNOWN, stored, never resent)", async () => {
  const done = world();
  const { a, gate } = await staleA(done);
  assert.equal(done.code(await done.B()), "OK");
  gate.release();
  assert.equal(done.code(await a), "UNKNOWN");
  assert.deepEqual(done.sends(), { A: 0, B: 1, C: 0 });

  const retry = world();
  const g = retry.model.pause("A", "ai_calls_reserve_held");
  const ra = retry.A();
  await g.arrived;
  assert.equal(retry.code(await retry.C()), "IN_PROGRESS");
  g.release();
  assert.equal(retry.code(await ra), "OK");
  assert.equal(retry.total(), 1);

  const late = world();
  const gl = late.model.pause("A", "ai_calls_mark_sent_held");
  const la = late.A();
  await gl.arrived;
  const key = late.model.onlyKey();
  assert.deepEqual([late.model.abandon(key), late.model.forget(key)], ["REFUSED_OPEN_ATTEMPT", "REFUSED_ACQUIRED"]);
  gl.release();
  assert.equal(late.code(await la), "OK");

  const lost = world(() => jsonResponse(504, {}));
  assert.equal(lost.code(await lost.A()), "UNKNOWN");
  assert.equal(lost.code(await lost.A()), "UNKNOWN");
  assert.deepEqual([lost.total(), lost.model.statuses()], [1, ["unknown"]]);
});

Deno.test("fail closed: the candidate not applied (404), a lost or failing reserve_held / mark_sent_held, a release_held that fails -> nothing sent; a lost reserve leaves the hold for the ledger's recovery; a lost permit leaves it 'sent' for recovery (counted, never resent)", async () => {
  const cases: Array<[string, (m: OwnerHeldModel) => void, string[]]> = [
    ["reserve_held missing (404)", (m) => m.missing.add("ai_calls_reserve_held"), []],
    ["mark_sent_held missing (404): its own hold is released", (m) => m.missing.add("ai_calls_mark_sent_held"), ["released"]],
    ["reserve_held lost", (m) => m.faults.set("ai_calls_reserve_held#1", "lost"), ["reserved"]],
    ["reserve_held 500", (m) => m.faults.set("ai_calls_reserve_held#1", 500), []],
    ["mark_sent_held lost", (m) => m.faults.set("ai_calls_mark_sent_held#1", "lost"), ["sent"]],
    ["mark_sent_held network", (m) => m.faults.set("ai_calls_mark_sent_held#1", "network"), ["released"]],
  ];
  for (const [label, setup, statuses] of cases) {
    const w = world();
    setup(w.model);
    assert.equal(w.code(await w.A()), "UNKNOWN", label);
    assert.deepEqual([w.total(), w.model.statuses()], [0, statuses], label);
  }
});

Deno.test("configuration: no ledger mode at gatewayExecute (neither the owner-held ledger nor the explicit legacy flag) refuses before G5 is asked; an unknown runtime ledgerMode is a configuration error", async () => {
  let asked = 0;
  const authority: AuthorityPort = { verdict: () => { asked++; return ALLOW.verdict(null, { app: "postona", feature: "consult", brand: BRAND }); }, recheck: ALLOW.recheck };
  const r = await gatewayExecute({ authority, policies: SET.registry, provider: { readEnv: () => undefined }, store: { claim: () => Promise.reject(new Error("never")), complete: () => Promise.reject(new Error("never")) } },
    "credential", { app: "postona", feature: "consult", operationId: "op-g6-20-0001", input: "x", brand: BRAND });
  assert.deepEqual([r.ok, (r as { code: string }).code, asked], [false, "LEDGER_UNAVAILABLE", 0]);
  assert.throws(() =>
    createAiGateway({
      supabaseUrl: SUPABASE, serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY), readEnv: () => undefined, authority: ALLOW, policies: SET.registry,
      ledgerMode: "busy" as never,
    }), (e: unknown) => e instanceof AiGatewayConfigError);
});
