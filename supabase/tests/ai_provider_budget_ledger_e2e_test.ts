// End-to-end: executeAiRequest + SupabaseLedgerBudgetGuard -> PostgREST shim -> the real migration in a disposable
// PostgreSQL. The AI provider is a fake fetch (no real API). Proves that the TypeScript payloads pass the real SQL
// validation and that budgets, retries, timeouts and crash replays land in the ledger as designed.
// Run by supabase/tests/ai_provider_budget_ledger_run.sh (part "e2e"); ignored when its environment is absent.
import assert from "node:assert/strict";
import { executeAiRequest, InMemoryBudgetGuard, resolveSecret, SupabaseLedgerBudgetGuard } from "../functions/_shared/ai_provider/mod.ts";
import {
  anthropicBody,
  anthropicError,
  hangUntilAborted,
  jsonResponse,
  recordingFetch,
  sampleRequest,
  testDeps,
  VALID_PAYLOAD,
} from "../functions/_shared/ai_provider/test_support.ts";

const URL_BASE = Deno.env.get("AIL_E2E_URL");
const KEY = Deno.env.get("AIL_E2E_KEY");
const enabled = !!URL_BASE && !!KEY;
const USER = "00000000-0000-4000-8000-0000000000e1";

function guard(rpcTimeoutMs?: number) {
  const secret = resolveSecret("AIL_E2E_KEY", () => KEY);
  assert.ok(secret.ok);
  return new SupabaseLedgerBudgetGuard({ supabaseUrl: URL_BASE!, serviceKey: secret.value, rpcTimeoutMs });
}

async function budgetBucket(policyKey: string): Promise<Record<string, unknown> | undefined> {
  const rows = await rpc("ai_ledger_budget_status", {}) as Array<Record<string, unknown>>;
  return rows.find((row) => row.policy_key === policyKey);
}

/** A mock provider that answers after `delayMs` and counts every HTTP request it receives. */
function slowProvider(delayMs: number) {
  return recordingFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return jsonResponse(200, anthropicBody(VALID_PAYLOAD));
  });
}

async function rpc(name: string, p: unknown): Promise<unknown> {
  const response = await fetch(`${URL_BASE}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: KEY!, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p }),
  });
  assert.equal(response.status, 200, `${name} ${response.status}`);
  return await response.json();
}

async function summary(dimension: string): Promise<Array<Record<string, unknown>>> {
  const now = new Date(Date.now() + 9 * 3600_000);
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return await rpc("ai_ledger_usage_summary", { billing_month: month, dimension }) as Array<Record<string, unknown>>;
}

Deno.test({ name: "e2e: success is reserved, sent, settled and summarised with the same cost", ignore: !enabled }, async () => {
  const provider = recordingFetch(() => jsonResponse(200, anthropicBody(VALID_PAYLOAD), { "request-id": "req_e2e_1" }));
  const result = await executeAiRequest(sampleRequest("anthropic", { callId: "e2e-success" }), testDeps(provider.fetch, { budget: guard() }).deps);
  assert.ok(result.ok, JSON.stringify(result));
  const rows = await summary("logical_role");
  const row = rows.find((r) => r.key === "test.provider.sample")!;
  assert.equal(row.attempts, 1);
  assert.equal(Number(row.estimated_cost_usd), result.estimatedCostUsd);
  assert.equal(row.input_tokens, 800);
});

Deno.test({ name: "e2e: a crash replay of a finished call is refused before any provider request", ignore: !enabled }, async () => {
  const provider = recordingFetch(() => jsonResponse(200, anthropicBody(VALID_PAYLOAD)));
  const replay = await executeAiRequest(sampleRequest("anthropic", { callId: "e2e-success" }), testDeps(provider.fetch, { budget: guard() }).deps);
  assert.ok(!replay.ok && replay.errorCode === "BUDGET_DENIED" && replay.detail === "ATTEMPT_FINALIZED");
  assert.equal(provider.calls.length, 0);
});

Deno.test({ name: "e2e: the per-user daily cap stops the third consult call before the provider", ignore: !enabled }, async () => {
  const openai = recordingFetch(() =>
    jsonResponse(200, {
      status: "completed",
      model: "gpt-6-luna",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(VALID_PAYLOAD) }] }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })
  );
  const outcomes: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await executeAiRequest(
      sampleRequest("openai", { model: "gpt-6-luna", usageContext: { application: "postona", feature: "consult", subject: { kind: "user", userId: USER } } }),
      testDeps(openai.fetch, { budget: guard() }).deps,
    );
    outcomes.push(result.ok ? "ok" : `${result.errorCode}:${result.detail}`);
  }
  assert.deepEqual(outcomes, ["ok", "ok", "BUDGET_DENIED:CALL_LIMIT"]);
  assert.equal(openai.calls.length, 2, "the third call never reached the provider");
  const users = await summary("user");
  assert.equal(users.find((r) => r.key === USER)?.attempts, 2);
});

Deno.test({ name: "e2e: a retried 529 and a timeout are both in the ledger; the timeout at its upper bound", ignore: !enabled }, async () => {
  let call = 0;
  const flaky = recordingFetch(() => (call++ === 0 ? jsonResponse(529, anthropicError(529, "overloaded_error", "busy")) : jsonResponse(200, anthropicBody(VALID_PAYLOAD))));
  const retried = await executeAiRequest(sampleRequest("anthropic", { callId: "e2e-retry", logicalRole: "test.e2e.retry" }), testDeps(flaky.fetch, { budget: guard() }).deps);
  assert.ok(retried.ok && retried.transportAttempts === 2);
  const roles = await summary("logical_role");
  const retryRow = roles.find((r) => r.key === "test.e2e.retry")!;
  assert.deepEqual([retryRow.attempts, retryRow.failed, retryRow.succeeded], [2, 1, 1]);

  const hanging = recordingFetch((_call, _index, init) => hangUntilAborted(init));
  const timedOut = await executeAiRequest(
    sampleRequest("anthropic", { callId: "e2e-timeout", logicalRole: "test.e2e.timeout", timeoutMs: 1_000, transport: { maxAttempts: 1 } }),
    testDeps(hanging.fetch, { budget: guard() }).deps,
  );
  assert.ok(!timedOut.ok && timedOut.errorCode === "TIMEOUT" && timedOut.costBasis === "includes_upper_bound");
  const after = await summary("logical_role");
  const timeoutRow = after.find((r) => r.key === "test.e2e.timeout")!;
  assert.equal(timeoutRow.unknown, 1);
  assert.equal(Number(timeoutRow.upper_bound_cost_usd), timedOut.estimatedCostUsd);
});

Deno.test({ name: "e2e: Phase 1a in-memory guard still works unchanged next to the ledger guard", ignore: !enabled }, async () => {
  const provider = recordingFetch(() => jsonResponse(200, anthropicBody(VALID_PAYLOAD)));
  const memory = new InMemoryBudgetGuard([{ id: "all", scope: {}, maxCalls: 1 }]);
  const result = await executeAiRequest(sampleRequest("anthropic"), testDeps(provider.fetch, { budget: memory }).deps);
  assert.ok(result.ok);
});

// ---- R1: one reservation = at most one provider request ----------------------------------------------------------

for (const [feature, cap] of [["r1_cap1", 1], ["r1_cap10", 10]] as const) {
  Deno.test({ name: `e2e R1: two concurrent calls, same callId, separate guards, call cap ${cap} -> ONE provider request, ONE charge`, ignore: !enabled }, async () => {
    const provider = slowProvider(300);
    const request = sampleRequest("anthropic", {
      callId: `r1-concurrent-${feature}`,
      logicalRole: `test.r1.${feature}`,
      usageContext: { application: "kabumori", feature },
      transport: { maxAttempts: 1 },
    });
    const [first, second] = await Promise.all([
      executeAiRequest(request, testDeps(provider.fetch, { budget: guard() }).deps),
      executeAiRequest(request, testDeps(provider.fetch, { budget: guard() }).deps),
    ]);
    assert.equal(provider.calls.length, 1, "the provider received exactly one HTTP request");
    const outcomes = [first, second].map((r) => (r.ok ? "ok" : `${r.errorCode}:${r.detail}`)).sort();
    assert.deepEqual(outcomes, ["BUDGET_DENIED:SEND_NOT_CONFIRMED", "ok"]);
    const roles = await summary("logical_role");
    assert.equal(roles.find((r) => r.key === `test.r1.${feature}`)?.attempts, 1, "one ledger event");
    const bucket = await budgetBucket(`e2e.r1.${feature}`);
    assert.deepEqual([bucket?.calls, Number(bucket?.held_usd)], [1, 0], "one call counted, nothing left held");
  });
}

Deno.test({ name: "e2e R1: mark_sent commits but its response times out -> no send, the hold stays, a replay cannot send", ignore: !enabled }, async () => {
  const provider = slowProvider(0);
  const request = sampleRequest("anthropic", {
    callId: "r1-mark-sent-timeout",
    logicalRole: "test.r1.timeout",
    usageContext: { application: "kabumori", feature: "r1_timeout" },
    transport: { maxAttempts: 1 },
  });
  await fetch(`${URL_BASE}/__test/fault`, {
    method: "POST",
    headers: { apikey: KEY!, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ rpc: "ai_ledger_mark_sent", hangMs: 1500, count: 1 }),
  }).then((r) => r.body?.cancel());
  const lost = await executeAiRequest(request, testDeps(provider.fetch, { budget: guard(500) }).deps);
  assert.ok(!lost.ok && lost.errorCode === "BUDGET_DENIED" && lost.detail === "SEND_NOT_CONFIRMED", `first call: ${JSON.stringify(lost)}`);
  assert.equal(provider.calls.length, 0, "an unconfirmed permit is never assumed");
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const held = await budgetBucket("e2e.r1.r1_timeout");
  assert.ok(Number(held?.held_usd) > 0 && held?.calls === 1, "the possibly-sent hold stays counted (not released)");
  const replay = await executeAiRequest(request, testDeps(provider.fetch, { budget: guard() }).deps);
  assert.ok(!replay.ok && replay.errorCode === "BUDGET_DENIED", `replay: ${JSON.stringify(replay)}`);
  assert.equal(provider.calls.length, 0, "the replay of a sent attempt never reaches the provider");
});

Deno.test({ name: "e2e R1: connection lost after the permit -> one request, charged at its upper bound; a replay cannot send", ignore: !enabled }, async () => {
  const broken = recordingFetch(() => Promise.reject(new TypeError("connection reset")));
  const request = sampleRequest("anthropic", {
    callId: "r1-lost-after-send",
    logicalRole: "test.r1.lost",
    usageContext: { application: "kabumori", feature: "r1_lost" },
    transport: { maxAttempts: 1 },
  });
  const lost = await executeAiRequest(request, testDeps(broken.fetch, { budget: guard() }).deps);
  assert.ok(!lost.ok && lost.errorCode === "NETWORK" && lost.costBasis === "includes_upper_bound");
  const replay = await executeAiRequest(request, testDeps(broken.fetch, { budget: guard() }).deps);
  assert.ok(!replay.ok && replay.errorCode === "BUDGET_DENIED" && replay.detail === "ATTEMPT_FINALIZED");
  assert.equal(broken.calls.length, 1);
  const row = (await summary("logical_role")).find((r) => r.key === "test.r1.lost")!;
  assert.deepEqual([row.attempts, row.unknown], [1, 1]);
});

Deno.test({ name: "e2e R1: an ordinary transport retry still works (attempt 2 is its own reservation and charge)", ignore: !enabled }, async () => {
  let call = 0;
  const flaky = recordingFetch(() => (call++ === 0 ? jsonResponse(529, anthropicError(529, "overloaded_error", "busy")) : jsonResponse(200, anthropicBody(VALID_PAYLOAD))));
  const request = sampleRequest("anthropic", { callId: "r1-retry", logicalRole: "test.r1.retry", usageContext: { application: "kabumori", feature: "r1_retry" }, transport: { maxAttempts: 2 } });
  const result = await executeAiRequest(request, testDeps(flaky.fetch, { budget: guard() }).deps);
  assert.ok(result.ok && result.transportAttempts === 2);
  assert.equal(flaky.calls.length, 2);
  const row = (await summary("logical_role")).find((r) => r.key === "test.r1.retry")!;
  assert.deepEqual([row.attempts, row.failed, row.succeeded], [2, 1, 1]);
});
