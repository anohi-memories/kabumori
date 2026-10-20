// G5-10: the session-only verdict SQL candidate (supabase/candidates/common_account_authorization_verdict/003_session_verdict.sql) on a local
// PostgreSQL 17 with fake data, over the REAL F5 chain, the PR #303 owner-epoch candidate, 001 (R1) and 002 (R0). The reference sessionVerdict()
// (session_verdict.ts, PR #406) is the ORACLE: for every world the real function must answer exactly what the reference answers from the same facts.
// A TEST-ONLY consumer (schema sv_consumer, created here, not G3's 007) shows the interface G3 would use: the verdict first, no row touched otherwise.
// A PASS is not a managed result and not an approval to apply.
// Needs CAL_E2E=1, PGHOST / PGPORT / PGUSER / PGDATABASE / PGSUPER / SV_CANDIDATE / SV_ROLLBACK / SV_OTHER / SV_API (the runner sets them).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { type SessionFacts, sessionVerdict } from '../candidates/common_account_postona_authz/session_verdict.ts';
import type { ClaimSources } from '../candidates/common_account_postona_authz/rpc_preflight.ts';

const enabled = Deno.env.get('CAL_E2E') === '1';
const db = Deno.env.get('PGDATABASE') ?? '';
const owner = Deno.env.get('PGUSER') ?? '';
const superUser = Deno.env.get('PGSUPER') ?? '';
const decoder = new TextDecoder();
if (enabled && !db) throw new Error('PGDATABASE is required');
globalThis.fetch = (() => { throw new Error('the G5-10 tests make no network request'); }) as typeof fetch;

type Psql = { ok: boolean; out: string; error: string };
const env = (user: string) => ({ PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: user, PGDATABASE: db, LC_ALL: 'C' });
async function run(user: string, args: string[]): Promise<Psql> {
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...args], env: env(user), clearEnv: true, stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
const psql = (statement: string) => run(owner, ['-c', statement]);
async function sql(statement: string): Promise<string> {
  const r = await psql(statement);
  if (!r.ok) throw new Error(r.error);
  return r.out;
}
async function superSql(statement: string): Promise<string> {
  const r = await run(superUser, ['-c', statement]);
  if (!r.ok) throw new Error(r.error);
  return r.out;
}
const spawn = (statement: string) => new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement], env: env(owner), clearEnv: true, stdout: 'piped', stderr: 'piped' }).spawn();
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
const candidate = () => Deno.env.get('SV_CANDIDATE') ?? '';
const rollback = () => Deno.env.get('SV_ROLLBACK') ?? '';
const otherRole = () => Deno.env.get('SV_OTHER') ?? '';
const apiRole = () => Deno.env.get('SV_API') ?? '';
const SV = 'private.account_lifecycle_session_verdict';
const RLS_ERROR = /query would be affected by row-level security policy for table/u;

// ---- the caller's claims: the per-claim settings (an older PostgREST) or request.jwt.claims; the verdict reads nothing else ----------------------
type Claims =
  | { kind: 'legacy'; sub: string; role?: string; session?: string | null; anonymous?: string }
  | { kind: 'json'; json: string }
  | { kind: 'none' };
function settings(c: Claims): string {
  if (c.kind === 'none') return '';
  if (c.kind === 'json') return `set local request.jwt.claims = ${lit(c.json)};`;
  return [`set local request.jwt.claim.sub = ${lit(c.sub)};`, `set local request.jwt.claim.role = ${lit(c.role ?? 'authenticated')};`,
    c.session === null ? '' : `set local request.jwt.claim.session_id = ${lit(c.session ?? '')};`,
    c.anonymous === undefined ? '' : `set local request.jwt.claim.is_anonymous = ${lit(c.anonymous)};`].join(' ');
}
const inTx = (c: Claims, statement: string, role?: string) => `begin; ${settings(c)} ${role ? `set local role ${role};` : ''} ${statement}; commit`;
type Person = { user: string; session: string };
const legacy = (p: Person, extra: Partial<{ role: string; session: string | null; anonymous: string }> = {}): Claims => ({ kind: 'legacy', sub: p.user, session: p.session, ...extra });
const jsonClaims = (p: Person, extra: Record<string, unknown> = {}): Claims => ({ kind: 'json', json: JSON.stringify({ sub: p.user, role: 'authenticated', session_id: p.session, ...extra }) });
/** The verdict, called by its owner (it has no other grant), with auth.uid() read in the same transaction. */
async function verdictAndUid(c: Claims): Promise<[string, string | null]> {
  const v = await sql(inTx(c, `select ${SV}()`));
  // auth.uid() itself raises on malformed JSON claims (the verdict never calls it then): such a caller has no uid
  const uid = await psql(inTx(c, `select coalesce(auth.uid()::text, '')`));
  return [v, uid.ok && uid.out !== '' ? uid.out : null];
}
const verdict = async (c: Claims) => (await verdictAndUid(c))[0];

// ---- the oracle: sessionVerdict() over facts read by a TEST-ONLY statement --------------------------------------------------------------------
function claimSources(c: Claims, authUid: string | null): ClaimSources {
  if (c.kind === 'legacy') return { legacy: { sub: c.sub, role: c.role ?? 'authenticated', sessionId: c.session === undefined ? null : c.session, isAnonymous: c.anonymous ?? null }, claimsJson: null, authUid };
  if (c.kind === 'json') return { legacy: null, claimsJson: c.json, authUid };
  return { legacy: null, claimsJson: null, authUid };
}
async function oracle(c: Claims, authUid: string | null): Promise<string> {
  let sub = '';
  let session = '';
  if (c.kind === 'legacy') {
    sub = c.sub;
    session = c.session ?? '';
  }
  if (c.kind === 'json') {
    try {
      const o = JSON.parse(c.json);
      sub = typeof o?.sub === 'string' ? o.sub : '';
      session = typeof o?.session_id === 'string' ? o.session_id : '';
    } catch { /* malformed: the claims stage refuses before any fact is needed */ }
  }
  const uuid = /^[0-9a-f-]{36}$/u;
  const facts: SessionFacts = JSON.parse(await sql(`select json_build_object(
    'userExists', ${uuid.test(sub) ? `exists (select 1 from auth.users u where u.id = ${lit(sub)}::uuid)` : 'false'},
    'session', ${uuid.test(session) ? `(select json_build_object('userId', s.user_id, 'notAfterMs', (extract(epoch from s.not_after) * 1000)::bigint) from auth.sessions s where s.id = ${lit(session)}::uuid)` : 'null'})`));
  return sessionVerdict(claimSources(c, authUid), facts, Date.now());
}
async function agree(c: Claims, label: string): Promise<string> {
  const [v, uid] = await verdictAndUid(c);
  assert.equal(v, await oracle(c, uid), `${label}: the SQL answer equals sessionVerdict()`);
  return v;
}

// ---- the world ---------------------------------------------------------------------------------------------------------------------------------
async function person(options: { x?: boolean; workspace?: boolean; notAfter?: string } = {}): Promise<Person> {
  const user = randomUUID();
  if (options.workspace) await sql(`select public.fixture_user_with_workspace('${user}'::uuid, ${lit(`sv_${user.slice(0, 6)}`)})`);
  else await sql(`select public.fixture_login('${user}'::uuid)`);
  if (options.x !== false) {
    assert.equal(JSON.parse(await sql(inTx({ kind: 'legacy', sub: user, session: null }, 'select to_jsonb(public.start_x_autopost_service())', 'authenticated'))).status, 'active');
  }
  const session = randomUUID();
  await sql(`insert into auth.sessions (id, user_id, not_after) values ('${session}', '${user}', ${options.notAfter ?? 'null'})`);
  return { user, session };
}
const derived = (user: string) => sql(`select public.social_mobile_account_deletion_workspace('${user}'::uuid)`);
const r1 = async (p: Person, c: Claims) => JSON.parse(await sql(inTx(c, `select public.common_account_authorization_verdict('postona', 'read_workspace', ${lit(await derived(p.user))})::text`, 'authenticated')));

// The TEST-ONLY consumer: what G3's 007 receipt / cancel would do -- the verdict FIRST, then the caller's own row (owner = the lifecycle owner).
async function consumer() {
  await sql(`create schema if not exists sv_consumer;
    create table if not exists sv_consumer.reservations (id uuid primary key, user_id uuid not null, status text not null);
    create or replace function sv_consumer.receipt(p_id uuid) returns text language plpgsql stable security definer set search_path = '' as $f$
    declare v text;
    begin
      if ${SV}() is distinct from 'active' then raise exception 'POSTONA_RESV_AUTH_REQUIRED' using errcode = '42501'; end if;
      select r.status into v from sv_consumer.reservations r where r.id = p_id and r.user_id = auth.uid();
      if v is null then raise exception 'POSTONA_RESV_NOT_FOUND'; end if;
      return v;
    end $f$;
    create or replace function sv_consumer.cancel(p_id uuid) returns text language plpgsql volatile security definer set search_path = '' as $f$
    begin
      if ${SV}() is distinct from 'active' then raise exception 'POSTONA_RESV_AUTH_REQUIRED' using errcode = '42501'; end if;
      update sv_consumer.reservations r set status = 'cancelled' where r.id = p_id and r.user_id = auth.uid() and r.status = 'planned';
      if not found then raise exception 'POSTONA_RESV_NOT_FOUND_OR_NOT_CANCELLABLE'; end if;
      return 'cancelled';
    end $f$;
    revoke all on function sv_consumer.receipt(uuid), sv_consumer.cancel(uuid) from public;
    grant usage on schema sv_consumer to ${apiRole()};
    grant execute on function sv_consumer.receipt(uuid), sv_consumer.cancel(uuid) to ${apiRole()}`);
}
const reserve = async (p: Person, status = 'planned') => {
  const id = randomUUID();
  await sql(`insert into sv_consumer.reservations values ('${id}', '${p.user}', ${lit(status)})`);
  return id;
};
const status = (id: string) => sql(`select status from sv_consumer.reservations where id = '${id}'`);
const asApi = (c: Claims, statement: string) => psql(inTx(c, statement, apiRole()));

/** A layout in which `table` is owned by ANOTHER role with ordinary RLS on and every privilege granted to the function owner. */
async function hostile<T>(table: string, body: () => Promise<T>, options: { bypass?: boolean; inherit?: boolean } = {}): Promise<T> {
  const rls = await sql(`select relrowsecurity::text from pg_class where oid = '${table}'::regclass`);
  await superSql(`alter table ${table} owner to ${otherRole()}; grant all on ${table} to ${owner}; alter table ${table} enable row level security`);
  if (options.bypass) await superSql(`alter role ${owner} bypassrls`);
  if (options.inherit) await superSql(`grant ${otherRole()} to ${owner}`);
  try {
    return await body();
  } finally {
    if (options.inherit) await superSql(`revoke ${otherRole()} from ${owner}`);
    if (options.bypass) await superSql(`alter role ${owner} nobypassrls`);
    await superSql(`alter table ${table} owner to ${owner}; revoke all on ${table} from ${otherRole()}${rls === 'true' ? '' : `; alter table ${table} disable row level security`}`);
  }
}

// =============================================================================================================================================
test_('install: one STABLE definer function, no parameter, empty search path and row_security = off, EXECUTE for its owner ONLY; a second install is refused; the rollback drops it alone', async () => {
  assert.equal(await sql(`select array_to_string(proacl::text[], ',') from pg_proc where oid = '${SV}()'::regprocedure`), `${owner}=X/${owner}`);
  assert.equal(await sql(`select (provolatile = 's' and prosecdef and proconfig @> array['search_path=""', 'row_security=off'] and pronargs = 0
    and proowner = (select oid from pg_roles where rolname = current_user))::text from pg_proc where oid = '${SV}()'::regprocedure`), 'true');
  for (const role of ['anon', 'authenticated', 'service_role', 'authenticator', apiRole()]) {
    assert.equal(await sql(`select has_function_privilege('${role}', '${SV}()', 'EXECUTE')::text`), 'false', `${role} has no EXECUTE`);
  }
  for (const role of ['authenticated', 'service_role', apiRole()]) {
    const r = await psql(`begin; set local role ${role}; select ${SV}(); commit`);
    assert.ok(!r.ok && /permission denied/u.test(r.error), `${role} cannot call it: ${r.error}`);
  }
  const extra = await psql(`select ${SV}('${randomUUID()}'::uuid)`);
  assert.ok(!extra.ok && /does not exist/u.test(extra.error), 'there is no user / session parameter to pass');
  assert.ok(/SESSION_VERDICT_ALREADY_APPLIED/u.test((await run(owner, ['-f', candidate()])).error));
  assert.ok((await run(owner, ['-f', rollback()])).ok);
  assert.equal(await sql(`select count(*) from pg_proc where proname = 'account_lifecycle_session_verdict'`), '0');
  assert.equal(await sql(`select count(*) from pg_proc where proname in ('common_account_authorization_verdict', 'common_account_bootstrap_verdict')`), '2', 'R1 and R0 stay');
  assert.ok((await run(owner, ['-f', candidate()])).ok, 'the install works again');
});

test_('the oracle, active: both claim forms, no expiry and a future expiry; the answer equals sessionVerdict()', async () => {
  const a = await person();
  for (const c of [legacy(a), jsonClaims(a), jsonClaims(a, { is_anonymous: false }), jsonClaims(a, { is_anonymous: null }), legacy(a, { anonymous: 'false' })]) {
    assert.equal(await agree(c, JSON.stringify(c)), 'active');
  }
  const b = await person({ notAfter: `now() + interval '1 hour'` });
  assert.equal(await agree(jsonClaims(b), 'future not_after'), 'active');
});

test_('the oracle, refused: P7\'s five cases, the claims rules, a deleted login, a disagreeing auth.uid(); each equals sessionVerdict() and the real R1\'s own code', async () => {
  const cases: [string, () => Promise<[Person, Claims]>, string][] = [
    ['C1 signed out', async () => { const p = await person({ workspace: true }); await sql(`delete from auth.sessions where id = '${p.session}'`); return [p, jsonClaims(p)]; }, 'SESSION_REVOKED'],
    ['C2 expired', async () => { const p = await person({ workspace: true, notAfter: `now() - interval '1 second'` }); return [p, jsonClaims(p)]; }, 'SESSION_EXPIRED'],
    ['C3 another person\'s live session', async () => { const p = await person({ workspace: true }); const q = await person(); return [p, jsonClaims(p, { session_id: q.session })]; }, 'SESSION_REVOKED'],
    ['C4 an unknown session id', async () => { const p = await person({ workspace: true }); return [p, jsonClaims(p, { session_id: randomUUID() })]; }, 'SESSION_REVOKED'],
    ['C5 anonymous (JSON)', async () => { const p = await person({ workspace: true }); return [p, jsonClaims(p, { is_anonymous: true })]; }, 'AUTH_REQUIRED'],
    ['C5 anonymous (per-claim)', async () => { const p = await person({ workspace: true }); return [p, legacy(p, { anonymous: 'true' })]; }, 'AUTH_REQUIRED'],
  ];
  for (const [label, make, code] of cases) {
    const [p, c] = await make();
    assert.equal(await agree(c, label), code, label);
    const real = await r1(p, c);
    assert.equal(`${real.decision}:${real.reason}`, `deny:${code}`, `${label}: the real R1 says the same`);
  }
  const a = await person();
  const refused: Claims[] = [
    jsonClaims(a, { is_anonymous: 'false' }), jsonClaims(a, { role: 'anon' }), jsonClaims(a, { role: 'service_role' }), legacy(a, { role: 'anon' }),
    legacy(a, { session: null }), jsonClaims(a, { session_id: 'abc' }), { kind: 'json', json: JSON.stringify({ sub: a.user, role: 'authenticated' }) },
    { kind: 'json', json: '{not json' }, { kind: 'json', json: '[1]' }, { kind: 'none' }, jsonClaims({ user: 'not-a-uuid', session: a.session }),
  ];
  for (const c of refused) assert.equal(await agree(c, JSON.stringify(c)), 'AUTH_REQUIRED', JSON.stringify(c));
  // the login is gone (its sessions go with it)
  const gone = await person();
  await sql(`delete from auth.users where id = '${gone.user}'`);
  assert.equal(await agree(jsonClaims(gone), 'deleted login'), 'AUTH_REQUIRED');
  // auth.uid() disagrees with the claims' sub
  const b = await person();
  const def = await sql(`select pg_get_functiondef('auth.uid()'::regprocedure)`);
  await sql(`create or replace function auth.uid() returns uuid language sql stable as $$ select '${b.user}'::uuid $$`);
  try {
    for (const c of [legacy(a), jsonClaims(a)]) assert.equal(await agree(c, `auth.uid() disagrees (${c.kind})`), 'AUTH_REQUIRED');
  } finally {
    await sql(def);
  }
  assert.equal(await verdict(jsonClaims(a)), 'active');
});

test_('the entitlement and the account are not inputs (contract §5; the user / G1 decisions stay open): ended, suspended, 退会 started, locked, never registered are still active -- where the real R1 read_workspace refuses', async () => {
  const states: [string, (p: Person) => Promise<unknown>, string][] = [
    ['service ended', (p) => sql(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${p.user}'`), 'SERVICE_NOT_ACTIVE'],
    ['suspended', (p) => sql(`update public.service_entitlements set status = 'suspended' where user_id = '${p.user}'`), 'SERVICE_SUSPENDED'],
    ['locked', (p) => sql(`update public.common_accounts set status = 'locked' where user_id = '${p.user}'`), 'ACCOUNT_LOCKED'],
    ['退会 started', async (p) => {
      const lv = await sql(`select lifecycle_version from public.common_accounts where user_id = '${p.user}'`);
      await sql(`begin; set local role service_role; select public.begin_common_account_deletion('${p.user}'::uuid, ${lv}); commit`);
    }, 'ACCOUNT_DELETION_IN_PROGRESS'],
  ];
  for (const [label, change, code] of states) {
    const p = await person({ workspace: true });
    await change(p);
    assert.equal(await agree(jsonClaims(p), label), 'active', `${label}: the session verdict does not look at it`);
    const real = await r1(p, jsonClaims(p));
    assert.equal(`${real.decision}:${real.reason}`, `deny:${code}`, `${label}: R1 read_workspace (option A) refuses`);
  }
  const none = await person({ x: false });
  assert.equal(await agree(jsonClaims(none), 'no common account'), 'active');
});

test_('the consumer interface: the verdict first -- a dead session touches no reservation row (lock proof), changes nothing and is 42501; a live one reads / cancels only its own rows; an API role cannot call the verdict itself', async () => {
  await consumer();
  const a = await person();
  const mine = await reserve(a);
  const sent = await reserve(a, 'sent');
  const other = await person();
  const theirs = await reserve(other);
  // live: own receipt, own cancel; another person's row and an unknown id: the same not-found
  assert.equal((await asApi(jsonClaims(a), `select sv_consumer.receipt('${sent}')`)).out, 'sent');
  for (const id of [theirs, randomUUID()]) {
    const r = await asApi(jsonClaims(a), `select sv_consumer.receipt('${id}')`);
    assert.ok(!r.ok && /POSTONA_RESV_NOT_FOUND/u.test(r.error), r.error);
  }
  assert.equal(await status(theirs), 'planned');
  // dead sessions (P7's five cases): refused before any row, nothing changes
  const dead: [string, Claims][] = [
    ['an unknown (signed-out) session', jsonClaims({ user: a.user, session: randomUUID() })],
    ['another person\'s session', jsonClaims(a, { session_id: other.session })],
    ['anonymous', jsonClaims(a, { is_anonymous: true })],
    ['no session claim', { kind: 'json', json: JSON.stringify({ sub: a.user, role: 'authenticated' }) }],
  ];
  const expired = await person({ notAfter: `now() - interval '1 second'` });
  const expiredRow = await reserve(expired);
  for (const [label, c] of [...dead, ['expired', jsonClaims(expired)] as [string, Claims]]) {
    const id = label === 'expired' ? expiredRow : mine;
    for (const fn of ['receipt', 'cancel']) {
      const r = await run(owner, ['-v', 'VERBOSITY=verbose', '-c', inTx(c, `select sv_consumer.${fn}('${id}')`, apiRole())]);
      assert.ok(!r.ok && /42501: POSTONA_RESV_AUTH_REQUIRED/u.test(r.error), `${label} / ${fn}: ${r.error}`);
    }
    assert.equal(await status(id), 'planned', `${label}: nothing cancelled`);
  }
  // the lock proof: with the reservations locked away, every refusal answers at once (no row is touched); a live call waits for the rows
  const holder = spawn(`begin; lock table sv_consumer.reservations in access exclusive mode; select pg_sleep(4) /* sv-lock */; commit`);
  await untilSleeping('sv-lock');
  try {
    for (const [label, c] of dead) {
      const r = await asApi(c, `set local statement_timeout = '1500ms'; select sv_consumer.receipt('${mine}')`);
      assert.ok(!r.ok && /POSTONA_RESV_AUTH_REQUIRED/u.test(r.error), `${label}: refused without waiting (${r.error})`);
    }
    const live = await asApi(jsonClaims(a), `set local statement_timeout = '1500ms'; select sv_consumer.receipt('${mine}')`);
    assert.ok(!live.ok && /statement timeout/u.test(live.error), 'a live session reads the rows');
  } finally {
    await holder.output();
  }
  assert.equal((await asApi(jsonClaims(a), `select sv_consumer.cancel('${mine}')`)).out, 'cancelled');
  const again = await asApi(jsonClaims(a), `select sv_consumer.cancel('${mine}')`);
  assert.ok(!again.ok && /POSTONA_RESV_NOT_FOUND_OR_NOT_CANCELLABLE/u.test(again.error), 'a retried cancel changes nothing');
  const direct = await asApi(jsonClaims(a), `select ${SV}()`);
  assert.ok(!direct.ok && /permission denied/u.test(direct.error), 'the consumer\'s API role cannot call the verdict directly');
});

test_('one snapshot, nothing read first, no lifecycle lock: two calls in ONE statement agree across a concurrent sign-out; refusals read no row; the verdict never waits on account / entitlement / brand locks', async () => {
  const a = await person();
  const one = spawn(inTx(jsonClaims(a), `select ${SV}() || '|' || pg_sleep(2)::text || '|' || ${SV}() /* sv-one */`));
  await untilSleeping('sv-one');
  await sql(`delete from auth.sessions where id = '${a.session}'`);
  const [first, , second] = decoder.decode((await one.output()).stdout).trim().split('|');
  assert.deepEqual([first, second], ['active', 'active'], 'one statement, one snapshot');
  assert.equal(await verdict(jsonClaims(a)), 'SESSION_REVOKED', 'the next statement sees the sign-out');
  // nothing is read before the claims are accepted: with the login / session tables locked away, refusals answer at once and a good caller waits
  const c = await person();
  const auth = spawn(`begin; lock table auth.users, auth.sessions in access exclusive mode; select pg_sleep(4) /* sv-auth */; commit`);
  await untilSleeping('sv-auth');
  try {
    const refusedClaims: Claims[] = [jsonClaims(c, { is_anonymous: true }), jsonClaims(c, { role: 'anon' }), { kind: 'json', json: JSON.stringify({ sub: c.user, role: 'authenticated' }) },
      { kind: 'none' }];
    for (const refused of refusedClaims) {
      const r = await psql(inTx(refused, `set local statement_timeout = '1500ms'; select ${SV}()`));
      assert.ok(r.ok && r.out === 'AUTH_REQUIRED', `refused without reading (${r.error})`);
    }
    const good = await psql(inTx(jsonClaims(c), `set local statement_timeout = '1500ms'; select ${SV}()`));
    assert.ok(!good.ok && /statement timeout/u.test(good.error), 'a good caller reads the login and the session');
  } finally {
    await auth.output();
  }
  const b = await person({ workspace: true });
  const holder = spawn(`begin; lock table public.common_accounts, public.service_entitlements, public.brands, public.brand_memberships, private.account_lifecycle_operations in access exclusive mode; select pg_sleep(4) /* sv-life */; commit`);
  await untilSleeping('sv-life');
  try {
    const r = await psql(inTx(jsonClaims(b), `set local statement_timeout = '1500ms'; select ${SV}()`));
    assert.ok(r.ok && r.out === 'active', `answers while the lifecycle tables are locked (${r.error})`);
  } finally {
    await holder.output();
  }
});

test_('fail closed: an unreadable or RLS-filtered auth.sessions RAISES (42501), never active; with the guard taken off a hidden row could only refuse', async () => {
  await consumer();
  const a = await person();
  const id = await reserve(a);
  await sql(`revoke select on auth.sessions from ${owner}`);
  try {
    const r = await run(owner, ['-v', 'VERBOSITY=verbose', '-c', inTx(jsonClaims(a), `select ${SV}()`)]);
    assert.ok(!r.ok && /42501: permission denied for table sessions/u.test(r.error), r.error);
    const c = await asApi(jsonClaims(a), `select sv_consumer.cancel('${id}')`);
    assert.ok(!c.ok, 'the consumer aborts');
  } finally {
    await sql(`grant select on auth.sessions to ${owner}`);
  }
  await hostile('auth.sessions', async () => {
    const r = await run(owner, ['-v', 'VERBOSITY=verbose', '-c', inTx(jsonClaims(a), `select ${SV}()`)]);
    assert.ok(!r.ok && /42501/u.test(r.error) && RLS_ERROR.test(r.error) && r.error.includes('"sessions"'), r.error);
    const c = await asApi(jsonClaims(a), `select sv_consumer.cancel('${id}')`);
    assert.ok(!c.ok && RLS_ERROR.test(c.error), 'the consumer aborts');
    await sql(`alter function ${SV}() reset row_security`);
    try {
      assert.equal(await verdict(jsonClaims(a)), 'SESSION_REVOKED', 'without the guard the hidden row reads as no session: a refusal, never active');
    } finally {
      await sql(`alter function ${SV}() set row_security = off`);
    }
  });
  assert.equal(await status(id), 'planned');
  assert.equal(await verdict(jsonClaims(a)), 'active');
});

test_('the install refuses, and leaves nothing, on an unsafe layout; the legitimate ways (owner, inherited owner, BYPASSRLS) install; hostile default privileges are undone', async () => {
  const gone = () => sql(`select count(*) from pg_proc where proname = 'account_lifecycle_session_verdict'`);
  const attempt = async (label: string, before: () => Promise<unknown>, after: () => Promise<unknown>, code: RegExp) => {
    assert.ok((await run(owner, ['-f', rollback()])).ok);
    await before();
    try {
      const r = await run(owner, ['-f', candidate()]);
      assert.ok(!r.ok && code.test(r.error), `${label}: refused (${r.error.split('\n').find((l) => l.includes('ERROR')) ?? r.error})`);
      assert.equal(await gone(), '0', `${label}: nothing half-installed`);
    } finally {
      await after();
    }
  };
  await attempt('RLS hides auth.sessions rows from the owner', () => superSql(`alter table auth.sessions owner to ${otherRole()}; grant all on auth.sessions to ${owner}; alter table auth.sessions enable row level security`),
    () => superSql(`alter table auth.sessions owner to ${owner}; revoke all on auth.sessions from ${otherRole()}; alter table auth.sessions disable row level security`),
    /SESSION_VERDICT_PRECONDITION_RLS_HIDES_ROWS auth\.sessions/u);
  await attempt('a SET-only (NOINHERIT) membership in the table owner', () => superSql(`alter table auth.users owner to ${otherRole()}; grant all on auth.users to ${owner}; alter table auth.users enable row level security; grant ${otherRole()} to ${owner} with inherit false, set true`),
    () => superSql(`revoke ${otherRole()} from ${owner}; alter table auth.users owner to ${owner}; revoke all on auth.users from ${otherRole()}; alter table auth.users disable row level security`),
    /SESSION_VERDICT_PRECONDITION_RLS_HIDES_ROWS auth\.users/u);
  await attempt('RLS forced on auth.users', () => sql(`alter table auth.users enable row level security; alter table auth.users force row level security`),
    () => sql(`alter table auth.users no force row level security; alter table auth.users disable row level security`), /SESSION_VERDICT_PRECONDITION_RLS_FORCED auth\.users/u);
  await attempt('a view as auth.sessions', () => sql(`alter table auth.sessions rename to sessions_sv_table; create view auth.sessions as select * from auth.sessions_sv_table`),
    () => sql(`drop view auth.sessions; alter table auth.sessions_sv_table rename to sessions`), /SESSION_VERDICT_PRECONDITION_RELATION auth\.sessions/u);
  await attempt('auth.sessions without not_after', () => sql(`alter table auth.sessions rename column not_after to not_after_sv`),
    () => sql(`alter table auth.sessions rename column not_after_sv to not_after`), /SESSION_VERDICT_PRECONDITION_SESSIONS_SHAPE/u);
  await attempt('an API role reaches the owner (authenticator a member)', () => superSql(`grant ${owner} to authenticator`), () => superSql(`revoke ${owner} from authenticator`),
    /SESSION_VERDICT_PRECONDITION_/u);
  // the legitimate ways
  for (const [label, options] of [['an inherited table owner', { inherit: true }], ['BYPASSRLS', { bypass: true }]] as const) {
    await hostile('auth.sessions', async () => {
      assert.ok((await run(owner, ['-f', rollback()])).ok);
      const r = await run(owner, ['-f', candidate()]);
      assert.ok(r.ok, `${label}: installs (${r.error})`);
      const p = await person();
      assert.equal(await verdict(jsonClaims(p)), 'active', `${label}: sees the session`);
    }, options);
  }
  // hostile default privileges: to the API roles -> revoked by the install; to any other role -> the exact-ACL postcondition refuses the install
  await sql(`alter default privileges in schema private grant execute on functions to anon, authenticated, service_role`);
  try {
    assert.ok((await run(owner, ['-f', rollback()])).ok);
    const r = await run(owner, ['-f', candidate()]);
    assert.ok(r.ok, `installs under API-role default privileges (${r.error})`);
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await sql(`select has_function_privilege('${role}', '${SV}()', 'EXECUTE')::text`), 'false', role);
  } finally {
    await sql(`alter default privileges in schema private revoke execute on functions from anon, authenticated, service_role`);
  }
  await attempt('default privileges grant EXECUTE to another role', () => sql(`alter default privileges in schema private grant execute on functions to ${apiRole()}`),
    () => sql(`alter default privileges in schema private revoke execute on functions from ${apiRole()}`), /SESSION_VERDICT_POSTCONDITION_ACL/u);
  assert.ok((await run(owner, ['-f', candidate()])).ok);
  assert.equal(await gone(), '1', 'installed again at the end');
});

test_('no network: the model made no request', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
