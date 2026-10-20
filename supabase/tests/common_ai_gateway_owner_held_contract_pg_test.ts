// G6-11 (2026-10-20): executable contract preflight of a NON-CREATING owner-held check for the R1 root (H2 / H3: "busy" from
// ai_calls_claim is not proof that the asking process still owns the call; after recovery + forget_user + a re-claim, a
// stalled process passes the check and sends).
//
// THE SQL BELOW IS A TEST-ONLY CANDIDATE. It is created by this test in the runner's disposable scratch database and
// nowhere else: it is not a migration, it is not in supabase/migrations, it exists on no Supabase project, and
// gateway.ts does not call it. The gateway is composed with it only inside the test worker (ownerHeld mode). Writing
// it as a real migration needs a separate approved TASK and a Codex Sol (high) review.
//
// G6-12: every process here runs each RPC in its own READ COMMITTED transaction; the results hold in that scope only.
// A recovery with an older REPEATABLE READ / SERIALIZABLE snapshot breaks the held -> send argument (H3 #330): see
// common_ai_gateway_owner_held_isolation_{baseline,guard,fence}_pg_test.ts and docs/ai-provider/G6_OWNER_HELD_ISOLATION.md.
// The candidate SQL now lives in common_ai_gateway_owner_held_fixture.ts.
//
// Real ledger, ai_calls and maintenance SQL, separate gateway / recovery processes, fake G5 and providers.
// Run by common_ai_gateway_restart_race_pg_run.sh common_ai_gateway_owner_held_contract_pg_test.ts.
import assert from "node:assert/strict";
import {
  age,
  answer,
  auditMatchesLedger,
  codeOf,
  DB,
  gateway,
  HOST,
  keyOf,
  ledger,
  opts,
  paused,
  PORT,
  psql,
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
import { OWNER_HELD_CANDIDATE_SQL } from "./common_ai_gateway_owner_held_fixture.ts";


const USER_C = "00000000-0000-4000-8000-0000000000c3";
const JWT_C1 = "g6r-user-c.session-1.sig";
const asC = { credential: JWT_C1, brand: "brand_c", ownerHeld: true } as const;
const keyC = (op: string) => keyOf(op, { user: USER_C, brand: "brand_c" });
const FN = "public.ai_calls_claim_held(jsonb)";
const TEST_ROLES = ["g6r_inherits_authenticated", "g6r_inherits_service_role"];

async function serviceCall(name: string, p: unknown): Promise<{ ok: boolean; out: string; err: string }> {
  return await psql(`set role service_role; select public.${name}($j$${JSON.stringify(p)}$j$::jsonb)`);
}
async function held(p: unknown): Promise<unknown> {
  const r = await serviceCall("ai_calls_claim_held", p);
  assert.ok(r.ok, r.err);
  return JSON.parse(r.out);
}
const rowImage = (key: string) => rows(`select coalesce((select xmin::text || '|' || row_to_json(c)::text from ai_calls.consumer_calls c where call_key = '${key}'), '-')`);
const callCount = () => rows(`select count(*) from ai_calls.consumer_calls`);
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
/** Who may execute the function, from the catalog (owner excluded). */
const executors = () =>
  rows(`select coalesce(string_agg(case when a.grantee = 0 then 'PUBLIC' else r.rolname end || ':' || a.privilege_type, ',' order by coalesce(r.rolname, 'PUBLIC'), a.privilege_type), '-')
    from pg_proc p cross join lateral aclexplode(p.proacl) a left join pg_roles r on r.oid = a.grantee
   where p.oid = '${FN}'::regprocedure and a.grantee <> p.proowner`);
const claimToken = (key: string) => rows(`select coalesce((select claim_token::text from ai_calls.consumer_calls where call_key = '${key}'), '-')`);
const forgetUser = async (user: string) => JSON.parse(await rows(`set role service_role; select public.ai_calls_forget_user('{"user_id": "${user}"}'::jsonb)`));

Deno.test({ name: "setup: the shared fixtures, person C, and the TEST-ONLY candidate in this scratch database", ...opts }, async () => {
  await setupFixtures();
  await rows(`insert into g6r_fake.sessions values ('${JWT_C1}', '${USER_C}', 'sc1', 'active');
    insert into g6r_fake.entitlements values ('${USER_C}', 'postona:x_autopost');
    insert into g6r_fake.brands values ('brand_c', '${USER_C}', 21, 1)`);
  assert.equal(await rows(`select count(*) from pg_proc where proname = 'ai_calls_claim_held'`), "0", "no such function before the test creates it");
  const r = await psql(OWNER_HELD_CANDIDATE_SQL);
  assert.ok(r.ok, r.err);
});

Deno.test({ name: "ACL and definer: owner = the ai_calls RPCs' owner, SECURITY DEFINER with an empty search_path, EXECUTE for service_role only (Supabase default privileges trap shown), inherited roles, no direct table access", ...opts }, async () => {
  assert.equal(await rows(`select (select proowner from pg_proc where oid = '${FN}'::regprocedure) = (select proowner from pg_proc where oid = 'public.ai_calls_claim(jsonb)'::regprocedure)`), "t");
  assert.equal(await rows(`select prosecdef::text || '|' || array_to_string(proconfig, ',') || '|' || provolatile::text from pg_proc where oid = '${FN}'::regprocedure`), `true|search_path=""|v`);
  assert.equal(await executors(), "service_role:EXECUTE");
  for (const [role, may] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
    assert.equal(await rows(`select has_function_privilege('${role}', '${FN}', 'EXECUTE')`), may ? "t" : "f", role);
  }
  const anon = await psql(`set role anon; select public.ai_calls_claim_held('{}'::jsonb)`);
  assert.ok(!anon.ok && /permission denied/.test(anon.err), "anon is refused before the body runs");
  assert.equal(await rows(`select has_table_privilege('service_role', 'ai_calls.consumer_calls', 'SELECT')`), "f", "service_role reads rows only through the RPC");
  try {
    await rows(`create role ${TEST_ROLES[0]} nologin; grant authenticated to ${TEST_ROLES[0]}; create role ${TEST_ROLES[1]} nologin; grant service_role to ${TEST_ROLES[1]}`);
    assert.equal(await rows(`select has_function_privilege('${TEST_ROLES[0]}', '${FN}', 'EXECUTE')`), "f", "membership in authenticated gives nothing");
    assert.equal(await rows(`select has_function_privilege('${TEST_ROLES[1]}', '${FN}', 'EXECUTE')`), "t", "membership in service_role inherits it (an operational rule: grant service_role to nobody else)");
  } finally {
    await rows(`drop role if exists ${TEST_ROLES[0]}; drop role if exists ${TEST_ROLES[1]}`);
  }
  // The trap: this database (like Supabase) grants every new function in public to anon / authenticated by default.
  // Without the explicit revoke the same body would be callable by anon.
  const twin = OWNER_HELD_CANDIDATE_SQL.replaceAll("ai_calls_claim_held", "ai_calls_claim_held_noacl").replace(/revoke all on function[\s\S]*$/, "");
  assert.ok((await psql(twin)).ok);
  assert.equal(await rows(`select has_function_privilege('anon', 'public.ai_calls_claim_held_noacl(jsonb)', 'EXECUTE')`), "t", "default privileges would expose it");
  await rows(`drop function public.ai_calls_claim_held_noacl(jsonb)`);
  // A later migration that widens it is caught by the same catalog check.
  await rows(`grant execute on function ${FN} to authenticated`);
  assert.equal(await executors(), "authenticated:EXECUTE,service_role:EXECUTE", "the regression is visible");
  await rows(`revoke execute on function ${FN} from authenticated`);
  assert.equal(await executors(), "service_role:EXECUTE");
});

Deno.test({ name: "contract: held only for the exact identity + original owner + acquired; every other case false with a reason; a missing row is never created; nothing is written; bad input refused", ...opts }, async () => {
  const p = { call_key: "h5m2_" + "1".repeat(64), tenant_tag: "1".repeat(64), fingerprint: "1".repeat(64), application: "postona", feature: "postona:consult", subject_kind: "user", user_id: USER_A, brand_ref: "brand_x" };
  const claimed = JSON.parse((await serviceCall("ai_calls_claim", p)).out);
  assert.equal(claimed.kind, "acquired");
  const exact = { ...p, owner: claimed.owner };
  const before = await rowImage(p.call_key);
  assert.deepEqual(await held(exact), { held: true });
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["another owner", { ...exact, owner: crypto.randomUUID() }, "OWNER_MISMATCH"],
    ["another tenant", { ...exact, tenant_tag: "2".repeat(64) }, "IDENTITY_MISMATCH"],
    ["another fingerprint", { ...exact, fingerprint: "2".repeat(64) }, "IDENTITY_MISMATCH"],
    ["another app", { ...exact, application: "kabumori" }, "IDENTITY_MISMATCH"],
    ["another feature", { ...exact, feature: "postona:post_generation" }, "IDENTITY_MISMATCH"],
    ["another person", { ...exact, user_id: USER_B }, "IDENTITY_MISMATCH"],
    ["another brand", { ...exact, brand_ref: "brand_y" }, "IDENTITY_MISMATCH"],
    ["no brand", (({ brand_ref: _b, ...rest }) => rest)(exact), "IDENTITY_MISMATCH"],
    ["a system subject", (({ user_id: _u, brand_ref: _b, ...rest }) => ({ ...rest, subject_kind: "system" }))(exact), "IDENTITY_MISMATCH"],
    ["missing", { ...exact, call_key: "h5m2_" + "3".repeat(64) }, "NOT_FOUND"],
  ];
  const count = await callCount();
  for (const [label, q, reason] of cases) assert.deepEqual(await held(q), { held: false, reason }, label);
  assert.equal(await callCount(), count, "a missing row is not created");
  assert.equal(await rowImage(p.call_key), before, "the row is not written (same xmin, same content)");
  for (const [label, bad] of [["no owner", (({ owner: _o, ...rest }) => rest)(exact)], ["owner not a uuid", { ...exact, owner: "x" }], ["person without user_id", (({ user_id: _u, ...rest }) => rest)(exact)], ["bad key", { ...exact, call_key: "x" }]] as const) {
    const r = await serviceCall("ai_calls_claim_held", bad);
    assert.ok(!r.ok && /AI_CALLS_INVALID_INPUT/.test(r.err), label);
  }
  // Closed rows are never held: completed by the owner, or abandoned by recovery.
  const outcome = { ok: false, code: "UNKNOWN", audit: { callId: p.call_key, tenantTag: p.tenant_tag, feature: p.feature, role: "postona.consult.reply", model: "gpt-6-luna", policyVersion: "r1", attempts: 0, estimatedCostUsd: 0, costBasis: "no_request" } };
  assert.ok((await serviceCall("ai_calls_complete", { call_key: p.call_key, tenant_tag: p.tenant_tag, fingerprint: p.fingerprint, owner: claimed.owner, result: outcome })).ok);
  assert.deepEqual(await held(exact), { held: false, reason: "NOT_ACQUIRED" });
  assert.equal(await callCount(), count);
});

Deno.test({ name: "lock order, measured: the check waits for an abandon, a forget_user and the owner's complete in progress, and then sees their result (closed / missing, never re-created)", ...opts }, async () => {
  const make = async (n: string) => {
    const p = { call_key: "h5m2_" + n.repeat(64), tenant_tag: n.repeat(64), fingerprint: n.repeat(64), application: "postona", feature: "postona:consult", subject_kind: "user", user_id: USER_B, brand_ref: "brand_b" };
    const c = JSON.parse((await serviceCall("ai_calls_claim", p)).out);
    return { p, owner: c.owner as string };
  };
  const timed = async (q: unknown) => {
    const t0 = Date.now();
    const answer = await held(q);
    return { answer, ms: Date.now() - t0 };
  };
  // (a) an abandon in progress (it holds the call-key lock for 2 s before committing)
  const a = await make("4");
  await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set created_at = created_at - interval '1900 seconds' where call_key = '${a.p.call_key}'`);
  const tomb = { callId: a.p.call_key, tenantTag: a.p.tenant_tag, feature: a.p.feature, role: "postona.consult.reply", model: "gpt-6-luna", policyVersion: "r1", attempts: 0, estimatedCostUsd: 0, costBasis: "no_request" };
  const abandoning = session(`set role service_role; begin; select public.ai_calls_abandon($j$${JSON.stringify({ call_key: a.p.call_key, audit: tomb })}$j$::jsonb); select pg_sleep(2) /* g611-abandon */; commit;`);
  await sleeping("g611-abandon");
  const ra = await timed({ ...a.p, owner: a.owner });
  assert.ok((await abandoning).ok);
  assert.ok(ra.ms >= 1000, `waited ${ra.ms} ms`);
  assert.deepEqual(ra.answer, { held: false, reason: "NOT_ACQUIRED" });
  // (b) a forget_user in progress (exclusive person lock for 2 s): the check then finds nothing and creates nothing
  const b = await make("5");
  // forget_user refuses while a row is acquired: recovery closes it first (the real abandon); the token stays with "A".
  await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set created_at = created_at - interval '1900 seconds' where call_key = '${b.p.call_key}'`);
  const closedB = JSON.parse((await serviceCall("ai_calls_abandon", { call_key: b.p.call_key, audit: { ...tomb, callId: b.p.call_key, tenantTag: b.p.tenant_tag } })).out);
  assert.equal(closedB.abandoned, true);
  const forgetting = session(`set role service_role; begin; select public.ai_calls_forget_user('{"user_id": "${USER_B}"}'::jsonb); select pg_sleep(2) /* g611-forget */; commit;`);
  await sleeping("g611-forget");
  const before = await callCount();
  const rb = await timed({ ...b.p, owner: b.owner });
  const forgot = await forgetting;
  assert.ok(forgot.ok, forgot.err);
  assert.ok(rb.ms >= 1000, `waited ${rb.ms} ms`);
  assert.deepEqual(rb.answer, { held: false, reason: "NOT_FOUND" });
  assert.equal(await rows(`select count(*) from ai_calls.consumer_calls where call_key = '${b.p.call_key}'`), "0", "never re-created");
  assert.ok(Number(await callCount()) < Number(before));
  // (c) the owner's own complete in progress (row FOR UPDATE for 2 s)
  const c = await make("6");
  const outcome = { ok: false, code: "UNKNOWN", audit: { ...tomb, callId: c.p.call_key, tenantTag: c.p.tenant_tag } };
  const completing = session(`set role service_role; begin; select public.ai_calls_complete($j$${JSON.stringify({ call_key: c.p.call_key, tenant_tag: c.p.tenant_tag, fingerprint: c.p.fingerprint, owner: c.owner, result: outcome })}$j$::jsonb); select pg_sleep(2) /* g611-complete */; commit;`);
  await sleeping("g611-complete");
  const rc = await timed({ ...c.p, owner: c.owner });
  assert.ok((await completing).ok);
  assert.ok(rc.ms >= 1000, `waited ${rc.ms} ms`);
  assert.deepEqual(rc.answer, { held: false, reason: "NOT_ACQUIRED" });
});

Deno.test({ name: "R1 root with the candidate (separate processes): A stalls, recovery + forget_user, B re-claims; A's check says OWNER_MISMATCH and A sends NOTHING (the creating check sent once). Availability: B then finds attempt 1 burnt", ...opts }, async () => {
  const op = "op-g611-aba";
  const k = await keyC(op);
  const a = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim", trace: true });
  await paused(a, "after:ai_calls_claim");
  const firstOwner = await claimToken(k);
  await age(k, 1900);
  assert.equal((await recover()).candidates.find((c) => c.callKey === k)?.classification, "NOT_SENT_PROVEN");
  assert.equal((await forgetUser(USER_C)).forgotten, true, "forget_user while C is still authorised (precondition NOT met)");
  const b = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim" });
  await paused(b, "after:ai_calls_claim");
  assert.notEqual(await claimToken(k), firstOwner);
  await resume(a);
  const ra = await answer(a);
  assert.equal(await rows(`select count(*) from g6r_fake.events where worker = '${a.name}' and point = 'end:ai_calls_claim_held#1'`), "1", "A asked the candidate");
  assert.deepEqual([codeOf(ra), await sends(op), await ledger(k)], ["UNKNOWN", 0, "released"], "the non-owner sends nothing");
  await resume(b);
  const rb = await answer(b);
  // B (the real owner now) reserves attempt 1, which A's released hold already used: ATTEMPT_FINALIZED -> UNKNOWN (G6-10).
  assert.deepEqual([codeOf(rb), await sends(op), await state(k)], ["UNKNOWN", 0, "acquired"]);
  await age(k, 1900);
  const closed = (await recover()).candidates.find((c) => c.callKey === k);
  assert.deepEqual([closed?.classification, closed?.outcome], ["NOT_SENT_PROVEN", "ABANDONED"]);
  await auditMatchesLedger(k, "ABA with the candidate");
});

Deno.test({ name: "the owner path with the candidate: one process sends once; the first claim is the only ai_calls_claim, the pre-send check is the candidate; the answer lost or slower than the RPC timeout -> nothing sent", ...opts }, async () => {
  const op = "op-g611-owner";
  const k = await keyOf(op);
  const w = gateway(op, { ownerHeld: true, trace: true });
  assert.deepEqual([codeOf(await answer(w)), await sends(op), await state(k), await ledger(k)], ["OK", 1, "complete", "settled"]);
  assert.equal(await rows(`select string_agg(point, ',' order by seq) from g6r_fake.events where worker = '${w.name}' and point like 'start:ai_calls%'`), "start:ai_calls_claim#1,start:ai_calls_claim_held#1,start:ai_calls_complete#1");
  await auditMatchesLedger(k, "owner path");

  const lostOp = "op-g611-held-lost";
  const kl = await keyOf(lostOp);
  const lost = await answer(gateway(lostOp, { ownerHeld: true, faults: { "ai_calls_claim_held#1": "lost" } }));
  assert.deepEqual([codeOf(lost), await sends(lostOp), await state(kl), await ledger(kl)], ["UNKNOWN", 0, "acquired", "released"]);

  const slowOp = "op-g611-held-timeout";
  const ks = await keyOf(slowOp);
  const slow = gateway(slowOp, { ownerHeld: true, pauseAt: "after:ai_ledger_reserve", rpcTimeoutMs: 1500 });
  await paused(slow, "after:ai_ledger_reserve");
  const holder = session(`select pg_advisory_lock(hashtextextended('ai_calls:call:${ks}', 0)); select pg_sleep(4) /* g611-holder */;`);
  await sleeping("g611-holder");
  await resume(slow);
  assert.deepEqual([codeOf(await answer(slow)), await sends(slowOp), await ledger(ks)], ["UNKNOWN", 0, "released"]);
  assert.ok((await holder).ok);
  assert.equal(await state(ks), "acquired", "the late check finished without writing");
});

Deno.test({ name: "R2 erasure with the candidate: precondition met (de-authorised, then forget_user), the stalled process sends nothing and does NOT re-create the forgotten person's row (the creating check did)", ...opts }, async () => {
  const op = "op-g611-erasure";
  const k = await keyC(op);
  const a = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim", trace: true });
  await paused(a, "after:ai_calls_claim");
  await age(k, 1900);
  assert.equal((await recover()).candidates.find((c) => c.callKey === k)?.outcome, "ABANDONED");
  await rows(`update g6r_fake.sessions set state = 'revoked' where jwt = '${JWT_C1}'`);
  try {
    assert.equal((await forgetUser(USER_C)).forgotten, true);
    await resume(a);
    assert.deepEqual([codeOf(await answer(a)), await sends(op)], ["UNKNOWN", 0]);
    assert.equal(await rows(`select count(*) from g6r_fake.events where worker = '${a.name}' and point = 'end:ai_calls_claim_held#1'`), "1", "the check ran (before the recheck) and said NOT_FOUND");
    assert.equal(await rows(`select count(*) from ai_calls.consumer_calls where user_id = '${USER_C}'`), "0", "no call row for the forgotten person");
    // The ledger reservation made before any check still carries the person (both orders, G6-09): the ledger's own erasure.
    assert.equal(await rows(`select status || ':' || count(*) from ai_ledger.reservations where request_id = '${k}' and user_id = '${USER_C}' group by status`), "released:1");
  } finally {
    await rows(`update g6r_fake.sessions set state = 'active' where jwt = '${JWT_C1}'`);
  }
});

Deno.test({ name: "4-way race with the candidate: a stalled original, a restart and two recovery processes over 8 interleavings; at most one send, nothing left open, every row true to the ledger", ...opts }, async () => {
  const outcomes: Record<string, number> = {};
  for (let i = 0; i < 8; i++) {
    const op = `op-g611-race-${i}`;
    const k = await keyOf(op);
    const a = gateway(op, { ownerHeld: true, pauseAt: "after:ai_calls_claim" });
    await paused(a, "after:ai_calls_claim");
    await age(k, 1900);
    const later = <T>(ms: number, f: () => Promise<T>) => new Promise<T>((resolve, reject) => setTimeout(() => f().then(resolve, reject), ms));
    const [first, restarted] = await Promise.all([
      later([0, 300, 700, 1200][i % 4], async () => (await resume(a), codeOf(await answer(a)))),
      later(40 * (i % 3), async () => codeOf(await answer(gateway(op, { ownerHeld: true })))),
      later(25 * ((i + 1) % 4), () => recover()),
      later(15 * (i % 5), () => recover()),
    ]);
    const n = await sends(op);
    const st = await state(k);
    assert.ok(n <= 1 && ["complete", "abandoned"].includes(st), `${op}: sends ${n}, ${st}`);
    assert.equal(n === 1, st === "complete" && first === "OK", op);
    await auditMatchesLedger(k, op);
    const key = `${first}/${restarted}/${st}/sends=${n}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  console.log("G6-11 4-way outcomes:", JSON.stringify(outcomes));
  assert.ok(Object.keys(outcomes).length >= 2);
});
