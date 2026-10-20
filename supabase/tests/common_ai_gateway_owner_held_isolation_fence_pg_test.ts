// G6-12 (2026-10-20): PROPOSAL 2 for H3 #330 P2, as a TEST-ONLY fixture in the runner's scratch database (no migration):
// isolation-independent. The owner-held check WRITES its own acquired row (fence_seq + 1, nothing else; never an
// INSERT), so an abandon whose snapshot predates the stamp fails its existing FOR UPDATE with a serialization error
// (40001), and one whose snapshot follows the stamp sees the reservation committed before it. ai_calls_abandon is not
// changed. The same scenarios as the baseline file, where they fail; here the SAFETY conditions must hold. Run by
// common_ai_gateway_restart_race_pg_run.sh common_ai_gateway_owner_held_isolation_fence_pg_test.ts.
import assert from "node:assert/strict";
import { opts, psql, rows, setupFixtures } from "./common_ai_gateway_restart_race_support.ts";
import { asSafety, FENCE_FIXTURE_SQL, processChain, SAFE, SAFE_END, safeEnd, session, setupPersonC, sleeping, snapshotChain } from "./common_ai_gateway_owner_held_fixture.ts";

const image = (key: string) => rows(`select coalesce((select xmin::text || '|' || (to_jsonb(c) - 'fence_seq')::text || '|' || fence_seq from ai_calls.consumer_calls c where call_key = '${key}'), '-')`);
async function held(p: unknown): Promise<unknown> {
  const r = await psql(`set role service_role; select public.ai_calls_claim_held($j$${JSON.stringify(p)}$j$::jsonb)`);
  assert.ok(r.ok, r.err);
  return JSON.parse(r.out);
}

Deno.test({ name: "setup: shared fixtures, person C, the fence fixture (column, trigger, writing held)", ...opts }, async () => {
  await setupFixtures();
  await setupPersonC();
  const r = await psql(FENCE_FIXTURE_SQL);
  assert.ok(r.ok, r.err);
  assert.equal(await rows(`select has_function_privilege('anon', 'public.ai_calls_claim_held(jsonb)', 'EXECUTE')::text || has_function_privilege('service_role', 'public.ai_calls_claim_held(jsonb)', 'EXECUTE')::text`), "falsetrue");
});

Deno.test({ name: "READ COMMITTED recovery: unchanged (LEDGER_NOT_FINAL, forget refuses, no re-claim)", ...opts }, async () => {
  const o = await snapshotChain("read committed", "a");
  assert.deepEqual(asSafety(o), SAFE, JSON.stringify(o));
});

for (const [isolation, n] of [["repeatable read", "b"], ["serializable", "c"]] as const) {
  Deno.test({ name: `SAFETY with the fence: a ${isolation.toUpperCase()} recovery whose snapshot predates the stamp fails with 40001 (serialization_failure); A's call stays A's`, ...opts }, async () => {
    const o = await snapshotChain(isolation, n);
    assert.deepEqual(asSafety(o), SAFE, JSON.stringify(o));
    assert.equal((o.abandon as { error?: string }).error, "40001", JSON.stringify(o.abandon));
  });
}

Deno.test({ name: "SAFETY end to end with the fence: separate processes, REPEATABLE READ recovery fails -> forget refused -> no re-claim; A (still the owner) sends its one request", ...opts }, async () => {
  const o = await processChain("repeatable read", "op-g612-fence-rr");
  assert.deepEqual(safeEnd(o), SAFE_END, JSON.stringify(o));
  assert.deepEqual([o.abandon, o.forgot, o.a, o.sends], ["40001", false, "OK", 1]);
});

Deno.test({ name: "the writing check stays narrow: it stamps only its own acquired row (fence_seq + 1, nothing else), writes nothing otherwise, never inserts; the trigger refuses any other fence_seq change; an abandon holding the row makes the check wait and answer not held", ...opts }, async () => {
  const p = { call_key: "h5m2_" + "9".repeat(64), tenant_tag: "9".repeat(64), fingerprint: "9".repeat(64), application: "postona", feature: "postona:consult", subject_kind: "user", user_id: "00000000-0000-4000-8000-000000000099", brand_ref: "brand_c" };
  const c = JSON.parse((await psql(`set role service_role; select public.ai_calls_claim($j$${JSON.stringify(p)}$j$::jsonb)`)).out);
  const before = await image(p.call_key);
  assert.deepEqual(await held({ ...p, owner: c.owner }), { held: true });
  const after = await image(p.call_key);
  const [x0, body0, seq0] = before.split("|");
  const [x1, body1, seq1] = after.split("|");
  assert.deepEqual([x1 !== x0, body1 === body0, Number(seq1) - Number(seq0)], [true, true, 1], "one stamp, nothing else");
  const count = await rows(`select count(*) from ai_calls.consumer_calls`);
  for (const [label, q, reason] of [["another owner", { ...p, owner: crypto.randomUUID() }, "OWNER_MISMATCH"], ["another tenant", { ...p, owner: c.owner, tenant_tag: "8".repeat(64) }, "IDENTITY_MISMATCH"], ["missing", { ...p, owner: c.owner, call_key: "h5m2_" + "7".repeat(64) }, "NOT_FOUND"]] as const) {
    assert.deepEqual(await held(q), { held: false, reason }, label);
  }
  assert.equal(await image(p.call_key), after, "a refused check writes nothing");
  assert.equal(await rows(`select count(*) from ai_calls.consumer_calls`), count, "never inserts");
  for (const bad of [`fence_seq = fence_seq + 2`, `fence_seq = fence_seq + 1, brand_ref = 'brand_x'`]) {
    const r = await psql(`update ai_calls.consumer_calls set ${bad} where call_key = '${p.call_key}'`);
    assert.ok(!r.ok && /AI_CALLS_(FENCE_SEQ|IDENTITY_IMMUTABLE|TRANSITION)/.test(r.err), bad);
  }
  // An abandon that holds the row first: the check's UPDATE waits, then finds the row closed (not held).
  await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set created_at = created_at - interval '1900 seconds' where call_key = '${p.call_key}'`);
  const audit = { callId: p.call_key, tenantTag: p.tenant_tag, feature: p.feature, role: "postona.consult.reply", model: "gpt-6-luna", policyVersion: "r1", attempts: 0, estimatedCostUsd: 0, costBasis: "no_request" };
  const abandoning = session(`set role service_role; begin; select public.ai_calls_abandon($j$${JSON.stringify({ call_key: p.call_key, audit })}$j$::jsonb); select pg_sleep(2) /* g612-fence-abandon */; commit;`);
  await sleeping("g612-fence-abandon");
  const t0 = Date.now();
  const answer = await held({ ...p, owner: c.owner });
  assert.ok(Date.now() - t0 >= 1000, "waited for the abandon's commit");
  assert.ok((await abandoning).ok);
  assert.deepEqual(answer, { held: false, reason: "NOT_ACQUIRED" });
  const r = await psql(`update ai_calls.consumer_calls set fence_seq = fence_seq + 1 where call_key = '${p.call_key}'`);
  assert.ok(!r.ok, "a closed row cannot be stamped");
});
