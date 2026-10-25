// G5-39: REAL consumer code against the REAL G5 candidates (see the runner). In one throw-away database: G3's caller() and G4's require_person() /
// require_owner_epoch(), cut from their PR heads, call the installed S2-2 / S2-3 / owner epoch; G3's Edge Auth verifier and G6's transport + port run
// in Deno with fake fetches fed real G5 answers. Each result says what the consumer's code does today; nothing here changes G3 / G4 / G6, and
// nothing is a product PASS (the rest of each product -- tables, Edge wiring, managed Auth -- is not run). Needs CAL_E2E=1 and the runner's env.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, DB, C, X] = ['S36_OWNER', 'S36_DB', 'S36_C', 'S39_X'].map(env);
const decoder = new TextDecoder();
const test_ = enabled ? test : test.skip;

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
type Claims = Record<string, unknown>;
// a call with JSON claims; as the owner (the consumers' functions are owner-owned definers) or as `authenticated` (R1); 'ERROR <message>' if it raised
async function call(claims: Claims | null, expr: string, role: 'owner' | 'authenticated' = 'owner'): Promise<string> {
  const set = claims === null ? '' : `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true);`;
  const r = await run(['-c', `begin; ${set} ${role === 'authenticated' ? 'set local role authenticated;' : ''} select ${expr}; rollback;`]);
  return r.ok ? last(r.out) : `ERROR ${errorOf(r)}`;
}

// ---- the consumers' functions, cut from their files (the text is checked, then created in their own schemas) ---------------------------------
function cut(file: string, header: string): string {
  const text = Deno.readTextFileSync(`${X}/${file}`);
  const a = text.indexOf(header);
  assert.ok(a >= 0 && text.indexOf(header, a + 1) < 0, `${header} occurs once in ${file}`);
  const b = text.indexOf('end $$;', a);
  assert.ok(b > a, `${header}: its end`);
  return text.slice(a, b + 'end $$;'.length);
}
const G3_CALLER = enabled ? cut('g3_001.sql', 'create function postona_x_resv.caller() returns uuid') : '';
const G4_PERSON = enabled ? cut('g4_001.sql', 'create function postona_g4_x_oauth.require_person(p_user uuid) returns text') : '';
const G4_EPOCH = enabled ? cut('g4_001.sql', 'create function postona_g4_x_oauth.require_owner_epoch(p_brand_id text) returns bigint') : '';

// ---- the people -----------------------------------------------------------------------------------------------------------------------------
type Person = { user: string; session: string; ws: string };
const P: Record<string, Person> = {};
const UNKNOWN_SESSION = uid(3998);
async function person(key: string, n: number, kind: 'workspace' | 'login') {
  const user = uid(3900 + n);
  if (kind === 'workspace') await sql(`select public.fixture_user_with_workspace('${user}'::uuid, ${lit(`s39_${n}`)})`);
  else await sql(`select public.fixture_login('${user}'::uuid)`);
  const start = await run(['-c', `begin; select set_config('request.jwt.claim.sub', '${user}', true), set_config('request.jwt.claim.role', 'authenticated', true);
    select to_jsonb(public.start_x_autopost_service())::text; commit;`]);
  assert.ok(start.ok && start.out.includes('"active"'), start.error || start.out);
  const session = uid(3950 + n);
  await sql(`insert into auth.sessions (id, user_id, not_after) values ('${session}', '${user}', null)`);
  P[key] = { user, session, ws: await sql(`select 'u_' || substr(md5('${user}'), 1, 24)`) };
}
const claims = (p: Person, extra: Claims = {}): Claims => ({ sub: p.user, role: 'authenticated', session_id: p.session, is_anonymous: false, ...extra });
const r1 = (c: Claims, brand: string) => call(c, `public.common_account_authorization_verdict('postona', 'x_publish', ${lit(brand)})::text`, 'authenticated');

test_('setup: the G5 candidates in order (D1, S2-3, S2-2, S2-1) and the consumers\' functions, created exactly as cut from their PR heads', async () => {
  for (const name of ['d1', 's23', 's22', 's21']) {
    const r = await run(['-f', `${C}/${name}.sql`]);
    assert.ok(r.ok, `${name}\n${r.error}`);
  }
  assert.match(G3_CALLER, /private\.postona_personal_session\(\) is distinct from 'active'/u, 'G3 caller(): S2-2 first, only exactly active');
  assert.match(G4_PERSON, /private\.postona_personal_workspace_eligibility\(p_user\)/u, 'G4 require_person(): S2-3');
  assert.match(G4_EPOCH, /private\.account_lifecycle_brand_owner_epoch\(p_brand_id\)/u, 'G4 require_owner_epoch(): the brand owner epoch');
  await sql('create schema postona_x_resv; create schema postona_g4_x_oauth');
  for (const fn of [G3_CALLER, G4_PERSON, G4_EPOCH]) {
    const r = await run(['-c', fn]);
    assert.ok(r.ok, r.error);
  }
  await person('A', 1, 'workspace');
  await person('N', 2, 'login');
  await person('L', 3, 'login');
  await sql(`insert into public.brands (id, code_profile_key) values ('legacy_3903', 'company_v1'); insert into public.brand_memberships values ('legacy_3903', '${P.L.user}', 'owner')`);
  await person('SH', 4, 'workspace');
  await sql(`insert into public.brand_memberships values (${lit(P.SH.ws)}, '${P.N.user}', 'member')`);
  await person('E', 5, 'workspace');
  await person('K', 6, 'workspace');
});

test_('G4 require_person() (real, PR #523) on the real S2-2 / S2-3: person, new, legacy, shared, anonymous, missing claim, revoked session', async () => {
  const { A, N, L, SH } = P;
  const rp = (p: Person, c: Claims) => call(c, `postona_g4_x_oauth.require_person('${p.user}'::uuid)`);
  assert.equal(await rp(A, claims(A)), 'own');
  assert.equal(await rp(N, claims(N)), 'absent');
  assert.equal(await rp(L, claims(L)), 'ERROR OWN_WORKSPACE_CONFLICT', 'legacy brand, no own workspace (C4)');
  assert.equal(await rp(SH, claims(SH)), 'ERROR OWN_WORKSPACE_CONFLICT', 'a shared own workspace');
  assert.equal(await rp(A, claims(A, { is_anonymous: true })), 'ERROR SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE');
  assert.equal(await rp(A, { sub: A.user, role: 'authenticated', session_id: A.session }), 'ERROR SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE', 'is_anonymous missing');
  assert.equal(await rp(A, claims(A, { session_id: UNKNOWN_SESSION })), 'ERROR SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE', 'revoked / signed out');
  assert.match(await call(claims(A), `postona_g4_x_oauth.require_owner_epoch(${lit(A.ws)})::text`), /^[1-9][0-9]*$/u);
});

test_('GAP G4-1 (recorded): a stopped service or a locked account still passes G4\'s X sequence (S2-2 + S2-3 + owner epoch); T13 / R1 refuse it', async () => {
  const { E, K } = P;
  const before = await call(claims(E), `postona_g4_x_oauth.require_owner_epoch(${lit(E.ws)})::text`);
  const tokenBefore = JSON.parse(await r1(claims(E), E.ws)).owner_epoch;
  await sql(`update public.service_entitlements set status = 'suspended' where user_id = '${E.user}' and service_key = 'x_autopost'`);
  assert.equal(await call(claims(E), `postona_g4_x_oauth.require_person('${E.user}'::uuid)`), 'own', 'G4: S2-2 active, S2-3 own');
  assert.equal(await call(claims(E), `postona_g4_x_oauth.require_owner_epoch(${lit(E.ws)})::text`), before, 'G4: the owner epoch is unchanged');
  assert.equal(await call(claims(E), `private.account_lifecycle_assert_active_service_write('${E.user}'::uuid, 'x_autopost')`), 'ERROR SERVICE_NOT_ACTIVE', 'T13');
  assert.deepEqual([JSON.parse(await r1(claims(E), E.ws)).decision, JSON.parse(await r1(claims(E), E.ws)).reason], ['deny', 'SERVICE_SUSPENDED'], 'R1');
  // back to active: the brand owner epoch G4 binds cannot tell that the service stopped in between; R1's token carries the lifecycle version too
  await sql(`update public.service_entitlements set status = 'active' where user_id = '${E.user}' and service_key = 'x_autopost'`);
  const after = await call(claims(E), `postona_g4_x_oauth.require_owner_epoch(${lit(E.ws)})::text`);
  const tokenAfter = JSON.parse(await r1(claims(E), E.ws)).owner_epoch;
  console.log(`S39_MEASURE G4 owner epoch ${before} -> ${after}; R1 token ${tokenBefore} -> ${tokenAfter}`);
  assert.equal(after, before, 'G4\'s bound value does not move across a stop / restart');
  assert.notEqual(tokenAfter, tokenBefore, 'R1\'s token (owner epoch AND lifecycle version) does');
  // a locked account
  const lock = await run(['-c', `update public.common_accounts set status = 'locked' where user_id = '${K.user}'`]);
  console.log(`S39_MEASURE lock by a direct update: ${lock.ok ? 'ok' : errorOf(lock)}`);
  if (lock.ok) {
    assert.equal(await call(claims(K), `postona_g4_x_oauth.require_person('${K.user}'::uuid)`), 'own', 'G4: a locked account still passes S2-2 + S2-3');
    assert.equal(await call(claims(K), `private.account_lifecycle_assert_active_service_write('${K.user}'::uuid, 'x_autopost')`), 'ERROR ACCOUNT_LOCKED', 'T13');
  }
});

test_('G3 caller() (real, PR #524) on the real S2-2, with the claims G3\'s Edge sets (is_anonymous hard-coded false) and with the token\'s own claims', async () => {
  const { A } = P;
  const g3 = (c: Claims) => call(c, 'postona_x_resv.caller()::text');
  // G3's Edge (postgres_db.ts:75-77) always sets { sub, role: authenticated, session_id, is_anonymous: false }
  assert.equal(await g3(claims(A)), A.user, 'a person');
  assert.equal(await g3(claims(A, { session_id: UNKNOWN_SESSION })), 'ERROR POSTONA_RESV_AUTH_REQUIRED', 'a revoked session is refused');
  // if the Edge forwarded the verified token's own claim instead, the gate itself would refuse an anonymous or unproven caller
  assert.equal(await g3(claims(A, { is_anonymous: true })), 'ERROR POSTONA_RESV_AUTH_REQUIRED');
  assert.equal(await g3({ sub: A.user, role: 'authenticated', session_id: A.session }), 'ERROR POSTONA_RESV_AUTH_REQUIRED', 'claim missing');
});

test_('GAP G3-1 (recorded): G3\'s Edge Auth verifier (real) passes a user whose Auth answer lacks is_anonymous, or carries it as a string', async () => {
  const mod = await import(`file://${X}/g3_supabase_auth.ts`);
  const verifierFor = (body: Record<string, unknown>) => mod.createSupabaseAuthVerifier({
    supabaseUrl: 'https://example.invalid', anonKey: 'fake-anon-key-not-a-secret',
    fetch: () => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })),
  });
  const base = { id: P.A.user, role: 'authenticated', aud: 'authenticated' };
  assert.equal(await verifierFor({ ...base, is_anonymous: true }).verify('a.b.c'), null, 'the boolean true is refused');
  assert.deepEqual(await verifierFor({ ...base, is_anonymous: false }).verify('a.b.c'), { userId: P.A.user });
  // the gaps: missing, or a non-boolean, is not proof of a person -- yet the database is then told is_anonymous: false (see the previous test)
  assert.deepEqual(await verifierFor(base).verify('a.b.c'), { userId: P.A.user }, 'is_anonymous missing passes');
  assert.deepEqual(await verifierFor({ ...base, is_anonymous: 'true' }).verify('a.b.c'), { userId: P.A.user }, 'is_anonymous "true" (a string) passes');
});

test_('G6 transport + authority port (real, PR #500) fed the REAL R1 answers: allow, the D1 anonymous deny, revoked, another workspace, a stopped service', async () => {
  const { createG5RpcTransport } = await import(`file://${X}/g6/supabase/ai_gateway/g5_rpc_transport.ts`);
  const { createG5AuthorityPort } = await import(`file://${X}/g6/supabase/ai_gateway/authority_port.ts`);
  const { A, E, N } = P;
  await sql(`update public.service_entitlements set status = 'suspended' where user_id = '${E.user}' and service_key = 'x_autopost'`);
  const g6 = async (c: Claims, brand: string) => {
    const body = await call(c, `public.common_account_authorization_verdict('postona', 'consult', ${lit(brand)})::text`, 'authenticated');
    assert.ok(!body.startsWith('ERROR'), body);
    const transport = createG5RpcTransport({ supabaseUrl: 'https://example.invalid', publishableKey: 'fake-publishable-key-0123456789',
      fetch: () => Promise.resolve(new Response(body, { status: 200 })) });
    const port = createG5AuthorityPort({ transport, planAllowlist: new Map([['postona:consult', ['postona:x_autopost']]]) });
    const v = await port.verdict('aaa.bbb.ccc', { app: 'postona', feature: 'consult', brand: { app: 'postona', slug: brand } });
    return `${v.decision}${v.reason ? ':' + v.reason : ''}`;
  };
  const allow = await g6(claims(A), A.ws);
  assert.equal(allow, 'allow', 'a person on their own workspace');
  for (const [label, c, brand, expected] of [
    ['anonymous (D1: G6 KNOWN GAP 1 is now a deny)', claims(A, { is_anonymous: true }), A.ws, 'deny:AUTH_REQUIRED'],
    ['is_anonymous missing', { sub: A.user, role: 'authenticated', session_id: A.session }, A.ws, 'deny:AUTH_REQUIRED'],
    ['revoked session', claims(A, { session_id: UNKNOWN_SESSION }), A.ws, 'deny:SESSION_REVOKED'],
    ['another person\'s workspace', claims(A), N.ws, 'deny:BRAND_ACCESS_DENIED'],
    ['a stopped service', claims(E), E.ws, 'deny:SERVICE_SUSPENDED'],
  ] as Array<[string, Claims, string, string]>) {
    assert.equal(await g6(c, brand), expected, label);
  }
});

test_('the newest rollbacks (S2-3 PR #521, S2-2 PR #525) refuse while the REAL G3 / G4 functions call the gates; the gates stay', async () => {
  const md5 = (fn: string) => sql(`select md5(prosrc) from pg_proc where oid = '${fn}'::regprocedure`);
  const gates = `${await md5('private.postona_personal_session()')}|${await md5('private.postona_personal_workspace_eligibility(uuid)')}`;
  let r = await run(['-f', `${C}/s22_rb.sql`]);
  assert.ok(!r.ok && r.error.includes('S22_ROLLBACK_PRECONDITION_CALLERS'), `S2-2 under G3 caller() / G4 require_person()\n${r.error}`);
  r = await run(['-f', `${C}/s23_rb.sql`]);
  assert.ok(!r.ok && r.error.includes('S23_ROLLBACK_PRECONDITION_CALLERS'), `S2-3 under G4 require_person()\n${r.error}`);
  assert.equal(`${await md5('private.postona_personal_session()')}|${await md5('private.postona_personal_workspace_eligibility(uuid)')}`, gates, 'both gates kept');
});
