// G6-10 (2026-10-20): the H3 review's P2 on PR #372: a reserve whose answer is lost (or a ledger that cannot be reached)
// reaches the gateway as GUARD_UNAVAILABLE (shared execute.ts folds every reserve failure into it) and, before G6-10,
// was recorded as "not sent" (POLICY_DENIED / attempts 0 / no_request / 0 USD) and replayed as NOT_SENT, even when
// another process had sent the operation. Real ledger, ai_calls and maintenance SQL in a disposable socket-only
// PostgreSQL, separate gateway / recovery processes, fake G5 and providers.
// Not fixed here (asserted as such): the stalled process's own send after forget_user + a re-acquired row (R1 root).
// Run by common_ai_gateway_restart_race_pg_run.sh common_ai_gateway_lost_reserve_pg_test.ts.
import assert from "node:assert/strict";
import {
  age,
  ageLedger,
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
} from "./common_ai_gateway_restart_race_support.ts";

const USER_C = "00000000-0000-4000-8000-0000000000c3";
const JWT_C1 = "g6r-user-c.session-1.sig";
const asC = { credential: JWT_C1, brand: "brand_c" } as const;
const keyC = (op: string) => keyOf(op, { user: USER_C, brand: "brand_c" });
const forgetUser = async (user: string) => JSON.parse(await rows(`set role service_role; select public.ai_calls_forget_user('{"user_id": "${user}"}'::jsonb)`));
const claimToken = (key: string) => rows(`select coalesce((select claim_token::text from ai_calls.consumer_calls where call_key = '${key}'), '-')`);
const storedCode = (key: string) => rows(`select coalesce((select coalesce(result ->> 'code', '-') from ai_calls.consumer_calls where call_key = '${key}'), '-')`);

Deno.test({ name: "setup: the shared fixtures + person C", ...opts }, async () => {
  await setupFixtures();
  await rows(`insert into g6r_fake.sessions values ('${JWT_C1}', '${USER_C}', 'sc1', 'active');
    insert into g6r_fake.entitlements values ('${USER_C}', 'postona:x_autopost');
    insert into g6r_fake.brands values ('brand_c', '${USER_C}', 21, 1)`);
});

Deno.test({ name: "H3 reproduction: A sent under a re-acquired row; B's reserve COMMITS (ATTEMPT_FINALIZED) but its answer is lost -> B never records or answers NOT_SENT; recovery closes it from the ledger (measured). ROOT unresolved: A's send", ...opts }, async () => {
  const op = "op-g610-h3";
  const k = await keyC(op);
  const a = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim" });
  await paused(a, "after:ai_calls_claim");
  const firstOwner = await claimToken(k);
  await age(k, 1900);
  assert.equal((await recover()).candidates.find((c) => c.callKey === k)?.classification, "NOT_SENT_PROVEN");
  assert.equal((await forgetUser(USER_C)).forgotten, true, "forget_user while C is still authorised (precondition NOT met)");
  const b = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim", faults: { "ai_ledger_reserve#1": "lost" }, trace: true });
  await paused(b, "after:ai_calls_claim");
  assert.notEqual(await claimToken(k), firstOwner);
  await resume(a);
  assert.deepEqual([codeOf(await answer(a)), await sends(op), await ledger(k)], ["UNKNOWN", 1, "settled"], "ROOT: the stalled process sent once");
  await resume(b);
  const rb = await answer(b);
  assert.equal(await rows(`select count(*) from g6r_fake.events where worker = '${b.name}' and point = 'end:ai_ledger_reserve#1'`), "1", "B's reserve ran (and committed nothing new: attempt 1 was final)");
  // Before G6-10: LEDGER_UNAVAILABLE, row complete / POLICY_DENIED / no_request / 0 USD, replay NOT_SENT.
  assert.deepEqual([codeOf(rb), rb.audit ?? null, await state(k), await storedCode(k)], ["UNKNOWN", null, "acquired", "-"]);
  assert.equal(codeOf(await answer(gateway(op, asC))), "IN_PROGRESS", "replay waits, never NOT_SENT");
  await age(k, 1900);
  const closed = (await recover()).candidates.find((c) => c.callKey === k);
  assert.deepEqual([closed?.classification, closed?.outcome], ["RESULT_LOST", "ABANDONED"]);
  const tomb = await audit(k);
  assert.deepEqual([tomb.attempts, tomb.costBasis, tomb.estimatedCostUsd > 0], [1, "measured", true]);
  await auditMatchesLedger(k, "H3 after recovery");
  assert.equal(Number(await rows(`select count(*) from ai_ledger.usage_events where request_id = '${k}'`)), 1, "the ledger's cost is untouched (one measured event, A's)");
  const replay = await answer(gateway(op, asC));
  assert.deepEqual([codeOf(replay), replay.audit?.attempts, await sends(op)], ["UNKNOWN", 1, 1]);
});

Deno.test({ name: "one process, the reserve committed but its answer was lost: UNKNOWN (no NOT_SENT); the held reservation expires, recovery releases it and closes the row NOT_SENT_PROVEN; nothing sent", ...opts }, async () => {
  const op = "op-g610-reserve-lost";
  const k = await keyOf(op);
  const r = await answer(gateway(op, { faults: { "ai_ledger_reserve#1": "lost" } }));
  assert.deepEqual([codeOf(r), r.audit ?? null, await state(k), await ledger(k), await sends(op)], ["UNKNOWN", null, "acquired", "reserved", 0]);
  await age(k, 1900);
  await ageLedger(k, 0);
  const closed = (await recover()).candidates.find((c) => c.callKey === k);
  assert.deepEqual([closed?.classification, closed?.outcome, await ledger(k)], ["NOT_SENT_PROVEN", "ABANDONED", "released"]);
  await auditMatchesLedger(k, "lost reserve answer");
  assert.deepEqual([codeOf(await answer(gateway(op))), await sends(op)], ["UNKNOWN", 0]);
});

Deno.test({ name: "availability cost: the ledger truly unreachable (the reserve never ran) is now UNKNOWN / IN_PROGRESS until recovery (was LEDGER_UNAVAILABLE / NOT_SENT); a new operation id works at once", ...opts }, async () => {
  const op = "op-g610-reserve-down";
  const k = await keyOf(op);
  const r = await answer(gateway(op, { faults: { "ai_ledger_reserve#1": "down" } }));
  assert.deepEqual([codeOf(r), r.audit ?? null, await state(k), await ledger(k), await sends(op)], ["UNKNOWN", null, "acquired", "-", 0]);
  assert.equal(codeOf(await answer(gateway(op))), "IN_PROGRESS", "the same operation waits for recovery");
  assert.equal(codeOf(await answer(gateway("op-g610-reserve-down-new"))), "OK", "a new operation id is not blocked");
  await age(k, 1900);
  assert.deepEqual((await recover()).candidates.filter((c) => c.callKey === k).map((c) => `${c.classification}:${c.outcome}`), ["NOT_SENT_PROVEN:ABANDONED"]);
  assert.deepEqual([codeOf(await answer(gateway(op))), await sends(op)], ["UNKNOWN", 0]);
});
