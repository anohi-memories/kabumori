// G5-33 (S2-3): the personal-workspace eligibility predicate and R0 calling it. Two databases from the runner, both with D1 (PR #494) applied:
// S23 gets the candidate, REV keeps R0 as D1 leaves it. The same fixed ids in both, so R0's answers (hashed session refs included) compare byte
// for byte. A local fact about the candidate SQL; nothing about managed / production. Needs CAL_E2E=1 and the runner's environment.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, superUser, S23, REV] = ['S33_OWNER', 'PGSUPER', 'S33_DB', 'S33_REV'].map(env);
const decoder = new TextDecoder();
globalThis.fetch = (() => { throw new Error('the G5-33 tests make no network request'); }) as typeof fetch;
const test_ = enabled ? test : test.skip;

const R0 = 'public.common_account_bootstrap_verdict(text,text)';
const PRED = 'private.postona_personal_workspace_eligibility(uuid)';
// the checksums as the candidate states them
const candidateText = enabled ? Deno.readTextFileSync(env('S33_CANDIDATE')) : '';
const MD5_D1 = candidateText.match(/if v_md5 is distinct from '([0-9a-f]{32})' then\s+raise exception 'S23_PRECONDITION_R0_BODY_NOT_REVIEWED'/u)?.[1] ?? '';
const MD5_S23 = candidateText.match(/if v_md5 = '([0-9a-f]{32})' then\s+raise exception 'S23_ALREADY_APPLIED'/u)?.[1] ?? '';
const MD5_PRED = candidateText.match(/is distinct from '([0-9a-f]{32})' then\s+raise exception 'S23_POSTCONDITION_PREDICATE_BODY'/u)?.[1] ?? '';
if (enabled) assert.ok([MD5_D1, MD5_S23, MD5_PRED].every((m) => m.length === 32), 'the candidate states the three checksums');

type Result = { ok: boolean; out: string; error: string };
const args = (db: string, user: string, extra: string[]) => ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-U', user, ...extra];
async function run(db: string, extra: string[], user = owner): Promise<Result> {
  const out = await new Deno.Command('psql', { args: args(db, user, extra), stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
async function sql(db: string, statement: string, user = owner): Promise<string> {
  const r = await run(db, ['-c', statement], user);
  assert.ok(r.ok, `${statement}\n${r.error}`);
  return r.out;
}
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const md5 = (db: string, fn: string) => sql(db, `select md5(prosrc) from pg_proc where oid = '${fn}'::regprocedure`);
const exists = (db: string, fn: string) => sql(db, `select (to_regprocedure('${fn}') is not null)::text`);
// every attribute but the body (G5-28 / G5-29 / G5-31 baseline), with the OID, owner and ACL; NULL settings shown as NULL
const shape = (db: string, fn: string) => sql(db, `select p.oid || '|' || coalesce(p.proconfig::text, 'NULL') || '|' || coalesce(array_to_string(p.proacl::text[], ','), 'NULL')
  || '|' || p.proowner::regrole::text || '|' || p.provolatile::text || p.prosecdef::text || p.proisstrict::text || p.proleakproof::text || p.proparallel::text
  || p.prokind::text || p.proretset::text || p.procost::text || p.prorows::text || p.prosupport::text || p.prorettype::regtype::text || p.prolang::text
  || p.pronargdefaults::text || coalesce(p.proargnames::text, '-') || coalesce(p.proargmodes::text, '-') || coalesce(p.protrftypes::text, '-')
  from pg_proc p where p.oid = '${fn}'::regprocedure`);
const derived = (user: string) => sql(REV, `select 'u_' || substr(md5('${user}'), 1, 24)`);
const eligibility = (db: string, user: string) => sql(db, `select private.postona_personal_workspace_eligibility('${user}'::uuid)`);

// R0 as `authenticated` with JSON claims (D1: only the boolean false is not anonymous); the answer text, or ERROR
type Claims = Record<string, unknown> | string;
async function ask(db: string, claims: Claims, feature = 'x_connect_bootstrap'): Promise<string> {
  const raw = typeof claims === 'string' ? claims : JSON.stringify(claims);
  const r = await run(db, ['-c', `begin; select set_config('request.jwt.claims', ${lit(raw)}, true); set local role authenticated;
    select public.common_account_bootstrap_verdict('postona', ${lit(feature)})::text; rollback;`]);
  return r.ok ? r.out.split('\n').filter((l) => l !== '').pop() ?? '' : `ERROR ${r.error}`;
}
const decision = (answer: string) => (JSON.parse(answer) as { decision: string; reason: string | null });

// ---- the world: one person per case, the same ids in both databases --------------------------------------------------------------------------
const OTHER = uid(3300); // another person who owns things
type Case = { name: string; user: string; session: string; setup: (db: string, user: string) => Promise<void>; eligibility: string; changes: boolean };
const login = (db: string, user: string) => sql(db, `select public.fixture_login('${user}'::uuid)`);
const withWorkspace = (db: string, user: string) => sql(db, `select public.fixture_user_with_workspace('${user}'::uuid, ${lit(`s23_${user.slice(-6)}`)})`);
const xService = async (db: string, user: string) => {
  const r = await run(db, ['-c', `begin; select set_config('request.jwt.claim.sub', '${user}', true), set_config('request.jwt.claim.role', 'authenticated', true);
    select to_jsonb(public.start_x_autopost_service())::text; commit;`]);
  assert.ok(r.ok && r.out.includes('"active"'), r.error || r.out);
};
const brand = (db: string, id: string, members: Array<[string, string]>, kind = 'social_mobile_user_v1') =>
  sql(db, `insert into public.brands (id, code_profile_key) values (${lit(id)}, ${lit(kind)});
    ${members.map(([u, role]) => `insert into public.brand_memberships values (${lit(id)}, '${u}', ${lit(role)});`).join(' ')}`);
const own = async (db: string, user: string, members: Array<[string, string]>, kind?: string) => brand(db, await derived(user), members, kind);

const CASES: Case[] = [
  { name: 'C0 no workspace yet', user: uid(3301), session: uid(3401), eligibility: 'absent', changes: false,
    setup: async (db, u) => { await login(db, u); await xService(db, u); } },
  { name: 'C1 the own workspace, alone', user: uid(3302), session: uid(3402), eligibility: 'own', changes: false,
    setup: async (db, u) => { await withWorkspace(db, u); await xService(db, u); } },
  { name: 'C2 the own id with another kind', user: uid(3303), session: uid(3403), eligibility: 'OWN_WORKSPACE_CONFLICT', changes: false,
    setup: async (db, u) => { await login(db, u); await xService(db, u); await own(db, u, [[u, 'owner']], 'company_v1'); } },
  { name: 'C3 the own id owned by someone else', user: uid(3304), session: uid(3404), eligibility: 'OWN_WORKSPACE_CONFLICT', changes: false,
    setup: async (db, u) => { await login(db, u); await xService(db, u); await own(db, u, [[OTHER, 'owner']]); } },
  { name: 'C3 only a member of the own id', user: uid(3305), session: uid(3405), eligibility: 'OWN_WORKSPACE_CONFLICT', changes: false,
    setup: async (db, u) => { await login(db, u); await xService(db, u); await own(db, u, [[OTHER, 'owner'], [u, 'member']]); } },
  { name: 'two owners on the own id', user: uid(3306), session: uid(3406), eligibility: 'WORKSPACE_OWNER_UNKNOWN', changes: false,
    setup: async (db, u) => { await login(db, u); await xService(db, u); await own(db, u, [[u, 'owner'], [OTHER, 'owner']]); } },
  { name: 'NEW C4 no own workspace, owns one other brand', user: uid(3307), session: uid(3407), eligibility: 'OWN_WORKSPACE_CONFLICT', changes: true,
    setup: async (db, u) => { await login(db, u); await xService(db, u); await brand(db, 'legacy_3307', [[u, 'owner']], 'company_v1'); } },
  { name: 'NEW C5 the own workspace and another owned brand', user: uid(3308), session: uid(3408), eligibility: 'OWN_WORKSPACE_CONFLICT', changes: true,
    setup: async (db, u) => { await withWorkspace(db, u); await xService(db, u); await brand(db, 'legacy_3308', [[u, 'owner']]); } },
  { name: 'NEW another member on the own workspace', user: uid(3309), session: uid(3409), eligibility: 'OWN_WORKSPACE_CONFLICT', changes: true,
    setup: async (db, u) => { await withWorkspace(db, u); await xService(db, u); await sql(db, `insert into public.brand_memberships values (${lit(await derived(u))}, '${OTHER}', 'member')`); } },
  // a STAND-IN: the fixture's foreign key forbids it, so the superuser inserts with replication-role triggers off (whether the managed tables have
  // that key is NOT_VERIFIED: the POSTONA base tables are created by no migration)
  { name: 'NEW memberships under the own id without its brand row (stand-in)', user: uid(3310), session: uid(3410), eligibility: 'OWN_WORKSPACE_CONFLICT', changes: true,
    setup: async (db, u) => { await login(db, u); await xService(db, u);
      await sql(db, `begin; set local session_replication_role = replica; insert into public.brand_memberships values (${lit(await derived(u))}, '${OTHER}', 'owner'); commit;`, superUser); } },
  // PENDING P-1: membership (not ownership) in someone else's brand is outside the G5-23 §4.1 rule; the answer is recorded, not decided
  { name: 'a member (not owner) of another brand, no own workspace', user: uid(3311), session: uid(3411), eligibility: 'absent', changes: false,
    setup: async (db, u) => { await login(db, u); await xService(db, u); await brand(db, 'team_3311', [[OTHER, 'owner'], [u, 'member']]); } },
  { name: 'no service', user: uid(3312), session: uid(3412), eligibility: 'absent', changes: false,
    setup: async (db, u) => { await login(db, u); } },
];
const EXPIRED = uid(3499);
const UNKNOWN_SESSION = uid(3498);
const person = (c: Case, extra: Record<string, unknown> = {}) => ({ sub: c.user, role: 'authenticated', session_id: c.session, is_anonymous: false, ...extra });

test_('setup and FAIL before: R0 as D1 leaves it (md5 checked) allows C4, C5, a shared own workspace and an orphan membership', async () => {
  for (const db of [S23, REV]) {
    assert.equal(await md5(db, R0), MD5_D1, 'R0 is exactly D1');
    assert.equal(await exists(db, PRED), 'false');
    await sql(db, `select public.fixture_login('${OTHER}'::uuid)`);
    for (const c of CASES) {
      await c.setup(db, c.user);
      await sql(db, `insert into auth.sessions (id, user_id, not_after) values ('${c.session}', '${c.user}', null)`);
    }
    await sql(db, `insert into auth.sessions (id, user_id, not_after) values ('${EXPIRED}', '${CASES[1].user}', now() - interval '1 minute')`);
  }
  for (const c of CASES.filter((x) => x.changes)) {
    const a = decision(await ask(REV, person(c)));
    assert.equal(a.decision, 'allow', `${c.name}: P1 reproduced, D1's R0 allows it`);
  }
});

test_('refused installs leave R0 (D1) untouched and create nothing: superuser, R0 drift, a changed R0 body, a predicate already there, hidden rows, an API role', async () => {
  const cand = env('S33_CANDIDATE');
  const install = (user = owner) => run(REV, ['-f', cand], user);
  const before = await shape(REV, R0);
  const unchanged = async (label: string) => {
    assert.equal(await md5(REV, R0), MD5_D1, `${label}: R0 body`);
    assert.equal(await shape(REV, R0), before, `${label}: R0 shape`);
    assert.equal(await exists(REV, PRED), 'false', `${label}: no predicate`);
  };
  let r = await install(superUser);
  assert.ok(!r.ok && r.error.includes('S23_PRECONDITION_OWNER_IS_SUPERUSER'), r.error);
  await unchanged('superuser');
  const drifts: Array<[string, string, string, string, string]> = [
    ['R0 STRICT', `alter function ${R0} strict`, `alter function ${R0} called on null input`, 'S23_PRECONDITION_R0_SHAPE', owner],
    ['R0 RESET ALL', `alter function ${R0} reset all`, `alter function ${R0} set search_path = '' set row_security = off`, 'S23_PRECONDITION_R0_SHAPE', owner],
    ['R0 granted to anon', `grant execute on function ${R0} to anon`, `revoke execute on function ${R0} from anon`, 'S23_PRECONDITION_R0_SHAPE', owner],
    ['an API role made a member of the owner', `grant ${owner} to authenticator`, `revoke ${owner} from authenticator`, 'S23_PRECONDITION_R0_SHAPE', superUser],
    ['a function already under the predicate name', `create function ${PRED.replace('(uuid)', '(p_user uuid)')} returns text language sql as $$ select 'own' $$`,
      `drop function ${PRED}`, 'S23_PRECONDITION_PREDICATE_EXISTS', owner],
    ['FORCE RLS on brand_memberships', 'alter table public.brand_memberships force row level security', 'alter table public.brand_memberships no force row level security',
      'S23_PRECONDITION_RLS_FORCED', owner],
    ['RLS on, owner neither table owner nor BYPASSRLS', `alter table public.brand_memberships owner to ${superUser}; alter table public.brand_memberships enable row level security;
      grant select on public.brand_memberships to ${owner}`, `alter table public.brand_memberships disable row level security; alter table public.brand_memberships owner to ${owner}`,
      'S23_PRECONDITION_RLS_HIDES_ROWS', superUser],
  ];
  for (const [label, drift, undo, code, as] of drifts) {
    await sql(REV, drift, as);
    r = await install();
    assert.ok(!r.ok && r.error.includes(code), `${label}\n${r.error}`);
    await sql(REV, undo, as);
    assert.equal(await md5(REV, R0), MD5_D1, `${label}: R0 body`);
    assert.equal(await shape(REV, R0), before, `${label}: undone`);
    assert.equal(await exists(REV, PRED), 'false', `${label}: no predicate`);
  }
  // a changed R0 body (D1's plus a comment line) is someone else's change (the body is kept inside the database: psql trims its leading newline)
  const redefine = (expr: string) => `do $d$ begin execute format('create or replace function public.common_account_bootstrap_verdict(p_app text, p_feature text)
    returns jsonb language plpgsql stable security definer set search_path = '''' set row_security = off as %L', ${expr}); end $d$`;
  await sql(REV, `create table public.g533_saved_body as select prosrc as body from pg_proc where oid = '${R0}'::regprocedure`);
  await sql(REV, redefine(`(select body from public.g533_saved_body) || E'\\n-- changed\\n'`));
  r = await install();
  assert.ok(!r.ok && r.error.includes('S23_PRECONDITION_R0_BODY_NOT_REVIEWED'), r.error);
  await sql(REV, redefine('(select body from public.g533_saved_body)'));
  await sql(REV, 'drop table public.g533_saved_body');
  await unchanged('changed body');
  r = await run(REV, ['-f', env('S33_ROLLBACK')]);
  assert.ok(!r.ok && r.error.includes('S23_ROLLBACK_NOT_APPLIED'), r.error);
  await unchanged('rollback where never applied');
});

test_('install: R0 keeps its OID, owner, ACL and every attribute; the predicate is owner-only with the expected shape; nothing else changes; a second run refuses', async () => {
  const others = `select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ',' order by p.oid::regprocedure::text) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private', 'auth')
      and p.oid not in ('${R0}'::regprocedure) and p.proname <> 'postona_personal_workspace_eligibility'`;
  const beforeOthers = await sql(S23, others);
  const before = await shape(S23, R0);
  const r = await run(S23, ['-f', env('S33_CANDIDATE')]);
  assert.ok(r.ok, r.error);
  assert.equal(await md5(S23, R0), MD5_S23);
  assert.equal(await shape(S23, R0), before, 'same OID, owner, ACL, settings and attributes');
  assert.equal(await sql(S23, others), beforeOthers, 'every other function byte-identical');
  assert.equal(await md5(S23, PRED), MD5_PRED);
  assert.equal(await sql(S23, `select array_to_string(proacl::text[], ',') from pg_proc where oid = '${PRED}'::regprocedure`), `${owner}=X/${owner}`);
  assert.equal(await sql(S23, `select (provolatile = 's' and prosecdef and proconfig = array['search_path=""', 'row_security=off'] and not proisstrict
    and prorettype = 'text'::regtype)::text from pg_proc where oid = '${PRED}'::regprocedure`), 'true');
  for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) {
    assert.equal(await sql(S23, `select has_function_privilege('${role}', '${PRED}', 'EXECUTE')::text`), 'false', `${role}: no EXECUTE`);
  }
  const asApi = await run(S23, ['-c', `begin; set local role authenticated; select private.postona_personal_workspace_eligibility('${CASES[0].user}'::uuid); rollback;`]);
  assert.ok(!asApi.ok && /permission denied/u.test(asApi.error), `an API role cannot ask about anyone\n${asApi.error}`);
  const again = await run(S23, ['-f', env('S33_CANDIDATE')]);
  assert.ok(!again.ok && again.error.includes('S23_ALREADY_APPLIED'), again.error);
});

test_('the predicate: each case answers as the G5-23 §4.1 rule says; a NULL user raises; another person\'s state never leaks into the answer', async () => {
  for (const c of CASES) assert.equal(await eligibility(S23, c.user), c.eligibility, c.name);
  // OTHER owns several brands (the C3 / C4-like rows above): their own answer is a conflict, and it changed nobody else's (checked above)
  assert.equal(await eligibility(S23, OTHER), 'OWN_WORKSPACE_CONFLICT', 'the other person: no own workspace, but owns other brands');
  const r = await run(S23, ['-c', 'select private.postona_personal_workspace_eligibility(null)']);
  assert.ok(!r.ok && r.error.includes('POSTONA_PERSONAL_WORKSPACE_USER_REQUIRED'), r.error);
  assert.equal(await eligibility(S23, uid(3397)), 'absent', 'an unknown id is absent (R0 refuses the person before asking: no login)');
});

test_('PASS after: R0 changes ONLY the four new cases (allow -> deny OWN_WORKSPACE_CONFLICT); every other answer is byte-identical to D1', async () => {
  const compared: Array<[string, Claims, string, boolean]> = [];
  for (const c of CASES) compared.push([c.name, person(c), 'x_connect_bootstrap', c.changes]);
  const c1 = CASES[1];
  compared.push(
    ['C1 via Threads', person(c1), 'threads_connect_bootstrap', false],
    ['C4 via Threads', person(CASES[6]), 'threads_connect_bootstrap', true],
    ['anonymous true', person(c1, { is_anonymous: true }), 'x_connect_bootstrap', false],
    ['claim missing', { sub: c1.user, role: 'authenticated', session_id: c1.session }, 'x_connect_bootstrap', false],
    ['C4 anonymous: refused before the workspace', person(CASES[6], { is_anonymous: true }), 'x_connect_bootstrap', false],
    ['C4 claim missing', { sub: CASES[6].user, role: 'authenticated', session_id: CASES[6].session }, 'x_connect_bootstrap', false],
    ['revoked session', person(c1, { session_id: UNKNOWN_SESSION }), 'x_connect_bootstrap', false],
    ['C4 revoked session: refused before the workspace', person(CASES[6], { session_id: UNKNOWN_SESSION }), 'x_connect_bootstrap', false],
    ['expired session', person(c1, { session_id: EXPIRED }), 'x_connect_bootstrap', false],
    ['role anon', person(c1, { role: 'anon' }), 'x_connect_bootstrap', false],
    ['broken claims', '{not json', 'x_connect_bootstrap', false],
    ['another feature', person(c1), 'x_publish', false],
  );
  let changed = 0;
  for (const [label, claims, feature, changes] of compared) {
    const rev = await ask(REV, claims, feature);
    const now = await ask(S23, claims, feature);
    if (!changes) {
      assert.equal(now, rev, `${label}: byte-identical`);
      continue;
    }
    changed += 1;
    assert.equal(decision(rev).decision, 'allow', `${label}: D1 allowed it`);
    const after = JSON.parse(now);
    assert.deepEqual([after.decision, after.reason, after.owner_epoch, after.entitlements, after.session], ['deny', 'OWN_WORKSPACE_CONFLICT', null, [], null], label);
    // the rest of the v1 object is unchanged: the same keys, scope and subject
    const before = JSON.parse(rev);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), `${label}: the same 8 keys`);
    assert.deepEqual([after.v, after.scope, after.subject], [before.v, before.scope, before.subject], `${label}: v / scope / subject`);
  }
  assert.equal(changed, 5, 'four cases (one also via Threads) change; nothing else');
  console.log(`S23_R0_COMPARED ${compared.length} answers, ${changed} changed, ${compared.length - changed} byte-identical`);
});

test_('owner change on the own workspace (A -> B -> A): the predicate follows the live rows; R0 stays begin-only (no owner epoch in any answer)', async () => {
  const c = CASES[1];
  const ws = await derived(c.user);
  assert.equal(await eligibility(S23, c.user), 'own');
  await sql(S23, `update public.brand_memberships set user_id = '${OTHER}' where brand_id = ${lit(ws)} and user_id = '${c.user}'`);
  assert.equal(await eligibility(S23, c.user), 'OWN_WORKSPACE_CONFLICT', 'B owns it');
  assert.equal(decision(await ask(S23, person(c))).reason, 'OWN_WORKSPACE_CONFLICT');
  await sql(S23, `update public.brand_memberships set user_id = '${c.user}' where brand_id = ${lit(ws)} and user_id = '${OTHER}'`);
  assert.equal(await eligibility(S23, c.user), 'own', 'A again');
  const back = JSON.parse(await ask(S23, person(c)));
  assert.deepEqual([back.decision, back.owner_epoch], ['allow', null], 'an R0 allow carries no epoch: the exchange and posts stay behind R1 + W1');
});

test_('the rollback refuses a drift of R0 or of the predicate, and then puts back D1 byte for byte; a second rollback refuses; the candidate re-installs', async () => {
  const rb = env('S33_ROLLBACK');
  const drifts: Array<[string, string, string, string, string]> = [
    ['R0 STRICT', `alter function ${R0} strict`, `alter function ${R0} called on null input`, 'S23_ROLLBACK_PRECONDITION_R0_SHAPE', owner],
    ['R0 RESET ALL', `alter function ${R0} reset all`, `alter function ${R0} set search_path = '' set row_security = off`, 'S23_ROLLBACK_PRECONDITION_R0_SHAPE', owner],
    ['predicate STRICT', `alter function ${PRED} strict`, `alter function ${PRED} called on null input`, 'S23_ROLLBACK_PRECONDITION_PREDICATE_SHAPE', owner],
    ['predicate granted to authenticated', `grant execute on function ${PRED} to authenticated`, `revoke execute on function ${PRED} from authenticated`,
      'S23_ROLLBACK_PRECONDITION_PREDICATE_SHAPE', owner],
    ['predicate RESET ALL', `alter function ${PRED} reset all`, `alter function ${PRED} set search_path = '' set row_security = off`, 'S23_ROLLBACK_PRECONDITION_PREDICATE_SHAPE', owner],
  ];
  const r0Before = await shape(S23, R0);
  const predBefore = await shape(S23, PRED);
  for (const [label, drift, undo, code, as] of drifts) {
    await sql(S23, drift, as);
    const r = await run(S23, ['-f', rb]);
    assert.ok(!r.ok && r.error.includes(code), `${label}\n${r.error}`);
    assert.equal(await md5(S23, R0), MD5_S23, `${label}: the S2-3 R0 stays`);
    await sql(S23, undo, as);
    assert.equal(`${await shape(S23, R0)}|${await shape(S23, PRED)}`, `${r0Before}|${predBefore}`, `${label}: undone`);
  }
  // a changed predicate body is someone else's change
  await sql(S23, `create table public.g533_saved_pred as select prosrc as body from pg_proc where oid = '${PRED}'::regprocedure`);
  const redefinePred = (expr: string) => `do $d$ begin execute format('create or replace function private.postona_personal_workspace_eligibility(p_user uuid)
    returns text language plpgsql stable security definer set search_path = '''' set row_security = off as %L', ${expr}); end $d$`;
  await sql(S23, redefinePred(`(select body from public.g533_saved_pred) || E'\\n-- changed\\n'`));
  let r = await run(S23, ['-f', rb]);
  assert.ok(!r.ok && r.error.includes('S23_ROLLBACK_PRECONDITION_PREDICATE_BODY'), r.error);
  await sql(S23, redefinePred('(select body from public.g533_saved_pred)'));
  await sql(S23, 'drop table public.g533_saved_pred');
  assert.equal(await md5(S23, PRED), MD5_PRED);
  // the rollback
  r = await run(S23, ['-f', rb]);
  assert.ok(r.ok, r.error);
  assert.equal(await md5(S23, R0), MD5_D1, 'D1 byte for byte');
  assert.equal(await shape(S23, R0), r0Before, 'same OID / owner / ACL / attributes');
  assert.equal(await exists(S23, PRED), 'false', 'the predicate is gone');
  assert.equal(decision(await ask(S23, person(CASES[6]))).decision, 'allow', 'C4 is allowed again (D1 behaviour)');
  r = await run(S23, ['-f', rb]);
  assert.ok(!r.ok && r.error.includes('S23_ROLLBACK_NOT_APPLIED'), r.error);
  r = await run(S23, ['-f', env('S33_CANDIDATE')]);
  assert.ok(r.ok, r.error);
  assert.equal(decision(await ask(S23, person(CASES[6]))).reason, 'OWN_WORKSPACE_CONFLICT', 're-installed');
  assert.equal(decision(await ask(S23, person(CASES[1]))).decision, 'allow', 'C1 still allowed');
});
