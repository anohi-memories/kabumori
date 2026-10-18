// F5 M2 (POSTONA AI consultation): what the server-side authorization of an AI consult can rest on TODAY, proven on a local PostgreSQL 17 with fake data.
//
//   Edge identity (a DOUBLE of /auth/v1/user)  ->  body selector  ->  workspace ownership (the REAL brand_memberships RLS of 20260918120000)
//     ->  POSTONA entitlement + common account (F5's REAL Phase 1 column grants and RLS, read as the person's role)  ->  AI plan / quota (a G6 DOUBLE)
//     ->  pre-provider recheck  ->  a MOCK AI provider that only counts
//
// This is a MODEL of the gate the live `social-mobile-consult` handler lacks; nothing of F6's / G6's handler, ledger or provider is used. A PASS is not a
// live AI consultation, not the managed behaviour of PostgREST / GoTrue, and not an AI plan decision. The ONLY outbound call is the counter below; global
// fetch is replaced by a thrower. Needs CAL_E2E=1 and PGHOST / PGPORT / PGUSER / PGDATABASE (common_account_m2_ai_consult_authz_run.sh sets them).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const db = Deno.env.get('PGDATABASE') ?? '';
const decoder = new TextDecoder();
if (enabled && !db) throw new Error('PGDATABASE is required');
globalThis.fetch = (() => { throw new Error('M2 tests make no network request'); }) as typeof fetch;

// ---- psql ------------------------------------------------------------------------------------------------------------------------------
type Psql = { ok: boolean; out: string; error: string };
function psqlEnv(): Record<string, string> {
  return { PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: Deno.env.get('PGUSER') ?? '', PGDATABASE: db, LC_ALL: 'C' };
}
async function psql(statement: string): Promise<Psql> {
  const out = await new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement], env: psqlEnv(), clearEnv: true, stdout: 'piped', stderr: 'piped',
  }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
async function sql(statement: string): Promise<string> {
  const r = await psql(statement);
  if (!r.ok) throw new Error(r.error);
  return r.out;
}
const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
const asRole = (role: 'authenticated' | 'service_role' | 'anon', claims: { sub?: string; session?: string }, statement: string) => {
  const sets = [claims.sub ? `set local request.jwt.claim.sub = '${claims.sub}';` : '', `set local request.jwt.claim.role = '${role}';`,
    claims.session ? `set local request.jwt.claim.session_id = '${claims.session}';` : ''].join(' ');
  return `begin; ${sets} set local role ${role}; ${statement}; commit;`;
};
type Login = { user: string; session: string };
const asLogin = (login: Login, statement: string) => asRole('authenticated', { sub: login.user, session: login.session }, statement);
/** The person's claims on the owner connection (no role switch): for the F5 probe, which reads the claims and not the database role. */
const withClaims = (login: Login, statement: string) =>
  `begin; set local request.jwt.claim.sub = '${login.user}'; set local request.jwt.claim.role = 'authenticated'; set local request.jwt.claim.session_id = '${login.session}'; ${statement}; commit;`;
/** The result of a statement run as the person's role, or the database's refusal. */
const asPerson = (login: Login, statement: string): Promise<Psql> => psql(asLogin(login, statement));
const denied = (r: Psql) => !r.ok && /permission denied|row-level security|does not exist/u.test(r.error);

// ---- people ------------------------------------------------------------------------------------------------------------------------------
type Person = { login: Login; workspace: string };
async function person(tag: string, options: { x?: boolean; kabumori?: boolean } = {}): Promise<Person> {
  const user = randomUUID();
  const workspace = await sql(`select public.fixture_user_with_workspace('${user}'::uuid, ${q(`${tag}_${user.slice(0, 6)}`)})`);
  if (options.x !== false) assert.equal(JSON.parse(await sql(asRole('authenticated', { sub: user }, 'select to_jsonb(public.start_x_autopost_service())'))).status, 'active');
  if (options.kabumori) assert.equal(JSON.parse(await sql(asRole('authenticated', { sub: user }, 'select to_jsonb(public.start_kabumori_service())'))).status, 'active');
  const session = randomUUID();
  await sql(`insert into auth.sessions (id, user_id, not_after) values ('${session}', '${user}', null)`);
  return { login: { user, session }, workspace };
}
const setEntitlement = async (user: string, status: string): Promise<void> => {
  await sql(`update public.service_entitlements set status = '${status}', ended_at = ${status === 'ended' ? 'now()' : 'null'} where user_id = '${user}'::uuid and service_key = 'x_autopost'`);
};
const setAccount = async (user: string, status: string): Promise<void> => {
  await sql(`update public.common_accounts set status = '${status}' where user_id = '${user}'::uuid`);
};
/** The service-end freeze (public.begin_service_deletion, service_role). */
const frozen = async (user: string) => JSON.parse(await sql(`begin; set local role service_role; select public.begin_service_deletion('${user}'::uuid, 'x_autopost'); commit`)) as Record<string, unknown>;

// ---- the model of the consult gate -----------------------------------------------------------------------------------------------------
type Provider = { calls: number; call(): { kind: 'simulated'; reply: string; effects_performed: false } };
const provider = (): Provider => {
  const p: Provider = { calls: 0, call() { p.calls += 1; return { kind: 'simulated', reply: 'SIM-AI-REPLY', effects_performed: false }; } };
  return p;
};
type Doubles = {
  /** a double of `/auth/v1/user`: false = an absent / invalid / expired JWT */
  tokenValid: boolean;
  /** [A] whether the managed `/auth/v1/user` also refuses a token whose session is gone. NOT_VERIFIED; the model lets the test isolate each answer */
  goTrueChecksSession: boolean;
  /** G6's AI plan / quota / budget decision (F5 owns none of it) */
  planAllows: boolean;
  /** how the gate re-reads the entitlement just before the provider call */
  recheck: 'rls' | 'f5_state' | 'none';
};
const DEFAULT: Doubles = { tokenValid: true, goTrueChecksSession: true, planAllows: true, recheck: 'rls' };
type Outcome = { status: number; code: string; steps: string[] };

async function entitled(login: Login): Promise<string> {
  const account = await asPerson(login, `select status from public.common_accounts where user_id = '${login.user}'::uuid`);
  const service = await asPerson(login, `select status from public.service_entitlements where user_id = '${login.user}'::uuid and service_key = 'x_autopost'`);
  if (!account.ok || !service.ok) return 'ENTITLEMENT_READ_UNAVAILABLE';
  const a = account.out === '' ? [] : account.out.split('\n');
  const s = service.out === '' ? [] : service.out.split('\n');
  if (a.length !== 1 || s.length !== 1) return 'NOT_REGISTERED';
  return a[0] === 'active' && s[0] === 'active' ? 'active' : `${a[0]}/${s[0]}`;
}
async function sessionAlive(login: Login): Promise<boolean> {
  return (await sql(`select exists (select 1 from auth.sessions s where s.id = '${login.session}' and s.user_id = '${login.user}'::uuid and (s.not_after is null or s.not_after > clock_timestamp()))`)) === 't';
}

async function consult(p: Person, body: Record<string, unknown>, ai: Provider, doubles: Partial<Doubles> = {}, between?: () => Promise<void>): Promise<Outcome> {
  const d = { ...DEFAULT, ...doubles };
  const steps: string[] = [];
  const out = (status: number, code: string): Outcome => ({ status, code, steps });
  // 1. identity (the live handler: bearer -> /auth/v1/user)
  steps.push('identity');
  if (!d.tokenValid) return out(401, 'AUTH_REQUIRED');
  if (d.goTrueChecksSession && !(await sessionAlive(p.login))) return out(401, 'AUTH_REQUIRED');
  // 2. the body is a selector, never authority (the live parse refuses unknown keys, so a client-supplied user id never travels)
  steps.push('body');
  if (Object.keys(body).some((key) => !['brand_id', 'message', 'history'].includes(key)) || typeof body.brand_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(body.brand_id)) {
    return out(400, 'REQUEST_BODY_INVALID');
  }
  // 3. ownership with the caller's own role (RLS applies; no service role)
  steps.push('ownership');
  const own = await asPerson(p.login, `select count(*) from public.brand_memberships where user_id = '${p.login.user}'::uuid and brand_id = ${q(body.brand_id)} and role = 'owner'`);
  if (!own.ok) return out(503, 'WORKSPACE_READ_UNAVAILABLE');
  if (own.out !== '1') return out(404, 'OWNED_WORKSPACE_NOT_FOUND');
  const profile = await asPerson(p.login, `select code_profile_key from public.brands where id = ${q(body.brand_id)}`);
  if (!profile.ok) return out(503, 'WORKSPACE_READ_UNAVAILABLE');
  if (profile.out !== 'social_mobile_user_v1') return out(profile.out === '' ? 404 : 409, profile.out === '' ? 'OWNED_WORKSPACE_NOT_FOUND' : 'SOCIAL_MOBILE_PROFILE_NOT_CONFIGURED');
  // 4. the POSTONA entitlement and the common account (F5's tables, the person's own role)
  steps.push('entitlement');
  const state = await entitled(p.login);
  if (state === 'ENTITLEMENT_READ_UNAVAILABLE') return out(503, state);
  if (state !== 'active') return out(403, 'CONSULT_NOT_ENTITLED');
  // 5. the AI plan, quota and budget are G6's; x_autopost active does not imply them
  steps.push('plan');
  if (!d.planAllows) return out(429, 'CONSULT_QUOTA_EXCEEDED');
  // 6. just before the provider
  if (between) await between();
  steps.push('recheck');
  if (d.recheck === 'rls' && (await entitled(p.login)) !== 'active') return out(403, 'CONSULT_NOT_ENTITLED');
  if (d.recheck === 'f5_state') {
    const f5 = await sql(asRole('service_role', {}, `select public.common_account_brand_service_state(${q(body.brand_id)}, 'x_autopost')`));
    if (f5 !== 'active') return out(403, 'CONSULT_NOT_ENTITLED');
  }
  steps.push('provider');
  ai.call();
  return out(200, 'ok');
}
const BODY = (p: Person) => ({ brand_id: p.workspace, message: 'a synthetic question', history: [] });
const test_ = enabled ? test : test.skip;

// =============================================================================================================================================
test_('the whole gate passes only when every boundary passes; the provider is the mock, nothing is written', async () => {
  const p = await person('ok');
  const ai = provider();
  const snapshot = () => sql(`select md5(concat_ws('|',
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from public.service_entitlements x),
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from public.common_accounts x),
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from public.brand_memberships x),
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from public.social_accounts x),
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from vault.secrets x)))`);
  const before = await snapshot();
  const o = await consult(p, BODY(p), ai);
  assert.deepEqual([o.status, o.code], [200, 'ok']);
  assert.equal(ai.calls, 1);
  assert.deepEqual(o.steps, ['identity', 'body', 'ownership', 'entitlement', 'plan', 'recheck', 'provider']);
  assert.equal(await snapshot(), before, 'the consult wrote nothing');
});

test_('what the person\'s role can read of F5\'s tables: own rows, granted columns only, no write; anon, service_role and the private schema nothing', async () => {
  const a = await person('acl-a');
  const b = await person('acl-b');
  const own = await asPerson(a.login, `select user_id::text, status, lifecycle_version::text from public.common_accounts`);
  assert.ok(own.ok && own.out.split('\n').length === 1 && own.out.startsWith(a.login.user), 'one row: the person\'s own');
  const ent = await asPerson(a.login, `select user_id::text, service_key, status from public.service_entitlements order by service_key`);
  assert.ok(ent.ok && ent.out.split('\n').every((line) => line.startsWith(a.login.user)), 'only the person\'s own entitlements');
  const other = await asPerson(a.login, `select count(*) from public.service_entitlements where user_id = '${b.login.user}'::uuid`);
  assert.equal(other.out, '0', 'another person\'s row is invisible');
  const otherAccount = await asPerson(a.login, `select count(*) from public.common_accounts where user_id = '${b.login.user}'::uuid`);
  assert.equal(otherAccount.out, '0');
  for (const column of ['source', 'legacy_evidence']) assert.ok(denied(await asPerson(a.login, `select ${column} from public.service_entitlements`)), `${column} is not readable`);
  assert.ok(denied(await asPerson(a.login, `select * from public.service_entitlements`)), 'select * is refused (it names columns that are not granted)');
  const accountColumns = await asPerson(a.login, `select * from public.common_accounts`);
  assert.ok(accountColumns.ok && accountColumns.out.split('|').length === 5, 'common_accounts has exactly the five granted columns, so select * is the granted set');
  assert.ok(denied(await asPerson(a.login, `update public.service_entitlements set status = 'active' where user_id = '${a.login.user}'::uuid`)), 'no update');
  assert.ok(denied(await asPerson(a.login, `delete from public.common_accounts where user_id = '${a.login.user}'::uuid`)), 'no delete');
  assert.ok(denied(await asPerson(a.login, `insert into public.service_entitlements (user_id, service_key, status, source, activated_at) values ('${a.login.user}'::uuid, 'kabumori', 'active', 'self_service', now())`)), 'no insert');
  assert.ok(denied(await asPerson(a.login, `select count(*) from private.account_lifecycle_operations`)), 'the private schema is closed');
  for (const role of ['anon', 'service_role'] as const) {
    const r = await psql(asRole(role, { sub: a.login.user }, `select status from public.service_entitlements`));
    assert.ok(denied(r), `${role} has no direct table access (service_role must use F5's definer functions)`);
  }
});

test_('workspace ownership with the person\'s role (real membership RLS): a foreign brand, a UUID instead of a slug and a client-supplied user id are refused before anything else', async () => {
  const a = await person('own-a');
  const b = await person('own-b');
  const ai = provider();
  const foreign = await consult(a, { brand_id: b.workspace, message: 'x' }, ai);
  assert.deepEqual([foreign.status, foreign.code], [404, 'OWNED_WORKSPACE_NOT_FOUND']);
  assert.ok(!foreign.steps.includes('entitlement'), 'nothing about the entitlement is asked for a brand the person does not own');
  const confused = await consult(a, { brand_id: a.login.user, message: 'x' }, ai);
  assert.deepEqual([confused.status, confused.code], [404, 'OWNED_WORKSPACE_NOT_FOUND'], 'a user UUID is not a workspace slug');
  const injected = await consult(a, { brand_id: a.workspace, message: 'x', user_id: b.login.user }, ai);
  assert.deepEqual([injected.status, injected.code], [400, 'REQUEST_BODY_INVALID'], 'a client-supplied user id never travels');
  const bad = await consult(a, { brand_id: "u_x'; drop table brands; --", message: 'x' }, ai);
  assert.equal(bad.status, 400);
  assert.equal(ai.calls, 0);
  // the membership RLS itself (real): B cannot see A's membership row
  const seen = await asPerson(b.login, `select count(*) from public.brand_memberships where brand_id = ${q(a.workspace)}`);
  assert.equal(seen.out, '0');
});

test_('every lifecycle state that is not active refuses the consult, and the AI provider is never reached', async () => {
  const cases: [string, (p: Person) => Promise<void>][] = [
    ['the entitlement ended', (p) => setEntitlement(p.login.user, 'ended')],
    ['the entitlement is suspended', (p) => setEntitlement(p.login.user, 'suspended')],
    ['the entitlement is provisioning', async (p) => { await sql(`update public.service_entitlements set status = 'provisioning' where user_id = '${p.login.user}'::uuid and service_key = 'x_autopost'`); }],
    ['the service is being deleted (the real freeze)', async (p) => { await frozen(p.login.user); }],
    ['the common account is locked', (p) => setAccount(p.login.user, 'locked')],
    ['the common account is being deleted', (p) => setAccount(p.login.user, 'deleting')],
  ];
  for (const [label, change] of cases) {
    const p = await person('life');
    await change(p);
    const ai = provider();
    const o = await consult(p, BODY(p), ai);
    assert.deepEqual([o.status, o.code], [403, 'CONSULT_NOT_ENTITLED'], label);
    assert.equal(ai.calls, 0, `${label}: the provider was not called`);
  }
  // never started POSTONA (Kabumori only): there is no x_autopost row
  const kab = await person('kab', { x: false, kabumori: true });
  const ai = provider();
  const o = await consult(kab, BODY(kab), ai);
  assert.deepEqual([o.status, o.code], [403, 'CONSULT_NOT_ENTITLED']);
  assert.equal(ai.calls, 0);
});

test_('the plan is not the entitlement: an active x_autopost does not allow the AI; with the plan off the provider is not reached', async () => {
  const p = await person('plan');
  const ai = provider();
  const o = await consult(p, BODY(p), ai, { planAllows: false });
  assert.deepEqual([o.status, o.code], [429, 'CONSULT_QUOTA_EXCEEDED']);
  assert.equal(ai.calls, 0);
  assert.equal(await entitled(p.login), 'active', 'the entitlement itself was active the whole time');
});

test_('the identity doubles refuse before anything is read: no token, an invalid token, a signed-out session', async () => {
  const p = await person('id');
  const ai = provider();
  const none = await consult(p, BODY(p), ai, { tokenValid: false });
  assert.deepEqual([none.status, none.code, none.steps], [401, 'AUTH_REQUIRED', ['identity']]);
  await sql(`delete from auth.sessions where id = '${p.login.session}'`);
  const out = await consult(p, BODY(p), ai);
  assert.deepEqual([out.status, out.code, out.steps], [401, 'AUTH_REQUIRED', ['identity']], 'with an Auth server that checks the session');
  assert.equal(ai.calls, 0);
});

test_('GAP: the entitlement read does not know about sessions: a signed-out person with an unexpired token passes it, F5\'s T13 guard does not', async () => {
  const p = await person('gap');
  await sql(`delete from auth.sessions where id = '${p.login.session}'`);   // signed out; the access token itself has not expired
  assert.equal(await entitled(p.login), 'active', 'RLS only compares auth.uid() with the row: it is blind to the session');
  const ai = provider();
  const o = await consult(p, BODY(p), ai, { goTrueChecksSession: false });
  assert.deepEqual([o.status, o.code], [200, 'ok'], 'if nothing else checks the session, the consult goes through');
  assert.equal(ai.calls, 1);
  const guard = await sql(withClaims(p.login, `select m2_fixture.guard_probe('${p.login.user}'::uuid, 'x_autopost')`));
  assert.equal(guard, 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'F5\'s T13 guard refuses the same person (session gone)');
});

test_('GAP: a freeze that has not committed is invisible to the read, while the T13 guard waits for it (busy); after the commit the read refuses', async () => {
  const p = await person('freeze');
  const holder = new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', `begin; set local role service_role; select public.begin_service_deletion('${p.login.user}'::uuid, 'x_autopost'); select pg_sleep(5); commit;`],
    env: psqlEnv(), clearEnv: true, stdout: 'piped', stderr: 'piped',
  }).spawn();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(await entitled(p.login), 'active', 'the uncommitted freeze is not visible to a plain read');
  const started = Date.now();
  const guard = await sql(withClaims(p.login, `select m2_fixture.guard_probe('${p.login.user}'::uuid, 'x_autopost')`));
  assert.equal(guard, 'ACCOUNT_LIFECYCLE_BUSY', 'the T13 guard waits for the freeze and answers busy');
  assert.ok(Date.now() - started >= 2500, 'after about the 3 s lock timeout');
  await holder.output();
  assert.notEqual(await entitled(p.login), 'active', 'after the commit the read refuses');
});

test_('RECHECK: a change after the first read is caught by the second read; the provider is not called. A change after the second read is not (the in-flight limit)', async () => {
  const p = await person('recheck');
  const caught = provider();
  const o = await consult(p, BODY(p), caught, { recheck: 'rls' }, () => setEntitlement(p.login.user, 'ended'));
  assert.deepEqual([o.status, o.code], [403, 'CONSULT_NOT_ENTITLED']);
  assert.equal(caught.calls, 0);
  const q2 = await person('recheck2');
  const viaF5 = provider();
  const o2 = await consult(q2, BODY(q2), viaF5, { recheck: 'f5_state' }, () => setAccount(q2.login.user, 'locked'));
  assert.deepEqual([o2.status, o2.code], [403, 'CONSULT_NOT_ENTITLED'], 'F5\'s service_role state read catches it too');
  assert.equal(viaF5.calls, 0);
  // no recheck at all: the provider is reached for a person who has since ended POSTONA
  const q3 = await person('recheck3');
  const none = provider();
  const o3 = await consult(q3, BODY(q3), none, { recheck: 'none' }, () => setEntitlement(q3.login.user, 'ended'));
  assert.deepEqual([o3.status, o3.code], [200, 'ok']);
  assert.equal(none.calls, 1, 'without a recheck an ended service still reaches the provider');
  // KNOWN LIMIT: the state changes after the second read, during the (mock) provider call
  const q4 = await person('limit');
  const inflight = provider();
  const o4 = await consult(q4, BODY(q4), inflight);
  assert.equal(o4.status, 200);
  await setEntitlement(q4.login.user, 'ended');
  assert.equal(inflight.calls, 1, 'the call was already made; no database lock spans a provider call, so it can only be recorded as it happened');
  const next = provider();
  assert.deepEqual((await consult(q4, BODY(q4), next)).code, 'CONSULT_NOT_ENTITLED');
  assert.equal(next.calls, 0);
});

test_('the two reads and F5\'s own state agree on every state of a lifecycle; the owner rules differ exactly where the live handler is looser', async () => {
  const states: [string, (p: Person) => Promise<void>][] = [
    ['active', () => Promise.resolve()],
    ['ended', (p) => setEntitlement(p.login.user, 'ended')],
    ['suspended', (p) => setEntitlement(p.login.user, 'suspended')],
    ['service deleting', async (p) => { await frozen(p.login.user); }],
    ['account locked', (p) => setAccount(p.login.user, 'locked')],
    ['account deleting', (p) => setAccount(p.login.user, 'deleting')],
  ];
  for (const [label, change] of states) {
    const p = await person('eq');
    await change(p);
    const byRead = (await entitled(p.login)) === 'active';
    const byF5 = (await sql(`select coalesce(private.account_lifecycle_service_state_readonly('${p.login.user}'::uuid, 'x_autopost'), 'active')`)) === 'active';
    assert.equal(byRead, byF5, `${label}: the RLS read and F5's readonly state decide the same`);
  }
  // two owners: the handler asks "is the caller an owner"; F5's rule asks "is there exactly one owner"
  const a = await person('two-a');
  const b = await person('two-b');
  await sql(`insert into public.brand_memberships values (${q(a.workspace)}, '${b.login.user}'::uuid, 'owner')`);
  const ai = provider();
  const aSeen = await consult(a, BODY(a), ai);
  const bSeen = await consult(b, { brand_id: a.workspace, message: 'x' }, ai);
  assert.deepEqual([aSeen.code, bSeen.code], ['ok', 'ok'], 'the live handler accepts either of two owners');
  assert.equal(await sql(`select coalesce(private.account_lifecycle_brand_owner(${q(a.workspace)})::text, 'none')`), 'none', 'F5\'s rule gives no owner');
  assert.equal(await sql(asRole('service_role', {}, `select public.common_account_brand_service_state(${q(a.workspace)}, 'x_autopost')`)), 'WORKSPACE_OWNER_UNKNOWN');
});

test_('service_role is a confused deputy if it trusts a client-supplied brand: F5\'s workspace state answers for ANY brand, so ownership must be proven first', async () => {
  const a = await person('dep-a');
  const b = await person('dep-b');
  await setEntitlement(b.login.user, 'ended');
  const forB = await sql(asRole('service_role', {}, `select public.common_account_brand_service_state(${q(b.workspace)}, 'x_autopost')`));
  assert.equal(forB, 'SERVICE_NOT_ACTIVE', 'a service_role caller learns another person\'s state from a brand id alone');
  // A's request naming B's brand is stopped by the ownership step, before any service_role read
  const ai = provider();
  const o = await consult(a, { brand_id: b.workspace, message: 'x' }, ai, { recheck: 'f5_state' });
  assert.deepEqual([o.status, o.code], [404, 'OWNED_WORKSPACE_NOT_FOUND']);
  assert.ok(!o.steps.includes('recheck'));
  assert.equal(ai.calls, 0);
  const selfCall = await psql(asLogin(a.login, `select public.common_account_brand_service_state(${q(b.workspace)}, 'x_autopost')`));
  assert.ok(denied(selfCall), 'a person\'s own role cannot call it at all');
});

test_('no network, no write: every refusal above left the provider counter at zero and the model made no request', async () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
  const p = await person('end');
  const ai = provider();
  await consult(p, { brand_id: p.workspace, message: 'x', history: [] }, ai, { tokenValid: false });
  await consult(p, { brand_id: 'u_nobody', message: 'x' }, ai);
  assert.equal(ai.calls, 0);
});
