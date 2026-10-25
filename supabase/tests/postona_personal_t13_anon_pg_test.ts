// G5-24 (S2-1): T13 refuses an anonymous sign-in, and nothing else changes. Two databases from the runner: S21 gets the candidate, REV keeps
// the reviewed T13 (76b50e1e). The writer under test is the fixture's consumer stand-in public.fixture_guarded_service_write (a definer writer
// owned by the lifecycle owner, EXECUTE for authenticated, T13 first): what a G3 / G4 writer does, without touching their files. A local fact
// about the candidate SQL; nothing about managed / production. Needs CAL_E2E=1 and the runner's environment.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, other, superUser, S21, REV] = ['S21_OWNER', 'S21_OTHER', 'PGSUPER', 'S21_DB', 'S21_REV'].map(env);
const decoder = new TextDecoder();
globalThis.fetch = (() => { throw new Error('the G5-24 tests make no network request'); }) as typeof fetch;
const test_ = enabled ? test : test.skip;

const T13 = 'private.account_lifecycle_assert_active_service_write(uuid,text)';
// the two body checksums, as the candidate itself states them (its "not reviewed" and "already applied" checks)
const candidateText = enabled ? Deno.readTextFileSync(env('S21_CANDIDATE')) : '';
const MD5_REVIEWED = candidateText.match(/if v_md5 is distinct from '([0-9a-f]{32})' then\s+raise exception 'T13_ANON_PRECONDITION_BODY_NOT_REVIEWED'/u)?.[1] ?? '';
const MD5_S21 = candidateText.match(/if v_md5 = '([0-9a-f]{32})' then\s+raise exception 'T13_ANON_ALREADY_APPLIED'/u)?.[1] ?? '';
if (enabled) assert.ok(MD5_REVIEWED.length === 32 && MD5_S21.length === 32, 'the candidate states both checksums');
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
const spawn = (db: string, statement: string, user = owner) =>
  new Deno.Command('psql', { args: args(db, user, ['-c', statement]), stdout: 'piped', stderr: 'piped' }).spawn();
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const md5 = (db: string) => sql(db, `select md5(prosrc) from pg_proc where oid = '${T13}'::regprocedure`);
const oid = (db: string) => sql(db, `select '${T13}'::regprocedure::oid`);
// (G5-30) every attribute of T13 but its body; REVIEWED_SHAPE is the value measured on the reviewed T13 (76b50e1e) in this PG17
const shape = (db: string) => sql(db, `select format('strict=%s leakproof=%s parallel=%s cost=%s support=%s trf=%s rows=%s argmodes=%s kind=%s '
  || 'retset=%s ret=%s lang=%s argnames=%s nargdefaults=%s secdef=%s volatile=%s config=%s owner=%s acl=%s', p.proisstrict, p.proleakproof,
  p.proparallel, p.procost, p.prosupport::oid, coalesce(p.protrftypes::text, 'NULL'), p.prorows, coalesce(p.proargmodes::text, 'NULL'), p.prokind,
  p.proretset, p.prorettype::regtype, l.lanname, p.proargnames, p.pronargdefaults, p.prosecdef, p.provolatile, coalesce(p.proconfig::text, 'NULL'),
  p.proowner::regrole, p.proacl) from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = '${T13}'::regprocedure`, superUser);
const REVIEWED_SHAPE = () => 'strict=f leakproof=f parallel=u cost=100 support=0 trf=NULL rows=0 argmodes=NULL kind=f retset=f ret=void lang=plpgsql '
  + `argnames={p_user_id,p_service_key} nargdefaults=0 secdef=t volatile=v config={"search_path=\\"\\""} owner=${owner} acl={${owner}=X/${owner}}`;
// (G5-30) the attribute drifts a CREATE OR REPLACE erases without an error (measured): [label, who can make it, the drift, its undo]. The
// superuser's direct pg_proc updates are CATALOG STAND-INS, not the DDL path: no plpgsql TRANSFORM exists in this PG17 (the real TRANSFORM
// path is NOT_VERIFIED), and no DDL sets ROWS or argument modes on a function returning void.
const cat = (set: string) => `update pg_catalog.pg_proc set ${set} where oid = '${T13}'::regprocedure`;
const DRIFTS: Array<[string, 'owner' | 'super', string, string]> = [
  ['STRICT', 'owner', `alter function ${T13} strict`, `alter function ${T13} called on null input`],
  ['PARALLEL SAFE', 'owner', `alter function ${T13} parallel safe`, `alter function ${T13} parallel unsafe`],
  ['PARALLEL RESTRICTED', 'owner', `alter function ${T13} parallel restricted`, `alter function ${T13} parallel unsafe`],
  ['COST 50', 'owner', `alter function ${T13} cost 50`, `alter function ${T13} cost 100`],
  ['LEAKPROOF', 'super', `alter function ${T13} leakproof`, `alter function ${T13} not leakproof`],
  ['SUPPORT textlike_support', 'super', `alter function ${T13} support textlike_support`, cat('prosupport = 0::oid::regproc')],
  ['RESET ALL (proconfig NULL)', 'owner', `alter function ${T13} reset all`, `alter function ${T13} set search_path = ''`],
  ['TRANSFORM stand-in {int4}', 'super', cat(`protrftypes = array['int4'::regtype::oid]::oid[]`), cat('protrftypes = null')],
  ['TRANSFORM stand-in {}', 'super', cat(`protrftypes = '{}'::oid[]`), cat('protrftypes = null')],
  ['ROWS stand-in 10', 'super', cat('prorows = 10'), cat('prorows = 0')],
  ['argument modes stand-in {i,i}', 'super', cat(`proargmodes = array['i', 'i']::"char"[]`), cat('proargmodes = null')],
];
const as = (db: string, who: 'owner' | 'super', statement: string) => sql(db, statement, who === 'super' ? superUser : owner);

// claims: 'json' -> request.jwt.claims (an object, given as raw JSON text); 'legacy' -> the per-claim settings of an older PostgREST
type Claims = { style: 'json'; raw: string } | { style: 'legacy'; sub: string; role: string; session: string; anon?: string };
function claimSql(c: Claims): string {
  if (c.style === 'json') return `select set_config('request.jwt.claims', ${lit(c.raw)}, true);`;
  return `select set_config('request.jwt.claim.sub', ${lit(c.sub)}, true), set_config('request.jwt.claim.role', ${lit(c.role)}, true),
    set_config('request.jwt.claim.session_id', ${lit(c.session)}, true)${c.anon === undefined ? '' : `, set_config('request.jwt.claim.is_anonymous', ${lit(c.anon)}, true)`};`;
}
// a call of the consumer stand-in as `authenticated` with the given claims: 'OK' or the error text (the transaction is rolled back either way)
async function write(db: string, c: Claims, call = `public.fixture_guarded_service_write('x_autopost')`, prefix = ''): Promise<string> {
  const r = await run(db, ['-c', `begin; ${prefix} ${claimSql(c)} set local role authenticated; select ${call}; rollback;`]);
  if (r.ok) return 'OK';
  const m = r.error.match(/ERROR:\s+(.*)/u);
  return m ? m[1].trim() : r.error;
}
const json = (o: Record<string, unknown>): Claims => ({ style: 'json', raw: JSON.stringify(o) });

// the people: one active x_autopost user per database (same ids), with a live session
const P = uid(2401);
const Q = uid(2402); // a login without the x_autopost service
const sessions: Record<string, { live: string; expired: string }> = {};
async function seed(db: string) {
  await sql(db, `select public.fixture_login('${P}'); select public.fixture_login('${Q}')`);
  const start = await run(db, ['-c', `begin; select set_config('request.jwt.claim.sub', '${P}', true), set_config('request.jwt.claim.role', 'authenticated', true);
    set local role authenticated; select public.start_x_autopost_service(); commit;`]);
  assert.ok(start.ok, start.error);
  const live = await sql(db, `insert into auth.sessions (user_id) values ('${P}') returning id`);
  const expired = await sql(db, `insert into auth.sessions (user_id, not_after) values ('${P}', now() - interval '1 minute') returning id`);
  sessions[db] = { live, expired };
}
// a person proves non-anonymity with the boolean false (GoTrue's claim); `bare` is the same token without the claim (G5-25: refused)
const person = (db: string, extra: Record<string, unknown> = {}) => json({ sub: P, role: 'authenticated', session_id: sessions[db].live, is_anonymous: false, ...extra });
const bare = (db: string) => json({ sub: P, role: 'authenticated', session_id: sessions[db].live });

test_('setup and FAIL before: the reviewed T13 (md5 of its body checked) lets an anonymous sign-in write, by either claim source', async () => {
  for (const db of [S21, REV]) {
    assert.equal(await md5(db), MD5_REVIEWED, 'the installed T13 is the reviewed one');
    await seed(db);
  }
  assert.equal(await write(S21, person(S21, { is_anonymous: true })), 'OK', 'JSON claims');
  assert.equal(await write(S21, { style: 'legacy', sub: P, role: 'authenticated', session: sessions[S21].live, anon: 'true' }), 'OK', 'per-claim settings');
  assert.equal(await write(S21, bare(S21)), 'OK', 'a token without the claim (H4 P2: unproven, yet allowed)');
  assert.equal(await write(S21, { style: 'legacy', sub: P, role: 'authenticated', session: sessions[S21].live }), 'OK', 'per-claim settings without the claim');
  assert.equal(await write(S21, person(S21)), 'OK', 'a person');
});

test_('refused installs leave the reviewed T13 untouched: superuser, another role, an API role reaching it, a changed body', async () => {
  const cand = env('S21_CANDIDATE');
  const install = (user: string) => run(REV, ['-f', cand], user);
  const unchanged = async () => assert.equal(await md5(REV), MD5_REVIEWED, 'nothing changed');
  let r = await install(superUser);
  assert.ok(!r.ok && r.error.includes('T13_ANON_PRECONDITION_OWNER_IS_SUPERUSER'), r.error);
  r = await install(other);
  assert.ok(!r.ok && r.error.includes('T13_ANON_PRECONDITION_SHAPE'), r.error);
  await unchanged();
  for (const [label, change, undo] of [
    ['EXECUTE granted to authenticated', `grant execute on function ${T13} to authenticated`, `revoke execute on function ${T13} from authenticated`],
    ['an API role made a member of the owner', `grant ${owner} to authenticator`, `revoke ${owner} from authenticator`],
  ]) {
    await sql(REV, change, label.includes('member') ? superUser : owner);
    r = await install(owner);
    assert.ok(!r.ok && r.error.includes('T13_ANON_PRECONDITION_SHAPE'), `${label}\n${r.error}`);
    await sql(REV, undo, label.includes('member') ? superUser : owner);
    await unchanged();
  }
  // a body that is not the reviewed one (here: the reviewed one plus a comment line) is someone else's change
  // (the body is kept inside the database: psql output trimming would change its leading newline)
  const redefine = (expr: string) => `do $d$ begin execute format('create or replace function private.account_lifecycle_assert_active_service_write(p_user_id uuid, p_service_key text)
    returns void language plpgsql volatile security definer set search_path = '''' as %L', ${expr}); end $d$`;
  await sql(REV, `create table public.g524_saved_body as select prosrc as body from pg_proc where oid = '${T13}'::regprocedure`);
  await sql(REV, redefine(`(select body from public.g524_saved_body) || E'\\n-- changed\\n'`));
  r = await install(owner);
  assert.ok(!r.ok && r.error.includes('T13_ANON_PRECONDITION_BODY_NOT_REVIEWED'), r.error);
  await sql(REV, redefine('(select body from public.g524_saved_body)'));
  await sql(REV, 'drop table public.g524_saved_body');
  await unchanged();
  // the rollback refuses where the candidate never ran
  r = await run(REV, ['-f', env('S21_ROLLBACK')]);
  assert.ok(!r.ok && r.error.includes('T13_ANON_ROLLBACK_NOT_APPLIED'), r.error);
  await unchanged();
});

// (G5-25) H4's P2 reproduced on PR #480's own candidate (1a974b8d), then rolled back with its own rollback; skipped without the pinned commit
const testP2 = enabled && env('S21_P2_CANDIDATE') !== '' ? test : test.skip;
testP2('P2 before (PR #480 head 1a974b8d): a missing, null or empty claim passes its T13; that is what this revision refuses', async () => {
  let r = await run(REV, ['-f', env('S21_P2_CANDIDATE')]);
  assert.ok(r.ok, r.error);
  assert.equal(await write(REV, person(REV, { is_anonymous: true })), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'PR #480 refuses true');
  assert.equal(await write(REV, bare(REV)), 'OK', 'P2: a missing JSON claim passes');
  assert.equal(await write(REV, person(REV, { is_anonymous: null })), 'OK', 'P2: a null JSON claim passes');
  assert.equal(await write(REV, { style: 'legacy', sub: P, role: 'authenticated', session: sessions[REV].live }), 'OK', 'P2: a missing per-claim setting passes');
  assert.equal(await write(REV, { style: 'legacy', sub: P, role: 'authenticated', session: sessions[REV].live, anon: '' }), 'OK', 'P2: an empty per-claim setting passes');
  r = await run(REV, ['-f', env('S21_P2_ROLLBACK')]);
  assert.ok(r.ok, r.error);
  assert.equal(await md5(REV), MD5_REVIEWED, 'back to the reviewed T13');
});

// (G5-30) the drifts reproduced on PR #483's own candidate (9d739904) and its rollback; skipped without the pinned commit
const testP3 = enabled && env('S21_P3_CANDIDATE') !== '' ? test : test.skip;
testP3('drift before (PR #483 head 9d739904): its install and its rollback pass over every attribute drift and erase it', async () => {
  assert.equal(await shape(REV), REVIEWED_SHAPE(), 'the measured baseline');
  for (const [label, who, drift] of DRIFTS) {
    await as(REV, who, drift);
    let r = await run(REV, ['-f', env('S21_P3_CANDIDATE')]);
    assert.ok(r.ok, `${label}: PR #483 installs over it\n${r.error}`);
    assert.equal(await shape(REV), REVIEWED_SHAPE(), `${label}: erased by the install`);
    await as(REV, who, drift);
    r = await run(REV, ['-f', env('S21_P3_ROLLBACK')]);
    assert.ok(r.ok, `${label}: PR #483's rollback runs over it\n${r.error}`);
    assert.equal(await shape(REV), REVIEWED_SHAPE(), `${label}: erased by the rollback`);
    assert.equal(await md5(REV), MD5_REVIEWED);
  }
});

test_('(G5-30) each attribute drift refuses the install with T13_ANON_PRECONDITION_SHAPE; the reviewed body and the drift are left as they were', async () => {
  assert.equal(await shape(REV), REVIEWED_SHAPE(), 'the measured baseline');
  for (const [label, who, drift, undo] of DRIFTS) {
    await as(REV, who, drift);
    const drifted = await shape(REV);
    assert.notEqual(drifted, REVIEWED_SHAPE(), `${label}: the drift is real`);
    const r = await run(REV, ['-f', env('S21_CANDIDATE')]);
    assert.ok(!r.ok && r.error.includes('T13_ANON_PRECONDITION_SHAPE'), `${label}\n${r.error}`);
    assert.equal(await shape(REV), drifted, `${label}: kept, not erased`);
    assert.equal(await md5(REV), MD5_REVIEWED, `${label}: body unchanged`);
    await as(REV, who, undo);
    assert.equal(await shape(REV), REVIEWED_SHAPE(), `${label}: undone`);
  }
});

test_('install: same OID, owner-only EXECUTE kept, the expected body; a second run refuses', async () => {
  const before = await oid(S21);
  assert.equal(await shape(S21), REVIEWED_SHAPE(), 'the measured baseline');
  const acl = await sql(S21, `select proacl::text from pg_proc where oid = '${T13}'::regprocedure`);
  const r = await run(S21, ['-f', env('S21_CANDIDATE')]);
  assert.ok(r.ok, r.error);
  assert.equal(await oid(S21), before, 'same OID: every consumer reference stays');
  assert.equal(await md5(S21), MD5_S21);
  assert.equal(await sql(S21, `select proacl::text from pg_proc where oid = '${T13}'::regprocedure`), acl);
  assert.equal(await shape(S21), REVIEWED_SHAPE(), 'every attribute, the owner and the ACL kept');
  for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) {
    assert.equal(await sql(S21, `select has_function_privilege('${role}', '${T13}', 'EXECUTE')`), 'f', `${role}: no EXECUTE (no Data API path)`);
  }
  const again = await run(S21, ['-f', env('S21_CANDIDATE')]);
  assert.ok(!again.ok && again.error.includes('T13_ANON_ALREADY_APPLIED'), again.error);
});

// the cases compared across the two databases: [label, claims, expected after (null = same as before)]
function cases(db: string): Array<[string, Claims, string | null]> {
  const live = sessions[db].live;
  const L = (anon?: string): Claims => ({ style: 'legacy', sub: P, role: 'authenticated', session: live, anon });
  return [
    ['JSON is_anonymous true', person(db, { is_anonymous: true }), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['JSON is_anonymous "true" (a string)', person(db, { is_anonymous: 'true' }), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['JSON is_anonymous "false" (a string, not the boolean)', person(db, { is_anonymous: 'false' }), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['JSON is_anonymous 1', person(db, { is_anonymous: 1 }), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['legacy is_anonymous true', L('true'), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['legacy is_anonymous yes', L('yes'), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['JSON is_anonymous false', person(db, { is_anonymous: false }), null],
    // G5-25 (H4 P2): non-anonymity must be PROVEN -- a missing, null, empty or otherwise typed claim is refused like an anonymous one
    ['JSON claim missing', bare(db), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['JSON is_anonymous null', person(db, { is_anonymous: null }), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['JSON is_anonymous {} (an object)', person(db, { is_anonymous: {} }), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['legacy claim missing', L(), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['legacy is_anonymous empty', L(''), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'],
    ['legacy is_anonymous false', L('false'), null],
    ['another person\'s session', json({ sub: P, role: 'authenticated', session_id: '00000000-0000-4000-8000-0000000000ff', is_anonymous: false }), null],
    ['expired session', json({ sub: P, role: 'authenticated', session_id: sessions[db].expired, is_anonymous: false }), null],
    ['role anon in the claims', json({ sub: P, role: 'anon', session_id: live, is_anonymous: false }), null],
    ['no session id', json({ sub: P, role: 'authenticated', is_anonymous: false }), null],
    ['broken claims', { style: 'json', raw: '{not json' }, null],
    ['a person without the service', json({ sub: Q, role: 'authenticated', session_id: live, is_anonymous: false }), null],
  ];
}

test_('PASS after: only the anonymous and the unproven cases change (to ACCOUNT_LIFECYCLE_AUTH_REQUIRED); every other answer is identical to the reviewed T13', async () => {
  const before = cases(REV);
  const after = cases(S21);
  for (let i = 0; i < before.length; i += 1) {
    const [label, claimsRev, expected] = before[i];
    const rev = await write(REV, claimsRev);
    const now = await write(S21, after[i][1]);
    if (expected === null) {
      assert.equal(now, rev, `${label}: unchanged`);
    } else {
      assert.equal(rev, 'OK', `${label}: the reviewed T13 lets it through`);
      assert.equal(now, expected, `${label}: refused now`);
    }
  }
  // nothing was written by a refused call (each call is rolled back anyway; a committed one shows the footprint)
  const commitAnon = await run(S21, ['-c', `begin; ${claimSql(person(S21, { is_anonymous: true }))} set local role authenticated;
    select public.fixture_guarded_service_write('x_autopost'); commit;`]);
  assert.ok(!commitAnon.ok);
  assert.equal(await sql(S21, `select count(*) from public.fixture_service_footprint where user_id = '${P}'`), '0');
  // the writer that trusts its input (another person's id) and READ COMMITTED: unchanged too
  for (const [label, call, prefix] of [
    ['a writer handing over another id', `public.fixture_guarded_write_for('${Q}', 'x_autopost')`, ''],
    ['REPEATABLE READ', `public.fixture_guarded_service_write('x_autopost')`, 'set transaction isolation level repeatable read;'],
  ] as const) {
    assert.equal(await write(S21, person(S21), call, prefix), await write(REV, person(REV), call, prefix), label);
  }
});

test_('before any lock: with the account row held by another session, an anonymous call is refused at once; a person waits and times out', async () => {
  const holder = spawn(S21, `begin; select 1 from public.common_accounts where user_id = '${P}' for update; select pg_sleep(3) /* g524-hold */; commit`);
  for (let i = 0; i < 200; i += 1) {
    if ((await sql(S21, `select count(*) from pg_stat_activity where wait_event = 'PgSleep' and position('g524-hold' in query) > 0`, superUser)) === '1') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await write(S21, person(S21, { is_anonymous: true }), undefined, `set local lock_timeout = '300ms';`), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED');
  assert.match(await write(S21, person(S21), undefined, `set local lock_timeout = '300ms';`), /lock timeout/u);
  assert.ok((await holder.output()).success);
});

test_('(G5-30) each attribute drift refuses the rollback with T13_ANON_ROLLBACK_PRECONDITION_SHAPE; the S2-1 body and the drift stay', async () => {
  for (const [label, who, drift, undo] of DRIFTS) {
    await as(S21, who, drift);
    const drifted = await shape(S21);
    const r = await run(S21, ['-f', env('S21_ROLLBACK')]);
    assert.ok(!r.ok && r.error.includes('T13_ANON_ROLLBACK_PRECONDITION_SHAPE'), `${label}\n${r.error}`);
    assert.equal(await shape(S21), drifted, `${label}: kept, not erased`);
    assert.equal(await md5(S21), MD5_S21, `${label}: the S2-1 body stays`);
    await as(S21, who, undo);
    assert.equal(await shape(S21), REVIEWED_SHAPE(), `${label}: undone`);
  }
});

test_('rollback: the reviewed body byte for byte, same OID, the anonymous case passes again; a second rollback refuses; the candidate re-installs', async () => {
  const before = await oid(S21);
  let r = await run(S21, ['-f', env('S21_ROLLBACK')]);
  assert.ok(r.ok, r.error);
  assert.equal(await md5(S21), MD5_REVIEWED);
  assert.equal(await shape(S21), REVIEWED_SHAPE(), 'every attribute kept');
  assert.equal(await oid(S21), before);
  assert.equal(await write(S21, person(S21, { is_anonymous: true })), 'OK', 'the reviewed behaviour is back');
  assert.equal(await write(S21, bare(S21)), 'OK', 'including the missing claim');
  r = await run(S21, ['-f', env('S21_ROLLBACK')]);
  assert.ok(!r.ok && r.error.includes('T13_ANON_ROLLBACK_NOT_APPLIED'), r.error);
  r = await run(S21, ['-f', env('S21_CANDIDATE')]);
  assert.ok(r.ok, r.error);
  assert.equal(await md5(S21), MD5_S21);
  assert.equal(await write(S21, person(S21, { is_anonymous: true })), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED');
  assert.equal(await write(S21, bare(S21)), 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED');
  assert.equal(await write(S21, person(S21)), 'OK');
});
