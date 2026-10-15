// Phase 9 (F5): POSTONA-first shared sign-in and enrollment, OFFLINE. The REAL enrollment modules of both apps
//
//   POSTONA    apps/social-mobile/src/domain/service-enrollment.ts   (gate: features/service-enrollment/service-enrollment-gate.tsx)
//   Kabumori   src/lib/service-enrollment.ts                         (used by src/lib/auth.ts)
//
// run unmodified, over real fetch, against the two seams of common_account_phase9_seams.ts (a MODEL of GoTrue that
// writes real auth rows, and a PostgREST stand-in) in front of the repository's own SQL (Phase 1-8, plus the Phase 9
// fence in the FENCED database; the NOFENCE database is the same world without it, for the fail-before evidence).
//
// What this proves: the exact answers of the SQL are the ones the apps parse; a POSTONA person never needs a Kabumori
// profile, entitlement or deployment; one login = one common account; services are independent; stale / forged /
// expired credentials reach nothing they should not. What it does NOT prove (managed disposable only): real GoTrue
// behaviour (confirmation e-mails, identity linking settings, rate limits, refresh reuse), the real PostgREST error
// mapping, RLS under the real roles, the React gate (pinned by the apps' own tests).
// Needs CAL_E2E=1, PGHOST / PGPORT / PGUSER / PGDATABASE (fenced) and PGDATABASE_NOFENCE.
import assert from 'node:assert/strict';
import test from 'node:test';

import * as kabumori from '../../src/lib/service-enrollment.ts';
import * as postona from '../../apps/social-mobile/src/domain/service-enrollment.ts';
import { APIKEY, authCall, lit, psql, type Seams, SERVICE_KEY, sql, startSeams } from './common_account_phase9_seams.ts';

const enabled = Deno.env.get('CAL_E2E') === '1';
const FENCED = Deno.env.get('PGDATABASE') ?? '';
const NOFENCE = Deno.env.get('PGDATABASE_NOFENCE') ?? '';
if (enabled && (!FENCED || !NOFENCE)) throw new Error('PGDATABASE and PGDATABASE_NOFENCE are required');

// ---- people (a login, as an app holds it) ---------------------------------------------------------------------------
type Login = { userId: string; email: string; accessToken: string; refreshToken: string; sessionId: string };
let counter = 0;
const nextEmail = (tag: string) => `${tag}-${++counter}-${crypto.randomUUID().slice(0, 8)}@example.test`;
const PASSWORD = 'correct-horse-battery-staple';

function loginOf(body: Record<string, unknown> | null): Login | null {
  if (!body || typeof body.access_token !== 'string') return null;
  const user = body.user as { id: string; email: string };
  const claims = JSON.parse(atob(body.access_token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as { session_id: string };
  return { userId: user.id, email: user.email, accessToken: body.access_token, refreshToken: String(body.refresh_token), sessionId: claims.session_id };
}
async function signUp(seams: Seams, email = nextEmail('p9'), password = PASSWORD) {
  const answer = await authCall(seams, '/signup', { email, password });
  return { ...answer, email, login: loginOf(answer.body) };
}
async function signIn(seams: Seams, email: string, password = PASSWORD) {
  const answer = await authCall(seams, '/token', { email, password }, { query: 'grant_type=password' });
  return { ...answer, login: loginOf(answer.body) };
}
async function refresh(seams: Seams, login: Login) {
  const answer = await authCall(seams, '/token', { refresh_token: login.refreshToken }, { query: 'grant_type=refresh_token' });
  return { ...answer, login: loginOf(answer.body) };
}
const signOut = (seams: Seams, login: Login, scope: 'local' | 'global' = 'local') =>
  authCall(seams, '/logout', undefined, { bearer: login.accessToken, query: `scope=${scope}` });
async function provider(seams: Seams, name: 'apple' | 'google', claims: { sub: string; email?: string; email_verified?: boolean }) {
  const answer = await authCall(seams, '/token', { provider: name, id_token: JSON.stringify(claims) }, { query: 'grant_type=id_token' });
  return { ...answer, login: loginOf(answer.body) };
}

// ---- the apps' own modules, over the seam ----------------------------------------------------------------------------
type Outcome = postona.EnrollmentOutcome;
const noSignal = () => new AbortController().signal;
const postonaTransport = (seams: Seams, accessToken: string) => postona.createSessionBoundTransport({ url: seams.baseUrl, apiKey: APIKEY, accessToken });
const kabumoriTransport = (seams: Seams, accessToken: string) => kabumori.createSessionBoundTransport({ url: seams.baseUrl, apiKey: APIKEY, accessToken });
const startPostona = (seams: Seams, login: Login, accessToken = login.accessToken): Promise<Outcome> =>
  postona.startServiceAutomatically(postonaTransport(seams, accessToken), 'x_autopost', noSignal());
const startKabumori = (seams: Seams, login: Login, accessToken = login.accessToken): Promise<Outcome> =>
  kabumori.startServiceAutomatically(kabumoriTransport(seams, accessToken), 'kabumori', noSignal());
const reactivatePostona = (seams: Seams, login: Login, version: number): Promise<Outcome> =>
  postona.reactivateServiceExplicitly(postonaTransport(seams, login.accessToken), 'x_autopost', version, noSignal());
const reactivateKabumori = (seams: Seams, login: Login, version: number): Promise<Outcome> =>
  kabumori.reactivateServiceExplicitly(kabumoriTransport(seams, login.accessToken), 'kabumori', version, noSignal());
const startCalls = (seams: Seams, fn: string) => seams.hits.filter((h) => h.path.endsWith(`/rpc/${fn}`)).length;

// ---- the database (the person's rows and what must never move) -------------------------------------------------------
const db = (d: string) => ({
  users: async () => Number(await sql('select count(*) from auth.users', d)),
  accounts: async (user: string) => Number(await sql(`select count(*) from public.common_accounts where user_id = ${lit(user)}`, d)),
  entitlements: async (user: string) =>
    await sql(`select coalesce(string_agg(service_key || ':' || status, ',' order by service_key), '') from public.service_entitlements where user_id = ${lit(user)}`, d),
  profile: async (user: string) => Number(await sql(`select count(*) from public.profiles where id = ${lit(user)}`, d)),
  version: async (user: string) => Number(await sql(`select lifecycle_version from public.common_accounts where user_id = ${lit(user)}`, d)),
  workspaces: async (user: string) => Number(await sql(`select count(*) from public.brand_memberships where user_id = ${lit(user)}`, d)),
  /** the entitlement row of one service, byte for byte (and, for Kabumori, its profile root) */
  fingerprint: async (user: string, service: string) => await sql(
    `select md5(coalesce((select to_jsonb(e)::text from public.service_entitlements e where e.user_id = ${lit(user)} and e.service_key = ${lit(service)}), '-')
        || case when ${lit(service)} = 'kabumori' then coalesce((select to_jsonb(p)::text from public.profiles p where p.id = ${lit(user)}), '-') else '' end)`, d),
  svc: async (statement: string) => {
    const r = await psql(`begin; set local role service_role; ${statement}; commit;`, { database: d });
    if (!r.ok) throw new Error(r.err);
    return r.out;
  },
  owner: (statement: string) => sql(statement, d),
});
const F = db(FENCED);
const N = db(NOFENCE);

/** Ends POSTONA the way the orchestrator does (owner lease, X settled, the database reads the footprint back). */
async function endPostona(d: ReturnType<typeof db>, user: string): Promise<void> {
  const begun = JSON.parse(await d.svc(`select to_jsonb(public.begin_service_deletion(${lit(user)}::uuid, 'x_autopost'))`)) as { status: string; operation_id: string };
  assert.equal(begun.status, 'started');
  const claimed = JSON.parse(await d.svc(`select to_jsonb(public.claim_service_deletion(${lit(user)}::uuid, 'x_autopost', ${lit(begun.operation_id)}::uuid))`)) as { status: string; lease: string };
  assert.equal(claimed.status, 'acquired');
  await d.svc(`select public.record_owned_service_deletion_provider_result(${lit(user)}::uuid, 'x_autopost', ${lit(begun.operation_id)}::uuid, ${lit(claimed.lease)}::uuid, 'x', 'done')`);
  const finished = JSON.parse(await d.svc(`select to_jsonb(public.finish_owned_service_deletion(${lit(user)}::uuid, 'x_autopost', ${lit(begun.operation_id)}::uuid, ${lit(claimed.lease)}::uuid))`)) as { status: string };
  assert.equal(finished.status, 'ended');
}

// =====================================================================================================================
test('1 a new person signs up for POSTONA alone: one login, one common account, one active x_autopost entitlement, nothing of Kabumori', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED });
  try {
    const before = await F.users();
    const up = await signUp(seams);
    assert.equal(up.status, 200);
    const login = up.login!;
    assert.equal(await F.users(), before + 1);
    assert.equal(await F.accounts(login.userId), 0, 'signing up creates no common account by itself');
    const outcome = await startPostona(seams, login);
    assert.deepEqual(outcome, { kind: 'ready', started: true, sharedAccountNotice: false });
    assert.equal(await F.accounts(login.userId), 1);
    assert.equal(await F.entitlements(login.userId), 'x_autopost:active');
    assert.equal(await F.profile(login.userId), 0, 'no Kabumori profile is required or created');
    assert.equal(await F.workspaces(login.userId), 0, 'no workspace, social account or credential either');
    assert.equal(await F.users(), before + 1, 'enrollment never touches Auth');
    // no Kabumori RPC was called by POSTONA's enrollment
    assert.equal(startCalls(seams, 'start_kabumori_service') + startCalls(seams, 'ensure_my_profile'), 0);
  } finally {
    await seams.stop();
  }
});

test('2 repeat sign-in, a refreshed token and a second device are the same person; only a new sign-in is a new login', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED });
  try {
    const { login } = await signUp(seams);
    const gate = postona.createEnrollmentGate((context, signal) =>
      postona.startServiceAutomatically(postonaTransport(seams, context.accessToken), 'x_autopost', signal));
    const first = await gate.ensure({ userId: login!.userId, accessToken: login!.accessToken });
    assert.deepEqual(first, { kind: 'ready', started: true, sharedAccountNotice: false });
    // a token refresh keeps the login (same session id): the gate does not ask again
    const refreshed = (await refresh(seams, login!)).login!;
    assert.equal(refreshed.sessionId, login!.sessionId);
    assert.equal(postona.loginSessionIdOf(refreshed.userId, refreshed.accessToken), postona.loginSessionIdOf(login!.userId, login!.accessToken));
    const again = await gate.ensure({ userId: refreshed.userId, accessToken: refreshed.accessToken });
    assert.deepEqual(again, first);
    assert.equal(startCalls(seams, 'start_x_autopost_service'), 1, 'one request for one login, refresh included');
    // a refresh token is single use (rotation)
    assert.equal((await authCall(seams, '/token', { refresh_token: login!.refreshToken }, { query: 'grant_type=refresh_token' })).status, 400);
    // sign out this device, sign in again: a NEW login, decided again by the server, idempotently
    await signOut(seams, refreshed);
    const second = (await signIn(seams, login!.email)).login!;
    assert.notEqual(second.sessionId, login!.sessionId);
    const decided = await gate.ensure({ userId: second.userId, accessToken: second.accessToken });
    assert.deepEqual(decided, { kind: 'ready', started: false, sharedAccountNotice: false });
    // a second device of the same person, concurrently with the first: still one entitlement
    const device = (await signIn(seams, login!.email)).login!;
    assert.deepEqual(await startPostona(seams, device), { kind: 'ready', started: false, sharedAccountNotice: false });
    assert.equal(await F.entitlements(login!.userId), 'x_autopost:active');
    assert.equal(await F.accounts(login!.userId), 1);
  } finally {
    await seams.stop();
  }
});

test('3 an existing Kabumori login adds POSTONA: the same login, no new Auth user, the notice once, Kabumori untouched', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED });
  try {
    const { login } = await signUp(seams);
    assert.deepEqual(await startKabumori(seams, login!), { kind: 'ready', started: true, sharedAccountNotice: false });
    assert.equal(await F.profile(login!.userId), 1, 'Kabumori created its own profile root');
    const users = await F.users();
    const kabumoriBefore = await F.fingerprint(login!.userId, 'kabumori');
    const outcome = await startPostona(seams, login!);
    assert.deepEqual(outcome, { kind: 'ready', started: true, sharedAccountNotice: true });
    assert.equal(await F.users(), users, 'no duplicate Auth user');
    assert.equal(await F.entitlements(login!.userId), 'kabumori:active,x_autopost:active');
    assert.equal(await F.fingerprint(login!.userId, 'kabumori'), kabumoriBefore, 'the Kabumori entitlement row and profile are byte-identical');
    // the notice is for the start only: the next sign-in is quiet
    assert.deepEqual(await startPostona(seams, login!), { kind: 'ready', started: false, sharedAccountNotice: false });
  } finally {
    await seams.stop();
  }
});

test('4 POSTONA first, Kabumori later: the profile root appears only with Kabumori; POSTONA is untouched', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED });
  try {
    const { login } = await signUp(seams);
    await startPostona(seams, login!);
    const postonaBefore = await F.fingerprint(login!.userId, 'x_autopost');
    assert.equal(await F.profile(login!.userId), 0);
    assert.deepEqual(await startKabumori(seams, login!), { kind: 'ready', started: true, sharedAccountNotice: true });
    assert.equal(await F.profile(login!.userId), 1);
    assert.equal(await F.fingerprint(login!.userId, 'x_autopost'), postonaBefore);
    assert.equal(await F.entitlements(login!.userId), 'kabumori:active,x_autopost:active');
  } finally {
    await seams.stop();
  }
});

test('5 sign-up idempotency: the same address twice, concurrently, and in confirmation mode creates one login', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED });
  const confirming = await startSeams({ database: FENCED, autoconfirm: false });
  try {
    const email = nextEmail('dup');
    const before = await F.users();
    const results = await Promise.all(Array.from({ length: 6 }, () => signUp(seams, email)));
    const created = results.filter((r) => r.status === 200 && r.login);
    assert.equal(created.length, 1, 'exactly one sign-up wins');
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body?.error_code === 'user_already_exists'));
    assert.equal(await F.users(), before + 1);
    assert.equal(Number(await F.owner(`select count(*) from auth.identities where user_id = ${lit(created[0].login!.userId)}`)), 1);
    // enrollment of the winner happens once, whoever asks
    const winner = created[0].login!;
    const starts = await Promise.all([startPostona(seams, winner), startPostona(seams, winner), startPostona(seams, winner)]);
    assert.equal(starts.filter((o) => o.kind === 'ready' && o.started).length, 1);
    assert.equal(await F.entitlements(winner.userId), 'x_autopost:active');

    // confirmation mode: a new address gets a user and NO session (nothing to enroll); a repeat gets an obfuscated user and
    // creates nothing
    const fresh = nextEmail('conf');
    const a = await signUp(confirming, fresh);
    assert.equal(a.status, 200);
    assert.equal(a.login, null, 'no session before the address is confirmed');
    const usersAfterFirst = await F.users();
    const b = await signUp(confirming, fresh);
    assert.equal(b.status, 200);
    assert.equal(await F.users(), usersAfterFirst, 'the repeat created nothing');
    assert.equal((await signIn(confirming, fresh)).body?.error_code, 'email_not_confirmed');
    // nothing was enrolled for anyone without a session
    assert.equal(startCalls(confirming, 'start_x_autopost_service'), 0);
  } finally {
    await seams.stop();
    await confirming.stop();
  }
});

test('6 provider identity scoping (model): an account is the Auth user, never the e-mail, the provider or the subject', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED, linking: 'verified_email' });
  const never = await startSeams({ database: FENCED, linking: 'never' });
  try {
    const email = nextEmail('idp');
    const { login } = await signUp(seams, email);
    await startPostona(seams, login!);
    const users = await F.users();
    // the same person with Apple, the same verified address: GoTrue links to the SAME login (model of the default)
    const subject = `apple-${crypto.randomUUID()}`;
    const linked = await provider(seams, 'apple', { sub: subject, email, email_verified: true });
    assert.equal(linked.login!.userId, login!.userId);
    assert.equal(await F.users(), users, 'no second Auth user');
    assert.deepEqual(await startPostona(seams, linked.login!), { kind: 'ready', started: false, sharedAccountNotice: false });
    // the same subject again: the same login (and one identity row)
    const repeat = await provider(seams, 'apple', { sub: subject, email, email_verified: true });
    assert.equal(repeat.login!.userId, login!.userId);
    assert.equal(Number(await F.owner(`select count(*) from auth.identities where provider = 'apple' and provider_id = ${lit(subject)}`)), 1);
    // a DIFFERENT address (Apple private relay) is a different person to GoTrue, hence a different common account:
    // nothing is merged by this system, nothing of the first is visible to the second
    const relay = await provider(seams, 'apple', { sub: `apple-${crypto.randomUUID()}`, email: nextEmail('relay'), email_verified: true });
    assert.notEqual(relay.login!.userId, login!.userId);
    assert.deepEqual(await startPostona(seams, relay.login!), { kind: 'ready', started: true, sharedAccountNotice: false });
    assert.equal(await F.entitlements(relay.login!.userId), 'x_autopost:active');
    assert.equal(await F.accounts(relay.login!.userId), 1);
    assert.equal(await F.accounts(login!.userId), 1);
    // linking OFF: the provider sign-in with an address that already has a login is refused by GoTrue; no user appears
    const other = nextEmail('never');
    await signUp(never, other);
    const usersNever = await F.users();
    const refused = await provider(never, 'google', { sub: `g-${crypto.randomUUID()}`, email: other, email_verified: true });
    assert.equal(refused.status, 422);
    assert.equal(await F.users(), usersNever);
  } finally {
    await seams.stop();
    await never.stop();
  }
});

test('7 expired, forged, missing and stale credentials reach nothing', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED, accessTtlSeconds: 60 });
  try {
    const { login } = await signUp(seams);
    // expired: the PostgREST layer refuses before any SQL; the client treats it as transient and nothing is written
    seams.advance(61);
    await assert.rejects(startPostona(seams, login!), postona.EnrollmentUnavailableError);
    assert.equal(await F.accounts(login!.userId), 0, 'an expired token created nothing');
    // the refresh restores service (a new access token of the same login)
    const refreshed = (await refresh(seams, login!)).login!;
    assert.deepEqual(await startPostona(seams, refreshed), { kind: 'ready', started: true, sharedAccountNotice: false });
    // forged (another key) and unsigned
    const forged = await seams.mint({ aud: 'authenticated', role: 'authenticated', sub: login!.userId, session_id: login!.sessionId, exp: 9_999_999_999 }, { secret: 'wrong' });
    await assert.rejects(startPostona(seams, login!, forged), postona.EnrollmentUnavailableError);
    // the publishable key alone: the anon role has no EXECUTE
    const anon = await seams.mint({ aud: 'authenticated', role: 'anon', exp: Math.floor(Date.now() / 1000) + 600 });
    await assert.rejects(startPostona(seams, login!, anon), postona.EnrollmentUnavailableError);
    // a valid token of a login that was removed since: a definite answer, nothing is created
    const gone = (await signUp(seams)).login!;
    const removed = await authCall(seams, `/admin/users/${gone.userId}`, undefined, { method: 'DELETE', bearer: SERVICE_KEY, apikey: SERVICE_KEY });
    assert.equal(removed.status, 200);
    assert.deepEqual(await startPostona(seams, gone), { kind: 'blocked', reason: 'ACCOUNT_NOT_FOUND' });
    assert.equal(await F.accounts(gone.userId), 0);
    assert.equal(Number(await F.owner(`select count(*) from public.service_entitlements where user_id = ${lit(gone.userId)}`)), 0);
    // the server answers 401/403 with the SQLSTATE class the apps map
    const statuses = seams.hits.filter((h) => h.path.includes('/rpc/')).map((h) => h.status);
    assert.ok(statuses.includes(401) && statuses.includes(200));
  } finally {
    await seams.stop();
  }
});

test('8 a signed-out device\'s unexpired token may not restart an ended service (fail-before on the world without the fence)', { skip: !enabled }, async () => {
  for (const [label, d] of [['without the fence', N], ['with the fence', F]] as const) {
    const seams = await startSeams({ database: label === 'with the fence' ? FENCED : NOFENCE });
    try {
      const { login } = await signUp(seams);
      await startPostona(seams, login!);
      await endPostona(d, login!.userId);
      const ended = await startPostona(seams, login!);
      assert.equal(ended.kind, 'reenroll_required');
      const version = (ended as { lifecycleVersion: number }).lifecycleVersion;
      // the person signs out; the access token is still inside its lifetime
      const out = await signOut(seams, login!, 'global');
      assert.equal(out.status, 204, JSON.stringify(out));
      assert.equal(Number(await d.owner(`select count(*) from auth.sessions where user_id = ${lit(login!.userId)}`)), 0);
      // the automatic start is idempotent and never restarts: allowed, and says "re-enroll" again
      assert.equal((await startPostona(seams, login!)).kind, 'reenroll_required');
      const restart = await reactivatePostona(seams, login!, version);
      if (label === 'with the fence') {
        assert.deepEqual(restart, { kind: 'blocked', reason: 'ACCOUNT_NOT_FOUND' }, 'the restart needs a live session');
        assert.equal(await d.entitlements(login!.userId), 'x_autopost:ended');
      } else {
        assert.deepEqual(restart, { kind: 'ready', started: true, sharedAccountNotice: false }, `FAIL-BEFORE: ${label} the stale token restarted the service`);
        assert.equal(await d.entitlements(login!.userId), 'x_autopost:active');
      }
    } finally {
      await seams.stop();
    }
  }
});

test('9 an anonymous (guest) session is not enrolled (fail-before on the world without the fence)', { skip: !enabled }, async () => {
  for (const [label, name] of [['without the fence', NOFENCE], ['with the fence', FENCED]] as const) {
    const seams = await startSeams({ database: name });
    try {
      const guest = await sql(`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id::text`, name);
      const session = await sql(`insert into auth.sessions (user_id) values (${lit(guest)}) returning id::text`, name);
      const token = await seams.mint({
        aud: 'authenticated', role: 'authenticated', sub: guest, session_id: session, is_anonymous: true, exp: Math.floor(Date.now() / 1000) + 600,
      });
      const outcome = await startPostona(seams, { userId: guest } as Login, token);
      const rows = await sql(`select count(*) from public.service_entitlements where user_id = ${lit(guest)}`, name);
      if (label === 'with the fence') {
        assert.deepEqual(outcome, { kind: 'blocked', reason: 'ACCOUNT_NOT_FOUND' });
        assert.equal(rows, '0');
      } else {
        assert.equal(outcome.kind, 'ready', `FAIL-BEFORE: ${label} a guest session was enrolled`);
        assert.equal(rows, '1');
      }
    } finally {
      await seams.stop();
    }
  }
});

test('10 user-level isolation: a token acts for its own person only, whatever it sends', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED });
  try {
    const a = (await signUp(seams)).login!;
    const b = (await signUp(seams)).login!;
    await startPostona(seams, a);
    const aBefore = await F.fingerprint(a.userId, 'x_autopost');
    // B's start creates B's rows and changes nothing of A
    assert.deepEqual(await startPostona(seams, b), { kind: 'ready', started: true, sharedAccountNotice: false });
    assert.equal(await F.fingerprint(a.userId, 'x_autopost'), aBefore);
    assert.equal(await F.entitlements(a.userId), 'x_autopost:active');
    assert.equal(await F.entitlements(b.userId), 'x_autopost:active');
    // there is no way to name another person: a user id argument is not part of any exposed signature
    const spoof = await fetch(`${seams.baseUrl}/rest/v1/rpc/start_x_autopost_service`, {
      method: 'POST',
      headers: { apikey: APIKEY, Authorization: `Bearer ${b.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user_id: a.userId }),
    });
    assert.equal(spoof.status, 404, 'the signature has no such parameter (PGRST202)');
    // a service-only function is not even exposed to a person's token
    const internal = await fetch(`${seams.baseUrl}/rest/v1/rpc/begin_service_deletion`, {
      method: 'POST',
      headers: { apikey: APIKEY, Authorization: `Bearer ${b.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user_id: a.userId, p_service_key: 'x_autopost' }),
    });
    assert.equal(internal.status, 404);
    // and even if it were exposed, the database refuses the role
    const direct = await psql(`begin; set local "request.jwt.claims" = '{"sub":"${b.userId}","role":"authenticated"}'; set local role authenticated; select public.begin_service_deletion(${lit(a.userId)}::uuid, 'x_autopost'); commit;`, { database: FENCED });
    assert.equal(direct.ok, false);
    assert.match(direct.err, /permission denied/u);
    assert.equal(await F.entitlements(a.userId), 'x_autopost:active');
  } finally {
    await seams.stop();
  }
});

test('11 lifecycle: suspended and locked refuse; ended needs the person\'s own restart at the version the server named; a version is used once', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED });
  try {
    const { login } = await signUp(seams);
    await startKabumori(seams, login!);
    await startPostona(seams, login!);
    const kabumoriBefore = await F.fingerprint(login!.userId, 'kabumori');

    // suspended (an operator's state): the start and the restart refuse, and Kabumori is unaffected
    await F.owner(`update public.service_entitlements set status = 'suspended' where user_id = ${lit(login!.userId)} and service_key = 'x_autopost'`);
    assert.deepEqual(await startPostona(seams, login!), { kind: 'blocked', reason: 'SERVICE_SUSPENDED' });
    assert.deepEqual(await reactivatePostona(seams, login!, await F.version(login!.userId)), { kind: 'blocked', reason: 'SERVICE_SUSPENDED' });
    assert.deepEqual(await startKabumori(seams, login!), { kind: 'ready', started: false, sharedAccountNotice: false });
    await F.owner(`update public.service_entitlements set status = 'active' where user_id = ${lit(login!.userId)} and service_key = 'x_autopost'`);

    // the whole account locked: both services refuse
    await F.owner(`update public.common_accounts set status = 'locked' where user_id = ${lit(login!.userId)}`);
    assert.deepEqual(await startPostona(seams, login!), { kind: 'blocked', reason: 'ACCOUNT_LOCKED' });
    assert.deepEqual(await startKabumori(seams, login!), { kind: 'blocked', reason: 'ACCOUNT_LOCKED' });
    await F.owner(`update public.common_accounts set status = 'active' where user_id = ${lit(login!.userId)}`);

    // ended by the person: never restarted automatically, restarted by the person's own click at the version named
    await endPostona(F, login!.userId);
    const ended = await startPostona(seams, login!);
    assert.equal(ended.kind, 'reenroll_required');
    const version = (ended as { lifecycleVersion: number }).lifecycleVersion;
    assert.equal(await F.entitlements(login!.userId), 'kabumori:active,x_autopost:ended');
    assert.equal(await F.fingerprint(login!.userId, 'kabumori'), kabumoriBefore, 'ending POSTONA left Kabumori exactly as it was');
    assert.equal(await F.profile(login!.userId), 1);
    assert.equal(await F.users() > 0, true);
    assert.equal((await reactivatePostona(seams, login!, version + 7)).kind, 'reenroll_required', 'a wrong version changes nothing and names the real one');
    assert.equal(await F.entitlements(login!.userId), 'kabumori:active,x_autopost:ended');
    assert.deepEqual(await reactivatePostona(seams, login!, version), { kind: 'ready', started: true, sharedAccountNotice: true });
    // the version was used: the same click again does not restart anything a second time
    const replay = await reactivatePostona(seams, login!, version);
    assert.equal(replay.kind, 'reenroll_required', 'the restart itself moved the version; a replay is "changed"');
    assert.equal(await F.entitlements(login!.userId), 'kabumori:active,x_autopost:active');
    // the other app's explicit restart of an ACTIVE service is a no-op answer, not an error
    assert.deepEqual(await reactivateKabumori(seams, login!, await F.version(login!.userId)), { kind: 'ready', started: false, sharedAccountNotice: false });
  } finally {
    await seams.stop();
  }
});

test('12 the services of one login end and return independently, in both directions, and the login itself stays', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED });
  try {
    const { login, email } = await signUp(seams);
    await startKabumori(seams, login!);
    await startPostona(seams, login!);
    const memberships = await F.workspaces(login!.userId);

    // POSTONA ends: the login, Kabumori and the other brand are untouched; the person can still sign in
    await endPostona(F, login!.userId);
    assert.equal(await F.workspaces(login!.userId), memberships);
    assert.equal(await F.profile(login!.userId), 1);
    assert.equal((await signIn(seams, email)).status, 200, 'the common login survives a POSTONA-only withdrawal');
    assert.deepEqual(await startKabumori(seams, login!), { kind: 'ready', started: false, sharedAccountNotice: false });
    assert.equal((await startPostona(seams, login!)).kind, 'reenroll_required');

    // Kabumori ends (service_role, as its own backend does): POSTONA stays what it was, and needs no profile
    const postonaBefore = await F.fingerprint(login!.userId, 'x_autopost');
    const withdrawn = JSON.parse(await F.svc(`select to_jsonb(public.withdraw_kabumori_service(${lit(login!.userId)}::uuid))`)) as { status: string };
    assert.equal(withdrawn.status, 'ended');
    assert.equal(await F.profile(login!.userId), 0);
    assert.equal(await F.workspaces(login!.userId), memberships);
    assert.equal(await F.entitlements(login!.userId), 'kabumori:ended,x_autopost:ended');
    assert.equal((await signIn(seams, email)).status, 200);
    // restart only POSTONA: Kabumori stays ended (and its profile gone) -- no side effect on the other app
    const version = await F.version(login!.userId);
    assert.deepEqual(await reactivatePostona(seams, login!, version), { kind: 'ready', started: true, sharedAccountNotice: false });
    assert.equal(await F.entitlements(login!.userId), 'kabumori:ended,x_autopost:active');
    assert.equal(await F.profile(login!.userId), 0);
    assert.notEqual(postonaBefore, '');
  } finally {
    await seams.stop();
  }
});

test('13 concurrency: eight first starts of one person, and two restarts of one version, each decide exactly once', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED });
  try {
    const { login } = await signUp(seams);
    const starts = await Promise.all(Array.from({ length: 8 }, () => startPostona(seams, login!)));
    assert.equal(starts.filter((o) => o.kind === 'ready' && o.started).length, 1);
    assert.equal(starts.filter((o) => o.kind === 'ready' && !o.started).length, 7);
    assert.equal(await F.entitlements(login!.userId), 'x_autopost:active');
    assert.equal(await F.accounts(login!.userId), 1);

    await endPostona(F, login!.userId);
    const version = (await startPostona(seams, login!) as { lifecycleVersion: number }).lifecycleVersion;
    const restarts = await Promise.all([reactivatePostona(seams, login!, version), reactivatePostona(seams, login!, version), reactivatePostona(seams, login!, version)]);
    assert.equal(restarts.filter((o) => o.kind === 'ready' && o.started).length, 1, 'exactly one restart');
    assert.ok(restarts.every((o) => o.kind === 'ready' || o.kind === 'reenroll_required'), 'the others are told it changed');
    assert.equal(await F.entitlements(login!.userId), 'x_autopost:active');

    // an end racing a start: the start never resurrects an ended service whichever order the database picks
    const racer = (await signUp(seams)).login!;
    await startPostona(seams, racer);
    const [, afterRace] = await Promise.all([endPostona(F, racer.userId), startPostona(seams, racer)]);
    assert.ok(afterRace.kind === 'ready' || afterRace.kind === 'blocked' || afterRace.kind === 'reenroll_required');
    const finalState = await F.entitlements(racer.userId);
    assert.equal(finalState, 'x_autopost:ended', `the end won, never undone by a start (${finalState})`);
  } finally {
    await seams.stop();
  }
});

test('14 the exposed surface is exactly the five enrollment RPCs with no user argument', { skip: !enabled }, async () => {
  const names = await sql(`select string_agg(p.oid::regprocedure::text, ' | ' order by p.proname) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and (p.proname like 'start\\_%service' or p.proname like 'reactivate\\_%service' or p.proname = 'ensure_my_profile')`, FENCED);
  assert.equal(names, 'ensure_my_profile() | reactivate_kabumori_service(bigint) | reactivate_x_autopost_service(bigint) | start_kabumori_service() | start_x_autopost_service()');
  // nothing of the lifecycle's backend half is callable by a person's role
  const backend = await sql(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
    and has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.proname !~ '^fixture_'
    and p.proname ~ '(deletion|withdraw|lifecycle|entitlement|common_account|provider_)'`, FENCED);
  assert.equal(backend, '', 'nothing of the lifecycle\'s backend half is callable by a person\'s role');
  // the registry of services is data of a reviewed migration: a key outside it is a CHECK violation, not an input
  const registry = await sql(`select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.service_entitlements'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%service_key%'`, FENCED);
  assert.match(registry, /kabumori.*x_autopost|x_autopost.*kabumori/u);
  const unknownKey = await psql(`insert into public.service_entitlements (user_id, service_key, status, source) values (gen_random_uuid(), 'photo_share', 'active', 'self_service')`, { database: FENCED });
  assert.equal(unknownKey.ok, false);
  // a service key outside the registry cannot be started (no wrapper exists; the private function refuses the key)
  const refused = await psql(`select private.account_lifecycle_start_service(gen_random_uuid(), 'something_else')`, { database: FENCED });
  assert.equal(refused.ok, false);
  assert.match(refused.err, /ACCOUNT_LIFECYCLE_SERVICE_INVALID|permission denied/u);
});

test('15 a person who belongs to another brand: enrollment works, nothing of the other brand moves, and the POSTONA end is refused rather than guessed', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED });
  try {
    const { login } = await signUp(seams);
    // another brand of the platform (an internal workspace, as an operator would grant) and a membership in it
    await F.owner(`insert into public.brands (id, code_profile_key) values ('p9_other_brand', 'kabumori_v1') on conflict do nothing;
                   insert into public.brand_memberships (brand_id, user_id, role) values ('p9_other_brand', ${lit(login!.userId)}, 'member') on conflict do nothing`);
    const membership = await F.owner(`select md5(to_jsonb(m)::text) from public.brand_memberships m where m.brand_id = 'p9_other_brand' and m.user_id = ${lit(login!.userId)}`);
    const brand = await F.owner(`select md5(to_jsonb(b)::text) from public.brands b where b.id = 'p9_other_brand'`);
    // the person is a member of a brand that is not a POSTONA self-service workspace; POSTONA enrollment is unaffected
    assert.deepEqual(await startPostona(seams, login!), { kind: 'ready', started: true, sharedAccountNotice: false });
    assert.equal(await F.owner(`select md5(to_jsonb(m)::text) from public.brand_memberships m where m.brand_id = 'p9_other_brand' and m.user_id = ${lit(login!.userId)}`), membership);
    assert.equal(await F.owner(`select md5(to_jsonb(b)::text) from public.brands b where b.id = 'p9_other_brand'`), brand);
    // the self-service end is NOT offered to such a person: the lifecycle names the reason and changes nothing
    const refused = JSON.parse(await F.svc(`select to_jsonb(public.begin_service_deletion(${lit(login!.userId)}::uuid, 'x_autopost'))`)) as { status: string; reason: string };
    assert.deepEqual(refused, { status: 'blocked', reason: 'X_WORKSPACE_NOT_SELF_SERVICE' });
    assert.equal(await F.entitlements(login!.userId), 'x_autopost:active');
    assert.equal(await F.owner(`select md5(to_jsonb(m)::text) from public.brand_memberships m where m.brand_id = 'p9_other_brand' and m.user_id = ${lit(login!.userId)}`), membership);
    // and the person keeps signing in and enrolling idempotently
    assert.deepEqual(await startPostona(seams, (await signIn(seams, login!.email)).login!), { kind: 'ready', started: false, sharedAccountNotice: false });
  } finally {
    await seams.stop();
  }
});

test('16 a person\'s role cannot write the common tables or make itself a Kabumori user; the lifecycle objects are not even readable', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: FENCED });
  try {
    const { login } = await signUp(seams);
    await startPostona(seams, login!);
    const as = (statement: string) => psql(
      `begin; set local "request.jwt.claims" = '${JSON.stringify({ sub: login!.userId, role: 'authenticated', session_id: login!.sessionId })}'; set local role authenticated; ${statement}; commit;`,
      { database: FENCED });
    // what a person may read is its own status, in granted columns only (RLS: own rows; no source / evidence columns)
    const other = (await signUp(seams)).login!;
    await startPostona(seams, other);
    const seen = await as(`select * from public.service_entitlements`);
    assert.equal(seen.ok, false, 'a table-wide read needs columns that were never granted');
    const mine = await psql(
      `begin; set local "request.jwt.claims" = '${JSON.stringify({ sub: login!.userId, role: 'authenticated', session_id: login!.sessionId })}'; set local role authenticated; `
      + `select string_agg(user_id::text || ':' || service_key || ':' || status, ',') from public.service_entitlements; commit;`, { database: FENCED });
    assert.equal(mine.out, `${login!.userId}:x_autopost:active`, 'only the person\'s own row is visible');
    for (const statement of [
      'select source from public.service_entitlements',
      'select legacy_evidence from public.service_entitlements',
      `insert into public.service_entitlements (user_id, service_key, status, source) values ('${login!.userId}', 'kabumori', 'active', 'self_service')`,
      `update public.service_entitlements set status = 'active' where user_id = '${login!.userId}'`,
      `update public.common_accounts set status = 'active' where user_id = '${login!.userId}'`,
      `delete from public.service_entitlements where user_id = '${login!.userId}'`,
      'select * from private.account_lifecycle_operations',
      `select private.account_lifecycle_start_service('${login!.userId}'::uuid, 'kabumori')`,
    ]) {
      const result = await as(statement);
      assert.equal(result.ok, false, `refused: ${statement}`);
      assert.match(result.err, /permission denied/u, statement);
    }
    // a Kabumori profile root cannot be created by a person who never started Kabumori (the root fence of Phase 4)
    const stray = await as(`insert into public.profiles (id) values ('${login!.userId}')`);
    assert.equal(stray.ok, false, 'a stray profile insert is refused');
    assert.equal(await F.profile(login!.userId), 0);
    assert.equal(await F.entitlements(login!.userId), 'x_autopost:active');
  } finally {
    await seams.stop();
  }
});
