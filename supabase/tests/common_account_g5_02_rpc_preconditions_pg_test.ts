// G5-02: the PRECONDITIONS of the proposed G5 read RPC R1 (docs/common-account/g5-02-authorization-verdict-rpc-preflight.md §3) on the REAL
// common-account chain (F5 P1..P10 + the PR #303 owner-epoch candidate), local PostgreSQL 17, fake data. Nothing is created: catalog reads, the
// existing functions, the real RLS as the person's role, and two real concurrent sessions. A PASS is a precondition of the design, not the RPC.
// Needs CAL_E2E=1 and PGHOST / PGPORT / PGUSER / PGDATABASE (common_account_g5_02_rpc_preconditions_pg_run.sh sets them).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const db = Deno.env.get('PGDATABASE') ?? '';
const owner = Deno.env.get('PGUSER') ?? '';
const decoder = new TextDecoder();
if (enabled && !db) throw new Error('PGDATABASE is required');
globalThis.fetch = (() => { throw new Error('the G5-02 tests make no network request'); }) as typeof fetch;

const env = () => ({ PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: owner, PGDATABASE: db, LC_ALL: 'C' });
type Psql = { ok: boolean; out: string; error: string };
async function psql(statement: string): Promise<Psql> {
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement], env: env(), clearEnv: true, stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
async function sql(statement: string): Promise<string> {
  const r = await psql(statement);
  if (!r.ok) throw new Error(r.error);
  return r.out;
}
const spawn = (statement: string) => new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement], env: env(), clearEnv: true, stdout: 'piped', stderr: 'piped' }).spawn();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function untilSleeping(marker: string) {
  for (let i = 0; i < 100; i += 1) {
    if ((await sql(`select count(*) from pg_stat_activity where wait_event = 'PgSleep' and position('${marker}' in query) > 0`)) === '1') return;
    await sleep(50);
  }
  throw new Error(`${marker} never slept`);
}
const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;
const test_ = enabled ? test : test.skip;
const asUser = (user: string, statement: string) =>
  `begin; set local request.jwt.claim.sub = '${user}'; set local request.jwt.claim.role = 'authenticated'; set local role authenticated; ${statement}; commit`;
type Person = { user: string; brand: string };
async function person(): Promise<Person> {
  const user = randomUUID();
  const brand = await sql(`select public.fixture_user_with_workspace('${user}'::uuid, ${lit(`g502_${user.slice(0, 6)}`)})`);
  assert.equal(JSON.parse(await sql(asUser(user, 'select to_jsonb(public.start_x_autopost_service())'))).status, 'active');
  return { user, brand };
}

/** Every relation R1 would read, and every helper it would call. */
const RELATIONS = ['public.common_accounts', 'public.service_entitlements', 'public.brands', 'public.brand_memberships', 'private.account_lifecycle_operations',
  'private.account_lifecycle_brand_owner_epochs', 'auth.users', 'auth.sessions'];
const HELPERS = ['private.account_lifecycle_brand_owner(text)', 'private.account_lifecycle_brand_owner_epoch(text)', 'private.account_lifecycle_brand_owner_epoch_covered()',
  'private.account_lifecycle_owner_epoch_exposure()', 'private.account_lifecycle_service_state_readonly(uuid,text)', 'public.common_account_brand_service_state(text,text)'];

test_('row visibility: the lifecycle owner (the RPC\'s owner) can read every relation R1 needs, and no RLS is FORCED on them', async () => {
  for (const rel of RELATIONS) {
    assert.equal(await sql(`select has_table_privilege(current_user, ${lit(rel)}, 'SELECT')::text`), 'true', `${rel} readable by the owner`);
    assert.equal(await sql(`select relforcerowsecurity::text from pg_class where oid = ${lit(rel)}::regclass`), 'false', `${rel}: RLS not forced`);
  }
  for (const rel of ['public.common_accounts', 'public.service_entitlements', 'public.brand_memberships']) {
    assert.equal(await sql(`select (relowner = (select oid from pg_roles where rolname = current_user))::text from pg_class where oid = ${lit(rel)}::regclass`), 'true', `${rel} owned by the lifecycle owner (RLS does not apply to it)`);
    assert.equal(await sql(`select relrowsecurity::text from pg_class where oid = ${lit(rel)}::regclass`), 'true', `${rel}: RLS on for everyone else`);
  }
});

test_('helpers: every function R1 would call is STABLE (one snapshot with the calling statement) and owner-only; the locking decision is VOLATILE and must NOT be used', async () => {
  for (const fn of HELPERS) {
    assert.equal(await sql(`select provolatile from pg_proc where oid = ${lit(fn)}::regprocedure`), 's', `${fn} is STABLE`);
    assert.equal(await sql(`select (prosecdef and proconfig @> array['search_path=""'])::text from pg_proc where oid = ${lit(fn)}::regprocedure`), 'true', `${fn}: definer, empty search_path`);
  }
  for (const fn of HELPERS.filter((f) => f.startsWith('private.'))) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(await sql(`select has_function_privilege(${lit(role)}, ${lit(fn)}::regprocedure, 'EXECUTE')::text`), 'false', `${role} cannot call ${fn}`);
    }
  }
  assert.equal(await sql(`select provolatile from pg_proc where oid = 'private.account_lifecycle_service_state_refusal(uuid,text)'::regprocedure`), 'v', 'the locking Phase 4 decision is VOLATILE (a new snapshot per statement + row locks): not for a read RPC');
});

test_('one snapshot: two reads of the real owner epoch in ONE statement agree across a concurrent owner change; two statements in one transaction do not', async () => {
  const a = await person();
  const b = await person();
  const getter = `private.account_lifecycle_brand_owner_epoch(${lit(a.brand)})`;
  const change = () => sql(`begin; update public.brand_memberships set role = 'admin' where brand_id = ${lit(a.brand)} and user_id = '${a.user}'; insert into public.brand_memberships (brand_id, user_id, role) values (${lit(a.brand)}, '${b.user}', 'owner'); commit`);
  const restore = () => sql(`begin; delete from public.brand_memberships where brand_id = ${lit(a.brand)} and user_id = '${b.user}'; update public.brand_memberships set role = 'owner' where brand_id = ${lit(a.brand)} and user_id = '${a.user}'; commit`);
  // ONE statement: both getter calls use the statement's snapshot
  const one = spawn(`select coalesce(${getter}::text, 'NULL') || '|' || pg_sleep(2)::text || '|' || coalesce(${getter}::text, 'NULL') /* g502-one */`);
  await untilSleeping('g502-one');
  await change();
  const oneOut = decoder.decode((await one.output()).stdout).trim().split('|');
  assert.equal(oneOut[0], oneOut[2], `one statement: ${oneOut.join(' ')}`);
  assert.ok(/^[1-9][0-9]*$/u.test(oneOut[0]), 'a real epoch, not NULL');
  const after = await sql(`select coalesce(${getter}::text, 'NULL')`);
  assert.ok(Number(after) > Number(oneOut[0]), `the change committed during the statement (epoch now ${after})`);
  await restore();
  // TWO statements in one READ COMMITTED transaction: the second sees the committed change
  const before = await sql(`select ${getter}`);
  const two = spawn(`begin; select coalesce(${getter}::text, 'NULL'); select pg_sleep(2) /* g502-two */; select coalesce(${getter}::text, 'NULL'); commit`);
  await untilSleeping('g502-two');
  await change();
  const twoOut = decoder.decode((await two.output()).stdout).trim().split('\n').filter((l) => l !== '');
  assert.notEqual(twoOut[0], twoOut[twoOut.length - 1], `two statements: ${twoOut.join(' ')}`);
  assert.ok(Number(twoOut[twoOut.length - 1]) > Number(before), 'the second statement saw the new owner\'s epoch');
});

test_('the person cannot assemble the facts alone: RLS shows only their own rows, and none of the owner / epoch / readonly-state helpers -- so R1 is needed', async () => {
  const a = await person();
  const b = await person();
  assert.equal(await sql(asUser(a.user, `select count(*) from public.service_entitlements where user_id = '${a.user}'`)), '1', 'own entitlement visible');
  assert.equal(await sql(asUser(a.user, `select count(*) from public.service_entitlements where user_id = '${b.user}'`)), '0', 'another person\'s entitlement invisible');
  assert.equal(await sql(asUser(a.user, `select count(*) from public.common_accounts where user_id = '${b.user}'`)), '0');
  assert.equal(await sql(asUser(a.user, `select count(*) from public.brand_memberships where brand_id = ${lit(b.brand)}`)), '0', 'another workspace\'s members invisible');
  assert.equal(await sql(asUser(a.user, `select count(*) from public.brand_memberships where brand_id = ${lit(a.brand)}`)), '1', 'only the person\'s own membership row');
  const r = await psql(asUser(a.user, `select private.account_lifecycle_brand_owner_epoch(${lit(a.brand)})`));
  assert.ok(!r.ok && /permission denied/u.test(r.error), 'the owner epoch is not the person\'s to read');
  const s = await psql(asUser(a.user, `select count(*) from auth.sessions`));
  assert.ok(!s.ok && /permission denied/u.test(s.error), 'auth.sessions is not the person\'s to read');
});

test_('no network: the model made no request', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
