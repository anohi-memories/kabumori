// G5-20: the deny-net of the owner-epoch candidate's widened exposure check, on the runner's two throw-away PG17 databases. Every finding must make
// the getter answer NULL (and the resync refuse) at the very next read, and the install refuse while it is there; the contract grants and the
// harmless cases must not. Needs CAL_E2E=1 and the runner's environment. A local fact about the candidate SQL; nothing about managed / production.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, mid, mid2, admin, child, superUser] = ['OA_OWNER', 'OA_MID', 'OA_MID2', 'OA_ADMIN', 'OA_CHILD', 'PGSUPER'].map(env);
const MAIN = env('OA_DB_MAIN');
const FRESH = env('OA_DB_FRESH');
const decoder = new TextDecoder();
globalThis.fetch = (() => { throw new Error('the G5-20 tests make no network request'); }) as typeof fetch;
const test_ = enabled ? test : test.skip;

type Result = { ok: boolean; out: string; error: string };
const args = (db: string, user: string, extra: string[]) => ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-d', db, '-U', user, ...extra];
async function run(db: string, extra: string[], user = owner): Promise<Result> {
  const out = await new Deno.Command('psql', { args: args(db, user, extra), stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
const psql = (db: string, statement: string, user = owner) => run(db, ['-c', statement], user);
async function sql(db: string, statement: string, user = owner): Promise<string> {
  const r = await psql(db, statement, user);
  assert.ok(r.ok, `${statement}\n${r.error}`);
  return r.out;
}
const asSuper = (db: string, statement: string) => sql(db, statement, superUser);
const install = (db: string) => run(db, ['-f', env('OA_CANDIDATE')]);
const rollback = (db: string) => run(db, ['-f', env('OA_ROLLBACK')]);

const T = 'public.brand_memberships';
const H = 'private.account_lifecycle_brand_owner_epochs';
const SYS = 'tableoid, cmax, xmax, cmin, xmin, ctid';
const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000b2';
const B1 = 'b_one';
const B2 = 'b_two';
const exposure = (db = MAIN) => sql(db, `select coalesce(private.account_lifecycle_owner_epoch_exposure(), 'NONE')`);
const epoch = (brand = B1, db = MAIN) => sql(db, `select coalesce(private.account_lifecycle_brand_owner_epoch('${brand}')::text, 'NULL')`);
const resync = (brand = B1) => psql(MAIN, `select private.account_lifecycle_brand_owner_epoch_resync('${brand}')`);
const cleanColumns = `revoke all (brand_id, user_id, role, created_at, ${SYS}) on ${T} from public, anon, authenticated, service_role, authenticator, ${mid}, ${mid2}, ${admin}, ${child}`;
const cleanHistory = `revoke all on ${H} from public, anon, authenticated, service_role, authenticator, ${mid}, ${mid2}; revoke all (brand_id, epoch, owner_user_id, owner_count, ${SYS}) on ${H} from public, anon, authenticated, service_role, authenticator, ${mid}, ${mid2}`;

// one finding: seen at the next read, the getter refuses, the resync refuses; after the undo the same number comes back
async function finding(grant: string, undo: string, code: string, label: string, as = owner) {
  const before = await epoch();
  assert.notEqual(before, 'NULL', `${label}: covered before`);
  await sql(MAIN, grant, as);
  assert.equal(await exposure(), code, label);
  assert.equal(await epoch(), 'NULL', `${label}: the getter refuses`);
  const r = await resync();
  assert.ok(!r.ok && /OWNER_EPOCH_COVERAGE_BROKEN/u.test(r.error), `${label}: the resync refuses`);
  await sql(MAIN, undo, as);
  assert.equal(await exposure(), 'NONE', `${label}: undone`);
  assert.equal(await epoch(), before, `${label}: the same number, nothing moved`);
}

test_('clean install: covered, the contract grants are not findings, two workspaces answer', async () => {
  await sql(MAIN, `insert into auth.users values ('${U1}'), ('${U2}'); insert into public.brands (id) values ('${B1}'), ('${B2}');
    insert into ${T} (brand_id, user_id, role) values ('${B1}', '${U1}', 'owner'), ('${B2}', '${U2}', 'owner')`);
  assert.equal(await exposure(), 'NONE');
  assert.equal(await sql(MAIN, `select has_table_privilege('authenticated', '${T}', 'SELECT') and has_table_privilege('service_role', '${T}', 'SELECT, INSERT, UPDATE, DELETE')`), 't',
    'the contract: authenticated SELECT, service_role DML');
  assert.equal(await sql(MAIN, `select count(*) from pg_attribute where attrelid in ('${T}'::regclass, '${H}'::regclass) and attacl is not null`), '0');
  assert.notEqual(await epoch(B1), 'NULL');
  assert.notEqual(await epoch(B2), 'NULL');
});

test_('column INSERT / UPDATE / REFERENCES of anon / authenticated (and PUBLIC) is a write finding', async () => {
  const cases: Array<[string, string]> = [
    ['anon INSERT (brand_id)', `grant insert (brand_id) on ${T} to anon`],
    ['authenticated UPDATE (role)', `grant update (role) on ${T} to authenticated`],
    ['authenticated REFERENCES (brand_id, user_id)', `grant references (brand_id, user_id) on ${T} to authenticated`],
    ['authenticated INSERT (created_at)', `grant insert (created_at) on ${T} to authenticated`],
    ['PUBLIC UPDATE (role)', `grant update (role) on ${T} to public`],
  ];
  for (const [label, grant] of cases) {
    assert.equal(await sql(MAIN, `select has_table_privilege('authenticated', '${T}', 'INSERT, UPDATE, REFERENCES') or has_table_privilege('anon', '${T}', 'INSERT, UPDATE, REFERENCES')`), 'f');
    await finding(grant, cleanColumns, 'API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN', label);
  }
});

test_('the column-ACL allowlist is empty: column SELECT for any API role or PUBLIC, and any service_role / authenticator column grant', async () => {
  const cases: Array<[string, string]> = [
    ['authenticated SELECT (role)', `grant select (role) on ${T} to authenticated`],
    ['anon SELECT (brand_id)', `grant select (brand_id) on ${T} to anon`],
    ['service_role UPDATE (role)', `grant update (role) on ${T} to service_role`],
    ['service_role REFERENCES (brand_id, user_id)', `grant references (brand_id, user_id) on ${T} to service_role`],
    ['authenticator SELECT (user_id)', `grant select (user_id) on ${T} to authenticator`],
    ['PUBLIC SELECT (created_at)', `grant select (created_at) on ${T} to public`],
  ];
  for (const [label, grant] of cases) await finding(grant, cleanColumns, 'API_ROLE_HAS_MEMBERSHIP_COLUMN_ACL', label);
});

test_('system columns: any grant on ctid / xmin / ... to an API role or PUBLIC is found (has_any_column_privilege ignores them)', async () => {
  const cases: Array<[string, string]> = [
    ['anon SELECT (ctid)', `grant select (ctid) on ${T} to anon`],
    ['authenticated REFERENCES (xmin)', `grant references (xmin) on ${T} to authenticated`],
    ['authenticated UPDATE (xmin)', `grant update (xmin) on ${T} to authenticated`],
    ['service_role INSERT (cmin)', `grant insert (cmin) on ${T} to service_role`],
    ['PUBLIC SELECT (tableoid)', `grant select (tableoid) on ${T} to public`],
    ['authenticator SELECT (xmax)', `grant select (xmax) on ${T} to authenticator`],
  ];
  for (const [label, grant] of cases) {
    await sql(MAIN, grant);
    assert.equal(await sql(MAIN, `select has_any_column_privilege('anon', '${T}', 'SELECT, INSERT, UPDATE, REFERENCES') or has_any_column_privilege('authenticated', '${T}', 'INSERT, UPDATE, REFERENCES')`), 'f',
      `${label}: invisible to has_any_column_privilege`);
    await sql(MAIN, cleanColumns);
    await finding(grant, cleanColumns, 'API_ROLE_HAS_MEMBERSHIP_COLUMN_ACL', label);
  }
});

test_('role graph: column grants reached through NOINHERIT, SET-only and two-hop memberships are found', async () => {
  // authenticated -> mid (no INHERIT): authenticated's own effective privilege is false, the reach is not
  await asSuper(MAIN, `grant ${mid} to authenticated with inherit false`);
  await sql(MAIN, `grant update (role) on ${T} to ${mid}`);
  assert.equal(await sql(MAIN, `select has_any_column_privilege('authenticated', '${T}', 'UPDATE')`), 'f');
  assert.equal(await exposure(), 'API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN');
  assert.equal(await epoch(), 'NULL');
  await sql(MAIN, cleanColumns);
  assert.equal(await exposure(), 'NONE');
  await asSuper(MAIN, `revoke ${mid} from authenticated`);
  // anon -> mid -> mid2 (INHERIT, SET false), a system-column grant on mid2
  await asSuper(MAIN, `grant ${mid} to anon with inherit true, set false; grant ${mid2} to ${mid}`);
  await finding(`grant select (ctid) on ${T} to ${mid2}`, cleanColumns, 'API_ROLE_HAS_MEMBERSHIP_COLUMN_ACL', 'two hops, SET false');
  await asSuper(MAIN, `revoke ${mid2} from ${mid}; revoke ${mid} from anon`);
  assert.equal(await exposure(), 'NONE');
});

test_('not findings: a role no API role reaches, a member OF authenticated, and an owner -> owner system-column entry', async () => {
  const e = await epoch();
  for (const grant of [`grant update (role), references (brand_id, user_id) on ${T} to ${admin}`, `grant select (ctid), update (role) on ${T} to ${child}`,
    `grant select (xmin) on ${T} to ${owner}`]) {
    await sql(MAIN, grant);
    assert.equal(await exposure(), 'NONE', grant);
    assert.equal(await epoch(), e, grant);
  }
  await sql(MAIN, `${cleanColumns}; revoke all (${SYS}) on ${T} from ${owner}`);
  assert.equal(await sql(MAIN, `select count(*) from pg_attribute where attrelid = '${T}'::regclass and attacl is not null`), '0');
});

test_('the epoch history: any privilege for PUBLIC or a reached role -- table, TRIGGER, REFERENCES, MAINTAIN, a column, a system column -- is found', async () => {
  // NOINHERIT: authenticated's own effective privilege stays false, only the reach finds mid's grants
  await asSuper(MAIN, `grant ${mid} to authenticated with inherit false`);
  const cases: Array<[string, string]> = [
    ['TRIGGER to authenticator', `grant trigger on ${H} to authenticator`],
    ['REFERENCES to anon', `grant references on ${H} to anon`],
    ['MAINTAIN to service_role', `grant maintain on ${H} to service_role`],
    ['SELECT to PUBLIC', `grant select on ${H} to public`],
    ['INSERT to a role authenticated reaches', `grant insert on ${H} to ${mid}`],
    ['column SELECT (epoch) to authenticated', `grant select (epoch) on ${H} to authenticated`],
    ['system column SELECT (ctid) to PUBLIC', `grant select (ctid) on ${H} to public`],
    ['system column REFERENCES (xmin) to a reached role', `grant references (xmin) on ${H} to ${mid}`],
  ];
  for (const [label, grant] of cases) await finding(grant, cleanHistory, 'API_ROLE_CAN_REACH_OWNER_EPOCH_HISTORY', label);
  await sql(MAIN, `grant insert on ${H} to ${mid}`);
  assert.equal(await sql(MAIN, `select has_table_privilege('authenticated', '${H}', 'INSERT')`), 'f', 'invisible to the API role itself');
  await sql(MAIN, cleanHistory);
  await asSuper(MAIN, `revoke ${mid} from authenticated`);
});

test_('why the history matters: a trigger of a reached role on it runs AS THE OWNER inside every bump; the getter refuses while it exists', async () => {
  await asSuper(MAIN, `grant ${mid} to authenticated`);
  await sql(MAIN, `grant trigger on ${H} to ${mid}`);
  await asSuper(MAIN, `set role ${mid}; create table att.log (who text); grant insert on att.log to public;
    create function att.spy() returns trigger language plpgsql as $f$ begin insert into att.log values (current_user); return null; end $f$;
    create trigger spy after insert or update on ${H} for each row execute function att.spy()`);
  assert.equal(await exposure(), 'API_ROLE_CAN_REACH_OWNER_EPOCH_HISTORY');
  assert.equal(await epoch(), 'NULL');
  await sql(MAIN, `update ${T} set role = 'admin' where brand_id = '${B2}'; update ${T} set role = 'owner' where brand_id = '${B2}'`);
  assert.equal(await asSuper(MAIN, 'select string_agg(distinct who, \',\') from att.log'), owner, 'the reached role\'s code ran as the owner');
  await asSuper(MAIN, `drop trigger spy on ${H}; drop table att.log; drop function att.spy()`);
  await sql(MAIN, cleanHistory);
  await asSuper(MAIN, `revoke ${mid} from authenticated`);
  assert.equal(await exposure(), 'NONE');
  assert.notEqual(await epoch(B2), 'NULL');
});

test_('install: a column / system-column grant present before it refuses the install and leaves nothing', async () => {
  for (const [grant, code] of [[`grant references (brand_id, user_id) on ${T} to authenticated`, 'OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN'],
    [`grant select (ctid) on ${T} to anon`, 'OWNER_EPOCH_PRECONDITION_API_ROLE_HAS_MEMBERSHIP_COLUMN_ACL']]) {
    await sql(FRESH, grant);
    const r = await install(FRESH);
    assert.ok(!r.ok && r.error.includes(code), `${grant}\n${r.error}`);
    assert.equal(await sql(FRESH, `select (to_regprocedure('private.account_lifecycle_owner_epoch_exposure()') is null and to_regclass('${H}') is null
      and not exists (select 1 from pg_trigger where tgrelid = '${T}'::regclass and not tgisinternal))::text`), 'true', 'nothing left');
    await sql(FRESH, cleanColumns);
  }
});

test_('install: a global or schema default privilege that would hand the history to a reached role refuses the install and leaves nothing', async () => {
  // TRIGGER / MAINTAIN / REFERENCES were invisible to the install's older table check (SELECT .. TRUNCATE), which still answers first for those
  const cases: Array<[string, string, string, string]> = [
    ['a GLOBAL default TRIGGER to authenticator', 'alter default privileges grant trigger on tables to authenticator', 'alter default privileges revoke trigger on tables from authenticator',
      'OWNER_EPOCH_POSTCONDITION_EXPOSURE'],
    ['a schema default MAINTAIN to a role authenticated reaches', `alter default privileges in schema private grant maintain on tables to ${mid}`,
      `alter default privileges in schema private revoke maintain on tables from ${mid}`, 'OWNER_EPOCH_POSTCONDITION_EXPOSURE'],
    // (a default to PUBLIC, anon, authenticated or service_role is removed by the install's own `revoke all`; one to any other reached role is not)
    ['a GLOBAL default REFERENCES to a role authenticated reaches', `alter default privileges grant references on tables to ${mid}`,
      `alter default privileges revoke references on tables from ${mid}`, 'OWNER_EPOCH_POSTCONDITION_EXPOSURE'],
    ['a schema default SELECT to a role authenticated reaches', `alter default privileges in schema private grant select on tables to ${mid}`,
      `alter default privileges in schema private revoke select on tables from ${mid}`, 'OWNER_EPOCH_POSTCONDITION_TABLE_ACL'],
  ];
  await asSuper(FRESH, `grant ${mid} to authenticated`);
  for (const [label, grant, undo, code] of cases) {
    await sql(FRESH, grant);
    const r = await install(FRESH);
    assert.ok(!r.ok && r.error.includes(code), `${label}\n${r.error}`);
    assert.equal(await sql(FRESH, `select (to_regprocedure('private.account_lifecycle_owner_epoch_exposure()') is null and to_regclass('${H}') is null)::text`), 'true', `${label}: nothing left`);
    await sql(FRESH, undo);
  }
  await asSuper(FRESH, `revoke ${mid} from authenticated`);
  assert.equal(await sql(FRESH, `select count(*) from pg_default_acl d join pg_roles r on r.oid = d.defaclrole where r.rolname = '${owner}' and d.defaclnamespace = 0`), '0');
  const ok = await install(FRESH);
  assert.ok(ok.ok, ok.error);
  assert.equal(await exposure(FRESH), 'NONE');
});

test_('rollback keeps the history; a grant on it while uninstalled refuses the re-install; after the revoke the re-install moves every number on', async () => {
  const e1 = BigInt(await epoch(B1));
  let r = await rollback(MAIN);
  assert.ok(r.ok, r.error);
  await sql(MAIN, `grant select on ${H} to anon`);
  r = await install(MAIN);
  assert.ok(!r.ok && r.error.includes('OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_REACH_OWNER_EPOCH_HISTORY'), r.error);
  await sql(MAIN, cleanHistory);
  r = await install(MAIN);
  assert.ok(r.ok, r.error);
  assert.ok(BigInt(await epoch(B1)) > e1, 'the re-start fence moved the number on');
  assert.equal(await exposure(), 'NONE');
});

test_('per read, READ COMMITTED: a column grant committed by another session is seen by the next statement of an open transaction', async () => {
  const reader = new Deno.Command('psql', { args: args(MAIN, owner, ['-c', `begin; select coalesce(private.account_lifecycle_brand_owner_epoch('${B1}')::text, 'NULL');
    select pg_sleep(2) /* g520-reader */; select coalesce(private.account_lifecycle_brand_owner_epoch('${B1}')::text, 'NULL'); commit`]), stdout: 'piped', stderr: 'piped' }).spawn();
  for (let i = 0; i < 100; i += 1) {
    if ((await asSuper(MAIN, `select count(*) from pg_stat_activity where wait_event = 'PgSleep' and position('g520-reader' in query) > 0`)) === '1') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await sql(MAIN, `grant update (role) on ${T} to authenticated`);
  const out = await reader.output();
  assert.ok(out.success, decoder.decode(out.stderr));
  const lines = decoder.decode(out.stdout).trim().split('\n').filter((l) => l !== '');
  assert.notEqual(lines[0], 'NULL');
  assert.equal(lines[lines.length - 1], 'NULL', 'the second read of the same transaction refuses');
  await sql(MAIN, cleanColumns);
  assert.equal(await exposure(), 'NONE');
});

test_('the older findings keep their codes and order', async () => {
  await sql(MAIN, `grant trigger on ${T} to authenticated; grant update (role) on ${T} to authenticated; grant select (ctid) on ${T} to anon`);
  assert.equal(await exposure(), 'API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS');
  await sql(MAIN, `revoke trigger on ${T} from authenticated`);
  assert.equal(await exposure(), 'API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN');
  await sql(MAIN, `grant references on ${T} to authenticated`);
  assert.equal(await exposure(), 'API_ROLE_CAN_WRITE_MEMBERSHIPS', 'the table-level code comes first');
  await sql(MAIN, `revoke references on ${T} from authenticated; ${cleanColumns}`);
  assert.equal(await exposure(), 'NONE');
});
