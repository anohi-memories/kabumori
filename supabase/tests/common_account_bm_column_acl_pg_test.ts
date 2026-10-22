// G5-19: G3's six questions on public.brand_memberships column / system-column ACLs, measured on two throw-away PG17 worlds built from the REAL
// membership migration: "pre" (the old default grants) and "post" (2026-10-30, none). G3's PR #370 forward candidate is the pinned 547d9f92 text
// (BM_G3_001, written by the runner with `git show`); G5's PR #303 candidate is this branch's file. A local fact about the SQL; nothing about managed
// or production, no G3 / G4 / G6 file changed. Needs CAL_E2E=1 and the runner's environment.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const repo = env('BM_REPO');
const owner = env('BM_OWNER');
const att = env('BM_ATT');
const superUser = env('PGSUPER');
const PRE = env('BM_DB_PRE');
const POST = env('BM_DB_POST');
const decoder = new TextDecoder();
globalThis.fetch = (() => { throw new Error('the G5-19 tests make no network request'); }) as typeof fetch;
const test_ = enabled ? test : test.skip;

type Result = { ok: boolean; out: string; error: string };
const args = (db: string, user: string, statement: string) =>
  ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-d', db, '-U', user, '-c', statement];
async function psql(db: string, statement: string, user = owner): Promise<Result> {
  const out = await new Deno.Command('psql', { args: args(db, user, statement), stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
const spawn = (db: string, statement: string, user = owner) =>
  new Deno.Command('psql', { args: args(db, user, statement), stdout: 'piped', stderr: 'piped' }).spawn();
async function sql(db: string, statement: string, user = owner): Promise<string> {
  const r = await psql(db, statement, user);
  assert.ok(r.ok, `${statement}\n${r.error}`);
  return r.out;
}
const fails = async (db: string, statement: string, pattern: RegExp, user = owner) => {
  const r = await psql(db, statement, user);
  assert.ok(!r.ok, `expected a failure: ${statement}`);
  assert.match(r.error, pattern);
};
async function runFile(db: string, path: string, user = owner): Promise<Result> {
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-U', user, '-f', path], stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}

const T = 'public.brand_memberships';
const G5_001 = `${repo}/supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql`;
const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000b2';
const B1 = 'b_one';
const B2 = 'b_two';
const SYS = 'tableoid, cmax, xmax, cmin, xmin, ctid';
const priv = (db: string, role: string, p: string) => sql(db, `select has_table_privilege('${role}', '${T}', '${p}')`);
const anyCol = (db: string, role: string, p: string) => sql(db, `select has_any_column_privilege('${role}', '${T}', '${p}')`);
const exposure = (db: string) => sql(db, `select coalesce(private.account_lifecycle_owner_epoch_exposure(), 'NULL')`);
const epoch = (db: string, brand: string) => sql(db, `select coalesce(private.account_lifecycle_brand_owner_epoch('${brand}')::text, 'NULL')`);
const columnAcls = (db: string) => sql(db, `select count(*) from pg_attribute where attrelid = '${T}'::regclass and attacl is not null`);
const asUser = (user: string, body: string) => `begin; set local role authenticated; set local request.jwt.claim.sub = '${user}'; ${body}; commit`;

test_('Q6: the real membership migration in the two worlds (old default grants vs 2026-10-30)', async () => {
  // pre: the defaults gave everything; the migration takes INSERT / UPDATE / DELETE from the end-user roles and everything from anon
  assert.equal(await priv(PRE, 'authenticated', 'SELECT'), 't');
  for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal(await priv(PRE, 'authenticated', p), 't', `pre authenticated ${p}`);
  for (const p of ['INSERT', 'UPDATE', 'DELETE']) assert.equal(await priv(PRE, 'authenticated', p), 'f', `pre authenticated ${p}`);
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    assert.equal(await priv(PRE, 'service_role', p), 't', `pre service_role ${p}`);
    assert.equal(await priv(PRE, 'anon', p), 'f', `pre anon ${p}`);
  }
  // post: only the migration's explicit grant is left
  assert.equal(await priv(POST, 'authenticated', 'SELECT'), 't');
  for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal(await priv(POST, 'authenticated', p), 'f', `post authenticated ${p}`);
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    assert.equal(await priv(POST, 'service_role', p), 'f', `post service_role ${p}`);
    assert.equal(await priv(POST, 'anon', p), 'f', `post anon ${p}`);
  }
  for (const db of [PRE, POST]) {
    assert.equal(await sql(db, `select pg_get_userbyid(relowner) = '${owner}' and relrowsecurity from pg_class where oid = '${T}'::regclass`), 't', 'owner, RLS');
    assert.equal(await columnAcls(db), '0', 'no column ACL');
  }
});

test_('Q6: G3 001 (pinned 547d9f92) and G5 001 (PR #303) in the two worlds', async () => {
  const g3 = env('BM_G3_001');
  assert.match(Deno.readTextFileSync(g3), /BM_PRIV_POSTCONDITION_SERVICE_ROLE_DML_LOST/u, 'the pinned G3 file');
  // pre: G5 refuses until G3's revoke, then installs
  let r = await runFile(PRE, G5_001);
  assert.ok(!r.ok && r.error.includes('OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS'), r.error);
  r = await runFile(PRE, g3);
  assert.ok(r.ok, r.error);
  assert.match(r.out, /^BM_PRIV_PRESTATE v2\|/mu);
  for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal(await priv(PRE, 'authenticated', p), 'f', `pre after G3: authenticated ${p}`);
  assert.equal(await priv(PRE, 'service_role', 'TRIGGER'), 'f');
  assert.equal(await priv(PRE, 'service_role', 'DELETE'), 't');
  r = await runFile(PRE, G5_001);
  assert.ok(r.ok, r.error);
  assert.equal(await exposure(PRE), 'NULL');
  // post: G3's postcondition refuses (service_role never had DML here) and changes nothing; G5 installs without it
  const before = await sql(POST, `select coalesce(relacl::text, '') from pg_class where oid = '${T}'::regclass`);
  r = await runFile(POST, g3);
  assert.ok(!r.ok && r.error.includes('BM_PRIV_POSTCONDITION_SERVICE_ROLE_DML_LOST'), r.error);
  assert.equal(await sql(POST, `select coalesce(relacl::text, '') from pg_class where oid = '${T}'::regclass`), before, 'G3 left the ACL as it was');
  r = await runFile(POST, G5_001);
  assert.ok(r.ok, r.error);
  assert.equal(await exposure(POST), 'NULL');
  // the seed: two workspaces, each with one owner; U1 cannot see B2 under RLS
  for (const db of [PRE, POST]) {
    await sql(db, `insert into auth.users values ('${U1}'), ('${U2}'); insert into public.brands (id) values ('${B1}'), ('${B2}');
      insert into ${T} (brand_id, user_id, role) values ('${B1}', '${U1}', 'owner'), ('${B2}', '${U2}', 'owner')`);
    assert.notEqual(await epoch(db, B1), 'NULL');
    assert.equal(await sql(db, asUser(U1, `select string_agg(brand_id, ',') from ${T}`)), B1);
  }
});

test_('Q2: the L-1 exposure check sees table grants, not column grants (per read, on the installed candidate)', async () => {
  const e1 = await epoch(PRE, B1);
  const columnGrants: Array<[string, string]> = [
    ['REFERENCES', 'grant references (brand_id, user_id)'], ['UPDATE', 'grant update (role)'], ['INSERT', 'grant insert (brand_id, user_id, role)'],
  ];
  for (const [p, grant] of columnGrants) {
    await sql(PRE, `${grant} on ${T} to authenticated`);
    assert.equal(await priv(PRE, 'authenticated', p), 'f', `${p}: has_table_privilege`);
    assert.equal(await anyCol(PRE, 'authenticated', p), 't', `${p}: has_any_column_privilege`);
    assert.equal(await exposure(PRE), 'NULL', `${p}: the column grant is not seen`);
    assert.equal(await epoch(PRE, B1), e1, `${p}: the getter keeps answering`);
    await sql(PRE, `revoke all (brand_id, user_id, role) on ${T} from authenticated`);
  }
  assert.equal(await columnAcls(PRE), '0');
  // the same privilege at table level is seen at the very next read, and the getter refuses
  await sql(PRE, `grant references on ${T} to authenticated`);
  assert.equal(await exposure(PRE), 'API_ROLE_CAN_WRITE_MEMBERSHIPS');
  assert.equal(await epoch(PRE, B1), 'NULL');
  await sql(PRE, `revoke references on ${T} from authenticated`);
  assert.equal(await epoch(PRE, B1), e1);
});

test_('Q2: a column REFERENCES on the key columns = an FK onto memberships: existence oracle past RLS, and the deletion cascade blocked', async () => {
  await sql(PRE, `grant references (brand_id, user_id) on ${T} to authenticated`);
  const asAtt = (body: string) => `begin; set local role ${att}; ${body}; commit`;
  await sql(PRE, asAtt(`create table att.probe (brand_id text, user_id uuid, foreign key (brand_id, user_id) references ${T} (brand_id, user_id))`), superUser);
  assert.equal(await sql(PRE, asAtt(`select count(*) from ${T}`), superUser), '0', 'RLS shows the attacker no membership');
  await sql(PRE, asAtt(`insert into att.probe values ('${B2}', '${U2}')`), superUser);
  await fails(PRE, asAtt(`insert into att.probe values ('${B2}', '${U1}')`), /23503/u, superUser);
  const e2 = await epoch(PRE, B2);
  await fails(PRE, `delete from public.brands where id = '${B2}'`, /23503[\s\S]*still referenced from table "probe"/u);
  await fails(PRE, `update ${T} set user_id = '${U1}' where brand_id = '${B2}'`, /23503/u);
  assert.equal(await epoch(PRE, B2), e2, 'nothing moved');
  await sql(PRE, 'drop table att.probe', superUser);
  await sql(PRE, `revoke references (brand_id, user_id) on ${T} from authenticated`);
  // without the column grant the FK cannot be made
  await fails(PRE, asAtt(`create table att.probe2 (brand_id text, user_id uuid, foreign key (brand_id, user_id) references ${T} (brand_id, user_id))`), /42501/u, superUser);
  assert.equal(await columnAcls(PRE), '0');
});

test_('Q2: a column UPDATE / INSERT is stopped today only by RLS (no write policy); the epoch triggers still fire for real writes', async () => {
  await sql(PRE, `grant update (role) on ${T} to authenticated; grant insert (brand_id, user_id, role) on ${T} to authenticated`);
  assert.equal(await sql(PRE, asUser(U1, `with u as (update ${T} set role = 'owner' where brand_id = '${B2}' returning 1) select count(*) from u`)), '0');
  assert.equal(await sql(PRE, asUser(U1, `with u as (update ${T} set role = 'admin' where user_id = '${U1}' returning 1) select count(*) from u`)), '0');
  await fails(PRE, asUser(U1, `insert into ${T} (brand_id, user_id, role) values ('${B2}', '${U1}', 'owner')`), /42501[\s\S]*row-level security/u);
  await sql(PRE, `revoke all (brand_id, user_id, role) on ${T} from authenticated`);
  const before = await epoch(PRE, B1);
  await sql(PRE, `update ${T} set role = 'admin' where brand_id = '${B1}'; update ${T} set role = 'owner' where brand_id = '${B1}'`);
  assert.equal(BigInt(await epoch(PRE, B1)), BigInt(before) + 2n, 'owner -> admin -> owner moved the epoch twice');
});

test_('Q3: system-column grants are recorded but give nothing L-1 guards: no write, no FK, no row for anon, nothing new for authenticated', async () => {
  const e1 = await epoch(PRE, B1);
  await sql(PRE, `grant select (ctid) on ${T} to anon; grant references (xmin), update (xmin), insert (cmin) on ${T} to authenticated`);
  assert.equal(await sql(PRE, `select string_agg(attname || '=' || attacl::text, ' ' order by attnum) from pg_attribute where attrelid = '${T}'::regclass and attacl is not null`),
    `cmin={authenticated=a/${owner}} xmin={authenticated=wx/${owner}} ctid={anon=r/${owner}}`);
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
    assert.equal(await anyCol(PRE, 'anon', p), 'f', `anon ${p}: system columns are not counted`);
    if (p !== 'SELECT') assert.equal(await anyCol(PRE, 'authenticated', p), 'f', `authenticated ${p}`);
  }
  assert.equal(await sql(PRE, `select has_column_privilege('anon', '${T}', 'ctid', 'SELECT')`), 't');
  assert.equal(await exposure(PRE), 'NULL');
  assert.equal(await epoch(PRE, B1), e1);
  // what the grants allow
  assert.equal(await sql(PRE, `begin; set local role anon; select count(*) from (select ctid from ${T}) s; commit`), '0', 'anon: RLS, no anon policy');
  await fails(PRE, `begin; set local role anon; select count(*) from ${T}; commit`, /42501/u);
  await fails(PRE, asUser(U1, `update ${T} set xmin = '1'`), /cannot assign to system column/u);
  await fails(PRE, asUser(U1, `insert into ${T} (cmin) values ('1')`), /column "cmin" of relation "brand_memberships" does not exist/u);
  await fails(PRE, `begin; set local role ${att}; create table att.p3 (x xid references ${T} (xmin)); commit`, /system columns cannot be used in foreign keys/u, superUser);
  await fails(PRE, `create unique index on ${T} (xmin)`, /no default operator class/u);
  await sql(PRE, `revoke all (${SYS}) on ${T} from anon, authenticated`);
  assert.equal(await columnAcls(PRE), '0');
  // authenticated already reads the system columns of its own rows through the table SELECT, with no column grant at all
  assert.equal(await sql(PRE, asUser(U1, `select count(*) || ':' || bool_and(ctid is not null and xmin is not null) from ${T}`)), '1:true');
});

test_('model only (not a candidate): a widened L-1 sees every gap above and stays quiet on the clean world and on owner->owner entries', async () => {
  await sql(PRE, `create schema g519_model; create function g519_model.exposure() returns text language sql stable security definer set search_path = '' as $f$
    with reach as (
      select a.rolname as api, r.oid as role_oid from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
       where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator'))
    select coalesce(private.account_lifecycle_owner_epoch_exposure(), case
      when exists (select 1 from reach x where x.api in ('anon', 'authenticated')
                    and (pg_catalog.has_any_column_privilege(x.role_oid, '${T}', 'INSERT')
                      or pg_catalog.has_any_column_privilege(x.role_oid, '${T}', 'UPDATE')
                      or pg_catalog.has_any_column_privilege(x.role_oid, '${T}', 'REFERENCES'))) then 'API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN'
      when exists (select 1 from pg_catalog.pg_attribute a, pg_catalog.aclexplode(a.attacl) e
                    where a.attrelid = '${T}'::regclass and a.attnum < 0
                      and (e.grantee = 0 or e.grantee in (select x.role_oid from reach x))) then 'API_ROLE_HAS_SYSTEM_COLUMN_ACL'
      else null end)
  $f$`);
  const model = () => sql(PRE, 'select coalesce(g519_model.exposure(), \'NULL\')');
  assert.equal(await model(), 'NULL', 'clean world');
  const cases: Array<[string, string]> = [
    [`grant references (brand_id, user_id) on ${T} to authenticated`, 'API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN'],
    [`grant update (role) on ${T} to authenticated`, 'API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN'],
    [`grant insert (brand_id) on ${T} to authenticated`, 'API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN'],
    [`grant select (ctid) on ${T} to anon`, 'API_ROLE_HAS_SYSTEM_COLUMN_ACL'],
    [`grant references (xmin) on ${T} to authenticated`, 'API_ROLE_HAS_SYSTEM_COLUMN_ACL'],
    [`grant select (ctid) on ${T} to public`, 'API_ROLE_HAS_SYSTEM_COLUMN_ACL'],
    [`grant select (xmin) on ${T} to service_role`, 'API_ROLE_HAS_SYSTEM_COLUMN_ACL'],
  ];
  for (const [grant, code] of cases) {
    await sql(PRE, grant);
    assert.equal(await model(), code, grant);
    assert.equal(await exposure(PRE), 'NULL', `the real check misses: ${grant}`);
    await sql(PRE, `revoke all (brand_id, user_id, role, ${SYS}) on ${T} from public, anon, authenticated, service_role`);
  }
  await sql(PRE, `grant select (xmin) on ${T} to ${owner}`);
  assert.equal(await model(), 'NULL', 'an owner->owner entry is not an API role');
  await sql(PRE, `revoke select (xmin) on ${T} from ${owner}`);
  await sql(PRE, 'drop schema g519_model cascade');
  assert.equal(await columnAcls(PRE), '0');
});

test_("G3's option A1 (proposal check): rows rewritten, ACL back to NULL, no table lock, event triggers fire per statement, a concurrent GRANT times out", async () => {
  const a1 = `grant select (${SYS}) on ${T} to ${owner}; revoke select (${SYS}) on ${T} from ${owner}`;
  await sql(PRE, `create schema g519_evt; create table g519_evt.log (tag text);
    create function g519_evt.count() returns event_trigger language plpgsql security definer set search_path = '' as $f$ begin insert into g519_evt.log values (tg_tag); end $f$;
    create event trigger g519_evt_count on ddl_command_end execute function g519_evt.count()`, superUser);
  const out = await sql(PRE, `begin; ${a1};
    select (select count(*) from pg_attribute where attrelid = '${T}'::regclass and attnum < 0 and attacl is null) || ':'
        || (select count(*) from pg_attribute where attrelid = '${T}'::regclass and attnum < 0 and xmin::text = pg_current_xact_id()::xid::text) || ':'
        || (select count(*) from pg_locks where pid = pg_backend_pid() and locktype = 'relation' and relation = '${T}'::regclass);
    commit`);
  assert.equal(out, '6:6:0', 'six NULL ACLs, six rows rewritten by this transaction, no lock on the table');
  assert.equal(await sql(PRE, `select string_agg(tag, ',' order by tag) from g519_evt.log`, superUser), 'GRANT,REVOKE', 'one event per statement');
  await sql(PRE, 'drop event trigger g519_evt_count', superUser);
  // a concurrent system-column GRANT waits on the claimed row and hits its lock_timeout; nothing is left
  const holder = spawn(PRE, `begin; ${a1}; select pg_sleep(3) /* g519-a1 */; commit`);
  for (let i = 0; i < 100; i += 1) {
    if ((await sql(PRE, `select count(*) from pg_stat_activity where wait_event = 'PgSleep' and position('g519-a1' in query) > 0`, superUser)) === '1') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await fails(PRE, `set lock_timeout = '300ms'; grant select (ctid) on ${T} to anon`, /55P03/u);
  assert.ok((await holder.output()).success);
  assert.equal(await columnAcls(PRE), '0');
  // an event trigger that fails makes A1 fail as a whole
  await sql(PRE, `create function g519_evt.fail() returns event_trigger language plpgsql as $f$ begin raise exception 'G519_EVENT_TRIGGER_REFUSED'; end $f$;
    create event trigger g519_evt_fail on ddl_command_end when tag in ('GRANT') execute function g519_evt.fail()`, superUser);
  await fails(PRE, `begin; ${a1}; commit`, /G519_EVENT_TRIGGER_REFUSED/u);
  await sql(PRE, 'drop event trigger g519_evt_fail; drop schema g519_evt cascade', superUser);
  assert.equal(await columnAcls(PRE), '0');
  // the corner case G3 names: an owner->owner system-column entry made before is removed by the claim (narrowing only)
  await sql(PRE, `grant select (xmin) on ${T} to ${owner}`);
  await sql(PRE, `begin; ${a1}; commit`);
  assert.equal(await columnAcls(PRE), '0');
});
