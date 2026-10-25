// G5-41: the bundle's two entrypoints (INSTALL_ALL.sql / ROLLBACK_ALL.sql, generated from the verbatim parts) against H2's two P2 findings on
// PR #531. STAGE reproduces both on the per-file procedure first; ENTRY shows the entrypoints closing them. Throw-away databases only; nothing
// about managed / production / GoTrue. Needs CAL_E2E=1 and the runner's environment.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, superUser, ENTRY, STAGE, B] = ['S40_OWNER', 'PGSUPER', 'S40_ENTRY', 'S40_STAGE', 'S40_BUNDLE'].map(env);
const decoder = new TextDecoder();
const test_ = enabled ? test : test.skip;

type Result = { ok: boolean; out: string; error: string };
const args = (db: string, user: string, extra: string[]) => ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-U', user, ...extra];
async function run(db: string, extra: string[], user = owner): Promise<Result> {
  const out = await new Deno.Command('psql', { args: args(db, user, extra), stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
async function sql(db: string, statement: string, user = owner): Promise<string> {
  const r = await run(db, ['-c', statement], user);
  assert.ok(r.ok, `${statement}\n${r.error}`);
  return r.out;
}
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const file = (name: string) => `${B}/${name}`;
const INSTALL_ALL = enabled ? Deno.readTextFileSync(file('INSTALL_ALL.sql')) : '';
const ROLLBACK_ALL = 'ROLLBACK_ALL.sql';
const tmp = (name: string, text: string) => {
  const path = `${Deno.makeTempDirSync({ dir: env('S40_TMP'), prefix: 'g541-' })}/${name}`;
  Deno.writeTextFileSync(path, text);
  return path;
};
// every function of public / private / auth: body checksum, ACL, owner and the attributes a CREATE OR REPLACE / DROP would touch
const catalog = (db: string) => sql(db, `select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proacl::text[], ','), '-')
  || ':' || p.proowner::regrole::text || ':' || p.provolatile::text || p.prosecdef::text || p.proisstrict::text || p.proleakproof::text || p.proparallel::text
  || p.procost::text || p.prorows::text || coalesce(p.proconfig::text, '-'), ' ' order by p.oid::regprocedure::text)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private', 'auth')`);
const R1 = 'public.common_account_authorization_verdict(text,text,text)';
const exists = (db: string, fn: string) => sql(db, `select (to_regprocedure('${fn}') is not null)::text`);

// a person (own workspace, x_autopost active, a live session), the same ids in both databases
const P = uid(4101);
const SESSION = uid(4151);
async function seed(db: string) {
  await sql(db, `select public.fixture_user_with_workspace('${P}'::uuid, 's41')`);
  const start = await run(db, ['-c', `begin; select set_config('request.jwt.claim.sub', '${P}', true), set_config('request.jwt.claim.role', 'authenticated', true);
    select to_jsonb(public.start_x_autopost_service())::text; commit;`]);
  assert.ok(start.ok && start.out.includes('"active"'), start.error || start.out);
  await sql(db, `insert into auth.sessions (id, user_id, not_after) values ('${SESSION}', '${P}', null)`);
}
// R1 as `authenticated` with the claim `is_anonymous` MISSING (H2's F2 probe): the decision, or the error
async function missingClaimR1(db: string): Promise<string> {
  const ws = await sql(db, `select 'u_' || substr(md5('${P}'), 1, 24)`);
  const claims = JSON.stringify({ sub: P, role: 'authenticated', session_id: SESSION });
  const r = await run(db, ['-c', `begin; select set_config('request.jwt.claims', ${lit(claims)}, true); set local role authenticated;
    select (public.common_account_authorization_verdict('postona', 'x_publish', ${lit(ws)}) ->> 'decision'); rollback;`]);
  return r.ok ? r.out.split('\n').filter((l) => l).pop() ?? '' : `ERROR ${(r.error.match(/ERROR:\s+(.*)/u)?.[1] ?? r.error).trim()}`;
}

test_('FAIL before (H2 F2 on PR #531): the per-file procedure commits 10..30 first -- a missing is_anonymous claim gets an R1 ALLOW in between', async () => {
  await seed(STAGE);
  for (const name of ['10_r1_authorization_verdict.sql', '20_r0_bootstrap_verdict.sql', '30_sv_session_verdict.sql']) {
    const r = await run(STAGE, ['-f', file(name)]);
    assert.ok(r.ok, `${name}\n${r.error}`);
  }
  assert.equal(await missingClaimR1(STAGE), 'allow', 'the intermediate state H2 reproduced');
});

test_('FAIL before (H2 F1 on PR #531): R30 / R20 / R10 run alone drop SV / R0 / R1 under a consumer that calls them', async () => {
  await sql(STAGE, `create function public.g541_consumer() returns text language plpgsql as $c$ begin
    perform private.account_lifecycle_session_verdict(); perform public.common_account_bootstrap_verdict('postona', 'x_connect_bootstrap');
    return public.common_account_authorization_verdict('postona', 'x_publish', 'u_x')::text; end $c$`);
  for (const name of ['R30_sv_session_verdict_rollback.sql', 'R20_r0_bootstrap_verdict_rollback.sql', 'R10_r1_authorization_verdict_rollback.sql']) {
    const r = await run(STAGE, ['-f', file(name)]);
    assert.ok(r.ok, `${name} runs alone (an unguarded part)\n${r.error}`);
  }
  assert.equal(await exists(STAGE, R1), 'false');
  const broken = await run(STAGE, ['-c', 'select public.g541_consumer()']);
  assert.ok(!broken.ok && /does not exist/u.test(broken.error), broken.error);
});

let PRE = '';
let POST = '';
test_('F2 fixed: INSTALL_ALL is one transaction -- cut before D1, cut before the commit, or a late refusal leaves NOTHING; R1 never answers', async () => {
  await seed(ENTRY);
  PRE = await catalog(ENTRY);
  assert.equal(INSTALL_ALL.split('\n').filter((l) => l === 'begin;').length, 1, 'one begin');
  assert.equal(INSTALL_ALL.split('\n').filter((l) => l === 'commit;').length, 1, 'one commit');
  const d1 = INSTALL_ALL.indexOf('-- ==== part 40_d1_verdicts_anonymous_strict.sql');
  assert.ok(d1 > 0);
  // an interruption: the session ends before the commit (psql reaches EOF inside the transaction) -- after 10..30, and after everything
  for (const [label, text] of [['cut before D1 (only 10..30 ran)', INSTALL_ALL.slice(0, d1)], ['everything but the final commit', INSTALL_ALL.slice(0, INSTALL_ALL.lastIndexOf('commit;'))]]) {
    const r = await run(ENTRY, ['-f', tmp('cut.sql', text)]);
    assert.ok(r.ok, `${label}: psql itself ran\n${r.error}`);
    assert.equal(await catalog(ENTRY), PRE, `${label}: nothing committed`);
    assert.match(await missingClaimR1(ENTRY), /^ERROR .*does not exist/u, `${label}: R1 does not exist, so no allow`);
  }
  // a refusal in the LAST part (S2-1 on a drifted T13): the whole install is undone
  await sql(ENTRY, `alter function private.account_lifecycle_assert_active_service_write(uuid, text) cost 50`);
  const drifted = await catalog(ENTRY);
  let r = await run(ENTRY, ['-f', file('INSTALL_ALL.sql')]);
  assert.ok(!r.ok && r.error.includes('T13_ANON_PRECONDITION_SHAPE'), r.error);
  assert.equal(await catalog(ENTRY), drifted, 'parts 10..60 undone with the transaction');
  await sql(ENTRY, `alter function private.account_lifecycle_assert_active_service_write(uuid, text) cost 100`);
  assert.equal(await catalog(ENTRY), PRE);
  r = await run(ENTRY, ['-f', file('INSTALL_ALL.sql')], superUser);
  assert.ok(!r.ok, 'a superuser run refuses');
  assert.equal(await catalog(ENTRY), PRE);
});

test_('F2 fixed: while INSTALL_ALL is running (held before its commit), another session sees no R1 at all; after the commit, the missing claim is DENIED', async () => {
  const held = tmp('held.sql', INSTALL_ALL.slice(0, INSTALL_ALL.lastIndexOf('commit;')) + "select pg_sleep(3) /* g541-hold */;\ncommit;\n");
  const child = new Deno.Command('psql', { args: args(ENTRY, owner, ['-f', held]), stdout: 'piped', stderr: 'piped' }).spawn();
  for (let i = 0; i < 200; i += 1) {
    if ((await sql(ENTRY, `select count(*) from pg_stat_activity where wait_event = 'PgSleep' and position('g541-hold' in query) > 0`, superUser)) === '1') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await sql(ENTRY, `select count(*) from pg_stat_activity where wait_event = 'PgSleep' and position('g541-hold' in query) > 0`, superUser), '1', 'the install is held');
  assert.equal(await exists(ENTRY, R1), 'false', 'R1 is invisible to another session mid-install');
  assert.match(await missingClaimR1(ENTRY), /^ERROR .*does not exist/u);
  const done = await child.output();
  assert.ok(done.success, decoder.decode(done.stderr));
  assert.equal(await missingClaimR1(ENTRY), 'deny', 'after the commit: D1 is in force, the missing claim is denied');
  POST = await catalog(ENTRY);
  const again = await run(ENTRY, ['-f', file('INSTALL_ALL.sql')]);
  assert.ok(!again.ok && again.error.includes('AUTH_VERDICT_ALREADY_APPLIED'), again.error);
  assert.equal(await catalog(ENTRY), POST, 'a second INSTALL_ALL changes nothing');
});

test_('F1 fixed: ROLLBACK_ALL refuses, dropping NOTHING, under any caller / dependent, in a partial state, or as a superuser', async () => {
  const refusals: Array<[string, string, string, string]> = [
    ['a PL/pgSQL caller of R1', `create function public.g541_c1() returns text language plpgsql as $c$ begin return public.common_account_authorization_verdict('postona', 'x_publish', 'u_x')::text; end $c$`,
      'drop function public.g541_c1()', 'BUNDLE_ROLLBACK_CALLERS'],
    ['an upper-case caller of S2-2', `create function public.g541_c2() returns text language plpgsql as $c$ begin return PRIVATE.POSTONA_PERSONAL_SESSION(); end $c$`,
      'drop function public.g541_c2()', 'BUNDLE_ROLLBACK_CALLERS'],
    ['a plain SQL caller of W1', `create function public.g541_c3() returns text language sql as $c$ select private.account_lifecycle_worker_brand_verdict('u_x', 'x_autopost', 1, 1) $c$`,
      'drop function public.g541_c3()', 'BUNDLE_ROLLBACK_CALLERS'],
    ['a view on SV', 'create view public.g541_v as select private.account_lifecycle_session_verdict() as v', 'drop view public.g541_v', 'BUNDLE_ROLLBACK_DEPENDENTS'],
    ['a BEGIN ATOMIC caller of R0', `create function public.g541_c4() returns jsonb language sql begin atomic select public.common_account_bootstrap_verdict('postona', 'x_connect_bootstrap'); end`,
      'drop function public.g541_c4()', 'BUNDLE_ROLLBACK_DEPENDENTS'],
    ['a partial state (S2-1 rolled back by hand)', '', '', 'BUNDLE_ROLLBACK_STATE_NOT_INSTALLED'],
  ];
  for (const [label, create, drop, code] of refusals) {
    if (create) await sql(ENTRY, create);
    else assert.ok((await run(ENTRY, ['-f', file('R70_s2_1_t13_anonymous_refusal_rollback.sql')])).ok);
    const before = await catalog(ENTRY);
    const r = await run(ENTRY, ['-f', file(ROLLBACK_ALL)]);
    assert.ok(!r.ok && r.error.includes(code), `${label}\n${r.error}`);
    assert.equal(await catalog(ENTRY), before, `${label}: nothing dropped or restored`);
    if (drop) await sql(ENTRY, drop);
    else assert.ok((await run(ENTRY, ['-f', file('70_s2_1_t13_anonymous_refusal.sql')])).ok);
  }
  assert.equal(await catalog(ENTRY), POST);
  const r = await run(ENTRY, ['-f', file(ROLLBACK_ALL)], superUser);
  assert.ok(!r.ok && r.error.includes('BUNDLE_ROLLBACK_OWNER_IS_SUPERUSER'), r.error);
  assert.equal(await catalog(ENTRY), POST);
});

test_('ROLLBACK_ALL returns the exact pre-install catalog; a second run refuses; INSTALL_ALL / ROLLBACK_ALL cycle again', async () => {
  let r = await run(ENTRY, ['-f', file(ROLLBACK_ALL)]);
  assert.ok(r.ok, r.error);
  assert.equal(await catalog(ENTRY), PRE, 'the exact pre-install catalog (bodies, ACLs, owners, attributes, settings)');
  r = await run(ENTRY, ['-f', file(ROLLBACK_ALL)]);
  assert.ok(!r.ok && r.error.includes('BUNDLE_ROLLBACK_STATE_NOT_INSTALLED'), r.error);
  assert.equal(await catalog(ENTRY), PRE);
  r = await run(ENTRY, ['-f', file('INSTALL_ALL.sql')]);
  assert.ok(r.ok, r.error);
  assert.equal(await catalog(ENTRY), POST, 'the same post-install catalog');
  r = await run(ENTRY, ['-f', file(ROLLBACK_ALL)]);
  assert.ok(r.ok, r.error);
  assert.equal(await catalog(ENTRY), PRE);
});
