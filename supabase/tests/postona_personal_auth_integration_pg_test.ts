// G5-36: the G5 personal-auth candidates together (world 21a5cad4 + D1 + S2-3 + S2-2 + S2-1, each from its own PR head, blob checked by the runner)
// and the FAKE consumer call sequences of postona_personal_auth_integration_fake_consumers.sql. A local fact about candidate SQL in one throw-away
// database; nothing about managed / production / GoTrue, and the fakes are not G3's or G4's product code. Needs CAL_E2E=1 and the runner's env.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, superUser, DB, C] = ['S36_OWNER', 'PGSUPER', 'S36_DB', 'S36_C'].map(env);
const decoder = new TextDecoder();
globalThis.fetch = (() => { throw new Error('the G5-36 tests make no network request'); }) as typeof fetch;
const test_ = enabled ? test : test.skip;
const file = (name: string) => `${C}/${name}`;

type Result = { ok: boolean; out: string; error: string };
async function run(extra: string[], user = owner): Promise<Result> {
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-U', user, ...extra], stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
async function sql(statement: string, user = owner): Promise<string> {
  const r = await run(['-c', statement], user);
  assert.ok(r.ok, `${statement}\n${r.error}`);
  return r.out;
}
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const errorOf = (r: Result) => (r.error.match(/ERROR:\s+(.*)/u)?.[1] ?? r.error).trim();
const last = (out: string) => out.split('\n').filter((l) => l !== '').pop() ?? '';
const F = {
  R1: 'public.common_account_authorization_verdict(text,text,text)', R0: 'public.common_account_bootstrap_verdict(text,text)',
  SV: 'private.account_lifecycle_session_verdict()', T13: 'private.account_lifecycle_assert_active_service_write(uuid,text)',
  S23: 'private.postona_personal_workspace_eligibility(uuid)', S22: 'private.postona_personal_session()',
  W1: 'private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)', W2: 'public.common_account_worker_brand_verdict(text,text,bigint,bigint)',
};
const md5 = (fn: string) => sql(`select coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure('${fn}')), 'absent')`);
// the reviewed bodies in the world, and each candidate's, as their files state them (D1: R1 / R0 / SV; S2-3: R0 + predicate; S2-1: T13)
const REVIEWED = { R1: '781b00e342e29b709df967571922d27f', R0: 'e999adeb6cb877b2b3001501d58397a4', SV: '69840800118ab8d66ceabfa81fbc93dd', T13: '08840016794a973225be767952265e79' };
const AFTER = { R1: '7e84d9a2ecc53923d0c7846a4514dfdd', R0: '3e89fcff1a3232ef794cdf0483a75130', SV: 'a5d4d71c532847a8573e86a4bd0c791d', T13: '1f8cd9c764c251f3232c61b7a77ff597',
  S23: 'fa4623601fe2ef6efc38478c9f65105e', S22: 'a5d4d71c532847a8573e86a4bd0c791d' };
const ORDER: Array<[string, string]> = [['D1', 'd1'], ['S2-3', 's23'], ['S2-2', 's22'], ['S2-1', 's21']];
// test-only ABLATION (postona_personal_auth_integration_ablation.py): leave ONE candidate out, so that the matrix below must fail without it
const ABLATE = env('S36_ABLATE');
if (ABLATE === 's21') AFTER.T13 = REVIEWED.T13;
if (ABLATE === 's22') AFTER.S22 = 'absent';
if (ABLATE === 's23') Object.assign(AFTER, { R0: 'f3fb1fb4102b0cbf969145045e079318', S23: 'absent' });
const LOADED = ORDER.filter(([, name]) => name !== ABLATE);

// a call as `authenticated` with JSON claims; commit (a begin that creates the workspace) or roll back. 'ERROR <message>' if it raised.
type Claims = Record<string, unknown>;
async function as(claims: Claims | null, expr: string, commit = false): Promise<string> {
  const set = claims === null ? '' : `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true);`;
  const r = await run(['-c', `begin; ${set} set local role authenticated; select ${expr}; ${commit ? 'commit' : 'rollback'};`]);
  return r.ok ? last(r.out) : `ERROR ${errorOf(r)}`;
}
// the same as the owner (owner-only gates; the worker has no person)
async function asOwner(claims: Claims | null, expr: string): Promise<string> {
  const set = claims === null ? '' : `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true);`;
  const r = await run(['-c', `begin; ${set} select ${expr}; rollback;`]);
  return r.ok ? last(r.out) : `ERROR ${errorOf(r)}`;
}

// ---- the people (fixed ids) ------------------------------------------------------------------------------------------------------------------
type Person = { user: string; session: string; ws: string };
const P: Record<string, Person> = {};
const EXPIRED = uid(3699);
const UNKNOWN_SESSION = uid(3698);
const ws = (user: string) => sql(`select 'u_' || substr(md5('${user}'), 1, 24)`);
async function person(key: string, n: number, kind: 'workspace' | 'login') {
  const user = uid(3600 + n);
  if (kind === 'workspace') await sql(`select public.fixture_user_with_workspace('${user}'::uuid, ${lit(`s36_${n}`)})`);
  else await sql(`select public.fixture_login('${user}'::uuid)`);
  const start = await run(['-c', `begin; select set_config('request.jwt.claim.sub', '${user}', true), set_config('request.jwt.claim.role', 'authenticated', true);
    select to_jsonb(public.start_x_autopost_service())::text; commit;`]);
  assert.ok(start.ok && start.out.includes('"active"'), start.error || start.out);
  const session = uid(3700 + n);
  await sql(`insert into auth.sessions (id, user_id, not_after) values ('${session}', '${user}', null)`);
  P[key] = { user, session, ws: await ws(user) };
}
const claims = (p: Person, extra: Claims = {}): Claims => ({ sub: p.user, role: 'authenticated', session_id: p.session, is_anonymous: false, ...extra });
const missing = (p: Person): Claims => ({ sub: p.user, role: 'authenticated', session_id: p.session });
const keysOf = (answer: string) => Object.keys(JSON.parse(answer)).sort().join(',');
const V1_KEYS = 'decision,entitlements,owner_epoch,reason,scope,session,subject,v';
const r1 = (p: Person, c: Claims, brand = p.ws) => as(c, `public.common_account_authorization_verdict('postona', 'x_publish', ${lit(brand)})::text`);

test_('install order on the reviewed world: D1 -> S2-3 -> S2-2 -> S2-1, each from its PR head, each body as its file states; then the fake consumers', async () => {
  for (const k of ['R1', 'R0', 'SV', 'T13'] as const) assert.equal(await md5(F[k]), REVIEWED[k], `the world's ${k} is the reviewed one`);
  for (const k of ['S23', 'S22'] as const) assert.equal(await md5(F[k]), 'absent');
  for (const [label, name] of LOADED) {
    const r = await run(['-f', file(`${name}.sql`)]);
    assert.ok(r.ok, `${label}\n${r.error}`);
  }
  for (const k of ['R1', 'R0', 'SV', 'T13', 'S23', 'S22'] as const) assert.equal(await md5(F[k]), AFTER[k], `${k} after the four installs`);
  if (ABLATE !== 's22') assert.equal(await md5(F.S22), await md5(F.SV), 'S2-2 and SV share one body');
  const fakes = await run(['-f', env('S36_FAKES')]);
  assert.ok(fakes.ok, fakes.error);
});

test_('privileges: the owner-only gates are reachable by no API role; R0 / R1 by authenticated only; the worker fake by no API role', async () => {
  const can = (role: string, fn: string) => sql(`select has_function_privilege('${role}', '${fn}', 'EXECUTE')::text`);
  for (const fn of [F.SV, F.S22, F.S23, F.T13, F.W1, 'g5fake.worker_send(text,text)']) {
    for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) assert.equal(await can(role, fn), 'false', `${role} -> ${fn}`);
  }
  for (const fn of [F.R0, F.R1]) {
    assert.equal(await can('authenticated', fn), 'true', `authenticated -> ${fn}`);
    assert.equal(await can('anon', fn), 'false', `anon -> ${fn}`);
  }
  for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) {
    assert.equal(await sql(`select pg_has_role('${role}', '${owner}', 'MEMBER')::text`), 'false', `${role} is not a member of the owner`);
  }
  // called directly by an API role, an owner-only gate is refused
  for (const expr of ['private.postona_personal_session()', `private.postona_personal_workspace_eligibility('${uid(1)}'::uuid)`]) {
    const r = await as(null, expr);
    assert.match(r, /permission denied/u, expr);
  }
});

test_('the people', async () => {
  await person('A', 1, 'workspace');   // a person with their own workspace
  await person('Q', 2, 'workspace');   // another person
  await person('N', 3, 'login');       // a new person, no workspace yet
  await person('L', 4, 'login');       // owns a legacy brand, no own workspace (C4)
  await sql(`insert into public.brands (id, code_profile_key) values ('legacy_3604', 'company_v1'); insert into public.brand_memberships values ('legacy_3604', '${P.L.user}', 'owner')`);
  await person('SH', 5, 'workspace');  // their own workspace has another member
  await sql(`insert into public.brand_memberships values (${lit(P.SH.ws)}, '${P.Q.user}', 'member')`);
  await person('E', 6, 'workspace');   // the service will be stopped
  await sql(`insert into auth.sessions (id, user_id, not_after) values ('${EXPIRED}', '${P.A.user}', now() - interval '1 minute')`);
});

test_('the negative matrix through the fake consumers (G4 begin / reconnect / callback, G3 create / cancel / receipt / worker, R1 v1 for G6)', async () => {
  const { A, Q, N, L, SH } = P;
  // ---- the person, normal
  assert.equal(await as(claims(A), 'g5fake.x_begin()'), 'BEGIN_OWN');
  assert.equal(await as(claims(N), 'g5fake.x_begin()', true), 'BEGIN_CREATED', 'the personal workspace is created once');
  assert.equal(await as(claims(N), 'g5fake.x_begin()'), 'BEGIN_OWN', '... and reused after');
  const bound = await as(claims(A), `g5fake.reservation_create(${lit(A.ws)})`);
  assert.match(bound, /^g5oe:\d+:\d+$/u, 'a reservation binds R1\'s owner-epoch token');
  assert.equal(await as(claims(A), `g5fake.x_callback(${lit(A.ws)}, ${lit(bound)})`), 'COMPLETE_OK');
  assert.equal(await as(claims(A), 'g5fake.reservation_cancel()'), 'CANCEL_OK');
  assert.equal(await as(claims(A), 'g5fake.reservation_receipt()'), 'RECEIPT_OK');
  assert.equal(await asOwner(null, `g5fake.worker_send(${lit(A.ws)}, ${lit(bound)})`), 'active');
  const allow = await r1(A, claims(A));
  assert.equal(keysOf(allow), V1_KEYS, 'R1 allow: exactly the 8 v1 keys');
  assert.deepEqual([JSON.parse(allow).decision, JSON.parse(allow).entitlements], ['allow', ['postona:x_autopost']]);

  // ---- not a proven person / not a live session: T13 raises in every writer, S2-2 refuses cancel / receipt, R1 denies with 8 keys
  const cases: Array<[string, Claims, string, string]> = [
    ['anonymous', claims(A, { is_anonymous: true }), 'AUTH_REQUIRED', 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['is_anonymous missing', missing(A), 'AUTH_REQUIRED', 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['revoked / signed-out session', claims(A, { session_id: UNKNOWN_SESSION }), 'SESSION_REVOKED', 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['expired session', claims(A, { session_id: EXPIRED }), 'SESSION_EXPIRED', 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['another person\'s session', claims(A, { session_id: Q.session }), 'SESSION_REVOKED', 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
  ];
  for (const [label, c, gate, t13] of cases) {
    for (const call of ['g5fake.x_begin()', `g5fake.x_reconnect_begin(${lit(A.ws)})`, `g5fake.x_callback(${lit(A.ws)}, ${lit(bound)})`, `g5fake.reservation_create(${lit(A.ws)})`]) {
      assert.equal(await as(c, call), `ERROR ${t13}`, `${label}: ${call} stops at T13`);
    }
    assert.equal(await as(c, 'g5fake.reservation_cancel()'), `S22:${gate}`, `${label}: cancel`);
    assert.equal(await as(c, 'g5fake.reservation_receipt()'), `S22:${gate}`, `${label}: receipt`);
    const deny = await r1(A, c);
    assert.equal(keysOf(deny), V1_KEYS, `${label}: R1 deny keeps the 8 keys`);
    assert.deepEqual([JSON.parse(deny).decision, JSON.parse(deny).reason], ['deny', gate], `${label}: R1`);
    assert.equal(await asOwner(c, 'private.postona_personal_session()'), await asOwner(c, 'private.account_lifecycle_session_verdict()'), `${label}: S2-2 = SV`);
  }

  // ---- the workspace
  const wrong = await as(claims(A), `g5fake.reservation_create(${lit(Q.ws)})`);
  assert.equal(wrong, 'R1:deny:BRAND_ACCESS_DENIED', 'another person\'s workspace');
  assert.equal(await as(claims(L), 'g5fake.x_begin()'), 'R0:deny:OWN_WORKSPACE_CONFLICT', 'legacy brand, no own workspace (C4)');
  assert.equal(await as(claims(SH), 'g5fake.x_begin()'), 'R0:deny:OWN_WORKSPACE_CONFLICT', 'a shared own workspace');
  assert.equal(await asOwner(null, `private.postona_personal_workspace_eligibility('${SH.user}'::uuid)`), 'OWN_WORKSPACE_CONFLICT');
  // RECORDED, not a pass / fail of the design: R1 (unchanged by S2-3) still answers for a shared own workspace as below
  const shR1 = JSON.parse(await r1(SH, claims(SH)));
  console.log(`S36_FINDING R1 for a shared own workspace (an extra member): ${shR1.decision}${shR1.reason ? ' ' + shR1.reason : ''}`);
});

test_('owner epoch A -> B -> A: R1\'s token changes, the bound callback is STALE and the worker refuses the old token; a fresh token works', async () => {
  const { A, Q } = P;
  const bound = await as(claims(A), `g5fake.reservation_create(${lit(A.ws)})`);
  await sql(`update public.brand_memberships set user_id = '${Q.user}' where brand_id = ${lit(A.ws)} and user_id = '${A.user}'`);
  assert.equal(await as(claims(A), `g5fake.reservation_create(${lit(A.ws)})`), 'R1:deny:BRAND_ACCESS_DENIED', 'B owns it: A is refused');
  await sql(`update public.brand_memberships set user_id = '${A.user}' where brand_id = ${lit(A.ws)} and user_id = '${Q.user}'`);
  const fresh = await as(claims(A), `g5fake.reservation_create(${lit(A.ws)})`);
  assert.match(fresh, /^g5oe:\d+:\d+$/u);
  assert.notEqual(fresh, bound, 'the same owner again, but a new owner epoch');
  assert.equal(await as(claims(A), `g5fake.x_callback(${lit(A.ws)}, ${lit(bound)})`), 'STALE_OWNER_EPOCH', 'G4: a callback bound before the change');
  assert.equal(await asOwner(null, `g5fake.worker_send(${lit(A.ws)}, ${lit(bound)})`), 'OWNER_EPOCH_CHANGED', 'G3: the worker with the old token');
  assert.equal(await asOwner(null, `g5fake.worker_send(${lit(A.ws)}, ${lit(fresh)})`), 'active');
  assert.equal(await asOwner(null, `g5fake.worker_send(${lit(A.ws)}, null)`), 'NO_BOUND_EPOCH', 'an old row without a token never sends');
});

test_('the service stops (entitlement no longer active): writers and R1 refuse, the worker refuses; S2-2 cancel / receipt still answer (P-2 PENDING)', async () => {
  const { E } = P;
  const bound = await as(claims(E), `g5fake.reservation_create(${lit(E.ws)})`);
  assert.match(bound, /^g5oe:/u);
  await sql(`update public.service_entitlements set status = 'suspended' where user_id = '${E.user}' and service_key = 'x_autopost'`);
  assert.match(await as(claims(E), 'g5fake.x_begin()'), /^ERROR SERVICE_NOT_ACTIVE$/u, 'T13');
  const deny = JSON.parse(await r1(E, claims(E)));
  assert.deepEqual([deny.decision, deny.reason], ['deny', 'SERVICE_SUSPENDED'], 'R1');
  assert.equal(await asOwner(null, `g5fake.worker_send(${lit(E.ws)}, ${lit(bound)})`), 'SERVICE_NOT_ACTIVE', 'W1');
  // S2-2 answers about the session only, by design: whether a stopped person may cancel / read receipts is the user's P-2
  assert.equal(await as(claims(E), 'g5fake.reservation_cancel()'), 'CANCEL_OK');
});

test_('rollback in reverse order (S2-1, S2-2, S2-3, D1) returns the reviewed world; S2-2 refuses while a consumer names it; reinstall works', async () => {
  // a consumer still names the S2-2 gate: its rollback refuses (S2-3's rollback has no such check: recorded)
  let r = await run(['-f', file('s22_rb.sql')]);
  assert.ok(!r.ok && r.error.includes('S22_ROLLBACK_PRECONDITION_CALLERS'), r.error);
  assert.equal(await sql(`drop schema g5fake cascade`), '');
  for (const [label, name] of [...ORDER].reverse()) {
    r = await run(['-f', file(`${name}_rb.sql`)]);
    assert.ok(r.ok, `rollback ${label}\n${r.error}`);
  }
  for (const k of ['R1', 'R0', 'SV', 'T13'] as const) assert.equal(await md5(F[k]), REVIEWED[k], `${k} back to the reviewed body`);
  for (const k of ['S23', 'S22'] as const) assert.equal(await md5(F[k]), 'absent', `${k} gone`);
  for (const [label, name] of ORDER) {
    r = await run(['-f', file(`${name}.sql`)]);
    assert.ok(r.ok, `reinstall ${label}\n${r.error}`);
  }
  for (const k of ['R1', 'R0', 'SV', 'T13', 'S23', 'S22'] as const) assert.equal(await md5(F[k]), AFTER[k], `${k} re-installed`);
  assert.deepEqual(JSON.parse(await r1(P.A, claims(P.A))).decision, 'allow');
  assert.equal(await asOwner(claims(P.A), 'private.postona_personal_session()'), 'active');
});
