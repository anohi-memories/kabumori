// G6-20 (2026-10-28): the OWNER-HELD LEDGER candidate (supabase/candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql)
// on the real ledger, call store, maintenance and owner-held (20261020154536) SQL, with the real gateway in separate
// processes (ledgerMode "owner_held", the runtime default since G6-20), the harness's fake G5 and fake providers.
// The candidate is applied ONLY in the runner's disposable socket-only database. Production NO_GO.
// Run by common_ai_gateway_restart_race_pg_run.sh common_ai_gateway_owner_held_ledger_pg_test.ts.
import assert from "node:assert/strict";
import {
  age,
  answer,
  auditMatchesLedger,
  codeOf,
  gateway,
  keyOf,
  ledger,
  opts,
  paused,
  psql,
  recover,
  resume,
  rows,
  sends,
  setupFixtures,
  state,
} from "./common_ai_gateway_restart_race_support.ts";
import { MIGRATION_PATH, psqlFile } from "./common_ai_gateway_owner_held_fixture.ts";

const CANDIDATE_PATH = new URL("../candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql", import.meta.url).pathname;
const USER_C = "00000000-0000-4000-8000-0000000000c3";
const JWT_C1 = "g6r-user-c.session-1.sig";
/** The SQL contract tests' own person (their rows stay open; forget_user of C must not meet them). */
const USER_D = "00000000-0000-4000-8000-0000000000d4";
const OWNER_HELD = { ledgerMode: "owner_held" } as const;
const asC = { credential: JWT_C1, brand: "brand_c", ledgerMode: "owner_held" } as const;
const keyC = (op: string) => keyOf(op, { user: USER_C, brand: "brand_c" });
const RPCS = ["public.ai_calls_reserve_held(jsonb)", "public.ai_calls_mark_sent_held(jsonb)", "public.ai_calls_release_held(jsonb)"];

const service = async (name: string, p: unknown) => {
  const r = await psql(`set role service_role; select public.${name}($j$${JSON.stringify(p)}$j$::jsonb)`);
  return r.ok ? { ok: true, out: JSON.parse(r.out), err: "" } : { ok: false, out: null, err: r.err };
};
const claimToken = (key: string) => rows(`select coalesce((select claim_token::text from ai_calls.consumer_calls where call_key = '${key}'), '-')`);
const forgetUser = async (user: string) => JSON.parse(await rows(`set role service_role; select public.ai_calls_forget_user('{"user_id": "${user}"}'::jsonb)`));
const owners = (key: string) => rows(`select count(*) || ':' || count(distinct claim_token) from ai_calls.attempt_owners where call_key = '${key}'`);
const catalog = () =>
  rows(`select string_agg(p.oid::regprocedure::text || '=' || p.prosecdef || '/' || coalesce(array_to_string(p.proconfig, ','), '-') || '/' || coalesce(p.proacl::text, '-'), ';' order by p.oid::regprocedure::text)
    from pg_proc p where p.oid in (${RPCS.map((s) => `to_regprocedure('${s}')`).join(", ")}, to_regprocedure('ai_calls.hold_reason(jsonb)'))`);

/** A claim made directly (service_role) for the SQL contract tests: its identity, as the gateway would send it. */
async function directClaim(n: string) {
  const fp = n.padStart(64, "0");
  const p = { call_key: `h5m2_${fp}`, tenant_tag: "b".repeat(64), fingerprint: fp, application: "postona", feature: "consult", subject_kind: "user", user_id: USER_D, brand_ref: "brand_d" };
  const c = await service("ai_calls_claim", p);
  assert.ok(c.ok && c.out.kind === "acquired", c.err);
  return { held: { ...p, owner: c.out.owner as string }, key: p.call_key };
}
const ledgerP = (key: string, attempt = 1) => ({
  request_id: key, attempt, provider: "openai", model: "gpt-6-luna", application: "postona", feature: "consult", logical_role: "postona.consult.reply",
  subject_kind: "user", user_id: USER_D, amount_usd: 0.01, hold_seconds: 60,
});

Deno.test({ name: "setup: fixtures, person C, the owner-held migration and then the candidate; a second run of the candidate is refused with nothing changed", ...opts }, async () => {
  await setupFixtures();
  await rows(`insert into g6r_fake.sessions values ('${JWT_C1}', '${USER_C}', 'sc1', 'active');
    insert into g6r_fake.entitlements values ('${USER_C}', 'postona:x_autopost');
    insert into g6r_fake.brands values ('brand_c', '${USER_C}', 21, 1)`);
  const m = await psqlFile(MIGRATION_PATH);
  assert.ok(m.ok, m.err);
  const c = await psqlFile(CANDIDATE_PATH);
  assert.ok(c.ok, c.err);
  const before = await catalog();
  const again = await psqlFile(CANDIDATE_PATH);
  assert.deepEqual([again.ok, again.sqlstate, /G6_OWNER_HELD_LEDGER_PRESTATE: already applied/.test(again.err)], [false, "P0001", true], again.err);
  assert.equal(await catalog(), before);
});

Deno.test({ name: "catalog and ACL: the three RPCs are SECURITY DEFINER with an empty search_path, EXECUTE for service_role only; hold_reason and attempt_owners are owner-only; anon / authenticated cannot call or read anything", ...opts }, async () => {
  for (const sig of RPCS) {
    assert.equal(await rows(`select prosecdef::text || coalesce(array_to_string(proconfig, ','), '-') from pg_proc where oid = to_regprocedure('${sig}')`), 'truesearch_path=""', sig);
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal(await rows(`select has_function_privilege('${role}', '${sig}', 'EXECUTE')::text`), String(role === "service_role"), `${role} ${sig}`);
    }
  }
  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.equal(await rows(`select (has_function_privilege('${role}', 'ai_calls.hold_reason(jsonb)', 'EXECUTE') or has_table_privilege('${role}', 'ai_calls.attempt_owners', 'SELECT'))::text`), "false", role);
  }
  assert.equal(await rows(`select relrowsecurity::text || (select count(*) from pg_policy where polrelid = 'ai_calls.attempt_owners'::regclass) from pg_class where oid = 'ai_calls.attempt_owners'::regclass`), "true0");
});

Deno.test({ name: "SQL contract: reserve_held refuses a claim that does not own the call (no reservation made); the owner reserves and is recorded; mark_sent_held needs the owner AND the attempt's owner; release_held touches only its own; READ COMMITTED only; request_id must be the call key; a missing row is never created", ...opts }, async () => {
  const a = await directClaim("1");
  const stranger = { ...a.held, owner: crypto.randomUUID() };
  const refused = await service("ai_calls_reserve_held", { held: stranger, ledger: ledgerP(a.key) });
  assert.deepEqual(refused.out, { allowed: false, held: false, reason: "OWNER_MISMATCH" });
  assert.equal(await ledger(a.key), "-", "the ledger was never reached");
  const mine = await service("ai_calls_reserve_held", { held: a.held, ledger: ledgerP(a.key) });
  assert.equal(mine.out.allowed, true);
  assert.equal(await owners(a.key), "1:1");
  const rid = mine.out.reservation_id as string;
  assert.deepEqual((await service("ai_calls_mark_sent_held", { held: stranger, reservation_id: rid })).out, { may_send: false, held: false, reason: "OWNER_MISMATCH" });
  assert.deepEqual((await service("ai_calls_release_held", { held: stranger, reservation_id: rid })).out, { released: false, reason: "ATTEMPT_OWNER_MISMATCH" });
  assert.equal(await ledger(a.key), "reserved", "a stranger can neither send nor release it");
  const sent = await service("ai_calls_mark_sent_held", { held: a.held, reservation_id: rid });
  assert.deepEqual([sent.out.may_send, sent.out.held, sent.out.status], [true, true, "sent"]);
  assert.equal((await service("ai_calls_mark_sent_held", { held: a.held, reservation_id: rid })).out.may_send, false, "one permit only");
  const inFlight = (await service("ai_calls_reserve_held", { held: a.held, ledger: ledgerP(a.key) })).out;
  assert.deepEqual([inFlight.allowed, inFlight.reason, inFlight.held, "reservation_id" in inFlight], [false, "ATTEMPT_IN_FLIGHT", true, false], "a refusal hands out no reservation id");

  // A reservation made outside reserve_held (no recorded owner) gives no permit even to the row's owner.
  const b = await directClaim("2");
  const plain = await service("ai_ledger_reserve", ledgerP(b.key));
  assert.equal(plain.out.allowed, true);
  assert.deepEqual((await service("ai_calls_mark_sent_held", { held: b.held, reservation_id: plain.out.reservation_id })).out, { may_send: false, held: true, reason: "ATTEMPT_OWNER_MISMATCH" });
  // ...and reserve_held does not adopt it either (its id is not handed out).
  const adopt = await service("ai_calls_reserve_held", { held: b.held, ledger: ledgerP(b.key) });
  assert.equal(adopt.out.allowed, true, "the unsent plain hold is reused...");
  assert.equal(await owners(b.key), "1:1", "...and recorded for this owner only because it was unowned");
  // An attempt recorded for ANOTHER claim token (reachable only through a stale-snapshot recovery, which the RC guard
  // refuses; made here directly as the owner) is refused, and its id is not handed out.
  const c = await directClaim("3");
  const first = await service("ai_calls_reserve_held", { held: c.held, ledger: ledgerP(c.key) });
  await rows(`update ai_calls.attempt_owners set claim_token = '${crypto.randomUUID()}' where reservation_id = '${first.out.reservation_id}'`);
  assert.deepEqual((await service("ai_calls_reserve_held", { held: c.held, ledger: ledgerP(c.key) })).out, { allowed: false, held: true, reason: "ATTEMPT_OWNER_MISMATCH", reused: true });
  assert.deepEqual((await service("ai_calls_mark_sent_held", { held: c.held, reservation_id: first.out.reservation_id })).out, { may_send: false, held: true, reason: "ATTEMPT_OWNER_MISMATCH" });

  // Isolation, input and missing rows.
  for (const iso of ["repeatable read", "serializable"]) {
    const r = await psql(`set role service_role; begin isolation level ${iso}; select public.ai_calls_reserve_held($j$${JSON.stringify({ held: a.held, ledger: ledgerP(a.key, 2) })}$j$::jsonb); commit;`);
    assert.ok(!r.ok && /AI_CALLS_REQUIRES_READ_COMMITTED/.test(r.err), iso);
  }
  const wrongKey = await service("ai_calls_reserve_held", { held: a.held, ledger: { ...ledgerP(a.key, 2), request_id: `h5m2_${"9".repeat(64)}` } });
  assert.ok(!wrongKey.ok && /request_id must be the call key/.test(wrongKey.err));
  const ghost = { ...a.held, call_key: `h5m2_${"7".repeat(64)}`, fingerprint: "7".repeat(64) };
  assert.deepEqual((await service("ai_calls_reserve_held", { held: ghost, ledger: ledgerP(ghost.call_key) })).out, { allowed: false, held: false, reason: "NOT_FOUND" });
  assert.equal(await state(ghost.call_key), "-", "never created");
});

Deno.test({ name: "the owner path (separate process, ledgerMode owner_held): sends once; one ai_calls_claim only, then reserve_held, mark_sent_held, settle, complete; the attempt is recorded for its claim; audit = ledger", ...opts }, async () => {
  const op = "op-g620-owner";
  const k = await keyOf(op);
  const w = gateway(op, { ...OWNER_HELD, trace: true });
  assert.deepEqual([codeOf(await answer(w)), await sends(op), await state(k), await ledger(k)], ["OK", 1, "complete", "settled"]);
  assert.equal(await rows(`select string_agg(point, ',' order by seq) from g6r_fake.events where worker = '${w.name}' and point like 'start:ai_%'`),
    "start:ai_calls_claim#1,start:ai_calls_reserve_held#1,start:ai_calls_mark_sent_held#1,start:ai_ledger_settle#1,start:ai_calls_complete#1");
  assert.equal(await owners(k), "1:1");
  await auditMatchesLedger(k, "owner path");
});

Deno.test({ name: "R1 root CLOSED on real SQL (G6-11 ABA, G6-18 S2/S3): A stalls after its claim, recovery + forget_user, B re-claims; A's reserve_held is refused (the ledger is never reached, nothing sent) and B sends ONCE (OK) — before G6-20 B found attempt 1 burnt", ...opts }, async () => {
  const op = "op-g620-aba";
  const k = await keyC(op);
  const a = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim", trace: true });
  await paused(a, "after:ai_calls_claim");
  const firstOwner = await claimToken(k);
  await age(k, 1900);
  assert.equal((await recover()).candidates.find((c) => c.callKey === k)?.classification, "NOT_SENT_PROVEN");
  assert.equal((await forgetUser(USER_C)).forgotten, true);
  const b = gateway(op, { ...asC, pauseAt: "after:ai_calls_claim" });
  await paused(b, "after:ai_calls_claim");
  assert.notEqual(await claimToken(k), firstOwner);
  await resume(a);
  const ra = await answer(a);
  assert.deepEqual([codeOf(ra), await sends(op), await ledger(k)], ["UNKNOWN", 0, "-"], "A: refused before the ledger");
  assert.equal(await rows(`select count(*) from g6r_fake.events where worker = '${a.name}' and point like 'start:ai_calls_claim#2'`), "0", "no busy re-claim");
  await resume(b);
  const rb = await answer(b);
  assert.deepEqual([codeOf(rb), await sends(op), await state(k), await ledger(k), await owners(k)], ["OK", 1, "complete", "settled", "1:1"], "B: the owner sends once");
  await auditMatchesLedger(k, "ABA closed");
});

Deno.test({ name: "right before the send permit (after reserve_held and the recheck): READ COMMITTED recovery cannot close the row (the attempt is open), the owner sends once; a lost answer of reserve_held or mark_sent_held sends nothing (UNKNOWN), the hold stays for the ledger's recovery", ...opts }, async () => {
  const op = "op-g620-late";
  const k = await keyOf(op);
  const w = gateway(op, { ...OWNER_HELD, pauseAt: "before:ai_calls_mark_sent_held" });
  await paused(w, "before:ai_calls_mark_sent_held");
  await age(k, 1900);
  const rec = (await recover()).candidates.find((c) => c.callKey === k);
  assert.notEqual(rec?.outcome, "ABANDONED", JSON.stringify(rec));
  await resume(w);
  assert.deepEqual([codeOf(await answer(w)), await sends(op), await ledger(k)], ["OK", 1, "settled"]);

  for (const [rpc, left] of [["ai_calls_reserve_held", "reserved"], ["ai_calls_mark_sent_held", "sent"]] as const) {
    const lostOp = `op-g620-lost-${rpc.replace(/_/g, "-")}`;
    const kl = await keyOf(lostOp);
    const r = await answer(gateway(lostOp, { ...OWNER_HELD, faults: { [`${rpc}#1`]: "lost" } }));
    assert.deepEqual([codeOf(r), await sends(lostOp), await state(kl), await ledger(kl)], ["UNKNOWN", 0, "acquired", left], rpc);
  }
});
