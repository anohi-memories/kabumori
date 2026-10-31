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

// what anon / authenticated may write on brands (table or column privileges)
const brandWrites = () => sql(SUPER, `select coalesce(string_agg(r || ':' || k, ' ' order by r, k), '-') from unnest(array['anon', 'authenticated']) r,
  unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) k
  where case when k in ('INSERT', 'UPDATE', 'REFERENCES') then has_any_column_privilege(r, 'public.brands', k) else has_table_privilege(r, 'public.brands', k) end`);
const code = (r: { error: { code?: string } | null; status: number }) => `${r.status}:${r.error?.code ?? '-'}`;

Deno.test({ name: 'G5-02 #2 G1 #592 on the real JWT: the person reads their own brand\'s kind (code_profile_key) -> ready -> candidates; another person, no login, a signed-out login, an ended service, a second membership and a repeated W0 conflict never become ready and send nothing', ...opts }, async () => {
  // read-back of the world the suite runs on (G5-02 #3's brands fix, installed by the runner; the world as built is the next test's rollback)
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

// ---- G5-02 #3: the brands fix (supabase/candidates/postona_brands_tenant_isolation), installed by the runner as `postgres` -----------------
const FIX = Deno.env.get('G5LS_BRANDS_FIX') ?? '';
const SECRET = Deno.env.get('G5LS_SECRET') ?? '';
const INSTALL = '001_brands_tenant_isolation.sql';
const ROLLBACK = '001_brands_tenant_isolation_rollback.sql';
const fix = (name: string, user = OWNER) => psql(user, ['-f', `${FIX}/${name}`]);
const fixOk = async (name: string) => { const r = await fix(name); assert.ok(r.ok, `${name}\n${r.error}`); };
// what the install recorded for the rollback ('-' when there is no record)
async function prestate() {
  if (await sql(SUPER, `select to_regclass('private.postona_brands_isolation_prestate') is null`) === 't') return '-';
  return sql(SUPER, 'select row_security || \' \' || table_acl::text || \' \' || column_acl::text from private.postona_brands_isolation_prestate');
}
const AS_BUILT_WRITES = ['anon', 'authenticated'].flatMap((r) => ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'TRIGGER', 'TRUNCATE', 'UPDATE'].map((k) => `${r}:${k}`)).join(' ');
// the backend's own path: service_role (BYPASSRLS) through the real PostgREST
const backend = () => createClient(API, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
// PostgREST serves a new relation only after a schema reload
async function served(c: SupabaseClient, rel: string) {
  await sql(SUPER, `notify pgrst, 'reload schema'`);
  for (let i = 0; i < 100; i++) {
    if ((await c.from(rel).select('id').limit(1)).error === null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`PostgREST never served ${rel}`);
}
// drifts (and their restores) shared by the refusal cases and the mutants
const MEMBER_POLICY = 'exists (select 1 from public.brand_memberships as bm where bm.brand_id = brands.id and bm.user_id = (select auth.uid()))';
const INVOKER_WRITER: [string, string] = [
  'create function public.g5ls_touch(p text) returns void language sql as $f$ update public.brands set display_name = display_name where id = p $f$; grant execute on function public.g5ls_touch(text) to authenticated',
  'drop function public.g5ls_touch(text)'];
const FILTERED_DEFINER: [string, string] = [
  'create role g5ls_definer nologin; create function public.g5ls_peek() returns bigint language sql security definer as $f$ select count(*) from public.brands $f$; alter function public.g5ls_peek() owner to g5ls_definer',
  'drop function public.g5ls_peek(); drop role g5ls_definer'];
const KIND_REVOKE: [string, string] = [
  'revoke select on public.brands from authenticated; grant select (id, display_name, is_active, publish_mode) on public.brands to authenticated',
  'revoke select (id, display_name, is_active, publish_mode) on public.brands from authenticated; grant select on public.brands to authenticated'];
const WRITER_ROLE: [string, string] = [
  'create role g5ls_writer nologin; grant update on public.brands to g5ls_writer; grant g5ls_writer to authenticated',
  'revoke g5ls_writer from authenticated; revoke update on public.brands from g5ls_writer; drop role g5ls_writer'];
// the owner's default privileges giving the tables it creates in private (the record) to another role
const DEFAULT_ACL: [string, string] = [
  'alter default privileges for role postgres in schema private grant select on tables to authenticator',
  'alter default privileges for role postgres in schema private revoke select on tables from authenticator'];
// G5-02 #4: H1's F1 / F2 drifts on PR #600 (and the safe views they must not catch)
const MEMBERS_POLICY = '(select auth.uid()) = user_id';
const F1_NO_CORRELATION: [string, string] = [
  'alter policy social_mobile_member_select_brands on public.brands using (exists (select 1 from public.brand_memberships as bm where bm.user_id = (select auth.uid())))',
  `alter policy social_mobile_member_select_brands on public.brands using (${MEMBER_POLICY})`];
const F1_OR_TRUE: [string, string] = [
  `alter policy social_mobile_member_select_brands on public.brands using ((${MEMBER_POLICY}) or true)`,
  `alter policy social_mobile_member_select_brands on public.brands using (${MEMBER_POLICY})`];
const F1_MEMBERSHIP_TRUE: [string, string] = [
  'alter policy social_mobile_membership_self_select on public.brand_memberships using (true)',
  `alter policy social_mobile_membership_self_select on public.brand_memberships using (${MEMBERS_POLICY})`];
const DROP_PAIR = 'drop view public.g5ls_outer; drop view public.g5ls_inner';
// H1's: an owner-run inner view no API role may select, under an owner-run outer view authenticated may select
const F2_TWO_HOP: [string, string] = [
  'create view public.g5ls_inner as select id from public.brands; revoke all on public.g5ls_inner from public, anon, authenticated; create view public.g5ls_outer as select * from public.g5ls_inner; revoke all on public.g5ls_outer from public, anon; grant select on public.g5ls_outer to authenticated',
  DROP_PAIR];
// mixed and SAFE (measured): an owner-run outer view over a private invoker inner view; the inner one still reads brands as the person
const SAFE_DEFINER_THEN_INVOKER: [string, string] = [
  'create view public.g5ls_inner with (security_invoker = true) as select id from public.brands; revoke all on public.g5ls_inner from public, anon, authenticated; create view public.g5ls_outer as select * from public.g5ls_inner; revoke all on public.g5ls_outer from public, anon; grant select on public.g5ls_outer to authenticated',
  DROP_PAIR];
// mixed: an invoker outer view over an owner-run inner view authenticated may select
const F2_INVOKER_THEN_GRANTED_DEFINER: [string, string] = [
  'create view public.g5ls_inner as select id from public.brands; revoke all on public.g5ls_inner from public, anon; grant select on public.g5ls_inner to authenticated; create view public.g5ls_outer with (security_invoker = true) as select * from public.g5ls_inner; revoke all on public.g5ls_outer from public, anon; grant select on public.g5ls_outer to authenticated',
  DROP_PAIR];
// safe: invoker over invoker (row security binds the person at brands)
const SAFE_INVOKER_CHAIN: [string, string] = [
  'create view public.g5ls_inner with (security_invoker = true) as select id from public.brands; revoke all on public.g5ls_inner from public, anon; grant select on public.g5ls_inner to authenticated; create view public.g5ls_outer with (security_invoker = true) as select * from public.g5ls_inner; revoke all on public.g5ls_outer from public, anon; grant select on public.g5ls_outer to authenticated',
  DROP_PAIR];
// safe: an invoker outer view over an owner-run inner view NO API role may select (the person is refused at the inner view)
const SAFE_UNGRANTED_INNER: [string, string] = [
  'create view public.g5ls_inner as select id from public.brands; revoke all on public.g5ls_inner from public, anon, authenticated; create view public.g5ls_outer with (security_invoker = true) as select * from public.g5ls_inner; revoke all on public.g5ls_outer from public, anon; grant select on public.g5ls_outer to authenticated',
  DROP_PAIR];
// 33 invoker views in a row, each selectable by authenticated: deeper than the walk decides (32) -> refused, fail closed
const DEEP_CHAIN: [string, string] = [
  Array.from({ length: 33 }, (_, i) => `create view public.g5ls_c${i + 1} with (security_invoker = true) as select id from ${i === 0 ? 'public.brands' : `public.g5ls_c${i}`}; revoke all on public.g5ls_c${i + 1} from public, anon; grant select on public.g5ls_c${i + 1} to authenticated`).join('; '),
  Array.from({ length: 33 }, (_, i) => `drop view public.g5ls_c${33 - i}`).join('; ')];
// the whole-condition comparisons (mutant sites in the install and the preflight)
const BRANDS_QUAL_SITE = "\n                    and pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g')\n                        = '(EXISTS ( SELECT 1 FROM public.brand_memberships bm WHERE ((bm.brand_id = brands.id) AND (bm.user_id = ( SELECT auth.uid() AS uid)))))')";
const MEMBERS_QUAL_SITE = "\n                            and pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g')\n                                = '(( SELECT auth.uid() AS uid) = user_id)')";
const PF_BRANDS_QUAL_SITE = "\n                              and pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g')\n                                  = '(EXISTS ( SELECT 1 FROM public.brand_memberships bm WHERE ((bm.brand_id = brands.id) AND (bm.user_id = ( SELECT auth.uid() AS uid)))))')";
const PF_MEMBERS_QUAL_SITE = "\n                              and pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g') = '(( SELECT auth.uid() AS uid) = user_id)')";

Deno.test({ name: 'G5-02 #3 brands fix: installed -> a person reads only their own brand and writes none, anon nothing, the backend everything; rollback -> the world as built (a person reads, changes and deletes another workspace, anon inserts: PF_BRANDS FAIL again); re-install -> the same catalog and record', ...opts }, async () => {
  const base = { catalog: await catalog(), acl: await readAcl(), pre: await prestate() };
  assert.match(base.pre, /^false \[/u, 'the runner\'s install recorded the world as built: row security off');
  assert.match(base.pre, /"grantee": "anon", "grantable": false, "privilege": "INSERT"/u);
  const R = await signUp('R');
  const S = await signUp('S');
  const T = await signUp('T');
  const rws = await derived(R.id);
  const sws = await derived(S.id);
  const tws = await derived(T.id);
  for (const p of [R, S, T]) assert.equal((await firstRun(p)).view, 'ready');

  // installed: S sees its own brand only, writes no brand (not even its own: brands is backend-written) and no membership (no owner change)
  const denied = async () => {
    assert.deepEqual((await S.client.from('brands').select('id')).data, [{ id: sws }]);
    assert.deepEqual((await S.client.from('brands').select('id').eq('id', rws)).data, []);
    assert.equal(code(await S.client.from('brands').update({ is_active: true, publish_mode: 'live' }).eq('id', rws)), '403:42501');
    assert.equal(code(await S.client.from('brands').update({ publish_mode: 'live' }).eq('id', sws)), '403:42501');
    assert.equal(code(await S.client.from('brands').delete().eq('id', tws)), '403:42501');
    assert.equal(code(await S.client.from('brands').insert({ id: `g5ls_s_${n}`, display_name: 'S', code_profile_key: 'social_mobile_user_v1' })), '403:42501');
    assert.equal(code(await S.client.from('brand_memberships').insert({ brand_id: rws, user_id: S.id, role: 'owner' })), '403:42501');
    assert.equal(code(await S.client.from('brand_memberships').update({ user_id: S.id }).eq('brand_id', sws)), '403:42501');
    assert.equal(code(await newClient().from('brands').select('id')), '401:42501');
    assert.equal(code(await newClient().from('brands').insert({ id: `g5ls_anon_${n}`, display_name: 'anon' })), '401:42501');
    assert.deepEqual([await rows(R.id), await rows(S.id), await rows(T.id)], [PERSONAL, PERSONAL, PERSONAL], 'nothing changed');
  };
  await denied();
  // the backend path is unchanged: service_role reads every brand and writes one through PostgREST
  const all = Number(await sql(SUPER, 'select count(*) from public.brands'));
  assert.equal(((await backend().from('brands').select('id')).data ?? []).length, all);
  assert.equal(code(await backend().from('brands').insert({ id: `g5ls_be_${n}`, display_name: 'backend' })), '201:-');
  assert.deepEqual((await backend().from('brands').update({ display_name: 'backend 2' }).eq('id', `g5ls_be_${n}`).select('display_name')).data, [{ display_name: 'backend 2' }]);
  assert.equal(code(await backend().from('brands').delete().eq('id', `g5ls_be_${n}`)), '204:-');

  // rollback: exactly the world as built, re-detected by the preflight; the cross-tenant paths are back
  await fixOk(ROLLBACK);
  const built = { catalog: await catalog(), acl: await readAcl() };
  assert.equal(await prestate(), '-');
  assert.match(built.acl, /brands:rls=false:force=false/u);
  assert.equal(await brandWrites(), AS_BUILT_WRITES);
  const p = await preflight();
  assert.equal(p.verdict, 'FAIL PF_BRANDS', p.lines.join('\n'));
  assert.match(p.line('PF_BRANDS'), /^PF_BRANDS FAIL row security off on brands; brands writable by anon, authenticated: /u);
  try {
    assert.ok(((await S.client.from('brands').select('id')).data ?? []).some((r) => r.id === rws), 'S reads R\'s brand');
    assert.deepEqual((await S.client.from('brands').update({ is_active: true, publish_mode: 'live' }).eq('id', rws).select('id')).data, [{ id: rws }], 'S sets R\'s workspace active / live');
    assert.equal(await rows(R.id), '1/1/social_mobile_user_v1,My Workspace,true,live');
    assert.deepEqual((await S.client.from('brands').delete().eq('id', tws).select('id')).data, [{ id: tws }], 'S deletes T\'s workspace');
    assert.equal(await rows(T.id), '0/0/-', 'T\'s membership went with it');
    assert.equal(code(await newClient().from('brands').insert({ id: `g5ls_anon_${n}`, display_name: 'anon' })), '201:-', 'anon inserts a brand');
    assert.equal((await firstRun(S)).personal, sws, 'G1 itself still names only the person\'s own');
  } finally {
    await sql(SUPER, `update public.brands set is_active = false, publish_mode = 'disabled' where id = '${rws}'; delete from public.brands where id = 'g5ls_anon_${n}'`);
  }
  await assert.rejects(async () => { const r = await fix(ROLLBACK); if (!r.ok) throw new Error(r.error); }, /BRANDS_ISOLATION_NOT_INSTALLED/u);
  assert.equal(await catalog(), built.catalog, 'the refused rollback changed nothing');

  // re-install (twice: a re-run keeps the first record): the catalog, the ACL and the record are the first install's again
  await fixOk(INSTALL);
  assert.deepEqual([await catalog(), await readAcl(), await prestate()], [base.catalog, base.acl, base.pre]);
  await fixOk(INSTALL);
  assert.deepEqual([await catalog(), await readAcl(), await prestate()], [base.catalog, base.acl, base.pre]);
  // T's workspace comes back through the product path (W0), then everything is denied again
  assert.deepEqual(await firstRun(T), { w0: 'ready:created', snapshot: 'ready', personal: tws, view: 'ready', outcome: 'candidates' });
  await denied();
  const after = await preflight();
  assert.match(after.verdict, /^PASS /u, after.lines.join('\n'));
  assert.match(after.line('PF_BRANDS'), /^PF_BRANDS PASS/u);
  // and the cycle is repeatable
  await fixOk(ROLLBACK);
  assert.deepEqual([await catalog(), await readAcl()], [built.catalog, built.acl]);
  await fixOk(INSTALL);
  assert.deepEqual([await catalog(), await readAcl(), await prestate()], [base.catalog, base.acl, base.pre]);
});

Deno.test({ name: 'G5-02 #3 preflight on the fixed world: every drift that reopens brands is a PF_BRANDS FAIL (column grants, a role an API role reaches, anon SELECT, another policy, a view as its owner, row security, the member policies) or PF_APP_READ FAIL; the preflight changes nothing; code_profile_key not granted -> G1 unconfirmed, nothing sent', ...opts }, async () => {
  const base = { catalog: await catalog(), acl: await readAcl() };
  const R = await signUp('R3');
  const S = await signUp('S3');
  const rws = await derived(R.id);
  assert.equal((await firstRun(R)).view, 'ready');
  assert.equal((await firstRun(S)).view, 'ready');
  const KIND = KIND_REVOKE;
  const cases: Array<[string, string, string, RegExp]> = [
    ['row security off on brands', 'alter table public.brands disable row level security', 'alter table public.brands enable row level security', /^PF_BRANDS FAIL row security off on brands: /u],
    ['row security off on brand_memberships', 'alter table public.brand_memberships disable row level security', 'alter table public.brand_memberships enable row level security', /^PF_BRANDS FAIL row security off on brand_memberships: /u],
    ['an UPDATE grant on brands', 'grant update on public.brands to authenticated', 'revoke update on public.brands from authenticated', /^PF_BRANDS FAIL brands writable by authenticated: /u],
    ['a column UPDATE grant on brands', 'grant update (display_name) on public.brands to authenticated', 'revoke update (display_name) on public.brands from authenticated', /^PF_BRANDS FAIL brands writable by authenticated: /u],
    ['an INSERT grant to anon', 'grant insert on public.brands to anon', 'revoke insert on public.brands from anon', /^PF_BRANDS FAIL brands writable by anon: /u],
    ['a DELETE grant to PUBLIC', 'grant delete on public.brands to public', 'revoke delete on public.brands from public', /^PF_BRANDS FAIL brands writable by anon, authenticated: /u],
    ['a role authenticated reaches holds UPDATE', 'create role g5ls_writer nologin; grant update on public.brands to g5ls_writer; grant g5ls_writer to authenticated with inherit false',
      'revoke g5ls_writer from authenticated; revoke update on public.brands from g5ls_writer; drop role g5ls_writer', /^PF_BRANDS FAIL brands writable by g5ls_writer: /u],
    ['anon may SELECT', 'grant select on public.brands to anon', 'revoke select on public.brands from anon', /^PF_BRANDS FAIL brands readable by anon: /u],
    ['another permissive policy on brands', 'create policy g5ls_extra on public.brands for select to authenticated using (true)', 'drop policy g5ls_extra on public.brands',
      /^PF_BRANDS FAIL another permissive policy on brands \(g5ls_extra\): /u],
    ['a view reading brands as its owner', 'create view public.g5ls_brands_v as select id, display_name from public.brands; grant select on public.g5ls_brands_v to authenticated',
      'drop view public.g5ls_brands_v', /^PF_BRANDS FAIL a view reads brands as its owner \((public\.)?g5ls_brands_v\): /u],
    ['the member read policy on brands dropped', 'alter policy social_mobile_member_select_brands on public.brands rename to g5ls_renamed',
      'alter policy g5ls_renamed on public.brands rename to social_mobile_member_select_brands', /^PF_BRANDS FAIL a member read policy \(20260918120000\) is missing or changed \(name, command, role or condition\); another permissive policy on brands \(g5ls_renamed\): /u],
    ['the member read policy widened to anon', 'alter policy social_mobile_membership_self_select on public.brand_memberships to anon, authenticated',
      'alter policy social_mobile_membership_self_select on public.brand_memberships to authenticated', /^PF_BRANDS FAIL a member read policy \(20260918120000\) is missing or changed \(name, command, role or condition\): /u],
    ['the kind not granted', KIND[0], KIND[1], /^PF_APP_READ FAIL authenticated cannot read brands\.code_profile_key: /u],
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
  assert.deepEqual([await catalog(), await readAcl()], [base.catalog, base.acl], 'restored');
  // why the two new reads are FAILs: through PostgREST the extra policy and the view each show S another person's brand
  await sql(SUPER, cases[8][1]);
  try {
    assert.ok(((await S.client.from('brands').select('id')).data ?? []).some((r) => r.id === rws), 'an extra permissive policy widens what S reads');
  } finally {
    await sql(SUPER, cases[8][2]);
  }
  await sql(SUPER, cases[9][1]);
  try {
    await served(S.client, 'g5ls_brands_v');
    assert.ok(((await S.client.from('g5ls_brands_v').select('id')).data ?? []).some((r) => r.id === rws), 'the view reads as its owner');
  } finally {
    await sql(SUPER, cases[9][2]);
  }
  // not a FAIL: a security_invoker view (row security binds the reader) and another policy on brand_memberships (still a WARN)
  await sql(SUPER, 'create view public.g5ls_brands_iv with (security_invoker = true) as select id from public.brands; grant select on public.g5ls_brands_iv to authenticated');
  try {
    assert.match((await preflight()).line('PF_BRANDS'), /^PF_BRANDS PASS/u);
    await served(S.client, 'g5ls_brands_iv');
    assert.deepEqual((await S.client.from('g5ls_brands_iv').select('id')).data, [{ id: await derived(S.id) }]);
  } finally {
    await sql(SUPER, 'drop view public.g5ls_brands_iv');
  }
  await sql(SUPER, 'create policy g5ls_extra_m on public.brand_memberships for select to authenticated using (true)');
  try {
    const p = await preflight();
    assert.match(p.verdict, /^PASS /u);
    assert.match(p.line('PF_BRANDS_POLICIES'), /^PF_BRANDS_POLICIES WARN 1 other permissive policy\(ies\) on brand_memberships /u);
  } finally {
    await sql(SUPER, 'drop policy g5ls_extra_m on public.brand_memberships');
  }
  assert.deepEqual([await catalog(), await readAcl()], [base.catalog, base.acl], 'restored');

  // the kind not granted, through the app: W0 is ready but G1 cannot confirm the workspace -> unconfirmed, nothing sent (the product blocker)
  const sent = provider.calls;
  await sql(SUPER, KIND[0]);
  try {
    assert.deepEqual(await firstRun(R), { w0: 'ready:existing', snapshot: 'ready', personal: null, view: 'unconfirmed', outcome: 'NOT_SENT:no_workspace' });
    assert.equal(provider.calls, sent);
  } finally {
    await sql(SUPER, KIND[1]);
  }
  assert.deepEqual([await catalog(), await readAcl()], [base.catalog, base.acl], 'restored');
  assert.deepEqual(await firstRun(R), { w0: 'ready:existing', snapshot: 'ready', personal: rws, view: 'ready', outcome: 'candidates' });
  assert.equal(provider.calls, sent + 1);
});

Deno.test({ name: 'G5-02 #3 brands fix install refuses on a world it is not for (superuser, not the owner, forced row security, memberships not isolated, another member policy, another permissive policy, a view as its owner, an invoker writer, a filtered definer, the kind not readable, a reached role keeping a write, a held lock) and changes nothing', ...opts }, async () => {
  await fixOk(ROLLBACK);
  const built = { catalog: await catalog(), acl: await readAcl() };
  await sql(SUPER, `create role g5ls_stranger login password 'postgres'`);
  const cases: Array<[string, string, string, RegExp, string?]> = [
    ['a superuser', 'select 1', 'select 1', /BRANDS_ISOLATION_SUPERUSER/u, SUPER],
    ['not the owner', 'select 1', 'select 1', /BRANDS_ISOLATION_NOT_OWNER: g5ls_stranger cannot act as postgres/u, 'g5ls_stranger'],
    ['forced row security', 'alter table public.brands force row level security', 'alter table public.brands no force row level security', /BRANDS_FORCE_ROW_SECURITY/u],
    ['memberships row security off', 'alter table public.brand_memberships disable row level security', 'alter table public.brand_memberships enable row level security',
      /BRANDS_MEMBERSHIPS_NOT_ISOLATED: brand_memberships row security off/u],
    ['memberships self policy widened', 'alter policy social_mobile_membership_self_select on public.brand_memberships to anon, authenticated',
      'alter policy social_mobile_membership_self_select on public.brand_memberships to authenticated', /BRANDS_MEMBERSHIPS_NOT_ISOLATED: brand_memberships social_mobile_membership_self_select missing or changed/u],
    ['memberships column-writable', 'grant update (role) on public.brand_memberships to authenticated', 'revoke update (role) on public.brand_memberships from authenticated',
      /BRANDS_MEMBERSHIPS_NOT_ISOLATED: brand_memberships writable by authenticated:UPDATE/u],
    ['the member policy reads every brand', 'alter policy social_mobile_member_select_brands on public.brands using (true)',
      `alter policy social_mobile_member_select_brands on public.brands using (${MEMBER_POLICY})`, /BRANDS_MEMBER_POLICY/u],
    ['another permissive policy', 'create policy g5ls_extra on public.brands for select to public using (true)', 'drop policy g5ls_extra on public.brands', /BRANDS_UNREVIEWED_POLICY: g5ls_extra/u],
    ['a view as its owner', 'create view public.g5ls_brands_v as select id from public.brands; grant select on public.g5ls_brands_v to anon', 'drop view public.g5ls_brands_v',
      /BRANDS_VIEW_BYPASS: (public\.)?g5ls_brands_v/u],
    ['an invoker writer', ...INVOKER_WRITER, /BRANDS_INVOKER_WRITER: (public\.)?g5ls_touch\(text\)/u],
    ['a filtered definer', ...FILTERED_DEFINER, /BRANDS_DEFINER_FILTERED: (public\.)?g5ls_peek\(\)/u],
    ['the kind not readable', ...KIND_REVOKE, /BRANDS_MEMBER_READ_MISSING: authenticated cannot read brands\.code_profile_key/u],
    ['a reached role keeps a write', ...WRITER_ROLE, /BRANDS_POSTCONDITION_WRITE: authenticated:UPDATE, g5ls_writer:UPDATE/u],
    ['anon reaches authenticated', 'grant authenticated to anon', 'revoke authenticated from anon', /BRANDS_POSTCONDITION_ANON_READ: anon, authenticated/u],
    ['the owner\'s default privileges give the record away', ...DEFAULT_ACL, /BRANDS_POSTCONDITION_PRESTATE/u],
  ];
  try {
    for (const [label, drift, restore, want, user] of cases) {
      await sql(SUPER, drift);
      try {
        const during = { catalog: await catalog(), acl: await readAcl() };
        const r = await fix(INSTALL, user ?? OWNER);
        assert.ok(!r.ok, `${label}: installed`);
        assert.match(r.error, want, label);
        assert.deepEqual([await catalog(), await readAcl(), await prestate()], [during.catalog, during.acl, '-'], `${label}: nothing changed`);
      } finally {
        await sql(SUPER, restore);
      }
    }
    assert.deepEqual([await catalog(), await readAcl()], [built.catalog, built.acl], 'restored');
    // a transaction holding brands: the install waits lock_timeout (5 s), then stops having changed nothing
    const holder = new Deno.Command('psql', {
      args: ['-X', '-q', '-h', '127.0.0.1', '-p', DB_PORT, '-U', SUPER, '-d', 'postgres', '-c', 'begin; lock table public.brands in row exclusive mode; select pg_sleep(60); commit'],
      env: { LC_ALL: 'C' }, stdout: 'null', stderr: 'null',
    }).spawn();
    try {
      for (let i = 0; i < 100 && await sql(SUPER, `select count(*) from pg_stat_activity where wait_event = 'PgSleep' and query like 'begin; lock table public.brands%'`) !== '1'; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const r = await fix(INSTALL);
      assert.ok(!r.ok);
      assert.match(r.error, /lock timeout/u);
      assert.deepEqual([await catalog(), await readAcl(), await prestate()], [built.catalog, built.acl, '-']);
    } finally {
      await sql(SUPER, `select pg_terminate_backend(pid) from pg_stat_activity where query like 'begin; lock table public.brands%'`);
      holder.kill();
      await holder.status;
    }
  } finally {
    await sql(SUPER, 'drop role g5ls_stranger');
    await fixOk(INSTALL);
  }
  assert.match(await readAcl(), /brands:rls=true:force=false/u);
  assert.equal(await brandWrites(), '-');
});

// ---- G5-02 #4: H1's F1 / F2 on PR #600, before (PR #600's files) and after (this tree) ------------------------------------------------------
const PR600 = Deno.env.get('G5LS_PR600') ?? '';

Deno.test({ name: 'G5-02 #4 H1 F1 / F2: a dropped brand correlation, an added OR true, a membership policy reading every row, an owner-run view behind a private one, an invoker view over a selectable owner-run one and an undecided deep chain -- PR #600 installed / passed them and a person read another person\'s rows; now the install refuses and PF_BRANDS fails each; safe chains (invoker over invoker, owner-run over invoker, invoker over a private owner-run view) pass', ...opts }, async () => {
  const base = { catalog: await catalog(), acl: await readAcl(), pre: await prestate() };
  const R = await signUp('R4');
  const S = await signUp('S4');
  const rws = await derived(R.id);
  const sws = await derived(S.id);
  for (const p of [R, S]) assert.equal((await firstRun(p)).view, 'ready');
  const oldPf = async () => pfLine(await psql(OWNER, ['-f', `${PR600}/MVP_RELEASE_PREFLIGHT.sql`]), 'PF_BRANDS');
  const newPf = async () => (await preflight()).line('PF_BRANDS');
  const sees = async (rel: string, col = 'id', id = rws) => {
    if (rel.startsWith('g5ls_')) await served(S.client, rel);
    return ((await S.client.from(rel).select(col)).data ?? []).some((r) => (r as unknown as Record<string, string>)[col] === id);
  };
  // [label, drift, PR #600 missed it, new PF_BRANDS line, new install refusal, what S's JWT reads of R through it]
  const cases: Array<[string, [string, string], boolean, RegExp, RegExp, () => Promise<boolean>]> = [
    ['F1 the brand correlation dropped', F1_NO_CORRELATION, true, /^PF_BRANDS FAIL a member read policy \(20260918120000\) is missing or changed /u, /BRANDS_MEMBER_POLICY/u, () => sees('brands')],
    ['F1 OR true added', F1_OR_TRUE, true, /^PF_BRANDS FAIL a member read policy \(20260918120000\) is missing or changed /u, /BRANDS_MEMBER_POLICY/u, () => sees('brands')],
    ['F1 the membership policy reads every row', F1_MEMBERSHIP_TRUE, true, /^PF_BRANDS FAIL a member read policy \(20260918120000\) is missing or changed /u,
      /BRANDS_MEMBERSHIPS_NOT_ISOLATED: brand_memberships social_mobile_membership_self_select missing or changed/u, () => sees('brand_memberships', 'user_id', R.id)],
    ['F2 an owner-run view behind a private owner-run view (H1\'s 2-hop)', F2_TWO_HOP, true, /^PF_BRANDS FAIL a view reads brands as its owner \(public\.g5ls_outer\): /u,
      /BRANDS_VIEW_BYPASS: public\.g5ls_outer/u, () => sees('g5ls_outer')],
    ['F2 an invoker view over a selectable owner-run view', F2_INVOKER_THEN_GRANTED_DEFINER, false, /^PF_BRANDS FAIL a view reads brands as its owner \(public\.g5ls_inner, public\.g5ls_outer\): /u,
      /BRANDS_VIEW_BYPASS: public\.g5ls_inner, public\.g5ls_outer/u, () => sees('g5ls_outer')],
    ['F2 33 invoker views in a row (not decided)', DEEP_CHAIN, true, /^PF_BRANDS FAIL a view reads brands as its owner \(public\.g5ls_c33\): /u, /BRANDS_VIEW_BYPASS: public\.g5ls_c33/u,
      () => Promise.resolve(false)],
  ];
  for (const [label, [drift, restore], missed, pfWant, installWant, leaks] of cases) {
    // after the install (drift later): PR #600's preflight passed it, this one fails it; and what the person can read through it
    await sql(SUPER, drift);
    try {
      assert.equal((await oldPf()).startsWith('PF_BRANDS PASS'), missed, `${label}: PR #600's preflight`);
      assert.match(await newPf(), pfWant, label);
      if (!label.includes('33')) assert.ok(await leaks(), `${label}: S reads R's row through it (why it is a finding)`);
      // before the install: PR #600's install accepted it; this one refuses it and changes nothing
      await fixOk(ROLLBACK);
      const during = { catalog: await catalog(), acl: await readAcl() };
      const old = await psql(OWNER, ['-f', `${PR600}/${INSTALL}`]);
      assert.equal(old.ok, missed, `${label}: PR #600's install\n${old.error}`);
      if (old.ok) await fixOk(ROLLBACK);
      const r = await fix(INSTALL);
      assert.ok(!r.ok, `${label}: installed`);
      assert.match(r.error, installWant, label);
      assert.deepEqual([await catalog(), await readAcl(), await prestate()], [during.catalog, during.acl, '-'], `${label}: nothing changed`);
    } finally {
      await sql(SUPER, restore);
      if (await prestate() === '-') await fixOk(INSTALL);
    }
    assert.deepEqual([await catalog(), await readAcl(), await prestate()], [base.catalog, base.acl, base.pre], `${label}: restored`);
  }

  // safe chains pass both, and row security binds the person: invoker over invoker reads only S's own; invoker over a private owner-run
  // view is refused at the inner view
  for (const [label, [drift, restore]] of [['invoker over invoker', SAFE_INVOKER_CHAIN], ['owner-run over a private invoker view', SAFE_DEFINER_THEN_INVOKER],
    ['invoker over a private owner-run view', SAFE_UNGRANTED_INNER]] as Array<[string, [string, string]]>) {
    await sql(SUPER, drift);
    try {
      assert.match(await newPf(), /^PF_BRANDS PASS/u, label);
      await sql(SUPER, `notify pgrst, 'reload schema'`);
      for (let i = 0; i < 50 && (await S.client.from('g5ls_outer').select('id')).error?.code === 'PGRST205'; i++) await new Promise((r) => setTimeout(r, 100));
      const got = await S.client.from('g5ls_outer').select('id');
      if (label !== 'invoker over a private owner-run view') assert.deepEqual(got.data, [{ id: sws }], label);
      else assert.equal(code(got), '403:42501', label);
      await fixOk(ROLLBACK);
      await fixOk(INSTALL);
    } finally {
      await sql(SUPER, restore);
    }
  }
  assert.deepEqual([await catalog(), await readAcl(), await prestate()], [base.catalog, base.acl, base.pre], 'restored');
});

// ---- mutants of the brands fix and of PF_BRANDS (each must change the answer of its case) -------------------------------------------------
// psql reading SQL text from stdin (a mutant is never written to disk; the reviewed files are only read)
async function psqlText(user: string, text: string): Promise<Result> {
  const child = new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', DB_PORT, '-U', user, '-d', 'postgres', '-f', '-'],
    env: { LC_ALL: 'C', PGOPTIONS: '-c client_min_messages=notice' }, stdin: 'piped', stdout: 'piped', stderr: 'piped',
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(text));
  await w.close();
  const o = await child.output();
  return { ok: o.success, out: decoder.decode(o.stdout).trim(), error: decoder.decode(o.stderr).trim() };
}
function mutate(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `mutant site not unique: ${from.slice(0, 100)}`);
  return text.replace(from, to);
}
const pfLine = (r: Result, code: string) => [...r.error.matchAll(/G5_MVP_PREFLIGHT (\S+ \S+ [^\n]*)/gu)].map((m) => m[1]).find((l) => l.startsWith(`${code} `)) ?? '-';

Deno.test({ name: 'G5-02 #3 mutants: every guard of the brands install (27) and rollback (5) and every PF_BRANDS / PF_APP_READ clause (24) is load-bearing (G5-02 #3 + #4); the reviewed files are unchanged', ...opts }, async () => {
  const install = await Deno.readTextFile(`${FIX}/${INSTALL}`);
  const rollback = await Deno.readTextFile(`${FIX}/${ROLLBACK}`);
  const pf = await Deno.readTextFile(`${MVP}/MVP_RELEASE_PREFLIGHT.sql`);
  const installed = { catalog: await catalog(), acl: await readAcl(), pre: await prestate() };
  const killed: string[] = [];

  // ---- install: on the world as built with the drift each guard refuses, the mutant does not refuse as the original does
  await fixOk(ROLLBACK);
  const built = { catalog: await catalog(), acl: await readAcl() };
  await sql(SUPER, `create role g5ls_stranger login password 'postgres'`);
  const off = (code: string) => [`  if v_txt is not null then\n    raise exception '${code}`, `  if false then\n    raise exception '${code}`];
  const IM: Array<[string, string, string, string, string, RegExp, string?]> = [
    ['IM1 a superuser not refused', "  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then\n    raise exception 'BRANDS_ISOLATION_SUPERUSER",
      "  if false then\n    raise exception 'BRANDS_ISOLATION_SUPERUSER", 'select 1', 'select 1', /BRANDS_ISOLATION_SUPERUSER/u, SUPER],
    ['IM2 the owner not checked', "  if not pg_catalog.pg_has_role(current_user, v_owner, 'USAGE') then\n    raise exception 'BRANDS_ISOLATION_NOT_OWNER",
      "  if false then\n    raise exception 'BRANDS_ISOLATION_NOT_OWNER", 'select 1', 'select 1', /BRANDS_ISOLATION_NOT_OWNER/u, 'g5ls_stranger'],
    ['IM3 forced row security not refused', '  if (select c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = v_brands) then', '  if false then',
      'alter table public.brands force row level security', 'alter table public.brands no force row level security', /BRANDS_FORCE_ROW_SECURITY/u],
    ['IM4 memberships row security not checked', "case when not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = v_members) then 'row security off' end,", 'null::text,',
      'alter table public.brand_memberships disable row level security', 'alter table public.brand_memberships enable row level security', /BRANDS_MEMBERSHIPS_NOT_ISOLATED/u],
    ['IM5 memberships self policy roles not checked', "and p.polcmd = 'r' and p.polpermissive and p.polroles = array[v_auth] and p.polwithcheck is null\n",
      "and p.polcmd = 'r' and p.polpermissive and p.polwithcheck is null\n",
      'alter policy social_mobile_membership_self_select on public.brand_memberships to anon, authenticated',
      'alter policy social_mobile_membership_self_select on public.brand_memberships to authenticated', /BRANDS_MEMBERSHIPS_NOT_ISOLATED/u],
    ['IM6 memberships column writes not seen', 'else pg_catalog.has_any_column_privilege(x.oid, v_members, k) end))', 'else pg_catalog.has_table_privilege(x.oid, v_members, k) end))',
      'grant update (role) on public.brand_memberships to authenticated', 'revoke update (role) on public.brand_memberships from authenticated', /BRANDS_MEMBERSHIPS_NOT_ISOLATED/u],
    ['IM7 the brands policy condition not compared', BRANDS_QUAL_SITE, ')', ...F1_NO_CORRELATION, /BRANDS_MEMBER_POLICY/u],
    ['IM8 the memberships policy condition not compared', MEMBERS_QUAL_SITE, ')', ...F1_MEMBERSHIP_TRUE, /BRANDS_MEMBERSHIPS_NOT_ISOLATED/u],
    ['IM9 other policies not refused', ...off('BRANDS_UNREVIEWED_POLICY') as [string, string],
      'create policy g5ls_extra on public.brands for select to authenticated using (true)', 'drop policy g5ls_extra on public.brands', /BRANDS_UNREVIEWED_POLICY/u],
    ['IM10 PUBLIC policies not seen', "                  where u = 0 or pg_catalog.pg_has_role(v_anon, u, 'MEMBER')", "                  where pg_catalog.pg_has_role(v_anon, u, 'MEMBER')",
      'create policy g5ls_extra on public.brands for select to public using (true)', 'drop policy g5ls_extra on public.brands', /BRANDS_UNREVIEWED_POLICY/u],
    ['IM11 views not refused', ...off('BRANDS_VIEW_BYPASS') as [string, string],
      'create view public.g5ls_brands_v as select id from public.brands; grant select on public.g5ls_brands_v to anon', 'drop view public.g5ls_brands_v', /BRANDS_VIEW_BYPASS/u],
    ['IM12 materialized views not seen', "      from pg_catalog.pg_class c where c.relkind in ('v', 'm')),\n  walk(", "      from pg_catalog.pg_class c where c.relkind in ('v')),\n  walk(",
      'create materialized view public.g5ls_brands_m as select id from public.brands; grant select on public.g5ls_brands_m to authenticated', 'drop materialized view public.g5ls_brands_m',
      /BRANDS_VIEW_BYPASS/u],
    ['IM13 invoker writers not refused', ...off('BRANDS_INVOKER_WRITER') as [string, string], ...INVOKER_WRITER, /BRANDS_INVOKER_WRITER/u],
    ['IM14 filtered definers not refused', ...off('BRANDS_DEFINER_FILTERED') as [string, string], ...FILTERED_DEFINER, /BRANDS_DEFINER_FILTERED/u],
    ['IM15 the kind read not checked', ...off('BRANDS_MEMBER_READ_MISSING') as [string, string], ...KIND_REVOKE, /BRANDS_MEMBER_READ_MISSING/u],
    ['IM16 reached roles not checked after', "   where (pg_catalog.pg_has_role(v_anon, x.oid, 'MEMBER') or pg_catalog.pg_has_role(v_auth, x.oid, 'MEMBER'))\n     and case when k in",
      "   where x.rolname in ('anon', 'authenticated')\n     and case when k in", ...WRITER_ROLE, /BRANDS_POSTCONDITION_WRITE: authenticated:UPDATE, g5ls_writer:UPDATE/u],
    ['IM17 anon reads not checked after', ...off('BRANDS_POSTCONDITION_ANON_READ') as [string, string],
      'grant authenticated to anon', 'revoke authenticated from anon', /BRANDS_POSTCONDITION_ANON_READ/u],
    ['IM18 the record\'s ACL not checked', '     or exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(', '     or false and exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(',
      ...DEFAULT_ACL, /BRANDS_POSTCONDITION_PRESTATE/u],
    // G5-02 #4 (H1 F2): the view chain walk
    ['IM24 view chains not followed', '     where w.depth < 32 and (not w.invoker', '     where w.depth < 1 and (not w.invoker', ...F2_TWO_HOP, /BRANDS_VIEW_BYPASS: (public\.)?g5ls_outer/u],
    ['IM25 reach through an owner-run view forgotten', "     where w.depth < 32 and (not w.invoker or pg_catalog.has_any_column_privilege(w.api, e.child, 'SELECT')))",
      "     where w.depth < 32 and (pg_catalog.has_any_column_privilege(w.api, e.child, 'SELECT')))", ...F2_TWO_HOP, /BRANDS_VIEW_BYPASS: (public\.)?g5ls_outer/u],
    ['IM27 an undecided deep chain accepted', '      or (w.depth >= 32 and exists', '      or (false and exists', ...DEEP_CHAIN, /BRANDS_VIEW_BYPASS: /u],
  ];
  try {
    for (const [label, from, to, drift, restore, want, user] of IM) {
      await sql(SUPER, drift);
      try {
        const original = await fix(INSTALL, user ?? OWNER);
        assert.ok(!original.ok && want.test(original.error), `${label}: the original must refuse\n${original.error}`);
        const r = await psqlText(user ?? OWNER, mutate(install, from, to));
        assert.ok(r.ok || !want.test(r.error), `${label}: survived\n${r.error}`);
        killed.push(label.split(' ')[0]);
      } finally {
        if (await prestate() !== '-') {   // a mutant that installed (IM1 as the superuser): back to the world as built
          await sql(SUPER, 'alter table private.postona_brands_isolation_prestate owner to postgres');
          await fixOk(ROLLBACK);
        }
        await sql(SUPER, restore);
      }
    }
    // the change itself: without each step the postconditions refuse the whole transaction (the original installs on this same world)
    const CORE: Array<[string, string, string, RegExp]> = [
      ['IM19 anon kept', 'revoke all on table public.brands from public, anon;', 'revoke all on table public.brands from public;', /BRANDS_POSTCONDITION_WRITE: anon:/u],
      ['IM20 authenticated writes kept', '  revoke insert, update, delete, truncate, references, trigger on table public.brands from authenticated;\n', '', /BRANDS_POSTCONDITION_WRITE: authenticated:DELETE/u],
      ['IM21 row security left off', '  alter table public.brands enable row level security;\n', '', /BRANDS_POSTCONDITION_ROW_SECURITY/u],
    ];
    for (const [label, from, to, want] of CORE) {
      const r = await psqlText(OWNER, mutate(install, from, to));
      assert.ok(!r.ok && want.test(r.error), `${label}: survived\n${r.error}`);
      assert.deepEqual([await catalog(), await prestate()], [built.catalog, '-'], `${label}: refused as a whole`);
      killed.push(label.split(' ')[0]);
    }
    // MAINTAIN: the same, through the postcondition's MAINTAIN entry
    {
      const r = await psqlText(OWNER, mutate(install, "    execute 'revoke maintain on table public.brands from authenticated';", '    null;'));
      assert.ok(!r.ok && /BRANDS_POSTCONDITION_WRITE: authenticated:MAINTAIN/u.test(r.error), `IM22 survived\n${r.error}`);
      killed.push('IM22');
    }
    // the other way round (G5-02 #4): an invoker view over an owner-run view the API role may not select is no bypass; the original installs,
    // a walk that skips the privilege check of an invoker hop refuses it
    await sql(SUPER, SAFE_UNGRANTED_INNER[0]);
    try {
      await fixOk(INSTALL);
      await fixOk(ROLLBACK);
      const r = await psqlText(OWNER, mutate(install, "(not w.invoker or pg_catalog.has_any_column_privilege(w.api, e.child, 'SELECT')))", 'true)'));
      assert.ok(!r.ok && /BRANDS_VIEW_BYPASS/u.test(r.error), `IM26 survived\n${r.error}`);
      killed.push('IM26');
    } finally {
      if (await prestate() !== '-') await fixOk(ROLLBACK);
      await sql(SUPER, SAFE_UNGRANTED_INNER[1]);
    }
    // the version gate: a server outside the pinned major refuses before reading any policy
    {
      const r = await psqlText(OWNER, mutate(install, 'not between 170000 and 179999', 'not between 160000 and 169999'));
      assert.ok(!r.ok && /BRANDS_POLICY_UNVERIFIABLE: the member policies are pinned as PostgreSQL 17 prints them \(this is 17\./u.test(r.error), r.error);
    }
    assert.deepEqual([await catalog(), await readAcl()], [built.catalog, built.acl], 'restored');
  } finally {
    await sql(SUPER, 'drop role g5ls_stranger');
  }

  // ---- the record: a re-run must keep the first install's (the world as built), never the hardened state
  await fixOk(INSTALL);
  assert.equal(await prestate(), installed.pre);
  const saved = await sql(SUPER, 'select to_jsonb(p)::text from private.postona_brands_isolation_prestate p');
  {
    const r = await psqlText(OWNER, mutate(install, '  on conflict (id) do nothing;',
      '  on conflict (id) do update set row_security = excluded.row_security, table_acl = excluded.table_acl, column_acl = excluded.column_acl;'));
    assert.ok(r.ok, r.error);
    assert.notEqual(await prestate(), installed.pre, 'IM23 survived');
    killed.push('IM23');
    await sql(SUPER, `update private.postona_brands_isolation_prestate p set (row_security, table_acl, column_acl, recorded_at)
      = (select s.row_security, s.table_acl, s.column_acl, s.recorded_at from jsonb_populate_record(null::private.postona_brands_isolation_prestate, '${saved}') s)`);
    assert.equal(await prestate(), installed.pre);
  }

  // ---- rollback: from the installed world, with a column grant in the record (the as-built world plus anon SELECT (display_name))
  await fixOk(ROLLBACK);
  await sql(SUPER, 'grant select (display_name) on public.brands to anon');
  const builtCol = { catalog: await catalog(), acl: await readAcl() };
  await fixOk(INSTALL);
  const installedCol = { catalog: await catalog(), acl: await readAcl() };
  const recordSql = install.slice(install.indexOf('  create table if not exists private.postona_brands_isolation_prestate'), install.indexOf('  revoke all on table private.postona_brands_isolation_prestate'));
  const savedCol = await sql(SUPER, 'select to_jsonb(p)::text from private.postona_brands_isolation_prestate p');
  const RM: Array<[string, string, string, (r: Result) => boolean | Promise<boolean>]> = [
    ['RM1 table grants not restored', "    execute pg_catalog.format('grant %s on table public.brands to %s%s', v_entry.privilege, v_entry.grantee,\n                              case when v_entry.grantable then ' with grant option' else '' end);",
      '    null;', (r) => !r.ok && /BRANDS_ROLLBACK_POSTCONDITION/u.test(r.error)],
    ['RM2 column grants not restored', "    execute pg_catalog.format('grant %s (%I) on table public.brands to %s%s', v_entry.privilege, v_entry.\"column\", v_entry.grantee,\n                              case when v_entry.grantable then ' with grant option' else '' end);",
      '    null;', (r) => !r.ok && /BRANDS_ROLLBACK_POSTCONDITION/u.test(r.error)],
    ['RM3 row security not restored', '  if not v_pre.row_security then\n    alter table public.brands disable row level security;\n  end if;\n', '', (r) => !r.ok && /BRANDS_ROLLBACK_POSTCONDITION/u.test(r.error)],
    ['RM4 the postcondition off (with no column grant restored)', '  if v_got is distinct from v_want\n', '  if false and v_got is distinct from v_want\n',
      async (r) => r.ok && await readAcl() !== builtCol.acl],
    ['RM5 the record kept', '  drop table private.postona_brands_isolation_prestate;\n', '', async (r) => r.ok && await prestate() !== '-'],
  ];
  for (const [label, from, to, isKilled] of RM) {
    let text = mutate(rollback, from, to);
    if (label.startsWith('RM4')) text = mutate(text, RM[1][1], RM[1][2]);
    const r = await psqlText(OWNER, text);
    assert.ok(await isKilled(r), `${label}: survived\n${r.error}`);
    killed.push(label.split(' ')[0]);
    // back to the installed world: the record (if the mutant dropped it) and the real rollback + install
    if (await prestate() === '-') {
      await sql(OWNER, recordSql);
      await sql(OWNER, `insert into private.postona_brands_isolation_prestate select * from jsonb_populate_record(null::private.postona_brands_isolation_prestate, '${savedCol}')`);
    }
    await fixOk(ROLLBACK);
    assert.deepEqual([await catalog(), await readAcl()], [builtCol.catalog, builtCol.acl], `${label}: the real rollback restores the world with the column grant`);
    await fixOk(INSTALL);
    assert.deepEqual([await catalog(), await readAcl()], [installedCol.catalog, installedCol.acl]);
  }
  // the original rollback restores the column grant too, then the suite's world comes back
  await fixOk(ROLLBACK);
  assert.match(await readAcl(), /col:public\.brands\.display_name:\{anon=r\/postgres\}|col:brands\.display_name:\{anon=r\/postgres\}/u);
  await sql(SUPER, 'revoke select (display_name) on public.brands from anon');
  await fixOk(INSTALL);
  assert.deepEqual([await catalog(), await readAcl(), await prestate()], [installed.catalog, installed.acl, installed.pre]);

  // ---- PF_BRANDS / PF_APP_READ: on the fixed world with the drift each clause catches, the mutant no longer reports it
  const brandsWhere = "        where (pg_catalog.pg_has_role(pg_catalog.to_regrole('anon'), r.oid, 'MEMBER') or pg_catalog.pg_has_role(pg_catalog.to_regrole('authenticated'), r.oid, 'MEMBER'))\n          and case when k in";
  const PM: Array<[string, string, string, string, string, string, RegExp]> = [
    ['PM1 code_profile_key not checked', "('brands', 'publish_mode'), ('brands', 'code_profile_key'),", "('brands', 'publish_mode'),", ...KIND_REVOKE, 'PF_APP_READ', /^PF_APP_READ FAIL/u],
    ['PM2 the membership role not checked', "('brand_memberships', 'brand_id'), ('brand_memberships', 'role'),", "('brand_memberships', 'brand_id'),",
      'revoke select on public.brand_memberships from authenticated; grant select (brand_id, user_id) on public.brand_memberships to authenticated',
      'revoke select (brand_id, user_id) on public.brand_memberships from authenticated; grant select, maintain on public.brand_memberships to authenticated', 'PF_APP_READ', /^PF_APP_READ FAIL/u],
    ['PM3 row security not checked', 'and not c.relrowsecurity),', 'and false),', 'alter table public.brands disable row level security', 'alter table public.brands enable row level security', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM4 memberships row security not checked', "where c.oid in ('public.brands'::regclass, 'public.brand_memberships'::regclass) and not c.relrowsecurity",
      "where c.oid in ('public.brands'::regclass) and not c.relrowsecurity",
      'alter table public.brand_memberships disable row level security', 'alter table public.brand_memberships enable row level security', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM5 member policies not checked', "           then 'a member read policy (20260918120000) is missing or changed (name, command, role or condition)' end,", "           and false then 'x' end,",
      'alter policy social_mobile_membership_self_select on public.brand_memberships to anon, authenticated',
      'alter policy social_mobile_membership_self_select on public.brand_memberships to authenticated', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM6 policy roles not checked', "and p.polname = 'social_mobile_membership_self_select'\n                              and p.polcmd = 'r' and p.polpermissive and p.polroles = array[pg_catalog.to_regrole('authenticated')::oid]",
      "and p.polname = 'social_mobile_membership_self_select'\n                              and p.polcmd = 'r' and p.polpermissive",
      'alter policy social_mobile_membership_self_select on public.brand_memberships to anon, authenticated',
      'alter policy social_mobile_membership_self_select on public.brand_memberships to authenticated', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM7 brand writes not checked', 'pg_catalog.unnest(v_brand_writes) k', "pg_catalog.unnest('{}'::text[]) k",
      'grant update on public.brands to authenticated', 'revoke update on public.brands from authenticated', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM8 anon\'s reach not checked', brandsWhere, "        where pg_catalog.pg_has_role(pg_catalog.to_regrole('authenticated'), r.oid, 'MEMBER')\n          and case when k in",
      'grant insert on public.brands to anon', 'revoke insert on public.brands from anon', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM9 memberships\' other policies not warned', "    if v_n > 0 then\n      v_lines := v_lines || ('PF_BRANDS_POLICIES WARN", "    if false then\n      v_lines := v_lines || ('PF_BRANDS_POLICIES WARN",
      'create policy g5ls_extra_m on public.brand_memberships for select to authenticated using (true)', 'drop policy g5ls_extra_m on public.brand_memberships',
      'PF_BRANDS_POLICIES', /^PF_BRANDS_POLICIES WARN/u],
    ['PM10 column grants not seen', "then pg_catalog.has_any_column_privilege(r.oid, 'public.brands', k)", "then pg_catalog.has_table_privilege(r.oid, 'public.brands', k)",
      'grant update (display_name) on public.brands to authenticated', 'revoke update (display_name) on public.brands from authenticated', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM11 reached roles not seen', brandsWhere, "        where r.rolname in ('anon', 'authenticated')\n          and case when k in",
      'create role g5ls_writer nologin; grant update on public.brands to g5ls_writer; grant g5ls_writer to authenticated with inherit false',
      'revoke g5ls_writer from authenticated; revoke update on public.brands from g5ls_writer; drop role g5ls_writer', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM12 MAINTAIN not checked', "then array['MAINTAIN'] else", "then '{}'::text[] else",
      'grant maintain on public.brands to authenticated', 'revoke maintain on public.brands from authenticated', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM13 anon reads not checked', "and pg_catalog.has_any_column_privilege(r.oid, 'public.brands', 'SELECT')),", 'and false),',
      'grant select on public.brands to anon', 'revoke select on public.brands from anon', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM14 other brands policies not checked', "where p.polrelid = 'public.brands'::regclass and p.polpermissive and p.polname <> 'social_mobile_member_select_brands'", 'where false',
      'create policy g5ls_extra on public.brands for select to authenticated using (true)', 'drop policy g5ls_extra on public.brands', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM15 PUBLIC policies not seen', "          and exists (select 1 from pg_catalog.unnest(p.polroles) u where u = 0 or pg_catalog.pg_has_role(",
      '          and exists (select 1 from pg_catalog.unnest(p.polroles) u where pg_catalog.pg_has_role(',
      'create policy g5ls_extra on public.brands for select to public using (true)', 'drop policy g5ls_extra on public.brands', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM16 views not checked', "        where (not w.invoker and exists (select 1 from edge e where e.parent = w.rel and e.child = 'public.brands'::regclass))", '        where (false)',
      'create view public.g5ls_brands_v as select id from public.brands; grant select on public.g5ls_brands_v to authenticated', 'drop view public.g5ls_brands_v', 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    // the other way round: a security_invoker view is bound by row security and is NOT a finding; the mutant reports it
    ['PM17 security_invoker views reported', "where pg_catalog.lower(o) in ('security_invoker=true'", "where false and pg_catalog.lower(o) in ('security_invoker=true'",
      'create view public.g5ls_brands_iv with (security_invoker = true) as select id from public.brands; grant select on public.g5ls_brands_iv to authenticated', 'drop view public.g5ls_brands_iv',
      'PF_BRANDS', /^PF_BRANDS PASS/u],
    // G5-02 #4 (H1 F1 / F2)
    ['PM18 the brands policy condition not compared', PF_BRANDS_QUAL_SITE, ')', ...F1_NO_CORRELATION, 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM19 the memberships policy condition not compared', PF_MEMBERS_QUAL_SITE, ')', ...F1_MEMBERSHIP_TRUE, 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM20 view chains not followed', '          where w.depth < 32 and (not w.invoker', '          where w.depth < 1 and (not w.invoker', ...F2_TWO_HOP, 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM21 reach through an owner-run view forgotten', "          where w.depth < 32 and (not w.invoker or pg_catalog.has_any_column_privilege(w.api, e.child, 'SELECT')))",
      "          where w.depth < 32 and (pg_catalog.has_any_column_privilege(w.api, e.child, 'SELECT')))", ...F2_TWO_HOP, 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM22 an invoker hop\'s privilege not checked', "(not w.invoker or pg_catalog.has_any_column_privilege(w.api, e.child, 'SELECT')))", 'true)', ...SAFE_UNGRANTED_INNER, 'PF_BRANDS', /^PF_BRANDS PASS/u],
    ['PM23 an undecided deep chain passed', '           or (w.depth >= 32 and exists', '           or (false and exists', ...DEEP_CHAIN, 'PF_BRANDS', /^PF_BRANDS FAIL/u],
    ['PM24 materialized views not seen', "           from pg_catalog.pg_class c where c.relkind in ('v', 'm')),", "           from pg_catalog.pg_class c where c.relkind in ('v')),",
      'create materialized view public.g5ls_brands_m as select id from public.brands; grant select on public.g5ls_brands_m to authenticated', 'drop materialized view public.g5ls_brands_m',
      'PF_BRANDS', /^PF_BRANDS FAIL/u],
  ];
  for (const [label, from, to, drift, restore, code, want] of PM) {
    await sql(SUPER, drift);
    try {
      const original = await psqlText(OWNER, pf);
      assert.match(pfLine(original, code), want, `${label}: the original\n${original.error}`);
      const r = await psqlText(OWNER, mutate(pf, from, to));
      assert.notEqual(pfLine(r, 'PF_OWNER'), '-', `${label}: the mutant did not run\n${r.error}`);
      assert.doesNotMatch(pfLine(r, code), want, `${label}: survived`);
      killed.push(label.split(' ')[0]);
    } finally {
      await sql(SUPER, restore);
    }
  }
  assert.deepEqual([await catalog(), await readAcl(), await prestate()], [installed.catalog, installed.acl, installed.pre], 'restored');
  // the reviewed files were only read
  assert.deepEqual([await Deno.readTextFile(`${FIX}/${INSTALL}`), await Deno.readTextFile(`${FIX}/${ROLLBACK}`), await Deno.readTextFile(`${MVP}/MVP_RELEASE_PREFLIGHT.sql`)], [install, rollback, pf]);
  // the version gate of the preflight: a server outside the pinned major is a FAIL, not a guess
  {
    const r = await psqlText(OWNER, mutate(pf, 'not between 170000 and 179999', 'not between 160000 and 169999'));
    assert.match(pfLine(r, 'PF_BRANDS'), /^PF_BRANDS FAIL the member read policies are pinned as PostgreSQL 17 prints them \(this is 17\./u);
  }
  assert.equal(killed.length, 27 + 5 + 24);
  console.log(`G5-02 #3/#4 mutants killed ${killed.length} / ${27 + 5 + 24}: ${killed.join(' ')}`);
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
