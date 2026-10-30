// G5-51 (2026-10-30): the personal workspace first run (W0) and the lifecycle owner on the REAL local Supabase runtime. Run by
// postona_personal_workspace_local_run.sh only (it builds the stack; without it every test is ignored).
// Real here: GoTrue (ES256 user JWTs, sign-up / anonymous sign-in / sign-out / password sign-in), PostgREST (the person's role and claims),
// Kong, Postgres 17.6.1.165 with the real auth schema, the lifecycle owner `postgres`, G5's world + this tree's candidates, G6's localtest
// twin of the real Edge entry (PR #582) with its ledger SQL, supabase-js 2.115.0 and G1's own snapshot read + assist client (PR #576).
// Fake: the AI provider (a server on this host). Nothing is deployed; production NO_GO.
import assert from 'node:assert/strict';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0';

const API = Deno.env.get('G5LS_API') ?? '';
const PUBLISHABLE = Deno.env.get('G5LS_PUBLISHABLE') ?? '';
const DB_PORT = Deno.env.get('G5LS_DB_PORT') ?? '';
const FAKE_PORT = Number(Deno.env.get('G5LS_FAKE_PORT') ?? '0');
const MVP = Deno.env.get('G5LS_MVP') ?? '';
const G1 = Deno.env.get('G5LS_G1') ?? '';
const G6 = Deno.env.get('G5LS_G6') ?? '';
const enabled = API !== '' && PUBLISHABLE !== '' && MVP !== '' && G1 !== '' && G6 !== '';
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };
const OWNER = 'postgres';
const SUPER = 'supabase_admin';
const LOCALTEST = 'postona-post-assist-localtest';
const W0 = 'postona_ensure_my_personal_workspace';
const decoder = new TextDecoder();

// ---- psql -------------------------------------------------------------------------------------------------------------------------------
type Result = { ok: boolean; out: string; error: string };
async function psql(user: string, args: string[]): Promise<Result> {
  const o = await new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', DB_PORT, '-U', user, '-d', 'postgres', ...args],
    env: { LC_ALL: 'C', PGOPTIONS: '-c client_min_messages=notice' }, stdout: 'piped', stderr: 'piped',
  }).output();
  return { ok: o.success, out: decoder.decode(o.stdout).trim(), error: decoder.decode(o.stderr).trim() };
}
async function sql(user: string, text: string): Promise<string> {
  const r = await psql(user, ['-c', text]);
  assert.ok(r.ok, `${text}\n${r.error}`);
  return r.out;
}
const file = (name: string, user = OWNER) => psql(user, ['-f', `${MVP}/${name}`]);
const ok = async (name: string, user = OWNER) => { const r = await file(name, user); assert.ok(r.ok, `${name}\n${r.error}`); };
const refuses = async (name: string, code: RegExp, user = OWNER) => { const r = await file(name, user); assert.ok(!r.ok, `${name} ran`); assert.match(r.error, code); };
async function preflight(user = OWNER) {
  const r = await file('MVP_RELEASE_PREFLIGHT.sql', user);
  const lines = [...r.error.matchAll(/G5_MVP_PREFLIGHT (\S+ \S+ [^\n]*)/gu)].map((m) => m[1]);
  const verdict = r.ok ? lines.find((l) => l.startsWith('VERDICT PASS'))?.slice(8) ?? `? ${r.error}` : `FAIL ${r.error.match(/G5_MVP_PREFLIGHT_FAILED ([^\n]*)/u)?.[1] ?? r.error}`;
  const line = (code: string) => lines.find((l) => l.startsWith(`${code} `)) ?? '-';
  return { verdict, lines, line };
}
// every function (body / ACL / owner / config), default ACL, role membership and relation ACL outside the system schemas (a relation's ACL
// items sorted: a revoke and a re-grant put the same item last)
const catalog = () => sql(SUPER, `select md5(string_agg(x, E'\\n' order by x)) from (
  select 'p ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '-') || ' ' || p.proowner::regrole::text || coalesce(p.proconfig::text, '') x
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^(pg_|information_schema)'
  union all select 'd ' || d.defaclrole::regrole::text || ' ' || d.defaclnamespace::text || d.defaclobjtype::text || ' ' || d.defaclacl::text from pg_default_acl d
  union all select 'm ' || m.roleid::regrole::text || ' ' || m.member::regrole::text || m.admin_option || m.inherit_option || m.set_option from pg_auth_members m
  union all select 'c ' || c.oid::regclass::text || ' ' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a), '-') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^(pg_|information_schema)') s`);
const derived = (u: string) => sql(SUPER, `select 'u_' || substr(md5('${u}'), 1, 24)`);
// <brands with the derived id>/<the person's memberships>/<the derived brand's shape>
const rows = (u: string) => sql(SUPER, `select (select count(*) from public.brands where id = 'u_' || substr(md5('${u}'), 1, 24)) || '/'
  || (select count(*) from public.brand_memberships where user_id = '${u}') || '/'
  || coalesce((select code_profile_key || ',' || display_name || ',' || is_active || ',' || publish_mode from public.brands where id = 'u_' || substr(md5('${u}'), 1, 24)), '-')`);
const PERSONAL = '1/1/social_mobile_user_v1,My Workspace,false,disabled';

// ---- the fake provider --------------------------------------------------------------------------------------------------------------------
const provider = { calls: 0 };
const { openAiBody } = enabled ? await import(`file://${G6}/ai_provider/test_support.ts`) : { openAiBody: null };
const server = enabled
  ? Deno.serve({ hostname: '127.0.0.1', port: FAKE_PORT, onListen: () => {} }, async (req) => {
    await req.text();
    provider.calls++;
    const reply = { candidates: [{ text: '週末限定のいちごタルトです。', hashtags: ['#いちごタルト'] }] };
    return new Response(JSON.stringify(openAiBody(reply, { model: 'gpt-6-luna' })), { status: 200, headers: { 'Content-Type': 'application/json' } });
  })
  : null;

// ---- people: real GoTrue sign-ups (passwords live only in this process) ----------------------------------------------------------------
type Person = { id: string; email: string; password: string; token: string; client: SupabaseClient };
const newClient = () => createClient(API, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } });
let n = 0;
async function signUp(label: string, start = true): Promise<Person> {
  const client = newClient();
  const email = `g5ls-${label.toLowerCase()}-${++n}-${crypto.randomUUID().slice(0, 6)}@example.test`;
  const password = crypto.randomUUID();
  const r = await client.auth.signUp({ email, password });
  assert.ok(r.data.session && r.data.user, r.error?.message);
  const p = { id: r.data.user.id, email, password, token: r.data.session.access_token, client };
  if (start) assert.equal(((await client.rpc('start_x_autopost_service')).data as { status: string }).status, 'active', `${label} starts POSTONA`);
  return p;
}
async function signInAgain(p: Person) {
  const r = await p.client.auth.signInWithPassword({ email: p.email, password: p.password });
  assert.ok(r.data.session, r.error?.message);
  p.token = r.data.session.access_token;
}
const part = (token: string, i: number) => JSON.parse(atob(token.split('.')[i].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(token.split('.')[i].length / 4) * 4, '=')));

// PostgREST, exactly as the app's supabase-js would call it (publishable apikey + the person's Bearer)
async function rpc(token: string | null, fn: string, args: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { apikey: PUBLISHABLE, 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { status: res.status, body };
}
// W0's answer in one word: ready:created / ready:existing / <refusal status> / HTTP<status>:<PostgREST code>
async function w0(token: string | null): Promise<string> {
  const r = await rpc(token, W0);
  if (r.status !== 200) return `HTTP${r.status}:${r.body.code}`;
  return r.body.status === 'ready' ? `ready:${r.body.created ? 'created' : 'existing'}` : String(r.body.status);
}
const verdict = async (p: Person, brand: string) => (await rpc(p.token, 'common_account_authorization_verdict', { p_app: 'postona', p_feature: 'post_generation', p_brand_id: brand })).body;

// one press of AIで下書き in G1's composer, exactly as the app does it: snapshot (real supabase-js, real RLS) -> env -> gate -> request -> send.
// The only change: functions.invoke goes to G6's localtest twin of the entry (loopback URL, fake provider).
async function app(p: Person, o: { brandId?: string; workspaceId?: string } = {}) {
  const { SupabaseSocialRepository } = await import(`${G1}/data/supabase-repository.ts`);
  const assist = await import(`${G1}/features/schedule/post-assist.ts`);
  const client = new Proxy(p.client, {
    get(t, k) {
      if (k === 'functions') return { invoke: (_name: string, o2: unknown) => t.functions.invoke(LOCALTEST, o2 as never) };
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const snap = await new SupabaseSocialRepository(client).readSnapshot();
  const workspaceId: string | null = o.workspaceId ?? snap.data.workspace?.id ?? null;
  const e = { client, accessToken: p.token, userId: p.id, brandId: o.brandId ?? workspaceId, workspaceId, platform: 'x', preview: false };
  const request = assist.newAssistRequest(e, () => crypto.randomUUID(), 'row-1', 'draft', '', { notes: 'いちごタルト 週末限定', instruction: '' });
  const outcome = request === null ? null : await assist.sendAssist(e, request);
  return { snapshot: snap.state as string, workspaceId: snap.data.workspace?.id ?? null, outcome: outcome === null ? 'NOT_SENT' : String(outcome.kind) };
}

// W0's body as a CREATE OR REPLACE (keeps the ACL), from an install file: this tree's, or PR #585's (G5LS_W0_585, read-only archive)
async function w0Body(path: string): Promise<string> {
  const src = await Deno.readTextFile(path);
  const start = src.indexOf('create function public.postona_ensure_my_personal_workspace()');
  assert.ok(start > 0, path);
  return src.slice(start, src.indexOf('end $$;', start) + 'end $$;'.length).replace('create function', 'create or replace function');
}
const installBody = async (text: string) => { const r = await psql(OWNER, ['-c', text]); assert.ok(r.ok, r.error); };

// H1 P2 F1, deterministic: a backend writer (postgres, or service_role through SET ROLE) inserts a FOREIGN brand under the person's derived
// id -- active, live, the personal kind -- and holds its transaction open; W0 is called meanwhile (S2-3 still sees the id absent, its brand
// insert waits on the writer's row); the writer commits; W0 resumes and meets the conflict.
async function foreignRace(p: Person, writer: 'postgres' | 'service_role'): Promise<string> {
  const id = await derived(p.id);
  const child = new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', DB_PORT, '-U', OWNER, '-d', 'postgres'],
    env: { LC_ALL: 'C' }, stdin: 'piped', stdout: 'piped', stderr: 'piped',
  }).spawn();
  const stdin = child.stdin.getWriter();
  const out = child.stdout.getReader();
  const say = (t: string) => stdin.write(new TextEncoder().encode(t + '\n'));
  await say(`begin;${writer === 'service_role' ? ' set local role service_role;' : ''}`);
  await say(`insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key) values ('${id}', 'Backend', true, 'live', 'social_mobile_user_v1');`);
  await say(`select 'g5ls-held-' || current_user;`);
  let seen = '';
  while (!seen.includes('g5ls-held-')) {
    const { value, done } = await out.read();
    assert.ok(!done, 'the writer exited early');
    seen += decoder.decode(value);
  }
  assert.ok(seen.includes(`g5ls-held-${writer}`), seen);
  const call = w0(p.token);
  let waiting = false;
  for (let i = 0; i < 100 && !waiting; i++) {
    waiting = (await sql(SUPER, `select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%${W0}%'`)) === '1';
    if (!waiting) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(waiting, 'W0 waits on the writer\'s row');
  await say('commit;');
  await stdin.close();
  out.releaseLock();
  const status = await child.status;
  assert.ok(status.success, 'the writer committed');
  return await call;
}
// the foreign row and the person's memberships after the race: <display_name,is_active,publish_mode>/<memberships of the person>/<memberships of the brand>
const foreignAfter = (u: string) => sql(SUPER, `select (select display_name || ',' || is_active || ',' || publish_mode from public.brands where id = 'u_' || substr(md5('${u}'), 1, 24)) || '/'
  || (select count(*) from public.brand_memberships where user_id = '${u}') || '/'
  || (select count(*) from public.brand_memberships where brand_id = 'u_' || substr(md5('${u}'), 1, 24))`);

const people: Record<string, Person> = {};
const PRE = { catalog: '' };

// ---- F2: who can own the profile on the Supabase image -------------------------------------------------------------------------------
Deno.test({ name: 'F2: the image\'s postgres cannot hand USAGE on auth or the auth.users row lock to a dedicated owner; the preflight and W0 install name it; the lock fails as G6-26 saw', ...opts }, async () => {
  assert.equal(await sql(SUPER, "select rolsuper || ',' || rolbypassrls from pg_roles where rolname = 'postgres'"), 'false,true', 'postgres: not a superuser, BYPASSRLS');
  assert.equal(await sql(SUPER, `select string_agg(c.relname || ':' || c.relrowsecurity, ' ' order by c.relname) from pg_class c where c.relnamespace = 'auth'::regnamespace and c.relname in ('users', 'sessions')`),
    'sessions:true users:true', 'RLS is enabled on the auth tables');
  assert.equal(await sql(SUPER, `select string_agg(table_name || ':' || privilege_type || ':' || is_grantable, ' ' order by table_name, privilege_type) from information_schema.role_table_grants
    where table_schema = 'auth' and table_name in ('users', 'sessions') and grantee = 'postgres' and privilege_type in ('SELECT', 'UPDATE')`),
    'sessions:SELECT:YES sessions:UPDATE:NO users:SELECT:YES users:UPDATE:NO', 'postgres may pass on SELECT only');
  await sql(OWNER, "create role g5ls_dedicated login password 'postgres' nosuperuser bypassrls");
  try {
    const g = await psql(OWNER, ['-c', 'grant usage on schema auth to g5ls_dedicated', '-c', 'grant update (updated_at) on auth.users to g5ls_dedicated',
      '-c', 'grant select on auth.users, auth.sessions to g5ls_dedicated']);
    assert.ok(g.ok, g.error);
    assert.match(g.error, /no privileges were granted for "auth"/u);
    assert.match(g.error, /no privileges were granted for column "updated_at" of relation "users"/u);
    assert.equal(await sql(SUPER, "select has_schema_privilege('g5ls_dedicated', 'auth', 'USAGE') || ',' || has_any_column_privilege('g5ls_dedicated', 'auth.users', 'UPDATE') || ',' || has_table_privilege('g5ls_dedicated', 'auth.users', 'SELECT')"),
      'false,false,true');
    let p = await preflight('g5ls_dedicated');
    assert.match(p.verdict, /^FAIL .*PF_OWNER_AUTH/u, p.lines.join('\n'));
    assert.match(p.line('PF_OWNER_AUTH'), /^PF_OWNER_AUTH FAIL .*no USAGE on schema auth/u);
    await refuses('MVP_W0_INSTALL.sql', /W0_PRECONDITION_OWNER_AUTH schema/u, 'g5ls_dedicated');
    // USAGE through a membership in authenticated (postgres holds its ADMIN option): the read works, the row lock still does not
    await sql(OWNER, 'grant authenticated to g5ls_dedicated');
    p = await preflight('g5ls_dedicated');
    assert.match(p.line('PF_OWNER_AUTH'), /^PF_OWNER_AUTH FAIL .*cannot lock auth\.users rows/u, p.lines.join('\n'));
    await refuses('MVP_W0_INSTALL.sql', /W0_PRECONDITION_OWNER_AUTH tables/u, 'g5ls_dedicated');
    const lock = await psql('g5ls_dedicated', ['-c', 'begin', '-c', 'select 1 from auth.users limit 1 for key share', '-c', 'rollback']);
    assert.ok(!lock.ok);
    assert.match(lock.error, /permission denied for table users/u, 'the error G6-26 F2 met in ensure_my_profile / start_x_autopost_service');
  } finally {
    await sql(OWNER, 'revoke authenticated from g5ls_dedicated; revoke select on auth.users, auth.sessions from g5ls_dedicated; drop role g5ls_dedicated');
  }
});

// ---- the release, step by step, as postgres ---------------------------------------------------------------------------------------------
Deno.test({ name: 'release as postgres: preflight absent -> MVP_INSTALL -> W0 install -> R1 grant -> (W0 still owner-only: a person is refused) -> W0 grant; every step checked by the preflight', ...opts }, async () => {
  PRE.catalog = await catalog();
  let p = await preflight();
  assert.equal(p.verdict, 'PASS phase=absent warnings=0', p.lines.join('\n'));
  assert.deepEqual(p.lines.filter((l) => !l.startsWith('VERDICT')).map((l) => l.split(' ').slice(0, 2).join(' ')),
    ['PF_OWNER PASS', 'PF_P1 PASS', 'PF_P3 PASS', 'PF_APP_READ PASS', 'PF_BRANDS PASS', 'PF_OWNER_AUTH PASS', 'PF_AUTH PASS', 'PF_ROLE_GRAPH PASS', 'PF_AUTHENTICATOR PASS', 'PF_DEFAULT_ACL PASS', 'PF_PHASE PASS', 'PF_W0 PASS', 'PF_DATA PASS']);
  assert.match(p.line('PF_W0'), /absent/u);
  await refuses('MVP_W0_INSTALL.sql', /W0_PRECONDITION_GATE private\.postona_personal_session\(\)/u);
  assert.equal(await catalog(), PRE.catalog, 'the preflight and a refused install change nothing');
  await ok('MVP_INSTALL.sql');
  await ok('MVP_W0_INSTALL.sql');
  p = await preflight();
  assert.equal(p.verdict, 'PASS phase=installed warnings=0', p.lines.join('\n'));
  assert.match(p.line('PF_W0'), /installed \(owner-only\)/u);
  await refuses('MVP_W0_INSTALL.sql', /W0_PRECONDITION_EXISTS/u);
  await ok('MVP_R1_EXECUTE_GRANT.sql');
  people.A = await signUp('A');
  assert.equal(await w0(people.A.token), 'HTTP403:42501', 'W0 installed but not granted');
  assert.equal(await rows(people.A.id), '0/0/-');
  p = await preflight();
  assert.equal(p.verdict, 'PASS phase=granted warnings=1', p.lines.join('\n'));
  assert.match(p.line('PF_DATA_NO_WORKSPACE'), /^PF_DATA_NO_WORKSPACE WARN 1 /u);
  await ok('MVP_W0_EXECUTE_GRANT.sql');
  await ok('MVP_W0_EXECUTE_GRANT.sql');   // idempotent
  assert.match((await preflight()).line('PF_W0'), /granted \(owner \+ authenticated\)/u);
});

// ---- the first run --------------------------------------------------------------------------------------------------------------------
Deno.test({ name: 'first run: sign-up -> (W0 before POSTONA: refused, nothing written) -> start -> W0 creates -> W0 again is the same row -> G1 reads it -> AI draft through G6 gives candidates; no X connection', ...opts }, async () => {
  const B = people.B = await signUp('B', false);
  assert.deepEqual([part(B.token, 0).alg, part(B.token, 1).role, part(B.token, 1).is_anonymous, typeof part(B.token, 1).session_id], ['ES256', 'authenticated', false, 'string'], 'a real GoTrue access token');
  const before = await app(B);
  assert.deepEqual([before.snapshot, before.workspaceId, before.outcome], ['blocked', null, 'NOT_SENT'], 'G1 before the workspace: no workspace, nothing sent');
  assert.equal(await w0(B.token), 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'POSTONA not started yet');
  assert.equal(await rows(B.id), '0/0/-');
  assert.equal(((await B.client.rpc('start_x_autopost_service')).data as { status: string }).status, 'active');
  const r = await rpc(B.token, W0);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ready', created: true, workspace_id: await derived(B.id) });
  assert.equal(await rows(B.id), PERSONAL);
  assert.equal(await w0(B.token), 'ready:existing', 'idempotent');
  assert.equal(await rows(B.id), PERSONAL);
  assert.equal(await sql(SUPER, `select count(*) from public.social_accounts where brand_id = '${await derived(B.id)}'`), '0', 'no X account row: X is not needed');
  const calls = provider.calls;
  const after = await app(B);
  assert.deepEqual([after.snapshot, after.workspaceId, after.outcome], ['ready', await derived(B.id), 'candidates'], 'G1 -> G6 -> G5 on the W0 workspace');
  assert.equal(provider.calls, calls + 1);
  const v = await verdict(B, await derived(B.id));
  assert.deepEqual([v.decision, String(v.owner_epoch).startsWith('g5pv:')], ['allow', true]);
  // A (released before the grant) runs the same first run now
  assert.equal(await w0(people.A.token), 'ready:created');
  assert.equal((await app(people.A)).outcome, 'candidates');
  assert.equal((await preflight()).verdict, 'PASS phase=granted warnings=0', 'every active POSTONA person now has a workspace');
});

// ---- refusals ---------------------------------------------------------------------------------------------------------------------------
Deno.test({ name: 'refused, nothing written: anonymous, no token, logged out, expired session (then a new sign-in works), another person cannot be named; another workspace is refused by G1 and by G5', ...opts }, async () => {
  const anon = newClient();
  const s = await anon.auth.signInAnonymously();
  assert.ok(s.data.session && s.data.user, s.error?.message);
  assert.equal(part(s.data.session.access_token, 1).is_anonymous, true);
  assert.equal(await w0(s.data.session.access_token), 'AUTH_REQUIRED');
  assert.equal(await rows(s.data.user.id), '0/0/-');
  assert.equal(await w0(null), 'HTTP401:42501', 'no Bearer: the anon role may not call it');

  const C = await signUp('C');
  const old = C.token;
  await C.client.auth.signOut();
  assert.equal(await w0(old), 'SESSION_REVOKED', 'the JWT is still within exp; the session row is gone');
  assert.equal(await rows(C.id), '0/0/-');

  const D = await signUp('D');
  await sql(SUPER, `update auth.sessions set not_after = now() - interval '1 minute' where user_id = '${D.id}'`);
  assert.equal(await w0(D.token), 'SESSION_EXPIRED');
  assert.equal(await rows(D.id), '0/0/-');
  await signInAgain(D);
  assert.equal(await w0(D.token), 'ready:created', 're-authorized');

  // W0 takes no argument: nobody can name another person
  const named = await rpc(people.B.token, W0, { p_user: people.A.id });
  assert.deepEqual([named.status, named.body.code], [404, 'PGRST202']);
  // B aims at A's workspace: G1's own gate does not send; skipping G1's gate, G6 asks G5, which refuses
  assert.equal((await app(people.B, { brandId: await derived(people.A.id) })).outcome, 'NOT_SENT');
  assert.equal((await app(people.B, { brandId: await derived(people.A.id), workspaceId: await derived(people.A.id) })).outcome, 'not_available');
  assert.equal(await rows(people.A.id), PERSONAL);
});

// ---- concurrency --------------------------------------------------------------------------------------------------------------------------
Deno.test({ name: 'concurrent: W0 || W0 of one person -> one created, one existing; W0 || the X OAuth begin RPC -> one workspace; begin first -> W0 adopts it', ...opts }, async () => {
  for (let i = 0; i < 6; i++) {
    const P = await signUp(`P${i}`);
    const got = (await Promise.all([w0(P.token), w0(P.token)])).sort();
    assert.deepEqual(got, ['ready:created', 'ready:existing'], `P${i}`);
    assert.equal(await rows(P.id), PERSONAL, `P${i}`);
  }
  const begin = (p: Person) => rpc(p.token, 'begin_social_mobile_x_oauth_connection', {
    p_state_hash: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join(''),
    p_redirect_uri: 'kabumori://oauth/x', p_expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  const beginRace: string[] = [];
  for (let i = 0; i < 4; i++) {
    const Q = await signUp(`Q${i}`);
    const [a, b] = await Promise.all([w0(Q.token), begin(Q)]);
    // (G5-02 task 1) W0 writes both rows or none: if the begin RPC took the derived id first, W0 refuses without joining it; the refusal
    // wrote nothing, so the next call finds the person's own workspace
    assert.match(a, /^(ready:(created|existing)|OWN_WORKSPACE_CONFLICT)$/u, `Q${i}`);
    beginRace.push(a);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal((b.body as unknown as Array<{ brand_id: string }>)[0].brand_id, await derived(Q.id));
    assert.equal(await rows(Q.id), PERSONAL, `Q${i}`);
    assert.equal(await w0(Q.token), 'ready:existing', `Q${i} again`);
  }
  console.log(`W0 || begin RPC answers: ${beginRace.join(' ')}`);
  const R = await signUp('R');
  assert.equal((await begin(R)).status, 200);
  assert.equal(await w0(R.token), 'ready:existing', 'the begin RPC created it first');
  assert.equal(await rows(R.id), PERSONAL);
});

// ---- H1 P2 F1 (G5-02 task 1) ---------------------------------------------------------------------------------------------------------
Deno.test({ name: 'F1: a backend writer (postgres / service_role) takes the derived id between S2-3 and the insert -> PR #585\'s body joins it and says created (FAIL reproduced); this body refuses, writes nothing, leaves the foreign row as it was (PASS)', ...opts }, async () => {
  const fixed = await w0Body(`${MVP}/MVP_W0_INSTALL.sql`);
  const before = await w0Body(Deno.env.get('G5LS_W0_585') ?? '');
  try {
    await installBody(before);
    for (const writer of ['postgres', 'service_role'] as const) {
      const p = await signUp(`F1old-${writer}`);
      assert.equal(await foreignRace(p, writer), 'ready:created', `PR #585 body, ${writer}: the defect`);
      assert.equal(await foreignAfter(p.id), 'Backend,true,live/1/1', `PR #585 body, ${writer}: the person was made owner of the foreign active / live brand`);
    }
  } finally {
    await installBody(fixed);
  }
  assert.equal(await sql(SUPER, `select md5(prosrc) from pg_proc where oid = 'public.${W0}()'::regprocedure`), '3b3cc024c7816fa5e86a65e71f90060c');
  for (const writer of ['postgres', 'service_role'] as const) {
    const p = await signUp(`F1-${writer}`);
    assert.equal(await foreignRace(p, writer), 'OWN_WORKSPACE_CONFLICT', writer);
    assert.equal(await foreignAfter(p.id), 'Backend,true,live/0/0', `${writer}: no membership, the foreign row untouched`);
    // later calls meet it at step 3: S2-3 refuses the committed foreign row (personal kind, no owner) -- no repair, no adoption
    assert.equal(await w0(p.token), 'WORKSPACE_OWNER_UNKNOWN', `${writer}: and every later call refuses it too`);
    assert.equal(await foreignAfter(p.id), 'Backend,true,live/0/0');
    assert.equal((await app(p)).outcome, 'NOT_SENT', `${writer}: G1 has no workspace to send for`);
  }
  assert.match((await preflight()).line('PF_W0'), /^PF_W0 PASS granted/u);
});

// ---- lifecycle ---------------------------------------------------------------------------------------------------------------------------
Deno.test({ name: 'lifecycle: service ended -> W0 refused (no write) and G1 not available; restarted -> W0 the same row, a new g5pv generation; account locked -> refused', ...opts }, async () => {
  const A = people.A;
  const ws = await derived(A.id);
  const g1 = String((await verdict(A, ws)).owner_epoch);
  const lv = Number(await sql(SUPER, `select lifecycle_version from public.common_accounts where user_id = '${A.id}'`));
  await sql(SUPER, `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A.id}' and service_key = 'x_autopost'`);
  assert.equal(await w0(A.token), 'SERVICE_NOT_ACTIVE');
  assert.equal((await app(A)).outcome, 'not_available');
  assert.equal((await verdict(A, ws)).decision, 'deny');
  const re = await A.client.rpc('reactivate_x_autopost_service', { p_expected_lifecycle_version: Number(await sql(SUPER, `select lifecycle_version from public.common_accounts where user_id = '${A.id}'`)) });
  assert.equal((re.data as { status: string } | null)?.status, 'active', JSON.stringify(re.error));
  assert.equal(await w0(A.token), 'ready:existing');
  assert.equal(await rows(A.id), PERSONAL);
  const g2 = String((await verdict(A, ws)).owner_epoch);
  assert.ok(g1.startsWith('g5pv:') && g2.startsWith('g5pv:') && g1 !== g2 && Number(g2.slice(5)) > lv, `${g1} -> ${g2}: a check taken before the end is not this generation (A-B-A)`);
  assert.equal((await app(A)).outcome, 'candidates');

  const L = await signUp('L');
  await sql(SUPER, `update public.common_accounts set status = 'locked' where user_id = '${L.id}'`);
  assert.equal(await w0(L.token), 'ACCOUNT_LOCKED');
  assert.equal(await rows(L.id), '0/0/-');
});

// ---- shapes W0 must not adopt or repair ------------------------------------------------------------------------------------------------
Deno.test({ name: 'not adopted, not repaired: a foreign brand under the derived id, another membership, a derived brand owned by someone else, a concurrent writer leaving a shared shape (both inserts undone)', ...opts }, async () => {
  const E = await signUp('E');
  await sql(SUPER, `insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key) values ('${await derived(E.id)}', 'Other', true, 'live', 'kabumori_brand')`);
  assert.equal(await w0(E.token), 'OWN_WORKSPACE_CONFLICT');
  assert.equal(await rows(E.id), '1/0/kabumori_brand,Other,true,live');

  const F = await signUp('F');
  await sql(SUPER, `insert into public.brands (id, display_name, code_profile_key) values ('g5ls_shared_${n}', 'Shared', 'shared_v1');
    insert into public.brand_memberships (brand_id, user_id, role) values ('g5ls_shared_${n}', '${F.id}', 'member')`);
  assert.equal(await w0(F.token), 'OTHER_WORKSPACE_MEMBERSHIP');
  assert.equal(await rows(F.id), '0/1/-');

  const G = await signUp('G');
  const H = await signUp('H', false);
  await sql(SUPER, `insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key) values ('${await derived(G.id)}', 'My Workspace', false, 'disabled', 'social_mobile_user_v1');
    insert into public.brand_memberships (brand_id, user_id, role) values ('${await derived(G.id)}', '${H.id}', 'owner')`);
  assert.equal(await w0(G.token), 'OWN_WORKSPACE_CONFLICT');
  assert.equal(await rows(G.id), '1/0/social_mobile_user_v1,My Workspace,false,disabled');

  // a writer that adds a second member while W0 inserts (a test-only trigger): S2-3 then answers not own, and W0 undoes both of its rows
  const J = await signUp('J');
  const K = await signUp('K', false);
  await sql(SUPER, `create function public.g5ls_test_intruder() returns trigger language plpgsql as $f$ begin
      insert into public.brand_memberships (brand_id, user_id, role) values (new.id, '${K.id}', 'member'); return null; end $f$;
    create trigger g5ls_test_intruder after insert on public.brands for each row when (new.id = '${await derived(J.id)}') execute function public.g5ls_test_intruder()`);
  try {
    assert.equal(await w0(J.token), 'OWN_WORKSPACE_CONFLICT');
    assert.equal(await rows(J.id), '0/0/-');
    assert.equal(await sql(SUPER, `select count(*) from public.brand_memberships where user_id = '${K.id}'`), '0', 'the intruder row is undone with W0\'s');
  } finally {
    await sql(SUPER, 'drop trigger g5ls_test_intruder on public.brands; drop function public.g5ls_test_intruder()');
  }
});

// ---- G5-02 #2: G1 #592's first run reads the personal workspace's kind (brands.code_profile_key) with the person's own JWT -----------------
const G1B = Deno.env.get('G5LS_G1B') ?? '';
// the relation ACL / row security the snapshot reads through, as the catalog has it now
const readAcl = () => sql(SUPER, `select string_agg(x, ' ' order by x) from (
  select c.relname || ':rls=' || c.relrowsecurity || ':force=' || c.relforcerowsecurity x from pg_class c where c.oid in ('public.brands'::regclass, 'public.brand_memberships'::regclass)
  union all select c.relname || ':acl=' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a), '-') from pg_class c where c.oid in ('public.brands'::regclass, 'public.brand_memberships'::regclass)
  union all select 'col:' || attrelid::regclass::text || '.' || attname || ':' || coalesce(attacl::text, '-') from pg_attribute where attrelid in ('public.brands'::regclass, 'public.brand_memberships'::regclass) and attnum > 0 and attacl is not null
  union all select 'policy:' || polrelid::regclass::text || ':' || polname || ':' || polcmd::text || ':' || polpermissive || ':' || array_to_string(array(select coalesce(r.rolname, 'public') from unnest(polroles) u left join pg_roles r on r.oid = u), ',')
    || ':' || coalesce(pg_get_expr(polqual, polrelid), '-') from pg_policy where polrelid in ('public.brands'::regclass, 'public.brand_memberships'::regclass)) s`);
// can <role> SELECT these columns (table or column privilege)
const canRead = (role: string) => sql(SUPER, `select string_agg(t || '.' || c || ':' || has_column_privilege('${role}', t, c, 'SELECT'), ' ' order by t, c) from (values
  ('public.brands', 'id'), ('public.brands', 'display_name'), ('public.brands', 'is_active'), ('public.brands', 'publish_mode'), ('public.brands', 'code_profile_key'),
  ('public.brand_memberships', 'brand_id'), ('public.brand_memberships', 'role'), ('public.brand_memberships', 'user_id')) v(t, c)`);
// G1 #592's first run, as PersonalWorkspaceProvider + usePostAssistEnv decide it: W0 through G1's own call (one bounded retry on
// OWN_WORKSPACE_CONFLICT) -> G1's own snapshot read -> 'ready' only when the snapshot's personal workspace is W0's -> one press of
// AIで下書き through G1's own gate (the composer's brand is the snapshot's workspace). functions.invoke goes to G6's localtest twin.
async function firstRun(p: Person, o: { brandId?: string } = {}) {
  const ws = await import(`${G1B}/domain/personal-workspace.ts`);
  const { SupabaseSocialRepository } = await import(`${G1B}/data/supabase-repository.ts`);
  const assist = await import(`${G1B}/features/schedule/post-assist.ts`);
  const client = new Proxy(p.client, {
    get(t, k) {
      if (k === 'functions') return { invoke: (_name: string, o2: unknown) => t.functions.invoke(LOCALTEST, o2 as never) };
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const decided = await ws.ensurePersonalWorkspace(ws.createPersonalWorkspaceCall({ url: API, apiKey: PUBLISHABLE, accessToken: p.token }), new AbortController().signal);
  const snap = await new SupabaseSocialRepository(client).readSnapshot();
  const personal: string | null = snap.data.personalWorkspaceId ?? null;
  const view: string = decided.kind === 'ready' ? (personal === decided.workspaceId ? 'ready' : 'unconfirmed') : decided.kind;
  const e = {
    client, accessToken: p.token, userId: p.id, brandId: o.brandId ?? snap.data.workspace?.id ?? '', workspaceId: view === 'ready' ? decided.workspaceId : null,
    platform: 'x', preview: false, loginRefused: view === 'relogin', workspaceSetup: view === 'relogin' ? 'idle' : view, retryWorkspaceSetup: null,
  };
  const request = assist.newAssistRequest(e, () => crypto.randomUUID(), 'row-1', 'draft', '', { notes: 'いちごタルト 週末限定', instruction: '' });
  const outcome = request === null ? `NOT_SENT:${assist.assistBlock(e)}` : String((await assist.sendAssist(e, request))?.kind);
  return { w0: decided.kind === 'ready' ? `ready:${decided.created ? 'created' : 'existing'}` : String(decided.kind), snapshot: String(snap.state), personal, view, outcome };
}

// what anon / authenticated may write on brands (table privileges)
const brandWrites = () => sql(SUPER, `select coalesce(string_agg(r || ':' || k, ' ' order by r, k), '-') from unnest(array['anon', 'authenticated']) r,
  unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) k where has_table_privilege(r, 'public.brands', k)`);
const code = (r: { error: { code?: string } | null; status: number }) => `${r.status}:${r.error?.code ?? '-'}`;

Deno.test({ name: 'G5-02 #2 G1 #592 on the real JWT: the person reads their own brand\'s kind (code_profile_key) -> ready -> candidates; another person, no login, a signed-out login, an ended service, a second membership and a repeated W0 conflict never become ready and send nothing', ...opts }, async () => {
  // read-back of the world the suite runs on (the runner's stand-in for the brands owner's hardening; the world as built is the next test)
  assert.doesNotMatch(await canRead('authenticated'), /:false/u, 'the person may read every snapshot column, code_profile_key included');
  assert.doesNotMatch(await canRead('anon'), /:true/u);
  assert.equal(await brandWrites(), '-', 'no API write on brands');
  assert.match(await readAcl(), /brand_memberships:rls=true:force=false .*brands:rls=true:force=false/u);
  const pf = await preflight();
  assert.match(pf.verdict, /^PASS phase=granted /u, pf.lines.join('\n'));
  assert.match(pf.line('PF_APP_READ'), /^PF_APP_READ PASS/u);
  assert.match(pf.line('PF_BRANDS'), /^PF_BRANDS PASS/u);
  assert.equal(pf.line('PF_BRANDS_POLICIES'), '-');

  // the person: W0 creates, G1's snapshot shows the same id by its kind, G1's gate sends; again: existing, the same
  const P = await signUp('P');
  const pws = await derived(P.id);
  const calls = provider.calls;
  assert.deepEqual(await firstRun(P), { w0: 'ready:created', snapshot: 'ready', personal: pws, view: 'ready', outcome: 'candidates' });
  assert.deepEqual(await firstRun(P), { w0: 'ready:existing', snapshot: 'ready', personal: pws, view: 'ready', outcome: 'candidates' });
  assert.equal(provider.calls, calls + 2);
  assert.deepEqual((await P.client.from('brands').select('id,code_profile_key')).data, [{ id: pws, code_profile_key: 'social_mobile_user_v1' }], 'P\'s JWT reads its own brand only');

  // another person: their own workspace only; P's brand is neither visible nor writable; G1's gate refuses P's id
  const Q = await signUp('Q');
  const qws = await derived(Q.id);
  assert.deepEqual(await firstRun(Q), { w0: 'ready:created', snapshot: 'ready', personal: qws, view: 'ready', outcome: 'candidates' });
  assert.deepEqual((await Q.client.from('brands').select('id').eq('id', pws)).data, []);
  assert.deepEqual((await Q.client.from('brands').select('id')).data, [{ id: qws }]);
  assert.equal(code(await Q.client.from('brands').update({ is_active: true, publish_mode: 'live' }).eq('id', pws)), '403:42501');
  assert.equal(code(await Q.client.from('brands').insert({ id: `g5ls_q_${n}`, display_name: 'Q', code_profile_key: 'social_mobile_user_v1' })), '403:42501');
  assert.equal(code(await Q.client.from('brands').delete().eq('id', pws)), '403:42501');
  const anon = newClient();
  assert.equal(code(await anon.from('brands').select('id')), '401:42501');
  assert.equal(code(await anon.from('brands').insert({ id: `g5ls_anon_${n}`, display_name: 'anon' })), '401:42501');
  assert.equal(await rows(P.id), PERSONAL, 'P\'s workspace is untouched');
  const sent = provider.calls;
  assert.equal((await firstRun(Q, { brandId: pws })).outcome, 'NOT_SENT:other_workspace');

  // no login: G1's snapshot is blocked and its gate sends nothing
  const none = await (async () => {
    const { SupabaseSocialRepository } = await import(`${G1B}/data/supabase-repository.ts`);
    return (await new SupabaseSocialRepository(newClient()).readSnapshot()).state;
  })();
  assert.equal(none, 'blocked');

  // a signed-out login (its JWT still within exp): W0 SESSION_REVOKED -> relogin; nothing sent
  const C = await signUp('C2');
  await C.client.auth.signOut();
  const c = await firstRun(C);
  assert.deepEqual([c.w0, c.view, c.outcome], ['relogin', 'relogin', 'NOT_SENT:relogin']);
  assert.equal(await rows(C.id), '0/0/-');

  // an ended service: W0 SERVICE_NOT_ACTIVE -> service_inactive; nothing sent, the workspace stays
  const E = await signUp('E2');
  assert.equal((await firstRun(E)).view, 'ready');
  const sentE = provider.calls;
  await sql(SUPER, `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${E.id}' and service_key = 'x_autopost'`);
  const e = await firstRun(E);
  assert.deepEqual([e.w0, e.view, e.outcome], ['service_inactive', 'service_inactive', 'NOT_SENT:workspace_service_inactive']);
  assert.equal(provider.calls, sentE);
  assert.equal(await rows(E.id), PERSONAL);

  // a second membership (a shared brand): S2-3 still answers own for the sole personal workspace (G5-51), and G1 finds that one by its kind
  // among the person's brands -> ready on the personal workspace only
  const M = await signUp('M');
  const mws = await derived(M.id);
  assert.equal((await firstRun(M)).view, 'ready');
  await sql(SUPER, `insert into public.brands (id, display_name, code_profile_key) values ('g5ls_m2_${n}', 'Shared', 'shared_v1');
    insert into public.brand_memberships (brand_id, user_id, role) values ('g5ls_m2_${n}', '${M.id}', 'member')`);
  assert.deepEqual(await firstRun(M), { w0: 'ready:existing', snapshot: 'ready', personal: mws, view: 'ready', outcome: 'candidates' });
  assert.equal((await firstRun(M, { brandId: `g5ls_m2_${n}` })).outcome, 'NOT_SENT:other_workspace', 'the shared brand is never sent');
  // a second brand of the personal kind owned: G1 names neither (nothing is guessed), W0 refuses (support), nothing sent
  await sql(SUPER, `insert into public.brands (id, display_name, code_profile_key) values ('g5ls_m3_${n}', 'Second', 'social_mobile_user_v1');
    insert into public.brand_memberships (brand_id, user_id, role) values ('g5ls_m3_${n}', '${M.id}', 'owner')`);
  const sentM = provider.calls;
  const m2 = await firstRun(M);
  assert.deepEqual([m2.w0, m2.personal, m2.view, m2.outcome], ['support', null, 'support', 'NOT_SENT:workspace_support']);
  assert.equal(provider.calls, sentM);

  // W0 conflict on both of G1's calls (a test-only concurrent writer adds a member on every insert): G1 asks once more, then support
  const J = await signUp('J2');
  const K = await signUp('K2', false);
  await sql(SUPER, `create function public.g5ls_test_intruder() returns trigger language plpgsql as $f$ begin
      insert into public.brand_memberships (brand_id, user_id, role) values (new.id, '${K.id}', 'member'); return null; end $f$;
    create trigger g5ls_test_intruder after insert on public.brands for each row when (new.id = '${await derived(J.id)}') execute function public.g5ls_test_intruder()`);
  try {
    const j = await firstRun(J);
    assert.deepEqual([j.w0, j.personal, j.view, j.outcome], ['support', null, 'support', 'NOT_SENT:workspace_support']);
    assert.equal(await rows(J.id), '0/0/-', 'both refusals wrote nothing');
  } finally {
    await sql(SUPER, 'drop trigger g5ls_test_intruder on public.brands; drop function public.g5ls_test_intruder()');
  }
  assert.equal(provider.calls, sent + 3, 'after P and Q only the three ready runs (E2, M, M with a shared membership) reached the provider');
});

Deno.test({ name: 'G5-02 #2 brands ACL: the world as built (row security off, the image\'s default write grants) lets a person read and change another workspace and anon insert -- PF_BRANDS FAIL; code_profile_key not granted -> G1 unconfirmed, nothing sent, PF_APP_READ FAIL; restored', ...opts }, async () => {
  const base = { catalog: await catalog(), acl: await readAcl() };
  const R = await signUp('R');
  const S = await signUp('S');
  const rws = await derived(R.id);
  const sws = await derived(S.id);
  assert.equal((await firstRun(R)).view, 'ready');
  assert.equal((await firstRun(S)).view, 'ready');

  // the world exactly as G5's world + 20260918120000 build it on the Supabase image (measured before the runner's stand-in)
  await sql(SUPER, 'alter table public.brands disable row level security; grant insert, update, delete, truncate, references, trigger, maintain on public.brands to anon, authenticated');
  try {
    assert.equal(await brandWrites(), 'anon:DELETE anon:INSERT anon:REFERENCES anon:TRIGGER anon:TRUNCATE anon:UPDATE authenticated:DELETE authenticated:INSERT authenticated:REFERENCES authenticated:TRIGGER authenticated:TRUNCATE authenticated:UPDATE');
    const p = await preflight();
    assert.equal(p.verdict, 'FAIL PF_BRANDS', p.lines.join('\n'));
    assert.match(p.line('PF_BRANDS'), /^PF_BRANDS FAIL row security off on brands; brands writable by anon, authenticated: /u);
    assert.match(p.line('PF_APP_READ'), /^PF_APP_READ PASS/u);
    // what that lets S's JWT do to R's workspace, through PostgREST
    assert.ok(((await S.client.from('brands').select('id')).data ?? []).some((r) => r.id === rws), 'S reads R\'s brand');
    assert.deepEqual((await S.client.from('brands').update({ is_active: true, publish_mode: 'live' }).eq('id', rws).select('id')).data, [{ id: rws }], 'S sets R\'s workspace active / live');
    assert.equal(await rows(R.id), '1/1/social_mobile_user_v1,My Workspace,true,live');
    assert.equal(code(await newClient().from('brands').insert({ id: `g5ls_anon_${n}`, display_name: 'anon' })), '201:-', 'anon inserts a brand');
    // G1 itself still names only the person's own (its reads are bounded by the person's memberships)
    assert.equal((await firstRun(S)).personal, sws);
  } finally {
    await sql(SUPER, `alter table public.brands enable row level security; revoke all on public.brands from anon;
      revoke insert, update, delete, truncate, references, trigger, maintain on public.brands from authenticated;
      update public.brands set is_active = false, publish_mode = 'disabled' where id = '${rws}'; delete from public.brands where id = 'g5ls_anon_${n}'`);
  }
  assert.equal(await rows(R.id), PERSONAL);
  assert.deepEqual([await catalog(), await readAcl()], [base.catalog, base.acl], 'restored');

  // each part alone is a FAIL (or, for another policy, a WARN); the preflight changes nothing
  const cases: Array<[string, string, string, RegExp]> = [
    ['row security off on brands', 'alter table public.brands disable row level security', 'alter table public.brands enable row level security', /^PF_BRANDS FAIL row security off on brands: /u],
    ['row security off on brand_memberships', 'alter table public.brand_memberships disable row level security', 'alter table public.brand_memberships enable row level security', /^PF_BRANDS FAIL row security off on brand_memberships: /u],
    ['an UPDATE grant on brands', 'grant update on public.brands to authenticated', 'revoke update on public.brands from authenticated', /^PF_BRANDS FAIL brands writable by authenticated: /u],
    ['an INSERT grant to anon', 'grant insert on public.brands to anon', 'revoke insert on public.brands from anon', /^PF_BRANDS FAIL brands writable by anon: /u],
    ['the member read policy on brands dropped', 'alter policy social_mobile_member_select_brands on public.brands rename to g5ls_renamed',
      'alter policy g5ls_renamed on public.brands rename to social_mobile_member_select_brands', /^PF_BRANDS FAIL a member read policy \(20260918120000\) is missing or not for authenticated only: /u],
    ['the member read policy widened to anon', 'alter policy social_mobile_membership_self_select on public.brand_memberships to anon, authenticated',
      'alter policy social_mobile_membership_self_select on public.brand_memberships to authenticated', /^PF_BRANDS FAIL a member read policy \(20260918120000\) is missing or not for authenticated only: /u],
    ['the kind not granted', 'revoke select on public.brands from authenticated; grant select (id, display_name, is_active, publish_mode) on public.brands to authenticated',
      'revoke select (id, display_name, is_active, publish_mode) on public.brands from authenticated; grant select on public.brands to authenticated',
      /^PF_APP_READ FAIL authenticated cannot read brands\.code_profile_key: /u],
    ['the membership role not granted', 'revoke select on public.brand_memberships from authenticated; grant select (brand_id, user_id) on public.brand_memberships to authenticated',
      'revoke select (brand_id, user_id) on public.brand_memberships from authenticated; grant select, maintain on public.brand_memberships to authenticated',
      /^PF_APP_READ FAIL authenticated cannot read brand_memberships\.role: /u],
  ];
  for (const [label, drift, restore, want] of cases) {
    await sql(SUPER, drift);
    try {
      const during = await catalog();
      const p = await preflight();
      const id = want.source.slice(1).split(' ')[0];
      assert.equal(p.verdict, `FAIL ${id}`, `${label}\n${p.lines.join('\n')}`);
      assert.match(p.line(id), want, label);
      assert.equal(await catalog(), during, `${label}: the preflight changed nothing`);
    } finally {
      await sql(SUPER, restore);
    }
  }
  await sql(SUPER, `create policy g5ls_extra on public.brands for select to authenticated using (true)`);
  try {
    const p = await preflight();
    assert.match(p.verdict, /^PASS /u);
    assert.match(p.line('PF_BRANDS_POLICIES'), /^PF_BRANDS_POLICIES WARN 1 /u);
    assert.ok(((await S.client.from('brands').select('id')).data ?? []).some((r) => r.id === rws), 'why it is reported: an extra permissive policy widens what S reads');
  } finally {
    await sql(SUPER, 'drop policy g5ls_extra on public.brands');
  }
  assert.deepEqual([await catalog(), await readAcl()], [base.catalog, base.acl], 'restored');

  // the kind not granted, through the app: W0 is ready but G1 cannot confirm the workspace -> unconfirmed, nothing sent (the product blocker)
  const sent = provider.calls;
  await sql(SUPER, cases[6][1]);
  try {
    assert.deepEqual(await firstRun(R), { w0: 'ready:existing', snapshot: 'ready', personal: null, view: 'unconfirmed', outcome: 'NOT_SENT:no_workspace' });
    assert.equal(provider.calls, sent);
  } finally {
    await sql(SUPER, cases[6][2]);
  }
  assert.deepEqual([await catalog(), await readAcl()], [base.catalog, base.acl], 'restored');
  assert.deepEqual(await firstRun(R), { w0: 'ready:existing', snapshot: 'ready', personal: rws, view: 'ready', outcome: 'candidates' });
  assert.equal(provider.calls, sent + 1);
});

// ---- mutants of W0's body (each must change an answer above) -------------------------------------------------------------------------
Deno.test({ name: 'W0 mutants: every guard is load-bearing (8 / 8 detected); the reviewed body is restored by its pin', ...opts }, async () => {
  const body = await w0Body(`${MVP}/MVP_W0_INSTALL.sql`);
  const install = installBody;
  const cut = (from: string, to: string) => (t: string) => { const i = t.indexOf(from), j = t.indexOf(to, i); assert.ok(i > 0 && j > i, from); return t.slice(0, i) + t.slice(j); };
  const swap = (a: string, b: string) => (t: string) => { assert.ok(t.includes(a), a); return t.replace(a, b); };
  const scenarios: Record<string, () => Promise<[string, string]>> = {
    notStarted: async () => [await w0((await signUp('mA', false)).token), 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'],
    loggedOut: async () => { const p = await signUp('mB'); const t = p.token; await p.client.auth.signOut(); return [await w0(t), 'SESSION_REVOKED']; },
    otherMember: async () => {
      const p = await signUp('mC');
      await sql(SUPER, `insert into public.brands (id, display_name, code_profile_key) values ('g5ls_m_${n}', 'Shared', 'shared_v1');
        insert into public.brand_memberships (brand_id, user_id, role) values ('g5ls_m_${n}', '${p.id}', 'member')`);
      return [await w0(p.token), 'OTHER_WORKSPACE_MEMBERSHIP'];
    },
    intruder: async () => {
      const p = await signUp('mD'); const k = await signUp('mK', false);
      await sql(SUPER, `create function public.g5ls_test_intruder() returns trigger language plpgsql as $f$ begin
          insert into public.brand_memberships (brand_id, user_id, role) values (new.id, '${k.id}', 'member'); return null; end $f$;
        create trigger g5ls_test_intruder after insert on public.brands for each row when (new.id = '${await derived(p.id)}') execute function public.g5ls_test_intruder()`);
      try { return [await w0(p.token), 'OWN_WORKSPACE_CONFLICT']; } finally { await sql(SUPER, 'drop trigger g5ls_test_intruder on public.brands; drop function public.g5ls_test_intruder()'); }
    },
    again: async () => [await w0(people.B.token), 'ready:existing'],
    raceForeign: async () => [await foreignRace(await signUp('mF'), 'postgres'), 'OWN_WORKSPACE_CONFLICT'],
    memberTaken: async () => {
      // a writer that already put the person into the brand W0 is creating (test-only trigger, as the intruder): W0's own membership insert
      // writes nothing, so W0 did not write both rows
      const p = await signUp('mG');
      await sql(SUPER, `create function public.g5ls_test_intruder() returns trigger language plpgsql as $f$ begin
          insert into public.brand_memberships (brand_id, user_id, role) values (new.id, '${p.id}', 'owner'); return null; end $f$;
        create trigger g5ls_test_intruder after insert on public.brands for each row when (new.id = '${await derived(p.id)}') execute function public.g5ls_test_intruder()`);
      try { return [await w0(p.token), 'OWN_WORKSPACE_CONFLICT']; } finally { await sql(SUPER, 'drop trigger g5ls_test_intruder on public.brands; drop function public.g5ls_test_intruder()'); }
    },
    foreignBrand: async () => {
      const p = await signUp('mE');
      await sql(SUPER, `insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key) values ('${await derived(p.id)}', 'Other', true, 'live', 'kabumori_brand')`);
      return [await w0(p.token), 'OWN_WORKSPACE_CONFLICT'];
    },
  };
  const mutants: Array<[string, (t: string) => string, string]> = [
    ['M1 no T13 writer fence', cut('  begin\n    perform private.account_lifecycle_assert_active_service_write', '  -- 3. the S2-3 facts'), 'notStarted'],
    ['M2 no S2-2 session gate', cut('  if v_session is distinct from \'active\' then', '  v_user := (select auth.uid());'), 'loggedOut'],
    ['M3 no other-membership refusal', cut('  if exists (select 1 from public.brand_memberships m where m.user_id = v_user and m.brand_id <> v_workspace) then', '  -- 4. the begin RPC'), 'otherMember'],
    ['M4 no S2-3 postcondition', swap(" or private.postona_personal_workspace_eligibility(v_user) is distinct from 'own' then", ' then'), 'intruder'],
    ['M5 own reported as created', swap("'workspace_id', v_workspace, 'created', false", "'workspace_id', v_workspace, 'created', true"), 'again'],
    ['M7 the brand insert result unchecked (H1 P2 F1)', cut('    if v_brand_written is not true then', '    insert into public.brand_memberships'), 'raceForeign'],
    ['M8 the membership insert result unchecked', swap('if v_member_written is not true or private', 'if private'), 'memberTaken'],
    ['M6 the fence for another service', swap("assert_active_service_write(v_user, 'x_autopost')", "assert_active_service_write(v_user, 'kabumori')"), 'again'],
  ];
  // (not a mutant here: dropping the early S2-3 refusal. The postcondition re-runs the same S2-3 rule after the inserts and undoes them, so the
  // answer is the same by construction; the early refusal only avoids the writes.)
  // the reviewed body answers every scenario as expected
  for (const [name, s] of Object.entries(scenarios)) { const [got, want] = await s(); assert.equal(got, want, `reviewed body, ${name}`); }
  const detected: string[] = [];
  try {
    for (const [name, mutate, scenario] of mutants) {
      await install(mutate(body));
      const [got, want] = await scenarios[scenario]();
      if (got !== want) detected.push(name);
    }
  } finally {
    await install(body);
  }
  assert.deepEqual(detected, mutants.map((m) => m[0]));
  assert.equal(await sql(SUPER, `select md5(prosrc) from pg_proc where oid = 'public.${W0}()'::regprocedure`), '3b3cc024c7816fa5e86a65e71f90060c', 'restored');
  assert.match((await preflight()).line('PF_W0'), /^PF_W0 PASS granted/u);
});

// ---- stop, drift, withdraw ------------------------------------------------------------------------------------------------------------
Deno.test({ name: 'stop / drift / withdraw: W0 revoke -> a person is refused, workspaces stay; a widened ACL is a preflight FAIL the stop clears; MVP_ROLLBACK refuses while W0 exists; the full withdraw restores the catalog', ...opts }, async () => {
  const A = people.A;
  await ok('MVP_W0_EXECUTE_REVOKE.sql');
  assert.equal(await w0(A.token), 'HTTP403:42501');
  assert.equal(await rows(A.id), PERSONAL, 'the rows stay');
  assert.equal((await app(A)).outcome, 'candidates', 'R1-MVP still answers for an existing workspace');
  assert.match((await preflight()).line('PF_W0'), /installed \(owner-only\)/u);
  await sql(OWNER, `grant execute on function public.${W0}() to service_role`);
  const p = await preflight();
  assert.match(p.verdict, /^FAIL PF_W0$/u, p.lines.join('\n'));
  await refuses('MVP_W0_EXECUTE_GRANT.sql', /W0_EXEC_GRANT_PRECONDITION_ACL/u);
  await ok('MVP_W0_EXECUTE_REVOKE.sql');
  await ok('MVP_W0_EXECUTE_REVOKE.sql');   // idempotent
  assert.match((await preflight()).line('PF_W0'), /installed \(owner-only\)/u);
  await ok('MVP_W0_EXECUTE_GRANT.sql');
  assert.equal(await w0(A.token), 'ready:existing', 're-granted');
  await refuses('MVP_W0_ROLLBACK.sql', /W0_ROLLBACK_PRECONDITION_GRANTED/u);
  await ok('MVP_R1_EXECUTE_REVOKE.sql');
  await refuses('MVP_ROLLBACK.sql', /CALLERS/u);
  await ok('MVP_W0_EXECUTE_REVOKE.sql');
  await ok('MVP_W0_ROLLBACK.sql');
  assert.match((await preflight()).line('PF_W0'), /absent/u);
  // gone: PostgREST answers 404 either from its schema cache (PGRST202) or, before the cache reloads, from Postgres (42883)
  assert.match(await w0(A.token), /^HTTP404:(PGRST202|42883)$/u);
  await ok('MVP_ROLLBACK.sql');
  assert.match((await preflight()).verdict, /^PASS phase=absent /u);
  assert.equal(await catalog(), PRE.catalog, 'every function, ACL, default ACL, membership and relation ACL as before the release');
  assert.equal(await rows(A.id), PERSONAL, 'the person\'s workspace is data: it stays');
  const calls = provider.calls;
  assert.notEqual((await app(A)).outcome, 'candidates', 'without R1-MVP nothing is sent (G5-50 gap 3: G6 shows retry)');
  assert.equal(provider.calls, calls);
  await server?.shutdown();
});
