// G6-12 (2026-10-20): H3 #330 P2 on the PR384 owner-held candidate, AGAINST THE CURRENT SHARED SQL (no guard). The
// "held -> send" argument assumes ai_calls_abandon sees the open reservation; a recovery transaction whose REPEATABLE
// READ / SERIALIZABLE snapshot predates it does not. The SAFETY conditions below are asserted as written and are
// EXPECTED TO FAIL here (the counterexample); the READ COMMITTED contrast passes. Nothing is relaxed to make it pass.
// TEST-ONLY candidate in the runner's scratch database; no migration. Run by
// common_ai_gateway_restart_race_pg_run.sh common_ai_gateway_owner_held_isolation_baseline_pg_test.ts (exit 1 expected).
import assert from "node:assert/strict";
import { opts, psql, rows, setupFixtures } from "./common_ai_gateway_restart_race_support.ts";
import { asSafety, OWNER_HELD_CANDIDATE_SQL, processChain, SAFE, SAFE_END, safeEnd, setupPersonC, snapshotChain } from "./common_ai_gateway_owner_held_fixture.ts";

Deno.test({ name: "setup: shared fixtures, person C, the PR384 TEST-ONLY candidate (no guard)", ...opts }, async () => {
  await setupFixtures();
  await setupPersonC();
  const r = await psql(OWNER_HELD_CANDIDATE_SQL);
  assert.ok(r.ok, r.err);
  assert.equal(await rows(`show default_transaction_isolation`), "read committed", "this cluster's default (not assumed for callers)");
});

Deno.test({ name: "contrast, READ COMMITTED recovery: the abandon sees A's reservation (LEDGER_NOT_FINAL); forget refuses; no re-claim; A's mark_sent is A's own", ...opts }, async () => {
  const o = await snapshotChain("read committed", "a");
  assert.deepEqual(asSafety(o), SAFE, JSON.stringify(o));
});

Deno.test({ name: "SAFETY (expected FAIL on the current SQL): a REPEATABLE READ recovery whose snapshot predates A's reservation must not close A's call", ...opts }, async () => {
  const o = await snapshotChain("repeatable read", "b");
  assert.deepEqual(asSafety(o), SAFE, JSON.stringify(o));
});

Deno.test({ name: "SAFETY (expected FAIL on the current SQL): the same with a SERIALIZABLE recovery", ...opts }, async () => {
  const o = await snapshotChain("serializable", "c");
  assert.deepEqual(asSafety(o), SAFE, JSON.stringify(o));
});

Deno.test({ name: "SAFETY end to end (expected FAIL on the current SQL): separate processes, owner-held gateway, REPEATABLE READ recovery -> forget -> B re-claims -> A must send NOTHING", ...opts }, async () => {
  const o = await processChain("repeatable read", "op-g612-base-rr");
  // Safe: A's call is not closed, not re-claimed, and no process sends while it is not the call's owner. (A, still
  // the owner, may send its one request.)
  assert.deepEqual(safeEnd(o), SAFE_END, JSON.stringify(o));
});
