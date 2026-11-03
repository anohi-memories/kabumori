// G5-42: the entrypoint-only migration candidate on throw-away databases (see the runner): the prerequisites refuse (nothing created) when one is
// missing; the install is one transaction (a cut leaves nothing, a missing is_anonymous is never allowed); the final state, ACLs and the D1 deny;
// the rollback refuses under a caller and otherwise returns the exact pre-install catalog; reinstall. Nothing about managed / production.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, superUser, prefix, MIG] = ['S42_OWNER', 'PGSUPER', 'S42_PREFIX', 'S42_MIG'].map(env);
const decoder = new TextDecoder();
const test_ = enabled ? test : test.skip;
const db = (w: string) => `${prefix}_${w}`;
const INSTALL = `${MIG}/20261028090000_postona_personal_auth_install.sql`;
const ROLLBACK = `${MIG}/ROLLBACK_20261028090000_postona_personal_auth.sql`;

type Result = { ok: boolean; out: string; error: string };
async function run(d: string, extra: string[], user = owner): Promise<Result> {
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', d, '-U', user, ...extra], stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
async function sql(d: string, statement: string, user = owner): Promise<string> {
  const r = await run(d, ['-c', statement], user);
  assert.ok(r.ok, `${statement}\n${r.error}`);
  return r.out;
}
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const catalog = (d: string) => sql(d, `select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proacl::text[], ','), '-')
  || ':' || p.proowner::regrole::text || ':' || p.provolatile::text || p.prosecdef::text || p.proisstrict::text || p.proleakproof::text || p.proparallel::text
  || p.procost::text || p.prorows::text || coalesce(p.proconfig::text, '-'), ' ' order by p.oid::regprocedure::text)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private', 'auth')`);
const P = '00000000-0000-4000-8000-000000004201';
const SESSION = '00000000-0000-4000-8000-000000004251';
async function missingClaimR1(d: string): Promise<string> {
  const ws = await sql(d, `select 'u_' || substr(md5('${P}'), 1, 24)`);
  const r = await run(d, ['-c', `begin; select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: P, role: 'authenticated', session_id: SESSION }))}, true);
    set local role authenticated; select public.common_account_authorization_verdict('postona', 'x_publish', ${lit(ws)}) ->> 'decision'; rollback;`]);
  return r.ok ? r.out.split('\n').filter((l) => l).pop() ?? '' : `ERROR ${(r.error.match(/ERROR:\s+(.*)/u)?.[1] ?? r.error).trim()}`;
}
let PRE = '';
let POST = '';

test_('a missing prerequisite refuses the whole migration and creates nothing: the lifecycle chain (P1), PR #457\'s owner epoch (P2), G3\'s L-1 revoke (P3)', async () => {
  for (const [w, code] of [['nochain', 'MIGRATION_PREREQ_P1_LIFECYCLE_CHAIN'], ['noepoch', 'MIGRATION_PREREQ_P2_OWNER_EPOCH_MISSING'], ['nol1', 'MIGRATION_PREREQ_P3_L1_REVOKE']]) {
    const before = await catalog(db(w));
    const r = await run(db(w), ['-f', INSTALL]);
    assert.ok(!r.ok && r.error.includes(code), `${w}\n${r.error}`);
    assert.equal(await catalog(db(w)), before, `${w}: nothing created`);
  }
  const r = await run(db('mig'), ['-f', INSTALL], superUser);
  assert.ok(!r.ok && r.error.includes('MIGRATION_PREREQ_OWNER_IS_SUPERUSER'), r.error);
});

test_('one transaction: the migration cut before D1, or before its commit, leaves nothing -- R1 does not exist, so a missing claim is never allowed', async () => {
  const M = db('mig');
  await sql(M, `select public.fixture_user_with_workspace('${P}'::uuid, 's42')`);
  const start = await run(M, ['-c', `begin; select set_config('request.jwt.claim.sub', '${P}', true), set_config('request.jwt.claim.role', 'authenticated', true);
    select to_jsonb(public.start_x_autopost_service())::text; commit;`]);
  assert.ok(start.ok && start.out.includes('"active"'), start.error || start.out);
  await sql(M, `insert into auth.sessions (id, user_id, not_after) values ('${SESSION}', '${P}', null)`);
  PRE = await catalog(M);
  const text = Deno.readTextFileSync(INSTALL);
  const d1 = text.indexOf('-- ==== part 40_d1_verdicts_anonymous_strict.sql');
  assert.ok(d1 > 0 && text.indexOf('-- ==== G5-42 PREREQUISITES') < text.indexOf('-- ==== part 10_r1_authorization_verdict.sql'), 'the prerequisites run first');
  for (const cut of [text.slice(0, d1), text.slice(0, text.lastIndexOf('commit;'))]) {
    const path = `${Deno.makeTempDirSync({ dir: env('S42_TMP') })}/cut.sql`;
    Deno.writeTextFileSync(path, cut);
    const r = await run(M, ['-f', path]);
    assert.ok(r.ok, r.error);
    assert.equal(await catalog(M), PRE, 'nothing committed');
    assert.match(await missingClaimR1(M), /^ERROR .*does not exist/u);
  }
});

test_('install: the final state with D1 in force (a missing claim is DENIED), the reviewed ACLs; a second run refuses', async () => {
  const M = db('mig');
  const r = await run(M, ['-f', INSTALL]);
  assert.ok(r.ok, r.error);
  assert.equal(await missingClaimR1(M), 'deny');
  const acl = (fn: string) => sql(M, `select array_to_string(proacl::text[], ',') from pg_proc where oid = '${fn}'::regprocedure`);
  assert.equal(await acl('public.common_account_authorization_verdict(text,text,text)'), `${owner}=X/${owner},authenticated=X/${owner}`);
  assert.equal(await acl('public.common_account_bootstrap_verdict(text,text)'), `${owner}=X/${owner},authenticated=X/${owner}`);
  assert.equal(await acl('public.common_account_worker_brand_verdict(text,text,bigint,bigint)'), `${owner}=X/${owner},service_role=X/${owner}`);
  for (const fn of ['private.account_lifecycle_session_verdict()', 'private.postona_personal_session()', 'private.postona_personal_workspace_eligibility(uuid)',
    'private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)', 'private.account_lifecycle_assert_active_service_write(uuid,text)']) {
    assert.equal(await acl(fn), `${owner}=X/${owner}`, `${fn}: owner-only`);
  }
  POST = await catalog(M);
  const again = await run(M, ['-f', INSTALL]);
  assert.ok(!again.ok && again.error.includes('AUTH_VERDICT_ALREADY_APPLIED'), again.error);
  assert.equal(await catalog(M), POST);
});

test_('rollback: refuses (dropping nothing) under a consumer of R1; otherwise the exact pre-install catalog; reinstall gives the same state', async () => {
  const M = db('mig');
  await sql(M, `create function public.g542_consumer() returns text language plpgsql as $c$ begin return public.common_account_authorization_verdict('postona', 'x_publish', 'u_x')::text; end $c$`);
  let r = await run(M, ['-f', ROLLBACK]);
  assert.ok(!r.ok && r.error.includes('BUNDLE_ROLLBACK_CALLERS'), r.error);
  await sql(M, 'drop function public.g542_consumer()');
  assert.equal(await catalog(M), POST, 'nothing dropped');
  r = await run(M, ['-f', ROLLBACK]);
  assert.ok(r.ok, r.error);
  assert.equal(await catalog(M), PRE, 'the exact pre-install catalog');
  r = await run(M, ['-f', INSTALL]);
  assert.ok(r.ok, r.error);
  assert.equal(await catalog(M), POST);
});
