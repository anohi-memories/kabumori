// F5 M1 (first manual X post): the authorization chain of ONE manual X text post, on a local PostgreSQL 17 with fake data.
//
//   person's JWT claims + a live auth.sessions row  ->  authorize (REAL F5 T13 guard, REAL brand-owner rule, G4 DOUBLE, switch)
//     ->  presend (REAL F5 advisory workspace state, fresh G4 / owner / switch reads)  ->  MOCK X transport (a counter)  ->  record  ->  read-back
//
// A PASS here proves F5's side of the contract and the order of the checks. It is NOT a real X post, NOT a verified X identity, NOT a managed
// Auth / PostgREST behaviour and NOT F3's or G4's code: the F3 wrappers are a model, G4 is a double, X is a counter. Every stored result is
// SIMULATED. Needs CAL_E2E=1 and PGHOST / PGPORT / PGUSER / PGDATABASE (common_account_m1_manual_x_publish_run.sh sets them).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const db = Deno.env.get('PGDATABASE') ?? '';
const decoder = new TextDecoder();
if (enabled && !db) throw new Error('PGDATABASE is required');
// no outbound network of any kind in this file: the only "X" is the counter below
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('M1 tests make no network request'); }) as typeof fetch;
void realFetch;

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
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// ---- identities: a person's claims (the PostgREST role / claim settings) and a login session row of the model auth.sessions -------------
type Login = { user: string; session: string };
const asRole = (role: 'authenticated' | 'service_role' | 'anon', claims: { sub?: string; role?: string; session?: string }, statement: string) => {
  const sets = [
    claims.sub ? `set local request.jwt.claim.sub = '${claims.sub}';` : '',
    `set local request.jwt.claim.role = '${claims.role ?? role}';`,
    claims.session ? `set local request.jwt.claim.session_id = '${claims.session}';` : '',
  ].join(' ');
  return `begin; ${sets} set local role ${role}; ${statement}; commit;`;
};
const asLogin = (login: Login, statement: string) => asRole('authenticated', { sub: login.user, session: login.session }, statement);
const asService = (statement: string) => asRole('service_role', {}, statement);
async function newSession(user: string, notAfter: string | null = null): Promise<string> {
  const id = randomUUID();
  await sql(`insert into auth.sessions (id, user_id, not_after) values ('${id}', '${user}', ${notAfter === null ? 'null' : `now() + interval '${notAfter}'`})`);
  return id;
}

type Person = { login: Login; workspace: string; account: string };
/** A POSTONA person: a user workspace with one X account (fixture), x_autopost started, G4 verified for them, a live session. */
async function person(tag: string, options: { x?: boolean; kabumori?: boolean; verified?: boolean } = {}): Promise<Person> {
  const user = randomUUID();
  const workspace = await sql(`select public.fixture_user_with_workspace('${user}'::uuid, ${q(`${tag}_${user.slice(0, 6)}`)})`);
  const account = await sql(`select id from public.social_accounts where brand_id = ${q(workspace)} limit 1`);
  if (options.x !== false) {
    assert.equal(JSON.parse(await sql(asRole('authenticated', { sub: user }, 'select to_jsonb(public.start_x_autopost_service())'))).status, 'active');
  }
  if (options.kabumori) {
    assert.equal(JSON.parse(await sql(asRole('authenticated', { sub: user }, 'select to_jsonb(public.start_kabumori_service())'))).status, 'active');
  }
  if (options.verified !== false) {
    await sql(`insert into m1_fixture.g4_account (social_account_id, verified_user_id, credential_owner_id) values (${q(account)}, '${user}', '${user}')`);
  }
  return { login: { user, session: await newSession(user) }, workspace, account };
}

// ---- the chain (the model of F3's orchestrator; X is a counter) ----------------------------------------------------------------------
type Transport = { calls: number; mode: 'ok' | 'timeout'; post(text: string): Promise<{ kind: 'simulated'; xId: string; effects_performed: false; remote_x_verified: false }> };
function transport(mode: 'ok' | 'timeout' = 'ok'): Transport {
  const t: Transport = {
    calls: 0, mode,
    post(text: string) {
      t.calls += 1;
      if (t.mode === 'timeout') return Promise.reject(new Error('timeout'));
      return Promise.resolve({ kind: 'simulated' as const, xId: `SIM-${sha(text).slice(0, 12)}`, effects_performed: false as const, remote_x_verified: false as const });
    },
  };
  return t;
}
type Json = Record<string, unknown>;
const rpcAsLogin = async (login: Login, call: string) => JSON.parse(await sql(asLogin(login, `select ${call}`))) as Json;
const rpcAsService = async (call: string) => JSON.parse(await sql(asService(`select ${call}`))) as Json;

type Outcome = { stage: 'authorize' | 'presend' | 'sent'; status: string; code?: string; intent?: string; recorded?: Json };
async function manualPost(p: Person, x: Transport, text: string, requestId: string, between?: (stage: 'authorized') => Promise<void>): Promise<Outcome> {
  const auth = await rpcAsLogin(p.login, `m1_fixture.authorize_manual_post(${q(p.account)}, ${q(requestId)}, ${q(sha(text))})`);
  if (auth.status !== 'authorized') return { stage: 'authorize', status: String(auth.status), code: String(auth.code) };
  const intent = String(auth.intent_id);
  if (auth.state && auth.state !== 'authorized') return { stage: 'authorize', status: 'replay', code: String(auth.state), intent };
  if (between) await between('authorized');
  const pre = await rpcAsService(`m1_fixture.presend_check('${intent}'::uuid)`);
  if (pre.status !== 'ok') return { stage: 'presend', status: String(pre.status), code: String(pre.code), intent };
  let recorded: Json;
  try {
    const sent = await x.post(text);
    recorded = await rpcAsService(`m1_fixture.record_result('${intent}'::uuid, 'sent', ${q(sent.xId)})`);
  } catch {
    recorded = await rpcAsService(`m1_fixture.record_result('${intent}'::uuid, 'uncertain', null)`);
  }
  return { stage: 'sent', status: String(recorded.state), intent, recorded };
}
const readBack = (intent: string) => rpcAsService(`m1_fixture.read_back('${intent}'::uuid)`);
const intents = (user: string) => sql(`select count(*) from m1_fixture.intent where user_id = '${user}'::uuid`);
async function refused(o: Outcome, stage: Outcome['stage'], code: string, x: Transport, label: string, user?: string) {
  assert.deepEqual([o.stage, o.status, o.code], [stage, stage === 'authorize' && code === 'ACCOUNT_LIFECYCLE_BUSY' ? 'busy' : 'refused', code], label);
  assert.equal(x.calls, 0, `${label}: the X transport was not called`);
  if (user && stage === 'authorize') assert.equal(await intents(user), '0', `${label}: nothing was stored`);
}

// ---- state changes (the model world; the owner role) ----------------------------------------------------------------------------------
const setEntitlement = async (user: string, status: string): Promise<void> => {
  await sql(`update public.service_entitlements set status = '${status}', ended_at = ${status === 'ended' ? 'now()' : 'null'} where user_id = '${user}'::uuid and service_key = 'x_autopost'`);
};
const setAccount = async (user: string, status: string): Promise<void> => {
  await sql(`update public.common_accounts set status = '${status}' where user_id = '${user}'::uuid`);
};
/** The service-end freeze (public.begin_service_deletion, service_role): the entitlement is 'deleting' and an operation is open. */
const frozen = async (user: string) => JSON.parse(await sql(`begin; set local role service_role; select public.begin_service_deletion('${user}'::uuid, 'x_autopost'); commit`)) as Json;
const test_ = enabled ? test : test.skip;
const TEXT = 'a synthetic first post, no real account';

// =============================================================================================================================================
test_('the whole chain passes only when every boundary passes; the X call is the mock, the result is SIMULATED and read back by another connection', async () => {
  const p = await person('ok');
  const x = transport();
  const o = await manualPost(p, x, TEXT, 'req-1');
  assert.deepEqual([o.stage, o.status], ['sent', 'sent']);
  assert.equal(x.calls, 1);
  const row = await readBack(String(o.intent));
  assert.equal(row.state, 'sent');
  assert.equal(row.simulated, true, 'a stored result is marked simulated');
  assert.match(String(row.simulated_x_id), /^SIM-[0-9a-f]{12}$/u, 'the id is a simulated id, never an X id');
  assert.equal(row.after_freeze, false);
  assert.equal(row.text_sha256, sha(TEXT));
  assert.ok(!('user_id' in row), 'the read-back does not expose the person');
});

test_('T13 refuses every unusable login or lifecycle state with the F5 code and the X transport is never called', async () => {
  const cases: [string, (p: Person) => Promise<void>, string][] = [
    ['an entitlement that ended', (p) => setEntitlement(p.login.user, 'ended'), 'SERVICE_NOT_ACTIVE'],
    ['a suspended entitlement', (p) => setEntitlement(p.login.user, 'suspended'), 'SERVICE_NOT_ACTIVE'],
    ['a service deletion in progress', async (p) => { await frozen(p.login.user); }, 'SERVICE_DELETION_IN_PROGRESS'],
    ['a locked common account', (p) => setAccount(p.login.user, 'locked'), 'ACCOUNT_LOCKED'],
    ['a common account being deleted', (p) => setAccount(p.login.user, 'deleting'), 'ACCOUNT_DELETION_IN_PROGRESS'],
    ['a logged-out session (the row is gone)', (p) => sql(`delete from auth.sessions where id = '${p.login.session}'`).then(() => undefined), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['an expired session', (p) => sql(`update auth.sessions set not_after = now() - interval '1 second' where id = '${p.login.session}'`).then(() => undefined), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['a session of another person', async (p) => {
      const other = randomUUID();
      await sql(`insert into auth.users (id) values ('${other}'::uuid)`);
      await sql(`update auth.sessions set user_id = '${other}'::uuid where id = '${p.login.session}'`);
    }, 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
  ];
  for (const [label, change, code] of cases) {
    const p = await person('t13');
    await change(p);
    const x = transport();
    await refused(await manualPost(p, x, TEXT, `req-${label}`), 'authorize', code, x, label, p.login.user);
  }
});

test_('a person who never started POSTONA (Kabumori only, or nothing) cannot authorize, even with an X workspace and a live session', async () => {
  const kabumoriOnly = await person('kab', { x: false, kabumori: true });
  const x = transport();
  await refused(await manualPost(kabumoriOnly, x, TEXT, 'req-k'), 'authorize', 'SERVICE_NOT_REGISTERED', x, 'Kabumori entitlement is not POSTONA', kabumoriOnly.login.user);
  assert.equal(await sql(`select status from public.service_entitlements where user_id = '${kabumoriOnly.login.user}'::uuid and service_key = 'kabumori'`), 'active', 'the other service is untouched');
});

test_('the caller must be the person: no claims, the anon role, the service role and another subject are refused before anything is read', async () => {
  const p = await person('who');
  const call = `m1_fixture.authorize_manual_post(${q(p.account)}, 'req-who', ${q(sha(TEXT))})`;
  const none = JSON.parse(await sql(asRole('authenticated', {}, `select ${call}`))) as Json;
  assert.deepEqual([none.status, none.code], ['refused', 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'], 'no subject');
  const anon = await psql(asRole('anon', {}, `select ${call}`));
  assert.ok(!anon.ok && /permission denied/u.test(anon.error), 'anon cannot execute the user path');
  const service = await psql(asRole('service_role', {}, `select ${call}`));
  assert.ok(!service.ok && /permission denied/u.test(service.error), 'service_role cannot execute the user path');
  // F5's guard compares the token's subject with the person it is asked about
  const other = randomUUID();
  const probe = await sql(asLogin(p.login, `select m1_fixture.guard_probe('${other}'::uuid, 'x_autopost')`));
  assert.equal(probe, 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'a subject that is not the asked person');
  const wrongRole = await sql(asRole('authenticated', { sub: p.login.user, role: 'anon', session: p.login.session }, `select m1_fixture.guard_probe('${p.login.user}'::uuid, 'x_autopost')`));
  assert.equal(wrongRole, 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'a role claim that is not authenticated');
  const noSession = await sql(asRole('authenticated', { sub: p.login.user }, `select m1_fixture.guard_probe('${p.login.user}'::uuid, 'x_autopost')`));
  assert.equal(noSession, 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'a token without a session id');
  assert.equal(await sql(asLogin(p.login, `select m1_fixture.guard_probe('${p.login.user}'::uuid, 'threads')`)), 'ACCOUNT_LIFECYCLE_SERVICE_INVALID', 'F5 knows two service keys only');
  assert.equal(await intents(p.login.user), '0');
});

test_('another person\'s workspace, an ambiguous owner and a non-user workspace are refused', async () => {
  const a = await person('own-a');
  const b = await person('own-b');
  const x = transport();
  // B tries A's X account
  const stolen = await rpcAsLogin(b.login, `m1_fixture.authorize_manual_post(${q(a.account)}, 'req-steal', ${q(sha(TEXT))})`);
  assert.deepEqual([stolen.status, stolen.code], ['refused', 'NOT_WORKSPACE_OWNER']);
  // two owners: F5's rule gives no owner at all
  await sql(`insert into public.brand_memberships values (${q(a.workspace)}, '${b.login.user}'::uuid, 'owner')`);
  const two = await manualPost(a, x, TEXT, 'req-two');
  assert.deepEqual([two.stage, two.code], ['authorize', 'NOT_WORKSPACE_OWNER']);
  assert.equal(await sql(`select coalesce(private.account_lifecycle_brand_owner(${q(a.workspace)})::text, 'none')`), 'none');
  assert.equal(await sql(`select public.common_account_brand_service_state(${q(a.workspace)}, 'x_autopost')`), 'WORKSPACE_OWNER_UNKNOWN');
  await sql(`delete from public.brand_memberships where brand_id = ${q(a.workspace)} and user_id = '${b.login.user}'::uuid`);
  // a workspace that is not a user workspace (Kabumori / AI Lab kind)
  await sql(`update public.brands set code_profile_key = 'kabumori_ai_lab' where id = ${q(a.workspace)}`);
  const kind = await manualPost(a, x, TEXT, 'req-kind');
  assert.deepEqual([kind.stage, kind.code], ['authorize', 'NOT_WORKSPACE_OWNER']);
  assert.equal(x.calls, 0);
});

test_('G4 and the switch: an unverified X owner, a credential owned by someone else and a disabled switch are refused', async () => {
  const unverified = await person('g4a', { verified: false });
  const mismatch = await person('g4b');
  const disabled = await person('g4c');
  await sql(`update m1_fixture.g4_account set credential_owner_id = '${randomUUID()}'::uuid where social_account_id = ${q(mismatch.account)}`);
  await sql(`update public.social_accounts set publish_enabled = false where id = ${q(disabled.account)}`);
  const x = transport();
  await refused(await manualPost(unverified, x, TEXT, 'r1'), 'authorize', 'CONNECTION_NOT_VERIFIED', x, 'unverified X owner', unverified.login.user);
  await refused(await manualPost(mismatch, x, TEXT, 'r2'), 'authorize', 'CREDENTIAL_OWNER_MISMATCH', x, 'credential owner mismatch', mismatch.login.user);
  await refused(await manualPost(disabled, x, TEXT, 'r3'), 'authorize', 'X_ACCOUNT_PUBLISH_DISABLED', x, 'publish disabled', disabled.login.user);
  // a verification that names another person
  const stolenVerification = await person('g4d');
  await sql(`update m1_fixture.g4_account set verified_user_id = '${randomUUID()}'::uuid where social_account_id = ${q(stolenVerification.account)}`);
  await refused(await manualPost(stolenVerification, x, TEXT, 'r4'), 'authorize', 'CONNECTION_NOT_VERIFIED', x, 'verification for another person', stolenVerification.login.user);
});

test_('RACE: whatever changes after authorize is caught by the pre-send read and the X transport is not called', async () => {
  const cases: [string, (p: Person) => Promise<void>, string][] = [
    ['the service ended', (p) => setEntitlement(p.login.user, 'ended'), 'SERVICE_NOT_ACTIVE'],
    ['the service is being deleted', async (p) => { await frozen(p.login.user); }, 'SERVICE_DELETION_IN_PROGRESS'],
    ['the common account is locked', (p) => setAccount(p.login.user, 'locked'), 'ACCOUNT_LOCKED'],
    ['the common account is being deleted', (p) => setAccount(p.login.user, 'deleting'), 'ACCOUNT_DELETION_IN_PROGRESS'],
    ['G4 withdrew the verification', (p) => sql(`update m1_fixture.g4_account set verified_user_id = null where social_account_id = ${q(p.account)}`).then(() => undefined), 'CONNECTION_NOT_VERIFIED'],
    ['the credential owner changed', (p) => sql(`update m1_fixture.g4_account set credential_owner_id = '${randomUUID()}'::uuid where social_account_id = ${q(p.account)}`).then(() => undefined), 'CREDENTIAL_OWNER_MISMATCH'],
    ['the token was refreshed or reconnected (credential generation)', (p) => sql(`update m1_fixture.g4_account set credential_generation = credential_generation + 1 where social_account_id = ${q(p.account)}`).then(() => undefined), 'CREDENTIAL_CHANGED'],
    ['the switch was turned off', (p) => sql(`update public.social_accounts set publish_enabled = false where id = ${q(p.account)}`).then(() => undefined), 'X_ACCOUNT_PUBLISH_DISABLED'],
    ['the workspace changed owner to someone with no account', async (p) => {
      const heir = randomUUID();
      await sql(`insert into auth.users (id) values ('${heir}'::uuid)`);
      await sql(`update public.brand_memberships set user_id = '${heir}'::uuid where brand_id = ${q(p.workspace)} and role = 'owner'`);
    }, 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'],
    // the new owner is a person whose POSTONA is fully active: only the owner re-check can refuse
    ['the workspace changed owner to another active POSTONA person', async (p) => {
      const heir = await person('heir');
      await sql(`update public.brand_memberships set user_id = '${heir.login.user}'::uuid where brand_id = ${q(p.workspace)} and role = 'owner'`);
    }, 'OWNER_CHANGED'],
  ];
  for (const [label, change, code] of cases) {
    const p = await person('race');
    const x = transport();
    const o = await manualPost(p, x, TEXT, `req-${label}`, () => change(p));
    assert.equal(o.stage, 'presend', label);
    assert.equal(o.status, 'refused', label);
    assert.equal(o.code, code, label);
    assert.equal(x.calls, 0, `${label}: the X transport was not called`);
    const row = await readBack(String(o.intent));
    assert.equal(row.state, 'authorized', `${label}: the intent stays unsent`);
  }
});

test_('a double submit, a replay after the send and an unknown outcome never send twice, and an unknown outcome is not retried', async () => {
  const p = await person('idem');
  const x = transport();
  const first = await manualPost(p, x, TEXT, 'same-request');
  assert.equal(first.status, 'sent');
  const second = await manualPost(p, x, TEXT, 'same-request');
  assert.deepEqual([second.stage, second.status, second.code], ['authorize', 'replay', 'sent'], 'the same request id returns the same intent');
  assert.equal(second.intent, first.intent);
  assert.equal(x.calls, 1, 'one X call for two submissions');
  assert.equal(await intents(p.login.user), '1');
  // direct re-run of presend for a sent intent: refused
  const again = await rpcAsService(`m1_fixture.presend_check('${first.intent}'::uuid)`);
  assert.deepEqual([again.status, again.code], ['refused', 'INTENT_NOT_AUTHORIZED']);
  // a replay of the same request after POSTONA ended is refused by T13 first, not answered from the stored intent
  await setEntitlement(p.login.user, 'ended');
  const afterEnd = await manualPost(p, x, TEXT, 'same-request');
  assert.deepEqual([afterEnd.stage, afterEnd.code], ['authorize', 'SERVICE_NOT_ACTIVE']);
  assert.equal(x.calls, 1);
  await setEntitlement(p.login.user, 'active');
  // recording twice
  const twice = await rpcAsService(`m1_fixture.record_result('${first.intent}'::uuid, 'sent', 'SIM-other')`);
  assert.deepEqual([twice.status, twice.code], ['refused', 'INTENT_NOT_AUTHORIZED'], 'one transition only');
  // an unknown outcome: recorded as uncertain, never re-sent by the same request id
  const q2 = await person('unc');
  const timeout = transport('timeout');
  const unknown = await manualPost(q2, timeout, TEXT, 'unknown-request');
  assert.deepEqual([unknown.stage, unknown.status], ['sent', 'uncertain']);
  const retry = await manualPost(q2, timeout, TEXT, 'unknown-request');
  assert.deepEqual([retry.stage, retry.status, retry.code], ['authorize', 'replay', 'uncertain']);
  assert.equal(timeout.calls, 1, 'an uncertain outcome is not sent again');
  assert.equal((await readBack(String(unknown.intent))).simulated_x_id, null);
});

test_('KNOWN LIMIT: a service that ends after the pre-send read cannot stop the call in flight; the result is recorded as it happened and flagged', async () => {
  const p = await person('limit');
  const x = transport();
  // the pre-send read passes, then the person ends POSTONA while the (mock) X call is in flight
  const auth = await rpcAsLogin(p.login, `m1_fixture.authorize_manual_post(${q(p.account)}, 'req-limit', ${q(sha(TEXT))})`);
  const intent = String(auth.intent_id);
  assert.equal((await rpcAsService(`m1_fixture.presend_check('${intent}'::uuid)`)).status, 'ok');
  await setEntitlement(p.login.user, 'ended');
  const sent = await x.post(TEXT);
  const recorded = await rpcAsService(`m1_fixture.record_result('${intent}'::uuid, 'sent', ${q(sent.xId)})`);
  assert.deepEqual([recorded.status, recorded.state, recorded.after_freeze], ['recorded', 'sent', true]);
  assert.equal(x.calls, 1, 'F5 does not and cannot stop a call that is already in flight (no database lock spans the call to X)');
  // ...but nothing new can be authorized afterwards
  const next = await manualPost(p, x, TEXT, 'req-after');
  assert.deepEqual([next.stage, next.code], ['authorize', 'SERVICE_NOT_ACTIVE']);
  assert.equal(x.calls, 1);
});

test_('T13 is a fence: a freeze that holds the lifecycle rows makes authorize BUSY after about 3 s (retryable, nothing stored), and a later retry passes', async () => {
  const p = await person('busy');
  const holder = new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', `begin; select private.account_lifecycle_lock('${p.login.user}'::uuid, false); select pg_sleep(5); commit;`],
    env: psqlEnv(), clearEnv: true, stdout: 'piped', stderr: 'piped',
  }).spawn();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const x = transport();
  const started = Date.now();
  const o = await manualPost(p, x, TEXT, 'req-busy');
  const took = Date.now() - started;
  await refused(o, 'authorize', 'ACCOUNT_LIFECYCLE_BUSY', x, 'a freeze holding the lifecycle rows', p.login.user);
  assert.ok(took >= 2500 && took < 4800, `the wait is bounded by the 3 s lock timeout (took ${took} ms)`);
  await holder.output();
  const retry = await manualPost(p, x, TEXT, 'req-busy-2');
  assert.equal(retry.status, 'sent');
  assert.equal(x.calls, 1);
});

test_('a freeze that starts after authorize waits for nothing the chain holds: the pre-send read sees it, and the lifecycle rows are ordered with the writer', async () => {
  // authorize holds its locks only to its own COMMIT: a freeze may start at once afterwards and the pre-send read refuses
  const p = await person('order');
  const x = transport();
  const o = await manualPost(p, x, TEXT, 'req-order', async () => { await frozen(p.login.user); });
  assert.deepEqual([o.stage, o.code], ['presend', 'SERVICE_DELETION_IN_PROGRESS']);
  assert.equal(x.calls, 0);
});

test_('who may call what: the guard and the owner rule are owner-only, the workspace state is service_role-only, the model path is split by role', async () => {
  const p = await person('acl');
  const callable = async (role: 'authenticated' | 'service_role' | 'anon', call: string) => (await psql(asRole(role, { sub: p.login.user, session: p.login.session }, `select ${call}`))).ok;
  const guard = `private.account_lifecycle_assert_active_service_write('${p.login.user}'::uuid, 'x_autopost')`;
  const owner = `private.account_lifecycle_brand_owner(${q(p.workspace)})`;
  const refusal = `private.account_lifecycle_service_state_refusal('${p.login.user}'::uuid, 'x_autopost')`;
  const state = `public.common_account_brand_service_state(${q(p.workspace)}, 'x_autopost')`;
  for (const role of ['authenticated', 'service_role', 'anon'] as const) {
    assert.equal(await callable(role, guard), false, `${role} cannot call the T13 guard`);
    assert.equal(await callable(role, owner), false, `${role} cannot call the owner rule`);
    assert.equal(await callable(role, refusal), false, `${role} cannot call the locking state decision`);
  }
  assert.equal(await callable('service_role', state), true, 'service_role reads the workspace state');
  assert.equal(await callable('authenticated', state), false, 'a person\'s token cannot read the workspace state');
  assert.equal(await callable('anon', state), false);
  assert.equal(await callable('authenticated', `m1_fixture.presend_check(gen_random_uuid())`), false, 'a person cannot run the worker path');
  assert.equal(await callable('service_role', `m1_fixture.authorize_manual_post(${q(p.account)}, 'x', ${q(sha('x'))})`), false, 'the worker cannot run the user path');
});

test_('nothing the chain does touches X, Vault, the other service or another person: the mock counted every call and the rows around are unchanged', async () => {
  const mine = await person('iso', { kabumori: true });
  const other = await person('iso-other');
  const snapshot = () => sql(`select md5(concat_ws('|',
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from public.service_entitlements x),
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from public.common_accounts x),
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from vault.secrets x),
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from public.social_accounts x)))`);
  const before = await snapshot();
  const x = transport();
  const o = await manualPost(mine, x, TEXT, 'req-iso');
  assert.equal(o.status, 'sent');
  assert.equal(await snapshot(), before, 'no entitlement, account, Vault secret or X account row changed');
  assert.equal(await intents(other.login.user), '0');
  assert.ok(Number(await sql(`select count(*) from m1_fixture.intent`)) >= 1);
});
