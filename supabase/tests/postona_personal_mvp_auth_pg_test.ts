// G5-46: the PERSONAL MVP auth profile on throw-away databases (see the runner). In a world WITHOUT the brand owner epoch (PR #457 left out):
// it installs (one transaction) and refuses its own preconditions; the person gates (S2-2 / S2-3 / T13) answer as reviewed; the new personal
// worker verdict MV stops a stale job on every MVP event that can happen (service ending / ended and restarted / account deleting, a second
// member, a wrong workspace, tampered generation triggers) and -- labelled RESIDUAL -- not on an owner change undone in between, which no API
// role can make; READ COMMITTED concurrency; the rollback refuses under a consumer and otherwise restores the exact catalog; the MVP profile
// and the G5-42 migration candidate exclude each other and can be switched. Nothing about managed / production.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, superUser, prefix, MVP, MIG] = ['S46_OWNER', 'PGSUPER', 'S46_PREFIX', 'S46_MVP', 'S46_MIG'].map(env);
const decoder = new TextDecoder();
const test_ = enabled ? test : test.skip;
const db = (w: string) => `${prefix}_${w}`;
const INSTALL = `${MVP}/MVP_INSTALL.sql`;
const ROLLBACK = `${MVP}/MVP_ROLLBACK.sql`;
const FULL = `${MIG}/20261028090000_postona_personal_auth_install.sql`;
const NE = db('ne');

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
const answer = (r: Result) => r.ok ? `OK ${r.out.split('\n').pop() ?? ''}` : `ERROR ${(r.error.match(/ERROR:\s+(.*)/u)?.[1] ?? r.error).trim()}`;
const catalog = (d: string) => sql(d, `select coalesce(string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce((select string_agg(a, ',' order by a) from unnest(p.proacl::text[]) a), '-')
  || ':' || p.proowner::regrole::text || ':' || p.provolatile::text || p.prosecdef::text || p.proisstrict::text || p.proconfig::text, ' ' order by p.oid::regprocedure::text), '')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^(pg_|information_schema)'`, superUser);
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;

const id = (n: number) => `00000000-0000-4000-8000-0000000046${String(n).padStart(2, '0')}`;
const [A, B, D] = [id(1), id(2), id(4)];
const [SA, SD] = [id(51), id(54)];
type Claims = Record<string, unknown>;
const claims = (u: string, s: string, extra: Claims = {}): Claims => ({ sub: u, role: 'authenticated', session_id: s, is_anonymous: false, ...extra });
// one statement with the verified claims; `role` null = the lifecycle owner itself (as inside an owner-owned definer consumer)
async function as(c: Claims | null, statement: string, role: string | null = null, before = '', commit = false): Promise<string> {
  return answer(await run(NE, ['-c', `begin; ${before}`, '-c', `select set_config('request.jwt.claims', ${lit(c ? JSON.stringify(c) : '')}, true);${role ? ` set local role ${role};` : ''}`,
    '-c', statement, '-c', commit ? 'commit;' : 'rollback;']));
}
let WA = '';
let LV = '';
const MV = (u: string, w: string, lv: string, service = 'x_autopost') => `select private.postona_personal_worker_verdict('${u}', ${lit(w)}, ${lit(service)}, ${lv})`;
const PRE: Record<string, string> = {};

test_('install (no owner epoch in the world): a superuser or a membership write path for an API role refuses (nothing created); then one transaction, every gate owner-only; a second run refuses', async () => {
  assert.equal(await sql(NE, `select coalesce(to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)')::text, 'absent')`), 'absent', 'PR #457 is not in this world');
  PRE.ne = await catalog(NE);
  assert.match(answer(await run(NE, ['-f', INSTALL], superUser)), /^ERROR MVP_PREREQ_OWNER_IS_SUPERUSER/u);
  await sql(NE, 'grant insert on public.brand_memberships to authenticated');
  assert.match(answer(await run(NE, ['-f', INSTALL])), /^ERROR MVP_PREREQ_P3_MEMBERSHIP_WRITE/u);
  await sql(NE, 'revoke insert on public.brand_memberships from authenticated');
  assert.equal(await catalog(NE), PRE.ne, 'nothing created');
  const r = await run(NE, ['-f', INSTALL]);
  assert.ok(r.ok, r.error);
  for (const fn of ['private.postona_personal_session()', 'private.postona_personal_workspace_eligibility(uuid)', 'private.account_lifecycle_assert_active_service_write(uuid,text)',
    'private.account_lifecycle_generation_covered()', 'private.postona_personal_worker_verdict(uuid,text,text,bigint)']) {
    assert.equal(await sql(NE, `select array_to_string(proacl::text[], ',') from pg_proc where oid = '${fn}'::regprocedure`), `${owner}=X/${owner}`, fn);
  }
  assert.equal(await sql(NE, `select count(*) from pg_proc where proname in ('common_account_authorization_verdict', 'common_account_bootstrap_verdict', 'account_lifecycle_worker_brand_verdict', 'account_lifecycle_session_verdict')`), '0', 'no R1 / R0 / W1 / SV');
  const installed = await catalog(NE);
  assert.match(answer(await run(NE, ['-f', INSTALL])), /^ERROR S22_ALREADY_APPLIED/u);
  assert.equal(await catalog(NE), installed);
  // people: A and D with POSTONA started (own workspace, live session); B another login
  await sql(NE, `select public.fixture_user_with_workspace(u, 's46' || right(u::text, 2)), public.fixture_login(u) from unnest(array['${A}', '${B}', '${D}']::uuid[]) u;
    insert into auth.sessions (id, user_id, not_after) values ('${SA}', '${A}', null), ('${SD}', '${D}', null)`);
  for (const [u, s] of [[A, SA], [D, SD]]) {
    assert.equal(await as(claims(u, s), `select public.start_x_autopost_service() ->> 'status'`, 'authenticated', '', true), 'OK active');
  }
  WA = await sql(NE, `select 'u_' || substr(md5('${A}'), 1, 24)`);
  LV = await sql(NE, `select lifecycle_version from public.common_accounts where user_id = '${A}'`);
});

test_('person gates as reviewed, with no owner epoch: S2-2 active only for a live non-anonymous session; S2-3 own; T13 refuses an anonymous caller; no API role executes any gate', async () => {
  assert.equal(await as(claims(A, SA), `select private.postona_personal_session() || '/' || private.postona_personal_workspace_eligibility('${A}')`), 'OK active/own');
  for (const [label, c] of [['anonymous', claims(A, SA, { is_anonymous: true })], ['is_anonymous missing', { sub: A, role: 'authenticated', session_id: SA }],
    ['unknown session', claims(A, id(99))], ['no claims', null]] as Array<[string, Claims | null]>) {
    assert.notEqual(await as(c, 'select private.postona_personal_session()'), 'OK active', label);
  }
  assert.notEqual(await as(claims(A, SA), 'select private.postona_personal_session()', null, `update auth.sessions set not_after = now() - interval '1 minute' where id = '${SA}';`), 'OK active', 'ended session');
  assert.match(await as(claims(A, SA, { is_anonymous: true }), `select private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost')`), /^ERROR ACCOUNT_LIFECYCLE_AUTH_REQUIRED/u);
  assert.equal(await as(claims(A, SA), `select 'passed' from (select private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost')) x`), 'OK passed');
  for (const role of ['authenticated', 'anon', 'service_role']) {
    for (const q of ['select private.postona_personal_session()', MV(A, WA, LV)]) {
      assert.match(await as(claims(A, SA), q, role), /^ERROR permission denied for function /u, `${role}: ${q}`);
    }
  }
});

test_('personal worker verdict MV: active for the job\'s person / workspace / generation; refuses every MVP staleness; a session end is NOT its business (P-4); RESIDUAL: an owner change undone in between', async () => {
  assert.equal(await as(null, MV(A, WA, LV)), 'OK active');
  const SUSPEND = `update public.service_entitlements set status = 'suspended' where user_id = '${A}' and service_key = 'x_autopost';`;
  const cases: Array<[string, string, string]> = [
    ['no person', await as(null, `select private.postona_personal_worker_verdict(null, ${lit(WA)}, 'x_autopost', ${LV})`), 'OK PERSONAL_WORKER_INPUT_REQUIRED'],
    ['another service key', await as(null, MV(A, WA, LV, 'kabumori')), 'OK ACCOUNT_LIFECYCLE_SERVICE_INVALID'],
    ['no generation', await as(null, MV(A, WA, 'null')), 'OK EXPECTED_LIFECYCLE_VERSION_REQUIRED'],
    ['someone else\'s workspace', await as(null, MV(A, await sql(NE, `select 'u_' || substr(md5('${B}'), 1, 24)`), LV)), 'OK NOT_PERSONAL_WORKSPACE'],
    ['an older generation', await as(null, MV(A, WA, String(Number(LV) - 1))), 'OK SERVICE_GENERATION_CHANGED'],
    ['service being ended', await as(null, MV(A, WA, LV), null, `set local role service_role; select public.begin_service_deletion('${A}'::uuid, 'x_autopost'); reset role;`), 'OK SERVICE_DELETION_IN_PROGRESS'],
    ['service suspended', await as(null, MV(A, WA, LV), null, SUSPEND), 'OK SERVICE_NOT_ACTIVE'],
    ['a second member (B) on the workspace', await as(null, MV(A, WA, LV), null, `insert into public.brand_memberships (brand_id, user_id, role) values ('${WA}', '${B}', 'member');`), 'OK OWN_WORKSPACE_CONFLICT'],
    ['a second owner (B)', await as(null, MV(A, WA, LV), null, `insert into public.brand_memberships (brand_id, user_id, role) values ('${WA}', '${B}', 'owner');`), 'OK WORKSPACE_OWNER_UNKNOWN'],
    ['generation triggers tampered', await as(null, MV(A, WA, LV), null, `create function pg_temp.t() returns trigger language plpgsql as $t$ begin return new; end $t$;
      create trigger g546_extra before update on public.common_accounts for each row execute function pg_temp.t();`), 'OK SERVICE_GENERATION_UNAVAILABLE'],
    ['session ended (P-4: the job is the person\'s, not the session\'s)', await as(null, MV(A, WA, LV), null, `update auth.sessions set not_after = now() - interval '1 minute' where id = '${SA}';`), 'OK active'],
    ['RESIDUAL: A -> B -> A completed (owner / service_role only; no API role writes memberships)', await as(null, MV(A, WA, LV), null,
      `insert into public.brand_memberships (brand_id, user_id, role) values ('${WA}', '${B}', 'owner'); delete from public.brand_memberships where brand_id = '${WA}' and user_id = '${B}';`), 'OK active'],
  ];
  for (const [label, got, want] of cases) assert.equal(got, want, label);
  // ended and restarted: the service ends (the end saga's final state, written here as the owner), then the person reactivates it -> a new
  // generation; the job made before is stale
  const restarted = await run(NE, ['-c', `begin; update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A}' and service_key = 'x_autopost';`, '-c', `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims(A, SA)))}, true); set local role authenticated;`,
    '-c', `select public.reactivate_x_autopost_service((select lifecycle_version from public.common_accounts where user_id = '${A}')) ->> 'status'`, '-c', 'reset role;',
    '-c', `${MV(A, WA, LV)}, (select lifecycle_version from public.common_accounts where user_id = '${A}')`, '-c', 'rollback;']);
  assert.ok(restarted.ok, restarted.error);
  const [old, lv2] = restarted.out.split('\n').pop()!.split('|');
  assert.equal(old, 'SERVICE_GENERATION_CHANGED', restarted.out);
  assert.ok(Number(lv2) > Number(LV), restarted.out);
});

test_('READ COMMITTED: a job holding a transaction sees a service end committed by another session at its next check', async () => {
  const WD = await sql(NE, `select 'u_' || substr(md5('${D}'), 1, 24)`);
  const LVD = await sql(NE, `select lifecycle_version from public.common_accounts where user_id = '${D}'`);
  const job = new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', NE, '-U', owner, '-c', 'begin;', '-c', MV(D, WD, LVD),
    '-c', 'select pg_sleep(1.5);', '-c', MV(D, WD, LVD), '-c', 'commit;'], stdout: 'piped', stderr: 'piped' }).output();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await sql(NE, `set role service_role; select public.begin_service_deletion('${D}'::uuid, 'x_autopost')`);
  const out = await job;
  assert.ok(out.success, decoder.decode(out.stderr));
  assert.deepEqual(decoder.decode(out.stdout).split('\n').filter((l) => l && l !== ''), ['active', 'SERVICE_DELETION_IN_PROGRESS']);
});

test_('rollback refuses under a consumer and otherwise restores the exact catalog; the MVP profile and the G5-42 migration candidate exclude each other and can be switched', async () => {
  const installed = await catalog(NE);
  await sql(NE, `create function public.g546_consumer() returns text language sql security definer set search_path = '' as $c$ ${MV(A, WA, LV)} $c$`);
  const withConsumer = await catalog(NE);
  assert.match(answer(await run(NE, ['-f', ROLLBACK])), /^ERROR MV_ROLLBACK_PRECONDITION_(CALLERS|DEPENDENTS)/u);
  assert.equal(await catalog(NE), withConsumer, 'nothing dropped');
  await sql(NE, 'drop function public.g546_consumer()');
  assert.equal(await catalog(NE), installed);
  const r = await run(NE, ['-f', ROLLBACK]);
  assert.ok(r.ok, r.error);
  assert.equal(await catalog(NE), PRE.ne, 'the exact pre-install catalog');
  // "ep" has the owner epoch: the full candidate needs it, the MVP does not; whichever is installed first, the other refuses
  const EP = db('ep');
  const pre = await catalog(EP);
  assert.ok((await run(EP, ['-f', INSTALL])).ok, 'MVP installs where the owner epoch exists too');
  assert.match(answer(await run(EP, ['-f', FULL])), /^ERROR /u, 'the full candidate refuses on top of the MVP');
  assert.ok((await run(EP, ['-f', ROLLBACK])).ok);
  assert.equal(await catalog(EP), pre);
  assert.ok((await run(EP, ['-f', FULL])).ok, 'after the MVP rollback the full candidate installs');
  assert.match(answer(await run(EP, ['-f', INSTALL])), /^ERROR /u, 'the MVP refuses on top of the full candidate');
  assert.match(answer(await run(NE, ['-f', FULL])), /^ERROR MIGRATION_PREREQ_P2_OWNER_EPOCH_MISSING/u, 'without PR #457 only the MVP installs');
});
