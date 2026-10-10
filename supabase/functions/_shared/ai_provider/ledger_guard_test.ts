// SupabaseLedgerBudgetGuard against a fake PostgREST, and executeAiRequest with it (Phase 1b, required tests 16-19,
// 29, 30 on the TypeScript side): exact RPC payloads, the send happens only after mark_sent, RPC failures never lead
// to a send, settlement details, and no key or payload in errors. The real SQL behaviour is proven separately by
// supabase/tests/ai_provider_budget_ledger_run.sh.
import assert from "node:assert/strict";
import test from "node:test";
import { executeAiRequest } from "./execute.ts";
import { LedgerRpcError, SupabaseLedgerBudgetGuard } from "./ledger_guard.ts";
import { resolveSecret } from "./secrets.ts";
import { anthropicBody, anthropicError, jsonResponse, recordingFetch, type RecordedCall, sampleRequest, testDeps, VALID_PAYLOAD } from "./test_support.ts";

const SERVICE_KEY = "test-service-key-NOT-REAL-00000000";
const BASE = "https://project-ref.supabase.co";
const RESERVATION = "11111111-1111-4111-8111-111111111111";
const USER = "00000000-0000-4000-8000-00000000000a";
const BRAND = "00000000-0000-4000-8000-0000000000b1";

type RpcHandler = (name: string, p: Record<string, unknown>) => Response | Promise<Response>;

function ledger(handler: RpcHandler) {
  const recorder = recordingFetch((call) => {
    const name = call.url.slice(`${BASE}/rest/v1/rpc/`.length);
    return handler(name, (call.body as { p: Record<string, unknown> }).p);
  });
  const secret = resolveSecret("SUPABASE_SERVICE_ROLE_KEY", () => SERVICE_KEY);
  assert.ok(secret.ok);
  const guard = new SupabaseLedgerBudgetGuard({ supabaseUrl: BASE, serviceKey: secret.value, fetch: recorder.fetch });
  return { guard, calls: recorder.calls, rpcNames: () => recorder.calls.map((call) => call.url.split("/").pop()) };
}

const okLedger: RpcHandler = (name) => {
  if (name === "ai_ledger_reserve") return jsonResponse(200, { allowed: true, reservation_id: RESERVATION, status: "reserved", reused: false, level: "ok" });
  if (name === "ai_ledger_mark_sent") return jsonResponse(200, { status: "sent", may_send: true });
  if (name === "ai_ledger_settle") return jsonResponse(200, { status: "settled", usage_event_id: 1, duplicate: false });
  if (name === "ai_ledger_release") return jsonResponse(200, { status: "released" });
  return jsonResponse(404, { code: "PGRST202" });
};

test("reserve: exact RPC payload, service-key headers, user subject with brand", async () => {
  const { guard, calls } = ledger(okLedger);
  const decision = await guard.reserve({
    provider: "openai", model: "gpt-6-luna", application: "postona", feature: "consult", logicalRole: "postona.consult",
    callId: "call-1", attempt: 2, subject: { kind: "user", userId: USER, brandId: BRAND },
  }, 0.0123456789);
  assert.deepEqual(decision, { allowed: true, reservation: { id: RESERVATION, limitIds: [], reservedUsd: 0.01234568 } });
  const call: RecordedCall = calls[0];
  assert.equal(call.url, `${BASE}/rest/v1/rpc/ai_ledger_reserve`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers.get("apikey"), SERVICE_KEY);
  assert.equal(call.headers.get("authorization"), `Bearer ${SERVICE_KEY}`);
  assert.deepEqual(call.body, {
    p: {
      request_id: "call-1", attempt: 2, provider: "openai", model: "gpt-6-luna", application: "postona", feature: "consult",
      logical_role: "postona.consult", subject_kind: "user", user_id: USER, brand_id: BRAND, amount_usd: 0.01234568, hold_seconds: 900,
    },
  });
});

test("reserve: denials map to the guard's reasons; missing call id is refused before any RPC", async () => {
  for (const [db, mapped] of [["NO_MATCHING_POLICY", "NO_MATCHING_LIMIT"], ["CALL_LIMIT", "CALL_LIMIT"], ["COST_LIMIT", "COST_LIMIT"], ["PER_CALL_LIMIT", "PER_CALL_LIMIT"], ["ATTEMPT_FINALIZED", "ATTEMPT_FINALIZED"], ["ATTEMPT_IN_FLIGHT", "SEND_NOT_CONFIRMED"], ["SOMETHING_NEW", "GUARD_UNAVAILABLE"]]) {
    const { guard } = ledger(() => jsonResponse(200, { allowed: false, reason: db, policy_key: "postona.per_brand" }));
    const decision = await guard.reserve({ provider: "openai", model: "m", application: "a", feature: "f", logicalRole: "r", callId: "c", attempt: 1 }, 0.1);
    assert.deepEqual(decision, { allowed: false, reason: mapped, limitId: "postona.per_brand" });
  }
  const { guard, calls } = ledger(okLedger);
  await assert.rejects(() => guard.reserve({ provider: "openai", model: "m", application: "a", feature: "f", logicalRole: "r" }, 0.1), /AI_LEDGER_CONTEXT_INCOMPLETE/);
  assert.equal(calls.length, 0);
});

test("18./19. RPC failures throw a sanitised error: no key, no body, no payload", async () => {
  const leaky = ledger(() => jsonResponse(500, { code: "XX000", message: `internal ${SERVICE_KEY} SENTINEL-PAYLOAD` }));
  await assert.rejects(
    () => leaky.guard.reserve({ provider: "openai", model: "m", application: "a", feature: "f", logicalRole: "r", callId: "c", attempt: 1 }, 0.1),
    (error: unknown) => {
      assert.ok(error instanceof LedgerRpcError);
      assert.equal(error.message, "AI_LEDGER_RPC_FAILED:ai_ledger_reserve:500:XX000");
      assert.ok(!error.message.includes(SERVICE_KEY) && !error.message.includes("SENTINEL"));
      return true;
    },
  );
  const offline = ledger(() => Promise.reject(new TypeError("connection refused")));
  await assert.rejects(() => offline.guard.markSent({ id: RESERVATION, limitIds: [], reservedUsd: 0.1 }), /AI_LEDGER_RPC_FAILED:ai_ledger_mark_sent:network/);
  const refused = ledger(() => jsonResponse(200, { status: "released", may_send: false }));
  await assert.rejects(() => refused.guard.markSent({ id: RESERVATION, limitIds: [], reservedUsd: 0.1 }), /AI_LEDGER_SEND_NOT_ALLOWED:released/);
  const secret = resolveSecret("X", () => SERVICE_KEY);
  assert.ok(secret.ok);
  assert.throws(() => new SupabaseLedgerBudgetGuard({ supabaseUrl: "http://example.com", serviceKey: secret.value }), /AI_LEDGER_URL_NOT_HTTPS/);
});

test("1./29. executeAiRequest with the ledger guard: reserve -> mark_sent -> provider -> settle with full details", async () => {
  const order: string[] = [];
  const settles: Record<string, unknown>[] = [];
  const { guard } = ledger((name, p) => {
    order.push(name);
    if (name === "ai_ledger_settle") settles.push(p);
    return okLedger(name, p);
  });
  const provider = recordingFetch(() => {
    order.push("provider");
    return jsonResponse(200, anthropicBody(VALID_PAYLOAD, { usage: { input_tokens: 700, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 400, output_tokens_details: { thinking_tokens: 150 } } }), { "request-id": "req_anthropic_1" });
  });
  const request = sampleRequest("anthropic", { callId: "market-report-2026-10-10-close", usageContext: { application: "kabumori", feature: "market_report" } });
  const result = await executeAiRequest(request, testDeps(provider.fetch, { budget: guard }).deps);
  assert.ok(result.ok);
  assert.equal(result.callId, "market-report-2026-10-10-close");
  assert.deepEqual(order, ["ai_ledger_reserve", "ai_ledger_mark_sent", "provider", "ai_ledger_settle"]);
  assert.deepEqual(settles[0], {
    reservation_id: RESERVATION,
    outcome: "succeeded",
    cost_basis: "measured",
    estimated_cost_usd: (700 * 4 + 100 * 0.2 + 400 * 20) / 1_000_000,
    price_catalog_version: "ai-provider-catalog/2026-10-10.1",
    latency_ms: 0,
    input_tokens: 800,
    cache_read_input_tokens: 100,
    cache_write_5m_input_tokens: 0,
    cache_write_1h_input_tokens: 0,
    output_tokens: 400,
    reasoning_output_tokens: 150,
    actual_model: "claude-opus-5-5",
    provider_request_id: "req_anthropic_1",
    http_status: 200,
  });
});

test("19. no send when mark_sent refuses or fails; the unsent reservation is released", async () => {
  for (const markSent of [() => jsonResponse(200, { status: "released", may_send: false }), () => jsonResponse(503, { code: "PGRST000" })]) {
    const order: string[] = [];
    const { guard } = ledger((name, p) => {
      order.push(name);
      return name === "ai_ledger_mark_sent" ? markSent() : okLedger(name, p);
    });
    const provider = recordingFetch(() => jsonResponse(200, anthropicBody(VALID_PAYLOAD)));
    const result = await executeAiRequest(sampleRequest("anthropic"), testDeps(provider.fetch, { budget: guard }).deps);
    assert.ok(!result.ok);
    assert.deepEqual([result.errorCode, result.detail, result.costBasis, result.transportAttempts], ["BUDGET_DENIED", "SEND_NOT_CONFIRMED", "no_request", 0]);
    assert.equal(provider.calls.length, 0, "the provider was never called");
    assert.deepEqual(order, ["ai_ledger_reserve", "ai_ledger_mark_sent", "ai_ledger_release"]);
  }
});

test("19. reserve failure: nothing is sent", async () => {
  const { guard } = ledger(() => jsonResponse(500, { code: "XX000" }));
  const provider = recordingFetch(() => jsonResponse(200, anthropicBody(VALID_PAYLOAD)));
  const result = await executeAiRequest(sampleRequest("anthropic"), testDeps(provider.fetch, { budget: guard }).deps);
  assert.ok(!result.ok && result.errorCode === "BUDGET_DENIED" && result.detail === "GUARD_UNAVAILABLE");
  assert.equal(provider.calls.length, 0);
});

test("16./17./18. failures are settled with their outcome; a settle failure does not change the result", async () => {
  const settles: Record<string, unknown>[] = [];
  const { guard } = ledger((name, p) => {
    if (name === "ai_ledger_settle") settles.push(p);
    return okLedger(name, p);
  });
  const refusal = recordingFetch(() => jsonResponse(200, anthropicBody(null, { stopReason: "refusal", text: "" })));
  await executeAiRequest(sampleRequest("anthropic"), testDeps(refusal.fetch, { budget: guard }).deps);
  assert.deepEqual([settles[0].outcome, settles[0].cost_basis, settles[0].error_code], ["failed", "measured", "REFUSAL"]);
  const credit = recordingFetch(() => jsonResponse(400, anthropicError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.")));
  await executeAiRequest(sampleRequest("anthropic"), testDeps(credit.fetch, { budget: guard }).deps);
  assert.deepEqual([settles[1].outcome, settles[1].cost_basis, settles[1].error_code, settles[1].input_tokens, settles[1].estimated_cost_usd], ["failed", "measured", "CREDIT_EXHAUSTED", 0, 0]);
  const network = recordingFetch(() => Promise.reject(new TypeError("reset")));
  await executeAiRequest(sampleRequest("anthropic", { transport: { maxAttempts: 1 } }), testDeps(network.fetch, { budget: guard }).deps);
  assert.deepEqual([settles[2].outcome, settles[2].cost_basis, settles[2].error_code, settles[2].input_tokens], ["unknown", "upper_bound", "NETWORK", undefined]);

  const broken = ledger((name, p) => (name === "ai_ledger_settle" ? jsonResponse(500, { code: "XX000" }) : okLedger(name, p)));
  const provider = recordingFetch(() => jsonResponse(200, anthropicBody(VALID_PAYLOAD)));
  const result = await executeAiRequest(sampleRequest("anthropic"), testDeps(provider.fetch, { budget: broken.guard }).deps);
  assert.ok(result.ok, "the answer is still returned; the ledger recovery finalises the attempt at its upper bound");
});

test("30. ledger payloads carry identifiers and counts only: no prompt, output or provider key", async () => {
  const bodies: string[] = [];
  const { guard } = ledger((name, p) => {
    bodies.push(JSON.stringify(p));
    return okLedger(name, p);
  });
  const provider = recordingFetch(() => jsonResponse(200, anthropicBody({ ...VALID_PAYLOAD, title: "OUTPUT-SENTINEL" })));
  await executeAiRequest(
    sampleRequest("anthropic", { systemInstructions: "PROMPT-SENTINEL", userContent: "PROMPT-SENTINEL", usageContext: { application: "postona", feature: "consult", subject: { kind: "user", userId: USER } } }),
    testDeps(provider.fetch, { budget: guard }).deps,
  );
  const all = bodies.join("\n");
  for (const sentinel of ["PROMPT-SENTINEL", "OUTPUT-SENTINEL", "test-anthropic-key", SERVICE_KEY]) assert.ok(!all.includes(sentinel), sentinel);
});

test("subject and callId are validated before any RPC", async () => {
  const { guard, calls } = ledger(okLedger);
  const provider = recordingFetch(() => jsonResponse(200, anthropicBody(VALID_PAYLOAD)));
  for (const usageContext of [
    { application: "postona", feature: "consult", subject: { kind: "user", userId: "not-a-uuid" } },
    { application: "postona", feature: "consult", subject: { kind: "system", userId: USER } },
    { application: "postona", feature: "consult", subject: { kind: "user", userId: USER, brandId: "x" } },
  ]) {
    const result = await executeAiRequest(sampleRequest("anthropic", { usageContext: usageContext as never }), testDeps(provider.fetch, { budget: guard }).deps);
    assert.ok(!result.ok && result.errorCode === "REQUEST_INVALID" && result.detail === "usageContext.subject");
  }
  const badCall = await executeAiRequest(sampleRequest("anthropic", { callId: "has space" }), testDeps(provider.fetch, { budget: guard }).deps);
  assert.ok(!badCall.ok && badCall.detail === "callId");
  assert.equal(calls.length, 0);
  assert.equal(provider.calls.length, 0);
});
