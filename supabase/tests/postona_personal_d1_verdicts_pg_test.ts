// G5-27 (D1): R1 / R0 / SV read is_anonymous strictly (only a proven false), as T13 does since PR #483 -- and nothing else changes. Two databases
// from the runner: D1 gets the candidate, REV keeps the reviewed verdicts (ceb77ce4). Every case is asked of both and compared byte for byte; only
// the unproven claims (missing / null / empty) change, to the existing AUTH_REQUIRED answer. A local fact about the candidate SQL; nothing about
// managed / production or a wired consumer. Needs CAL_E2E=1 and the runner's environment.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, superUser, D1, REV] = ['S27_OWNER', 'PGSUPER', 'S27_DB', 'S27_REV'].map(env);
const decoder = new TextDecoder();
globalThis.fetch = (() => { throw new Error('the G5-27 tests make no network request'); }) as typeof fetch;
const test_ = enabled ? test : test.skip;

const R1 = 'public.common_account_authorization_verdict(text,text,text)';
const R0 = 'public.common_account_bootstrap_verdict(text,text)';
const SV = 'private.account_lifecycle_session_verdict()';
const FNS = { R1, R0, SV } as const;
// the checksums as the candidate states them: [reviewed, D1] per function
const candidateText = enabled ? Deno.readTextFileSync(env('S27_CANDIDATE')) : '';
function stated(k: 'R1' | 'R0' | 'SV'): [string, string] {
  const reviewed = candidateText.match(new RegExp(`if v_md5 is distinct from '([0-9a-f]{32})' then\\s+raise exception 'D1_PRECONDITION_${k}_BODY_NOT_REVIEWED'`, 'u'))?.[1] ?? '';
  const d1 = candidateText.match(new RegExp(`raise exception 'D1_POSTCONDITION_${k}_OID';\\s+end if;\\s+if \\(select pg_catalog.md5\\(p.prosrc\\) from pg_catalog.pg_proc p where p.oid = v_fn\\) is distinct from '([0-9a-f]{32})'`, 'u'))?.[1] ?? '';
  return [reviewed, d1];
}
const MD5 = enabled ? { R1: stated('R1'), R0: stated('R0'), SV: stated('SV') } : { R1: ['', ''], R0: ['', ''], SV: ['', ''] };
if (enabled) for (const [k, [a, b]] of Object.entries(MD5)) assert.ok(a.length === 32 && b.length === 32, `${k}: the candidate states both checksums`);

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
const md5 = (db: string, fn: string) => sql(db, `select md5(prosrc) from pg_proc where oid = '${fn}'::regprocedure`);
// (G5-28) the shape includes every attribute CREATE OR REPLACE would reset (H4 P2 on PR #486)
const shape = (db: string, fn: string) => sql(db, `select oid || '|' || proconfig::text || '|' || array_to_string(proacl::text[], ',') || '|' || provolatile::text || prosecdef::text
  || '|' || proisstrict::text || proleakproof::text || proparallel::text || prokind::text || proretset::text || procost::text || prorows::text || prosupport::text
  || prorettype::regtype::text || prolang::regproc::text || pronargdefaults::text || coalesce(proargnames::text, '-') || '|' || coalesce(protrftypes::text, 'no-transform')
  from pg_proc where oid = '${fn}'::regprocedure`);
const strictness = (db: string) => sql(db, `select string_agg(proisstrict::text || proparallel::text || procost::text || proleakproof::text, ',' order by oid::regprocedure::text) from pg_proc
  where oid in ('${R1}'::regprocedure, '${R0}'::regprocedure, '${SV}'::regprocedure)`);

type Claims = { style: 'json'; raw: string } | { style: 'legacy'; sub: string; role: string; session: string; anon?: string };
function claimSql(c: Claims): string {
  if (c.style === 'json') return `select set_config('request.jwt.claims', ${lit(c.raw)}, true);`;
  return `select set_config('request.jwt.claim.sub', ${lit(c.sub)}, true), set_config('request.jwt.claim.role', ${lit(c.role)}, true),
    set_config('request.jwt.claim.session_id', ${lit(c.session)}, true)${c.anon === undefined ? '' : `, set_config('request.jwt.claim.is_anonymous', ${lit(c.anon)}, true)`};`;
}
// R1 / R0 as `authenticated` (their grant), SV as its owner (no grant): the answer text, or ERROR
async function ask(db: string, which: 'R1' | 'R0' | 'SV', c: Claims, brand: string): Promise<string> {
  const call = which === 'R1' ? `public.common_account_authorization_verdict('postona', 'x_publish', ${lit(brand)})::text`
    : which === 'R0' ? `public.common_account_bootstrap_verdict('postona', 'x_connect_bootstrap')::text` : 'private.account_lifecycle_session_verdict()';
  const r = await run(db, ['-c', `begin; ${claimSql(c)} ${which === 'SV' ? '' : 'set local role authenticated;'} select ${call}; rollback;`]);
  return r.ok ? r.out.split('\n').filter((l) => l !== '').pop() ?? '' : `ERROR ${r.error}`;
}

type Person = { user: string; session: string; expired: string; brand: string };
const people: Record<string, Person> = {};
async function seed(db: string, user: string) {
  const brand = await sql(db, `select public.fixture_user_with_workspace('${user}'::uuid, ${lit(`d1_${user.slice(0, 6)}`)})`);
  const start = await run(db, ['-c', `begin; select set_config('request.jwt.claim.sub', '${user}', true), set_config('request.jwt.claim.role', 'authenticated', true);
    select to_jsonb(public.start_x_autopost_service())::text; commit;`]);
  assert.ok(start.ok && start.out.includes('"active"'), start.error || start.out);
  // the same ids in both databases, so the hashed session refs of the answers compare byte for byte
  const session = SESSION;
  const expired = EXPIRED;
  await sql(db, `insert into auth.sessions (id, user_id, not_after) values ('${session}', '${user}', null), ('${expired}', '${user}', now() - interval '1 minute')`);
  people[db] = { user, session, expired, brand };
}
const P = enabled ? randomUUID() : '';
const SESSION = randomUUID();
const EXPIRED = randomUUID();
const UNKNOWN_SESSION = randomUUID();
const NOSVC = enabled ? randomUUID() : ''; // a login with a workspace but without the x_autopost service

test_('setup and FAIL before: the reviewed R1 / R0 / SV accept a missing or null is_anonymous as "not anonymous"', async () => {
  for (const db of [D1, REV]) {
    for (const [k, fn] of Object.entries(FNS)) assert.equal(await md5(db, fn), MD5[k as 'R1'][0], `${k}: the reviewed body`);
    await seed(db, P);
    await sql(db, `select public.fixture_user_with_workspace('${NOSVC}'::uuid, 'd1_nosvc')`);
  }
  const p = people[REV];
  const bare = { style: 'json', raw: JSON.stringify({ sub: p.user, role: 'authenticated', session_id: p.session }) } as Claims;
  assert.match(await ask(REV, 'R1', bare, p.brand), /"decision": "allow"/u, 'R1 allows a token without the claim');
  assert.match(await ask(REV, 'R0', bare, p.brand), /"decision": "allow"/u, 'R0 allows it');
  assert.equal(await ask(REV, 'SV', bare, p.brand), 'active', 'SV answers active');
});

test_('refused installs leave the reviewed verdicts untouched: superuser, an API role reaching the owner, a changed ACL, a changed body; rollback where never applied', async () => {
  const cand = env('S27_CANDIDATE');
  const before = async () => Object.fromEntries(await Promise.all(Object.entries(FNS).map(async ([k, fn]) => [k, `${await md5(REV, fn)}|${await shape(REV, fn)}`])));
  const snapshot = await before();
  const check = async (label: string) => assert.deepEqual(await before(), snapshot, `${label}: nothing changed`);
  let r = await run(REV, ['-f', cand], superUser);
  assert.ok(!r.ok && r.error.includes('D1_PRECONDITION_OWNER_IS_SUPERUSER'), r.error);
  await check('superuser');
  for (const [label, change, undo, code, as] of [
    ['an API role made a member of the owner', `grant ${owner} to authenticator`, `revoke ${owner} from authenticator`, 'D1_PRECONDITION_R1_SHAPE', superUser],
    ['EXECUTE on SV granted to authenticated', `grant execute on function ${SV} to authenticated`, `revoke execute on function ${SV} from authenticated`, 'D1_PRECONDITION_SV_SHAPE', owner],
    ['EXECUTE on R0 granted to anon', `grant execute on function ${R0} to anon`, `revoke execute on function ${R0} from anon`, 'D1_PRECONDITION_R0_SHAPE', owner],
  ] as const) {
    await sql(REV, change, as);
    r = await run(REV, ['-f', cand]);
    assert.ok(!r.ok && r.error.includes(code), `${label}\n${r.error}`);
    await sql(REV, undo, as);
    await check(label);
  }
  // a body that is not the reviewed one (R0 + a comment line); kept inside the database (psql output trimming would change it)
  const redefine = (expr: string) => `do $d$ begin execute format('create or replace function public.common_account_bootstrap_verdict(p_app text, p_feature text)
    returns jsonb language plpgsql stable security definer set search_path = '''' set row_security = off as %L', ${expr}); end $d$`;
  await sql(REV, `create table public.g527_saved as select prosrc as body from pg_proc where oid = '${R0}'::regprocedure`);
  await sql(REV, redefine(`(select body from public.g527_saved) || E'\\n-- changed\\n'`));
  r = await run(REV, ['-f', cand]);
  assert.ok(!r.ok && r.error.includes('D1_PRECONDITION_R0_BODY_NOT_REVIEWED'), r.error);
  await sql(REV, redefine('(select body from public.g527_saved)'));
  await sql(REV, 'drop table public.g527_saved');
  await check('a changed body');
  r = await run(REV, ['-f', env('S27_ROLLBACK')]);
  assert.ok(!r.ok && r.error.includes('D1_ROLLBACK_NOT_APPLIED'), r.error);
  await check('rollback where never applied');
});

// (G5-28) H4's P2 on PR #486's own candidate (24e6be5c): an attribute drift (here STRICT on R1) was accepted and silently reset
const testP2 = enabled && env('S27_P2_CANDIDATE') !== '' ? test : test.skip;
testP2('P2 before (PR #486 head 24e6be5c): a STRICT R1 is accepted by its install and reset to non-STRICT; a STRICT SV is accepted by its rollback', async () => {
  await sql(REV, `alter function ${R1} strict`);
  let r = await run(REV, ['-f', env('S27_P2_CANDIDATE')]);
  assert.ok(r.ok, `P2: the install accepts the drift\n${r.error}`);
  assert.equal(await sql(REV, `select proisstrict from pg_proc where oid = '${R1}'::regprocedure`), 'f', 'P2: the drift was silently reset');
  await sql(REV, `alter function ${SV} strict`);
  r = await run(REV, ['-f', env('S27_P2_ROLLBACK')]);
  assert.ok(r.ok, `P2: the rollback accepts the drift\n${r.error}`);
  assert.equal(await sql(REV, `select proisstrict from pg_proc where oid = '${SV}'::regprocedure`), 'f', 'P2: reset again');
  for (const [k, fn] of Object.entries(FNS)) assert.equal(await md5(REV, fn), MD5[k as 'R1'][0], `${k}: back to the reviewed body`);
});

// (G5-29) H4's P2 on PR #487 (e282c563): protrftypes (the TRANSFORM attribute) is not in its baseline. A real TRANSFORM cannot be put on a plpgsql
// function here (no transform exists for plpgsql; SQL cannot create the internal-typed support functions), so the drift is a superuser's direct
// catalog edit -- a STAND-IN for the attribute, labelled as such; a real TRANSFORM path stays NOT_VERIFIED.
const standIn = (fn: string, value: string) => `update pg_catalog.pg_proc set protrftypes = ${value} where oid = '${fn}'::regprocedure`;
const trf = (db: string, fn: string) => sql(db, `select coalesce(protrftypes::text, 'null') from pg_proc where oid = '${fn}'::regprocedure`);
const testP3 = enabled && env('S27_P3_CANDIDATE') !== '' ? test : test.skip;
testP3('P2 before (PR #487 head e282c563): a protrftypes drift (catalog stand-in) is accepted by its install and its rollback and erased', async () => {
  await sql(REV, standIn(R1, "array['jsonb'::regtype::oid]::oid[]"), superUser);
  let r = await run(REV, ['-f', env('S27_P3_CANDIDATE')]);
  assert.ok(r.ok, `P2: the install accepts it\n${r.error}`);
  assert.equal(await trf(REV, R1), 'null', 'P2: erased by CREATE OR REPLACE');
  await sql(REV, standIn(SV, "array['text'::regtype::oid]::oid[]"), superUser);
  r = await run(REV, ['-f', env('S27_P3_ROLLBACK')]);
  assert.ok(r.ok, `P2: the rollback accepts it\n${r.error}`);
  assert.equal(await trf(REV, SV), 'null', 'P2: erased again');
  for (const [k, fn] of Object.entries(FNS)) assert.equal(await md5(REV, fn), MD5[k as 'R1'][0], `${k}: back to the reviewed body`);
});

// (G5-31) a RESET ALL leaves proconfig NULL: `p.proconfig = array[...]` is then NULL, `not (NULL)` is NULL, and a plpgsql IF treats NULL as false.
// The reviewed settings are put back with one ALTER (the order of proconfig is the reviewed one; the shape comparison checks it).
const resetAll = (fn: string) => `alter function ${fn} reset all`;
const settingsBack = (fn: string) => `alter function ${fn} set search_path = '' set row_security = off`;
const config = (db: string, fn: string) => sql(db, `select coalesce(proconfig::text, 'NULL') from pg_proc where oid = '${fn}'::regprocedure`);
const REVIEWED_CONFIG = '{"search_path=\\"\\"",row_security=off}';
const testP4 = enabled && env('S27_P4_CANDIDATE') !== '' ? test : test.skip;
testP4('P2 before (PR #488 head ad83ffd8): a RESET ALL on R1, R0 or SV is accepted by its install and its rollback and the NULL settings are erased', async () => {
  for (const [k, fn] of Object.entries(FNS)) {
    await sql(REV, resetAll(fn));
    assert.equal(await config(REV, fn), 'NULL', `${k}: the drift is real`);
    let r = await run(REV, ['-f', env('S27_P4_CANDIDATE')]);
    assert.ok(r.ok, `${k}: P2, the install accepts it\n${r.error}`);
    assert.equal(await config(REV, fn), REVIEWED_CONFIG, `${k}: P2, erased by the install`);
    await sql(REV, resetAll(fn));
    r = await run(REV, ['-f', env('S27_P4_ROLLBACK')]);
    assert.ok(r.ok, `${k}: P2, the rollback accepts it\n${r.error}`);
    assert.equal(await config(REV, fn), REVIEWED_CONFIG, `${k}: P2, erased by the rollback`);
    for (const [j, f] of Object.entries(FNS)) assert.equal(await md5(REV, f), MD5[j as 'R1'][0], `${j}: back to the reviewed body`);
  }
});

test_('attribute drift (STRICT, PARALLEL, COST, LEAKPROOF, protrftypes stand-in, RESET ALL) refuses the install and the rollback, and nothing changes -- body or attribute', async () => {
  const baseline = Object.fromEntries(await Promise.all(Object.entries(FNS).map(async ([k, fn]) => [k, `${await md5(REV, fn)}|${await shape(REV, fn)}`])));
  const drifts: Array<[string, string, string, string, string]> = [
    ['R1 STRICT', `alter function ${R1} strict`, `alter function ${R1} called on null input`, 'D1_PRECONDITION_R1_SHAPE', owner],
    ['R0 STRICT', `alter function ${R0} strict`, `alter function ${R0} called on null input`, 'D1_PRECONDITION_R0_SHAPE', owner],
    ['SV STRICT', `alter function ${SV} strict`, `alter function ${SV} called on null input`, 'D1_PRECONDITION_SV_SHAPE', owner],
    ['R0 PARALLEL SAFE', `alter function ${R0} parallel safe`, `alter function ${R0} parallel unsafe`, 'D1_PRECONDITION_R0_SHAPE', owner],
    ['SV COST 50', `alter function ${SV} cost 50`, `alter function ${SV} cost 100`, 'D1_PRECONDITION_SV_SHAPE', owner],
    ['R1 LEAKPROOF', `alter function ${R1} leakproof`, `alter function ${R1} not leakproof`, 'D1_PRECONDITION_R1_SHAPE', superUser],
    // (G5-29) protrftypes, by the catalog stand-in (see above); the empty array is not the reviewed NULL either
    ['R1 protrftypes {jsonb} (stand-in)', standIn(R1, "array['jsonb'::regtype::oid]::oid[]"), standIn(R1, 'null'), 'D1_PRECONDITION_R1_SHAPE', superUser],
    ['R0 protrftypes {} (stand-in)', standIn(R0, "'{}'::oid[]"), standIn(R0, 'null'), 'D1_PRECONDITION_R0_SHAPE', superUser],
    ['SV protrftypes {text} (stand-in)', standIn(SV, "array['text'::regtype::oid]::oid[]"), standIn(SV, 'null'), 'D1_PRECONDITION_SV_SHAPE', superUser],
    // (G5-31) RESET ALL: proconfig NULL, the real DDL of the owner
    ['R1 RESET ALL', resetAll(R1), settingsBack(R1), 'D1_PRECONDITION_R1_SHAPE', owner],
    ['R0 RESET ALL', resetAll(R0), settingsBack(R0), 'D1_PRECONDITION_R0_SHAPE', owner],
    ['SV RESET ALL', resetAll(SV), settingsBack(SV), 'D1_PRECONDITION_SV_SHAPE', owner],
  ];
  for (const [label, drift, undo, code, as] of drifts) {
    await sql(REV, drift, as);
    const shapes = Object.fromEntries(await Promise.all(Object.entries(FNS).map(async ([k, fn]) => [k, `${await md5(REV, fn)}|${await shape(REV, fn)}`])));
    const r = await run(REV, ['-f', env('S27_CANDIDATE')]);
    assert.ok(!r.ok && r.error.includes(code), `${label}\n${r.error}`);
    for (const [k, fn] of Object.entries(FNS)) assert.equal(`${await md5(REV, fn)}|${await shape(REV, fn)}`, shapes[k], `${label}: ${k} untouched (the drift stays visible)`);
    await sql(REV, undo, as);
    for (const [k, fn] of Object.entries(FNS)) assert.equal(`${await md5(REV, fn)}|${await shape(REV, fn)}`, baseline[k], `${label}: ${k} undone to the reviewed shape`);
  }
  assert.equal(await strictness(REV), 'falseu100false,falseu100false,falseu100false', 'every drift undone (booleans cast to text)');
  for (const fn of [R1, R0, SV]) assert.equal(await trf(REV, fn), 'null', `${fn}: no TRANSFORM left`);
});

test_('install: same OIDs, settings and ACLs, the expected bodies; no other G5 function changed; a second run refuses', async () => {
  const others = `select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ',' order by p.oid::regprocedure::text) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.oid not in ('${R1}'::regprocedure, '${R0}'::regprocedure, '${SV}'::regprocedure)`;
  const othersBefore = await sql(D1, others);
  const shapes = Object.fromEntries(await Promise.all(Object.entries(FNS).map(async ([k, fn]) => [k, await shape(D1, fn)])));
  const r = await run(D1, ['-f', env('S27_CANDIDATE')]);
  assert.ok(r.ok, r.error);
  for (const [k, fn] of Object.entries(FNS)) {
    assert.equal(await md5(D1, fn), MD5[k as 'R1'][1], `${k}: the D1 body`);
    assert.equal(await shape(D1, fn), shapes[k], `${k}: same OID, settings, ACL, STABLE definer`);
  }
  assert.equal(await sql(D1, others), othersBefore, 'every other function of public / private is byte-identical (W1, W2, T13, owner epoch, ...)');
  for (const role of ['anon', 'service_role', 'authenticator']) {
    for (const fn of [R1, R0]) assert.equal(await sql(D1, `select has_function_privilege('${role}', '${fn}', 'EXECUTE')`), 'f', `${role} ${fn}`);
  }
  for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) assert.equal(await sql(D1, `select has_function_privilege('${role}', '${SV}', 'EXECUTE')`), 'f', `${role} SV`);
  const again = await run(D1, ['-f', env('S27_CANDIDATE')]);
  assert.ok(!again.ok && again.error.includes('D1_ALREADY_APPLIED'), again.error);
});

// [label, claims for a database, changes (true) or byte-identical (false)]
function cases(db: string): Array<[string, Claims, boolean]> {
  const p = people[db];
  const j = (o: Record<string, unknown>): Claims => ({ style: 'json', raw: JSON.stringify(o) });
  const me = (extra: Record<string, unknown> = {}) => j({ sub: p.user, role: 'authenticated', session_id: p.session, ...extra });
  const L = (anon?: string): Claims => ({ style: 'legacy', sub: p.user, role: 'authenticated', session: p.session, anon });
  return [
    // D1: the unproven claims now refused
    ['JSON claim missing', me(), true],
    ['JSON is_anonymous null', me({ is_anonymous: null }), true],
    ['per-claim missing', L(), true],
    ['per-claim empty', L(''), true],
    // already refused before, and still the same answer
    ['JSON true', me({ is_anonymous: true }), false],
    ['JSON "true" (a string)', me({ is_anonymous: 'true' }), false],
    ['JSON "false" (a string)', me({ is_anonymous: 'false' }), false],
    ['JSON 1', me({ is_anonymous: 1 }), false],
    ['JSON {}', me({ is_anonymous: {} }), false],
    ['per-claim true', L('true'), false],
    ['per-claim yes', L('yes'), false],
    // proving false: the reviewed answers, byte for byte (allow with g5oe and entitlements included)
    ['JSON false (the person)', me({ is_anonymous: false }), false],
    ['per-claim false (the person)', L('false'), false],
    ['expired session', j({ sub: p.user, role: 'authenticated', session_id: p.expired, is_anonymous: false }), false],
    ['revoked (unknown) session', j({ sub: p.user, role: 'authenticated', session_id: UNKNOWN_SESSION, is_anonymous: false }), false],
    ['role anon', j({ sub: p.user, role: 'anon', session_id: p.session, is_anonymous: false }), false],
    ['no session id', j({ sub: p.user, role: 'authenticated', is_anonymous: false }), false],
    ['uppercase sub', j({ sub: p.user.toUpperCase(), role: 'authenticated', session_id: p.session, is_anonymous: false }), false],
    ['broken claims', { style: 'json', raw: '{not json' }, false],
    ['a login without the service', j({ sub: NOSVC, role: 'authenticated', session_id: p.session, is_anonymous: false }), false],
  ];
}

test_('PASS after: only the unproven claims change, to the existing AUTH_REQUIRED answer; every other answer of R1 / R0 / SV is byte-identical', async () => {
  const before = cases(REV);
  const after = cases(D1);
  // the existing AUTH_REQUIRED answers (role anon is refused at the subject step in both databases)
  const authRequired = {
    R1: await ask(REV, 'R1', before[15][1], people[REV].brand), R0: await ask(REV, 'R0', before[15][1], people[REV].brand), SV: await ask(REV, 'SV', before[15][1], people[REV].brand),
  };
  assert.match(authRequired.R1, /"reason": "AUTH_REQUIRED"/u);
  assert.equal(authRequired.SV, 'AUTH_REQUIRED');
  let changed = 0;
  for (let i = 0; i < before.length; i += 1) {
    const [label, claimsRev, changes] = before[i];
    for (const which of ['R1', 'R0', 'SV'] as const) {
      const rev = await ask(REV, which, claimsRev, people[REV].brand);
      const now = await ask(D1, which, after[i][1], people[D1].brand);
      if (changes) {
        assert.notEqual(rev, authRequired[which], `${label} ${which}: the reviewed verdict accepted it`);
        assert.equal(now, authRequired[which], `${label} ${which}: now the existing AUTH_REQUIRED answer`);
        changed += 1;
      } else {
        assert.equal(now, rev, `${label} ${which}: byte-identical`);
      }
    }
  }
  assert.equal(changed, 12, 'four claim forms x three functions');
  // the allow itself is untouched: the v1 wire with its 8 keys, the g5oe token and the entitlement
  const allow = JSON.parse(await ask(D1, 'R1', after[11][1], people[D1].brand));
  assert.equal(Object.keys(allow).sort().join(','), 'decision,entitlements,owner_epoch,reason,scope,session,subject,v');
  assert.equal(allow.decision, 'allow');
  assert.match(String(allow.owner_epoch), /^g5oe:[1-9][0-9]*:[1-9][0-9]*$/u);
  assert.deepEqual(allow.entitlements, ['postona:x_autopost']);
});

test_('rollback: the reviewed bodies byte for byte, same OIDs and ACLs; the missing claim is accepted again; a second rollback refuses; re-install works', async () => {
  const shapes = Object.fromEntries(await Promise.all(Object.entries(FNS).map(async ([k, fn]) => [k, await shape(D1, fn)])));
  // (G5-28) a STRICT drift after the install refuses the rollback and changes nothing
  await sql(D1, `alter function ${SV} strict`);
  const sv = `${await md5(D1, SV)}|${await shape(D1, SV)}`;
  let r = await run(D1, ['-f', env('S27_ROLLBACK')]);
  assert.ok(!r.ok && r.error.includes('D1_ROLLBACK_PRECONDITION_SV_SHAPE'), r.error);
  assert.equal(`${await md5(D1, SV)}|${await shape(D1, SV)}`, sv, 'the D1 body and the drift both stay');
  await sql(D1, `alter function ${SV} called on null input`);
  // (G5-29) a protrftypes drift (stand-in) after the install refuses the rollback the same way
  await sql(D1, standIn(R0, "array['jsonb'::regtype::oid]::oid[]"), superUser);
  const r0 = `${await md5(D1, R0)}|${await shape(D1, R0)}`;
  r = await run(D1, ['-f', env('S27_ROLLBACK')]);
  assert.ok(!r.ok && r.error.includes('D1_ROLLBACK_PRECONDITION_R0_SHAPE'), r.error);
  assert.equal(`${await md5(D1, R0)}|${await shape(D1, R0)}`, r0, 'the D1 body and the drift both stay');
  await sql(D1, standIn(R0, 'null'), superUser);
  // (G5-31) a RESET ALL (proconfig NULL) on any of the three after the install refuses the rollback; the D1 body and the NULL settings stay
  for (const [k, fn] of Object.entries(FNS)) {
    await sql(D1, resetAll(fn));
    const drifted = `${await md5(D1, fn)}|${await shape(D1, fn)}|${await config(D1, fn)}`;
    r = await run(D1, ['-f', env('S27_ROLLBACK')]);
    assert.ok(!r.ok && r.error.includes(`D1_ROLLBACK_PRECONDITION_${k}_SHAPE`), `${k}\n${r.error}`);
    assert.equal(`${await md5(D1, fn)}|${await shape(D1, fn)}|${await config(D1, fn)}`, drifted, `${k}: the D1 body and the drift both stay`);
    await sql(D1, settingsBack(fn));
    assert.equal(await shape(D1, fn), shapes[k], `${k}: undone`);
  }
  r = await run(D1, ['-f', env('S27_ROLLBACK')]);
  assert.ok(r.ok, r.error);
  for (const [k, fn] of Object.entries(FNS)) {
    assert.equal(await md5(D1, fn), MD5[k as 'R1'][0], `${k}: the reviewed body`);
    assert.equal(await shape(D1, fn), shapes[k], `${k}: same OID / settings / ACL`);
  }
  const p = people[D1];
  const bare = { style: 'json', raw: JSON.stringify({ sub: p.user, role: 'authenticated', session_id: p.session }) } as Claims;
  assert.equal(await ask(D1, 'SV', bare, p.brand), 'active', 'the reviewed behaviour is back');
  r = await run(D1, ['-f', env('S27_ROLLBACK')]);
  assert.ok(!r.ok && r.error.includes('D1_ROLLBACK_NOT_APPLIED'), r.error);
  r = await run(D1, ['-f', env('S27_CANDIDATE')]);
  assert.ok(r.ok, r.error);
  assert.equal(await ask(D1, 'SV', bare, p.brand), 'AUTH_REQUIRED');
});
