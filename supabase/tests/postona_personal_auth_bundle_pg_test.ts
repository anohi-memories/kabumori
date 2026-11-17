// G5-40: the install bundle on the prerequisite world (see the runner): order, idempotency, privileges, out-of-order refusals, the reverse
// rollback with the guard back to the exact pre-bundle catalog, and a reinstall. A local fact about candidate SQL in throw-away databases;
// nothing about managed / production. Needs CAL_E2E=1 and the runner's environment.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, superUser, DB, PROBE, B] = ['S40_OWNER', 'PGSUPER', 'S40_DB', 'S40_PROBE', 'S40_BUNDLE'].map(env);
const decoder = new TextDecoder();
const test_ = enabled ? test : test.skip;

type Result = { ok: boolean; out: string; error: string };
async function run(db: string, extra: string[], user = owner): Promise<Result> {
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-U', user, ...extra], stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
async function sql(db: string, statement: string, user = owner): Promise<string> {
  const r = await run(db, ['-c', statement], user);
  assert.ok(r.ok, `${statement}\n${r.error}`);
  return r.out;
}
const file = (name: string) => `${B}/${name}`;
const apply = (db: string, name: string, user = owner) => run(db, ['-f', file(name)], user);
const INSTALL = ['10_r1_authorization_verdict.sql', '20_r0_bootstrap_verdict.sql', '30_sv_session_verdict.sql', '40_d1_verdicts_anonymous_strict.sql',
  '50_s2_3_workspace_eligibility.sql', '60_s2_2_personal_session.sql', '70_s2_1_t13_anonymous_refusal.sql'];
const ALREADY = ['AUTH_VERDICT_ALREADY_APPLIED', 'BOOTSTRAP_VERDICT_ALREADY_APPLIED', 'SESSION_VERDICT_ALREADY_APPLIED', 'D1_ALREADY_APPLIED',
  'S23_ALREADY_APPLIED', 'S22_ALREADY_APPLIED', 'T13_ANON_ALREADY_APPLIED'];
const ROLLBACK = ['R70_s2_1_t13_anonymous_refusal_rollback.sql', 'R60_s2_2_personal_session_rollback.sql', 'R50_s2_3_workspace_eligibility_rollback.sql',
  'R40_d1_verdicts_anonymous_strict_rollback.sql', 'RG_base_rollback_guard.sql', 'R30_sv_session_verdict_rollback.sql',
  'R20_r0_bootstrap_verdict_rollback.sql', 'R10_r1_authorization_verdict_rollback.sql'];
// every function of public / private / auth with its body checksum and ACL (OIDs are left out: a reinstall gives new ones)
const catalog = (db: string) => sql(db, `select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proacl::text[], ','), '-'),
  ' ' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private', 'auth')`);
const md5 = (db: string, fn: string) => sql(db, `select coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure('${fn}')), 'absent')`);
const F = {
  R1: 'public.common_account_authorization_verdict(text,text,text)', R0: 'public.common_account_bootstrap_verdict(text,text)',
  SV: 'private.account_lifecycle_session_verdict()', T13: 'private.account_lifecycle_assert_active_service_write(uuid,text)',
  S23: 'private.postona_personal_workspace_eligibility(uuid)', S22: 'private.postona_personal_session()',
  W1: 'private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)', W2: 'public.common_account_worker_brand_verdict(text,text,bigint,bigint)',
};
const FINAL = { R1: '7e84d9a2ecc53923d0c7846a4514dfdd', R0: '3e89fcff1a3232ef794cdf0483a75130', SV: 'a5d4d71c532847a8573e86a4bd0c791d',
  T13: '1f8cd9c764c251f3232c61b7a77ff597', S23: 'fa4623601fe2ef6efc38478c9f65105e', S22: 'a5d4d71c532847a8573e86a4bd0c791d' };
let PRE = '';
let POST = '';

test_('out of order on the prerequisite world: D1 before R1, and S2-3 before R0, refuse and create nothing', async () => {
  PRE = await catalog(DB);
  for (const k of ['R1', 'R0', 'SV', 'S23', 'S22'] as const) assert.equal(await md5(DB, F[k]), 'absent', `${k} is not in the prerequisite world`);
  assert.equal(await md5(DB, F.T13), '08840016794a973225be767952265e79', 'the reviewed T13');
  let r = await apply(DB, INSTALL[3]);
  assert.ok(!r.ok && r.error.includes('D1_PRECONDITION_R1_MISSING'), r.error);
  r = await apply(DB, INSTALL[4]);
  assert.ok(!r.ok && r.error.includes('S23_PRECONDITION_R0_MISSING'), r.error);
  assert.equal(await catalog(DB), PRE, 'nothing created');
});

test_('install 10..70 in order; each body as stated; a second run of every step refuses (idempotent by refusal)', async () => {
  for (const name of INSTALL) {
    const r = await apply(DB, name);
    assert.ok(r.ok, `${name}\n${r.error}`);
  }
  for (const k of Object.keys(FINAL) as Array<keyof typeof FINAL>) assert.equal(await md5(DB, F[k]), FINAL[k], `${k} after the bundle`);
  POST = await catalog(DB);
  for (let i = 0; i < INSTALL.length; i += 1) {
    const r = await apply(DB, INSTALL[i]);
    assert.ok(!r.ok && r.error.includes(ALREADY[i]), `${INSTALL[i]} again\n${r.error}`);
  }
  assert.equal(await catalog(DB), POST, 'the second runs changed nothing');
  const superRun = await apply(DB, INSTALL[3], superUser);
  assert.ok(!superRun.ok, 'a superuser run refuses');
});

test_('privileges after the bundle: R0 / R1 for authenticated only; SV, S2-2, S2-3, T13, W1 owner-only; W2 for service_role; no API role in the owner', async () => {
  const can = (role: string, fn: string) => sql(DB, `select has_function_privilege('${role}', '${fn}', 'EXECUTE')::text`);
  for (const fn of [F.SV, F.S22, F.S23, F.T13, F.W1]) {
    for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) assert.equal(await can(role, fn), 'false', `${role} -> ${fn}`);
  }
  for (const fn of [F.R0, F.R1]) {
    assert.equal(await can('authenticated', fn), 'true', `authenticated -> ${fn}`);
    assert.equal(await can('anon', fn), 'false', `anon -> ${fn}`);
  }
  const w2 = [];
  for (const role of ['anon', 'authenticated', 'service_role']) w2.push(`${role}=${await can(role, F.W2)}`);
  console.log(`S40_W2_EXECUTE ${w2.join(' ')}`);
  assert.equal(await can('anon', F.W2), 'false');
  assert.equal(await can('authenticated', F.W2), 'false');
  assert.equal(await can('service_role', F.W2), 'true', 'W2 is the Edge worker\'s entry (service_role), as R1\'s file declares');
  for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) {
    assert.equal(await sql(DB, `select pg_has_role('${role}', '${owner}', 'MEMBER')::text`), 'false', `${role} not a member of the owner`);
  }
});

test_('rollback out of order refuses: D1 under S2-3, and the guard while any layer above (or a consumer) remains', async () => {
  let r = await apply(DB, 'R40_d1_verdicts_anonymous_strict_rollback.sql');
  assert.ok(!r.ok && r.error.includes('D1_ROLLBACK_PRECONDITION'), `D1 rollback under S2-3\n${r.error}`);
  r = await apply(DB, 'RG_base_rollback_guard.sql');
  assert.ok(!r.ok && r.error.includes('BUNDLE_ROLLBACK_GUARD_S2_2_PRESENT'), r.error);
  assert.equal(await catalog(DB), POST, 'nothing changed');
});

test_('reverse rollback R70 .. R10 with the guard returns the exact pre-bundle catalog; the guard refuses while a consumer still calls R1; reinstall', async () => {
  // the guard checks every layer: S2-2 / S2-3 rolled back first (independent of S2-1), then S2-1, then D1 -- refused until all are gone
  for (const name of [ROLLBACK[1], ROLLBACK[2]]) {
    const r = await apply(DB, name);
    assert.ok(r.ok, `${name}\n${r.error}`);
  }
  let g = await apply(DB, 'RG_base_rollback_guard.sql');
  assert.ok(!g.ok && g.error.includes('BUNDLE_ROLLBACK_GUARD_T13_NOT_REVIEWED'), `S2-1 still applied\n${g.error}`);
  g = await apply(DB, ROLLBACK[0]);
  assert.ok(g.ok, g.error);
  g = await apply(DB, 'RG_base_rollback_guard.sql');
  assert.ok(!g.ok && g.error.includes('BUNDLE_ROLLBACK_GUARD_VERDICT_NOT_REVIEWED'), `D1 still applied\n${g.error}`);
  g = await apply(DB, ROLLBACK[3]);
  assert.ok(g.ok, g.error);
  // a consumer of R1 (as G3's Threads create, G4, G6 would be): the guard refuses, the base rollbacks are not reached
  await sql(DB, `create function public.g540_consumer() returns text language plpgsql as $c$ begin
    return public.common_account_authorization_verdict('postona', 'x_publish', 'u_x')::text; end $c$`);
  let r = await apply(DB, 'RG_base_rollback_guard.sql');
  assert.ok(!r.ok && r.error.includes('BUNDLE_ROLLBACK_GUARD_CALLERS'), r.error);
  await sql(DB, 'create view public.g540_view as select private.account_lifecycle_session_verdict() as v');
  await sql(DB, 'drop function public.g540_consumer()');
  r = await apply(DB, 'RG_base_rollback_guard.sql');
  assert.ok(!r.ok && r.error.includes('BUNDLE_ROLLBACK_GUARD_DEPENDENTS'), r.error);
  await sql(DB, 'drop view public.g540_view');
  for (const name of ROLLBACK.slice(4)) {
    r = await apply(DB, name);
    assert.ok(r.ok, `${name}\n${r.error}`);
  }
  assert.equal(await catalog(DB), PRE, 'the exact pre-bundle catalog (bodies and ACLs of every function)');
  for (const name of INSTALL) {
    r = await apply(DB, name);
    assert.ok(r.ok, `reinstall ${name}\n${r.error}`);
  }
  assert.equal(await catalog(DB), POST, 'the reinstall gives the same catalog');
});

test_('FINDING (recorded): the base rollbacks R30 / R20 / R10 are unguarded -- without the guard, R10 drops R1 under D1 / S2-x and a consumer', async () => {
  for (const name of INSTALL) {
    const r = await apply(PROBE, name);
    assert.ok(r.ok, `${name}\n${r.error}`);
  }
  await sql(PROBE, `create function public.g540_consumer() returns text language plpgsql as $c$ begin
    return public.common_account_authorization_verdict('postona', 'x_publish', 'u_x')::text; end $c$`);
  const guard = await apply(PROBE, 'RG_base_rollback_guard.sql');
  assert.ok(!guard.ok, 'the guard refuses here');
  const r10 = await apply(PROBE, 'R10_r1_authorization_verdict_rollback.sql');
  assert.ok(r10.ok, `R10 runs anyway (no guard of its own)\n${r10.error}`);
  assert.equal(await md5(PROBE, F.R1), 'absent', 'R1 dropped while D1 / S2-3 / S2-2 / S2-1 are still applied');
  const broken = await run(PROBE, ['-c', 'select public.g540_consumer()']);
  assert.ok(!broken.ok && /does not exist/u.test(broken.error), `the consumer is broken\n${broken.error}`);
});
