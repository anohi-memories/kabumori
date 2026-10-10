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

function guard() {
  const secret = resolveSecret("AIL_E2E_KEY", () => KEY);
  assert.ok(secret.ok);
  return new SupabaseLedgerBudgetGuard({ supabaseUrl: URL_BASE!, serviceKey: secret.value });
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
