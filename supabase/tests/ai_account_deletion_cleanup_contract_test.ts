// Offline contract tests of the AI-cleanup reference (no database, no network: a fake rpc answers with the exact
// shapes of the PR261 SQL). deno test --no-config --deny-net --deny-write supabase/tests/ai_account_deletion_cleanup_contract_test.ts
import assert from "node:assert/strict";
import { BRIDGE_MAX_DEADLINE_MS, DEFAULT_MARGIN_MS, runAiAccountCleanup, type CleanupRequest } from "./ai_account_deletion_cleanup_contract.ts";

const USER = "00000000-0000-4000-8000-0000000000a1";
const SLUG = "u_0123456789abcdef01234567";
const ENDED = 1_000_000;
const READY = ENDED + BRIDGE_MAX_DEADLINE_MS + DEFAULT_MARGIN_MS;
const request = (over: Partial<CleanupRequest> = {}): CleanupRequest => ({
  userId: USER,
  workspaceSlug: SLUG,
  entitlementsEndedAtMs: ENDED,
  aiAuthorizationStopped: true,
  nowMs: READY,
  ...over,
});

type Answer = unknown | ((p: Record<string, unknown>) => unknown);
const HAPPY: Record<string, Answer> = {
  ai_calls_forget_user: { forgotten: true, deleted: 3, ledger_reservations_retained: 5 },
  ai_calls_forget_system_brand: { forgotten: true, deleted: 1 },
  ai_ledger_erase_user: { erased: true, reservations: 5, usage_events: 4, budget_buckets: 2, budget_policies: 1 },
  ai_ledger_user_footprint: { reservations: 0, usage_events: 0, budget_buckets: 0, budget_policies: 0, policy_mentions: 0, call_rows: 0, brand_call_rows: 0 },
};
function fake(overrides: Record<string, Answer> = {}) {
  const calls: Array<{ name: string; p: Record<string, unknown> }> = [];
  const answers = { ...HAPPY, ...overrides };
  const rpc = (name: string, p: Record<string, unknown>) => {
    calls.push({ name, p });
    const a = answers[name];
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve(typeof a === "function" ? (a as (p: Record<string, unknown>) => unknown)(p) : structuredClone(a));
  };
  return { rpc, calls, names: () => calls.map((c) => c.name) };
}
const ORDER = ["ai_calls_forget_user", "ai_calls_forget_system_brand", "ai_ledger_erase_user", "ai_ledger_user_footprint"];

Deno.test("happy path: the four RPCs in order, with the user id and the slug each where it belongs; done only after an all-zero read-back", async () => {
  const f = fake();
  const result = await runAiAccountCleanup(f.rpc, request());
  assert.deepEqual(result, {
    status: "done",
    callRowsDeleted: 3,
    systemBrandRowsDeleted: 1,
    erased: { reservations: 5, usage_events: 4, budget_buckets: 2, budget_policies: 1 },
    footprint: HAPPY.ai_ledger_user_footprint,
  });
  assert.deepEqual(f.names(), ORDER);
  assert.deepEqual(f.calls.map((c) => c.p), [{ user_id: USER }, { brand_ref: SLUG }, { user_id: USER }, { user_id: USER, brand_ref: SLUG }]);
});

Deno.test("no workspace: the system-brand step is skipped and the read-back has no brand count", async () => {
  const fp = { reservations: 0, usage_events: 0, budget_buckets: 0, budget_policies: 0, policy_mentions: 0, call_rows: 0 };
  const f = fake({ ai_ledger_user_footprint: fp });
  const result = await runAiAccountCleanup(f.rpc, request({ workspaceSlug: null }));
  assert.equal(result.status, "done");
  assert.deepEqual(f.names(), ["ai_calls_forget_user", "ai_ledger_erase_user", "ai_ledger_user_footprint"]);
  assert.deepEqual(f.calls[2].p, { user_id: USER });
});

Deno.test("preconditions and inputs: refused before any RPC", async () => {
  const cases: Array<[Partial<CleanupRequest>, string]> = [
    [{ entitlementsEndedAtMs: null }, "PRECONDITION_ENTITLEMENTS_NOT_ENDED"],
    [{ aiAuthorizationStopped: false }, "PRECONDITION_AI_AUTHORIZATION_ACTIVE"],
    [{ userId: USER.toUpperCase() }, "INVALID_USER_ID"],
    [{ userId: "00000000-0000-0000-8123-456789abcdef" }, "INVALID_USER_ID"],
    [{ userId: SLUG }, "INVALID_USER_ID"],
    [{ workspaceSlug: USER }, "INVALID_WORKSPACE_SLUG"],
    [{ workspaceSlug: "ai_salaryman_lab" }, "INVALID_WORKSPACE_SLUG"],
    [{ workspaceSlug: "u_0123456789ABCDEF01234567" }, "INVALID_WORKSPACE_SLUG"],
  ];
  for (const [over, reason] of cases) {
    const f = fake();
    assert.deepEqual(await runAiAccountCleanup(f.rpc, request(over)), { status: "refused", reason }, JSON.stringify(over));
    assert.equal(f.calls.length, 0);
  }
});

Deno.test("wait out the bridge deadline + margin after the entitlements ended; nothing is called meanwhile", async () => {
  const f = fake();
  assert.deepEqual(await runAiAccountCleanup(f.rpc, request({ nowMs: READY - 1 })), { status: "wait", reason: "BRIDGE_DEADLINE", retryAfterMs: 1 });
  assert.deepEqual(await runAiAccountCleanup(f.rpc, request({ nowMs: ENDED + BRIDGE_MAX_DEADLINE_MS, marginMs: 0 })), {
    status: "done",
    callRowsDeleted: 3,
    systemBrandRowsDeleted: 1,
    erased: { reservations: 5, usage_events: 4, budget_buckets: 2, budget_policies: 1 },
    footprint: HAPPY.ai_ledger_user_footprint,
  });
  assert.deepEqual(f.names(), ORDER, "only the second (ready) pass called anything");
});

Deno.test("in-flight work stops the pass at that step (retry later); later steps are not run", async () => {
  let f = fake({ ai_calls_forget_user: { forgotten: false, reason: "CALLS_IN_FLIGHT", in_flight: 2 } });
  assert.deepEqual(await runAiAccountCleanup(f.rpc, request()), { status: "retry_later", step: "forget_user", reason: "CALLS_IN_FLIGHT", detail: { in_flight: 2 } });
  assert.deepEqual(f.names(), ["ai_calls_forget_user"]);
  for (const answer of [{ forgotten: false, reason: "CALLS_IN_FLIGHT", in_flight: 1 }, { forgotten: false, reason: "CALLS_IN_FLIGHT", in_flight: 1, deleted: 2 }]) {
    f = fake({ ai_calls_forget_system_brand: answer });
    assert.deepEqual(await runAiAccountCleanup(f.rpc, request()), { status: "retry_later", step: "forget_system_brand", reason: "CALLS_IN_FLIGHT", detail: { in_flight: 1 } });
    assert.deepEqual(f.names(), ORDER.slice(0, 2));
  }
  f = fake({ ai_ledger_erase_user: { erased: false, reason: "LEDGER_IN_FLIGHT", in_flight: 1 } });
  assert.deepEqual(await runAiAccountCleanup(f.rpc, request()), { status: "retry_later", step: "erase_user", reason: "LEDGER_IN_FLIGHT", detail: { in_flight: 1 } });
  f = fake({ ai_ledger_erase_user: { erased: false, reason: "CALL_STORE_NOT_FORGOTTEN", call_rows: 1 } });
  assert.deepEqual(await runAiAccountCleanup(f.rpc, request()), { status: "retry_later", step: "erase_user", reason: "CALL_STORE_NOT_FORGOTTEN", detail: { call_rows: 1 } });
  assert.deepEqual(f.names(), ORDER.slice(0, 3), "no read-back after a refused erasure");
});

Deno.test("policy text naming the user, or a taken erased key: operator required, never auto-fixed", async () => {
  let f = fake({ ai_ledger_erase_user: { erased: false, reason: "POLICY_TEXT_MENTIONS_USER", policies: 1 } });
  assert.deepEqual(await runAiAccountCleanup(f.rpc, request()), { status: "operator_required", step: "erase_user", reason: "POLICY_TEXT_MENTIONS_USER", detail: { policies: 1 } });
  f = fake({ ai_ledger_erase_user: { erased: false, reason: "POLICY_KEY_CONFLICT" } });
  assert.deepEqual(await runAiAccountCleanup(f.rpc, request()), { status: "operator_required", step: "erase_user", reason: "POLICY_KEY_CONFLICT", detail: {} });
});

Deno.test("a read-back that is not all zero is never done (policy_mentions, brand rows, any count)", async () => {
  for (const key of ["reservations", "usage_events", "budget_buckets", "budget_policies", "policy_mentions", "call_rows", "brand_call_rows"]) {
    const fp = { ...HAPPY.ai_ledger_user_footprint as Record<string, number>, [key]: 1 };
    const f = fake({ ai_ledger_user_footprint: fp });
    const result = await runAiAccountCleanup(f.rpc, request());
    assert.equal(result.status, "retry_later", key);
    assert.equal((result as { reason: string }).reason, "FOOTPRINT_NOT_ZERO", key);
  }
});

Deno.test("a failing RPC is never success: the pass stops with that step", async () => {
  for (const name of ORDER) {
    const f = fake({ [name]: new Error("HTTP 503") });
    const step = { ai_calls_forget_user: "forget_user", ai_calls_forget_system_brand: "forget_system_brand", ai_ledger_erase_user: "erase_user", ai_ledger_user_footprint: "footprint" }[name];
    assert.deepEqual(await runAiAccountCleanup(f.rpc, request()), { status: "failed", step, reason: "RPC_ERROR" }, name);
    assert.deepEqual(f.names(), ORDER.slice(0, ORDER.indexOf(name) + 1));
  }
});

Deno.test("an unexpected answer is never success (fail closed): wrong types, missing / extra keys, unknown reasons", async () => {
  const bad: Array<[string, unknown]> = [
    ["ai_calls_forget_user", { forgotten: "true", deleted: 3, ledger_reservations_retained: 5 }],
    ["ai_calls_forget_user", { forgotten: true, deleted: 3 }],
    ["ai_calls_forget_user", { forgotten: true, deleted: -1, ledger_reservations_retained: 0 }],
    ["ai_calls_forget_user", { forgotten: false, reason: "CALLS_IN_FLIGHT", in_flight: 0 }],
    ["ai_calls_forget_user", { forgotten: false, reason: "SOMETHING_NEW", in_flight: 1 }],
    ["ai_calls_forget_user", null],
    ["ai_calls_forget_user", []],
    ["ai_calls_forget_system_brand", { forgotten: true, deleted: 1, extra: 1 }],
    ["ai_ledger_erase_user", { erased: true, reservations: 5, usage_events: 4, budget_buckets: 2 }],
    ["ai_ledger_erase_user", { erased: true, reservations: 5, usage_events: 4, budget_buckets: 2, budget_policies: 1, erased_subject: "00000000-0000-0000-8000-000000000001" }],
    ["ai_ledger_erase_user", { erased: false, reason: "POLICY_KEY_CONFLICT", policies: 1 }],
    ["ai_ledger_erase_user", { erased: true, reservations: 1.5, usage_events: 0, budget_buckets: 0, budget_policies: 0 }],
    ["ai_ledger_user_footprint", { reservations: 0, usage_events: 0, budget_buckets: 0, budget_policies: 0, call_rows: 0, brand_call_rows: 0 }],
    ["ai_ledger_user_footprint", { reservations: 0, usage_events: 0, budget_buckets: 0, budget_policies: 0, policy_mentions: "0", call_rows: 0, brand_call_rows: 0 }],
  ];
  for (const [name, answer] of bad) {
    const f = fake({ [name]: answer });
    const result = await runAiAccountCleanup(f.rpc, request());
    assert.equal(result.status, "failed", `${name} ${JSON.stringify(answer)}`);
    assert.equal((result as { reason: string }).reason, "UNEXPECTED_RESPONSE", name);
  }
});

Deno.test("idempotent: a later pass over an already-clean person is done with zero counts (the final sweep)", async () => {
  const f = fake({
    ai_calls_forget_user: { forgotten: true, deleted: 0, ledger_reservations_retained: 0 },
    ai_calls_forget_system_brand: { forgotten: true, deleted: 0 },
    ai_ledger_erase_user: { erased: true, reservations: 0, usage_events: 0, budget_buckets: 0, budget_policies: 0 },
  });
  const result = await runAiAccountCleanup(f.rpc, request());
  assert.equal(result.status, "done");
  assert.deepEqual(f.names(), ORDER);
});
