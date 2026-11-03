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
    // authenticated reaching service_role: since G6-14 the PRESTATE ACL check refuses it before anything changes.
    // (A failure AFTER the replacement, rolled back as a whole, is shown by the G6-14 probe test below.)
    const clean = await stateOf(db);
    await dbRows(db, `grant service_role to authenticated`);
    try {
      const r = await psqlFile(MIGRATION_PATH, db);
      assert.deepEqual([r.ok, /P0001: AI_CALLS_OWNER_HELD_PRESTATE: ACL drift: authenticated reaches service_role/.test(r.err)], [false, true], r.err);
      assert.deepEqual(await stateOf(db), clean, "nothing changed");
    } finally {
      await dbRows(db, `revoke service_role from authenticated`);
    }
    // A failure only the POSTCONDITIONS can see: a DDL event trigger grants claim_held to authenticated right after
    // the migration's own REVOKE. The exact-ACL postcondition refuses it and the whole migration rolls back.
    await freshDb(db);
    await dbRows(db, `create function public.g6r14_regrant() returns event_trigger language plpgsql as $f$
        begin
          if to_regprocedure('public.ai_calls_claim_held(jsonb)') is not null then
            execute 'grant execute on function public.ai_calls_claim_held(jsonb) to authenticated';
          end if;
        end $f$;
      create event trigger g6r14_regrant on ddl_command_end when tag in ('REVOKE') execute function public.g6r14_regrant();`);
    const beforeTrigger = await stateOf(db);
    const r = await psqlFile(MIGRATION_PATH, db);
    assert.deepEqual([r.ok, /P0001: AI_CALLS_OWNER_HELD_POST: unexpected grant ai_calls_claim_held authenticated:EXECUTE/.test(r.err)], [false, true], r.err);
    assert.deepEqual(await stateOf(db), beforeTrigger, "the replaced bodies and the new function were rolled back with it");
  } finally {
    await dropDb(db);
  }
});

// ---------------------------------------------------------------------------------------------------------
// G6-14 (H4 #331 P2): ACL drift on the call store / ledger must stop the migration, before and after, with no repair.
// ---------------------------------------------------------------------------------------------------------

/** Every privilege fact the drift tests compare: schema / relation / column / helper ACLs, default ACLs, app-role memberships. */
const aclImage = (db: string) =>
  dbRows(db, `select concat_ws(' || ',
    (select string_agg(n.nspname || '=' || coalesce(n.nspacl::text, '-'), ';' order by n.nspname) from pg_namespace n where n.nspname in ('ai_calls', 'ai_ledger')),
    (select string_agg(c.relname || '=' || coalesce(c.relacl::text, '-'), ';' order by c.relname) from pg_class c where c.relnamespace in ('ai_calls'::regnamespace, 'ai_ledger'::regnamespace)),
    (select count(*)::text from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace in ('ai_calls'::regnamespace, 'ai_ledger'::regnamespace) and a.attacl is not null),
    (select string_agg(f.oid::regprocedure::text || '=' || coalesce(f.proacl::text, '-'), ';' order by f.oid::regprocedure::text) from pg_proc f where f.pronamespace in ('ai_calls'::regnamespace, 'ai_ledger'::regnamespace)),
    (select coalesce(string_agg(d.defaclrole::regrole::text || '@' || d.defaclnamespace::regnamespace::text || '/' || d.defaclobjtype::text || '=' || d.defaclacl::text, ';' order by d.defaclrole::regrole::text, d.defaclnamespace, d.defaclobjtype), '-') from pg_default_acl d),
    (select coalesce(string_agg(m.roleid::regrole::text || '>' || m.member::regrole::text || ':' || m.inherit_option || m.set_option, ';' order by m.roleid::regrole::text, m.member::regrole::text), '-')
       from pg_auth_members m where m.member in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))))`);
/** Feed a (mutated) migration text to psql on stdin, as the owner. */
async function psqlText(sql: string, db: string) {
  const child = new Deno.Command("psql", {
    args: ["-X", "-h", Deno.env.get("GRR_PGHOST")!, "-p", Deno.env.get("GRR_PGPORT")!, "-U", Deno.env.get("GRR_PGSUPER")!, "-d", db, "-Atq", "-v", "ON_ERROR_STOP=1"],
    env: { LC_ALL: "C" },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(sql));
  await w.close();
  const o = await child.output();
  return { ok: o.success, err: new TextDecoder().decode(o.stderr) };
}
const H4_DRIFT = `grant select, insert, update, delete on ai_calls.consumer_calls to service_role;
  grant execute on function ai_calls.input_text(jsonb, text, boolean, text) to service_role`;

Deno.test({ name: "G6-14 ACL drift is refused before anything changes, with nothing repaired: H4's exact grants, PUBLIC, schema USAGE without a table grant, a column grant, a helper grant, a grant option, an inherited role, a default privilege, the ledger's tables, an application-role owner, a SECURITY DEFINER helper, a path to the owner, a SET-ROLE-only path", ...opts }, async () => {
  const db = `g6r14_drift_${Deno.pid}`;
  const owner = Deno.env.get("GRR_PGSUPER")!;
  const drifts: Array<[string, string, string, RegExp]> = [
    ["H4: service_role on the table and a helper", H4_DRIFT, "", /relation grants (\S+ \S+, )*consumer_calls service_role:INSERT/],
    ["PUBLIC reads the table", `grant select on ai_calls.consumer_calls to public`, "", /relation grants consumer_calls PUBLIC:SELECT/],
    ["anon USAGE on the schema, no table grant", `grant usage on schema ai_calls to anon`, "", /schema ai_calls grants anon:USAGE/],
    ["a column grant to authenticated", `grant select (user_id) on ai_calls.consumer_calls to authenticated`, "", /a column grant in ai_calls/],
    ["PUBLIC executes a helper", `grant execute on function ai_calls.tombstone(jsonb) to public`, "", /helper grants tombstone PUBLIC:EXECUTE/],
    ["a grant option on a helper", `grant execute on function ai_calls.input_uuid(jsonb, text, boolean) to service_role with grant option`, "", /helper grants input_uuid service_role:EXECUTE\+grant/],
    ["an inherited role reading the ledger", `create role g6r14_reader nologin; grant select on ai_ledger.reservations to g6r14_reader; grant g6r14_reader to authenticated`,
      `revoke g6r14_reader from authenticated; drop owned by g6r14_reader; drop role g6r14_reader`, /relation grants reservations g6r14_reader:SELECT/],
    ["a default privilege in ai_calls", `alter default privileges in schema ai_calls grant select on tables to service_role`, "", /a default privilege in ai_calls/],
    ["service_role writes the ledger", `grant update on ai_ledger.reservations to service_role`, "", /relation grants reservations service_role:UPDATE/],
    ["a relation owned by service_role", `alter table ai_ledger.usage_events owner to service_role`, "", /ai_ledger has an application-role or mixed owner/],
    ["a SECURITY DEFINER helper", `alter function ai_calls.tombstone(jsonb) security definer`, "", /a SECURITY DEFINER helper in ai_calls/],
    ["service_role reaches the owner", `grant ${owner} to service_role`, `revoke ${owner} from service_role`, /service_role (can use schema ai_(calls|ledger)|reaches)/],
    ["authenticated can SET ROLE service_role (no inheritance)", `grant service_role to authenticated with inherit false`, `revoke service_role from authenticated`, /authenticated reaches service_role/],
  ];
  try {
    for (const [label, drift, undo, why] of drifts) {
      await freshDb(db);
      await dbRows(db, drift);
      try {
        const [fns, acls] = [await stateOf(db), await aclImage(db)];
        const r = await psqlFile(MIGRATION_PATH, db);
        assert.deepEqual([r.ok, r.sqlstate], [false, "P0001"], `${label}: ${r.err}`);
        assert.match(r.err, /AI_CALLS_OWNER_HELD_PRESTATE: ACL drift: /, `${label}: ${r.err}`);
        assert.match(r.err, why, `${label}: ${r.err}`);
        assert.deepEqual([await stateOf(db), await aclImage(db)], [fns, acls], `${label}: nothing changed, nothing repaired`);
      } finally {
        if (undo) await dbRows(db, undo);
      }
    }
  } finally {
    await dropDb(db);
  }
});

Deno.test({ name: "G6-14 probes on the REAL migration text: without the PRESTATE ACL check, the POST check refuses the same drift and the whole migration rolls back; without both, H4's drift passes (so the check is what stops it); on a clean database the checks pass and leave no temporary function", ...opts }, async () => {
  const text = await Deno.readTextFile(MIGRATION_PATH);
  const pre = "  perform pg_temp.ai_calls_owner_held_acl_check('PRESTATE');\n";
  const post = "  perform pg_temp.ai_calls_owner_held_acl_check('POST');\n";
  assert.equal(text.split(pre).length - 1, 1);
  assert.equal(text.split(post).length - 1, 1);
  const db = `g6r14_probe_${Deno.pid}`;
  try {
    await freshDb(db);
    await dbRows(db, H4_DRIFT);
    const [fns, acls] = [await stateOf(db), await aclImage(db)];
    const noPre = await psqlText(text.replace(pre, "  null;\n"), db);
    assert.ok(!noPre.ok && /AI_CALLS_OWNER_HELD_POST: ACL drift: relation grants consumer_calls service_role/.test(noPre.err), noPre.err);
    assert.deepEqual([await stateOf(db), await aclImage(db)], [fns, acls], "the POST failure rolled back the replaced bodies and the new function");
    const neither = await psqlText(text.replace(pre, "  null;\n").replace(post, "  null;\n"), db);
    assert.ok(neither.ok, `without the two checks H4's drift is accepted: ${neither.err}`);
    assert.equal(await dbRows(db, `select has_table_privilege('service_role', 'ai_calls.consumer_calls', 'SELECT')::text || (to_regprocedure('public.ai_calls_claim_held(jsonb)') is not null)::text`), "truetrue");
    await freshDb(db);
    const clean = await psqlFile(MIGRATION_PATH, db);
    assert.ok(clean.ok, clean.err);
    assert.equal(await dbRows(db, `select count(*) from pg_proc where proname = 'ai_calls_owner_held_acl_check'`), "0", "the temporary check is gone");
  } finally {
    await dropDb(db);
  }
});

// ---------------------------------------------------------------------------------------------------------
// G6-15 (H4 #331 P2): a GLOBAL default privilege (pg_default_acl, defaclnamespace = 0) of a role that can create
// objects in ai_calls / ai_ledger sets the ACL of every object it creates there later. Refused like any other drift.
// ---------------------------------------------------------------------------------------------------------

const H4_GLOBAL = (owner: string) => `alter default privileges for role ${owner} grant select on tables to service_role`;
/** As the owner: a table, a sequence and a function created in ai_calls AFTER the migration, and what each grants. */
async function futureObjects(db: string) {
  await dbRows(db, `create table ai_calls.g6r15_future_t (x int); create sequence ai_calls.g6r15_future_s;
    create function ai_calls.g6r15_future_f() returns int language sql as $f$ select 1 $f$`);
  return dbRows(db, `select concat_ws(' ',
    coalesce((select relacl::text from pg_class where oid = 'ai_calls.g6r15_future_t'::regclass), 'default'),
    coalesce((select relacl::text from pg_class where oid = 'ai_calls.g6r15_future_s'::regclass), 'default'),
    coalesce((select proacl::text from pg_proc where oid = 'ai_calls.g6r15_future_f()'::regprocedure), 'default'),
    has_table_privilege('service_role', 'ai_calls.g6r15_future_t', 'SELECT')::text,
    has_sequence_privilege('service_role', 'ai_calls.g6r15_future_s', 'USAGE')::text)`);
}

Deno.test({ name: "G6-15 global default privileges are refused before anything changes, with nothing repaired: H4's owner SELECT ON TABLES to service_role, sequences, functions (beyond the built-in PUBLIC EXECUTE), a grant option, PUBLIC on tables, types, an inherited role, a member of the owner, another superuser, global + schema-scoped together", ...opts }, async () => {
  const db = `g6r15_global_${Deno.pid}`;
  const owner = Deno.env.get("GRR_PGSUPER")!;
  const drifts: Array<[string, string, string, RegExp]> = [
    ["H4: the owner's tables to service_role", H4_GLOBAL(owner), "", new RegExp(`reaching ai_calls grants ${owner} r service_role:SELECT`)],
    ["sequences USAGE / UPDATE to service_role", `alter default privileges for role ${owner} grant usage, update on sequences to service_role`, "", / S service_role:(USAGE|UPDATE)/],
    ["functions to service_role (PUBLIC is the built-in default)", `alter default privileges for role ${owner} grant execute on functions to service_role`, "", / f service_role:EXECUTE/],
    ["functions to authenticated with a grant option", `alter default privileges for role ${owner} grant execute on functions to authenticated with grant option`, "", / f authenticated:EXECUTE\+grant/],
    ["tables to PUBLIC", `alter default privileges for role ${owner} grant select on tables to public`, "", / r PUBLIC:SELECT/],
    ["types to anon", `alter default privileges for role ${owner} grant usage on types to anon`, "", / T anon:USAGE/],
    ["an inherited role", `create role g6r15_reader nologin; alter default privileges for role ${owner} grant select on tables to g6r15_reader; grant g6r15_reader to authenticated`,
      `revoke g6r15_reader from authenticated; drop owned by g6r15_reader; drop role g6r15_reader`, / r g6r15_reader:SELECT/],
    ["a member of the owner (it can create there)", `create role g6r15_member nologin; grant ${owner} to g6r15_member; alter default privileges for role g6r15_member grant select on tables to service_role`,
      `drop owned by g6r15_member; revoke ${owner} from g6r15_member; drop role g6r15_member`, /grants g6r15_member r service_role:SELECT/],
    ["another superuser", `create role g6r15_super superuser nologin; alter default privileges for role g6r15_super grant execute on functions to authenticated`,
      `drop owned by g6r15_super; drop role g6r15_super`, /grants g6r15_super f authenticated:EXECUTE/],
    ["global and schema-scoped together", `${H4_GLOBAL(owner)}; alter default privileges for role ${owner} in schema ai_ledger grant select on tables to service_role`, "",
      /(a global default privilege reaching ai_calls|a default privilege in ai_ledger)/],
  ];
  try {
    for (const [label, drift, undo, why] of drifts) {
      await freshDb(db);
      await dbRows(db, drift);
      try {
        const [fns, acls] = [await stateOf(db), await aclImage(db)];
        const r = await psqlFile(MIGRATION_PATH, db);
        assert.deepEqual([r.ok, r.sqlstate], [false, "P0001"], `${label}: ${r.err}`);
        assert.match(r.err, /AI_CALLS_OWNER_HELD_PRESTATE: ACL drift: /, `${label}: ${r.err}`);
        assert.match(r.err, why, `${label}: ${r.err}`);
        assert.doesNotMatch(r.err, / f PUBLIC:EXECUTE/, `${label}: the built-in PUBLIC EXECUTE is not the drift`);
        assert.deepEqual([await stateOf(db), await aclImage(db)], [fns, acls], `${label}: nothing changed, nothing repaired`);
      } finally {
        if (undo) await dbRows(db, undo);
      }
    }
  } finally {
    await dropDb(db);
  }
});

Deno.test({ name: "G6-15 what stays accepted and what later objects get: a clean database applies and re-applies, and a table / sequence created later grants nothing (a function only the built-in PUBLIC EXECUTE, unusable without the schema); stricter global rows and a role that cannot create there are accepted untouched; a global default added DURING the migration is refused by POST with everything rolled back; without the new check H4's global default passes and a later table is readable", ...opts }, async () => {
  const db = `g6r15_accept_${Deno.pid}`;
  const owner = Deno.env.get("GRR_PGSUPER")!;
  try {
    // Clean: apply, re-apply, then later objects.
    await freshDb(db);
    for (const run of ["apply", "re-apply"]) {
      const r = await psqlFile(MIGRATION_PATH, db);
      assert.ok(r.ok, `${run}: ${r.err}`);
    }
    assert.equal(await futureObjects(db), "default default default false false");
    for (const role of ["service_role", "anon", "authenticated"]) {
      const call = await psqlText(`set role ${role}; select ai_calls.g6r15_future_f();`, db);
      assert.ok(!call.ok && /permission denied for schema ai_calls/.test(call.err), `${role}: ${call.err}`);
    }
    // Stricter rows (REVOKE) of the owner and of another superuser, that superuser's grant option to itself (its own
    // objects' rights), and a grant by a role that cannot create here.
    await freshDb(db);
    await dbRows(db, `alter default privileges for role ${owner} revoke execute on functions from public;
      create role g6r15_super superuser nologin; alter default privileges for role g6r15_super revoke execute on functions from public;
      alter default privileges for role g6r15_super grant select on tables to g6r15_super with grant option;
      create role g6r15_other nologin; alter default privileges for role g6r15_other grant select on tables to service_role`);
    try {
      assert.equal(await dbRows(db, `select has_schema_privilege('g6r15_other', 'ai_calls', 'CREATE')::text || has_schema_privilege('g6r15_other', 'ai_ledger', 'CREATE')::text`), "falsefalse");
      const acls = await aclImage(db);
      const r = await psqlFile(MIGRATION_PATH, db);
      assert.ok(r.ok, r.err);
      assert.equal((await aclImage(db)).split(" || ")[4], acls.split(" || ")[4], "the global rows are left as they were");
      assert.equal(await futureObjects(db), `default default {${owner}=X/${owner}} false false`, "the owner's REVOKE applies: no PUBLIC EXECUTE");
    } finally {
      await dbRows(db, `drop owned by g6r15_super, g6r15_other; drop role g6r15_super; drop role g6r15_other`);
    }
    // POST: a DDL event trigger adds H4's global default right after the migration's REVOKE.
    await freshDb(db);
    await dbRows(db, `create function public.g6r15_add_global() returns event_trigger language plpgsql as $f$
        begin execute '${H4_GLOBAL(owner)}'; end $f$;
      create event trigger g6r15_add_global on ddl_command_end when tag in ('REVOKE') execute function public.g6r15_add_global();`);
    const [fns, acls] = [await stateOf(db), await aclImage(db)];
    const post = await psqlFile(MIGRATION_PATH, db);
    assert.ok(!post.ok && /P0001: AI_CALLS_OWNER_HELD_POST: ACL drift: a global default privilege reaching ai_calls grants \S+ r service_role:SELECT/.test(post.err), post.err);
    assert.deepEqual([await stateOf(db), await aclImage(db)], [fns, acls], "the new global row, the replaced bodies and claim_held were all rolled back");
    // The counterexample, kept: the REAL migration text without the new check accepts H4's global default.
    const text = await Deno.readTextFile(MIGRATION_PATH);
    const check = "    if v_extra is not null then\n      raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: a global default privilege";
    assert.equal(text.split(check).length - 1, 1);
    await freshDb(db);
    await dbRows(db, H4_GLOBAL(owner));
    const without = await psqlText(text.replace(check, check.replace("if v_extra is not null then", "if false then")), db);
    assert.ok(without.ok, `without the G6-15 check H4's global default is accepted: ${without.err}`);
    assert.equal(await dbRows(db, `select (to_regprocedure('public.ai_calls_claim_held(jsonb)') is not null)::text`), "true");
    assert.match(await futureObjects(db), / true false$/, "and a table created later is readable by service_role");
  } finally {
    await dropDb(db);
  }
});
