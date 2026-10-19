// G5-03: the authorization verdict SQL candidate (supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql) on a local
// PostgreSQL 17 with fake data, over the REAL F5 chain (P1..P10) and the PR #303 owner-epoch candidate. The reference decide() (verdict.ts) and
// workerBrandVerdict() (rpc_preflight.ts) are the ORACLES: for every world the real RPC must answer exactly what the reference answers from the same
// facts. A PASS is not a managed result (claim names, auth.uid(), PostgREST status codes stay NOT_VERIFIED), not a wired Edge function and not an
// approval to apply. Needs CAL_E2E=1, PGHOST / PGPORT / PGUSER / PGDATABASE / PGSUPER / AV_CANDIDATE / AV_ROLLBACK (the runner sets them).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { type AuthFacts, decide, type Principal, type Scope } from '../candidates/common_account_postona_authz/verdict.ts';
import { workerBrandVerdict } from '../candidates/common_account_postona_authz/rpc_preflight.ts';

const enabled = Deno.env.get('CAL_E2E') === '1';
const db = Deno.env.get('PGDATABASE') ?? '';
const owner = Deno.env.get('PGUSER') ?? '';
const superUser = Deno.env.get('PGSUPER') ?? '';
const decoder = new TextDecoder();
if (enabled && !db) throw new Error('PGDATABASE is required');
globalThis.fetch = (() => { throw new Error('the G5-03 tests make no network request'); }) as typeof fetch;

type Psql = { ok: boolean; out: string; error: string };
const env = (user: string) => ({ PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: user, PGDATABASE: db, LC_ALL: 'C' });
async function run(user: string, args: string[]): Promise<Psql> {
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...args], env: env(user), clearEnv: true, stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
const psql = (statement: string) => run(owner, ['-c', statement]);
const psqlSuper = (statement: string) => run(superUser, ['-c', statement]);
async function sql(statement: string): Promise<string> {
  const r = await psql(statement);
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
const candidate = () => Deno.env.get('AV_CANDIDATE') ?? '';
const rollback = () => Deno.env.get('AV_ROLLBACK') ?? '';
const R1 = 'public.common_account_authorization_verdict';

// ---- callers ------------------------------------------------------------------------------------------------------------------------------
type Claims = { kind: 'legacy'; sub: string; role?: string; session?: string | null; anonymous?: string } | { kind: 'json'; json: string };
/** A statement run as the database role `role` with the request's claims set the way PostgREST sets them. */
function asCaller(claims: Claims, statement: string, role = 'authenticated'): string {
  const sets = claims.kind === 'legacy'
    ? [`set local request.jwt.claim.sub = ${lit(claims.sub)};`, `set local request.jwt.claim.role = ${lit(claims.role ?? 'authenticated')};`,
      claims.session === null ? '' : `set local request.jwt.claim.session_id = ${lit(claims.session ?? '')};`,
      claims.anonymous === undefined ? '' : `set local request.jwt.claim.is_anonymous = ${lit(claims.anonymous)};`].join(' ')
    : `set local request.jwt.claims = ${lit(claims.json)};`;
  return `begin; ${sets} set local role ${role}; ${statement}; commit`;
}
const legacy = (p: { user: string; session: string }): Claims => ({ kind: 'legacy', sub: p.user, session: p.session });
const jsonClaims = (p: { user: string; session: string }, extra: Record<string, unknown> = {}): Claims =>
  ({ kind: 'json', json: JSON.stringify({ sub: p.user, role: 'authenticated', session_id: p.session, ...extra }) });
const call = (app: string | null, feature: string | null, brand: string | null) =>
  `select ${R1}(${app === null ? 'null' : lit(app)}, ${feature === null ? 'null' : lit(feature)}, ${brand === null ? 'null' : lit(brand)})::text`;
async function rpc(claims: Claims, app: string | null, feature: string | null, brand: string | null, role = 'authenticated'): Promise<Record<string, unknown>> {
  return JSON.parse(await sql(asCaller(claims, call(app, feature, brand), role)));
}

// ---- the oracle: the reference decide() over the same facts, read by the G5-01 TEST-ONLY statement ---------------------------------------
const FACTS_SQL = `select json_build_object(
  'userExists', exists (select 1 from auth.users u where u.id = $1::uuid),
  'sessionLive', (select case when s.id is null then false when s.not_after is null or s.not_after > clock_timestamp() then true else null end
                    from (select 1) x left join auth.sessions s on s.id = $2::uuid and s.user_id = $1::uuid),
  'account', (select json_build_object('status', a.status, 'lifecycleVersion', a.lifecycle_version,
                'deletionOpen', exists (select 1 from private.account_lifecycle_operations o
                                         where o.user_id = a.user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress'))
                from public.common_accounts a where a.user_id = $1::uuid),
  'entitlements', coalesce((select json_object_agg(e.service_key, json_build_object('status', e.status,
                'deletionOpen', exists (select 1 from private.account_lifecycle_operations o
                                         where o.user_id = e.user_id and o.operation_type = 'service_deletion' and o.service_key = e.service_key
                                           and o.status = 'in_progress')))
                from public.service_entitlements e where e.user_id = $1::uuid), '{}'::json),
  'brand', (select json_build_object('kind', b.code_profile_key,
                'callerRole', (select m.role from public.brand_memberships m where m.brand_id = b.id and m.user_id = $1::uuid),
                'ownerUserId', private.account_lifecycle_brand_owner(b.id),
                'ownerCount', (select count(*) from public.brand_memberships o where o.brand_id = b.id and o.role = 'owner'),
                'ownerEpoch', private.account_lifecycle_brand_owner_epoch(b.id))
              from public.brands b where b.id = $3))`;
async function oracle(p: Person, app: string, feature: string, brand: string | null): Promise<Record<string, unknown>> {
  const scope: Scope = { app, feature, brandId: brand };
  const principal: Principal = { userId: p.user, sessionId: p.session, role: 'authenticated' };
  const facts = JSON.parse(await sql(FACTS_SQL.replaceAll('$1', lit(p.user)).replaceAll('$2', lit(p.session)).replaceAll('$3', brand === null ? 'null' : lit(brand)))) as AuthFacts;
  const { issued_at_ms: _i, expires_at_ms: _e, ...wire } = await decide(scope, principal, facts, 0);
  return JSON.parse(JSON.stringify(wire));
}
const KEYS = 'decision,entitlements,owner_epoch,reason,scope,session,subject,v';

// ---- the world --------------------------------------------------------------------------------------------------------------------------
type Person = { user: string; session: string; brand: string };
async function person(options: { x?: boolean; kabumori?: boolean } = {}): Promise<Person> {
  const user = randomUUID();
  const brand = await sql(`select public.fixture_user_with_workspace('${user}'::uuid, ${lit(`av_${user.slice(0, 6)}`)})`);
  if (options.x !== false) assert.equal(JSON.parse(await sql(asCaller({ kind: 'legacy', sub: user, session: null }, 'select to_jsonb(public.start_x_autopost_service())'))).status, 'active');
  if (options.kabumori) assert.equal(JSON.parse(await sql(asCaller({ kind: 'legacy', sub: user, session: null }, 'select to_jsonb(public.start_kabumori_service())'))).status, 'active');
  const session = randomUUID();
  await sql(`insert into auth.sessions (id, user_id, not_after) values ('${session}', '${user}', null)`);
  return { user, session, brand };
}
/** The real RPC (both claim forms) equals the oracle. */
async function agree(p: Person, label: string, app = 'postona', feature = 'x_publish', brand: string | null = p.brand): Promise<Record<string, unknown>> {
  const viaLegacy = await rpc(legacy(p), app, feature, brand);
  const viaJson = await rpc(jsonClaims(p), app, feature, brand);
  assert.equal(Object.keys(viaLegacy).sort().join(','), KEYS, `${label}: exactly the 8 keys`);
  assert.deepEqual(viaJson, viaLegacy, `${label}: the JSON claims and the per-claim settings give the same answer`);
  assert.deepEqual(viaLegacy, await oracle(p, app, feature, brand), `${label}: the SQL answer equals the reference decide()`);
  return viaLegacy;
}
const why = (v: Record<string, unknown>) => `${v.decision}:${v.reason}`;

// =============================================================================================================================================
test_('install: three STABLE definer functions with an empty search path; R1 authenticated only, W2 service_role only, W1 no API role; a second install is refused; rollback and re-install', async () => {
  const acl = (fn: string) => sql(`select array_to_string(proacl::text[], ',') from pg_proc where oid = ${lit(fn)}::regprocedure`);
  assert.equal(await acl('public.common_account_authorization_verdict(text,text,text)'), `${owner}=X/${owner},authenticated=X/${owner}`);
  assert.equal(await acl('public.common_account_worker_brand_verdict(text,text,bigint,timestamptz)'), `${owner}=X/${owner},service_role=X/${owner}`);
  assert.equal(await acl('private.account_lifecycle_worker_brand_verdict(text,text,bigint,timestamptz)'), `${owner}=X/${owner}`);
  assert.equal(await sql(`select count(*) from pg_proc where proname in ('common_account_authorization_verdict', 'account_lifecycle_worker_brand_verdict', 'common_account_worker_brand_verdict')
    and provolatile = 's' and prosecdef and proconfig @> array['search_path=""'] and proowner = (select oid from pg_roles where rolname = current_user)`), '3');
  assert.ok(/AUTH_VERDICT_ALREADY_APPLIED/u.test((await run(owner, ['-f', candidate()])).error));
  assert.ok((await run(owner, ['-f', rollback()])).ok);
  assert.equal(await sql(`select count(*) from pg_proc where proname in ('common_account_authorization_verdict', 'account_lifecycle_worker_brand_verdict', 'common_account_worker_brand_verdict')`), '0');
  assert.ok((await run(owner, ['-f', candidate()])).ok, 'the install works again');
  for (const role of ['anon', 'service_role']) {
    const r = await psql(`begin; set local role ${role}; select ${R1}('postona', 'x_publish', 'u_x'); commit`);
    assert.ok(!r.ok && /permission denied/u.test(r.error), `${role} cannot call R1`);
  }
  for (const [role, fn] of [['authenticated', 'public.common_account_worker_brand_verdict'], ['anon', 'public.common_account_worker_brand_verdict'],
    ['authenticated', 'private.account_lifecycle_worker_brand_verdict'], ['service_role', 'private.account_lifecycle_worker_brand_verdict']] as const) {
    const r = await psql(`begin; set local role ${role}; select ${fn}('u_x', 'x_autopost', 1, now()); commit`);
    assert.ok(!r.ok && /permission denied/u.test(r.error), `${role} cannot call ${fn}`);
  }
  const extra = await psql(asCaller({ kind: 'legacy', sub: randomUUID(), session: randomUUID() }, `select ${R1}('postona', 'x_publish', 'u_x', '${randomUUID()}')`));
  assert.ok(!extra.ok && /does not exist/u.test(extra.error), 'there is no identity parameter to pass');
});

test_('the oracle, allowed: the owner of an active POSTONA workspace, every feature, both claim forms -- the SQL answer equals decide() byte for byte', async () => {
  const a = await person();
  for (const feature of ['read_workspace', 'x_connect', 'x_publish', 'threads_connect', 'threads_publish', 'consult', 'post_generation']) {
    const v = await agree(a, feature, 'postona', feature);
    assert.equal(v.decision, 'allow', feature);
  }
  const v = await agree(a, 'allow');
  const epoch = await sql(`select private.account_lifecycle_brand_owner_epoch(${lit(a.brand)})`);
  const lv = await sql(`select lifecycle_version from public.common_accounts where user_id = '${a.user}'`);
  assert.equal(v.owner_epoch, `g5oe:${epoch}:${lv}`);
  assert.ok(!JSON.stringify(v).includes(a.session), 'the raw session id is not returned');
});

test_('the oracle, refused: no account, Kabumori only, every entitlement / account state, deletions, session revoked / expired, foreign / unknown brand, admin, two owners, coverage broken, another workspace kind, bad questions', async () => {
  const cases: [string, () => Promise<Person>, string, string?, string?, (string | null)?][] = [
    ['no common account', () => person({ x: false }), 'deny:ACCOUNT_NOT_FOUND'],
    ['Kabumori only', () => person({ x: false, kabumori: true }), 'deny:SERVICE_NOT_REGISTERED'],
    ['entitlement ended', async () => { const p = await person(); await sql(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${p.user}'`); return p; }, 'deny:SERVICE_NOT_ACTIVE'],
    ['entitlement suspended', async () => { const p = await person(); await sql(`update public.service_entitlements set status = 'suspended' where user_id = '${p.user}'`); return p; }, 'deny:SERVICE_SUSPENDED'],
    ['entitlement provisioning', async () => { const p = await person(); await sql(`update public.service_entitlements set status = 'provisioning' where user_id = '${p.user}'`); return p; }, 'pending:SERVICE_PROVISIONING'],
    ['service-end freeze', async () => { const p = await person(); await sql(`begin; set local role service_role; select public.begin_service_deletion('${p.user}'::uuid, 'x_autopost'); commit`); return p; }, 'deny:SERVICE_DELETION_IN_PROGRESS'],
    ['退会 started', async () => {
      const p = await person();
      const lv = await sql(`select lifecycle_version from public.common_accounts where user_id = '${p.user}'`);
      assert.equal(JSON.parse(await sql(`begin; set local role service_role; select public.begin_common_account_deletion('${p.user}'::uuid, ${lv}); commit`)).status, 'started');
      return p;
    }, 'deny:ACCOUNT_DELETION_IN_PROGRESS'],
    ['account locked', async () => { const p = await person(); await sql(`update public.common_accounts set status = 'locked' where user_id = '${p.user}'`); return p; }, 'deny:ACCOUNT_LOCKED'],
    ['signed out', async () => { const p = await person(); await sql(`delete from auth.sessions where id = '${p.session}'`); return p; }, 'deny:SESSION_REVOKED'],
    ['session expired', async () => { const p = await person(); await sql(`update auth.sessions set not_after = now() - interval '1 second' where id = '${p.session}'`); return p; }, 'deny:SESSION_EXPIRED'],
    ['two owners', async () => { const p = await person(); const q = await person(); await sql(`insert into public.brand_memberships values (${lit(p.brand)}, '${q.user}', 'owner')`); return p; }, 'unknown:WORKSPACE_OWNER_UNKNOWN'],
    ['another workspace kind', async () => { const p = await person(); await sql(`update public.brands set code_profile_key = 'organization_v1' where id = ${lit(p.brand)}`); return p; }, 'deny:WORKSPACE_KIND_UNSUPPORTED'],
  ];
  for (const [label, make, expected] of cases) assert.equal(why(await agree(await make(), label)), expected, label);
  // another person's brand, an unknown brand, an admin of another person's brand
  const a = await person();
  const b = await person();
  assert.equal(why(await agree(b, 'foreign', 'postona', 'x_publish', a.brand)), 'deny:BRAND_ACCESS_DENIED');
  assert.equal(why(await agree(b, 'unknown brand', 'postona', 'x_publish', 'u_nosuchbrand0000')), 'deny:BRAND_ACCESS_DENIED');
  await sql(`insert into public.brand_memberships values (${lit(a.brand)}, '${b.user}', 'admin')`);
  assert.equal(why(await agree(b, 'admin', 'postona', 'x_publish', a.brand)), 'deny:ROLE_NOT_ALLOWED');
  // the epoch coverage broken (a disabled trigger)
  await sql(`alter table public.brand_memberships disable trigger account_lifecycle_owner_epoch_row`);
  try {
    assert.equal(why(await agree(a, 'coverage broken')), 'unknown:OWNER_EPOCH_UNAVAILABLE');
  } finally {
    await sql(`alter table public.brand_memberships enable trigger account_lifecycle_owner_epoch_row`);
  }
  // bad questions
  for (const [app, feature, brand, expected] of [['kabumori', 'x_publish', a.brand, 'deny:FEATURE_NOT_ENABLED'], ['miseiro', 'x_publish', a.brand, 'deny:FEATURE_NOT_ENABLED'],
    ['postona', 'delete_account', a.brand, 'deny:FEATURE_NOT_ENABLED'], ['postona', 'x_publish', null, 'deny:BRAND_REQUIRED'], ['postona', 'x_publish', 'U_UPPER', 'deny:BRAND_REQUIRED'],
    ['postona', 'x_publish', "u_x' or '1'='1", 'deny:BRAND_REQUIRED'], ['postona', 'x_publish', 'u_' + 'a'.repeat(64), 'deny:BRAND_REQUIRED'], ['postona', 'x_publish\n', a.brand, 'deny:FEATURE_NOT_ENABLED']] as const) {
    assert.equal(why(await agree(a, `${app}/${feature}/${brand}`, app, feature, brand)), expected);
  }
});

test_('the subject is the JWT only: anonymous (both forms), a non-authenticated role claim, a missing / malformed session, malformed claims and a sub that is not auth.uid() are refused', async () => {
  const a = await person();
  const refused: Claims[] = [
    jsonClaims(a, { is_anonymous: true }), jsonClaims(a, { is_anonymous: 'false' }), { kind: 'legacy', sub: a.user, session: a.session, anonymous: 'true' },
    jsonClaims(a, { role: 'service_role' }), jsonClaims(a, { role: 'anon' }), { kind: 'legacy', sub: a.user, session: null }, jsonClaims(a, { session_id: 'abc' }),
    { kind: 'json', json: '{not json' }, { kind: 'json', json: '[1]' }, jsonClaims({ user: 'not-a-uuid', session: a.session }),
  ];
  for (const c of refused) {
    const v = await rpc(c, 'postona', 'x_publish', a.brand);
    assert.equal(why(v), 'deny:AUTH_REQUIRED', JSON.stringify(c));
    assert.deepEqual(v.subject, { kind: 'system' });
  }
  assert.equal((await rpc(jsonClaims(a, { is_anonymous: false }), 'postona', 'x_publish', a.brand)).decision, 'allow', 'is_anonymous false');
  assert.equal((await rpc(jsonClaims(a, { is_anonymous: null }), 'postona', 'x_publish', a.brand)).decision, 'allow', 'is_anonymous null = absent (as the reference)');
  // the per-claim settings win over the JSON claims (F5 P3b's precedence), and auth.uid() must agree
  const b = await person();
  const both = await sql(`begin; set local request.jwt.claim.sub = '${a.user}'; set local request.jwt.claim.role = 'authenticated'; set local request.jwt.claim.session_id = '${a.session}';
    set local request.jwt.claims = ${lit(JSON.stringify({ sub: b.user, role: 'authenticated', session_id: b.session }))}; set local role authenticated; ${call('postona', 'x_publish', a.brand)}; commit`);
  assert.deepEqual(JSON.parse(both).subject, { kind: 'user', user_id: a.user });
  // TEST-WORLD: an auth.uid() that disagrees with the claims (another person) -> refused, whatever the claims say
  const def = await sql(`select pg_get_functiondef('auth.uid()'::regprocedure)`);
  await sql(`create or replace function auth.uid() returns uuid language sql stable as $$ select '${b.user}'::uuid $$`);
  try {
    for (const c of [legacy(a), jsonClaims(a)]) assert.equal(why(await rpc(c, 'postona', 'x_publish', a.brand)), 'deny:AUTH_REQUIRED', `auth.uid() disagrees (${c.kind})`);
  } finally {
    await sql(def);
  }
  assert.equal((await rpc(legacy(a), 'postona', 'x_publish', a.brand)).decision, 'allow', 'auth.uid() restored');
});

test_('nothing is read before the question and the caller are accepted: with the facts locked away, a bad question returns at once and a good one has to wait', async () => {
  const a = await person();
  const holder = spawn(`begin; lock table public.service_entitlements in access exclusive mode; select pg_sleep(4) /* av-lock */; commit`);
  await untilSleeping('av-lock');
  try {
    for (const [app, feature, brand] of [['kabumori', 'x_publish', a.brand], ['postona', 'nope', a.brand], ['postona', 'x_publish', 'BAD']] as const) {
      const r = await psql(asCaller(legacy(a), `set local statement_timeout = '1500ms'; ${call(app, feature, brand)}`));
      assert.ok(r.ok, `${app}/${feature}/${brand} answered without touching the locked table: ${r.error}`);
    }
    const anonymous = await psql(asCaller(jsonClaims(a, { is_anonymous: true }), `set local statement_timeout = '1500ms'; ${call('postona', 'x_publish', a.brand)}`));
    assert.ok(anonymous.ok, 'a refused caller reads nothing either');
    const good = await psql(asCaller(legacy(a), `set local statement_timeout = '1500ms'; ${call('postona', 'x_publish', a.brand)}`));
    assert.ok(!good.ok && /statement timeout/u.test(good.error), 'a good question reads the facts (and waits for the lock)');
  } finally {
    await holder.output();
  }
});

test_('no leak: an unknown brand and another person\'s brand are byte-identical; no answer carries another person\'s id, the owner id or a raw session id', async () => {
  const a = await person();
  const b = await person();
  const unknown = await sql(asCaller(legacy(b), call('postona', 'x_publish', 'u_nosuchbrand0000')));
  const foreignAsked = await sql(asCaller(legacy(b), call('postona', 'x_publish', 'u_nosuchbrand0000').replace('u_nosuchbrand0000', a.brand)));
  assert.equal(unknown.replace('u_nosuchbrand0000', a.brand), foreignAsked, 'identical but for the echoed question');
  // a non-member asking about a brand in an odd state (two owners) learns nothing either
  const c = await person();
  const d = await person();
  await sql(`insert into public.brand_memberships values (${lit(c.brand)}, '${d.user}', 'owner')`);
  assert.equal(why(await agree(b, 'two-owner brand of others', 'postona', 'x_publish', c.brand)), 'deny:BRAND_ACCESS_DENIED');
  await sql(`insert into public.brand_memberships values (${lit(a.brand)}, '${b.user}', 'admin')`);
  for (const feature of ['x_publish', 'consult']) {
    const text = await sql(asCaller(legacy(b), call('postona', feature, a.brand)));
    assert.ok(!text.includes(a.user), 'the owner\'s id is never returned');
    assert.ok(!text.includes(b.session) && !text.includes(a.session), 'no raw session id');
  }
});

test_('one snapshot through the RPC: two calls in ONE statement agree across a concurrent owner change; A -> B -> A and an entitlement end / restart change the token', async () => {
  const a = await person();
  const b = await person();
  const change = () => sql(`begin; update public.brand_memberships set role = 'admin' where brand_id = ${lit(a.brand)} and user_id = '${a.user}';
    insert into public.brand_memberships values (${lit(a.brand)}, '${b.user}', 'owner'); commit`);
  const restore = () => sql(`begin; delete from public.brand_memberships where brand_id = ${lit(a.brand)} and user_id = '${b.user}';
    update public.brand_memberships set role = 'owner' where brand_id = ${lit(a.brand)} and user_id = '${a.user}'; commit`);
  const one = spawn(asCaller(legacy(a), `select ${R1}('postona', 'x_publish', ${lit(a.brand)})::text || '|' || pg_sleep(2)::text || '|' || ${R1}('postona', 'x_publish', ${lit(a.brand)})::text /* av-one */`));
  await untilSleeping('av-one');
  await change();
  const [first, , second] = decoder.decode((await one.output()).stdout).trim().split('|');
  assert.equal(first, second, 'one statement, one snapshot');
  assert.equal(JSON.parse(first).decision, 'allow');
  assert.equal(why(await rpc(legacy(a), 'postona', 'x_publish', a.brand)), 'deny:ROLE_NOT_ALLOWED', 'the next statement sees the change');
  await restore();
  const back = await rpc(legacy(a), 'postona', 'x_publish', a.brand);
  assert.equal(back.decision, 'allow');
  assert.notEqual(back.owner_epoch, JSON.parse(first).owner_epoch, 'A -> B -> A: the same owner, a new token');
  await sql(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${a.user}'`);
  await sql(`update public.service_entitlements set status = 'active', ended_at = null where user_id = '${a.user}'`);
  const restarted = await rpc(legacy(a), 'postona', 'x_publish', a.brand);
  assert.equal(restarted.decision, 'allow');
  assert.notEqual(restarted.owner_epoch, back.owner_epoch, 'ended and re-started: a new token (lifecycle_version)');
});

test_('the worker forms: W2 for service_role equals the reference worker answer; owner change, re-activation since the bind, freeze, two owners, broken coverage, a bad bind or key', async () => {
  const W2 = (brand: string, key: string, epoch: string, bound: string) =>
    sql(`begin; set local role service_role; select public.common_account_worker_brand_verdict(${lit(brand)}, ${lit(key)}, ${epoch}, ${bound}); commit`);
  async function both(p: Person, key: string, epoch: number | null, boundSql: string, label: string): Promise<string> {
    const got = await W2(p.brand, key, epoch === null ? 'null' : String(epoch), boundSql);
    const facts = JSON.parse(await sql(`select json_build_object('serviceState', public.common_account_brand_service_state(${lit(p.brand)}, 'x_autopost'),
      'ownerEpoch', private.account_lifecycle_brand_owner_epoch(${lit(p.brand)}),
      'activatedAtMs', (select (extract(epoch from e.activated_at) * 1000)::bigint from public.service_entitlements e
                         where e.user_id = private.account_lifecycle_brand_owner(${lit(p.brand)}) and e.service_key = 'x_autopost'),
      'boundAtMs', (select (extract(epoch from (${boundSql})::timestamptz) * 1000)::bigint))`));
    const model = workerBrandVerdict({ serviceState: facts.serviceState, ownerEpoch: facts.ownerEpoch, entitlementActivatedAtMs: facts.activatedAtMs },
      { serviceKey: key, expectedOwnerEpoch: epoch, boundAtMs: facts.boundAtMs });
    assert.equal(got, model, `${label}: W2 equals the reference`);
    return got;
  }
  const a = await person();
  const epoch = Number(await sql(`select private.account_lifecycle_brand_owner_epoch(${lit(a.brand)})`));
  assert.equal(await both(a, 'x_autopost', epoch, 'now()', 'fresh'), 'active');
  assert.equal(await both(a, 'x_autopost', 0, 'now()', 'stand-in 0'), 'EXPECTED_OWNER_EPOCH_REQUIRED');
  assert.equal(await both(a, 'x_autopost', epoch, 'null', 'no bind time'), 'BOUND_AT_REQUIRED');
  assert.equal(await both(a, 'threads', epoch, 'now()', 'threads key'), 'ACCOUNT_LIFECYCLE_SERVICE_INVALID');
  assert.equal(await both(a, 'kabumori', epoch, 'now()', 'kabumori key'), 'ACCOUNT_LIFECYCLE_SERVICE_INVALID', 'POSTONA posting is x_autopost only');
  // re-activated after the bind (the start / reactivate RPCs set activated_at = now())
  const boundAt = await sql(`select now()::text`);
  await sql(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${a.user}'`);
  await sql(`update public.service_entitlements set status = 'active', ended_at = null, activated_at = clock_timestamp() + interval '1 second' where user_id = '${a.user}'`);
  assert.equal(await both(a, 'x_autopost', epoch, lit(boundAt) + '::timestamptz', 'reactivated'), 'SERVICE_REACTIVATED_SINCE_BIND');
  // A -> B -> A after the bind
  const b = await person();
  await sql(`delete from public.brand_memberships where brand_id = ${lit(a.brand)} and user_id = '${a.user}'`);
  await sql(`insert into public.brand_memberships values (${lit(a.brand)}, '${b.user}', 'owner')`);
  await sql(`delete from public.brand_memberships where brand_id = ${lit(a.brand)} and user_id = '${b.user}'`);
  await sql(`insert into public.brand_memberships values (${lit(a.brand)}, '${a.user}', 'owner')`);
  assert.equal(await both(a, 'x_autopost', epoch, 'now()', 'A -> B -> A'), 'OWNER_EPOCH_CHANGED');
  const now = Number(await sql(`select private.account_lifecycle_brand_owner_epoch(${lit(a.brand)})`));
  await sql(`insert into public.brand_memberships values (${lit(a.brand)}, '${b.user}', 'owner')`);
  assert.equal(await both(a, 'x_autopost', now, 'now()', 'two owners'), 'WORKSPACE_OWNER_UNKNOWN');
  await sql(`delete from public.brand_memberships where brand_id = ${lit(a.brand)} and user_id = '${b.user}'`);
  const settled = Number(await sql(`select private.account_lifecycle_brand_owner_epoch(${lit(a.brand)})`));
  await sql(`alter table public.brand_memberships disable trigger account_lifecycle_owner_epoch_row`);
  try {
    assert.equal(await both(a, 'x_autopost', settled, 'now()', 'coverage broken'), 'OWNER_EPOCH_UNAVAILABLE');
  } finally {
    await sql(`alter table public.brand_memberships enable trigger account_lifecycle_owner_epoch_row`);
  }
  await sql(`begin; set local role service_role; select public.begin_service_deletion('${a.user}'::uuid, 'x_autopost'); commit`);
  assert.equal(await both(a, 'x_autopost', settled, 'now()', 'freeze'), 'SERVICE_DELETION_IN_PROGRESS');
});

test_('the install refuses, and leaves nothing, when a precondition or the role graph is unsafe: API-role TRIGGER, forced RLS, a VOLATILE helper, anon in authenticated, authenticated in service_role', async () => {
  const gone = () => sql(`select count(*) from pg_proc where proname in ('common_account_authorization_verdict', 'account_lifecycle_worker_brand_verdict', 'common_account_worker_brand_verdict')`);
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
  await attempt('authenticated holds TRIGGER on brand_memberships', () => sql(`grant trigger on public.brand_memberships to authenticated`),
    () => sql(`revoke trigger on public.brand_memberships from authenticated`), /AUTH_VERDICT_PRECONDITION_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS/u);
  await attempt('RLS forced on service_entitlements', () => sql(`alter table public.service_entitlements force row level security`),
    () => sql(`alter table public.service_entitlements no force row level security`), /AUTH_VERDICT_PRECONDITION_RLS_FORCED/u);
  await attempt('a VOLATILE helper', () => sql(`alter function private.account_lifecycle_brand_owner(text) volatile`),
    () => sql(`alter function private.account_lifecycle_brand_owner(text) stable`), /AUTH_VERDICT_PRECONDITION_HELPER_SHAPE/u);
  await attempt('anon a member of authenticated', () => psqlSuper(`grant authenticated to anon`), () => psqlSuper(`revoke authenticated from anon`),
    /AUTH_VERDICT_POSTCONDITION_API_ROLE_REACHES|AUTH_VERDICT_PRECONDITION/u);
  await attempt('authenticated a member of service_role', () => psqlSuper(`grant service_role to authenticated`), () => psqlSuper(`revoke service_role from authenticated`),
    /AUTH_VERDICT_POSTCONDITION_API_ROLE_REACHES|AUTH_VERDICT_PRECONDITION/u);
  // default privileges that would hand EXECUTE to every API role are undone by the file's own revoke
  await sql(`alter default privileges in schema public grant execute on functions to anon, service_role`);
  try {
    assert.ok((await run(owner, ['-f', rollback()])).ok);
    assert.ok((await run(owner, ['-f', candidate()])).ok, 'installs under hostile default privileges');
    assert.equal(await sql(`select has_function_privilege('anon', '${R1}(text,text,text)', 'EXECUTE')::text`), 'false');
    assert.equal(await sql(`select has_function_privilege('service_role', '${R1}(text,text,text)', 'EXECUTE')::text`), 'false');
  } finally {
    await sql(`alter default privileges in schema public revoke execute on functions from anon, service_role`);
  }
  assert.equal(await gone(), '3', 'installed again at the end');
});

test_('no network: the model made no request', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
