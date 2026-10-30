// G5-50: the personal MVP release path and ONE end-to-end chain on throw-away databases (see postona_personal_mvp_release_pg_run.sh).
// MVP_RELEASE_PREFLIGHT.sql (read-only) refuses every environment the release must not go into, all findings at once, with nothing changed, and
// tells the phase; then install -> grant -> the person -> stop -> re-grant -> stop -> rollback, the preflight after each step. The chain is
// G1 PR #576's real code (snapshot read -> workspace id, assist gate, post-assist client) -> G6 PR #566's real Edge entry (personal-MVP adapter,
// G5 transport, ledger client) -> G5's R1-MVP + G6's real ledger SQL -> a fake OpenAI, with the test playing GoTrue / PostgREST / the Functions
// client (fixed fake tokens -> fixed claims; no JWT is verified: NOT_VERIFIED). Production NO_GO.
import assert from 'node:assert/strict';

const env = (name: string) => Deno.env.get(name) ?? '';
const [HOST, PORT, SUPER, OWNER, DB, LED, MVP, G1, G6] = ['S50_HOST', 'S50_PORT', 'S50_SUPER', 'S50_OWNER', 'S50_DB', 'S50_LED', 'S50_MVP', 'S50_G1', 'S50_G6'].map(env);
const enabled = env('S50_E2E') === '1' && /^\/(private\/)?tmp\//u.test(HOST);
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };
const decoder = new TextDecoder();

type Result = { ok: boolean; out: string; error: string };
async function run(db: string, user: string, args: string[]): Promise<Result> {
  const o = await new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', HOST, '-p', PORT, '-U', user, '-d', db, ...args],
    env: { LC_ALL: 'C', PGTZ: 'UTC', PGOPTIONS: '-c client_min_messages=notice' }, stdout: 'piped', stderr: 'piped',
  }).output();
  return { ok: o.success, out: decoder.decode(o.stdout).trim(), error: decoder.decode(o.stderr).trim() };
}
async function sql(statement: string, user = OWNER, db = DB): Promise<string> {
  const r = await run(db, user, ['-c', statement]);
  assert.ok(r.ok, `${statement}\n${r.error}`);
  return r.out;
}
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const file = (name: string, user = OWNER) => run(DB, user, ['-f', `${MVP}/${name}`]);
const ok = async (name: string) => { const r = await file(name); assert.ok(r.ok, `${name}\n${r.error}`); };
// the preflight's verdict: "PASS phase=<p> warnings=<n>" or "FAIL <codes>", and its lines
async function preflight(user = OWNER) {
  const r = await file('MVP_RELEASE_PREFLIGHT.sql', user);
  const lines = [...r.error.matchAll(/G5_MVP_PREFLIGHT (\S+ \S+ [^\n]*)/gu)].map((m) => m[1]);
  const verdict = r.ok ? lines.find((l) => l.startsWith('VERDICT PASS'))?.slice(8) ?? `? ${r.error}` : `FAIL ${r.error.match(/G5_MVP_PREFLIGHT_FAILED ([^\n]*)/u)?.[1] ?? r.error}`;
  return { verdict, lines };
}
// everything a release step could change: functions (body / ACL / owner / config), default ACLs, role memberships, relation ACLs
const catalog = () => sql(`select md5(string_agg(x, E'\\n' order by x)) from (
  select 'p ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '-') || ' ' || p.proowner::regrole::text || coalesce(p.proconfig::text, '') x
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^(pg_|information_schema)'
  union all select 'd ' || d.defaclrole::regrole::text || ' ' || d.defaclnamespace::text || d.defaclobjtype::text || ' ' || d.defaclacl::text from pg_default_acl d
  union all select 'm ' || m.roleid::regrole::text || ' ' || m.member::regrole::text || m.admin_option || m.inherit_option || m.set_option from pg_auth_members m
  union all select 'c ' || c.oid::regclass::text || ' ' || coalesce(c.relacl::text, '-') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^(pg_|information_schema)') s`, SUPER);

// ---- people (G5's world) ---------------------------------------------------------------------------------------------------------------
const id = (n: number) => `00000000-0000-4000-8000-0000000650${String(n).padStart(2, '0')}`;
const [A, B, D] = [id(1), id(2), id(4)];
const [SA, SA2, SB, SD] = [id(51), id(61), id(52), id(54)];
type Claims = Record<string, unknown>;
const claims = (u: string, s: string, extra: Claims = {}): Claims => ({ sub: u, role: 'authenticated', session_id: s, is_anonymous: false, ...extra });
const TOKENS: Record<string, { role: string; claims: Claims }> = {
  'g550-a.session-a.NOTREAL': { role: 'authenticated', claims: claims(A, SA) },
  'g550-a.session-a2.NOTREAL': { role: 'authenticated', claims: claims(A, SA2) },
  'g550-a.anonymous.NOTREAL': { role: 'authenticated', claims: claims(A, SA, { is_anonymous: true }) },
  'g550-b.session-b.NOTREAL': { role: 'authenticated', claims: claims(B, SB) },
  'g550-d.session-d.NOTREAL': { role: 'authenticated', claims: claims(D, SD) },
};
const [TA, TA2, TANON, TB] = ['g550-a.session-a.NOTREAL', 'g550-a.session-a2.NOTREAL', 'g550-a.anonymous.NOTREAL', 'g550-b.session-b.NOTREAL'];
const derived = (u: string) => sql(`select 'u_' || substr(md5('${u}'), 1, 24)`);
let [WA, WB, WD] = ['', '', ''];

// ---- G6's Edge entry with the test playing PostgREST (G5 / ledger) and OpenAI ------------------------------------------------------------
const SUPABASE = 'https://abcdefghijklmnopqrst.supabase.co';
const SERVICE_KEY = 'sb_secret_' + 'FAKE_G5_50_0000000000';
const PUBLISHABLE = 'sb_publishable_' + 'FAKE_G5_50_NOT_A_SECRET';
const seen = { g5: 0, ledger: 0, provider: 0, other: [] as string[], g5Bodies: [] as string[] };
const g5Script: string[] = []; // statements run (rolled back) inside the n-th G5 question of the next request
let g5n = 0;
async function edge() {
  const { createPostonaPostAssistEdgeHandler, POST_ASSIST_EDGE_ENV } = await import(`${G6}/ai_gateway/postona_post_assist_edge.ts`);
  const { G5_VERDICT_RPC } = await import(`${G6}/ai_gateway/g5_rpc_transport.ts`);
  const { FAKE_OPENAI_KEY, jsonResponse, openAiBody } = await import(`${G6}/ai_provider/test_support.ts`);
  const E: Record<string, string> = {
    [POST_ASSIST_EDGE_ENV.supabaseUrl]: SUPABASE, [POST_ASSIST_EDGE_ENV.publishableKey]: PUBLISHABLE, [POST_ASSIST_EDGE_ENV.serviceKey]: SERVICE_KEY,
    [POST_ASSIST_EDGE_ENV.feature]: JSON.stringify({ enabled: true, revision: 'g5-50-pg-1', provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'low',
      maxOutputTokens: 800, timeoutMs: 20_000, maxAttempts: 1, maxCostUsdPerOperation: 0.1, maxInputBytes: 8_000, entitlements: ['postona:x_autopost'] }),
    [POST_ASSIST_EDGE_ENV.allowedOrigins]: 'https://app.postona.example', OPENAI_API_KEY: FAKE_OPENAI_KEY,
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const h = new Headers(init?.headers);
    const body = String(init?.body ?? '');
    if (url === `${SUPABASE}/rest/v1/rpc/${G5_VERDICT_RPC}`) {
      seen.g5++; seen.g5Bodies.push(`${h.get('apikey') === PUBLISHABLE} ${Object.keys(JSON.parse(body)).sort().join(',')}`);
      const who = TOKENS[h.get('Authorization')?.match(/^Bearer (\S+)$/u)?.[1] ?? ''];
      if (h.get('apikey') !== PUBLISHABLE || !who) return jsonResponse(401, { code: 'PGRST301', message: 'JWT invalid' });
      const p = JSON.parse(body) as Record<string, string | null>;
      const call = `select public.common_account_authorization_verdict(${lit(String(p.p_app))}, ${lit(String(p.p_feature))}, ${p.p_brand_id === null ? 'null' : lit(String(p.p_brand_id))})::text`;
      const r = await run(DB, OWNER, ['-c', `begin; ${g5Script[g5n++] ?? ''}`, '-c', `select set_config('request.jwt.claims', ${lit(JSON.stringify(who.claims))}, true); set local role ${who.role};`,
        '-c', call, '-c', 'rollback;']);
      if (r.ok) return new Response(r.out.split('\n').pop(), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (/permission denied for function/u.test(r.error)) return jsonResponse(403, { code: '42501', message: 'permission denied' });
      if (/function public\.common_account_authorization_verdict\(.*\) does not exist/u.test(r.error)) return jsonResponse(404, { code: 'PGRST202', message: 'not found' });
      return jsonResponse(500, { code: 'XX000', message: 'statement failed' });
    }
    const rpc = url.startsWith(`${SUPABASE}/rest/v1/rpc/`) ? url.slice(`${SUPABASE}/rest/v1/rpc/`.length) : null;
    if (rpc !== null && /^ai_(?:ledger|calls)_[a-z_]+$/u.test(rpc)) {
      seen.ledger++;
      if (h.get('apikey') !== SERVICE_KEY) return jsonResponse(401, { code: 'PGRST301' });
      const payload = JSON.stringify((JSON.parse(body) as { p: unknown }).p);
      assert.ok(!payload.includes('$g550$'));
      const r = await run(LED, SUPER, ['-c', `set role service_role; select public.${rpc}($g550$${payload}$g550$::jsonb)`]);
      return r.ok ? new Response(r.out, { status: 200, headers: { 'Content-Type': 'application/json' } }) : jsonResponse(400, { code: r.error.match(/ERROR:\s+([A-Z0-9_]+)/u)?.[1] ?? 'XX000' });
    }
    if (url.startsWith('https://api.openai.com/')) {
      seen.provider++;
      return jsonResponse(200, openAiBody({ candidates: [{ text: '週末限定のいちごタルトです。', hashtags: ['#いちごタルト'] }] }, { model: 'gpt-6-luna' }));
    }
    seen.other.push(url);
    return jsonResponse(404, {});
  };
  return createPostonaPostAssistEdgeHandler({ readEnv: (name: string) => E[name], fetch, g5TimeoutMs: 10_000,
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 }, sleep: () => Promise.resolve(), random: () => 0 });
}

// ---- G1's supabase client as the app holds it for one signed-in session (GoTrue / PostgREST / Functions played here) ---------------------
type Row = Record<string, unknown>;
// `unordered`: G1 reads without an ORDER BY, so PostgREST may return the rows in any order; the test can pin one (id asc / desc)
function appClient(handler: (r: Request) => Promise<Response>, token: string, unordered: 'asc' | 'desc' | null = null) {
  const who = TOKENS[token];
  const select = (table: string) => {
    assert.match(table, /^[a-z_]+$/u);
    const q = { cols: '*', where: [] as string[], order: '', limit: '' };
    const builder = {
      select(cols: string) { assert.match(cols, /^[a-z_,]+$/u); q.cols = cols; return builder; },
      eq(col: string, v: string) { q.where.push(`${col} = ${lit(v)}`); return builder; },
      in(col: string, vs: string[]) { q.where.push(`${col} in (${vs.map(lit).join(', ') || 'null'})`); return builder; },
      order(col: string, o: { ascending: boolean }) { q.order = ` order by ${col} ${o.ascending ? 'asc' : 'desc'}`; return builder; },
      limit(n: number) { q.limit = ` limit ${Number(n)}`; return builder; },
      then(resolve: (v: { data: Row[] | null; error: { code: string } | null }) => void) {
        const order = q.order || (unordered && /(^|,)id(,|$)/u.test(q.cols) ? ` order by id ${unordered}` : '');
        const statement = `select coalesce(jsonb_agg(t order by n), '[]')::text from (select ${q.cols}, row_number() over () n from (select ${q.cols} from public.${table}${q.where.length ? ' where ' + q.where.join(' and ') : ''}${order}${q.limit}) u) t`;
        return run(DB, OWNER, ['-c', 'begin;', '-c', `select set_config('request.jwt.claims', ${lit(JSON.stringify(who.claims))}, true); set local role authenticated;`, '-c', statement, '-c', 'rollback;'])
          .then((r) => resolve(r.ok ? { data: JSON.parse(r.out.split('\n').pop()!), error: null } : { data: null, error: { code: /permission denied/u.test(r.error) ? '42501' : 'XX000' } }));
      },
    };
    return builder;
  };
  return {
    auth: { getUser: () => Promise.resolve(who ? { data: { user: { id: who.claims.sub } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } }) },
    from: select,
    functions: {
      // supabase-js FunctionsClient: JSON body, the client's apikey, the caller's headers; a non-2xx answer is an error whose context is the Response
      async invoke(name: string, o: { body: unknown; headers: Record<string, string> }) {
        const text = JSON.stringify(o.body);
        const res = await handler(new Request(`${SUPABASE}/functions/v1/${name}`, { method: 'POST', body: text,
          headers: { 'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(text).length), apikey: PUBLISHABLE, ...o.headers } }));
        return res.ok ? { data: await res.json(), error: null } : { data: null, error: Object.assign(new Error('FunctionsHttpError'), { context: res }) };
      },
    },
  };
}

// one press of AIで下書き in the composer, exactly as the app does it: snapshot -> env -> gate -> request -> send
let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;
async function app(token: string, o: { brandId?: string; userId?: string; unordered?: 'asc' | 'desc' } = {}) {
  const { SupabaseSocialRepository } = await import(`${G1}/data/supabase-repository.ts`);
  const assist = await import(`${G1}/features/schedule/post-assist.ts`);
  const client = appClient(await edge(), token, o.unordered ?? null);
  const snap = await new SupabaseSocialRepository(client).readSnapshot();
  const workspaceId: string | null = snap.data.workspace?.id ?? null;
  const e = { client, accessToken: token, userId: o.userId ?? String(TOKENS[token].claims.sub), brandId: o.brandId ?? workspaceId, workspaceId, platform: 'x', preview: false };
  const press = () => {
    const request = assist.newAssistRequest(e, uuid, 'row-1', 'draft', '', { notes: 'いちごタルト 週末限定', instruction: '' });
    return { request, send: () => request === null ? Promise.resolve(null) : assist.sendAssist(e, request) };
  };
  return { snapshot: snap.state as string, workspaceId, block: assist.assistBlock(e) as string | null, press, mod: assist };
}
const kind = (s: { kind: string } | null) => s === null ? 'NOT_SENT' : s.kind;
const counts = () => `g5=${seen.g5} ledger>0=${seen.ledger > 0} provider=${seen.provider} other=${seen.other.length}`;

Deno.test({ name: 'setup: A and D started POSTONA in their own workspace (live session), B is logged in without it; nothing installed', ...opts }, async () => {
  await sql(`select public.fixture_user_with_workspace(u, 'g550' || right(u::text, 2)), public.fixture_login(u) from unnest(array['${A}', '${B}', '${D}']::uuid[]) u;
    insert into auth.sessions (id, user_id, not_after) values ('${SA}', '${A}', null), ('${SB}', '${B}', null), ('${SD}', '${D}', null)`);
  for (const [u, s] of [[A, SA], [D, SD]]) {
    const started = await run(DB, OWNER, ['-c', 'begin;', '-c', `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims(u, s)))}, true); set local role authenticated;`,
      '-c', "select public.start_x_autopost_service() ->> 'status'", '-c', 'commit;']);
    assert.ok(started.ok && started.out.split('\n').includes('active'), started.error || started.out);
  }
  [WA, WB, WD] = await Promise.all([A, B, D].map(derived));
});

const PRE: { catalog?: string } = {};
Deno.test({ name: 'preflight on the release world: PASS phase=absent, every check reported, nothing changed', ...opts }, async () => {
  PRE.catalog = await catalog();
  const p = await preflight();
  assert.equal(p.verdict, 'PASS phase=absent warnings=0', p.lines.join('\n'));
  assert.deepEqual(p.lines.filter((l) => !l.startsWith('VERDICT')).map((l) => l.split(' ').slice(0, 2).join(' ')),
    ['PF_OWNER PASS', 'PF_P1 PASS', 'PF_P3 PASS', 'PF_APP_READ PASS', 'PF_BRANDS PASS', 'PF_OWNER_AUTH PASS', 'PF_AUTH PASS', 'PF_ROLE_GRAPH PASS', 'PF_AUTHENTICATOR PASS', 'PF_DEFAULT_ACL PASS', 'PF_PHASE PASS', 'PF_W0 PASS', 'PF_DATA PASS']);
  assert.equal(await catalog(), PRE.catalog);
});

Deno.test({ name: 'preflight refuses each environment the release must not go into -- all findings at once, nothing changed, restored after', ...opts }, async () => {
  const cases: Array<[string, string, string, string, string?]> = [
    ['authenticator cannot SET ROLE authenticated', 'revoke authenticated from authenticator', 'grant authenticated to authenticator with inherit false, set true', 'PF_AUTHENTICATOR', SUPER],
    ['authenticator inherits authenticated', 'revoke authenticated from authenticator; grant authenticated to authenticator with inherit true, set true',
      'revoke authenticated from authenticator; grant authenticated to authenticator with inherit false, set true', 'PF_AUTHENTICATOR', SUPER],
    ['anon is a member of authenticated', 'grant authenticated to anon', 'revoke authenticated from anon', 'PF_ROLE_GRAPH', SUPER],
    ['authenticator is a member of the lifecycle owner', `grant ${OWNER} to authenticator with inherit false`, `revoke ${OWNER} from authenticator`, 'PF_ROLE_GRAPH', SUPER],
    ['the owner\'s default privileges give functions to a role the install does not revoke (authenticator)', 'alter default privileges in schema private grant execute on functions to authenticator',
      'alter default privileges in schema private revoke execute on functions from authenticator', 'PF_DEFAULT_ACL'],
    ['auth.uid() reads only the legacy claim', "create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$",
      "create or replace function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$",
      'PF_AUTH'],
    ['an API write path on brand_memberships', 'grant insert on public.brand_memberships to authenticated', 'revoke insert on public.brand_memberships from authenticated', 'PF_P3'],
  ];
  const base = await catalog();
  const p0 = await preflight(SUPER);
  assert.equal(p0.verdict, 'FAIL PF_OWNER', 'a superuser');
  for (const [label, drift, restore, code, user] of cases) {
    await sql(drift, user ?? OWNER);
    try {
      const during = await catalog();
      const p = await preflight();
      assert.equal(p.verdict, `FAIL ${code}`, `${label}\n${p.lines.join('\n')}`);
      assert.equal(await catalog(), during, `${label}: the preflight changed nothing`);
    } finally {
      await sql(restore, user ?? OWNER);
    }
  }
  // all at once: every finding in one run
  for (const [, drift, , , user] of cases.slice(1, 6)) await sql(drift, user ?? OWNER);
  try {
    const all = await preflight();
    assert.equal(all.verdict, 'FAIL PF_AUTH PF_AUTHENTICATOR PF_DEFAULT_ACL PF_ROLE_GRAPH', all.lines.join('\n'));
    console.log(`G5-50 all at once: ${all.verdict}`);
    // why PF_DEFAULT_ACL is a release blocker: the install itself refuses late, as one transaction
    const r = await file('MVP_INSTALL.sql');
    assert.match(r.error, /S22_POSTCONDITION_SHAPE/u);
  } finally {
    for (const [, , restore, , user] of cases.slice(1, 6).reverse()) await sql(restore, user ?? OWNER);
  }
  assert.equal(await catalog(), base, 'restored');
  assert.equal((await preflight()).verdict, 'PASS phase=absent warnings=0');
});

Deno.test({ name: 'release: install -> preflight installed; the app\'s draft is not available (R1-MVP owner-only); grant -> preflight granted', ...opts }, async () => {
  await ok('MVP_INSTALL.sql');
  assert.equal((await preflight()).verdict, 'PASS phase=installed warnings=0');
  const a = await app(TA);
  assert.deepEqual([a.snapshot, a.workspaceId, a.block], ['ready', WA, null], 'G1 reads the derived personal id as the workspace');
  assert.equal(kind(await a.press().send()), 'not_available');
  assert.equal(seen.provider, 0);
  await ok('MVP_R1_EXECUTE_GRANT.sql');
  assert.equal((await preflight()).verdict, 'PASS phase=granted warnings=0');
});

Deno.test({ name: 'chain (granted): G1 snapshot -> gate -> client -> G6 Edge -> G5 R1-MVP -> ledger -> fake OpenAI: candidates; same key = stored; anonymous / B / another workspace refused; G1 sends 3 args only', ...opts }, async () => {
  const a = await app(TA);
  const p = a.press();
  const before = seen.provider;
  assert.equal(kind(await p.send()), 'candidates');
  assert.equal(seen.provider, before + 1, 'one provider call');
  assert.equal(kind(await p.send()), 'candidates', 'the same key again (a retry)');
  assert.equal(seen.provider, before + 1, 'the same key never calls the provider twice');
  assert.ok(seen.g5Bodies.every((b) => b === 'true p_app,p_brand_id,p_feature'), seen.g5Bodies.join('|'));
  // refused, nothing sent to the provider
  const anon = await app(TANON);
  assert.equal(kind(await anon.press().send()), 'not_available', 'anonymous session');
  const b = await app(TB);
  assert.deepEqual([b.snapshot, b.workspaceId], ['ready', WB], 'B has a workspace but never started POSTONA');
  assert.equal(kind(await b.press().send()), 'not_available', 'B: no x_autopost service');
  const other = await app(TA, { brandId: WD });
  assert.equal(other.block, 'other_workspace', 'G1 itself does not send for another workspace');
  assert.equal(kind(await other.press().send()), 'NOT_SENT');
  const g5Before = seen.g5;
  const skip = { client: appClient(await edge(), TA), accessToken: TA, userId: A, brandId: WD, workspaceId: WD, platform: 'x', preview: false };
  const direct = await other.mod.sendAssist(skip, other.mod.newAssistRequest(skip, uuid, 'row-1', 'draft', '', { notes: 'x', instruction: '' }));
  assert.equal(kind(direct), 'not_available', 'a request for D\'s workspace that skips G1\'s gate: G5 refuses');
  assert.equal(seen.g5, g5Before + 1);
  assert.equal(seen.provider, before + 1, counts());
  assert.deepEqual(seen.other, []);
});

Deno.test({ name: 'chain: the session ends -> not available; a new session -> candidates again (re-authorization); end + restart -> candidates with the new generation; an end between check and send -> refused before the provider', ...opts }, async () => {
  const before = seen.provider;
  await sql(`update auth.sessions set not_after = now() - interval '1 minute' where id = '${SA}'`);
  assert.equal(kind(await (await app(TA)).press().send()), 'not_available', 'the old session');
  await sql(`insert into auth.sessions (id, user_id, not_after) values ('${SA2}', '${A}', null)`);
  assert.equal(kind(await (await app(TA2)).press().send()), 'candidates', 'signed in again');
  const lv = await sql(`select lifecycle_version from public.common_accounts where user_id = '${A}'`);
  await sql(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A}' and service_key = 'x_autopost'`);
  assert.equal(kind(await (await app(TA2)).press().send()), 'not_available', 'service ended');
  // the person restarts it, naming the generation they see now (the end itself moved it)
  const re = await run(DB, OWNER, ['-c', 'begin;', '-c', `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims(A, SA2)))}, true); set local role authenticated;`,
    '-c', `select public.reactivate_x_autopost_service((select lifecycle_version from public.common_accounts where user_id = '${A}')) ->> 'status'`, '-c', 'commit;']);
  assert.ok(re.ok && re.out.split('\n').includes('active'), re.error || re.out);
  assert.ok(Number(await sql(`select lifecycle_version from public.common_accounts where user_id = '${A}'`)) > Number(lv), 'a new generation');
  assert.equal(kind(await (await app(TA2)).press().send()), 'candidates', 'restarted');
  // the service ends after G6's first check and before its recheck right before the send
  g5Script.length = 0; g5n = 0;
  g5Script.push('', `update public.service_entitlements set status = 'suspended' where user_id = '${A}' and service_key = 'x_autopost';`);
  try {
    assert.equal(kind(await (await app(TA2)).press().send()), 'not_available', 'stale between check and send');
  } finally {
    g5Script.length = 0; g5n = 0;
  }
  assert.equal(seen.provider, before + 2, counts());
});

Deno.test({ name: 'contract gap (G1 owns it): with a second membership G1 shows the first brand it reads; when that is not the derived personal id, the eligible person gets "not available" and G1 blocks the id G5 would allow', ...opts }, async () => {
  // a shared (non-personal) brand owned by D with A as a member (A and D then have 2 memberships each); G1 reads A's brands without an ORDER BY, so both orders are run
  await sql(`insert into public.brands (id, code_profile_key) values ('a_g550_shared', 'kabumori_team_v1');
    insert into public.brand_memberships (brand_id, user_id, role) values ('a_g550_shared', '${D}', 'owner'), ('a_g550_shared', '${A}', 'member')`);
  try {
    const first = await app(TA2, { unordered: 'asc' });
    assert.equal(first.workspaceId, 'a_g550_shared', 'G1 shows the first brand it reads (the shared one)');
    assert.equal(kind(await first.press().send()), 'not_available', 'sent for the shared brand: G5 BRAND_ACCESS_DENIED');
    const personal = await app(TA2, { brandId: WA, unordered: 'asc' });
    assert.equal(personal.block, 'other_workspace', 'G1 blocks the personal id, which G5 would allow');
    assert.equal(kind(await personal.press().send()), 'NOT_SENT');
    const second = await app(TA2, { unordered: 'desc' });
    assert.equal(second.workspaceId, WA, 'the other order: G1 shows the personal id');
    assert.equal(kind(await second.press().send()), 'candidates', 'the person is eligible on the derived id (one membership there, owns no other brand)');
    const p = await preflight();
    assert.equal(p.verdict, 'PASS phase=granted warnings=1', p.lines.join('\n'));
    assert.ok(p.lines.some((l) => l.startsWith('PF_DATA_MULTI_MEMBERSHIP WARN 2 ')), p.lines.join('\n'));
    console.log('G5-50 second membership: G1 shows a_g550_shared (not_available) or the personal id (candidates) depending on row order');
  } finally {
    await sql(`delete from public.brand_memberships where brand_id = 'a_g550_shared'; delete from public.brands where id = 'a_g550_shared'`);
  }
});

Deno.test({ name: 'stop: MVP_R1_EXECUTE_REVOKE.sql -> preflight installed, the app is not available (stored key too); re-grant -> candidates; stop -> rollback -> preflight absent, the catalog as before the release', ...opts }, async () => {
  const before = seen.provider;
  const a = await app(TA2);
  const p = a.press();
  assert.equal(kind(await p.send()), 'candidates');
  await ok('MVP_R1_EXECUTE_REVOKE.sql');
  assert.equal((await preflight()).verdict, 'PASS phase=installed warnings=0');
  assert.equal(kind(await p.send()), 'not_available', 'a stored key after the stop');
  assert.equal(kind(await a.press().send()), 'not_available', 'a new key after the stop');
  await ok('MVP_R1_EXECUTE_GRANT.sql');
  assert.equal(kind(await p.send()), 'candidates', 're-granted: the stored candidates');
  assert.equal(seen.provider, before + 1, counts());
  // a drifted release: the health check says so, and the stop is the way back
  await sql('grant execute on function private.postona_personal_worker_verdict(uuid,text,text,bigint) to authenticated');
  assert.equal((await preflight()).verdict, 'FAIL PF_GATES', 'a widened gate');
  await sql('revoke execute on function private.postona_personal_worker_verdict(uuid,text,text,bigint) from authenticated');
  await sql('grant execute on function public.common_account_authorization_verdict(text,text,text) to service_role');
  assert.equal((await preflight()).verdict, 'FAIL PF_PHASE', 'R1-MVP granted beyond authenticated');
  await ok('MVP_R1_EXECUTE_REVOKE.sql');
  assert.equal((await preflight()).verdict, 'PASS phase=installed warnings=0', 'the stop clears the drift');
  await ok('MVP_R1_EXECUTE_REVOKE.sql');
  await ok('MVP_ROLLBACK.sql');
  assert.equal((await preflight()).verdict, 'PASS phase=absent warnings=0');
  const gone = kind(await (await app(TA2)).press().send());
  assert.ok(['not_available', 'unavailable', 'retry_same_key'].includes(gone), `rolled back: R1-MVP absent (PostgREST 404) -> ${gone}`);
  console.log(`G5-50 rolled back: the app shows ${gone}`);
  assert.equal(await catalog(), PRE.catalog, 'the catalog as before the release');
});
