// G6-13 (2026-10-21): the REAL migration 20261020154536_ai_calls_owner_held_rc_guard.sql (proposal A of G6-12, accepted
// by H3 #330 for a scoped implementation) on the real ledger, call store and maintenance migrations, in the runner's
// disposable socket-only PostgreSQL. Nothing here injects a fixture guard or a fixture held: the migration file itself
// is applied with psql -f (and the local-only rollback for the rollback test). Production NO_GO; no gateway wiring.
// Also run against the real migration: common_ai_gateway_owner_held_contract_pg_test.ts with source "migration".
// The unmodified baseline (2 PASS / 3 intentional security FAIL) stays in common_ai_gateway_owner_held_isolation_baseline_pg_test.ts.
// Run by common_ai_gateway_restart_race_pg_run.sh common_ai_gateway_owner_held_rc_guard_migration_pg_test.ts.
import assert from "node:assert/strict";
import { opts, psql, rows, setupFixtures } from "./common_ai_gateway_restart_race_support.ts";
import {
  asSafety,
  MIGRATION_PATH,
  processChain,
  psqlFile,
  ROLLBACK_PATH,
  SAFE,
  SAFE_END,
  safeEnd,
  session,
  setupPersonC,
  snapshotChain,
} from "./common_ai_gateway_owner_held_fixture.ts";

const BASE = ["20261010050613_ai_provider_budget_ledger.sql", "20261017120000_ai_consumer_call_store.sql", "20261017150000_ai_ledger_user_erasure.sql"]
  .map((f) => new URL(`../migrations/${f}`, import.meta.url).pathname);
const RPCS = ["public.ai_calls_abandon(jsonb)", "public.ai_calls_forget_user(jsonb)", "public.ai_calls_claim_held(jsonb)"];
const UNCHANGED = ["public.ai_calls_claim(jsonb)", "public.ai_calls_complete(jsonb)", "public.ai_calls_purge_content(jsonb)", "public.ai_calls_forget_system_brand(jsonb)",
  "public.ai_calls_recovery_candidates(jsonb)", "public.ai_ledger_erase_user(jsonb)", "ai_calls.call_transition()"];
const TOMB = { role: "postona.consult.reply", model: "gpt-6-luna", policyVersion: "r1", attempts: 0, estimatedCostUsd: 0, costBasis: "no_request" };

/** Catalog image of a function: oid, owner, definer, config, volatility, ACL, body md5. */
const fnImage = (sig: string, db?: string) => {
  const q = `select coalesce((select p.oid || '|' || p.proowner::regrole || '|' || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ','), '-') || '|' || p.provolatile::text || '|' || coalesce(p.proacl::text, '-') || '|' || md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('${sig}')), 'absent')`;
  return db ? dbRows(db, q) : rows(q);
};
async function dbRows(db: string, sql: string): Promise<string> {
  const o = await new Deno.Command("psql", {
    args: ["-X", "-h", Deno.env.get("GRR_PGHOST")!, "-p", Deno.env.get("GRR_PGPORT")!, "-U", Deno.env.get("GRR_PGSUPER")!, "-d", db, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(o.success, new TextDecoder().decode(o.stderr));
  return new TextDecoder().decode(o.stdout).trim();
}
/** A fresh database with the Supabase-like roles / default privileges and the three base migrations (lifecycle tests). */
async function freshDb(name: string): Promise<void> {
  await dbRows("postgres", `drop database if exists ${name} with (force)`);
  await dbRows("postgres", `create database ${name}`);
  await dbRows(name, `grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
  for (const f of BASE) assert.ok((await psqlFile(f, name)).ok, f);
}
const dropDb = (name: string) => dbRows("postgres", `drop database if exists ${name} with (force)`);
/** Everything the lifecycle tests compare: the touched and untouched functions, the table rows, the triggers. */
const stateOf = async (db: string) => ({
  fns: await Promise.all([...RPCS, ...UNCHANGED].map((s) => fnImage(s, db))),
  rows: await dbRows(db, `select md5(coalesce(string_agg(row_to_json(c)::text, ',' order by call_key), '')) from ai_calls.consumer_calls c`),
  triggers: await dbRows(db, `select string_agg(tgname || ':' || tgfoid::regproc, ',' order by tgname) from pg_trigger where tgrelid in ('ai_calls.consumer_calls'::regclass, 'ai_ledger.reservations'::regclass) and not tgisinternal`),
  aliases: await dbRows(db, `select count(*) from pg_proc where proname like '%unguarded%' or proname like 'ai_calls_claim_held%'`),
});

/** Each line a separate psql -c, i.e. a separate statement (and transaction, outside an explicit BEGIN), one session. */
async function statements(lines: string[]) {
  const o = await new Deno.Command("psql", {
    args: ["-X", "-h", Deno.env.get("GRR_PGHOST")!, "-p", Deno.env.get("GRR_PGPORT")!, "-U", Deno.env.get("GRR_PGSUPER")!, "-d", Deno.env.get("GRR_DB")!, "-Atq",
      "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", ...lines.flatMap((l) => ["-c", l])],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const err = new TextDecoder().decode(o.stderr).trim();
  return { ok: o.success, err, sqlstate: err.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] ?? null };
}

let before: string[] = [];

Deno.test({ name: "setup: shared fixtures, person C; the REAL migration applied with psql -f (catalog recorded before)", ...opts }, async () => {
  await setupFixtures();
  await setupPersonC();
  before = await Promise.all([...RPCS, ...UNCHANGED].map((s) => fnImage(s)));
  assert.equal(before[2], "absent", "no claim_held before the migration");
  const r = await psqlFile(MIGRATION_PATH);
  assert.ok(r.ok, r.err);
});

Deno.test({ name: "catalog: same OIDs / owners / ACLs for the replaced RPCs, new bodies only there; claim_held owned like them, definer, empty search_path, VOLATILE; untouched functions byte-identical; no alias without the guard", ...opts }, async () => {
  const after = await Promise.all([...RPCS, ...UNCHANGED].map((s) => fnImage(s)));
  for (const i of [0, 1]) {
    const [oid0, owner0, def0, cfg0, vol0, acl0] = before[i].split("|");
    const [oid1, owner1, def1, cfg1, vol1, acl1, md51] = after[i].split("|");
    assert.deepEqual([oid1, owner1, def1, cfg1, vol1, acl1], [oid0, owner0, def0, cfg0, vol0, acl0], RPCS[i]);
    assert.notEqual(md51, before[i].split("|")[6], `${RPCS[i]} body replaced`);
  }
  const [, heldOwner, heldDef, heldCfg, heldVol, heldAcl] = after[2].split("|");
  assert.deepEqual([heldOwner, heldDef, heldCfg, heldVol], [before[0].split("|")[1], "true", 'search_path=""', "v"]);
  assert.equal(heldAcl, `{${before[0].split("|")[1]}=X/${before[0].split("|")[1]},service_role=X/${before[0].split("|")[1]}}`);
  assert.deepEqual(after.slice(3), before.slice(3), "untouched functions are byte-identical");
  const GUARD = "\nbegin\n  if current_setting('transaction_isolation') <> 'read committed' then\n    raise exception 'AI_CALLS_REQUIRES_READ_COMMITTED: %'";
  for (const sig of RPCS) {
    const src = await rows(`select prosrc from pg_proc where oid = '${sig}'::regprocedure`);
    const at = src.indexOf(GUARD);
    assert.ok(at >= 0 && at === src.indexOf("\nbegin\n") && at < src.indexOf("perform "), `${sig}: the guard opens the body, before any lock, read or write`);
  }
  assert.match(await rows(`select prosrc from pg_proc where oid = 'public.ai_calls_forget_system_brand(jsonb)'::regprocedure`), /AI_CALLS_REQUIRES_READ_COMMITTED/);
  assert.match(await rows(`select prosrc from pg_proc where oid = 'public.ai_ledger_erase_user(jsonb)'::regprocedure`), /AI_LEDGER_ERASURE_REQUIRES_READ_COMMITTED/);
  assert.equal(await rows(`select count(*) from pg_proc where proname like '%unguarded%' or (proname like 'ai_calls_claim_held%' and oid <> 'public.ai_calls_claim_held(jsonb)'::regprocedure)`), "0");
});

Deno.test({ name: "ACL, effective: EXECUTE for service_role only (no grant option), not PUBLIC / anon / authenticated nor a role inheriting authenticated; service_role cannot touch the table or the helpers directly", ...opts }, async () => {
  for (const sig of RPCS) {
    assert.equal(await rows(`select coalesce(string_agg(coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type || case when a.is_grantable then '+g' else '' end, ',' order by 1), '-')
      from pg_proc p cross join lateral aclexplode(p.proacl) a left join pg_roles r on r.oid = a.grantee where p.oid = '${sig}'::regprocedure and a.grantee <> p.proowner`), "service_role:EXECUTE", sig);
    for (const [role, may] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
      assert.equal(await rows(`select has_function_privilege('${role}', '${sig}', 'EXECUTE')::text || has_function_privilege('${role}', '${sig}', 'EXECUTE WITH GRANT OPTION')::text`), may ? "truefalse" : "falsefalse", `${sig} ${role}`);
    }
    const anon = await psql(`set role anon; select ${sig.replace("(jsonb)", "")}('{}'::jsonb)`);
    assert.ok(!anon.ok && /permission denied/.test(anon.err), `${sig}: anon refused before the body`);
  }
  try {
    await rows(`create role g6r13_inherits_authenticated nologin; grant authenticated to g6r13_inherits_authenticated`);
    for (const sig of RPCS) assert.equal(await rows(`select has_function_privilege('g6r13_inherits_authenticated', '${sig}', 'EXECUTE')`), "f", sig);
  } finally {
    await rows(`drop role if exists g6r13_inherits_authenticated`);
  }
  for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    assert.equal(await rows(`select has_table_privilege('service_role', 'ai_calls.consumer_calls', '${priv}')`), "f", priv);
  }
  assert.equal(await rows(`select count(*) from pg_proc p where p.pronamespace = 'ai_calls'::regnamespace and has_function_privilege('service_role', p.oid, 'EXECUTE')`), "0", "no helper is executable");
});

Deno.test({ name: "the guard: abandon / forget_user / claim_held refuse REPEATABLE READ, SERIALIZABLE and READ UNCOMMITTED with P0001 before any effect; the session default does not matter, the transaction's isolation does; a nested SECURITY DEFINER caller cannot pass", ...opts }, async () => {
  const p = { call_key: "h5m2_" + "f".repeat(64), tenant_tag: "f".repeat(64), fingerprint: "f".repeat(64), application: "postona", feature: "postona:consult", subject_kind: "user", user_id: "00000000-0000-4000-8000-0000000000ff", brand_ref: "brand_c" };
  const claimed = JSON.parse(await rows(`set role service_role; select public.ai_calls_claim($j$${JSON.stringify(p)}$j$::jsonb)`));
  await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set created_at = created_at - interval '1900 seconds' where call_key = '${p.call_key}'`);
  const image = () => rows(`select xmin::text || '|' || row_to_json(c)::text from ai_calls.consumer_calls c where call_key = '${p.call_key}'`);
  const calls: Array<[string, unknown]> = [
    ["ai_calls_abandon", { call_key: p.call_key, audit: { ...TOMB, callId: p.call_key, tenantTag: p.tenant_tag, feature: p.feature } }],
    ["ai_calls_forget_user", { user_id: p.user_id }],
    ["ai_calls_claim_held", { ...p, owner: claimed.owner }],
  ];
  const row0 = await image();
  for (const isolation of ["repeatable read", "serializable", "read uncommitted"]) {
    for (const [fn, q] of calls) {
      const r = await session(`set role service_role; begin isolation level ${isolation}; select public.${fn}($j$${JSON.stringify(q)}$j$::jsonb); commit;`);
      assert.deepEqual([r.ok, r.sqlstate], [false, "P0001"], `${fn} ${isolation}: ${r.err}`);
      assert.match(r.err, new RegExp(`AI_CALLS_REQUIRES_READ_COMMITTED: ${isolation}`));
    }
  }
  assert.equal(await image(), row0, "no effect at all");
  // Default vs actual: a REPEATABLE READ session default (each statement its own transaction) is refused; resetting the
  // default inside a REPEATABLE READ transaction changes nothing. (One psql -c string would be ONE transaction.)
  for (const lines of [
    [`set default_transaction_isolation = 'repeatable read'`, `set role service_role`, `select public.ai_calls_abandon($j$${JSON.stringify(calls[0][1])}$j$::jsonb)`],
    [`set role service_role`, `begin isolation level repeatable read`, `set default_transaction_isolation = 'read committed'`, `select public.ai_calls_abandon($j$${JSON.stringify(calls[0][1])}$j$::jsonb)`, `commit`],
  ]) {
    const r = await statements(lines);
    assert.deepEqual([r.ok, r.sqlstate], [false, "P0001"], lines.join("; "));
  }
  // A SECURITY DEFINER wrapper owned by the superuser, called in REPEATABLE READ: still refused.
  await rows(`create function public.g6r13_nested_abandon(p jsonb) returns jsonb language sql security definer set search_path = '' as $$ select public.ai_calls_abandon(p) $$`);
  try {
    const r = await session(`begin isolation level repeatable read; select public.g6r13_nested_abandon($j$${JSON.stringify(calls[0][1])}$j$::jsonb); commit;`);
    assert.deepEqual([r.ok, r.sqlstate], [false, "P0001"], r.err);
  } finally {
    await rows(`drop function public.g6r13_nested_abandon(jsonb)`);
  }
  assert.equal(await image(), row0);
  // READ COMMITTED (this cluster's default) still works: the stale row with nothing open is abandoned, then forgotten.
  assert.deepEqual(JSON.parse(await rows(`set role service_role; select public.ai_calls_claim_held($j$${JSON.stringify(calls[2][1])}$j$::jsonb)`)), { held: true });
  assert.deepEqual(JSON.parse(await rows(`set role service_role; select public.ai_calls_abandon($j$${JSON.stringify(calls[0][1])}$j$::jsonb)`)), { abandoned: true });
  assert.equal(JSON.parse(await rows(`set role service_role; select public.ai_calls_forget_user($j$${JSON.stringify(calls[1][1])}$j$::jsonb)`)).forgotten, true);
});

Deno.test({ name: "SAFETY on the real migration (the baseline's counterexamples): READ COMMITTED unchanged; a REPEATABLE READ / SERIALIZABLE / READ UNCOMMITTED recovery is refused and A's call stays A's; end to end the non-owner sends nothing", ...opts }, async () => {
  for (const [isolation, n] of [["read committed", "a"], ["repeatable read", "b"], ["serializable", "c"], ["read uncommitted", "d"]] as const) {
    const o = await snapshotChain(isolation, n);
    assert.deepEqual(asSafety(o), SAFE, `${isolation}: ${JSON.stringify(o)}`);
    if (isolation !== "read committed") assert.equal((o.abandon as { error?: string }).error, "P0001", isolation);
  }
  const e2e = await processChain("repeatable read", "op-g613-e2e-rr");
  assert.deepEqual(safeEnd(e2e), SAFE_END, JSON.stringify(e2e));
  assert.deepEqual([e2e.abandon, e2e.forgot, e2e.a, e2e.sends], ["P0001", false, "OK", 1], "A, still the owner, sends its one request");
});

Deno.test({ name: "lifecycle in fresh databases: apply / reapply are identical and keep rows, triggers, OIDs and ACLs; any drifted prestate (body, grant, overload, owner) is refused with nothing changed; a failure AFTER the replacement rolls the whole migration back; the local-only rollback restores exactly the original and refuses a second run", ...opts }, async () => {
  const db = `g6r13_life_${Deno.pid}`;
  try {
    await freshDb(db);
    await dbRows(db, `set role service_role; select public.ai_calls_claim('{"call_key": "h5m2_${"e".repeat(64)}", "tenant_tag": "${"e".repeat(64)}", "fingerprint": "${"e".repeat(64)}", "application": "postona", "feature": "postona:consult", "subject_kind": "system"}'::jsonb)`);
    const original = await stateOf(db);
    assert.ok((await psqlFile(MIGRATION_PATH, db)).ok);
    const applied = await stateOf(db);
    assert.deepEqual([applied.rows, applied.triggers], [original.rows, original.triggers], "rows and triggers untouched");
    for (const i of [0, 1]) assert.equal(applied.fns[i].split("|").slice(0, 6).join("|"), original.fns[i].split("|").slice(0, 6).join("|"), "same oid / owner / shape / ACL");
    assert.deepEqual(applied.fns.slice(3), original.fns.slice(3));
    const re = await psqlFile(MIGRATION_PATH, db);
    assert.ok(re.ok, re.err);
    assert.deepEqual(await stateOf(db), applied, "a re-run changes nothing (no wider grant)");
    // The local rollback: back to the exact original (same OIDs, ACLs, bodies), claim_held gone; a second run refuses.
    const rb = await psqlFile(ROLLBACK_PATH, db);
    assert.ok(rb.ok, rb.err);
    const back = await stateOf(db);
    assert.deepEqual(back, original, "exactly the original state");
    const rb2 = await psqlFile(ROLLBACK_PATH, db);
    assert.deepEqual([rb2.ok, rb2.sqlstate, /AI_CALLS_OWNER_HELD_ROLLBACK_PRESTATE/.test(rb2.err)], [false, "P0001", true]);
    assert.deepEqual(await stateOf(db), original);
    // Drifted prestates, each in a fresh database: refused (P0001) with nothing changed.
    const drifts: Array<[string, string]> = [
      ["a changed abandon body", `create or replace function public.ai_calls_abandon(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $f$ begin return '{}'::jsonb; end $f$`],
      ["a widened grant", `grant execute on function public.ai_calls_forget_user(jsonb) to authenticated`],
      ["another claim_held overload", `create function public.ai_calls_claim_held(p text) returns jsonb language sql as $f$ select '{}'::jsonb $f$`],
    ];
    for (const [label, drift] of drifts) {
      await freshDb(db);
      await dbRows(db, drift);
      const drifted = await stateOf(db);
      const r = await psqlFile(MIGRATION_PATH, db);
      assert.deepEqual([r.ok, r.sqlstate, /AI_CALLS_OWNER_HELD_PRESTATE/.test(r.err)], [false, "P0001", true], `${label}: ${r.err}`);
      assert.deepEqual(await stateOf(db), drifted, `${label}: nothing changed`);
    }
    // Not the owner: refused before anything.
    await freshDb(db);
    await dbRows(db, `create role g6r13_not_owner nologin; grant create, usage on schema public to g6r13_not_owner`);
    try {
      const o = await new Deno.Command("psql", {
        args: ["-X", "-h", Deno.env.get("GRR_PGHOST")!, "-p", Deno.env.get("GRR_PGPORT")!, "-U", Deno.env.get("GRR_PGSUPER")!, "-d", db, "-Atq", "-v", "ON_ERROR_STOP=1",
          "-c", "set role g6r13_not_owner", "-f", MIGRATION_PATH],
        env: { LC_ALL: "C" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const err = new TextDecoder().decode(o.stderr);
      assert.ok(!o.success && /AI_CALLS_OWNER_HELD_PRESTATE: run as the ai_calls owner/.test(err), err);
      assert.equal(await fnImage("public.ai_calls_claim_held(jsonb)", db), "absent");
    } finally {
      await dbRows(db, `revoke create, usage on schema public from g6r13_not_owner; drop role g6r13_not_owner`);
    }
    // A failure AFTER the bodies were replaced (the postcondition finds authenticated reaching service_role): all rolled back.
    const clean = await stateOf(db);
    await dbRows(db, `grant service_role to authenticated`);
    try {
      const r = await psqlFile(MIGRATION_PATH, db);
      // The effective-privilege postcondition (authenticated now inherits service_role's EXECUTE) stops it first.
      assert.deepEqual([r.ok, /P0001: AI_CALLS_OWNER_HELD_POST: EXECUTE of ai_calls_abandon\(jsonb\) for authenticated is wrong/.test(r.err)], [false, true], r.err);
      assert.deepEqual(await stateOf(db), clean, "the replaced bodies and the new function were rolled back with it");
    } finally {
      await dbRows(db, `revoke service_role from authenticated`);
    }
  } finally {
    await dropDb(db);
  }
});
