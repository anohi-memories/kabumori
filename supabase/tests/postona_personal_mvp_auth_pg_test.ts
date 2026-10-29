// G5-46: the PERSONAL MVP auth profile on throw-away databases (see the runner). In a world WITHOUT the brand owner epoch (PR #457 left out):
// it installs (one transaction) and refuses its own preconditions; the person gates (S2-2 / S2-3 / T13) answer as reviewed; the new personal
// worker verdict MV stops a stale job on every MVP event that can happen (service ending / ended and restarted / account deleting, a second
// member, a wrong workspace, tampered generation triggers) and -- labelled RESIDUAL -- not on an owner change undone in between, which no API
// role can make; READ COMMITTED concurrency; the rollback refuses under a consumer and otherwise restores the exact catalog; the MVP profile
// and the G5-42 migration candidate exclude each other and can be switched. Nothing about managed / production.
// G5-48: R1-MVP's one EXECUTE to authenticated (MVP_R1_EXECUTE_GRANT.sql) refuses every drift with nothing changed; the same R1 calls before
// the grant (all permission denied), after it (the person allowed, every other caller / token / app / workspace / state fail-closed) and after
// the idempotent stop (denied again); G6's PR #556 personal-MVP adapter (read-only archive) over its real transport, run here as the person.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, superUser, prefix, MVP, MIG, G6, G6M] = ['S46_OWNER', 'PGSUPER', 'S46_PREFIX', 'S46_MVP', 'S46_MIG', 'S46_G6', 'S48_G6M'].map(env);
const decoder = new TextDecoder();
const test_ = enabled ? test : test.skip;
const db = (w: string) => `${prefix}_${w}`;
const INSTALL = `${MVP}/MVP_INSTALL.sql`;
const ROLLBACK = `${MVP}/MVP_ROLLBACK.sql`;
const FULL = `${MIG}/20261028090000_postona_personal_auth_install.sql`;
const GRANT = `${MVP}/MVP_R1_EXECUTE_GRANT.sql`;
const REVOKE = `${MVP}/MVP_R1_EXECUTE_REVOKE.sql`;
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
// one statement with the verified claims (a string = raw claims text); `role` null = the lifecycle owner itself (as inside an owner-owned definer consumer)
async function as(c: Claims | string | null, statement: string, role: string | null = null, before = '', commit = false): Promise<string> {
  return answer(await run(NE, ['-c', `begin; ${before}`, '-c', `select set_config('request.jwt.claims', ${lit(c === null ? '' : typeof c === 'string' ? c : JSON.stringify(c))}, true);${role ? ` set local role ${role};` : ''}`,
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
  assert.equal(await sql(NE, `select count(*) from pg_proc where proname in ('common_account_bootstrap_verdict', 'account_lifecycle_worker_brand_verdict', 'common_account_worker_brand_verdict', 'account_lifecycle_session_verdict')`), '0', 'no R0 / W1 / W2 / SV');
  // (G5-47) R1 is the MVP body: the personal generation token, no owner epoch
  assert.equal(await sql(NE, `select (strpos(prosrc, '''g5pv:'' || f_lifecycle::text') > 0) || '/' || (strpos(prosrc, 'owner_epoch(') = 0) from pg_proc where oid = 'public.common_account_authorization_verdict(text,text,text)'::regprocedure`), 'true/true');
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

// ---- G5-48: R1-MVP's ONE EXECUTE to authenticated (MVP_R1_EXECUTE_GRANT.sql) and its stop (MVP_R1_EXECUTE_REVOKE.sql) ------------------------
const R1FN = 'public.common_account_authorization_verdict(text,text,text)';
const R1SIG = `'${R1FN}'::regprocedure`;
const r1acl = () => sql(NE, `select array_to_string(proacl::text[], ',') from pg_proc where oid = ${R1SIG}`);
const OWNER_ONLY = () => `${owner}=X/${owner}`;
const DENIED = /^ERROR permission denied for function common_account_authorization_verdict/u;

test_('EXECUTE grant: refuses with nothing changed as a superuser, as another role, on a drifted body / config / security, beside an overload, an ACL drift, a widened gate or a role graph that leaks authenticated; else exactly owner + authenticated, and a second run refuses; the stop is idempotent and clears any grantee', async () => {
  const installed = await catalog(NE);
  assert.equal(await r1acl(), OWNER_ONLY(), 'shipped owner-only');
  const refused = async (label: string, args: string[], want: RegExp, user = owner) => {
    const before = await catalog(NE);
    assert.match(answer(await run(NE, args, user)), want, label);
    assert.equal(await catalog(NE), before, `${label}: nothing changed`);
  };
  await refused('superuser', ['-f', GRANT], /^ERROR R1MVP_EXEC_PRECONDITION_OWNER_IS_SUPERUSER/u, superUser);
  await refused('another role (service_role)', ['-c', 'set role service_role', '-f', GRANT], /^ERROR R1MVP_EXEC_PRECONDITION_NOT_MVP/u);
  const def = await sql(NE, `select pg_get_functiondef(${R1SIG})`);
  const drifts: Array<[string, string, string]> = [
    ['a drifted body', def.replace("'FEATURE_NOT_ENABLED'", "'FEATURE_NOT_ENABLED' "), def],
    ['a drifted search_path', `alter function ${R1FN} set search_path = public`, `alter function ${R1FN} set search_path = ''`],
    ['security invoker', `alter function ${R1FN} security invoker`, `alter function ${R1FN} security definer`],
    ['volatile', `alter function ${R1FN} volatile`, `alter function ${R1FN} stable`],
  ];
  for (const [label, drift, restore] of drifts) {
    await sql(NE, drift);
    try {
      await refused(label, ['-f', GRANT], /^ERROR R1MVP_EXEC_PRECONDITION_NOT_MVP/u);
    } finally {
      await sql(NE, restore);
    }
    assert.equal(await catalog(NE), installed, `${label}: restored`);
  }
  const fenced: Array<[string, string, string, RegExp, string?]> = [
    ['an ACL drift (service_role granted)', `grant execute on function ${R1FN} to service_role`, `revoke execute on function ${R1FN} from service_role`, /^ERROR R1MVP_EXEC_PRECONDITION_ACL/u],
    ['an overload', `create function public.common_account_authorization_verdict(text, text, text, text) returns jsonb language sql as $o$ select null::jsonb $o$`,
      'drop function public.common_account_authorization_verdict(text, text, text, text)', /^ERROR R1MVP_EXEC_PRECONDITION_OVERLOAD/u],
    ['a widened gate (GC)', 'grant execute on function private.account_lifecycle_generation_covered() to authenticated',
      'revoke execute on function private.account_lifecycle_generation_covered() from authenticated', /^ERROR R1MVP_EXEC_PRECONDITION_DEPENDENCY/u],
    ['a widened gate (S2-3)', 'grant execute on function private.postona_personal_workspace_eligibility(uuid) to authenticated',
      'revoke execute on function private.postona_personal_workspace_eligibility(uuid) from authenticated', /^ERROR R1MVP_EXEC_PRECONDITION_DEPENDENCY/u],
    ['anon inherits authenticated', 'grant authenticated to anon', 'revoke authenticated from anon', /^ERROR R1MVP_EXEC_PRECONDITION_ROLE_GRAPH/u, superUser],
    ['service_role inherits authenticated', 'grant authenticated to service_role', 'revoke authenticated from service_role', /^ERROR R1MVP_EXEC_PRECONDITION_ROLE_GRAPH/u, superUser],
  ];
  for (const [label, drift, restore, want, user] of fenced) {
    await sql(NE, drift, user ?? owner);
    try {
      await refused(label, ['-f', GRANT], want);
    } finally {
      await sql(NE, restore, user ?? owner);
    }
  }
  assert.equal(await catalog(NE), installed, 'every refusal left the installed catalog');
  const g = await run(NE, ['-f', GRANT]);
  assert.ok(g.ok, g.error);
  assert.equal(await r1acl(), `${owner}=X/${owner},authenticated=X/${owner}`, 'exactly owner + authenticated');
  assert.equal(await sql(NE, `select string_agg(r || '=' || has_function_privilege(r, ${R1SIG}, 'EXECUTE'), ',' order by r) from unnest(array['anon', 'authenticated', 'service_role']) r`, superUser),
    'anon=false,authenticated=true,service_role=false');
  await refused('a second run', ['-f', GRANT], /^ERROR R1MVP_EXEC_PRECONDITION_ACL/u);
  // the stop: refuses only as a superuser or on something that is not R1-MVP; idempotent; clears grantees made outside these files too
  await refused('stop as a superuser', ['-f', REVOKE], /^ERROR R1MVP_EXEC_REVOKE_PRECONDITION_OWNER_IS_SUPERUSER/u, superUser);
  await refused('stop as another role', ['-c', 'set role service_role', '-f', REVOKE], /^ERROR R1MVP_EXEC_REVOKE_PRECONDITION_NOT_MVP/u);
  await sql(NE, `grant execute on function ${R1FN} to anon, public, service_role, authenticator`);
  for (let i = 0; i < 2; i++) {
    const r = await run(NE, ['-f', REVOKE]);
    assert.ok(r.ok, r.error);
    assert.equal(await r1acl(), OWNER_ONLY(), `stop run ${i + 1}`);
    assert.equal(await catalog(NE), installed, `stop run ${i + 1}: the installed catalog`);
  }
});

// ---- G5-47 / G5-48: R1-MVP (the R1 v1 verdict with the personal generation token) and G6 --------------------------------------------------
const R1 = (w: string, feature = 'consult', app = 'postona') => `select public.common_account_authorization_verdict(${lit(app)}, ${lit(feature)}, ${lit(w)})::text`;
// the decision and reason only, or the allow's token
const brief = (got: string) => {
  if (!got.startsWith('OK ')) return got;
  const v = JSON.parse(got.slice(3));
  return v.decision === 'allow' ? `allow ${v.owner_epoch}` : `${v.decision}:${v.reason}`;
};
const restart = () => `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A}' and service_key = 'x_autopost';
  select set_config('request.jwt.claims', ${lit(JSON.stringify(claims(A, SA)))}, true); set local role authenticated;
  select public.reactivate_x_autopost_service((select lifecycle_version from public.common_accounts where user_id = '${A}')); reset role;`;
const grant = async () => { const r = await run(NE, ['-f', GRANT]); assert.ok(r.ok, r.error); };
const stop = async () => { const r = await run(NE, ['-f', REVOKE]); assert.ok(r.ok, r.error); };

test_('R1-MVP before / after the EXECUTE grant / after the stop: as shipped every authenticated call is permission denied; granted, the person gets the v1 wire with owner_epoch = g5pv:<lifecycle_version>, and every other caller, token, app, workspace or state fails closed; the token is monotonic; RESIDUAL A -> B -> A; stopped, denied again', async () => {
  const WB = await sql(NE, `select 'u_' || substr(md5('${B}'), 1, 24)`);
  const endOp = `set local role service_role; select public.begin_service_deletion('${A}'::uuid, 'x_autopost'); reset role;`;
  // E: another person with a live session and an active service, made inside the rolled-back transaction
  const [E, SE] = [id(5), id(55)];
  const liveE = `select public.fixture_user_with_workspace('${E}', 's4805'), public.fixture_login('${E}');
    insert into auth.sessions (id, user_id, not_after) values ('${SE}', '${E}', null);
    select set_config('request.jwt.claims', ${lit(JSON.stringify(claims(E, SE)))}, true); set local role authenticated; select public.start_x_autopost_service(); reset role;`;
  // [label, claims (a string = raw claims text), statement, before, the answer once granted]
  const cases: Array<[string, Claims | string | null, string, string, string]> = [
    ['the person', claims(A, SA), R1(WA), '', `allow g5pv:${LV}`],
    ['anonymous', claims(A, SA, { is_anonymous: true }), R1(WA), '', 'deny:AUTH_REQUIRED'],
    ['is_anonymous missing', { sub: A, role: 'authenticated', session_id: SA }, R1(WA), '', 'deny:AUTH_REQUIRED'],
    ['is_anonymous the string "false"', claims(A, SA, { is_anonymous: 'false' }), R1(WA), '', 'deny:AUTH_REQUIRED'],
    ['no claims', null, R1(WA), '', 'deny:AUTH_REQUIRED'],
    ['claims not JSON', '{"sub": "' + A, R1(WA), '', 'deny:AUTH_REQUIRED'],
    ['role claim anon', claims(A, SA, { role: 'anon' }), R1(WA), '', 'deny:AUTH_REQUIRED'],
    ['role claim service_role', claims(A, SA, { role: 'service_role' }), R1(WA), '', 'deny:AUTH_REQUIRED'],
    ['sub not a uuid', claims('not-a-uuid', SA), R1(WA), '', 'deny:AUTH_REQUIRED'],
    ['session_id missing', { sub: A, role: 'authenticated', is_anonymous: false }, R1(WA), '', 'deny:AUTH_REQUIRED'],
    ['a login that does not exist', claims(id(97), SA), R1(WA), '', 'deny:AUTH_REQUIRED'],
    ['another person\'s live session id under the person\'s sub', claims(A, SD), R1(WA), '', 'deny:SESSION_REVOKED'],
    ['an unknown session', claims(A, id(98)), R1(WA), '', 'deny:SESSION_REVOKED'],
    ['an ended session', claims(A, SA), R1(WA), `update auth.sessions set not_after = now() - interval '1 minute' where id = '${SA}';`, 'deny:SESSION_EXPIRED'],
    ['another app', claims(A, SA), R1(WA, 'consult', 'kabumori'), '', 'deny:FEATURE_NOT_ENABLED'],
    ['an unknown feature', claims(A, SA), R1(WA, 'admin'), '', 'deny:FEATURE_NOT_ENABLED'],
    ['a malformed workspace id', claims(A, SA), R1('U_bad!'), '', 'deny:BRAND_REQUIRED'],
    // E: another person with a live session and an active service (made inside this rolled-back transaction) asking for A's workspace
    ['another active person asking for the person\'s workspace', claims(E, SE), R1(WA), liveE, 'deny:BRAND_ACCESS_DENIED'],
    ['another person\'s workspace', claims(A, SA), R1(WB), '', 'deny:BRAND_ACCESS_DENIED'],
    ['an unknown workspace', claims(A, SA), R1('u_000000000000000000000000'), '', 'deny:BRAND_ACCESS_DENIED'],
    ['a second member', claims(A, SA), R1(WA), `insert into public.brand_memberships (brand_id, user_id, role) values ('${WA}', '${B}', 'member');`, 'deny:OWN_WORKSPACE_CONFLICT'],
    ['a second owner', claims(A, SA), R1(WA), `insert into public.brand_memberships (brand_id, user_id, role) values ('${WA}', '${B}', 'owner');`, 'unknown:WORKSPACE_OWNER_UNKNOWN'],
    ['service suspended', claims(A, SA), R1(WA), `update public.service_entitlements set status = 'suspended' where user_id = '${A}' and service_key = 'x_autopost';`, 'deny:SERVICE_SUSPENDED'],
    ['service ended (not restarted)', claims(A, SA), R1(WA), `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A}' and service_key = 'x_autopost';`, 'deny:SERVICE_NOT_ACTIVE'],
    ['service being ended', claims(A, SA), R1(WA), endOp, 'deny:SERVICE_DELETION_IN_PROGRESS'],
    // an end operation in progress while the entitlement row still reads active (an inconsistent state, written here as the owner)
    ['end operation in progress, entitlement row active', claims(A, SA), R1(WA), `${endOp}
      update public.service_entitlements set status = 'active' where user_id = '${A}' and service_key = 'x_autopost';`, 'deny:SERVICE_DELETION_IN_PROGRESS'],
    ['generation triggers tampered', claims(A, SA), R1(WA), `create function pg_temp.t() returns trigger language plpgsql as $t$ begin return new; end $t$;
      create trigger g547_extra before update on public.common_accounts for each row execute function pg_temp.t();`, 'unknown:SERVICE_GENERATION_UNAVAILABLE'],
    ['RESIDUAL: A -> B -> A completed (owner / service_role only)', claims(A, SA), R1(WA),
      `insert into public.brand_memberships (brand_id, user_id, role) values ('${WA}', '${B}', 'owner'); delete from public.brand_memberships where brand_id = '${WA}' and user_id = '${B}';`, `allow g5pv:${LV}`],
  ];
  for (const [label, c, statement, before] of cases) assert.match(await as(c, statement, 'authenticated', before), DENIED, `as shipped: ${label}`);
  await grant();
  try {
    const allow = JSON.parse((await as(claims(A, SA), R1(WA), 'authenticated')).slice(3));
    assert.equal(Object.keys(allow).sort().join(','), 'decision,entitlements,owner_epoch,reason,scope,session,subject,v', 'the v1 wire, 8 keys');
    assert.deepEqual([allow.decision, allow.reason, allow.owner_epoch, allow.entitlements, allow.subject, allow.scope, allow.session.state],
      ['allow', null, `g5pv:${LV}`, ['postona:x_autopost'], { kind: 'user', user_id: A }, { app: 'postona', feature: 'consult', brand_slug: WA }, 'active']);
    assert.ok(!JSON.stringify(allow).includes(SA), 'the raw session id never leaves R1');
    for (const [label, c, statement, before, want] of cases) assert.equal(brief(await as(c, statement, 'authenticated', before)), want, `granted: ${label}`);
    // control: E itself is allowed on E's own workspace, so the refusal above is the workspace step
    assert.match(brief(await as(claims(E, SE), `select public.common_account_authorization_verdict('postona', 'consult', 'u_' || substr(md5('${E}'), 1, 24))::text`, 'authenticated', liveE)),
      /^allow g5pv:[1-9][0-9]*$/u, 'control: E on E\'s own workspace');
    // ended and restarted: the token moves up, so the old one never comes back
    const token = brief(await as(claims(A, SA), R1(WA), 'authenticated', restart()));
    assert.match(token, /^allow g5pv:[1-9][0-9]*$/u, token);
    assert.ok(Number(token.split(':')[1]) > Number(LV), `${token} > g5pv:${LV}`);
    for (const role of ['anon', 'service_role']) assert.match(await as(claims(A, SA), R1(WA), role), DENIED, `granted: ${role} still denied`);
  } finally {
    await stop();
  }
  for (const [label, c, statement, before] of cases) assert.match(await as(c, statement, 'authenticated', before), DENIED, `stopped: ${label}`);
});

test_('G6: PR #500\'s UNCHANGED port refuses the MVP allow (fail-closed); PR #556\'s personal-MVP adapter (read-only archive) over its REAL transport, whose request runs here as the person: denied before the grant, allow after it, generation stable / moved / denied, and not allow again after the stop', async () => {
  // the transport's request, executed here as the person (claims of A / SA) with R1-MVP's real answer; `failWith` = what PostgREST would answer
  let before = '';
  const seen: string[] = [];
  const fetchAsPerson = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = JSON.parse(String(init?.body ?? ''));
    seen.push(`${init?.method ?? 'GET'} ${url.pathname} ${Object.keys(body).sort().join(',')}`);
    const got = await as(claims(A, SA), R1(body.p_brand_id, body.p_feature, body.p_app), 'authenticated', before);
    return got.startsWith('OK ') ? new Response(got.slice(3), { status: 200 })
      : new Response(JSON.stringify({ code: '42501', message: got.slice(6) }), { status: DENIED.test(got) ? 403 : 500 });
  };
  const load = async (dir: string, pin: boolean, feature: string) => {
    const { createG5RpcTransport } = await import(`file://${dir}/supabase/ai_gateway/g5_rpc_transport.ts`);
    const { createG5AuthorityPort } = await import(`file://${dir}/supabase/ai_gateway/authority_port.ts`);
    const raw = createG5RpcTransport({ supabaseUrl: 'https://example.invalid', publishableKey: 'fake-publishable-key-0123456789', fetch: fetchAsPerson });
    const transport = pin ? (await import(`file://${dir}/supabase/ai_gateway/postona_post_assist_mvp.ts`)).pinPersonalMvpProfile(raw) : raw;
    return createG5AuthorityPort({ transport, planAllowlist: new Map([[`postona:${feature}`, ['postona:x_autopost']]]) });
  };
  const scope = (feature: string) => ({ app: 'postona', feature, brand: { app: 'postona', slug: WA } });
  const unchanged = await load(G6, false, 'consult');
  const adapter = await load(G6M, true, 'post_generation');
  const S = scope('post_generation');
  const shipped = await adapter.verdict('aaa.bbb.ccc', S);
  assert.notEqual(shipped.decision, 'allow', `as shipped (owner-only) the real path never allows: ${shipped.decision}:${shipped.reason}`);
  await grant();
  try {
    const today = await unchanged.verdict('aaa.bbb.ccc', scope('consult'));
    assert.equal(`${today.decision}:${today.reason}`, 'unknown:OWNER_EPOCH_SHAPE', 'today\'s G6 port alone never allows a g5pv token');
    const v1 = await adapter.verdict('aaa.bbb.ccc', S);
    assert.equal(v1.decision, 'allow', JSON.stringify(v1));
    const same = await adapter.recheck(v1);
    assert.equal(`${same.decision}:${same.generation === v1.generation}`, 'allow:true', 'nothing changed: the same generation');
    before = restart();
    const moved = await adapter.recheck(v1);
    assert.equal(`${moved.decision}:${moved.generation === v1.generation}`, 'allow:false', 'end + restart: the generation moves, so the gateway stops the prior call');
    before = `update public.service_entitlements set status = 'suspended' where user_id = '${A}' and service_key = 'x_autopost';`;
    const suspended = await adapter.recheck(v1);
    assert.equal(`${suspended.decision}:${suspended.reason}`, 'deny:SERVICE_SUSPENDED');
    before = `insert into public.brand_memberships (brand_id, user_id, role) values ('${WA}', '${B}', 'member');`;
    const shared = await adapter.recheck(v1);
    assert.equal(`${shared.decision}:${shared.reason}`, 'deny:OWN_WORKSPACE_CONFLICT');
    before = '';
  } finally {
    await stop();
  }
  const afterStop = await adapter.verdict('aaa.bbb.ccc', S);
  assert.notEqual(afterStop.decision, 'allow', `after the stop: ${afterStop.decision}:${afterStop.reason}`);
  assert.deepEqual([...new Set(seen)], ['POST /rest/v1/rpc/common_account_authorization_verdict p_app,p_brand_id,p_feature'], 'one RPC, the three named arguments only');
});

test_('rollback refuses under a consumer and otherwise restores the exact catalog; the MVP profile and the G5-42 migration candidate exclude each other and can be switched', async () => {
  const installed = await catalog(NE);
  await sql(NE, `create function public.g546_consumer() returns text language sql security definer set search_path = '' as $c$ ${MV(A, WA, LV)} $c$`);
  const withConsumer = await catalog(NE);
  assert.match(answer(await run(NE, ['-f', ROLLBACK])), /^ERROR MV_ROLLBACK_PRECONDITION_(CALLERS|DEPENDENTS)/u);
  assert.equal(await catalog(NE), withConsumer, 'nothing dropped');
  await sql(NE, 'drop function public.g546_consumer()');
  // (G5-47) a caller of R1-MVP stops the rollback too
  await sql(NE, `create function public.g547_consumer() returns jsonb language plpgsql security definer set search_path = '' as $c$ begin return public.common_account_authorization_verdict('postona', 'consult', 'u_x'); end $c$`);
  assert.match(answer(await run(NE, ['-f', ROLLBACK])), /^ERROR R1MVP_ROLLBACK_PRECONDITION_CALLERS/u);
  await sql(NE, 'drop function public.g547_consumer()');
  assert.equal(await catalog(NE), installed);
  // (G5-48) the whole MVP rollback with the EXECUTE grant still in place leaves nothing behind (the drop takes the ACL with it)
  await grant();
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
  // (G5-47) the MVP rollback never drops the full profile's reviewed R1
  const full = await catalog(EP);
  assert.match(answer(await run(EP, ['-f', ROLLBACK])), /^ERROR R1MVP_ROLLBACK_PRECONDITION_NOT_MVP/u);
  // (G5-48) neither the EXECUTE grant nor its stop touches the full profile's reviewed R1 (its ACL is G5-42's)
  assert.match(answer(await run(EP, ['-f', GRANT])), /^ERROR R1MVP_EXEC_PRECONDITION_NOT_MVP/u);
  assert.match(answer(await run(EP, ['-f', REVOKE])), /^ERROR R1MVP_EXEC_REVOKE_PRECONDITION_NOT_MVP/u);
  assert.equal(await catalog(EP), full);
  assert.match(answer(await run(NE, ['-f', FULL])), /^ERROR MIGRATION_PREREQ_P2_OWNER_EPOCH_MISSING/u, 'without PR #457 only the MVP installs');
});
