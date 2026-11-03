// G5-43: the REAL consumers of G5's owner-only gates (G4 X 001-004 at 98e5cf03, G3 001 at 1dc19904; pinned by the runner) on the G5-42
// migration candidate, on throw-away databases (see the runner). G4's owner / EXECUTE mismatch is closed WITHOUT a grant: installed by the
// lifecycle owner, every G4 precondition holds and the real begin / consume run through the real G5 gates; owned by anyone else, G4
// refuses at install, or (a grant, a superuser owner, a later owner change) the read-only alignment check names it and the call fails
// closed. Nothing about managed / production; no OAuth exchange, token, Vault or SNS call (begin / consume only write local fake rows).
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, other, superUser, prefix, MIG, CHECK, C] = ['S43_OWNER', 'S43_OTHER', 'PGSUPER', 'S43_PREFIX', 'S43_MIG', 'S43_CHECK', 'S43_CONSUMERS'].map(env);
const decoder = new TextDecoder();
const test_ = enabled ? test : test.skip;
const db = (w: string) => `${prefix}_${w}`;
const INSTALL = `${MIG}/20261028090000_postona_personal_auth_install.sql`;
const ROLLBACK = `${MIG}/ROLLBACK_20261028090000_postona_personal_auth.sql`;
const G4 = ['001', '002', '003', '004'].map((n) => `${C}/g4_${n}.sql`);
const G3 = `${C}/g3_001.sql`;

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
const errorOf = (r: Result) => r.ok ? `OK ${r.out}` : `ERROR ${(r.error.match(/ERROR:\s+(.*)/u)?.[1] ?? r.error).trim()}`;
// every function in every non-system schema (body, ACL, owner, attributes) and the schema list: "nothing created / changed"
const catalog = (d: string) => sql(d, `select coalesce(string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proacl::text[], ','), '-')
  || ':' || p.proowner::regrole::text || ':' || p.provolatile::text || p.prosecdef::text || p.proisstrict::text || p.proconfig::text, ' ' order by p.oid::regprocedure::text), '')
  || ' | ' || (select string_agg(nspname || ':' || coalesce(array_to_string(nspacl::text[], ','), '-'), ' ' order by nspname) from pg_namespace where nspname !~ '^(pg_|information_schema)')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^(pg_|information_schema)'`, superUser);
// G5's own ACLs only (R1 / R0 / W2 and every private.account_lifecycle_* / postona_personal_*)
const g5Acl = (d: string) => sql(d, `select string_agg(p.oid::regprocedure::text || '=' || coalesce(array_to_string(p.proacl::text[], ','), 'NULL'), ' ' order by p.oid::regprocedure::text)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'private' and (p.proname like 'account\\_lifecycle\\_%' or p.proname like 'postona\\_personal\\_%'))
     or p.proname in ('common_account_authorization_verdict', 'common_account_bootstrap_verdict', 'common_account_worker_brand_verdict')`, superUser);
// the alignment check, always inside a READ ONLY transaction; one "code|object|detail" line per finding
async function check(d: string): Promise<string[]> {
  const r = await run(d, ['-f', CHECK], owner, true);
  assert.ok(r.ok, r.error);
  return r.out.split('\n').filter((l) => l).map((l) => l.replaceAll(owner, 'OWNER').replaceAll(other, 'OTHER').replaceAll(superUser, 'SUPER'));
}
const codes = (rows: string[]) => rows.map((l) => l.split('|').slice(0, 2).join('|'));

const A = '00000000-0000-4000-8000-000000004301';
const B = '00000000-0000-4000-8000-000000004302';
const SA = '00000000-0000-4000-8000-000000004351';
const claims = (o: Record<string, unknown>) => `'${JSON.stringify(o).replaceAll("'", "''")}'`;
const GOOD = { sub: A, role: 'authenticated', session_id: SA, is_anonymous: false };
// one call as `authenticated` with the given verified claims (the Edge forwards them unchanged), rolled back unless asked to commit
async function asPerson(d: string, c: Record<string, unknown>, statement: string, commit = false, role = 'authenticated'): Promise<string> {
  const r = await run(d, ['-c', `begin; select set_config('request.jwt.claims', ${claims(c)}, true); set local role ${role};`, '-c', statement, '-c', commit ? 'commit;' : 'rollback;']);
  return errorOf(r.ok ? { ...r, out: r.out.split('\n').pop() ?? '' } : r);
}
const hash = (n: number) => n.toString(16).padStart(64, '0');
const BEGIN = (n: number) => `select brand_id || ',' || social_account_id from public.begin_social_mobile_x_oauth_connection('${hash(n)}', 'https://example.test/cb', now() + interval '10 minutes')`;
const CONSUME = (n: number) => `select brand_id || ',' || social_account_id from public.consume_social_mobile_x_oauth_state('${hash(n)}')`;
const PRE: Record<string, string> = {};
let WS = '';

test_('static: the check is ONE read-only SELECT (no write, DDL, grant, SET or call outside its string literals) and names only catalog objects schema-qualified', () => {
  const text = Deno.readTextFileSync(CHECK);
  const code = text.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').replace(/'(?:[^']|'')*'/gu, "''");
  assert.equal(code.split(';').filter((p) => p.trim()).length, 1, 'one statement');
  assert.match(code.trim(), /^with recursive\b[\s\S]*\bselect code, object, detail from finding order by code, object, detail;$/u);
  for (const word of ['insert', 'update', 'delete', 'merge', 'create', 'alter', 'drop', 'grant', 'revoke', 'truncate', 'copy', 'call', 'do', 'set', 'execute', 'perform', 'lock', 'notify', 'nextval', 'setval', 'set_config', 'pg_advisory']) {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'iu').test(code), word);
  }
  for (const rel of code.matchAll(/\b(from|join)\s+(?!lateral\b)([a-z_.]+)/giu)) {
    const name = rel[2];
    assert.ok(name.startsWith('pg_catalog.') || ['api', 'owner', 'gate', 'fn', 'entry', 'protected', 'consumer', 'consumer_path', 'finding'].includes(name), name);
  }
});

test_('install order and the aligned install: G4 before G5 refuses; G5 then G4 001-004 and G3 001, all by the lifecycle owner -- every precondition holds with NO grant, G5\'s ACLs are unchanged, the read-only check finds nothing', async () => {
  for (const w of ['al', 'mo', 'su']) PRE[w] = await catalog(db(w));
  const early = await run(db('al'), ['-f', G4[0]]);
  assert.match(errorOf(early), /^ERROR G4X_PRECONDITION_AUTHORITY_MISSING private\.postona_personal_session\(\)/u);
  assert.equal(await catalog(db('al')), PRE.al, 'G4 before G5: nothing created');
  assert.deepEqual(codes(await check(db('al'))), ['GATE_OWNER_MISSING|private.postona_personal_session()']);
  for (const w of ['al', 'mo', 'su']) {
    const r = await run(db(w), ['-f', INSTALL]);
    assert.ok(r.ok, `${w}\n${r.error}`);
  }
  const acl = await g5Acl(db('al'));
  for (const f of [...G4, G3]) {
    const r = await run(db('al'), ['-f', f]);
    assert.ok(r.ok, `${f}\n${r.error}`);
  }
  assert.equal(await g5Acl(db('al')), acl, 'no grant on any G5 gate or entry');
  assert.deepEqual(await check(db('al')), [], 'aligned: no finding');
  // the check really sees the consumers (directly and through owner-only helpers), and they are all the lifecycle owner's definers
  const seen = await sql(db('al'), `select string_agg(p.oid::regprocedure::text || ':' || (p.proowner::regrole::text = '${owner}') || p.prosecdef, ' ' order by 1)
    from pg_proc p where p.oid in ('public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)'::regprocedure,
      'public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)'::regprocedure, 'public.consume_social_mobile_x_oauth_state(text)'::regprocedure,
      'postona_g4_x_oauth.require_person(uuid)'::regprocedure, 'postona_x_resv.caller()'::regprocedure)`);
  assert.equal(seen.split(' ').filter((s) => s.endsWith(':truetrue')).length, 5, seen);
});

test_('real calls through the aligned consumers: G4 begin / consume as `authenticated` with verified claims; anonymous, a missing is_anonymous, a non-authenticated role claim, an ended session and a moved owner epoch are refused; G3 caller() the same; R1 (G6 transport) is executable by authenticated only', async () => {
  const M = db('al');
  await sql(M, `select public.fixture_user_with_workspace('${A}'::uuid, 's43a'), public.fixture_user_with_workspace('${B}'::uuid, 's43b')`);
  WS = await sql(M, `select 'u_' || substr(md5('${A}'), 1, 24)`);
  await sql(M, `insert into auth.sessions (id, user_id, not_after) values ('${SA}', '${A}', null)`);
  const sa = await sql(M, `select 'sa_' || substr(md5('${WS}' || ':x'), 1, 24)`);
  assert.equal(await asPerson(M, GOOD, BEGIN(1), true), `OK ${WS},${sa}`, 'begin through S2-2 + S2-3 + owner epoch');
  assert.equal(await asPerson(M, GOOD, CONSUME(1)), `OK ${WS},${sa}`, 'consume re-checks the same');
  const NOT_ACTIVE = 'ERROR SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE';
  for (const [why, c] of [['anonymous', { ...GOOD, is_anonymous: true }], ['no is_anonymous', { sub: A, role: 'authenticated', session_id: SA }],
    ['is_anonymous as a string', { ...GOOD, is_anonymous: 'false' }], ['role claim anon', { ...GOOD, role: 'anon' }], ['no session_id', { sub: A, role: 'authenticated', is_anonymous: false }]] as const) {
    assert.equal(await asPerson(M, c, BEGIN(2)), NOT_ACTIVE, `begin: ${why}`);
    assert.equal(await asPerson(M, c, CONSUME(1)), NOT_ACTIVE, `consume: ${why}`);
  }
  assert.equal(errorOf(await run(M, ['-c', `begin; update auth.sessions set not_after = now() - interval '1 minute' where id = '${SA}';
    select set_config('request.jwt.claims', ${claims(GOOD)}, true); set local role authenticated;`, '-c', CONSUME(1), '-c', 'rollback;'])), NOT_ACTIVE, 'ended session');
  // A -> B -> A on the workspace's owner membership: the owner epoch moves (monotonic), so the state bound at begin is stale (G4 Q11)
  assert.equal(errorOf(await run(M, ['-c', `begin; insert into public.brand_memberships (brand_id, user_id, role) values ('${WS}', '${B}', 'owner');
    delete from public.brand_memberships where brand_id = '${WS}' and user_id = '${B}';
    select set_config('request.jwt.claims', ${claims(GOOD)}, true); set local role authenticated;`, '-c', CONSUME(1), '-c', 'rollback;'])), 'ERROR OWNER_EPOCH_CHANGED', 'moved owner epoch');
  assert.equal(await asPerson(M, GOOD, CONSUME(1)), `OK ${WS},${sa}`, 'unchanged after the rolled-back moves');
  // G3: caller() is internal (owner-only) and runs S2-2 first; inside a definer it answers the person or AUTH_REQUIRED
  assert.equal(await asPerson(M, GOOD, 'select postona_x_resv.caller()', false, owner), `OK ${A}`);
  assert.equal(await asPerson(M, { ...GOOD, is_anonymous: true }, 'select postona_x_resv.caller()', false, owner), 'ERROR POSTONA_RESV_AUTH_REQUIRED');
  assert.equal(await asPerson(M, GOOD, 'select postona_x_resv.caller()'), 'ERROR permission denied for schema postona_x_resv');
  // G6: the gateway's transport calls R1 as authenticated; nothing else is needed (no grant), and other API roles cannot
  const r1 = `select (select string_agg(k, ',' order by k) from jsonb_object_keys(public.common_account_authorization_verdict('postona', 'x_publish', '${WS}')) k)`;
  assert.equal(await asPerson(M, GOOD, r1), 'OK decision,entitlements,owner_epoch,reason,scope,session,subject,v');
  for (const role of ['anon', 'service_role']) {
    assert.equal(await asPerson(M, GOOD, r1, false, role), 'ERROR permission denied for function common_account_authorization_verdict');
  }
});

test_('misaligned owners: another owner -> G4 refuses at install and creates nothing; the grant that would make G4\'s precondition pass, a superuser owner, and a later owner change are each named by the check (and the drifted call fails closed)', async () => {
  // "mo": begin / complete / consume owned by another non-superuser role -- G4's own precondition refuses
  const MO = db('mo');
  const before = await catalog(MO);
  assert.match(errorOf(await run(MO, ['-f', G4[0]], other)), /^ERROR G4X_PRECONDITION_AUTHORITY_NOT_EXECUTABLE private\.postona_personal_session\(\)/u);
  assert.equal(await catalog(MO), before, 'nothing created');
  assert.deepEqual(await check(MO), []);
  // the "easy fix" -- EXECUTE on the three gates for that owner (plus REFERENCES, which G4's own tables need): G4's precondition then
  // holds and G4 installs, and G5's check refuses the result
  await sql(MO, `grant execute on function private.postona_personal_session(), private.postona_personal_workspace_eligibility(uuid),
    private.account_lifecycle_brand_owner_epoch(text) to ${other}; grant references on public.social_accounts, public.social_account_oauth_states to ${other}`);
  for (const f of [G4[0], G4[1], G4[3]]) {
    const r = await run(MO, ['-f', f], other);
    assert.ok(r.ok, `${f}\n${r.error}`);
  }
  const mo = codes(await check(MO));
  for (const fn of ['private.postona_personal_session()', 'private.postona_personal_workspace_eligibility(uuid)', 'private.account_lifecycle_brand_owner_epoch(text)']) {
    assert.ok(mo.includes(`GATE_ACL_WIDENED|${fn}`), `${fn}\n${mo.join('\n')}`);
  }
  for (const fn of ['postona_g4_x_oauth.require_person(uuid)', 'postona_g4_x_oauth.require_owner_epoch(text)', 'public.begin_social_mobile_x_oauth_connection(text,text,timestamp with time zone)',
    'public.consume_social_mobile_x_oauth_state(text)']) {
    assert.ok(mo.includes(`CONSUMER_OWNER_MISMATCH|${fn}`), `${fn}\n${mo.join('\n')}`);
  }
  // "su": owned by a superuser -- has_function_privilege is true for a superuser, so G4's precondition admits it; G5's check does not
  const SU = db('su');
  for (const f of [G4[0], G4[1], G4[3]]) {
    const r = await run(SU, ['-f', f], superUser);
    assert.ok(r.ok, `${f}\n${r.error}`);
  }
  const su = codes(await check(SU));
  for (const fn of ['postona_g4_x_oauth.require_person(uuid)', 'public.begin_social_mobile_x_oauth_connection(text,text,timestamp with time zone)',
    'public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)', 'public.consume_social_mobile_x_oauth_state(text)']) {
    assert.ok(su.includes(`CONSUMER_OWNER_MISMATCH|${fn}`), `${fn}\n${su.join('\n')}`);
  }
  assert.ok(!su.some((l) => l.startsWith('GATE_')), 'no gate was widened there');
  // "al": a later owner change of begin -- named by the check, and the call fails closed (no EXECUTE on the owner-only helper)
  const M = db('al');
  const ok = await catalog(M);
  await sql(M, `alter function public.begin_social_mobile_x_oauth_connection(text,text,timestamptz) owner to ${other}`, superUser);
  try {
    assert.deepEqual(codes(await check(M)), ['CONSUMER_OWNER_MISMATCH|public.begin_social_mobile_x_oauth_connection(text,text,timestamp with time zone)']);
    // the first thing the new owner may not reach (here auth.uid(); else G4's owner-only helpers, then G5's gates) refuses the call
    assert.match(await asPerson(M, GOOD, BEGIN(3)), /^ERROR permission denied for (schema auth|function lock_workspace)$/u);
  } finally {
    await sql(M, `alter function public.begin_social_mobile_x_oauth_connection(text,text,timestamptz) owner to ${owner}`, superUser);
  }
  assert.equal(await catalog(M), ok);
  assert.deepEqual(await check(M), []);
});

test_('the check names each other way out of the rule (each applied, checked, undone): a gate grant, an API role that can become the owner, R1 / R0 / W2 ACL drift, an invoker or unfixed-search_path consumer, a writable search_path schema, a view on a gate', async () => {
  const M = db('al');
  const ok = await catalog(M);
  // [apply, undo, as, the findings it must cause, prefixes of findings it may also cause]
  const cases: [string, string, string, string[], string[]?][] = [
    [`alter function private.account_lifecycle_brand_owner(text) owner to ${other}`, `alter function private.account_lifecycle_brand_owner(text) owner to ${owner}`, superUser,
      ['GATE_OWNER_DIFFERS|private.account_lifecycle_brand_owner(text)']],
    // a NULL ACL means "PUBLIC may execute" (no REVOKE ever ran): only reachable by a catalog write, here in a throw-away database
    ["update pg_catalog.pg_proc set proacl = null where oid = 'private.account_lifecycle_gate_open(text)'::regprocedure",
      `update pg_catalog.pg_proc set proacl = array['${owner}=X/${owner}']::aclitem[] where oid = 'private.account_lifecycle_gate_open(text)'::regprocedure`, superUser,
      ['GATE_ACL_WIDENED|private.account_lifecycle_gate_open(text)']],
    // the gates' owner (taken from S2-2) is a superuser: named, and every other G5 function / consumer then differs from it
    [`alter function private.postona_personal_session() owner to ${superUser}`, `alter function private.postona_personal_session() owner to ${owner}`, superUser,
      ['GATE_OWNER_IS_SUPERUSER|SUPER'], ['GATE_OWNER_DIFFERS|', 'CONSUMER_OWNER_MISMATCH|', 'ENTRY_ACL_CHANGED|']],
    ['grant execute on function private.postona_personal_session() to authenticated', 'revoke execute on function private.postona_personal_session() from authenticated', owner,
      ['GATE_ACL_WIDENED|private.postona_personal_session()']],
    ['grant execute on function private.account_lifecycle_assert_active_service_write(uuid,text) to service_role', 'revoke execute on function private.account_lifecycle_assert_active_service_write(uuid,text) from service_role', owner,
      ['GATE_ACL_WIDENED|private.account_lifecycle_assert_active_service_write(uuid,text)']],
    // (authenticator then also inherits the owner's CREATE on the consumers' search_path schemas)
    [`grant ${owner} to authenticator`, `revoke ${owner} from authenticator`, superUser, [`GATE_OWNER_REACHABLE|OWNER`], ['CONSUMER_SEARCH_PATH_WRITABLE|']],
    ['revoke execute on function public.common_account_authorization_verdict(text,text,text) from authenticated', 'grant execute on function public.common_account_authorization_verdict(text,text,text) to authenticated', owner,
      ['ENTRY_ACL_CHANGED|public.common_account_authorization_verdict(text,text,text)']],
    ['grant execute on function public.common_account_bootstrap_verdict(text,text) to anon', 'revoke execute on function public.common_account_bootstrap_verdict(text,text) from anon', owner,
      ['ENTRY_ACL_CHANGED|public.common_account_bootstrap_verdict(text,text)']],
    ['grant execute on function public.common_account_worker_brand_verdict(text,text,bigint,bigint) to authenticated', 'revoke execute on function public.common_account_worker_brand_verdict(text,text,bigint,bigint) from authenticated', owner,
      ['ENTRY_ACL_CHANGED|public.common_account_worker_brand_verdict(text,text,bigint,bigint)']],
    ["create function public.g543_probe() returns text language sql security invoker as $$ select private.postona_personal_session() $$", 'drop function public.g543_probe()', owner,
      ['CONSUMER_NOT_DEFINER|public.g543_probe()']],
    ["create function public.g543_probe() returns text language plpgsql security definer as $$ begin return private.postona_personal_workspace_eligibility(null); end $$", 'drop function public.g543_probe()', owner,
      ['CONSUMER_SEARCH_PATH|public.g543_probe()']],
    [`create function public.g543_probe() returns text language plpgsql security definer set search_path = "$user", public as $$ begin return postona_g4_x_oauth.require_person(null); end $$`, 'drop function public.g543_probe()', owner,
      ['CONSUMER_SEARCH_PATH|public.g543_probe()']],
    // a SQL-standard body keeps no source text: found through pg_depend
    ['create function public.g543_probe() returns text language sql security invoker begin atomic; select private.postona_personal_session(); end', 'drop function public.g543_probe()', owner,
      ['CONSUMER_NOT_DEFINER|public.g543_probe()']],
    // through an owner-only helper of G3 (schema-qualified), owned by the lifecycle owner, definer, empty search_path: aligned
    [`create function public.g543_probe() returns text language sql security definer set search_path = '' as $$ select postona_x_resv.caller()::text $$`, 'drop function public.g543_probe()', owner,
      []],
    // a caller of an EXPOSED entry (G4's begin, executable by authenticated) is not a gate consumer: it needs only that entry's EXECUTE
    ["create function public.g543_probe() returns text language sql security invoker as $$ select brand_id from public.begin_social_mobile_x_oauth_connection('x', 'y', now()) $$",
      'drop function public.g543_probe()', owner, []],
    ['grant create on schema public to authenticated', 'revoke create on schema public from authenticated', superUser,
      ['CONSUMER_SEARCH_PATH_WRITABLE|public.begin_social_mobile_x_oauth_connection(text,text,timestamp with time zone)',
        'CONSUMER_SEARCH_PATH_WRITABLE|public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)',
        'CONSUMER_SEARCH_PATH_WRITABLE|public.consume_social_mobile_x_oauth_state(text)']],
    ['create view public.g543_view as select private.postona_personal_session() as v', 'drop view public.g543_view', owner,
      ['NON_FUNCTION_DEPENDENT|private.postona_personal_session()']],
  ];
  for (const [apply, undo, by, expected, also = []] of cases) {
    const r = await run(M, ['-c', apply], by);
    assert.ok(r.ok, `${apply}\n${r.error}`);
    try {
      const found = codes(await check(M));
      if (expected.length) {
        for (const e of expected) assert.ok(found.includes(e), `${apply}\n${found.join('\n')}`);
        assert.ok(found.every((f) => expected.includes(f) || also.some((a) => f.startsWith(a))), `${apply}: only what it caused\n${found.join('\n')}`);
      } else {
        assert.deepEqual(found, [], `${apply}: aligned`);
      }
    } finally {
      await sql(M, undo, by);
    }
    assert.equal(await catalog(M), ok, `undone: ${undo}`);
  }
  assert.deepEqual(await check(M), []);
});

test_('install / rollback safety with real consumers: the G5 rollback refuses (drops nothing) while G4 / G3 call its gates; after the consumers are withdrawn (G4 rollbacks 004 -> 001, G3 001 schema dropped) it returns the exact pre-install catalog', async () => {
  const M = db('al');
  const installed = await catalog(M);
  const r = await run(M, ['-f', ROLLBACK]);
  assert.match(errorOf(r), /^ERROR BUNDLE_ROLLBACK_CALLERS/u);
  assert.equal(await catalog(M), installed, 'nothing dropped');
  await sql(M, `delete from postona_g4_x_oauth.state_bindings; delete from postona_g4_x_oauth.connections`);
  for (const n of ['004', '003', '002', '001']) {
    const g = await run(M, ['-f', `${C}/g4_${n}_rollback.sql`]);
    assert.ok(g.ok, `G4 ${n} rollback\n${g.error}`);
  }
  // G3 001 ships no rollback file (G3's own business); its schema holds only its own objects, so the TEST WORLD drops it
  await sql(M, 'drop schema postona_x_resv cascade');
  const back = await run(M, ['-f', ROLLBACK]);
  assert.ok(back.ok, back.error);
  assert.equal(await catalog(M), PRE.al, 'the exact catalog before G5 and its consumers');
});
