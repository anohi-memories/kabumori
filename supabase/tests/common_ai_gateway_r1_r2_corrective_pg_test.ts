// G6-09 (2026-10-20): the H2 review's R1 / R2 findings on the PR #357 pre-send claim check, after the G6-only corrective
// (gateway.ts): a ledger refusal someone else may have sent under is answered UNKNOWN and recorded by nobody but recovery
// (R1 mitigation), and the authority recheck is the last step before mark_sent (R2). Real ledger, ai_calls and
// maintenance SQL in a disposable socket-only PostgreSQL, separate gateway / recovery processes, fake G5 and providers.
// What this does NOT fix (asserted as such): the stalled process's own send after forget_user + a re-acquired row (the
// claim check cannot prove ownership: shared SQL), and a change after the recheck (the remaining window).
// Run by common_ai_gateway_restart_race_pg_run.sh common_ai_gateway_r1_r2_corrective_pg_test.ts.
import assert from "node:assert/strict";
import {
  age,
  answer,
  audit,
  auditMatchesLedger,
  codeOf,
  gateway,
  keyOf,
  ledger,
  opts,
  paused,
  recover,
  resume,
  rows,
  sends,
  setupFixtures,
  state,
  USER_A,
  USER_B,
} from "./common_ai_gateway_restart_race_support.ts";

const USER_C = "00000000-0000-4000-8000-0000000000c3";
const JWT_C1 = "g6r-user-c.session-1.sig";
const asC = { credential: JWT_C1, brand: "brand_c" } as const;
const keyC = (op: string) => keyOf(op, { user: USER_C, brand: "brand_c" });
const forgetUser = async (user: string) => JSON.parse(await rows(`set role service_role; select public.ai_calls_forget_user('{"user_id": "${user}"}'::jsonb)`));
const claimToken = (key: string) => rows(`select coalesce((select claim_token::text from ai_calls.consumer_calls where call_key = '${key}'), '-')`);

Deno.test({ name: "setup: the shared fixtures + person C and two more brands of A", ...opts }, async () => {
  await setupFixtures();
  await rows(`insert into g6r_fake.sessions values ('${JWT_C1}', '${USER_C}', 'sc1', 'active');
    insert into g6r_fake.entitlements values ('${USER_C}', 'postona:x_autopost');
    insert into g6r_fake.brands values ('brand_c', '${USER_C}', 21, 1), ('brand_v', '${USER_A}', 51, 1), ('brand_u', '${USER_A}', 61, 1)`);
});

Deno.test({ name: "R1 (H2 reproduction, forget_user before the person is de-authorised): the live row is never recorded or answered as NOT_SENT; recovery closes it from the ledger. ROOT unresolved: the stalled process's send still happens", ...opts }, async () => {
  const op = "op-g609-r1";
  const k = await keyC(op);
  const a = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim" });
  await paused(a, "after:ai_calls_claim");
  const firstOwner = await claimToken(k);
  await age(k, 1900);
  assert.equal((await recover()).candidates.find((c) => c.callKey === k)?.classification, "NOT_SENT_PROVEN");
  assert.equal((await forgetUser(USER_C)).forgotten, true, "forget_user ran while C is still authorised (its precondition is NOT met)");
  const b = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim" });
  await paused(b, "after:ai_calls_claim");
  assert.notEqual(await claimToken(k), firstOwner, "B holds a new row (another claim token) under the same key");
  await resume(a);
  const ra = await answer(a);
  await resume(b);
  const rb = await answer(b);
  // ROOT (unchanged, needs the shared owner-held check): A's check answered busy for B's row and A sent once.
  assert.deepEqual([codeOf(ra), await sends(op), await ledger(k)], ["UNKNOWN", 1, "settled"]);
  // G6-09: B is told UNKNOWN (was LEDGER_UNAVAILABLE), records nothing (was POLICY_DENIED / attempts 0 / no_request).
  assert.deepEqual([codeOf(rb), rb.audit ?? null, await state(k), await audit(k)], ["UNKNOWN", null, "acquired", null]);
  assert.equal(codeOf(await answer(gateway(op, asC))), "IN_PROGRESS", "a replay waits (was NOT_SENT)");
  // Recovery closes the row with an audit built from the ledger: one measured attempt, its real cost.
  await age(k, 1900);
  const closed = (await recover()).candidates.find((c) => c.callKey === k);
  assert.deepEqual([closed?.classification, closed?.outcome], ["RESULT_LOST", "ABANDONED"]);
  const tomb = await audit(k);
  assert.deepEqual([tomb.attempts, tomb.costBasis], [1, "measured"]);
  assert.ok(tomb.estimatedCostUsd > 0);
  await auditMatchesLedger(k, "R1 after recovery");
  const replay = await answer(gateway(op, asC));
  assert.deepEqual([codeOf(replay), replay.audit?.attempts, await sends(op)], ["UNKNOWN", 1, 1], "never NOT_SENT, never resent");
});

Deno.test({ name: "system subjects: the current gateway stores no brand for a system call, so forget_system_brand cannot reach its rows (H2 correction; other producers NOT_VERIFIED)", ...opts }, async () => {
  const op = "op-g609-system";
  const k = await keyOf(op, { user: null, brand: null, app: "kabumori" });
  assert.equal(codeOf(await answer(gateway(op, { app: "kabumori" }))), "OK");
  assert.equal(await rows(`select subject_kind || ':' || coalesce(brand_ref, 'null') from ai_calls.consumer_calls where call_key = '${k}'`), "system:null");
  const forgot = JSON.parse(await rows(`set role service_role; select public.ai_calls_forget_system_brand('{"brand_ref": "u_${"a".repeat(24)}"}'::jsonb)`));
  assert.deepEqual([forgot.forgotten, forgot.deleted, await state(k)], [true, 0, "complete"]);
});

Deno.test({ name: "R2: a brand transfer after the claim check (before the recheck) stops the send; one after the recheck is not seen (the remaining window: mark_sent and the request)", ...opts }, async () => {
  const before = "op-g609-r2-before-recheck";
  const kb = await keyOf(before, { brand: "brand_v" });
  const a = gateway(before, { brand: "brand_v", pauseAt: "after:ai_calls_claim#2" });
  await paused(a, "after:ai_calls_claim#2");
  await rows(`update g6r_fake.brands set owner = '${USER_B}', owner_epoch = owner_epoch + 1 where slug = 'brand_v'`);
  await resume(a);
  assert.deepEqual([codeOf(await answer(a)), await sends(before), await ledger(kb)], ["AUTH_REVOKED_BEFORE_SEND", 0, "released"]);

  const after = "op-g609-r2-after-recheck";
  const ka = await keyOf(after, { brand: "brand_u" });
  const b = gateway(after, { brand: "brand_u", pauseAt: "after:g5_verdict#2" });
  await paused(b, "after:g5_verdict#2");
  await rows(`update g6r_fake.brands set owner = '${USER_B}', owner_epoch = owner_epoch + 1 where slug = 'brand_u'`);
  await resume(b);
  // RESIDUAL (documented): the recheck had already allowed it; nothing between the recheck and the request asks again.
  assert.deepEqual([codeOf(await answer(b)), await sends(after), await ledger(ka)], ["OK", 1, "settled"]);
  assert.equal(codeOf(await answer(gateway(after, { brand: "brand_u" }))), "AUTH_DENIED", "A can no longer read it");
});

Deno.test({ name: "R2 trade-off (forget_user precondition met): the stalled process sends nothing, but its claim check, now before the recheck, re-creates an acquired row for the forgotten person; recovery closes it and the erasure has to run again", ...opts }, async () => {
  const op = "op-g609-precondition-met";
  const k = await keyC(op);
  const a = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim", trace: true });
  await paused(a, "after:ai_calls_claim");
  await age(k, 1900);
  assert.equal((await recover()).candidates.find((c) => c.callKey === k)?.outcome, "ABANDONED");
  await rows(`update g6r_fake.sessions set state = 'revoked' where jwt = '${JWT_C1}'`);
  try {
    assert.equal((await forgetUser(USER_C)).forgotten, true);
    assert.equal(codeOf(await answer(gateway(op, asC))), "AUTH_DENIED", "no restart can start");
    await resume(a);
    assert.deepEqual([codeOf(await answer(a)), await sends(op), await ledger(k)], ["UNKNOWN", 0, "released"]);
    assert.equal(await rows(`select count(*) from g6r_fake.events where worker = '${a.name}' and point = 'start:ai_calls_claim#2'`), "1", "the check ran before the recheck");
    // What is left: the re-created row (the check creates a missing row) and, as before G6-09 too, the ledger reservation
    // made before any check; both carry the person's id until recovery and the erasures run again.
    assert.equal(await rows(`select state || ':' || user_id from ai_calls.consumer_calls where call_key = '${k}'`), `acquired:${USER_C}`);
    assert.equal(await rows(`select count(*) from ai_ledger.reservations where request_id = '${k}' and user_id = '${USER_C}'`), "1");
    await age(k, 1900);
    assert.equal((await recover()).candidates.find((c) => c.callKey === k)?.classification, "NOT_SENT_PROVEN");
    assert.equal((await forgetUser(USER_C)).forgotten, true);
    assert.equal(await rows(`select count(*) from ai_calls.consumer_calls where user_id = '${USER_C}'`), "0");
  } finally {
    await rows(`update g6r_fake.sessions set state = 'active' where jwt = '${JWT_C1}'`);
  }
});
