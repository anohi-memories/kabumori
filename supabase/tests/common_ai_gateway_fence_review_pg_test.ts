// G6-08 (2026-10-20): evidence for the focused review of the PR #357 pre-send claim check ("fence"), on the REAL ledger,
// ai_calls and maintenance SQL in a disposable socket-only PostgreSQL, with separate gateway / recovery processes
// (common_ai_gateway_restart_race_worker.ts). It adds what PR #357's own harness does not cover: the SQL lock order
// measured, "busy" not being an ownership proof (row deleted and re-acquired) and the ledger attempt key as the second
// fence, the check failing closed (lost answer, timeout behind a held lock, an orphan row), an identity-bound check, a
// retry after the sent grace, the authority window after the last check, and a 4-way race over many interleavings.
// Two tests pin a RESIDUAL behaviour on purpose (named "RESIDUAL"): they assert what happens today, for the reviewer.
// Run by common_ai_gateway_restart_race_pg_run.sh common_ai_gateway_fence_review_pg_test.ts.
import assert from "node:assert/strict";
import {
  age,
  ageLedger,
  answer,
  audit,
  auditMatchesLedger,
  codeOf,
  DB,
  gateway,
  HOST,
  JWT_B1,
  keyOf,
  ledger,
  opts,
  paused,
  PORT,
  recover,
  resume,
  rows,
  sends,
  setupFixtures,
  state,
  SUPER,
  USER_A,
  USER_B,
} from "./common_ai_gateway_restart_race_support.ts";

const USER_C = "00000000-0000-4000-8000-0000000000c3";
const USER_D = "00000000-0000-4000-8000-0000000000d4";
const JWT_C1 = "g6r-user-c.session-1.sig";
const JWT_D1 = "g6r-user-d.session-1.sig";
const asC = { credential: JWT_C1, brand: "brand_c" } as const;
const keyC = (op: string) => keyOf(op, { user: USER_C, brand: "brand_c" });

/** A second database session the test controls (for example one that holds a lock while the gateway waits). */
function session(sql: string) {
  const child = new Deno.Command("psql", {
    args: ["-X", "-h", HOST!, "-p", PORT!, "-U", SUPER!, "-d", DB!, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  return child.output().then((o) => ({ ok: o.success, out: new TextDecoder().decode(o.stdout).trim(), err: new TextDecoder().decode(o.stderr).trim() }));
}
async function sleeping(marker: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await rows(`select count(*) from pg_stat_activity where query like '%${marker}%' and wait_event = 'PgSleep'`)) !== "0") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${marker} never slept`);
}
const eventAt = (worker: string, point: string) => rows(`select coalesce(max(extract(epoch from at) * 1000)::bigint::text, '') from g6r_fake.events where worker = '${worker}' and point = '${point}'`);
const tombstoneAudit = async (key: string) => {
  const tenant = await rows(`select tenant_tag from ai_calls.consumer_calls where call_key = '${key}'`);
  return { callId: key, tenantTag: tenant, feature: "postona:consult", role: "postona.consult.reply", model: "gpt-6-luna", policyVersion: "r1", attempts: 0, estimatedCostUsd: 0, costBasis: "no_request" };
};
const forgetUser = async (user: string) => JSON.parse(await rows(`set role service_role; select public.ai_calls_forget_user('{"user_id": "${user}"}'::jsonb)`));

Deno.test({ name: "setup: the shared fixtures + people C and D", ...opts }, async () => {
  await setupFixtures();
  await rows(`insert into g6r_fake.sessions values ('${JWT_C1}', '${USER_C}', 'sc1', 'active'), ('${JWT_D1}', '${USER_D}', 'sd1', 'active');
    insert into g6r_fake.entitlements values ('${USER_C}', 'postona:x_autopost'), ('${USER_D}', 'postona:x_autopost');
    insert into g6r_fake.brands values ('brand_c', '${USER_C}', 21, 1), ('brand_d', '${USER_D}', 31, 1), ('brand_w', '${USER_A}', 41, 1)`);
});

Deno.test({ name: "lock order, measured: an abandon in progress holds the row's lock; the pre-send check waits for its commit and sees the tombstone. A reservation made first makes the abandon refuse", ...opts }, async () => {
  // (a) The abandon is first. The process waits after its claim; recovery's abandon runs in its own transaction and
  //     sleeps 2 s before committing (holding the call-key lock); the process resumes: reserve, recheck, check.
  const op = "op-g608-lock-abandon-first";
  const k = await keyOf(op);
  const a = gateway(op, { pauseAt: "after:ai_calls_claim", trace: true });
  await paused(a, "after:ai_calls_claim");
  await age(k, 1900);
  const abandon = session(`set role service_role; begin; select public.ai_calls_abandon($j$${JSON.stringify({ call_key: k, audit: await tombstoneAudit(k) })}$j$::jsonb); select pg_sleep(2) /* g608-abandon */; commit;`);
  await sleeping("g608-abandon");
  await resume(a);
  const r = await answer(a);
  const ab = await abandon;
  assert.ok(ab.ok, ab.err);
  assert.equal(JSON.parse(ab.out.split("\n")[0]).abandoned, true);
  const waited = Number(await eventAt(a.name, "end:ai_calls_claim#2")) - Number(await eventAt(a.name, "start:ai_calls_claim#2"));
  assert.ok(waited >= 1000, `the check waited for the abandon's commit (${waited} ms)`);
  assert.deepEqual([codeOf(r), await sends(op), await ledger(k), await state(k)], ["UNKNOWN", 0, "released", "abandoned"]);

  // (b) The reservation is first: the abandon sees an open attempt and refuses; the process then sends normally.
  const op2 = "op-g608-lock-reserve-first";
  const k2 = await keyOf(op2);
  const b = gateway(op2, { pauseAt: "after:ai_ledger_reserve" });
  await paused(b, "after:ai_ledger_reserve");
  await age(k2, 1900);
  const refused = JSON.parse(await rows(`set role service_role; select public.ai_calls_abandon($j$${JSON.stringify({ call_key: k2, audit: await tombstoneAudit(k2) })}$j$::jsonb)`));
  assert.deepEqual(refused, { abandoned: false, reason: "LEDGER_NOT_FINAL", open_attempts: 1 });
  await resume(b);
  assert.deepEqual([codeOf(await answer(b)), await sends(op2), await ledger(k2), await state(k2)], ["OK", 1, "settled", "complete"]);
  await auditMatchesLedger(k2, "reserve first");
});

Deno.test({ name: "busy is not an ownership proof: after recovery and forget_user, a restart re-acquires the row and the stalled process passes the check; the ledger's attempt key still refuses its send", ...opts }, async () => {
  const op = "op-g608-reacquired-held";
  const k = await keyC(op);
  const a = gateway(op, { ...asC, pauseAt: "after:ai_ledger_reserve", trace: true });
  await paused(a, "after:ai_ledger_reserve");
  await age(k, 1900);
  await ageLedger(k, 0); // the unsent hold expired
  assert.equal((await recover()).candidates.find((c) => c.callKey === k)?.outcome, "ABANDONED");
  assert.deepEqual(await forgetUser(USER_C), { forgotten: true, deleted: 1, ledger_reservations_retained: 1 });
  const restart = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim" });
  await paused(restart, "after:ai_calls_claim"); // the restart now holds a NEW acquired row under the same key
  await resume(a);
  const original = await answer(a);
  // The original's check answered busy (the restart's row): it went on to mark_sent, which refused its released hold.
  assert.equal(await rows(`select count(*) from g6r_fake.events where worker = '${a.name}' and point = 'start:ai_ledger_mark_sent#1'`), "1", "passed the check");
  await resume(restart);
  const second = await answer(restart);
  // The restart's reserve finds attempt 1 finalised (released): no attempt number can authorise a second send.
  assert.deepEqual([codeOf(original), codeOf(second), await sends(op), await ledger(k), await state(k)], ["UNKNOWN", "LEDGER_UNAVAILABLE", 0, "released", "complete"]);
  await auditMatchesLedger(k, "re-acquired row");
});

Deno.test({ name: "RESIDUAL (needs shared SQL): stalled BEFORE its reserve, recovery + forget_user, a restart holds the new row: the stalled process passes the check and sends; the restart is told NOT_SENT while the ledger has the charge", ...opts }, async () => {
  const op = "op-g608-residual-busy";
  const k = await keyC(op);
  const a = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim" });
  await paused(a, "after:ai_calls_claim");
  await age(k, 1900);
  assert.equal((await recover()).candidates.find((c) => c.callKey === k)?.classification, "NOT_SENT_PROVEN");
  assert.equal((await forgetUser(USER_C)).forgotten, true, "forget_user ran while C is still authorised (its documented precondition is NOT met)");
  const restart = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim" });
  await paused(restart, "after:ai_calls_claim");
  await resume(a);
  const original = await answer(a);
  await resume(restart);
  const second = await answer(restart);
  // What happens today: one send (by the process whose claim was closed and deleted), the charge in the ledger, and
  // the live row records "not sent" with no attempt.
  assert.deepEqual([codeOf(original), codeOf(second), await sends(op), await ledger(k), await state(k)], ["UNKNOWN", "LEDGER_UNAVAILABLE", 1, "settled", "complete"]);
  const row = await audit(k);
  assert.deepEqual([row.attempts, row.costBasis, await rows(`select result ->> 'code' from ai_calls.consumer_calls where call_key = '${k}'`)], [0, "no_request", "POLICY_DENIED"]);
  assert.equal(Number(await rows(`select count(*) from ai_ledger.usage_events where request_id = '${k}' and cost_basis = 'measured'`)), 1, "never double: the ledger allowed attempt 1 once");
  assert.equal(codeOf(await answer(gateway(op, asC))), "NOT_SENT", "the person is told it was not sent");
});

Deno.test({ name: "with forget_user's precondition met (the person can no longer be authorised), the stalled process is stopped by the recheck before the check, and no restart can start", ...opts }, async () => {
  const op = "op-g608-precondition-met";
  const k = await keyC(op);
  const a = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim", trace: true });
  await paused(a, "after:ai_calls_claim");
  await age(k, 1900);
  assert.equal((await recover()).candidates.find((c) => c.callKey === k)?.outcome, "ABANDONED");
  await rows(`update g6r_fake.sessions set state = 'revoked' where jwt = '${JWT_C1}'`);
  try {
    assert.equal((await forgetUser(USER_C)).forgotten, true);
    assert.equal(codeOf(await answer(gateway(op, asC))), "AUTH_DENIED");
    await resume(a);
    // Stopped at the recheck (the check never ran); its record then fails on the deleted row, hence UNKNOWN.
    assert.deepEqual([codeOf(await answer(a)), await sends(op), await ledger(k), await state(k)], ["UNKNOWN", 0, "released", "-"]);
    assert.equal(await rows(`select count(*) from g6r_fake.events where worker = '${a.name}' and point = 'start:ai_calls_claim#2'`), "0");
  } finally {
    await rows(`update g6r_fake.sessions set state = 'active' where jwt = '${JWT_C1}'`);
  }
});

Deno.test({ name: "the check fails closed: its answer lost after the statement ran; slower than the RPC timeout behind a lock another session holds; a lost answer that CREATED a row after deletion leaves an orphan that recovery closes", ...opts }, async () => {
  // (a) Lost answer: nothing sent, the hold released, UNKNOWN; the row stays acquired for recovery (NOT_SENT_PROVEN).
  const lostOp = "op-g608-check-lost";
  const kl = await keyOf(lostOp);
  const lost = await answer(gateway(lostOp, { faults: { "ai_calls_claim#2": "lost" } }));
  assert.deepEqual([codeOf(lost), await sends(lostOp), await ledger(kl), await state(kl)], ["UNKNOWN", 0, "released", "acquired"]);
  await age(kl, 1900);
  const closed = (await recover()).candidates.find((c) => c.callKey === kl);
  assert.deepEqual([closed?.classification, closed?.outcome], ["NOT_SENT_PROVEN", "ABANDONED"]);

  // (b) Timeout: another session holds the row's lock for 4 s; the check gives up after 1.5 s; nothing is sent.
  const slowOp = "op-g608-check-timeout";
  const ks = await keyOf(slowOp);
  const slow = gateway(slowOp, { pauseAt: "after:ai_ledger_reserve", rpcTimeoutMs: 1500, trace: true });
  await paused(slow, "after:ai_ledger_reserve");
  const holder = session(`select pg_advisory_lock(hashtextextended('ai_calls:call:${ks}', 0)); select pg_sleep(4) /* g608-holder */;`);
  await sleeping("g608-holder");
  const t0 = Date.now();
  await resume(slow);
  const r = await answer(slow);
  assert.ok(Date.now() - t0 >= 1400, "it waited for the timeout");
  assert.deepEqual([codeOf(r), await sends(slowOp), await ledger(ks)], ["UNKNOWN", 0, "released"]);
  assert.equal(await rows(`select count(*) from g6r_fake.events where worker = '${slow.name}' and point = 'end:ai_calls_claim#2'`), "0", "the check never answered");
  assert.ok((await holder).ok);
  assert.equal(await state(ks), "acquired", "the abandoned statement finished later without writing");

  // (c) Orphan: the row was closed and deleted while the process waited; its check re-creates the row and the answer is lost.
  const orphanOp = "op-g608-check-orphan";
  const ko = await keyC(orphanOp);
  const o = gateway(orphanOp, { ...asC, pauseAt: "after:ai_calls_claim", faults: { "ai_calls_claim#2": "lost" } });
  await paused(o, "after:ai_calls_claim");
  await age(ko, 1900);
  assert.equal((await recover()).candidates.find((c) => c.callKey === ko)?.outcome, "ABANDONED");
  assert.equal((await forgetUser(USER_C)).forgotten, true);
  await resume(o);
  assert.deepEqual([codeOf(await answer(o)), await sends(orphanOp), await ledger(ko), await state(ko)], ["UNKNOWN", 0, "released", "acquired"], "an orphan row nobody owns");
  assert.equal(codeOf(await answer(gateway(orphanOp, asC))), "IN_PROGRESS", "liveness cost: the operation waits for recovery");
  await age(ko, 1900);
  assert.deepEqual((await recover()).candidates.filter((c) => c.callKey === ko).map((c) => `${c.classification}:${c.outcome}`), ["NOT_SENT_PROVEN:ABANDONED"]);
  assert.deepEqual([codeOf(await answer(gateway(orphanOp, asC))), await sends(orphanOp)], ["UNKNOWN", 0]);
});

Deno.test({ name: "the check is bound to the identity, not only the key: a row whose identity changed under the same key (another tenant's) stops the send", ...opts }, async () => {
  const op = "op-g608-identity";
  const k = await keyOf(op);
  const a = gateway(op, { pauseAt: "after:ai_ledger_reserve" });
  await paused(a, "after:ai_ledger_reserve");
  const other = await keyOf(op, { user: USER_B, brand: "brand_b" });
  await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set user_id = '${USER_B}', tenant_tag = '${other.slice(5)}' where call_key = '${k}'`);
  await resume(a);
  assert.deepEqual([codeOf(await answer(a)), await sends(op), await ledger(k)], ["UNKNOWN", 0, "released"]);
  assert.equal(await rows(`select user_id || ':' || state from ai_calls.consumer_calls where call_key = '${k}'`), `${USER_B}:acquired`, "the other identity's row is untouched");
  void JWT_B1;
});

Deno.test({ name: "a provider answer slower than the sent grace, then a retryable refusal: the ledger alone would allow attempt 2; the check stops it (control: without recovery, attempt 2 is sent)", ...opts }, async () => {
  const control = "op-g608-retry-control";
  const kc = await keyOf(control, { feature: "post_generation" });
  const c = await answer(gateway(control, { feature: "post_generation", providerReplies: ["429", "ok"] }));
  assert.deepEqual([codeOf(c), await sends(control), await ledger(kc)], ["OK", 2, "settled,settled"]);

  const op = "op-g608-retry-after-grace";
  const k = await keyOf(op, { feature: "post_generation" });
  const a = gateway(op, { feature: "post_generation", providerReplies: ["429", "ok"], pauseAt: "provider#1" });
  await paused(a, "provider#1");
  await age(k, 2000);
  await ageLedger(k, 1000);
  const fenced = (await recover()).candidates.find((c) => c.callKey === k);
  assert.deepEqual([fenced?.classification, fenced?.outcome], ["POSSIBLY_SENT", "ABANDONED"]);
  const tomb = await audit(k);
  await resume(a);
  assert.deepEqual([codeOf(await answer(a)), await sends(op), await ledger(k)], ["UNKNOWN", 1, "unknown,released"]);
  assert.deepEqual(await audit(k), tomb);
  await auditMatchesLedger(k, "retry after grace");
});

Deno.test({ name: "why the check comes AFTER reserve: stopped right after the check, the process's own open reservation keeps recovery away (WAIT), and the call then finishes", ...opts }, async () => {
  const op = "op-g608-after-check";
  const k = await keyOf(op);
  const a = gateway(op, { pauseAt: "after:ai_calls_claim#2" });
  await paused(a, "after:ai_calls_claim#2");
  await age(k, 1900);
  const seen = (await recover()).candidates.find((c) => c.callKey === k);
  assert.deepEqual([seen?.outcome, await state(k), await ledger(k)], ["WAIT_LEDGER_OPEN", "acquired", "reserved"]);
  await resume(a);
  assert.deepEqual([codeOf(await answer(a)), await sends(op), await state(k)], ["OK", 1, "complete"]);
  await auditMatchesLedger(k, "after the check");
});

Deno.test({ name: "RESIDUAL (window): an owner-epoch change after the recheck (between the check and mark_sent) is not seen: the send goes out", ...opts }, async () => {
  const op = "op-g608-epoch-window";
  const k = await keyOf(op, { brand: "brand_w" });
  const a = gateway(op, { brand: "brand_w", pauseAt: "after:ai_calls_claim#2" });
  await paused(a, "after:ai_calls_claim#2");
  await rows(`update g6r_fake.brands set owner_epoch = owner_epoch + 1 where slug = 'brand_w'`);
  await resume(a);
  assert.deepEqual([codeOf(await answer(a)), await sends(op), await ledger(k)], ["OK", 1, "settled"]);
  // A restart under the new epoch replays the stored answer (same person, same brand), nothing more is sent.
  assert.deepEqual([codeOf(await answer(gateway(op, { brand: "brand_w" }))), await sends(op)], ["OK", 1]);
});

Deno.test({ name: "4-way race over many interleavings: a stalled original resumes while a restart and two recovery processes run; at most one send, nothing left open, every row true to the ledger", ...opts }, async () => {
  const outcomes: Record<string, number> = {};
  for (let i = 0; i < 12; i++) {
    const op = `op-g608-race-${i}`;
    const k = await keyOf(op, { user: USER_D, brand: "brand_d" });
    const who = { credential: JWT_D1, brand: "brand_d" };
    const a = gateway(op, { ...who, pauseAt: "after:ai_calls_claim" });
    await paused(a, "after:ai_calls_claim");
    await age(k, 1900);
    const runs: Promise<unknown>[] = [];
    // Who goes first varies: the original resumes at once or after the recovery processes have started.
    const delays = [[0, 300, 700, 1200][i % 4], 40 * (i % 3), 25 * ((i + 1) % 4), 15 * (i % 5)];
    const later = <T>(ms: number, f: () => Promise<T>) => new Promise<T>((resolve, reject) => setTimeout(() => f().then(resolve, reject), ms));
    runs.push(later(delays[0], async () => (await resume(a), codeOf(await answer(a)))));
    runs.push(later(delays[1], async () => codeOf(await answer(gateway(op, who)))));
    runs.push(later(delays[2], () => recover()));
    runs.push(later(delays[3], () => recover()));
    const [first, restarted] = (await Promise.all(runs)) as [string, string];
    const n = await sends(op);
    const st = await state(k);
    assert.ok(["OK", "UNKNOWN"].includes(first), `${op}: original ${first}`);
    assert.ok(["IN_PROGRESS", "OK", "UNKNOWN"].includes(restarted), `${op}: restart ${restarted}`);
    assert.ok(n <= 1, `${op}: sends ${n}`);
    assert.ok(["complete", "abandoned"].includes(st), `${op}: nothing left open (${st})`);
    assert.equal(n === 1, st === "complete" && first === "OK", `${op}: a send <=> the original finished`);
    assert.ok(Number(await rows(`select count(*) from ai_ledger.reservations where request_id = '${k}' and status <> 'released'`)) <= 1);
    await auditMatchesLedger(k, op);
    const key = `${first}/${restarted}/${st}/sends=${n}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  console.log("G6-08 4-way outcomes:", JSON.stringify(outcomes));
  assert.ok(Object.keys(outcomes).length >= 2, "both orders were exercised");
});
