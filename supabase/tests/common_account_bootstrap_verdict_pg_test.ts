// G5-07: the bootstrap verdict SQL candidate R0 (supabase/candidates/common_account_authorization_verdict/002_bootstrap_verdict.sql) on a local
// PostgreSQL 17 with fake data, over the REAL F5 chain, the PR #303 owner-epoch candidate and 001 (R1 / W1 / W2). The reference bootstrapVerdict()
// (bootstrap.ts) is the ORACLE: for every world the real R0 must answer exactly what the reference answers from the same facts. The first-connection
// flow runs main's REAL begin RPC and the real R1 with a counting exchange mock. A PASS is not a managed result and not an approval to apply.
// Needs CAL_E2E=1, PGHOST / PGPORT / PGUSER / PGDATABASE / PGSUPER / BV_CANDIDATE / BV_ROLLBACK (the runner sets them).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { acceptAllow, guardIrreversible, type Scope, type VerdictWire } from '../candidates/common_account_postona_authz/verdict.ts';
import { bindingFromAllow } from '../candidates/common_account_postona_authz/rpc_preflight.ts';
import { type BootstrapFacts, bootstrapVerdict } from '../candidates/common_account_postona_authz/bootstrap.ts';

const enabled = Deno.env.get('CAL_E2E') === '1';
const db = Deno.env.get('PGDATABASE') ?? '';
const owner = Deno.env.get('PGUSER') ?? '';
const superUser = Deno.env.get('PGSUPER') ?? '';
const decoder = new TextDecoder();
if (enabled && !db) throw new Error('PGDATABASE is required');
globalThis.fetch = (() => { throw new Error('the G5-07 tests make no network request'); }) as typeof fetch;

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
const candidate = () => Deno.env.get('BV_CANDIDATE') ?? '';
const rollback = () => Deno.env.get('BV_ROLLBACK') ?? '';
const R0 = 'public.common_account_bootstrap_verdict';
const KEYS = 'decision,entitlements,owner_epoch,reason,scope,session,subject,v';

type Claims = { kind: 'legacy'; sub: string; role?: string; session?: string | null; anonymous?: string } | { kind: 'json'; json: string };
function asCaller(claims: Claims, statement: string, role = 'authenticated'): string {
  const sets = claims.kind === 'legacy'
    ? [`set local request.jwt.claim.sub = ${lit(claims.sub)};`, `set local request.jwt.claim.role = ${lit(claims.role ?? 'authenticated')};`,
      claims.session === null ? '' : `set local request.jwt.claim.session_id = ${lit(claims.session ?? '')};`,
      claims.anonymous === undefined ? '' : `set local request.jwt.claim.is_anonymous = ${lit(claims.anonymous)};`].join(' ')
    : `set local request.jwt.claims = ${lit(claims.json)};`;
  return `begin; ${sets} set local role ${role}; ${statement}; commit`;
}
type Person = { user: string; session: string };
const legacy = (p: Person): Claims => ({ kind: 'legacy', sub: p.user, session: p.session });
const jsonClaims = (p: Person, extra: Record<string, unknown> = {}): Claims => ({ kind: 'json', json: JSON.stringify({ sub: p.user, role: 'authenticated', session_id: p.session, ...extra }) });
const callR0 = (app: string | null, feature: string | null) => `select ${R0}(${app === null ? 'null' : lit(app)}, ${feature === null ? 'null' : lit(feature)})::text`;
const r0 = async (c: Claims, app: string | null = 'postona', feature: string | null = 'x_connect_bootstrap'): Promise<Record<string, unknown>> =>
  JSON.parse(await sql(asCaller(c, callR0(app, feature))));
const why = (v: Record<string, unknown>) => `${v.decision}:${v.reason}`;
const derived = (user: string) => sql(`select public.social_mobile_account_deletion_workspace('${user}'::uuid)`);

// the oracle: bootstrapVerdict() over facts read by a TEST-ONLY statement (G5-01's person facts + the own workspace by the server's derivation)
const FACTS_SQL = `select json_build_object(
  'userExists', exists (select 1 from auth.users u where u.id = $1::uuid),
  'sessionLive', (select case when s.id is null then false when s.not_after is null or s.not_after > clock_timestamp() then true else null end
                    from (select 1) x left join auth.sessions s on s.id = $2::uuid and s.user_id = $1::uuid),
  'account', (select json_build_object('status', a.status, 'lifecycleVersion', a.lifecycle_version,
                'deletionOpen', exists (select 1 from private.account_lifecycle_operations o where o.user_id = a.user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress'))
                from public.common_accounts a where a.user_id = $1::uuid),
  'entitlements', coalesce((select json_object_agg(e.service_key, json_build_object('status', e.status,
                'deletionOpen', exists (select 1 from private.account_lifecycle_operations o where o.user_id = e.user_id and o.operation_type = 'service_deletion'
                                         and o.service_key = e.service_key and o.status = 'in_progress')))
                from public.service_entitlements e where e.user_id = $1::uuid), '{}'::json),
  'ownWorkspace', (select json_build_object('kind', b.code_profile_key,
                'callerRole', (select m.role from public.brand_memberships m where m.brand_id = b.id and m.user_id = $1::uuid),
                'ownerUserId', (select case when count(*) = 1 then (array_agg(m.user_id))[1] end from public.brand_memberships m where m.brand_id = b.id and m.role = 'owner'),
                'ownerCount', (select count(*) from public.brand_memberships o where o.brand_id = b.id and o.role = 'owner'))
              from public.brands b where b.id = public.social_mobile_account_deletion_workspace($1::uuid)))`;
async function oracle(p: Person, app: string, feature: string): Promise<Record<string, unknown>> {
  const facts = JSON.parse(await sql(FACTS_SQL.replaceAll('$1', lit(p.user)).replaceAll('$2', lit(p.session)))) as BootstrapFacts;
  const { issued_at_ms: _i, expires_at_ms: _e, ...wire } = await bootstrapVerdict({ app, feature, brandId: null }, { userId: p.user, sessionId: p.session, role: 'authenticated' }, facts, 0);
  return JSON.parse(JSON.stringify(wire));
}
async function agree(p: Person, label: string, app = 'postona', feature = 'x_connect_bootstrap'): Promise<Record<string, unknown>> {
  const viaLegacy = await r0(legacy(p), app, feature);
  const viaJson = await r0(jsonClaims(p), app, feature);
  assert.equal(Object.keys(viaLegacy).sort().join(','), KEYS, `${label}: exactly the 8 keys`);
  assert.equal(viaLegacy.owner_epoch, null, `${label}: never an owner epoch`);
  assert.deepEqual((viaLegacy.scope as Record<string, unknown>).brand_slug, null, `${label}: never a brand`);
  assert.deepEqual(viaJson, viaLegacy, `${label}: both claim forms agree`);
  assert.deepEqual(viaLegacy, await oracle(p, app, feature), `${label}: the SQL answer equals bootstrapVerdict()`);
  return viaLegacy;
}

// the world: a person with NO workspace (fixture_login), optionally the service; or with their workspace (fixture_user_with_workspace)
async function person(options: { x?: boolean; kabumori?: boolean; workspace?: boolean } = {}): Promise<Person> {
  const user = randomUUID();
  if (options.workspace) await sql(`select public.fixture_user_with_workspace('${user}'::uuid, ${lit(`bv_${user.slice(0, 6)}`)})`);
  else await sql(`select public.fixture_login('${user}'::uuid)`);
  const start = (fn: string) => sql(asCaller({ kind: 'legacy', sub: user, session: null }, `select to_jsonb(public.${fn}())`));
  if (options.x !== false) assert.equal(JSON.parse(await start('start_x_autopost_service')).status, 'active');
  if (options.kabumori) assert.equal(JSON.parse(await start('start_kabumori_service')).status, 'active');
  const session = randomUUID();
  await sql(`insert into auth.sessions (id, user_id, not_after) values ('${session}', '${user}', null)`);
  return { user, session };
}
const brandCount = () => sql(`select count(*) from public.brands`);
/** A workspace under the id derived for `p`, owned by someone else (an operator mistake, a leftover). */
async function preclaim(p: Person, members: [string, string][], kind = 'social_mobile_user_v1') {
  const ws = await derived(p.user);
  await sql(`insert into public.brands (id, code_profile_key) values (${lit(ws)}, ${lit(kind)})`);
  for (const [u, role] of members) await sql(`insert into auth.users (id) values ('${u}') on conflict do nothing; insert into public.brand_memberships values (${lit(ws)}, '${u}', ${lit(role)})`);
  return ws;
}

// =============================================================================================================================================
test_('install: one STABLE definer function with an empty search path, EXECUTE to authenticated only, no brand or person parameter; a second install is refused; rollback and re-install', async () => {
  assert.equal(await sql(`select array_to_string(proacl::text[], ',') from pg_proc where oid = '${R0}(text,text)'::regprocedure`), `${owner}=X/${owner},authenticated=X/${owner}`);
  assert.equal(await sql(`select (provolatile = 's' and prosecdef and proconfig @> array['search_path=""', 'row_security=off'] and proowner = (select oid from pg_roles where rolname = current_user))::text
    from pg_proc where oid = '${R0}(text,text)'::regprocedure`), 'true');
  assert.equal(await sql(`select count(*) from pg_proc where oid in ('public.common_account_authorization_verdict(text,text,text)'::regprocedure,
    'private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)'::regprocedure, 'public.common_account_worker_brand_verdict(text,text,bigint,bigint)'::regprocedure,
    'private.account_lifecycle_generation_covered()'::regprocedure) and proconfig @> array['row_security=off']`), '4', 'R1 / W1 / W2 / GC run with row_security = off too');
  assert.equal(await sql(`select pg_get_function_identity_arguments('${R0}(text,text)'::regprocedure)`), 'p_app text, p_feature text');
  assert.ok(/BOOTSTRAP_VERDICT_ALREADY_APPLIED/u.test((await run(owner, ['-f', candidate()])).error));
  assert.ok((await run(owner, ['-f', rollback()])).ok);
  assert.equal(await sql(`select count(*) from pg_proc where proname = 'common_account_bootstrap_verdict'`), '0');
  assert.equal(await sql(`select count(*) from pg_proc where proname = 'common_account_authorization_verdict'`), '1', 'the rollback leaves R1 alone');
  assert.ok((await run(owner, ['-f', candidate()])).ok, 'the install works again');
  for (const role of ['anon', 'service_role']) {
    const r = await psql(`begin; set local role ${role}; ${callR0('postona', 'x_connect_bootstrap')}; commit`);
    assert.ok(!r.ok && /permission denied/u.test(r.error), `${role} cannot call R0`);
  }
  for (const extra of [`'u_someone'`, `'${randomUUID()}'::uuid`]) {
    const r = await psql(asCaller({ kind: 'legacy', sub: randomUUID(), session: randomUUID() }, `select ${R0}('postona', 'x_connect_bootstrap', ${extra})`));
    assert.ok(!r.ok && /does not exist/u.test(r.error), 'there is no brand or person parameter to pass');
  }
});

test_('the oracle, allowed: a person with no workspace yet and a person whose own workspace is exactly theirs, both features, both claim forms; R0 creates nothing', async () => {
  const fresh = await person();
  const before = await brandCount();
  for (const feature of ['x_connect_bootstrap', 'threads_connect_bootstrap']) assert.equal(why(await agree(fresh, feature, 'postona', feature)), 'allow:null');
  assert.equal(await brandCount(), before, 'R0 created no workspace');
  assert.equal(await sql(`select count(*) from public.brands where id = ${lit(await derived(fresh.user))}`), '0');
  const own = await person({ workspace: true });
  const allow = await agree(own, 'own workspace');
  assert.equal(why(allow), 'allow:null');
  assert.deepEqual(allow.entitlements, ['postona:x_autopost']);
  assert.ok(!JSON.stringify(allow).includes(own.session) && !JSON.stringify(allow).includes(await derived(own.user)), 'no raw session id, no workspace id');
  // the caller's own workspace with other members (a viewer, an admin) is still exactly theirs: allowed, and the caller's role is the caller's
  const withMembers = await person({ workspace: true });
  for (const role of ['viewer', 'admin']) {
    const m = randomUUID();
    await sql(`insert into auth.users (id) values ('${m}'); insert into public.brand_memberships values (${lit(await derived(withMembers.user))}, '${m}', ${lit(role)})`);
  }
  assert.equal(why(await agree(withMembers, 'own workspace with a viewer and an admin')), 'allow:null');
  // read-only: R0 runs inside a READ ONLY transaction
  assert.equal(JSON.parse(await sql(`begin read only; set local request.jwt.claim.sub = '${fresh.user}'; set local request.jwt.claim.role = 'authenticated';
    set local request.jwt.claim.session_id = '${fresh.session}'; set local role authenticated; ${callR0('postona', 'x_connect_bootstrap')}; commit`)).decision, 'allow');
});

test_('the oracle, refused: no account, Kabumori only, every entitlement / account state, freeze, 退会, signed out / expired, a pre-claimed workspace, the caller as admin there, two owners, another kind, bad questions', async () => {
  const cases: [string, () => Promise<Person>, string][] = [
    ['no common account', () => person({ x: false }), 'deny:ACCOUNT_NOT_FOUND'],
    ['Kabumori only', () => person({ x: false, kabumori: true }), 'deny:SERVICE_NOT_REGISTERED'],
    ['ended', async () => { const p = await person(); await sql(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${p.user}'`); return p; }, 'deny:SERVICE_NOT_ACTIVE'],
    ['suspended', async () => { const p = await person(); await sql(`update public.service_entitlements set status = 'suspended' where user_id = '${p.user}'`); return p; }, 'deny:SERVICE_SUSPENDED'],
    ['provisioning', async () => { const p = await person(); await sql(`update public.service_entitlements set status = 'provisioning' where user_id = '${p.user}'`); return p; }, 'pending:SERVICE_PROVISIONING'],
    ['service-end freeze', async () => { const p = await person({ workspace: true }); await sql(`begin; set local role service_role; select public.begin_service_deletion('${p.user}'::uuid, 'x_autopost'); commit`); return p; }, 'deny:SERVICE_DELETION_IN_PROGRESS'],
    ['退会 started', async () => {
      const p = await person();
      const lv = await sql(`select lifecycle_version from public.common_accounts where user_id = '${p.user}'`);
      assert.equal(JSON.parse(await sql(`begin; set local role service_role; select public.begin_common_account_deletion('${p.user}'::uuid, ${lv}); commit`)).status, 'started');
      return p;
    }, 'deny:ACCOUNT_DELETION_IN_PROGRESS'],
    ['locked', async () => { const p = await person(); await sql(`update public.common_accounts set status = 'locked' where user_id = '${p.user}'`); return p; }, 'deny:ACCOUNT_LOCKED'],
    ['signed out', async () => { const p = await person(); await sql(`delete from auth.sessions where id = '${p.session}'`); return p; }, 'deny:SESSION_REVOKED'],
    ['expired', async () => { const p = await person(); await sql(`update auth.sessions set not_after = now() - interval '1 second' where id = '${p.session}'`); return p; }, 'deny:SESSION_EXPIRED'],
    ['pre-claimed by someone else', async () => { const p = await person(); await preclaim(p, [[randomUUID(), 'owner']]); return p; }, 'deny:OWN_WORKSPACE_CONFLICT'],
    ['the caller is only an admin there', async () => { const p = await person(); await preclaim(p, [[randomUUID(), 'owner'], [p.user, 'admin']]); return p; }, 'deny:OWN_WORKSPACE_CONFLICT'],
    ['two owners', async () => { const p = await person(); await preclaim(p, [[p.user, 'owner'], [randomUUID(), 'owner']]); return p; }, 'unknown:WORKSPACE_OWNER_UNKNOWN'],
    ['another workspace kind', async () => { const p = await person(); await preclaim(p, [[p.user, 'owner']], 'organization_v1'); return p; }, 'deny:OWN_WORKSPACE_CONFLICT'],
    ['an ownerless workspace under the derived id', async () => { const p = await person(); await preclaim(p, [[p.user, 'member']]); return p; }, 'unknown:WORKSPACE_OWNER_UNKNOWN'],
  ];
  for (const [label, make, expected] of cases) assert.equal(why(await agree(await make(), label)), expected, label);
  const a = await person();
  for (const [app, feature] of [['kabumori', 'x_connect_bootstrap'], ['miseiro', 'x_connect_bootstrap'], ['postona', 'x_connect'], ['postona', 'x_publish'], ['postona', 'consult'],
    ['postona', 'read_workspace'], ['postona', 'x_connect_bootstrap\n'], ['postona', '__proto__']] as const) {
    assert.equal(why(await agree(a, `${app}/${feature}`, app, feature)), 'deny:FEATURE_NOT_ENABLED');
  }
  assert.equal(why(await r0(legacy(a), 'postona', null)), 'deny:FEATURE_NOT_ENABLED');
  // a conflict answer never carries the other owner's id
  const b = await person();
  const other = randomUUID();
  await preclaim(b, [[other, 'owner']]);
  assert.ok(!JSON.stringify(await r0(legacy(b))).includes(other));
});

test_('the subject is the JWT only: anonymous (both forms), non-authenticated role claims, a missing / malformed session, malformed claims, an auth.uid() that disagrees', async () => {
  const a = await person();
  const refused: Claims[] = [
    jsonClaims(a, { is_anonymous: true }), jsonClaims(a, { is_anonymous: 'false' }), { kind: 'legacy', sub: a.user, session: a.session, anonymous: 'true' },
    jsonClaims(a, { role: 'service_role' }), jsonClaims(a, { role: 'anon' }), { kind: 'legacy', sub: a.user, session: null }, jsonClaims(a, { session_id: 'abc' }),
    { kind: 'json', json: '{not json' }, { kind: 'json', json: '[1]' }, jsonClaims({ user: 'not-a-uuid', session: a.session }),
  ];
  for (const c of refused) {
    const v = await r0(c);
    assert.equal(why(v), 'deny:AUTH_REQUIRED', JSON.stringify(c));
    assert.deepEqual(v.subject, { kind: 'system' });
  }
  assert.equal((await r0(jsonClaims(a, { is_anonymous: null }))).decision, 'allow');
  const b = await person();
  const def = await sql(`select pg_get_functiondef('auth.uid()'::regprocedure)`);
  await sql(`create or replace function auth.uid() returns uuid language sql stable as $$ select '${b.user}'::uuid $$`);
  try {
    for (const c of [legacy(a), jsonClaims(a)]) assert.equal(why(await r0(c)), 'deny:AUTH_REQUIRED', `auth.uid() disagrees (${c.kind})`);
  } finally {
    await sql(def);
  }
  assert.equal((await r0(legacy(a))).decision, 'allow');
});

test_('nothing is read before the question and the caller are accepted: with the entitlements locked away, refusals answer at once and a good question waits', async () => {
  const a = await person();
  const holder = spawn(`begin; lock table public.service_entitlements in access exclusive mode; select pg_sleep(4) /* bv-lock */; commit`);
  await untilSleeping('bv-lock');
  try {
    for (const [app, feature] of [['kabumori', 'x_connect_bootstrap'], ['postona', 'x_connect']] as const) {
      const r = await psql(asCaller(legacy(a), `set local statement_timeout = '1500ms'; ${callR0(app, feature)}`));
      assert.ok(r.ok, `${app}/${feature}: ${r.error}`);
    }
    assert.ok((await psql(asCaller(jsonClaims(a, { is_anonymous: true }), `set local statement_timeout = '1500ms'; ${callR0('postona', 'x_connect_bootstrap')}`))).ok);
    const good = await psql(asCaller(legacy(a), `set local statement_timeout = '1500ms'; ${callR0('postona', 'x_connect_bootstrap')}`));
    assert.ok(!good.ok && /statement timeout/u.test(good.error), 'a good question reads the facts');
  } finally {
    await holder.output();
  }
});

test_('one snapshot: two R0 calls in ONE statement agree across a concurrent end of the service; the next statement sees it', async () => {
  const a = await person();
  const one = spawn(asCaller(legacy(a), `select ${R0}('postona', 'x_connect_bootstrap')::text || '|' || pg_sleep(2)::text || '|' || ${R0}('postona', 'x_connect_bootstrap')::text /* bv-one */`));
  await untilSleeping('bv-one');
  await sql(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${a.user}'`);
  const [first, , second] = decoder.decode((await one.output()).stdout).trim().split('|');
  assert.equal(first, second);
  assert.equal(JSON.parse(first).decision, 'allow');
  assert.equal(why(await r0(legacy(a))), 'deny:SERVICE_NOT_ACTIVE');
});

test_('an R0 allow opens nothing else: the real R1 refuses the bootstrap features, no consumer accepts it for another scope, no worker can bind to it', async () => {
  const a = await person({ workspace: true });
  const allow = await r0(legacy(a));
  assert.equal(allow.decision, 'allow');
  for (const feature of ['x_connect_bootstrap', 'threads_connect_bootstrap']) {
    const r1 = JSON.parse(await sql(asCaller(legacy(a), `select public.common_account_authorization_verdict('postona', ${lit(feature)}, ${lit(await derived(a.user))})::text`)));
    assert.equal(why(r1), 'deny:FEATURE_NOT_ENABLED', `the real R1 refuses ${feature}`);
  }
  const stamped = { ...allow, issued_at_ms: 1_000, expires_at_ms: 61_000 } as unknown as VerdictWire;
  const ws = await derived(a.user);
  for (const s of [{ app: 'postona', feature: 'x_connect', brandId: ws }, { app: 'postona', feature: 'x_publish', brandId: ws }, { app: 'postona', feature: 'consult', brandId: ws }]) {
    assert.deepEqual(acceptAllow(stamped, s, 2_000), { refused: 'SCOPE_MISMATCH' });
  }
  assert.equal(bindingFromAllow(stamped), null, 'no owner epoch -> no binding');
  const w2 = await sql(`begin; set local role service_role; select public.common_account_worker_brand_verdict(${lit(ws)}, 'x_autopost', null, null); commit`);
  assert.equal(w2, 'EXPECTED_OWNER_EPOCH_REQUIRED', 'the worker form has nothing to compare an R0 allow with');
});

// ---- the first connection end to end: R0 -> main's REAL begin RPC -> the real R1 at the callback -> recheck -> one (mock) code exchange -------
const begin = (p: Person) => sql(asCaller(legacy(p), `select brand_id || '|' || social_account_id from public.begin_social_mobile_x_oauth_connection(
  ${lit(createHash('sha256').update(randomUUID()).digest('hex'))}, 'kabumori-social://oauth-callback', now() + interval '10 minutes')`));
const r1 = async (p: Person, ws: string, at: number): Promise<VerdictWire> => {
  const wire = JSON.parse(await sql(asCaller(legacy(p), `select public.common_account_authorization_verdict('postona', 'x_connect', ${lit(ws)})::text`)));
  return { ...wire, issued_at_ms: at, expires_at_ms: wire.decision === 'allow' ? at + 60_000 : at };
};
async function firstConnection(p: Person, hooks: { afterBegin?: () => Promise<void>; beforeExchange?: () => Promise<void> } = {}) {
  let exchanges = 0;
  const boot = await r0(legacy(p));
  if (boot.decision !== 'allow') return { stage: 'bootstrap', code: boot.reason, exchanges };
  const [ws] = (await begin(p)).split('|');
  await hooks.afterBegin?.();
  const scope: Scope = { app: 'postona', feature: 'x_connect', brandId: ws };
  const t0 = Date.now();
  const out = await guardIrreversible({ scope, first: await r1(p, ws, t0), prepare: async () => { await hooks.beforeExchange?.(); },
    recheck: () => r1(p, ws, t0 + 10), act: () => { exchanges += 1; return Promise.resolve('tokens (SIMULATED)'); }, nowMs: () => t0 + 20 });
  return out.sent ? { stage: 'exchanged', code: null, exchanges, ws } : { stage: 'callback', code: out.refused, exchanges, ws };
}

test_('the first connection: R0 allows, main\'s real begin creates exactly the caller\'s workspace, the real R1 allows at the callback, one exchange; a reconnect works the same', async () => {
  const a = await person();
  const r = await firstConnection(a);
  assert.deepEqual([r.stage, r.exchanges], ['exchanged', 1]);
  assert.equal(r.ws, await derived(a.user), 'the workspace is the server-derived one');
  assert.equal(await sql(`select string_agg(user_id::text || ':' || role, ',') from public.brand_memberships where brand_id = ${lit(r.ws!)}`), `${a.user}:owner`);
  assert.equal(why(await r0(legacy(a))), 'allow:null', 'the workspace now exists and is exactly the caller\'s');
  const again = await firstConnection(a);
  assert.deepEqual([again.stage, again.exchanges], ['exchanged', 1]);
});

test_('the first connection, refused with 0 exchanges: 退会 / service end / sign-out between begin and the callback or before the exchange, and a pre-claimed workspace -- where main\'s begin makes the caller a SECOND owner (the gap handed to G4 / F3)', async () => {
  const end = (p: Person) => sql(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${p.user}'`);
  const leave = async (p: Person) => {
    const lv = await sql(`select lifecycle_version from public.common_accounts where user_id = '${p.user}'`);
    await sql(`begin; set local role service_role; select public.begin_common_account_deletion('${p.user}'::uuid, ${lv}); commit`);
  };
  for (const [label, hook, code] of [
    ['退会 between begin and the callback', 'afterBegin', 'ACCOUNT_DELETION_IN_PROGRESS'],
    ['service ended right before the exchange', 'beforeExchange', 'RECHECK_SERVICE_NOT_ACTIVE'],
    ['signed out right before the exchange', 'beforeExchange', 'RECHECK_SESSION_REVOKED'],
  ] as const) {
    const p = await person();
    const act = label.startsWith('退会') ? () => leave(p) : label.startsWith('service') ? () => end(p) : () => sql(`delete from auth.sessions where id = '${p.session}'`).then(() => undefined);
    const r = await firstConnection(p, { [hook]: act });
    assert.deepEqual([r.code, r.exchanges], [code, 0], label);
  }
  // a workspace under the derived id already owned by someone else: R0 refuses before any begin
  const victim = await person();
  const other = randomUUID();
  const ws = await preclaim(victim, [[other, 'owner']]);
  assert.deepEqual(await firstConnection(victim), { stage: 'bootstrap', code: 'OWN_WORKSPACE_CONFLICT', exchanges: 0 });
  // ... and what main's begin does if called anyway: the caller becomes a SECOND owner of someone else's workspace (no post-creation check)
  await begin(victim);
  assert.equal(await sql(`select count(*) from public.brand_memberships where brand_id = ${lit(ws)} and role = 'owner'`), '2', 'main\'s begin joined the caller as a second owner');
  const scope: Scope = { app: 'postona', feature: 'x_connect', brandId: ws };
  const verdict = await r1(victim, ws, Date.now());
  assert.equal(`${verdict.decision}:${verdict.reason}`, 'unknown:WORKSPACE_OWNER_UNKNOWN', 'R1 then refuses (fail closed), so nothing is exchanged');
  assert.deepEqual(acceptAllow(verdict, scope, Date.now()), { refused: 'WORKSPACE_OWNER_UNKNOWN' });
});

test_('the install refuses, and leaves nothing, when a precondition or the role graph is unsafe; hostile default privileges are undone', async () => {
  const gone = () => sql(`select count(*) from pg_proc where proname = 'common_account_bootstrap_verdict'`);
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
    () => sql(`revoke trigger on public.brand_memberships from authenticated`), /BOOTSTRAP_VERDICT_PRECONDITION_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS/u);
  await attempt('RLS forced on brands', () => sql(`alter table public.brands force row level security`), () => sql(`alter table public.brands no force row level security`),
    /BOOTSTRAP_VERDICT_PRECONDITION_RLS_FORCED/u);
  await attempt('a different workspace derivation', () => sql(`create or replace function public.social_mobile_account_deletion_workspace(p_user_id uuid) returns text language sql immutable set search_path = '' as $f$ select 'w_' || p_user_id::text $f$`),
    () => sql(`create or replace function public.social_mobile_account_deletion_workspace(p_user_id uuid) returns text language sql immutable set search_path = '' as $f$ select 'u_' || substr(md5(p_user_id::text), 1, 24) $f$`),
    /BOOTSTRAP_VERDICT_PRECONDITION_WORKSPACE_DERIVATION/u);
  await attempt('anon a member of authenticated', () => psqlSuper(`grant authenticated to anon`), () => psqlSuper(`revoke authenticated from anon`),
    /BOOTSTRAP_VERDICT_POSTCONDITION_API_ROLE_REACHES|BOOTSTRAP_VERDICT_PRECONDITION/u);
  await sql(`alter default privileges in schema public grant execute on functions to anon, service_role`);
  try {
    assert.ok((await run(owner, ['-f', rollback()])).ok);
    assert.ok((await run(owner, ['-f', candidate()])).ok, 'installs under hostile default privileges');
    for (const role of ['anon', 'service_role']) assert.equal(await sql(`select has_function_privilege('${role}', '${R0}(text,text)', 'EXECUTE')::text`), 'false', role);
  } finally {
    await sql(`alter default privileges in schema public revoke execute on functions from anon, service_role`);
  }
  assert.equal(await gone(), '1', 'installed again at the end');
});

// ---- G5-08: every row the verdicts read must be visible to their owner (H1 C1 P2 on PR #383) ----------------------------------------------
const otherRole = () => Deno.env.get('BV_OTHER') ?? '';
const r1Candidate = () => Deno.env.get('BV_R1_CANDIDATE') ?? '';
const r1Rollback = () => Deno.env.get('BV_R1_ROLLBACK') ?? '';
async function superSql(statement: string): Promise<string> {
  const r = await psqlSuper(statement);
  if (!r.ok) throw new Error(r.error);
  return r.out;
}
/** H1's layout on `table`: owned by ANOTHER role, ordinary RLS on (NOT forced), every table privilege granted to the function owner. The table's
 *  own main policies (to authenticated: members / own rows only) then filter the function owner, which is a member of authenticated. */
async function hostile<T>(table: string, body: () => Promise<T>, options: { inherit?: boolean; noInherit?: boolean; bypass?: boolean } = {}): Promise<T> {
  const rls = await sql(`select relrowsecurity::text from pg_class where oid = '${table}'::regclass`);
  await superSql(`alter table ${table} owner to ${otherRole()}; grant all on ${table} to ${owner}; alter table ${table} enable row level security`);
  if (options.inherit) await superSql(`grant ${otherRole()} to ${owner}`);
  if (options.noInherit) await superSql(`grant ${otherRole()} to ${owner} with inherit false, set true`);
  if (options.bypass) await superSql(`alter role ${owner} bypassrls`);
  try {
    return await body();
  } finally {
    if (options.bypass) await superSql(`alter role ${owner} nobypassrls`);
    if (options.inherit || options.noInherit) await superSql(`revoke ${otherRole()} from ${owner}`);
    await superSql(`alter table ${table} owner to ${owner}; revoke all on ${table} from ${otherRole()}${rls === 'true' ? '' : `; alter table ${table} disable row level security`}`);
  }
}
const RLS_ERROR = /query would be affected by row-level security policy for table/u;
const installs = (file: string) => run(owner, ['-f', file]);
const reinstallAll = async () => {
  for (const rb of [rollback(), r1Rollback()]) assert.ok((await installs(rb)).ok);
  for (const file of [r1Candidate(), candidate()]) {
    const r = await installs(file);
    assert.ok(r.ok, r.error);
  }
};

test_('H1 C1 P2: a pre-claimed workspace that RLS hides from the function owner is an ERROR at the call and a refusal at the install (R0 and R1); 0 begin, 0 exchange', async () => {
  const victim = await person();
  const someone = randomUUID();
  const ws = await preclaim(victim, [[someone, 'owner']]);
  assert.equal(why(await agree(victim, 'pre-claimed, every row visible')), 'deny:OWN_WORKSPACE_CONFLICT');
  try {
    await hostile('public.brands', async () => {
      assert.equal(await sql(`select relrowsecurity::text || relforcerowsecurity::text || (relowner = '${otherRole()}'::regrole)::text || has_table_privilege('${owner}', 'public.brands', 'SELECT')::text
        from pg_class where oid = 'public.brands'::regclass`), 'truefalsetruetrue', 'the layout: RLS on, not forced, another owner, SELECT granted');
      assert.equal(await sql(`select count(*) from public.brands where id = ${lit(ws)}`), '0', 'the function owner cannot see the pre-claimed workspace');
      // the call: R0 (installed before the layout turned hostile) raises instead of reading the hidden row as absent
      const call = await psql(asCaller(legacy(victim), callR0('postona', 'x_connect_bootstrap')));
      assert.ok(!call.ok && RLS_ERROR.test(call.error) && call.error.includes('"brands"'), `R0 is an error: ${call.error}`);
      // ... and that guard is what closes the hole: without row_security = off the same call answers allow (H1 C1 P2 reproduced on the real SQL)
      await sql(`alter function ${R0}(text, text) reset row_security`);
      try {
        assert.equal(why(await r0(legacy(victim))), 'allow:null', 'with ordinary row security R0 reads the hidden workspace as absent');
      } finally {
        await sql(`alter function ${R0}(text, text) set row_security = off`);
      }
      // the G4 port: a non-200 is deny / unreachable, so main's begin and the code exchange never run
      let begins = 0;
      let exchanges = 0;
      const gate = await psql(asCaller(legacy(victim), callR0('postona', 'x_connect_bootstrap')));
      if (gate.ok && JSON.parse(gate.out).decision === 'allow') {
        begins += 1;
        await begin(victim);
        exchanges += 1;
      }
      assert.deepEqual([gate.ok, begins, exchanges], [false, 0, 0]);
      assert.equal(await superSql(`select string_agg(user_id::text || ':' || role, ',') from public.brand_memberships where brand_id = ${lit(ws)}`), `${someone}:owner`, 'no second owner');
      // R1 reads the same relation: an error too
      const r1call = await psql(asCaller(legacy(victim), `select public.common_account_authorization_verdict('postona', 'x_connect', ${lit(ws)})::text`));
      assert.ok(!r1call.ok && RLS_ERROR.test(r1call.error), `R1 is an error: ${r1call.error}`);
      // the installs: both refuse this layout and leave nothing
      assert.ok((await installs(rollback())).ok);
      const i0 = await installs(candidate());
      assert.ok(!i0.ok && /BOOTSTRAP_VERDICT_PRECONDITION_RLS_HIDES_ROWS public\.brands/u.test(i0.error), `R0 install refused: ${i0.error}`);
      assert.equal(await sql(`select count(*) from pg_proc where proname = 'common_account_bootstrap_verdict'`), '0');
      assert.ok((await installs(r1Rollback())).ok);
      const i1 = await installs(r1Candidate());
      assert.ok(!i1.ok && /AUTH_VERDICT_PRECONDITION_RLS_HIDES_ROWS public\.brands/u.test(i1.error), `R1 install refused: ${i1.error}`);
      assert.equal(await sql(`select count(*) from pg_proc where proname in ('common_account_authorization_verdict', 'account_lifecycle_worker_brand_verdict',
        'common_account_worker_brand_verdict', 'account_lifecycle_generation_covered')`), '0');
    });
  } finally {
    await reinstallAll();
  }
  assert.equal(why(await agree(victim, 'pre-claimed, visible again')), 'deny:OWN_WORKSPACE_CONFLICT');
  // W1 (an owner-only writer's check) on a hidden entitlement / account: an error, never a stale 'active'
  const a = await person({ workspace: true });
  const allow = await r0(legacy(a));
  assert.equal(allow.decision, 'allow');
  const [epoch, lv] = (await sql(`select private.account_lifecycle_brand_owner_epoch(${lit(await derived(a.user))}) || '|' || lifecycle_version from public.common_accounts where user_id = '${a.user}'`)).split('|');
  const w1 = `select private.account_lifecycle_worker_brand_verdict(${lit(await derived(a.user))}, 'x_autopost', ${epoch}, ${lv})`;
  assert.equal(await sql(w1), 'active');
  for (const [table, name] of [['public.common_accounts', 'common_accounts'], ['public.service_entitlements', 'service_entitlements']] as const) {
    // common_accounts is read by W1 itself; service_entitlements only inside the helper it calls (P5's service state), under W1's row_security
    await hostile(table, async () => {
      const r = await psql(w1);
      assert.ok(!r.ok && RLS_ERROR.test(r.error) && r.error.includes(`"${name}"`), `W1 is an error for ${table}: ${r.error}`);
    });
  }
  assert.equal(await sql(w1), 'active');
});

test_('every row visible, the legitimate ways: the table owner\'s privileges (also by inheritance) or BYPASSRLS install and see the pre-claimed workspace; a SET-only (NOINHERIT) membership and a view are refused', async () => {
  const victim = await person();
  await preclaim(victim, [[randomUUID(), 'owner']]);
  const fresh = await person();
  const reinstallR0 = async (label: string) => {
    assert.ok((await installs(rollback())).ok);
    const r = await installs(candidate());
    assert.ok(r.ok, `${label}: installs (${r.error})`);
    assert.equal(why(await agree(victim, `${label}: pre-claimed`)), 'deny:OWN_WORKSPACE_CONFLICT');
    assert.equal(why(await agree(fresh, `${label}: no workspace`)), 'allow:null');
  };
  try {
    // RLS on, the function owner owns the table: PostgreSQL's owner rule shows every row
    await sql(`alter table public.brands enable row level security`);
    try {
      await reinstallR0('RLS on, owned by the function owner');
    } finally {
      await sql(`alter table public.brands disable row level security`);
    }
    await hostile('public.brands', () => reinstallR0('another owner whose privileges the function owner inherits'), { inherit: true });
    await hostile('public.brands', () => reinstallR0('another owner, the function owner has BYPASSRLS'), { bypass: true });
    // a membership WITHOUT inherit (SET only) is not the owner's privileges: PostgreSQL filters, so the install must refuse (not "safe")
    await hostile('public.brands', async () => {
      assert.equal(await sql(`select (pg_has_role('${owner}', '${otherRole()}', 'MEMBER') and not pg_has_role('${owner}', '${otherRole()}', 'USAGE'))::text`), 'true');
      assert.equal(await sql(`select count(*) from public.brands where id = ${lit(await derived(victim.user))}`), '0', 'the owner is filtered');
      assert.ok((await installs(rollback())).ok);
      const r = await installs(candidate());
      assert.ok(!r.ok && /BOOTSTRAP_VERDICT_PRECONDITION_RLS_HIDES_ROWS public\.brands/u.test(r.error), `NOINHERIT is refused: ${r.error}`);
    }, { noInherit: true });
    // a view under a relation's name could hide rows with its WHERE: refused
    await sql(`alter table auth.sessions rename to sessions_bv_table; create view auth.sessions as select * from auth.sessions_bv_table`);
    try {
      assert.ok((await installs(rollback())).ok);
      const r = await installs(candidate());
      assert.ok(!r.ok && /BOOTSTRAP_VERDICT_PRECONDITION_RELATION auth\.sessions/u.test(r.error), `a view is refused: ${r.error}`);
    } finally {
      await sql(`drop view auth.sessions; alter table auth.sessions_bv_table rename to sessions`);
    }
  } finally {
    assert.ok((await installs(rollback())).ok);
    const r = await installs(candidate());
    assert.ok(r.ok, r.error);
  }
});

test_('no network: the model made no request', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
