// G6-12 (2026-10-20): PROPOSAL 1 for H3 #330 P2, as a TEST-ONLY fixture in the runner's scratch database (no migration):
// ai_calls_abandon, ai_calls_forget_user and the owner-held candidate refuse any isolation but READ COMMITTED, checked
// from inside the function (current_setting('transaction_isolation')), like the existing ai_calls_forget_system_brand.
// The same scenarios as the baseline file, where they fail; here the SAFETY conditions must hold. Plus what a function
// can and cannot do about the caller's isolation. Run by
// common_ai_gateway_restart_race_pg_run.sh common_ai_gateway_owner_held_isolation_guard_pg_test.ts.
import assert from "node:assert/strict";
import { opts, psql, rows, setupFixtures } from "./common_ai_gateway_restart_race_support.ts";
import { asSafety, GUARD_FIXTURE_SQL, processChain, SAFE, SAFE_END, safeEnd, session, setupPersonC, snapshotChain } from "./common_ai_gateway_owner_held_fixture.ts";

Deno.test({ name: "setup: shared fixtures, person C, the candidate + the READ COMMITTED guard fixture", ...opts }, async () => {
  await setupFixtures();
  await setupPersonC();
  const r = await psql(GUARD_FIXTURE_SQL);
  assert.ok(r.ok, r.err);
  for (const fn of ["ai_calls_abandon", "ai_calls_forget_user", "ai_calls_claim_held"]) {
    assert.equal(await rows(`select has_function_privilege('anon', 'public.${fn}(jsonb)', 'EXECUTE')::text || has_function_privilege('service_role', 'public.${fn}(jsonb)', 'EXECUTE')::text`), "falsetrue", fn);
  }
  for (const fn of ["ai_calls_abandon_unguarded", "ai_calls_forget_user_unguarded"]) {
    assert.equal(await rows(`select has_function_privilege('service_role', 'public.${fn}(jsonb)', 'EXECUTE')`), "f", `${fn} is reachable only through the guard`);
  }
});

Deno.test({ name: "READ COMMITTED recovery: unchanged (LEDGER_NOT_FINAL, forget refuses, no re-claim)", ...opts }, async () => {
  const o = await snapshotChain("read committed", "a");
  assert.deepEqual(asSafety(o), SAFE, JSON.stringify(o));
});

for (const [isolation, n] of [["repeatable read", "b"], ["serializable", "c"]] as const) {
  Deno.test({ name: `SAFETY with the guard: a ${isolation.toUpperCase()} recovery whose snapshot predates A's reservation is refused (P0001 AI_CALLS_REQUIRES_READ_COMMITTED); A's call stays A's`, ...opts }, async () => {
    const o = await snapshotChain(isolation, n);
    assert.deepEqual(asSafety(o), SAFE, JSON.stringify(o));
    assert.match(String((o.abandon as { message?: string }).message), /AI_CALLS_REQUIRES_READ_COMMITTED: (repeatable read|serializable)/);
    assert.equal((o.abandon as { error?: string }).error, "P0001");
  });
}

Deno.test({ name: "SAFETY end to end with the guard: separate processes, REPEATABLE READ recovery refused -> forget refused -> no re-claim; A (still the owner) sends its one request", ...opts }, async () => {
  const o = await processChain("repeatable read", "op-g612-guard-rr");
  assert.deepEqual(safeEnd(o), SAFE_END, JSON.stringify(o));
  assert.deepEqual([o.abandon, o.forgot, o.a, o.sends], ["P0001", false, "OK", 1]);
});

Deno.test({ name: "what a function can do about its caller's isolation: detect it (refuse) but not change it; forget_user and the candidate refuse too; a READ COMMITTED abandon of a stale row still works", ...opts }, async () => {
  // A function-level SET clause for transaction_isolation is refused when the function is created; a SET LOCAL in the
  // body fails at run time once the transaction has run a query. A function can detect its caller's isolation, not change it.
  const clause = await psql(`create function public.g612_probe_set_clause() returns text language plpgsql set transaction_isolation = 'read committed' as $$ begin return current_setting('transaction_isolation'); end $$`);
  assert.ok(!clause.ok && /parameter "transaction_isolation" cannot be set locally in functions/.test(clause.err), clause.err);
  await rows(`create function public.g612_probe_set_local() returns text language plpgsql as $$ begin set local transaction_isolation = 'read committed'; return current_setting('transaction_isolation'); end $$`);
  try {
    const r = await session(`begin isolation level repeatable read; select 1; select public.g612_probe_set_local(); commit;`);
    assert.deepEqual([r.ok, r.sqlstate], [false, "25001"], r.err);
    assert.match(r.err, /SET TRANSACTION ISOLATION LEVEL must be called before any query/);
  } finally {
    await rows(`drop function public.g612_probe_set_local()`);
  }
  for (const [fn, p] of [["ai_calls_forget_user", { user_id: "00000000-0000-4000-8000-0000000000ee" }], ["ai_calls_claim_held", { call_key: "h5m2_" + "e".repeat(64), tenant_tag: "e".repeat(64), fingerprint: "e".repeat(64), application: "postona", feature: "postona:consult", subject_kind: "system", owner: crypto.randomUUID() }]] as const) {
    const r = await session(`set role service_role; begin isolation level repeatable read; select public.${fn}($j$${JSON.stringify(p)}$j$::jsonb); commit;`);
    assert.deepEqual([r.ok, r.sqlstate], [false, "P0001"], fn);
  }
  // A stale row with nothing open is still recovered under READ COMMITTED.
  const p = { call_key: "h5m2_" + "d".repeat(64), tenant_tag: "d".repeat(64), fingerprint: "d".repeat(64), application: "postona", feature: "postona:consult", subject_kind: "system" };
  assert.ok((await psql(`set role service_role; select public.ai_calls_claim($j$${JSON.stringify(p)}$j$::jsonb)`)).ok);
  await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set created_at = created_at - interval '1900 seconds' where call_key = '${p.call_key}'`);
  const audit = { callId: p.call_key, tenantTag: p.tenant_tag, feature: p.feature, role: "postona.consult.reply", model: "gpt-6-luna", policyVersion: "r1", attempts: 0, estimatedCostUsd: 0, costBasis: "no_request" };
  const r = await psql(`set role service_role; select public.ai_calls_abandon($j$${JSON.stringify({ call_key: p.call_key, audit })}$j$::jsonb)`);
  assert.deepEqual(JSON.parse(r.out), { abandoned: true });
});
