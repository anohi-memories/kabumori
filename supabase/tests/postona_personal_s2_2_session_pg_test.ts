// G5-34 (S2-2): private.postona_personal_session() answers exactly as SV (as D1 leaves it) for every claim set, and installs WITHOUT the owner-epoch
// chain. Two databases from the runner: FULL (the G5 world + D1 + S2-3, with SV) and BARE (the auth fixture only). A local fact about the candidate
// SQL; nothing about managed / production / GoTrue. Needs CAL_E2E=1 and the runner's environment.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, superUser, FULL, BARE] = ['S34_OWNER', 'PGSUPER', 'S34_FULL', 'S34_BARE'].map(env);
const decoder = new TextDecoder();
globalThis.fetch = (() => { throw new Error('the G5-34 tests make no network request'); }) as typeof fetch;
const test_ = enabled ? test : test.skip;
// set by the mutation script for a BODY mutant: skip the "same text as SV" checks, so the mutant must be caught by an answer, not by a checksum
const behaviourOnly = Deno.env.get('S34_BEHAVIOUR_ONLY') === '1';

const S22 = 'private.postona_personal_session()';
const SV = 'private.account_lifecycle_session_verdict()';
const candidateText = enabled ? Deno.readTextFileSync(env('S34_CANDIDATE')) : '';
const MD5_S22 = candidateText.match(/= '([0-9a-f]{32})' then\s+raise exception 'S22_ALREADY_APPLIED'/u)?.[1] ?? '';
if (enabled) assert.equal(MD5_S22.length, 32, 'the candidate states its checksum');

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
const exists = (db: string, fn: string) => sql(db, `select (to_regprocedure('${fn}') is not null)::text`);
const md5 = (db: string, fn: string) => sql(db, `select md5(prosrc) from pg_proc where oid = '${fn}'::regprocedure`);
const shape = (db: string, fn: string) => sql(db, `select p.oid || '|' || coalesce(p.proconfig::text, 'NULL') || '|' || coalesce(array_to_string(p.proacl::text[], ','), 'NULL')
  || '|' || p.proowner::regrole::text || '|' || p.provolatile::text || p.prosecdef::text || p.proisstrict::text || p.proleakproof::text || p.proparallel::text
  || p.prokind::text || p.proretset::text || p.procost::text || p.prorows::text || p.prosupport::text || p.prorettype::regtype::text || p.pronargs::text
  || coalesce(p.proargnames::text, '-') || coalesce(p.proargmodes::text, '-') || coalesce(p.protrftypes::text, '-') from pg_proc p where p.oid = '${fn}'::regprocedure`);

// a claim set: JSON claims (an object or raw text) or the per-claim settings of an older PostgREST; null = no claims at all
type Claims = { json: unknown } | { raw: string } | { legacy: Record<string, string> } | null;
function claimSql(c: Claims): string {
  if (c === null) return '';
  if ('raw' in c) return `select set_config('request.jwt.claims', ${lit(c.raw)}, true);`;
  if ('json' in c) return `select set_config('request.jwt.claims', ${lit(JSON.stringify(c.json))}, true);`;
  return Object.entries(c.legacy).map(([k, v]) => `select set_config('request.jwt.claim.${k}', ${lit(v)}, true);`).join(' ');
}
// the gate's answer for a claim set, called as its owner (both gates are owner-only); 'ERROR …' if it raised; 'NULL' if it returned NULL
async function ask(db: string, fn: string, c: Claims, prefix = ''): Promise<string> {
  const r = await run(db, ['-c', `begin; ${prefix} ${claimSql(c)} select coalesce(${fn.replace('()', '')}(), 'NULL'); rollback;`]);
  return r.ok ? r.out.split('\n').filter((l) => l !== '').pop() ?? '' : `ERROR ${r.error}`;
}

const P = uid(3401);       // a person with a live session
const Q = uid(3402);       // another person with a live session
const NOBODY = uid(3403);  // no login at all
const LIVE = uid(3501);
const EXPIRED = uid(3502);
const Q_LIVE = uid(3503);
const DOOMED = uid(3504);  // revoked during the test (the row is deleted, as a sign-out does)
const HEX = '0000000a-0000-4000-8000-00000000340b';  // a person whose id has letters (case matters for the canonical-form check)
const HEX_LIVE = uid(3505);
async function seed(db: string) {
  await sql(db, `insert into auth.users (id) values ('${P}'), ('${Q}'), ('${HEX}') on conflict do nothing`);
  await sql(db, `insert into auth.sessions (id, user_id, not_after) values ('${LIVE}', '${P}', null), ('${EXPIRED}', '${P}', now() - interval '1 minute'),
    ('${Q_LIVE}', '${Q}', now() + interval '1 hour'), ('${DOOMED}', '${P}', null), ('${HEX_LIVE}', '${HEX}', null)`);
}
const person = (extra: Record<string, unknown> = {}): Claims => ({ json: { sub: P, role: 'authenticated', session_id: LIVE, is_anonymous: false, ...extra } });
const legacy = (extra: Record<string, string> = {}): Claims => ({ legacy: { sub: P, role: 'authenticated', session_id: LIVE, is_anonymous: 'false', ...extra } });
const CLAIM_SETS: Array<[string, Claims, string]> = [
  ['a person, JSON claims', person(), 'active'],
  ['a person, per-claim settings', legacy(), 'active'],
  ['a session expiring later', { json: { sub: Q, role: 'authenticated', session_id: Q_LIVE, is_anonymous: false } }, 'active'],
  ['anonymous (JSON true)', person({ is_anonymous: true }), 'AUTH_REQUIRED'],
  ['anonymous (per-claim true)', legacy({ is_anonymous: 'true' }), 'AUTH_REQUIRED'],
  ['is_anonymous claim missing (JSON)', { json: { sub: P, role: 'authenticated', session_id: LIVE } }, 'AUTH_REQUIRED'],
  ['is_anonymous JSON null', person({ is_anonymous: null }), 'AUTH_REQUIRED'],
  ['is_anonymous the string "false"', person({ is_anonymous: 'false' }), 'AUTH_REQUIRED'],
  ['is_anonymous 0', person({ is_anonymous: 0 }), 'AUTH_REQUIRED'],
  ['is_anonymous per-claim missing', { legacy: { sub: P, role: 'authenticated', session_id: LIVE } }, 'AUTH_REQUIRED'],
  ['is_anonymous per-claim empty', legacy({ is_anonymous: '' }), 'AUTH_REQUIRED'],
  ['role anon', person({ role: 'anon' }), 'AUTH_REQUIRED'],
  ['role service_role', person({ role: 'service_role' }), 'AUTH_REQUIRED'],
  ['an id with letters, lower case', { json: { sub: HEX, role: 'authenticated', session_id: HEX_LIVE, is_anonymous: false } }, 'active'],
  ['the same id in upper case (not the canonical form)', { json: { sub: HEX.toUpperCase(), role: 'authenticated', session_id: HEX_LIVE, is_anonymous: false } }, 'AUTH_REQUIRED'],
  ['sub not a uuid', person({ sub: 'someone' }), 'AUTH_REQUIRED'],
  ['session_id not a uuid', person({ session_id: 'abc' }), 'AUTH_REQUIRED'],
  ['no session_id', { json: { sub: P, role: 'authenticated', is_anonymous: false } }, 'AUTH_REQUIRED'],
  ['broken JSON claims', { raw: '{not json' }, 'AUTH_REQUIRED'],
  ['JSON claims that are an array', { raw: '[1]' }, 'AUTH_REQUIRED'],
  ['no claims at all', null, 'AUTH_REQUIRED'],
  ['a login that does not exist', { json: { sub: NOBODY, role: 'authenticated', session_id: LIVE, is_anonymous: false } }, 'AUTH_REQUIRED'],
  ['another person\'s session', person({ session_id: Q_LIVE }), 'SESSION_REVOKED'],
  ['an unknown session (signed out / revoked)', person({ session_id: uid(3599) }), 'SESSION_REVOKED'],
  ['an expired session', person({ session_id: EXPIRED }), 'SESSION_EXPIRED'],
];

test_('setup: FULL has SV exactly as D1 leaves it and no S2-2; BARE has neither SV nor any owner-epoch helper', async () => {
  if (!behaviourOnly) assert.equal(await md5(FULL, SV), MD5_S22, 'S2-2 states SV\'s D1 body checksum: the bodies are the same text');
  assert.equal(await exists(FULL, S22), 'false');
  assert.equal(await exists(FULL, 'private.account_lifecycle_owner_epoch_exposure()'), 'true', 'FULL carries the owner-epoch chain');
  for (const fn of [SV, S22, 'private.account_lifecycle_owner_epoch_exposure()']) assert.equal(await exists(BARE, fn), 'false', `BARE: no ${fn}`);
  for (const db of [FULL, BARE]) await seed(db);
});

test_('FAIL before (the coupling): SV\'s own install refuses without the owner-epoch helper; S2-2 installs there and answers', async () => {
  const sv = await run(BARE, ['-f', env('S34_SV_INSTALL')]);
  // it stops on the missing helper: either its own HELPER_SHAPE code, or PostgreSQL's "does not exist" for the helper named in that same check
  // (measured here: the regprocedure literal in the check is resolved when the statement is planned)
  assert.ok(!sv.ok && sv.error.includes('account_lifecycle_owner_epoch_exposure()'), sv.error);
  assert.equal(await exists(BARE, SV), 'false');
  const r = await run(BARE, ['-f', env('S34_CANDIDATE')]);
  assert.ok(r.ok, r.error);
  for (const [label, claims, expected] of CLAIM_SETS) assert.equal(await ask(BARE, S22, claims), expected, `BARE: ${label}`);
});

test_('refused installs create nothing: superuser, the name taken, FORCE RLS, RLS hiding rows, a volatile auth.uid(), a different auth.sessions', async () => {
  const install = (user = owner) => run(FULL, ['-f', env('S34_CANDIDATE')], user);
  const absent = async (label: string) => assert.equal(await exists(FULL, S22), 'false', `${label}: nothing created`);
  let r = await install(superUser);
  assert.ok(!r.ok && r.error.includes('S22_PRECONDITION_OWNER_IS_SUPERUSER'), r.error);
  await absent('superuser');
  const cases: Array<[string, string, string, string, string]> = [
    ['someone else\'s function under the name', `create function ${S22} returns text language sql as $$ select 'active' $$`, `drop function ${S22}`,
      'S22_PRECONDITION_NAME_TAKEN', owner],
    ['FORCE RLS on auth.sessions', 'alter table auth.sessions force row level security', 'alter table auth.sessions no force row level security',
      'S22_PRECONDITION_RLS_FORCED auth.sessions', owner],
    ['RLS on auth.users, owner neither table owner nor BYPASSRLS', `alter table auth.users owner to ${superUser}; alter table auth.users enable row level security;
      grant select on auth.users to ${owner}`, `alter table auth.users disable row level security; alter table auth.users owner to ${owner}`,
      'S22_PRECONDITION_RLS_HIDES_ROWS auth.users', superUser],
    ['a volatile auth.uid()', 'alter function auth.uid() volatile', 'alter function auth.uid() stable', 'S22_PRECONDITION_AUTH_UID', owner],
    ['auth.sessions without not_after', 'alter table auth.sessions rename column not_after to not_after_x', 'alter table auth.sessions rename column not_after_x to not_after',
      'S22_PRECONDITION_AUTH_SHAPE', owner],
  ];
  for (const [label, change, undo, code, as] of cases) {
    await sql(FULL, change, as);
    r = await install();
    assert.ok(!r.ok && r.error.includes(code), `${label}\n${r.error}`);
    await sql(FULL, undo, as);
    if (!label.startsWith('someone')) await absent(label);
  }
  await absent('after all');
  r = await run(FULL, ['-f', env('S34_ROLLBACK')]);
  assert.ok(!r.ok && r.error.includes('S22_ROLLBACK_NOT_APPLIED'), r.error);
});

test_('install: owner-only (no API role may EXECUTE or reach it), every attribute as declared, SV\'s exact body; nothing else changes; a second run refuses', async () => {
  const others = `select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proacl::text[], ','), '-'), ','
    order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private', 'auth') and p.proname <> 'postona_personal_session'`;
  const before = await sql(FULL, others);
  const r = await run(FULL, ['-f', env('S34_CANDIDATE')]);
  assert.ok(r.ok, r.error);
  assert.equal(await sql(FULL, others), before, 'every other function (SV, R0, R1, T13, W1, S2-3 ...) byte-identical, ACLs included');
  if (!behaviourOnly) assert.equal(await md5(FULL, S22), await md5(FULL, SV), 'the same body as SV (D1)');
  const s = await shape(FULL, S22);
  assert.ok(s.includes(`|{"search_path=\\"\\"",row_security=off}|${owner}=X/${owner}|${owner}|s`), s);
  for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) {
    assert.equal(await sql(FULL, `select has_function_privilege('${role}', '${S22}', 'EXECUTE')::text`), 'false', `${role}: no EXECUTE`);
  }
  const asApi = await run(FULL, ['-c', `begin; ${claimSql(person())} set local role authenticated; select private.postona_personal_session(); rollback;`]);
  assert.ok(!asApi.ok && /permission denied/u.test(asApi.error), `an API role cannot call it\n${asApi.error}`);
  const again = await run(FULL, ['-f', env('S34_CANDIDATE')]);
  assert.ok(!again.ok && again.error.includes('S22_ALREADY_APPLIED'), again.error);
});

test_('the same answer as SV for every claim set (anonymous, missing claim, role, malformed ids, no login, another person\'s / revoked / expired session); never NULL', async () => {
  let compared = 0;
  for (const [label, claims, expected] of CLAIM_SETS) {
    const sv = await ask(FULL, SV, claims);
    const s22 = await ask(FULL, S22, claims);
    assert.equal(s22, sv, `${label}: identical to SV`);
    assert.equal(s22, expected, `${label}: the expected answer`);
    compared += 1;
  }
  // sub must equal auth.uid(): in this world both read the same claims, so auth.uid() is replaced INSIDE the rolled-back transaction by one naming
  // another person (as a different or broken auth.uid() would) -- the claims alone are not enough
  const otherUid = `create or replace function auth.uid() returns uuid language sql stable as $u$ select '${Q}'::uuid $u$;`;
  for (const fn of [SV, S22]) assert.equal(await ask(FULL, fn, person(), otherUid), 'AUTH_REQUIRED', `${fn}: sub is not auth.uid()`);
  assert.equal(await ask(FULL, S22, person()), 'active', 'auth.uid() is back (the replacement was rolled back)');
  // a sign-out / revocation that removes the session row is seen at once
  const doomed = person({ session_id: DOOMED });
  assert.equal(await ask(FULL, S22, doomed), 'active');
  await sql(FULL, `delete from auth.sessions where id = '${DOOMED}'`);
  assert.equal(await ask(FULL, S22, doomed), 'SESSION_REVOKED');
  assert.equal(await ask(FULL, SV, doomed), 'SESSION_REVOKED');
  console.log(`S22_COMPARED ${compared + 2} answers identical to SV, 0 NULL`);
});

// ---- (G5-38) consumers of the gate and the rollback: the callers check in any letter case, recorded dependents, the limits ------------------
const GATE = 'private.postona_personal_session()';
const CONSUMERS: Array<[string, string, string, string]> = [
  ['a PL/pgSQL function', `create function public.g538_plpgsql() returns text language plpgsql as $c$ begin return ${GATE}; end $c$`, 'drop function public.g538_plpgsql()',
    'S22_ROLLBACK_PRECONDITION_CALLERS'],
  ['the name in upper case', `create function public.g538_upper() returns text language plpgsql as $c$ begin return ${GATE.toUpperCase()}; end $c$`,
    'drop function public.g538_upper()', 'S22_ROLLBACK_PRECONDITION_CALLERS'],
  ['the name in mixed case', `create function public.g538_mixed() returns text language plpgsql as $c$ begin return Private.Postona_Personal_Session(); end $c$`,
    'drop function public.g538_mixed()', 'S22_ROLLBACK_PRECONDITION_CALLERS'],
  ['a plain SQL function', `create function public.g538_sql() returns text language sql as $c$ select ${GATE} $c$`, 'drop function public.g538_sql()',
    'S22_ROLLBACK_PRECONDITION_CALLERS'],
  ['a SQL-standard (BEGIN ATOMIC) body', `create function public.g538_atomic() returns text language sql begin atomic select ${GATE}; end`, 'drop function public.g538_atomic()',
    'S22_ROLLBACK_PRECONDITION_DEPENDENTS'],
  ['a view', `create view public.g538_view as select ${GATE} as answer`, 'drop view public.g538_view', 'S22_ROLLBACK_PRECONDITION_DEPENDENTS'],
  // a FALSE POSITIVE, recorded: a comment naming the gate counts as a caller (it refuses; it never lets a real caller through)
  ['only a comment naming it (false positive)', `create function public.g538_comment() returns text language plpgsql as $c$ begin
    -- formerly called Private.Postona_Personal_Session()
    return 'x'; end $c$`, 'drop function public.g538_comment()', 'S22_ROLLBACK_PRECONDITION_CALLERS'],
];
const DYNAMIC = `create function public.g538_dynamic() returns text language plpgsql as $c$ declare r text; begin
  execute 'select private.postona_' || 'personal_session()' into r; return r; end $c$`;

const testOld = enabled && env('S34_OLD_ROLLBACK') !== '' ? test : test.skip;
testOld('FAIL before (PR #510 rollback, 6d59f3b6): an upper-case caller is not seen -- the gate is dropped under it and it breaks; a view stops only at DROP RESTRICT', async () => {
  await sql(FULL, CONSUMERS[1][1]);
  let r = await run(FULL, ['-f', env('S34_OLD_ROLLBACK')]);
  assert.ok(r.ok, `the old rollback runs under an upper-case caller\n${r.error}`);
  const broken = await run(FULL, ['-c', 'select public.g538_upper()']);
  assert.ok(!broken.ok && /does not exist/u.test(broken.error), `the caller is broken\n${broken.error}`);
  await sql(FULL, CONSUMERS[1][2]);
  r = await run(FULL, ['-f', env('S34_CANDIDATE')]);
  assert.ok(r.ok, `re-install\n${r.error}`);
  await sql(FULL, CONSUMERS[5][1]);
  r = await run(FULL, ['-f', env('S34_OLD_ROLLBACK')]);
  assert.ok(!r.ok && /other objects depend on it/u.test(r.error), r.error);
  assert.equal(await exists(FULL, S22), 'true', 'the gate kept');
  await sql(FULL, CONSUMERS[5][2]);
});

test_('(G5-38) the rollback refuses while anything still uses the gate -- the gate stays exactly; a dynamic-SQL caller is NOT seen (recorded limit)', async () => {
  const keep = `${await md5(FULL, S22)}|${await shape(FULL, S22)}`;
  const sv = `${await md5(FULL, SV)}|${await shape(FULL, SV)}`;
  for (const [label, create, drop, code] of CONSUMERS) {
    await sql(FULL, create);
    const r = await run(FULL, ['-f', env('S34_ROLLBACK')]);
    assert.ok(!r.ok && r.error.includes(code), `${label}\n${r.error}`);
    assert.equal(`${await md5(FULL, S22)}|${await shape(FULL, S22)}`, keep, `${label}: the gate exactly as it was (same OID, ACL, attributes)`);
    assert.equal(`${await md5(FULL, SV)}|${await shape(FULL, SV)}`, sv, `${label}: SV untouched`);
    await sql(FULL, drop);
  }
  await sql(FULL, DYNAMIC);
  let r = await run(FULL, ['-f', env('S34_ROLLBACK')]);
  assert.ok(r.ok, `the fence does not see dynamic SQL (recorded)\n${r.error}`);
  const broken = await run(FULL, ['-c', 'select public.g538_dynamic()']);
  assert.ok(!broken.ok && /does not exist/u.test(broken.error), broken.error);
  await sql(FULL, 'drop function public.g538_dynamic()');
  r = await run(FULL, ['-f', env('S34_CANDIDATE')]);
  assert.ok(r.ok, `re-install\n${r.error}`);
  assert.equal(await ask(FULL, S22, person()), 'active');
});

test_('the rollback refuses a drifted gate or a caller, then drops only S2-2; a second rollback refuses; the candidate re-installs', async () => {
  const rb = env('S34_ROLLBACK');
  const svBefore = `${await md5(FULL, SV)}|${await shape(FULL, SV)}`;
  const s22Before = await shape(FULL, S22);
  const drifts: Array<[string, string, string, string, string]> = [
    ['STRICT', `alter function ${S22} strict`, `alter function ${S22} called on null input`, 'S22_ROLLBACK_PRECONDITION_SHAPE', owner],
    ['RESET ALL (proconfig NULL)', `alter function ${S22} reset all`, `alter function ${S22} set search_path = '' set row_security = off`, 'S22_ROLLBACK_PRECONDITION_SHAPE', owner],
    ['granted to authenticated', `grant execute on function ${S22} to authenticated`, `revoke execute on function ${S22} from authenticated`, 'S22_ROLLBACK_PRECONDITION_SHAPE', owner],
    ['an API role made a member of the owner', `grant ${owner} to authenticator`, `revoke ${owner} from authenticator`, 'S22_ROLLBACK_PRECONDITION_API_ROLE_REACHES', superUser],
    ['a consumer calling it', `create function private.g534_consumer() returns text language plpgsql as $$ begin return private.postona_personal_session(); end $$`,
      'drop function private.g534_consumer()', 'S22_ROLLBACK_PRECONDITION_CALLERS', owner],
  ];
  for (const [label, drift, undo, code, as] of drifts) {
    await sql(FULL, drift, as);
    const r = await run(FULL, ['-f', rb]);
    assert.ok(!r.ok && r.error.includes(code), `${label}\n${r.error}`);
    assert.equal(await exists(FULL, S22), 'true', `${label}: kept`);
    await sql(FULL, undo, as);
    assert.equal(await shape(FULL, S22), s22Before, `${label}: undone`);
  }
  // a changed body is someone else's change (kept inside the database: psql trims a leading newline)
  await sql(FULL, `create table public.g534_saved as select prosrc as body from pg_proc where oid = '${S22}'::regprocedure`);
  const redefine = (expr: string) => `do $d$ begin execute format('create or replace function private.postona_personal_session()
    returns text language plpgsql stable security definer set search_path = '''' set row_security = off as %L', ${expr}); end $d$`;
  await sql(FULL, redefine(`(select body from public.g534_saved) || E'\\n-- changed\\n'`));
  let r = await run(FULL, ['-f', rb]);
  assert.ok(!r.ok && r.error.includes('S22_ROLLBACK_PRECONDITION_BODY'), r.error);
  await sql(FULL, redefine('(select body from public.g534_saved)'));
  await sql(FULL, 'drop table public.g534_saved');
  r = await run(FULL, ['-f', rb]);
  assert.ok(r.ok, r.error);
  assert.equal(await exists(FULL, S22), 'false', 'dropped');
  assert.equal(`${await md5(FULL, SV)}|${await shape(FULL, SV)}`, svBefore, 'SV untouched');
  r = await run(FULL, ['-f', rb]);
  assert.ok(!r.ok && r.error.includes('S22_ROLLBACK_NOT_APPLIED'), r.error);
  r = await run(FULL, ['-f', env('S34_CANDIDATE')]);
  assert.ok(r.ok, r.error);
  assert.equal(await ask(FULL, S22, person()), 'active', 're-installed');
  assert.equal(await ask(FULL, S22, person({ is_anonymous: true })), 'AUTH_REQUIRED');
});
