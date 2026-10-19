// G5-01: the POSTONA authorization verdict reference over the REAL common-account chain (F5 P1..P10 + the owner-epoch candidate of PR #303) on a
// local PostgreSQL 17 with fake data. The facts are read by ONE TEST-ONLY statement as the lifecycle owner (one snapshot); production has no such
// read today -- a G5 read RPC is a separate TASK behind a Codex Sol (high) gate (docs/common-account/g5-01-postona-entitlement-auth-boundary.md §6).
// The irreversible action is a counting mock. A PASS is not a managed result, not a wired Edge function and not an approval to apply anything.
// Needs CAL_E2E=1 and PGHOST / PGPORT / PGUSER / PGDATABASE (common_account_g5_01_authz_pg_run.sh sets them).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { type AuthFacts, authorize, guardIrreversible, ownerEpochToken, type Principal, type Scope } from '../candidates/common_account_postona_authz/verdict.ts';

const enabled = Deno.env.get('CAL_E2E') === '1';
const db = Deno.env.get('PGDATABASE') ?? '';
const decoder = new TextDecoder();
if (enabled && !db) throw new Error('PGDATABASE is required');
globalThis.fetch = (() => { throw new Error('the G5-01 tests make no network request'); }) as typeof fetch;

type Psql = { ok: boolean; out: string; error: string };
async function psql(statement: string): Promise<Psql> {
  const env = { PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: Deno.env.get('PGUSER') ?? '', PGDATABASE: db, LC_ALL: 'C' };
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement], env, clearEnv: true, stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
async function sql(statement: string): Promise<string> {
  const r = await psql(statement);
  if (!r.ok) throw new Error(r.error);
  return r.out;
}
const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;
const test_ = enabled ? test : test.skip;
const asUser = (user: string, statement: string) =>
  `begin; set local request.jwt.claim.sub = '${user}'; set local request.jwt.claim.role = 'authenticated'; set local role authenticated; ${statement}; commit`;

/**
 * TEST-ONLY facts read: ONE statement, so the owner, the owner epoch, the account and the entitlement are one snapshot (the owner-epoch caller rule).
 * The person is the JWT subject (principal.userId) and the session is the JWT session id; the request supplies only the brand id.
 */
export const FACTS_SQL = `select json_build_object(
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
let reads = 0;
async function readFacts(p: Principal, s: Scope): Promise<AuthFacts> {
  reads += 1;
  const statement = FACTS_SQL.replaceAll('$1', lit(p.userId)).replaceAll('$2', lit(p.sessionId)).replaceAll('$3', s.brandId === null ? 'null' : lit(s.brandId));
  return JSON.parse(await sql(statement)) as AuthFacts;
}

type Person = { user: string; session: string; brand: string };
async function person(options: { x?: boolean; kabumori?: boolean } = {}): Promise<Person> {
  const user = randomUUID();
  const brand = await sql(`select public.fixture_user_with_workspace('${user}'::uuid, ${lit(`g501_${user.slice(0, 6)}`)})`);
  if (options.x !== false) assert.equal(JSON.parse(await sql(asUser(user, 'select to_jsonb(public.start_x_autopost_service())'))).status, 'active');
  if (options.kabumori) assert.equal(JSON.parse(await sql(asUser(user, 'select to_jsonb(public.start_kabumori_service())'))).status, 'active');
  const session = randomUUID();
  await sql(`insert into auth.sessions (id, user_id, not_after) values ('${session}', '${user}', null)`);
  return { user, session, brand };
}
const principal = (p: Person, session = p.session): Principal => ({ userId: p.user, sessionId: session, role: 'authenticated' });
const scopeOf = (brandId: string | null, feature = 'x_publish'): Scope => ({ app: 'postona', feature, brandId });
const NOW = () => Date.now();
const ask = (p: Person, brandId: string | null = p.brand, feature = 'x_publish', session = p.session) => authorize(scopeOf(brandId, feature), principal(p, session), readFacts, NOW());
const why = async (p: Person, brandId: string | null = p.brand, feature = 'x_publish') => { const v = await ask(p, brandId, feature); return `${v.decision}:${v.reason}`; };
/** F5 P5's own answer for the workspace (service_role), the oracle the verdict's service part must agree with. */
const p5 = (brand: string) => sql(`begin; set local role service_role; select public.common_account_brand_service_state(${lit(brand)}, 'x_autopost'); commit`);

async function send(p: Person, between: () => Promise<void>, recheckSession = p.session) {
  const state = { sends: 0 };
  const s = scopeOf(p.brand);
  const out = await guardIrreversible({
    scope: s, first: await ask(p), prepare: between, recheck: () => authorize(s, principal(p, recheckSession), readFacts, NOW()),
    act: () => { state.sends += 1; return Promise.resolve('accepted (SIMULATED)'); }, nowMs: NOW,
  });
  return { out, sends: state.sends };
}

// =============================================================================================================================================
test_('the owner of an active POSTONA workspace is allowed: the token is the real F5 owner epoch and the real lifecycle_version, read in one statement', async () => {
  const a = await person();
  const v = await ask(a);
  assert.equal(v.decision, 'allow', JSON.stringify(v));
  const epoch = Number(await sql(`select private.account_lifecycle_brand_owner_epoch(${lit(a.brand)})`));
  const lv = Number(await sql(`select lifecycle_version from public.common_accounts where user_id = '${a.user}'`));
  assert.equal(v.owner_epoch, ownerEpochToken(epoch, lv));
  assert.deepEqual(v.entitlements, ['postona:x_autopost']);
  assert.equal(await p5(a.brand), 'active', 'F5 P5 agrees');
  assert.ok(!FACTS_SQL.includes(';'), 'the facts read is one statement');
});

test_('a common ID without POSTONA: a login with no common account, and a Kabumori-only person, are refused (F5 P5 agrees)', async () => {
  const bare = await person({ x: false });
  assert.equal(await why(bare), 'deny:ACCOUNT_NOT_FOUND');
  assert.equal(await p5(bare.brand), 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND');
  const kabumoriOnly = await person({ x: false, kabumori: true });
  assert.equal(await why(kabumoriOnly), 'deny:SERVICE_NOT_REGISTERED');
  assert.equal(await p5(kabumoriOnly.brand), 'SERVICE_NOT_REGISTERED');
});

test_('another person and another brand: B asking for A\'s workspace, an unknown brand and B as A\'s admin are refused; nothing comes from a request body user id', async () => {
  const a = await person();
  const b = await person();
  assert.equal(await why(b, a.brand), 'deny:BRAND_ACCESS_DENIED');
  assert.equal(await why(b, 'u_doesnotexist0000000000000'), 'deny:BRAND_ACCESS_DENIED', 'the same answer as not a member');
  await sql(`insert into public.brand_memberships (brand_id, user_id, role) values (${lit(a.brand)}, '${b.user}', 'admin')`);
  assert.equal(await why(b, a.brand), 'deny:ROLE_NOT_ALLOWED');
  assert.equal((await ask(a)).decision, 'allow', 'A is still the single owner');
  const before = reads;
  assert.equal(await why(a, a.brand, 'kabumori_market_report'), 'deny:FEATURE_NOT_ENABLED');
  assert.equal(reads, before, 'an unknown feature reads nothing');
});

test_('owner A -> B -> A through real membership writes: the F5 epoch moved, the recheck sends 0; an unchanged world sends once', async () => {
  const a = await person();
  const b = await person();
  const plain = await send(a, () => Promise.resolve());
  assert.deepEqual([plain.out.sent, plain.sends], [true, 1]);
  const r = await send(a, async () => {
    await sql(`delete from public.brand_memberships where brand_id = ${lit(a.brand)} and user_id = '${a.user}'`);
    await sql(`insert into public.brand_memberships (brand_id, user_id, role) values (${lit(a.brand)}, '${b.user}', 'owner')`);
    await sql(`delete from public.brand_memberships where brand_id = ${lit(a.brand)} and user_id = '${b.user}'`);
    await sql(`insert into public.brand_memberships (brand_id, user_id, role) values (${lit(a.brand)}, '${a.user}', 'owner')`);
  });
  assert.deepEqual([r.out, r.sends], [{ sent: false, refused: 'AUTH_CHANGED_BEFORE_SEND' }, 0]);
  assert.equal((await ask(a)).decision, 'allow', 'A is the owner again: a NEW verdict is allowed, the old one never');
});

test_('entitlement ABA: x_autopost ended and re-activated between the verdict and the send moves the real lifecycle_version; the recheck sends 0', async () => {
  const a = await person();
  const r = await send(a, async () => {
    await sql(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${a.user}' and service_key = 'x_autopost'`);
    await sql(`update public.service_entitlements set status = 'active', ended_at = null where user_id = '${a.user}' and service_key = 'x_autopost'`);
  });
  assert.deepEqual([r.out, r.sends], [{ sent: false, refused: 'AUTH_CHANGED_BEFORE_SEND' }, 0]);
});

test_('revocation and expiry of the real auth.sessions row, and a new login: refused or a new generation, never a send', async () => {
  const a = await person();
  const signedOut = await send(a, () => sql(`delete from auth.sessions where id = '${a.session}'`).then(() => undefined));
  assert.deepEqual([signedOut.out, signedOut.sends], [{ sent: false, refused: 'RECHECK_SESSION_REVOKED' }, 0]);
  const b = await person();
  await sql(`update auth.sessions set not_after = now() - interval '1 second' where id = '${b.session}'`);
  assert.equal(await why(b), 'deny:SESSION_EXPIRED');
  const c = await person();
  const other = randomUUID();
  await sql(`insert into auth.sessions (id, user_id, not_after) values ('${other}', '${c.user}', null)`);
  const relogin = await send(c, () => Promise.resolve(), other);
  assert.deepEqual([relogin.out, relogin.sends], [{ sent: false, refused: 'AUTH_CHANGED_BEFORE_SEND' }, 0]);
  assert.equal(await why(a, a.brand, 'x_publish'), 'deny:SESSION_REVOKED');
});

test_('owner unknown: a second owner makes the real F5 owner and owner epoch NULL -> unknown; a broken epoch coverage -> unknown; both recover', async () => {
  const a = await person();
  const b = await person();
  await sql(`insert into public.brand_memberships (brand_id, user_id, role) values (${lit(a.brand)}, '${b.user}', 'owner')`);
  assert.equal(await why(a), 'unknown:WORKSPACE_OWNER_UNKNOWN');
  assert.equal(await p5(a.brand), 'WORKSPACE_OWNER_UNKNOWN');
  await sql(`delete from public.brand_memberships where brand_id = ${lit(a.brand)} and user_id = '${b.user}'`);
  assert.equal((await ask(a)).decision, 'allow');
  await sql(`alter table public.brand_memberships disable trigger account_lifecycle_owner_epoch_row`);
  try {
    assert.equal(await why(a), 'unknown:OWNER_EPOCH_UNAVAILABLE');
  } finally {
    await sql(`alter table public.brand_memberships enable trigger account_lifecycle_owner_epoch_row`);
  }
  assert.equal((await ask(a)).decision, 'allow');
});

test_('deletion: the real service-end freeze and the real account deletion (退会) start are refused at once and at the recheck (F5 P5 agrees)', async () => {
  const a = await person();
  const frozen = await send(a, () => sql(`begin; set local role service_role; select public.begin_service_deletion('${a.user}'::uuid, 'x_autopost'); commit`).then(() => undefined));
  assert.deepEqual([frozen.out, frozen.sends], [{ sent: false, refused: 'RECHECK_SERVICE_DELETION_IN_PROGRESS' }, 0]);
  assert.equal(await p5(a.brand), 'SERVICE_DELETION_IN_PROGRESS');
  const b = await person();
  const lv = await sql(`select lifecycle_version from public.common_accounts where user_id = '${b.user}'`);
  const started = JSON.parse(await sql(`begin; set local role service_role; select public.begin_common_account_deletion('${b.user}'::uuid, ${lv}); commit`));
  assert.equal(started.status, 'started', JSON.stringify(started));
  assert.equal(await why(b), 'deny:ACCOUNT_DELETION_IN_PROGRESS');
  assert.equal(await p5(b.brand), 'ACCOUNT_DELETION_IN_PROGRESS');
});

test_('the read this needs is NOT reachable by an API role today: production needs a reviewed G5 read RPC (separate TASK, Sol gate)', async () => {
  const a = await person();
  for (const [role, fn] of [['service_role', `private.account_lifecycle_brand_owner_epoch(${lit(a.brand)})`], ['service_role', `private.account_lifecycle_brand_owner(${lit(a.brand)})`],
    ['authenticated', `public.common_account_brand_service_state(${lit(a.brand)}, 'x_autopost')`], ['anon', `public.common_account_brand_service_state(${lit(a.brand)}, 'x_autopost')`]] as const) {
    const r = await psql(`begin; set local role ${role}; select ${fn}; commit`);
    assert.ok(!r.ok && /permission denied/u.test(r.error), `${role} cannot call ${fn.split('(')[0]}`);
  }
  const r = await psql(`begin; set local role service_role; select status from public.service_entitlements limit 1; commit`);
  assert.ok(!r.ok && /permission denied/u.test(r.error), 'service_role has no direct table access (F5 P1)');
});

test_('no network: the model made no request', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
