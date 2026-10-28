// G5-44: ONE batch of the current POSTONA consumers (G4 X 001-004, G3 X OAuth T13 guard + reservations 001-006, G6 transport + port; pinned
// by the runner) on the G5-42 migration candidate, with the G5-43 alignment check. Each assertion states what the consumer's code does TODAY
// on G5's real gates: an allow, a refusal, or -- labelled GAP -- something that should be refused once its owner's change lands. Nothing
// here changes G3 / G4 / G6; nothing about managed / production; no OAuth exchange, token, Vault, SNS or paid call (local fake rows only).
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, superUser, prefix, MIG, CHECK, C] = ['S44_OWNER', 'PGSUPER', 'S44_PREFIX', 'S44_MIG', 'S44_CHECK', 'S44_CONSUMERS'].map(env);
const decoder = new TextDecoder();
const test_ = enabled ? test : test.skip;
const db = (w: string) => `${prefix}_${w}`;
const INSTALL = `${MIG}/20261028090000_postona_personal_auth_install.sql`;
const ROLLBACK = `${MIG}/ROLLBACK_20261028090000_postona_personal_auth.sql`;
const g4 = (n: string) => `${C}/g4_${n}.sql`;
const g3 = (n: string) => `${C}/g3_${n}.sql`;

type Result = { ok: boolean; out: string; error: string };
async function run(d: string, extra: string[], user = owner, readOnly = false): Promise<Result> {
  const options = `${Deno.env.get('PGOPTIONS') ?? ''}${readOnly ? ' -c default_transaction_read_only=on' : ''}`;
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', d, '-U', user, ...extra], env: { PGOPTIONS: options }, stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
async function sql(d: string, statement: string, user = owner): Promise<string> {
  const r = await run(d, ['-c', statement], user);
  assert.ok(r.ok, `${statement}\n${r.error}`);
  return r.out;
}
const answer = (r: Result) => r.ok ? `OK ${r.out.split('\n').pop() ?? ''}` : `ERROR ${(r.error.match(/ERROR:\s+(.*)/u)?.[1] ?? r.error).trim()}`;
// ACL entries sorted: a rollback that re-grants may store the same entries in another order
const catalog = (d: string) => sql(d, `select coalesce(string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce((select string_agg(a, ',' order by a) from unnest(p.proacl::text[]) a), '-')
  || ':' || p.proowner::regrole::text || ':' || p.provolatile::text || p.prosecdef::text || p.proisstrict::text || p.proconfig::text, ' ' order by p.oid::regprocedure::text), '')
  || ' | ' || (select string_agg(nspname || ':' || coalesce(array_to_string(nspacl::text[], ','), '-'), ' ' order by nspname) from pg_namespace where nspname !~ '^(pg_|information_schema)')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^(pg_|information_schema)'`, superUser);
const g5Acl = (d: string) => sql(d, `select string_agg(p.oid::regprocedure::text || '=' || coalesce(array_to_string(p.proacl::text[], ','), 'NULL'), ' ' order by p.oid::regprocedure::text)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'private' and (p.proname like 'account\\_lifecycle\\_%' or p.proname like 'postona\\_personal\\_%'))
     or p.proname in ('common_account_authorization_verdict', 'common_account_bootstrap_verdict', 'common_account_worker_brand_verdict')`, superUser);
async function check(d: string): Promise<string[]> {
  const r = await run(d, ['-f', CHECK], owner, true);
  assert.ok(r.ok, r.error);
  return r.out.split('\n').filter((l) => l);
}

// people: A = POSTONA x_autopost started, own workspace, X account verified (fake columns), live session; C = workspace + session, no
// service; B = another login (for A -> B -> A on A's workspace owner membership)
const id = (n: number) => `00000000-0000-4000-8000-0000000044${String(n).padStart(2, '0')}`;
const [A, B, Cn] = [id(1), id(2), id(3)];
const [SA, SC] = [id(51), id(53)];
const ws = (u: string) => sql(db('bt'), `select 'u_' || substr(md5('${u}'), 1, 24)`);
type Claims = Record<string, unknown>;
const claims = (u: string, s: string, extra: Claims = {}): Claims => ({ sub: u, role: 'authenticated', session_id: s, is_anonymous: false, ...extra });
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
// one statement as `role` with the verified claims the Edge forwards; `before` runs first as the owner (rolled back with the rest)
async function as(d: string, c: Claims, statement: string, role = 'authenticated', before = '', commit = false): Promise<string> {
  return answer(await run(d, ['-c', `begin; ${before}`, '-c', `select set_config('request.jwt.claims', ${lit(JSON.stringify(c))}, true); set local role ${role};`,
    '-c', statement, '-c', commit ? 'commit;' : 'rollback;']));
}
async function people(d: string) {
  await sql(d, `select public.fixture_user_with_workspace('${A}'::uuid, 's44a'), public.fixture_user_with_workspace('${B}'::uuid, 's44b'),
    public.fixture_user_with_workspace('${Cn}'::uuid, 's44c'); select public.fixture_login(u) from unnest(array['${A}', '${B}', '${Cn}']::uuid[]) u;
    insert into auth.sessions (id, user_id, not_after) values ('${SA}', '${A}', null), ('${SC}', '${Cn}', null)`);
  assert.match(await as(d, claims(A, SA), 'select public.start_x_autopost_service() ->> \'status\'', 'authenticated', '', true), /^OK active$/u);
  // fake "verified X account" columns, read by G3's own TEST DOUBLE of G4's predicate (never G4's implementation)
  await sql(d, `update public.brands set code_profile_key = 'social_mobile_user_v1' where id in ('${await ws(A)}', '${await ws(Cn)}');
    update public.social_accounts set platform = 'x', connection_status = 'identity_verified', verified_at = now(), last_connection_error_code = null
    where brand_id in ('${await ws(A)}', '${await ws(Cn)}')`);
}
const STOP_A = `set local role service_role; select public.begin_service_deletion('${A}'::uuid, 'x_autopost'); reset role;`;
const ABA = (w: string) => `insert into public.brand_memberships (brand_id, user_id, role) values ('${w}', '${B}', 'owner'); delete from public.brand_memberships where brand_id = '${w}' and user_id = '${B}';`;
const hash = (n: number) => n.toString(16).padStart(64, '0');
const BEGIN = (n: number) => `select brand_id || ',' || social_account_id from public.begin_social_mobile_x_oauth_connection('${hash(n)}', 'https://example.test/cb', now() + interval '10 minutes')`;
const CONSUME = (n: number) => `select brand_id || ',' || social_account_id from public.consume_social_mobile_x_oauth_state('${hash(n)}')`;
const PRE: Record<string, string> = {};

test_('install: G5 migration, then G4 X 001-004, G3\'s X OAuth T13 guard and G3 001-006, all by the lifecycle owner -- no grant on a G5 object, the read-only check finds nothing; the T13 guard BEFORE G4 makes G4 refuse', async () => {
  for (const w of ['bt', 'rv', 'ro']) {
    PRE[w] = await catalog(db(w));
    const r = await run(db(w), ['-f', INSTALL]);
    assert.ok(r.ok, `${w}\n${r.error}`);
  }
  const acl = await g5Acl(db('bt'));
  for (const f of [g4('001'), g4('002'), g4('003'), g4('004'), g3('t13'), g3('001'), g3('002'), g3('003'), g3('g4_predicate_test_double'), g3('004'), g3('005'), g3('006')]) {
    const r = await run(db('bt'), ['-f', f]);
    assert.ok(r.ok, `${f}\n${r.error}`);
  }
  assert.equal(await g5Acl(db('bt')), acl, 'no grant on any G5 gate or entry');
  assert.deepEqual(await check(db('bt')), [], 'aligned: every consumer is the lifecycle owner\'s definer');
  for (const f of [g4('001'), g4('002'), g4('003'), g4('004')]) assert.ok((await run(db('rv'), ['-f', f])).ok, f);
  assert.deepEqual(await check(db('rv')), []);
  // the other order: G3's wrapper renames main's bodies, so G4's exact-body precondition refuses (nothing created)
  assert.ok((await run(db('ro'), ['-f', g3('t13')])).ok);
  const before = await catalog(db('ro'));
  assert.equal(answer(await run(db('ro'), ['-f', g4('001')])), 'ERROR G4X_PRECONDITION_BEGIN_BODY');
  assert.equal(await catalog(db('ro')), before);
  // the API role is a NOLOGIN role for the future Edge login role; the TEST WORLD lets the owner act as it
  await sql(db('bt'), `grant postona_resv_api to ${owner} with set true`, superUser);
  await people(db('bt'));
  await people(db('rv'));
});

test_('X OAuth: G4 begin / consume wrapped by G3\'s T13 guard refuse a person without POSTONA, a service being ended, an anonymous or ended session and a moved owner epoch; without the wrapper (G4 alone) the first two pass -- GAP G4-1', async () => {
  const BT = db('bt');
  const wa = await ws(A);
  const sa = await sql(BT, `select 'sa_' || substr(md5('${wa}' || ':x'), 1, 24)`);
  assert.equal(await as(BT, claims(A, SA), BEGIN(1), 'authenticated', '', true), `OK ${wa},${sa}`);
  assert.equal(await as(BT, claims(A, SA), CONSUME(1)), `OK ${wa},${sa}`);
  const refusals: Array<[string, string, string]> = [
    ['no POSTONA service (no common account yet)', await as(BT, claims(Cn, SC), BEGIN(2)), 'ERROR ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'],
    ['service being ended (begin)', await as(BT, claims(A, SA), BEGIN(3), 'authenticated', STOP_A), 'ERROR SERVICE_DELETION_IN_PROGRESS'],
    ['service being ended (consume)', await as(BT, claims(A, SA), CONSUME(1), 'authenticated', STOP_A), 'ERROR SERVICE_DELETION_IN_PROGRESS'],
    ['anonymous', await as(BT, claims(A, SA, { is_anonymous: true }), BEGIN(4)), 'ERROR ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['is_anonymous missing', await as(BT, { sub: A, role: 'authenticated', session_id: SA }, BEGIN(4)), 'ERROR ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    // T13 (G3's wrapper) runs first and answers for the session too
    ['ended session', await as(BT, claims(A, SA), CONSUME(1), 'authenticated', `update auth.sessions set not_after = now() - interval '1 minute' where id = '${SA}';`), 'ERROR ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['A -> B -> A', await as(BT, claims(A, SA), CONSUME(1), 'authenticated', ABA(wa)), 'ERROR OWNER_EPOCH_CHANGED'],
  ];
  for (const [label, got, want] of refusals) assert.equal(got, want, label);
  // G4 alone (rv): the same two requests pass today
  const RV = db('rv');
  assert.match(await as(RV, claims(Cn, SC), BEGIN(5)), /^OK u_/u, 'GAP G4-1: no POSTONA service, X connect begins');
  assert.match(await as(RV, claims(A, SA), BEGIN(6), 'authenticated', STOP_A), /^OK u_/u, 'GAP G4-1: service being ended, X connect begins');
});

test_('G3 reservations through postona_resv_api: create / list / cancel for the person; anonymous, ended session, no service, a service being ended and every other API role refused; A -> B -> A is NOT refused -- GAP (no owner epoch on X reservations yet)', async () => {
  const BT = db('bt');
  const wa = await ws(A);
  const acct = await sql(BT, `select id from public.social_accounts where brand_id = '${wa}' and platform = 'x'`);
  const acctC = await sql(BT, `select id from public.social_accounts where brand_id = '${await ws(Cn)}' and platform = 'x'`);
  const body = 'G5-44 fake reservation';
  const sha = await sql(BT, `select encode(sha256(convert_to(${lit(body)}, 'UTF8')), 'hex')`);
  // one item per batch, each batch at its own hour (G3 refuses two posts in the same slot)
  const items = (hours: number) => JSON.stringify([{ draft_id: 'd1', scheduled_at: new Date(Date.now() + hours * 3600_000).toISOString(), body, consent: { confirmed: true, content_sha256: sha } }]);
  const CREATE = (batch: string, hours = 1) => `select status || '/' || reservation_id from postona_x_resv.create_batch('${acct}', '${batch}', 1, 'manual_exact', null, ${lit(items(hours))}::jsonb)`;
  const created = await as(BT, claims(A, SA), CREATE(id(61)), 'postona_resv_api', '', true);
  assert.match(created, /^OK planned\//u);
  const rid = created.split('/')[1];
  assert.equal(await as(BT, claims(A, SA), `select count(*) from postona_x_resv.list_reservations('${acct}')`, 'postona_resv_api'), 'OK 1');
  const refusals: Array<[string, string, string]> = [
    ['anonymous', await as(BT, claims(A, SA, { is_anonymous: true }), CREATE(id(62)), 'postona_resv_api'), 'ERROR POSTONA_RESV_AUTH_REQUIRED'],
    ['is_anonymous missing', await as(BT, { sub: A, role: 'authenticated', session_id: SA }, CREATE(id(62)), 'postona_resv_api'), 'ERROR POSTONA_RESV_AUTH_REQUIRED'],
    ['ended session', await as(BT, claims(A, SA), CREATE(id(62)), 'postona_resv_api', `update auth.sessions set not_after = now() - interval '1 minute' where id = '${SA}';`), 'ERROR POSTONA_RESV_AUTH_REQUIRED'],
    ['service being ended', await as(BT, claims(A, SA), CREATE(id(62)), 'postona_resv_api', STOP_A), 'ERROR POSTONA_RESV_SERVICE_NOT_ACTIVE'],
    ['no POSTONA service', await as(BT, claims(Cn, SC), `select count(*) from postona_x_resv.list_reservations('${acctC}')`, 'postona_resv_api'), 'ERROR POSTONA_RESV_SERVICE_NOT_ACTIVE'],
    ['another person\'s account', await as(BT, claims(Cn, SC), `select count(*) from postona_x_resv.list_reservations('${acct}')`, 'postona_resv_api'), 'ERROR POSTONA_RESV_ACCOUNT_NOT_FOUND'],
  ];
  for (const [label, got, want] of refusals) assert.equal(got, want, label);
  for (const role of ['authenticated', 'anon', 'service_role']) {
    assert.equal(await as(BT, claims(A, SA), CREATE(id(63)), role), 'ERROR permission denied for schema postona_x_resv', role);
  }
  const aba = await as(BT, claims(A, SA), CREATE(id(64), 5), 'postona_resv_api', ABA(wa));
  assert.match(aba, /^OK planned\//u, `GAP: a reservation is created right after A -> B -> A: ${aba}`);
  assert.match(await as(BT, claims(A, SA), `select status from postona_x_resv.cancel('${rid}', 1)`, 'postona_resv_api', '', true), /^OK cancelled$/u);
});

test_('G6 transport + authority port (real, PR #500) fed the real R1 answers on the migration candidate: allow for the person; anonymous, ended session, no service and a service being ended denied', async () => {
  const BT = db('bt');
  const { createG5RpcTransport } = await import(`file://${C}/g6/supabase/ai_gateway/g5_rpc_transport.ts`);
  const { createG5AuthorityPort } = await import(`file://${C}/g6/supabase/ai_gateway/authority_port.ts`);
  const g6 = async (c: Claims, brand: string, before = '') => {
    const got = await as(BT, c, `select public.common_account_authorization_verdict('postona', 'consult', ${lit(brand)})::text`, 'authenticated', before);
    assert.ok(got.startsWith('OK '), got);
    const transport = createG5RpcTransport({ supabaseUrl: 'https://example.invalid', publishableKey: 'fake-publishable-key-0123456789',
      fetch: () => Promise.resolve(new Response(got.slice(3), { status: 200 })) });
    const port = createG5AuthorityPort({ transport, planAllowlist: new Map([['postona:consult', ['postona:x_autopost']]]) });
    const v = await port.verdict('aaa.bbb.ccc', { app: 'postona', feature: 'consult', brand: { app: 'postona', slug: brand } });
    return `${v.decision}${v.reason ? ':' + v.reason : ''}`;
  };
  const wa = await ws(A);
  assert.equal(await g6(claims(A, SA), wa), 'allow');
  for (const [label, got, want] of [
    ['anonymous', await g6(claims(A, SA, { is_anonymous: true }), wa), 'deny:AUTH_REQUIRED'],
    ['ended session', await g6(claims(A, SA), wa, `update auth.sessions set not_after = now() - interval '1 minute' where id = '${SA}';`), 'deny:SESSION_EXPIRED'],
    ['no POSTONA service (no common account yet)', await g6(claims(Cn, SC), await ws(Cn)), 'deny:ACCOUNT_NOT_FOUND'],
    ['service being ended', await g6(claims(A, SA), wa, STOP_A), 'deny:SERVICE_DELETION_IN_PROGRESS'],
  ]) {
    assert.equal(got, want, label);
  }
});

test_('withdrawal with the batch installed: the G5 rollback refuses (drops nothing) while any consumer calls its gates; after G3 (T13 guard rollback, reservations schema) and G4 (004 -> 001) are withdrawn it returns the exact pre-install catalog', async () => {
  const BT = db('bt');
  const installed = await catalog(BT);
  assert.match(answer(await run(BT, ['-f', ROLLBACK])), /^ERROR BUNDLE_ROLLBACK_CALLERS/u);
  assert.equal(await catalog(BT), installed);
  assert.ok((await run(BT, ['-f', g3('t13_rollback')])).ok, 'G3 T13 guard rollback');
  // G3 001 / 002 ship no rollback file (G3's own business); 001-006 live only in schema postona_x_resv, so the TEST WORLD drops it
  await sql(BT, 'drop schema postona_x_resv cascade');
  await sql(BT, 'delete from postona_g4_x_oauth.state_bindings; delete from postona_g4_x_oauth.connections');
  for (const n of ['004', '003', '002', '001']) {
    const r = await run(BT, ['-f', g4(`${n}_rollback`)]);
    assert.ok(r.ok, `G4 ${n} rollback\n${r.error}`);
  }
  const back = await run(BT, ['-f', ROLLBACK]);
  assert.ok(back.ok, back.error);
  assert.equal(await catalog(BT), PRE.bt);
});
