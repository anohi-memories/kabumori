// G5-02 task 9: POSTONA push devices (supabase/candidates/postona_push_devices) on the REAL local Supabase runtime, run by
// postona_personal_workspace_local_run.sh after the workspace and media box suites: GoTrue ES256 JWTs and real sessions (sign-out deletes
// the session row), PostgREST, Kong, PG 17.6.1.165. The person's calls go through the G5-owned client module (client.ts) over supabase-js
// 2.115.0, as G1 will make them; the worker side is called as the lifecycle owner, as a G3 delivery function owned by it would.
// No push is sent: every token is a fake made here at run time ("ExponentPushToken[g5ptok...]"); no test prints one (only SHA-256 hashes are
// compared) and the runner scans every container log for the marker afterwards. Network: only the local API port (the runner's --allow-net).
// G5-02 task 10: H4 #331 task 24's three P2 are first reproduced on PR #667's own files (G5LS_PR667: install / stop / rollback / client.ts
// at 9140cefd), then the same cases pass on this tree's. G5-02 task 11: H4 #331 task 25's two P2 likewise on PR #672's files (G5LS_PR672,
// a04c1709). G5-02 task 12: H4 #331 task 26's two P2 likewise on PR #676's files (G5LS_PR676, 6bd753cf). A token whose control is not
// proven is PENDING; the tests play the push provider: the worker's private.postona_push_proof_issue gives the nonce, and the app on the
// phone that holds the token answers it (reg() does this for the phone the test registers from; reg1() never does).
import assert from 'node:assert/strict';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0';

const API = Deno.env.get('G5LS_API') ?? '';
const PUBLISHABLE = Deno.env.get('G5LS_PUBLISHABLE') ?? '';
const SECRET = Deno.env.get('G5LS_SECRET') ?? '';
const DB_PORT = Deno.env.get('G5LS_DB_PORT') ?? '';
const MVP = Deno.env.get('G5LS_MVP') ?? '';
const PUSH = Deno.env.get('G5LS_PUSH') ?? '';
const PR667 = Deno.env.get('G5LS_PR667') ?? '';
const PR672 = Deno.env.get('G5LS_PR672') ?? '';
const PR676 = Deno.env.get('G5LS_PR676') ?? '';
const PR681 = Deno.env.get('G5LS_PR681') ?? '';
const PR687 = Deno.env.get('G5LS_PR687') ?? '';
const enabled = API !== '' && PUBLISHABLE !== '' && SECRET !== '' && MVP !== '' && PUSH !== '' && DB_PORT !== '' && PR667 !== '' && PR672 !== '' && PR676 !== '' && PR681 !== '' && PR687 !== '';
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };
const OWNER = 'postgres';
const SUPER = 'supabase_admin';
const INSTALL = '001_push_devices.sql';
const STOP = '001_push_devices_stop.sql';
const ROLLBACK = '001_push_devices_rollback.sql';
const decoder = new TextDecoder();
const pd = enabled ? await import(`file://${PUSH}/client.ts`) : null;
const pd667 = enabled ? await import(`file://${PR667}/client.ts`) : null;
const pd672 = enabled ? await import(`file://${PR672}/client.ts`) : null;
const pd676 = enabled ? await import(`file://${PR676}/client.ts`) : null;
const pd681 = enabled ? await import(`file://${PR681}/client.ts`) : null;
const pd687 = enabled ? await import(`file://${PR687}/client.ts`) : null;
const clientText = enabled ? await Deno.readTextFile(`${PUSH}/client.ts`) : '';
// the client module the checks use (a mutant's while that mutant runs)
let pc = pd;
const installText = enabled ? await Deno.readTextFile(`${PUSH}/${INSTALL}`) : '';
const rollbackText = enabled ? await Deno.readTextFile(`${PUSH}/${ROLLBACK}`) : '';
// the install the checks restart with after a stop (a mutant's text while that mutant runs)
let currentInstall = installText;

// ---- psql ---------------------------------------------------------------------------------------------------------------------------------
type Result = { ok: boolean; out: string; error: string };
const psqlArgs = (user: string) => ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', DB_PORT, '-U', user, '-d', 'postgres'];
async function psql(user: string, args: string[], stdin?: string): Promise<Result> {
  const cmd = new Deno.Command('psql', {
    args: [...psqlArgs(user), ...args], env: { LC_ALL: 'C', PGOPTIONS: '-c client_min_messages=warning' },
    stdin: stdin === undefined ? 'null' : 'piped', stdout: 'piped', stderr: 'piped',
  }).spawn();
  if (stdin !== undefined) {
    const w = cmd.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const o = await cmd.output();
  return { ok: o.success, out: decoder.decode(o.stdout).trim(), error: decoder.decode(o.stderr).trim() };
}
async function sql(user: string, text: string): Promise<string> {
  const r = await psql(user, ['-c', text]);
  assert.ok(r.ok, `${text}\n${r.error}`);
  return r.out;
}
const runFile = (name: string, user = OWNER) => psql(user, ['-f', `${PUSH}/${name}`]);
const okFile = async (name: string, user = OWNER) => { const r = await runFile(name, user); assert.ok(r.ok, `${name}\n${r.error}`); };
const runText = (text: string, user = OWNER) => psql(user, ['-f', '-'], text);
const code = (r: Result) => (r.error.match(/PUSH_[A-Z_]+/u) ?? ['(none)'])[0];

// a live psql session (piped stdin, its own application_name) that holds a lock while the API calls queue behind it
class Session {
  #child: Deno.ChildProcess;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  constructor(readonly name: string, user = OWNER) {
    this.#child = new Deno.Command('psql', { args: psqlArgs(user), env: { LC_ALL: 'C', PGAPPNAME: name }, stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn();
    this.#writer = this.#child.stdin.getWriter();
  }
  async send(text: string) { await this.#writer.write(new TextEncoder().encode(`${text}\n`)); }
  async close(): Promise<Result> {
    await this.#writer.close();
    const o = await this.#child.output();
    return { ok: o.success, out: decoder.decode(o.stdout).trim(), error: decoder.decode(o.stderr).trim() };
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(50);
  }
  return pred();
}
// the newest session of that name (a check that failed under a mutant may leave an older one open; the mutant loop ends those)
const holding = (name: string) => until(async () => (await sql(SUPER, `select coalesce((select state from pg_stat_activity where application_name = '${name}' order by backend_start desc limit 1), 'gone')`)) === 'idle in transaction');
const endHolders = () => sql(SUPER, `select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name like 'g5pd-holder-%'`);
// API calls of <fn> waiting on a lock (PostgREST's backends; this polling query itself never waits on a lock)
const waitingCalls = async (fn: string) => Number(await sql(SUPER, `select count(*) from pg_stat_activity where state = 'active' and wait_event_type = 'Lock' and query like '%${fn}%'`));
const waitingStop = async () => Number(await sql(SUPER, `select count(*) from pg_stat_activity where state = 'active' and wait_event_type = 'Lock' and query like '%postona_push_control c set enabled = false%'`));

// ---- PostgREST keeps its own view of the functions: after an install, a stop or a rollback, reload it and wait ----------------------------
const newClient = () => createClient(API, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } });
async function reloadApi(want: 'present' | 'absent') {
  await sql(SUPER, `notify pgrst, 'reload schema'`);
  const probe = newClient();
  for (let i = 0; i < 150; i++) {
    const r = await probe.rpc('postona_push_device_list');
    const absent = r.error?.code === 'PGRST202' || r.error?.code === '42883';
    if ((want === 'absent') === absent) return;
    await sleep(100);
  }
  assert.fail(`PostgREST did not see the push RPCs ${want}`);
}
// functions (body / ACL / owner / config), default ACLs, role memberships, relation ACLs and row security
const catalog = () => sql(SUPER, `select md5(string_agg(x, E'\\n' order by x)) from (
  select 'p ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '-') || ' ' || p.proowner::regrole::text || coalesce(p.proconfig::text, '') || p.prosecdef x
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^(pg_|information_schema)'
  union all select 'd ' || d.defaclrole::regrole::text || ' ' || d.defaclnamespace::text || d.defaclobjtype::text || ' ' || d.defaclacl::text from pg_default_acl d
  union all select 'm ' || m.roleid::regrole::text || ' ' || m.member::regrole::text || m.admin_option || m.inherit_option || m.set_option from pg_auth_members m
  union all select 'c ' || c.oid::regclass::text || ' ' || c.relkind::text || ' ' || c.relrowsecurity || ' ' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a), '-')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^(pg_|information_schema)'
  union all select 'pol ' || polrelid::regclass::text || ' ' || polname || ' ' || polcmd::text || ' ' || array_to_string(polroles::regrole[]::text[], ',') from pg_policy) s`);

// ---- people: real GoTrue sign-ups, POSTONA started, the personal workspace made by W0 -----------------------------------------------------
type Person = { id: string; email: string; password: string; token: string; client: SupabaseClient; ws: string };
let n = 0;
async function person(label: string, workspace = true): Promise<Person> {
  const client = newClient();
  const email = `g5pd-${label.toLowerCase()}-${++n}-${crypto.randomUUID().slice(0, 6)}@example.test`;
  const password = crypto.randomUUID();
  const r = await client.auth.signUp({ email, password });
  assert.ok(r.data.session && r.data.user, r.error?.message);
  assert.equal(((await client.rpc('start_x_autopost_service')).data as { status: string }).status, 'active');
  if (workspace) assert.equal(((await client.rpc('postona_ensure_my_personal_workspace')).data as { status: string }).status, 'ready');
  const id = r.data.user.id;
  return { id, email, password, token: r.data.session.access_token, client, ws: await sql(SUPER, `select 'u_' || substr(md5('${id}'), 1, 24)`) };
}
// another session of the same person (another phone, or the same phone after signing in again)
async function second(p: Person): Promise<SupabaseClient> {
  const c = newClient();
  const r = await c.auth.signInWithPassword({ email: p.email, password: p.password });
  assert.ok(r.data.session, r.error?.message);
  return c;
}
const lifecycle = async (p: Person) => Number(await sql(SUPER, `select lifecycle_version from public.common_accounts where user_id = '${p.id}'`));
const endService = (p: Person) => sql(SUPER, `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${p.id}' and service_key = 'x_autopost'`);
async function restart(p: Person) {
  const re = await p.client.rpc('reactivate_x_autopost_service', { p_expected_lifecycle_version: await lifecycle(p) });
  assert.equal((re.data as { status: string } | null)?.status, 'active', JSON.stringify(re.error));
}

// ---- fake tokens (never printed: tests compare SHA-256 hashes) --------------------------------------------------------------------------
function fakeToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return `ExponentPushToken[g5ptok${btoa(String.fromCharCode(...b)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}]`;
}
const hex = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map((x) => x.toString(16).padStart(2, '0')).join('');
const uuid = () => crypto.randomUUID();
// (G5-02 #10) a phone's device secret: one per installation id, as the app keeps it in secure storage
function newSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `g5psec${btoa(String.fromCharCode(...b)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}`;   // marker: the runner scans the logs for it
}
const secrets = new Map<string, string>();
const secretOf = (inst: string) => { if (!secrets.has(inst)) secrets.set(inst, newSecret()); return secrets.get(inst) as string; };
// every answer the app gets: never a token (the marker), never a hash
function clean<T>(x: T): T {
  const s = JSON.stringify(x);
  assert.ok(!s.includes('g5ptok') && !s.includes('PushToken'), 'an answer carried a token');
  assert.ok(!s.includes('g5psec'), 'an answer carried a device secret');
  return x;
}
type Answer = { ok: boolean; status: string; device?: { registration_version: number; status: string; deliverable: boolean; this_session: boolean }; registration_version?: number | null };
// (G5-02 #12) the push worker's proof challenge for one installation: its nonce (the test is the provider; the nonce never leaves the test)
const issueNonce = (inst: string) => sql(OWNER, `select coalesce((select x->>'nonce' from jsonb_array_elements(private.postona_push_proof_issue(5, '${inst}')) x limit 1), '')`);
const randomNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(32))).map((x) => x.toString(16).padStart(2, '0')).join('');
const claimOf = async (token: string) => sql(SUPER, `select coalesce((select user_id || ':' || installation_id from private.postona_push_token_claims where token_sha256 = decode('${await hex(token)}', 'hex')), 'none')`);
// (G5-02 #14) the person's explicit "notifications on" for an installation: its one-time ON grant (undefined when refused)
const grantOf = async (c: SupabaseClient, inst: string, secret = secretOf(inst)): Promise<string | undefined> => {
  const g = clean(await pd.enablePushDevice(c, inst, secret)) as { ok: boolean; onGrant?: string };
  return g.ok ? g.onGrant : undefined;
};
// a registration from the phone that holds the token: when it is pending, the phone answers the provider's nonce. (G5-02 #14) Turning the
// installation on (from none, or from an "off" row) is the person's explicit "on": the helper asks the grant first, unless one is given
// (a string) or none is wanted (null)
const reg = async (c: SupabaseClient, inst: string, token: string, expected: number | null, platform = 'ios', secret = secretOf(inst), prove = true,
                   grant: string | null | undefined = undefined): Promise<Answer> => {
  if (grant === undefined && (expected === null || /^revoked:unregistered:/u.test(await row(inst)))) grant = await grantOf(c, inst, secret);
  const a = clean(await pd.registerPushDevice(c, { installationId: inst, deviceSecret: secret, platform, pushToken: token, expectedVersion: expected, ...(grant ? { onGrant: grant } : {}) })) as Answer;
  if (!prove || a.status !== 'pending_proof' || !a.device) return a;
  const nonce = await issueNonce(inst);
  if (nonce === '') return a;
  return clean(await pd.registerPushDevice(c, { installationId: inst, deviceSecret: secret, platform, pushToken: token, expectedVersion: a.device.registration_version, proofNonce: nonce })) as Answer;
};
// one registration call, never proven (a third party, or the answer before any proof)
const reg1 = (c: SupabaseClient, inst: string, token: string, expected: number | null, platform = 'ios', secret = secretOf(inst), grant: string | null | undefined = undefined) =>
  reg(c, inst, token, expected, platform, secret, false, grant);
// revoked rows of a person, as history (no token), straight in as the owner
const seedRevoked = (p: Person, k: number) => sql(OWNER, `insert into private.postona_push_devices (installation_id, device_secret_sha256, user_id, workspace_id, session_id, lifecycle_version,
    platform, registration_version, status, revoked_reason, revoked_at)
  select gen_random_uuid(), sha256(convert_to(gen_random_uuid()::text, 'UTF8')), '${p.id}', '${p.ws}', gen_random_uuid(), 1, null, 1, 'revoked', 'unregistered', now()
    from generate_series(1, ${k})`);
// PR #667's register (no device secret) through PR #667's client
const reg667 = async (c: SupabaseClient, inst: string, token: string, expected: number | null) =>
  clean(await pd667.registerPushDevice(c, { installationId: inst, platform: 'ios', pushToken: token, expectedVersion: expected })) as Answer;
async function restartPush() {
  const r = await runText(currentInstall);
  assert.ok(r.ok, r.error);
  await reloadApi('present');
}
const unreg = async (c: SupabaseClient, inst: string, secret?: string) => clean(await pd.unregisterPushDevice(c, inst, secret)) as Answer;
const list = async (c: SupabaseClient) => clean(await pd.listPushDevices(c)) as { ok: boolean; status?: string; delivery: string; devices: Array<{ installation_id: string; status: string; deliverable: boolean; this_session: boolean; registration_version: number; revoked_reason: string | null }> };
const rawRpc = async (c: SupabaseClient, fn: string, args: Record<string, unknown>) => {
  const r = await c.rpc(fn, args);
  clean(r.data);
  return r.error ? `HTTP:${r.error.code}` : String((r.data as { status: string }).status);
};
// the worker side, as the lifecycle owner: the verdict and the targets' token HASHES (sorted)
async function targets(p: Person, ws = p.ws): Promise<{ verdict: string; hashes: string[] }> {
  const out = await sql(OWNER, `select (x->>'verdict') || '|' || coalesce((select string_agg(encode(sha256(convert_to(t->>'push_token', 'UTF8')), 'hex'), ',') from jsonb_array_elements(x->'targets') t), '')
    from (select private.postona_push_delivery_targets('${p.id}', '${ws}') x) s`);
  const [verdict, hashes] = out.split('|');
  return { verdict, hashes: hashes ? hashes.split(',').sort() : [] };
}
const row = (inst: string) => sql(SUPER, `select coalesce((select status || ':' || coalesce(revoked_reason, '-') || ':' || registration_version || ':' || (push_token is null) || ':' || (token_sha256 is null)
  from private.postona_push_devices where installation_id = '${inst}'), 'none')`);
const owner = (inst: string) => sql(SUPER, `select coalesce((select user_id::text from private.postona_push_devices where installation_id = '${inst}'), 'none')`);
const activeFor = async (token: string) => sql(SUPER, `select count(*) from private.postona_push_devices where status = 'active' and token_sha256 = decode('${await hex(token)}', 'hex')`);
const invalidate = (inst: string, v: number) => sql(OWNER, `select private.postona_push_device_invalidate('${inst}', ${v})`);
// (G5-02 #13 P2-3) a registration exactly as PostgREST runs it -- the authenticator, `set local role authenticated`, the claims of the
// person's REAL GoTrue access token -- with only 'iat' changed: a request made at that time and delivered now (a delayed one). GoTrue signs
// ES256 with a key this test does not hold, so a really old JWT cannot be made; the claim source and the function are the ones HTTP uses.
async function claimsOf(c: SupabaseClient): Promise<Record<string, unknown>> {
  const t = (await c.auth.getSession()).data.session?.access_token ?? '';
  const b = (t.split('.')[1] ?? '').replace(/-/gu, '+').replace(/_/gu, '/');
  return JSON.parse(atob(b + '='.repeat((4 - (b.length % 4)) % 4))) as Record<string, unknown>;
}
const nowSec = async () => Number(await sql(SUPER, `select floor(extract(epoch from clock_timestamp()))::bigint`));
async function registerAt(c: SupabaseClient, iat: number | 'absent', inst: string, token: string, expected: number | null): Promise<string> {
  const claims = await claimsOf(c);
  if (iat === 'absent') delete claims.iat;
  else claims.iat = iat;
  const r = await psql('authenticator', ['-f', '-'], `begin;
set local role authenticated;
select set_config('request.jwt.claims', '${JSON.stringify(claims).replaceAll("'", "''")}', true) is null;
select public.postona_push_device_register('${inst}', '${secretOf(inst)}', 'ios', '${token}', ${expected ?? 'null'}) ->> 'status';
commit;
`);
  assert.ok(r.ok, r.error.replace(/g5p(tok|sec)[A-Za-z0-9_-]*/gu, '<marker>'));
  return r.out.split('\n').pop() ?? '';
}
const countOf = async (p: Person) => Number(await sql(SUPER, `select count(*) from private.postona_push_devices where user_id = '${p.id}'`));
const ageRows = (p: Person, k: number, keep: string[] = []) => sql(SUPER, `update private.postona_push_devices set revoked_at = now() - interval '2 days'
  where installation_id in (select installation_id from private.postona_push_devices where user_id = '${p.id}' and status = 'revoked'
    and revoked_at > now() - interval '1 day' ${keep.length ? `and installation_id not in (${keep.map((x) => `'${x}'`).join(',')})` : ''} order by installation_id limit ${k})`);

// ---- the profile this builds on (MVP_INSTALL + W0, as the workspace suite releases it) ---------------------------------------------------
async function ensureProfile() {
  if (await sql(SUPER, `select to_regprocedure('private.postona_personal_session()') is null`) === 't') {
    const a = await psql(OWNER, ['-f', `${MVP}/MVP_INSTALL.sql`]); assert.ok(a.ok, a.error);
    const b = await psql(OWNER, ['-f', `${MVP}/MVP_R1_EXECUTE_GRANT.sql`]); assert.ok(b.ok, b.error);
  }
  if (await sql(SUPER, `select to_regprocedure('public.postona_ensure_my_personal_workspace()') is null`) === 't') {
    const w = await psql(OWNER, ['-f', `${MVP}/MVP_W0_INSTALL.sql`]); assert.ok(w.ok, w.error);
  }
  const g = await psql(OWNER, ['-f', `${MVP}/MVP_W0_EXECUTE_GRANT.sql`]); assert.ok(g.ok, g.error);
}
async function installed() {
  if (await sql(SUPER, `select to_regclass('private.postona_push_devices') is null`) === 't') await okFile(INSTALL);
  await okFile(INSTALL);   // again: re-grants after a stop
  await reloadApi('present');
}

// ---- the contract, as checks: each runs on the real candidate (must pass) and is the target of a mutant (must fail there) ---------------
let currentRollback = rollbackText;
const checks: Record<string, () => Promise<void>> = {
  // sign-out (the session row deleted) stops delivery even when the app never unregistered
  async signOutStopsDelivery() {
    const A = await person('so');
    const phone = await second(A);
    const inst = uuid(), t = fakeToken();
    assert.equal((await reg(phone, inst, t, null)).status, 'registered');
    assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
    await phone.auth.signOut({ scope: 'local' });
    const after = await targets(A);
    assert.equal(after.verdict, 'active');
    assert.deepEqual(after.hashes, [], 'a signed-out phone is still a target');
  },
  // a service end + restart makes every earlier registration stale until the app registers again
  async restartMakesOldStale() {
    const A = await person('rs');
    const inst = uuid(), t = fakeToken();
    assert.equal((await reg(A.client, inst, t, null)).status, 'registered');
    await endService(A);
    assert.deepEqual(await targets(A), { verdict: 'SERVICE_NOT_ACTIVE', hashes: [] });
    await restart(A);
    assert.deepEqual(await targets(A), { verdict: 'active', hashes: [] }, 'a registration of the old generation is still a target');
    assert.equal((await reg(A.client, inst, t, 1)).status, 'registered');
    assert.deepEqual(await targets(A), { verdict: 'active', hashes: [await hex(t)] });
  },
  // owner loss stops delivery (MV's S2-3), and it comes back with the ownership
  async ownerLossStopsDelivery() {
    const A = await person('ol');
    const t = fakeToken();
    assert.equal((await reg(A.client, uuid(), t, null)).status, 'registered');
    await sql(SUPER, `delete from public.brand_memberships where user_id = '${A.id}'`);
    const lost = await targets(A);
    assert.notEqual(lost.verdict, 'active');
    assert.deepEqual(lost.hashes, [], 'a workspace the person no longer owns still delivers');
    await sql(SUPER, `insert into public.brand_memberships (brand_id, user_id, role) values ('${A.ws}', '${A.id}', 'owner')`);
    assert.deepEqual(await targets(A), { verdict: 'active', hashes: [await hex(t)] });
  },
  // a replayed (older) registration never overwrites a newer one
  async staleReplayRefused() {
    const A = await person('rp');
    const inst = uuid(), t1 = fakeToken(), t2 = fakeToken();
    assert.equal((await reg(A.client, inst, t1, null)).status, 'registered');
    assert.equal((await reg(A.client, inst, t2, 1)).status, 'registered');
    assert.equal((await reg(A.client, inst, t1, 1)).status, 'STALE_REGISTRATION', 'an old update replayed');
    assert.equal((await reg(A.client, inst, t1, null)).status, 'STALE_REGISTRATION', 'the first registration replayed');
    assert.deepEqual((await targets(A)).hashes, [await hex(t2)]);
  },
  // the service end is checked under T13's lock: no registration while the service is not active
  async serviceEndRefusesRegister() {
    const A = await person('se');
    await endService(A);
    assert.equal((await reg(A.client, uuid(), fakeToken(), null)).status, 'SERVICE_NOT_ACTIVE');
    assert.equal(await sql(SUPER, `select count(*) from private.postona_push_devices where user_id = '${A.id}'`), '0');
  },
  // (H4 #24 P2-3) a leaked token moves nothing: another person's registration of it, while the holder's registration is live, is refused
  async leakedTokenRefused() {
    const A = await person('lt-a'), B = await person('lt-b');
    const iA = uuid(), iB = uuid(), t = fakeToken();
    assert.equal((await reg(A.client, iA, t, null)).status, 'registered');
    assert.equal((await reg1(B.client, iB, t, null)).status, 'pending_proof', 'a leaked token must stay unproven');
    assert.match(await row(iA), /^active:-:1:false:false$/u);
    assert.match(await row(iB), /^pending:/u);
    assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
    assert.deepEqual((await targets(B)).hashes, [], 'a pending (unproven) token is a delivery target');
    // the nonce goes to the token = A's phone; B can only guess
    await issueNonce(iB);
    assert.equal((clean(await pd.registerPushDevice(B.client, { installationId: iB, deviceSecret: secretOf(iB), platform: 'ios', pushToken: t, expectedVersion: 1, proofNonce: randomNonce() })) as Answer).status, 'PROOF_INVALID');
    // after a restart (the generation stale, A's session live) still nothing for B
    await endService(A);
    await restart(A);
    assert.notEqual((await reg1(B.client, uuid(), t, null)).status, 'registered');
    assert.equal(await activeFor(t), '1');
    assert.equal(await claimOf(t), `${A.id}:${iA}`);
  },
  // (H4 #24 P2-3) a leaked installation id moves nothing: without that phone's device secret, the row answers DEVICE_IN_USE, whatever version
  async leakedInstallationRefused() {
    const A = await person('li-a'), B = await person('li-b');
    const inst = uuid(), ta = fakeToken();
    assert.equal((await reg(A.client, inst, ta, null)).status, 'registered');
    for (const v of [null, 1, 2]) {
      const r = await reg(B.client, inst, fakeToken(), v, 'ios', newSecret());
      assert.equal(r.status, 'DEVICE_IN_USE');
      assert.equal(r.registration_version, undefined, 'a version leaked');
    }
    assert.equal((await reg(A.client, inst, fakeToken(), 1, 'ios', newSecret())).status, 'DEVICE_IN_USE', 'the person too needs the phone\'s secret');
    assert.equal(await owner(inst), A.id);
    assert.match(await row(inst), /^active:-:1:false:false$/u);
    assert.deepEqual((await targets(A)).hashes, [await hex(ta)]);
    // a signed-out (dead) row is still the phone's: no secret, no takeover
    await A.client.auth.signOut({ scope: 'local' });
    assert.equal((await reg(B.client, inst, fakeToken(), null, 'ios', newSecret())).status, 'DEVICE_IN_USE');
    assert.equal(await owner(inst), A.id);
  },
  // the same phone signed in to another account (A never signed out there): the device secret proves the phone, so B takes it over at
  // once. (G5-02 #12) A first proved the token on an older installation, then reinstalled (active at once: its own token); the handover
  // follows the token's claim to the installation that holds it now.
  async handoverWithDeviceSecret() {
    const A = await person('ho-a'), B = await person('ho-b');
    const inst = uuid(), t = fakeToken();
    assert.equal((await reg(A.client, uuid(), t, null)).status, 'registered');
    assert.equal((await reg1(A.client, inst, t, null)).status, 'registered', 'the person\'s own proven token on a new installation');
    assert.equal((await reg1(B.client, inst, t, null)).status, 'registered', 'the same phone handed over with its device secret');
    assert.equal(await owner(inst), B.id);
    assert.deepEqual((await targets(A)).hashes, []);
    assert.deepEqual((await targets(B)).hashes, [await hex(t)]);
    assert.equal(await activeFor(t), '1');
  },
  // (H4 #25 P2-1) an ended session does not free a token: another person on another installation stays DEVICE_IN_USE (signed out,
  // unregistered, alike); the owner signs in again on the same phone and recovers; the owner's own reinstall moves it
  async signedOutTokenStaysWithOwner() {
    const A = await person('st-a'), B = await person('st-b');
    const phone = await second(A);
    const iA = uuid(), iB = uuid(), t = fakeToken();
    assert.equal((await reg(phone, iA, t, null)).status, 'registered');
    await phone.auth.signOut({ scope: 'local' });
    assert.equal((await reg1(B.client, iB, t, null)).status, 'pending_proof', 'a token moved to another account after the owner signed out');
    assert.match(await row(iA), /^active:-:1:false:false$/u);
    assert.deepEqual((await targets(B)).hashes, []);
    // the owner signs in again on that phone: the same installation and secret, its own proven token -- active at once
    const again = await second(A);
    assert.equal((await reg1(again, iA, t, 1)).status, 'registered');
    assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
    // the owner's own reinstall (a new installation id + secret, the same OS token) moves it at once
    const iA2 = uuid();
    assert.equal((await reg1(again, iA2, t, null)).status, 'registered');
    assert.match(await row(iA), /^revoked:taken_over:/u);
    // the owner turns it off: no row holds the token any more, the claim still does
    assert.equal((await unreg(again, iA2)).status, 'unregistered');
    assert.equal(await activeFor(t), '0');
    assert.equal((await reg1(B.client, uuid(), t, null)).status, 'pending_proof', 'an unregistered token became active for another account');
    assert.deepEqual((await targets(B)).hashes, []);
  },
  // (H4 #25 P2-1 / #26 P2-1) lost secure storage: the same person registers again at once; another person (the phone given away) is
  // pending and gets it by answering the proof on that phone -- the earlier owner's registration then stops (no permanent lock-out)
  async secretLossRecovery() {
    const A = await person('sl-a'), B = await person('sl-b');
    const i1 = uuid(), t = fakeToken();
    assert.equal((await reg(A.client, i1, t, null)).status, 'registered');
    const i2 = uuid();   // storage wiped: a new installation id and a new secret
    assert.equal((await reg1(A.client, i2, t, null)).status, 'registered');
    assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
    const i3 = uuid();   // the phone wiped again and given to B
    assert.equal((await reg1(B.client, i3, t, null)).status, 'pending_proof');
    assert.deepEqual((await targets(A)).hashes, [await hex(t)], 'a pending registration stopped the owner');
    const bState = () => Promise.resolve({ installationId: i3, deviceSecret: secretOf(i3), platform: 'ios', pushToken: t, expectedVersion: 1, notificationsEnabled: true });
    assert.equal((clean(await pc.confirmPushDevice(B.client, bState, { kind: 'postona_push_proof', installation_id: i3, nonce: await issueNonce(i3) })) as Answer).status, 'registered');
    assert.match(await row(i2), /^revoked:taken_over:/u);
    assert.deepEqual((await targets(A)).hashes, []);
    assert.deepEqual((await targets(B)).hashes, [await hex(t)]);
    assert.equal(await claimOf(t), `${B.id}:${i3}`);
  },
  // (H4 #25 P2-2) "off" before the first registration landed is kept: the delayed first registration is STALE, "on" again works
  async offBeforeFirstRegistration() {
    const A = await person('of');
    const inst = uuid(), t = fakeToken();
    const delayed = { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t, expectedVersion: null };
    const off = clean(await pc.unregisterPushDevice(A.client, inst, secretOf(inst))) as { status: string; device?: { registration_version: number } };
    assert.equal(off.status, 'unregistered', 'the off left nothing on the server');
    assert.equal(off.device?.registration_version, 1);
    assert.match(await row(inst), /^revoked:unregistered:1:true:true$/u);
    const late = clean(await pc.registerPushDevice(A.client, delayed)) as Answer;
    assert.equal(late.status, 'STALE_REGISTRATION', `the delayed first registration after "off": ${late.status}`);
    assert.match(await row(inst), /^revoked:unregistered:1:/u);
    assert.deepEqual((await targets(A)).hashes, []);
    // "on" again, from the version the off answered
    const onGrant = await grantOf(A.client, inst);   // (G5-02 #14) the person's explicit "on"
    const on = () => Promise.resolve({ ...delayed, expectedVersion: 1, onGrant, notificationsEnabled: true });
    assert.equal((clean(await pc.syncPushDevice(A.client, on)) as Answer).status, 'pending_proof');
    assert.equal((clean(await pc.confirmPushDevice(A.client, () => Promise.resolve({ ...delayed, expectedVersion: 2, notificationsEnabled: true }),
      { kind: 'postona_push_proof', installation_id: inst, nonce: await issueNonce(inst) })) as Answer).status, 'registered');
    assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
  },
  // (H4 #25 P2-2) the first registration and "off" at once (both queued on the installation's lock, either order): the phone ends off
  async firstRegistrationVsOff() {
    const A = await person('fo');
    for (let k = 0; k < 2; k++) {
      const inst = uuid(), t = fakeToken();
      const onGrant = await grantOf(A.client, inst);
      const holder = new Session(`g5pd-holder-fo${k}`);
      await holder.send(`begin; select pg_advisory_xact_lock(private.postona_push_lock_key('installation', '${inst}'));`);
      assert.ok(await holding(`g5pd-holder-fo${k}`));
      const pR = (async () => clean(await pc.registerPushDevice(A.client, { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t, expectedVersion: null, onGrant })) as Answer)();
      const pU = (async () => clean(await pc.unregisterPushDevice(A.client, inst, secretOf(inst))) as Answer)();
      assert.ok(await until(async () => (await waitingCalls('postona_push_device_register')) + (await waitingCalls('postona_push_device_unregister')) === 2));
      await holder.send('commit;');
      assert.ok((await holder.close()).ok);
      const [r, u] = await Promise.all([pR, pU]);
      assert.equal(u.status, 'unregistered');
      assert.ok(r.status === 'pending_proof' || r.status === 'STALE_REGISTRATION', r.status);
      assert.match(await row(inst), /^revoked:unregistered:/u, `round ${k}: the phone is not off (register ${r.status})`);
      assert.equal(await activeFor(t), '0');
    }
  },
  // (H4 #25 P2-2) an old success: the registration lands, but the person turned notifications off meanwhile (the off never reached the
  // server): the client completes the off in this session instead of reporting success
  async oldSuccessKeepsOff() {
    const A = await person('os');
    const inst = uuid(), t = fakeToken();
    let enabled = true;
    let reads = 0;
    const onGrant = await grantOf(A.client, inst);
    const readCurrent = () => {
      const s = { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t, expectedVersion: null, onGrant, notificationsEnabled: enabled };
      if (++reads === 1) enabled = false;   // the person taps "off" right after the sync read the state
      return Promise.resolve(s);
    };
    const r = clean(await pc.syncPushDevice(A.client, readCurrent)) as Answer;
    assert.equal(r.status, 'disabled', `an old success re-enabled the phone: ${r.status}`);
    assert.match(await row(inst), /^revoked:unregistered:2:/u);
    assert.deepEqual((await targets(A)).hashes, []);
  },
  // (H4 #25 P2-2) rapid toggles from two sessions, nothing awaited in between, ending "off": the phone ends off
  async rapidTogglesEndOff() {
    const A = await person('rt');
    const s2 = await second(A);
    const inst = uuid(), t = fakeToken();
    let enabled = false;
    let version: number | null = null;
    const readCurrent = () => Promise.resolve({ installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t, expectedVersion: version, notificationsEnabled: enabled });
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 6; i++) {
      enabled = i % 2 === 0;
      const c = i % 3 === 0 ? s2 : A.client;
      ops.push(enabled ? grantOf(c, inst).then((g) => pc.syncPushDevice(c, () => readCurrent().then((x) => ({ ...x, onGrant: g })))).then((x: Answer) => { if (x.ok && x.device) version = x.device.registration_version; return x; })
                       : pc.unregisterPushDevice(c, inst, secretOf(inst)).then((x: Answer) => { if (x.ok && x.device) version = x.device.registration_version; return x; }));
    }
    enabled = false;
    ops.push(pc.unregisterPushDevice(A.client, inst, secretOf(inst)));
    for (const x of await Promise.all(ops)) clean(x);
    assert.doesNotMatch(await row(inst), /^active:/u, 'rapid toggles ending "off" left the phone on');
    assert.deepEqual((await targets(A)).hashes, []);
  },
  // two proofs of one token at once (two people's pending registrations, another person's proven one active): serialized on the token lock,
  // the later proof wins, exactly one active, no error
  async sameTokenRace() {
    const C = await person('rc-c'), A = await person('rc-a'), B = await person('rc-b');
    const i0 = uuid(), iA = uuid(), iB = uuid(), t = fakeToken();
    assert.equal((await reg(C.client, i0, t, null)).status, 'registered');
    assert.equal((await reg1(A.client, iA, t, null)).status, 'pending_proof');
    assert.equal((await reg1(B.client, iB, t, null)).status, 'pending_proof');
    const nA = await issueNonce(iA), nB = await issueNonce(iB);
    const proof = (c: SupabaseClient, inst: string, nonce: string) =>
      (async () => clean(await pd.registerPushDevice(c, { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t, expectedVersion: 1, proofNonce: nonce })) as Answer)();
    const holder = new Session('g5pd-holder-token');
    await holder.send(`begin; select 1 from private.postona_push_devices where installation_id = '${i0}' for update;`);
    assert.ok(await holding('g5pd-holder-token'));
    const pA = proof(A.client, iA, nA);
    assert.ok(await until(async () => await waitingCalls('postona_push_device_register') === 1), 'A did not queue behind the row lock');
    let bDone = false;
    const pB = proof(B.client, iB, nB).finally(() => { bDone = true; });
    await until(async () => bDone || await waitingCalls('postona_push_device_register') === 2, 5_000);
    await holder.send('commit;');
    assert.ok((await holder.close()).ok);
    const [rA, rB] = await Promise.all([pA, pB]);
    assert.equal(rA.status, 'registered', `A: ${rA.status}`);
    assert.equal(rB.status, 'registered', `B: ${rB.status}`);
    assert.equal(await activeFor(t), '1');
    assert.match(await row(i0), /^revoked:taken_over:/u);
    assert.match(await row(iA), /^revoked:taken_over:/u, 'A proved first, then B');
    assert.deepEqual((await targets(B)).hashes, [await hex(t)]);
    assert.deepEqual((await targets(A)).hashes, []);
    assert.deepEqual((await targets(C)).hashes, []);
  },
  // another person cannot unregister, see or change an installation that is not theirs (and learns nothing about it)
  async othersCannotUnregister() {
    const A = await person('ou-a'), B = await person('ou-b');
    const inst = uuid(), t = fakeToken();
    assert.equal((await reg(A.client, inst, t, null)).status, 'registered');
    assert.equal((await unreg(B.client, inst)).status, 'not_registered');
    assert.equal((await unreg(B.client, uuid())).status, 'not_registered', 'the same answer as for an installation nobody has');
    assert.match(await row(inst), /^active:-:1:false:false$/u);
    assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
  },
  async othersCannotList() {
    const A = await person('ol-a'), B = await person('ol-b');
    assert.equal((await reg(A.client, uuid(), fakeToken(), null)).status, 'registered');
    const l = await list(B.client);
    assert.equal(l.ok, true);
    assert.deepEqual(l.devices, [], 'B sees A\'s devices');
  },
  // the provider's "dead token" for an OLD registration does not revoke a newer one
  async staleReceiptKeepsNewer() {
    const A = await person('sr');
    const inst = uuid(), t1 = fakeToken(), t2 = fakeToken();
    assert.equal((await reg(A.client, inst, t1, null)).status, 'registered');
    assert.equal((await reg(A.client, inst, t2, 1)).status, 'registered');
    assert.equal(await invalidate(inst, 1), 'unchanged');
    assert.deepEqual((await targets(A)).hashes, [await hex(t2)]);
    assert.equal(await invalidate(inst, 2), 'revoked');
    assert.deepEqual((await targets(A)).hashes, []);
  },
  // no workspace, or a workspace that is not the person's own: no registration
  async workspaceGateOnRegister() {
    const N = await person('wg-n', false);
    assert.equal((await reg(N.client, uuid(), fakeToken(), null)).status, 'WORKSPACE_REQUIRED');
    const A = await person('wg-a');
    await sql(SUPER, `delete from public.brand_memberships where user_id = '${A.id}'`);
    assert.notEqual((await reg(A.client, uuid(), fakeToken(), null)).status, 'registered');
    await sql(SUPER, `insert into public.brand_memberships (brand_id, user_id, role) values ('${A.ws}', '${A.id}', 'owner')`);
    assert.equal(await sql(SUPER, `select count(*) from private.postona_push_devices where user_id in ('${N.id}', '${A.id}')`), '0');
  },
  // signing in again on the same phone re-binds the row to the new session (the old session's sign-out then stops nothing)
  async newSessionRebinds() {
    const A = await person('nb');
    const s1 = await second(A);
    const inst = uuid(), t = fakeToken();
    assert.equal((await reg(s1, inst, t, null)).status, 'registered');
    const s2 = await second(A);
    assert.equal((await reg(s2, inst, t, 1)).status, 'registered', 'a new session must re-bind, not answer unchanged');
    await s1.auth.signOut({ scope: 'local' });
    assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
  },
  // (H4 #24 P2-1) a registration in flight (past EXECUTE, waiting in T13) when the stop commits: it reaches the fence after the stop and
  // refuses; nothing active, nothing deliverable after the stop
  async stopFencesInFlightRegistration() {
    const A = await person('sf');
    const inst = uuid(), t = fakeToken();
    const g = await grantOf(A.client, inst);
    const holder = new Session('g5pd-holder-sf');
    await holder.send(`begin; select 1 from public.common_accounts where user_id = '${A.id}' for update;`);
    assert.ok(await holding('g5pd-holder-sf'));
    const pR = reg(A.client, inst, t, null, 'ios', secretOf(inst), true, g);
    assert.ok(await until(async () => await waitingCalls('postona_push_device_register') === 1), 'the registration did not queue');
    const stop = await runFile(STOP);
    assert.ok(stop.ok, stop.error);
    await holder.send('commit;');
    assert.ok((await holder.close()).ok);
    const r = await pR;
    try {
      assert.equal(r.status, 'PUSH_DEVICES_STOPPED', `the in-flight registration after the stop: ${r.status}`);
      assert.equal(await sql(SUPER, `select count(*) from private.postona_push_devices where status = 'active' or push_token is not null`), '0', 'a token is active after the stop');
      assert.deepEqual(await targets(A), { verdict: 'PUSH_DEVICES_STOPPED', hashes: [] });
    } finally {
      await restartPush();
    }
  },
  // (H4 #24 P2-1) a registration that already holds the fence when the stop starts: the stop waits for it, then erases what it committed
  async stopWaitsForFenceHolder() {
    const A = await person('sw');
    const inst = uuid(), t = fakeToken();
    const holder = new Session('g5pd-holder-sw');
    await holder.send(`begin; select pg_advisory_xact_lock(private.postona_push_lock_key('token', '${await hex(t)}'));`);
    assert.ok(await holding('g5pd-holder-sw'));
    const pR = reg1(A.client, inst, t, null);
    assert.ok(await until(async () => await waitingCalls('postona_push_device_register') === 1));
    const pS = runFile(STOP);
    assert.ok(await until(async () => await waitingStop() === 1), 'the stop did not wait for the registration holding the fence');
    await holder.send('commit;');
    assert.ok((await holder.close()).ok);
    const [r, stop] = await Promise.all([pR, pS]);
    try {
      assert.ok(stop.ok, stop.error);
      assert.equal(r.status, 'pending_proof');
      assert.match(await row(inst), /^revoked:stopped:2:true:true$/u);
      assert.equal(await sql(SUPER, `select count(*) from private.postona_push_devices where status = 'active' or push_token is not null`), '0');
      assert.deepEqual(await targets(A), { verdict: 'PUSH_DEVICES_STOPPED', hashes: [] });
    } finally {
      await restartPush();
    }
  },
  // account deletion's fence is T13's account lock: a registration in flight when the account turns 'deleting' refuses
  async deletionFencesInFlight() {
    const A = await person('df');
    const iD = uuid();
    const g = await grantOf(A.client, iD);
    const holder = new Session('g5pd-holder-df');
    await holder.send(`begin; select 1 from public.common_accounts where user_id = '${A.id}' for update;`);
    assert.ok(await holding('g5pd-holder-df'));
    const pR = reg(A.client, iD, fakeToken(), null, 'ios', secretOf(iD), true, g);
    assert.ok(await until(async () => await waitingCalls('postona_push_device_register') === 1));
    await holder.send(`update public.common_accounts set status = 'deleting' where user_id = '${A.id}'; commit;`);
    assert.ok((await holder.close()).ok);
    assert.equal((await pR).status, 'ACCOUNT_DELETION_IN_PROGRESS');
    assert.equal(await sql(SUPER, `select count(*) from private.postona_push_devices where user_id = '${A.id}'`), '0');
  },
  // the fence off (whatever else is left): the delivery side answers nothing, the list says so, register refuses
  async disabledFlagStopsDelivery() {
    const A = await person('fl');
    const t = fakeToken();
    assert.equal((await reg(A.client, uuid(), t, null)).status, 'registered');
    await sql(OWNER, `update private.postona_push_control set enabled = false where id`);
    try {
      assert.deepEqual(await targets(A), { verdict: 'PUSH_DEVICES_STOPPED', hashes: [] }, 'a stopped system still answers targets');
      assert.equal((await list(A.client)).delivery, 'PUSH_DEVICES_STOPPED');
      assert.equal((await reg(A.client, uuid(), fakeToken(), null)).status, 'PUSH_DEVICES_STOPPED');
    } finally {
      await sql(OWNER, `update private.postona_push_control set enabled = true where id`);
    }
    assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
  },
  // a lock held for long (here the fence, 7 s): register gives up after 5 s with PUSH_BUSY and keeps nothing
  async lockTimeoutBusy() {
    const A = await person('lk');
    const inst = uuid();
    const g = await grantOf(A.client, inst);
    const holder = new Session('g5pd-holder-lk');
    await holder.send(`begin; select 1 from private.postona_push_control c where c.id for update;`);
    assert.ok(await holding('g5pd-holder-lk'));
    const release = sleep(7_000).then(async () => { await holder.send('commit;'); return holder.close(); });
    const t0 = Date.now();
    const r = await reg(A.client, inst, fakeToken(), null, 'ios', secretOf(inst), true, g);
    const waited = Date.now() - t0;
    assert.ok((await release).ok);
    assert.equal(r.status, 'PUSH_BUSY', `after ${waited} ms: ${r.status}`);
    assert.ok(waited >= 4_500 && waited < 6_900, `waited ${waited} ms`);
    assert.equal(await row(inst), 'none');
  },
  // (H4 #24 P2-2) the client never re-sends: an older sync after "notifications off" or after a newer token is refused and stays refused;
  // recovery reads the state again and does nothing when off, nothing when the person removed the phone, and otherwise only the current token
  async clientNeverResendsStale() {
    const A = await person('cl');
    const s2 = await second(A);
    const inst = uuid(), t1 = fakeToken(), t2 = fakeToken();
    const state = { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t1, expectedVersion: null as number | null, notificationsEnabled: true,
                    onGrant: await grantOf(A.client, inst) };
    const now = () => Promise.resolve({ ...state });
    const first = clean(await pd.syncPushDevice(A.client, now)) as Answer;
    assert.equal(first.status, 'pending_proof');
    assert.equal((clean(await pd.confirmPushDevice(A.client, () => Promise.resolve({ ...state, expectedVersion: 1 }),
      { kind: 'postona_push_proof', installation_id: inst, nonce: await issueNonce(inst) })) as Answer).status, 'registered');
    state.expectedVersion = 1;
    const captured = { ...state };   // an operation built now, run later
    // "off": the flag first, then unregister
    state.notificationsEnabled = false;
    assert.equal((await unreg(A.client, inst)).status, 'unregistered');
    const late = clean(await pd.syncPushDevice(A.client, () => Promise.resolve(captured))) as Answer;
    assert.equal(late.status, 'STALE_REGISTRATION');
    assert.match(await row(inst), /^revoked:unregistered:2:/u, 'an older sync revived the phone after "off"');
    assert.equal((clean(await pd.recoverStaleRegistration(A.client, now)) as Answer).status, 'disabled');
    assert.match(await row(inst), /^revoked:unregistered:2:/u);
    // "on" again by the person, then "removed" from another session: recovery leaves it removed
    state.notificationsEnabled = true;
    state.expectedVersion = 2;
    state.onGrant = await grantOf(A.client, inst);   // (G5-02 #14) the explicit "on"

    assert.equal((clean(await pd.syncPushDevice(A.client, now)) as Answer).status, 'registered');
    assert.equal((await unreg(s2, inst)).status, 'unregistered');
    assert.equal((clean(await pd.syncPushDevice(A.client, () => Promise.resolve({ ...state, expectedVersion: 3 }))) as Answer).status, 'STALE_REGISTRATION');
    assert.equal((clean(await pd.recoverStaleRegistration(A.client, now)) as Answer).status, 'removed');
    assert.match(await row(inst), /^revoked:unregistered:4:/u);
    // a newer token from the app's other session: the older one is refused and recovery registers the CURRENT token
    assert.equal((await reg(s2, inst, t2, 4)).status, 'registered');
    const old = clean(await pd.syncPushDevice(A.client, () => Promise.resolve({ ...state, pushToken: t1, expectedVersion: 4 }))) as Answer;
    assert.equal(old.status, 'STALE_REGISTRATION');
    assert.deepEqual((await targets(A)).hashes, [await hex(t2)], 'an older token overwrote the newer one');
    state.pushToken = t2;
    assert.equal((clean(await pd.recoverStaleRegistration(A.client, now)) as Answer).status, 'registered');
    assert.deepEqual((await targets(A)).hashes, [await hex(t2)]);
  },
  // (H4 #26 P2-1) a token nobody proved is PENDING: not a target, no claim; a wrong nonce is refused, an expired one too; five wrong answers
  // end it; the nonce the worker sent to that token, answered by the phone, makes it active
  async firstTokenNeedsProof() {
    const A = await person('fp');
    const inst = uuid(), t = fakeToken();
    const p = await reg1(A.client, inst, t, null);
    assert.equal(p.status, 'pending_proof', `an unproven first registration: ${p.status}`);
    assert.match(await row(inst), /^pending:-:1:false:false$/u);
    assert.deepEqual((await targets(A)).hashes, [], 'an unproven token is a delivery target');
    assert.equal(await claimOf(t), 'none');
    const l = await list(A.client);
    assert.deepEqual([l.devices[0].status, l.devices[0].deliverable], ['pending', false]);
    const nonce = await issueNonce(inst);
    assert.match(nonce, /^[0-9a-f]{64}$/u);
    const wrong = () => pd.registerPushDevice(A.client, { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t, expectedVersion: 1, proofNonce: randomNonce() });
    assert.equal((clean(await wrong()) as Answer).status, 'PROOF_INVALID');
    assert.deepEqual((await targets(A)).hashes, []);
    assert.equal((clean(await pd.registerPushDevice(A.client, { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t, expectedVersion: 1, proofNonce: nonce })) as Answer).status, 'registered');
    assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
    assert.equal(await claimOf(t), `${A.id}:${inst}`);
    // an expired nonce
    const i2 = uuid(), t2 = fakeToken();
    assert.equal((await reg1(A.client, i2, t2, null)).status, 'pending_proof');
    const n2 = await issueNonce(i2);
    await sql(OWNER, `update private.postona_push_devices set proof_expires_at = now() - interval '1 second' where installation_id = '${i2}'`);
    assert.equal((clean(await pd.registerPushDevice(A.client, { installationId: i2, deviceSecret: secretOf(i2), platform: 'ios', pushToken: t2, expectedVersion: 1, proofNonce: n2 })) as Answer).status, 'PROOF_EXPIRED');
    assert.match(await row(i2), /^pending:/u);
    // five wrong answers end it (the token erased)
    const i3 = uuid(), t3 = fakeToken();
    assert.equal((await reg1(A.client, i3, t3, null)).status, 'pending_proof');
    await issueNonce(i3);
    for (let k = 0; k < 5; k++) {
      assert.equal((clean(await pd.registerPushDevice(A.client, { installationId: i3, deviceSecret: secretOf(i3), platform: 'ios', pushToken: t3, expectedVersion: 1, proofNonce: randomNonce() })) as Answer).status, 'PROOF_INVALID');
    }
    assert.match(await row(i3), /^revoked:proof_failed:2:true:true$/u);
    // never proven in time: purge ends it
    await sql(OWNER, `update private.postona_push_devices set pending_expires_at = now() - interval '1 second' where installation_id = '${i2}'`);
    await sql(OWNER, `select private.postona_push_devices_purge()`);
    assert.match(await row(i2), /^revoked:proof_expired:2:true:true$/u);
  },
  // (H4 #26 P2-1) a wrong first binding locks nobody out: X registered the victim's token first (it stays pending, X never gets the nonce:
  // it goes to the victim's phone, whose app ignores a proof for another installation); the victim's phone proves and gets it
  async wrongFirstBindingRecovers() {
    const X = await person('wb-x'), V = await person('wb-v');
    const iX = uuid(), iV = uuid(), t = fakeToken();
    assert.equal((await reg1(X.client, iX, t, null)).status, 'pending_proof');
    assert.equal((await reg1(V.client, iV, t, null)).status, 'pending_proof');
    const nX = await issueNonce(iX);
    const nV = await issueNonce(iV);
    // both pushes reach the victim's phone (the token is its); its app answers only its own installation's
    const vState = () => Promise.resolve({ installationId: iV, deviceSecret: secretOf(iV), platform: 'ios', pushToken: t, expectedVersion: 1, notificationsEnabled: true });
    assert.equal((clean(await pc.confirmPushDevice(V.client, vState, { kind: 'postona_push_proof', installation_id: iX, nonce: nX })) as Answer).status, 'ignored');
    assert.equal((clean(await pc.confirmPushDevice(V.client, vState, { kind: 'postona_push_proof', installation_id: iV, nonce: nV })) as Answer).status, 'registered');
    assert.deepEqual((await targets(V)).hashes, [await hex(t)]);
    assert.deepEqual((await targets(X)).hashes, []);
    // X never saw the nonce: a guess is refused, and the victim's nonce does not fit X's registration
    assert.equal((clean(await pd.registerPushDevice(X.client, { installationId: iX, deviceSecret: secretOf(iX), platform: 'ios', pushToken: t, expectedVersion: 1, proofNonce: randomNonce() })) as Answer).status, 'PROOF_INVALID');
    assert.equal((clean(await pd.registerPushDevice(X.client, { installationId: iX, deviceSecret: secretOf(iX), platform: 'ios', pushToken: t, expectedVersion: 1, proofNonce: nV })) as Answer).status, 'PROOF_INVALID');
    assert.equal(await activeFor(t), '1');
    assert.equal(await claimOf(t), `${V.id}:${iV}`);
    // and X registering again is pending again (never active, never taking it over)
    assert.notEqual((await reg1(X.client, uuid(), t, null)).status, 'registered');
    assert.deepEqual((await targets(X)).hashes, []);
  },
  // (H4 #26 P2-1) the token claim is released when its account is gone
  async claimReleaseOnAccountGone() {
    const A = await person('cr');
    const t = fakeToken();
    assert.equal((await reg(A.client, uuid(), t, null)).status, 'registered');
    assert.notEqual(await claimOf(t), 'none');
    await sql(SUPER, `set session_replication_role = replica; delete from public.common_accounts where user_id = '${A.id}'`);
    const counts = JSON.parse(await sql(OWNER, `select private.postona_push_devices_purge()`)) as Record<string, number>;
    assert.ok(counts.claims_released >= 1, JSON.stringify(counts));
    assert.equal(await claimOf(t), 'none');
  },
  // (H4 #26 P2-2) one per-person cap for register and "off" alike, taken under one per-person lock: at 100 rows with nothing old enough to
  // prune, "off" records nothing and every new installation's registration is refused (no delivery); rows older than a day are pruned
  // for room; two concurrent "off"s queue on the person's lock; the count never exceeds 100; "on" again from a recorded "off" works
  async capacityAtomic() {
    const A = await person('cap');
    const count = async () => Number(await sql(SUPER, `select count(*) from private.postona_push_devices where user_id = '${A.id}'`));
    await seedRevoked(A, 99);
    assert.equal(await count(), 99);
    const i100 = uuid();
    const off1 = clean(await pc.unregisterPushDevice(A.client, i100, secretOf(i100))) as { status: string; recorded?: boolean };
    assert.deepEqual([off1.status, off1.recorded], ['unregistered', true]);
    assert.equal(await count(), 100);
    const i101 = uuid();
    const off2 = clean(await pc.unregisterPushDevice(A.client, i101, secretOf(i101))) as { status: string; recorded?: boolean };
    assert.deepEqual([off2.status, off2.recorded], ['unregistered', false], 'a 101st row, or a refused "off"');
    assert.equal(await count(), 100);
    assert.equal((await reg(A.client, i101, fakeToken(), null)).status, 'DEVICE_LIMIT', 'the unrecorded "off" installation registered (delivery after "off")');
    assert.equal((await reg(A.client, uuid(), fakeToken(), null)).status, 'DEVICE_LIMIT', 'register is outside the cap "off" respects');
    assert.equal(await count(), 100);
    // two rows older than a day: two concurrent "off"s of new installations, queued on the person's lock, each prune one
    await sql(SUPER, `update private.postona_push_devices set revoked_at = now() - interval '2 days' where installation_id in (select installation_id from private.postona_push_devices
      where user_id = '${A.id}' and installation_id not in ('${i100}') order by installation_id limit 2)`);
    const holder = new Session('g5pd-holder-cap');
    await holder.send(`begin; select pg_advisory_xact_lock(private.postona_push_lock_key('user', '${A.id}'));`);
    assert.ok(await holding('g5pd-holder-cap'));
    const ia = uuid(), ib = uuid();
    const pa = (async () => clean(await pc.unregisterPushDevice(A.client, ia, secretOf(ia))) as { recorded?: boolean })();
    const pb = (async () => clean(await pc.unregisterPushDevice(A.client, ib, secretOf(ib))) as { recorded?: boolean })();
    assert.ok(await until(async () => await waitingCalls('postona_push_device_unregister') === 2), 'the two "off"s did not queue on the person\'s lock');
    await holder.send('commit;');
    assert.ok((await holder.close()).ok);
    const [ra, rb] = await Promise.all([pa, pb]);
    assert.deepEqual([ra.recorded, rb.recorded], [true, true]);
    assert.equal(await count(), 100);
    // "on" again from a recorded "off": its own row, no room needed
    assert.equal((await reg(A.client, i100, fakeToken(), 1)).status, 'registered');
    assert.equal(await count(), 100);
  },
  // (H4 #26 P2-2) retention: revoked rows go 30 days after their revoke; a claim goes 180 days after its last activation when no active row
  // holds the token, and stays while one does
  async retentionPurge() {
    const A = await person('ret');
    const iOld = uuid(), tOld = fakeToken(), iLive = uuid(), tLive = fakeToken();
    assert.equal((await reg(A.client, iOld, tOld, null)).status, 'registered');
    assert.equal((await unreg(A.client, iOld)).status, 'unregistered');
    assert.equal((await reg(A.client, iLive, tLive, null)).status, 'registered');
    await sql(SUPER, `update private.postona_push_devices set revoked_at = now() - interval '31 days' where installation_id = '${iOld}';
      update private.postona_push_token_claims set updated_at = now() - interval '181 days' where user_id = '${A.id}'`);
    const counts = JSON.parse(await sql(OWNER, `select private.postona_push_devices_purge()`)) as Record<string, number>;
    assert.ok(counts.history_deleted >= 1 && counts.claims_expired >= 1, JSON.stringify(counts));
    assert.equal(await row(iOld), 'none');
    assert.equal(await claimOf(tOld), 'none');
    assert.equal(await claimOf(tLive), `${A.id}:${iLive}`, 'a claim with an active row expired');
    assert.deepEqual((await targets(A)).hashes, [await hex(tLive)]);
  },
  // (H4 #27 P2-1) a nonce only for a pending registration delivery itself would accept now -- not after an owner loss, a service end, a
  // restart (an older generation) or a sign-out, with purge not run
  async proofIssueEligibility() {
    const A = await person('pe-a');
    const i1 = uuid();
    assert.equal((await reg1(A.client, i1, fakeToken(), null)).status, 'pending_proof');
    await sql(SUPER, `delete from public.brand_memberships where user_id = '${A.id}'`);
    assert.equal(await issueNonce(i1), '', 'a nonce after the owner loss');
    await sql(SUPER, `insert into public.brand_memberships (brand_id, user_id, role) values ('${A.ws}', '${A.id}', 'owner')`);
    assert.match(await issueNonce(i1), /^[0-9a-f]{64}$/u, 'the owner back: no nonce');
    const B = await person('pe-b');
    const i2 = uuid();
    assert.equal((await reg1(B.client, i2, fakeToken(), null)).status, 'pending_proof');
    await endService(B);
    assert.equal(await issueNonce(i2), '', 'a nonce after the service end');
    await restart(B);
    assert.equal(await issueNonce(i2), '', 'a nonce for an older generation');
    assert.match(await row(i2), /^pending:/u);
    const C = await person('pe-c');
    const phone = await second(C);
    const i3 = uuid();
    assert.equal((await reg1(phone, i3, fakeToken(), null)).status, 'pending_proof');
    await phone.auth.signOut({ scope: 'local' });
    assert.equal(await issueNonce(i3), '', 'a nonce after the sign-out');
  },
  // (H4 #27 P2-1) the issue's lock order: the stop fence FOR SHARE first, then -- never waiting -- the account, the advisory locks, the row.
  // A lifecycle change or a registration holding its lock: that row is skipped at once (no nonce). A stop in progress: the issue waits for
  // it and issues nothing. An issue in progress: the stop waits for it, then erases the row (its nonce then fits nothing)
  async proofIssueLockOrder() {
    const A = await person('lo');
    const i1 = uuid(), t1 = fakeToken();
    assert.equal((await reg1(A.client, i1, t1, null)).status, 'pending_proof');
    const acc = new Session('g5pd-holder-acc', SUPER);
    await acc.send(`begin; select 1 from public.common_accounts where user_id = '${A.id}' for update;`);
    assert.ok(await holding('g5pd-holder-acc'));
    let t0 = Date.now();
    assert.equal(await issueNonce(i1), '', 'a nonce while a lifecycle change holds the account');
    assert.ok(Date.now() - t0 < 3_000, 'the issue waited on the account');
    await acc.send('commit;');
    assert.ok((await acc.close()).ok);
    const held = new Session('g5pd-holder-row', SUPER);
    await held.send(`begin; select 1 from private.postona_push_devices where installation_id = '${i1}' for update;`);
    assert.ok(await holding('g5pd-holder-row'));
    t0 = Date.now();
    assert.equal(await issueNonce(i1), '', 'a nonce while a registration holds the row');
    assert.ok(Date.now() - t0 < 3_000, 'the issue waited on the row');
    await held.send('commit;');
    assert.ok((await held.close()).ok);
    // a stop in progress holds the fence
    const stop = new Session('g5pd-holder-stop');
    await stop.send(`begin; select 1 from private.postona_push_control c where c.id for update;`);
    assert.ok(await holding('g5pd-holder-stop'));
    const late = issueNonce(i1);
    assert.ok(await until(async () => await waitingCalls('postona_push_proof_issue') === 1, 4_000), 'the issue did not wait for the stop');
    await stop.send(`update private.postona_push_control c set enabled = false where c.id; commit;`);
    assert.ok((await stop.close()).ok);
    assert.equal(await late, '', 'a nonce issued past the stop');
    await restartPush();
    // an issue in progress holds the fence FOR SHARE: the stop waits for it
    const iss = new Session('g5pd-holder-issue');
    await iss.send(`begin; select jsonb_array_length(private.postona_push_proof_issue(5, '${i1}'));`);
    assert.ok(await holding('g5pd-holder-issue'));
    const stopRun = runFile(STOP);
    assert.ok(await until(async () => await waitingStop() === 1, 4_000), 'the stop did not wait for the issue in progress');
    await iss.send('commit;');
    const out = await iss.close();
    assert.ok(out.ok, out.error);
    assert.equal(out.out.trim(), '1');
    const s = await stopRun;
    assert.ok(s.ok, s.error);
    assert.match(await row(i1), /^revoked:stopped:/u);
    await restartPush();
  },
  // (H4 #27 P2-2) the answer is fresh: the nonce never outlives its pending registration; an expired pending registration is never
  // activated (purge not run); another session of the person (also after the registering one signed out), a restart, a re-registration
  // make the nonce stale (not counted as wrong answers); a nonce works once
  async proofAcceptanceFreshness() {
    const ans = (c: SupabaseClient, inst: string, t: string, v: number, nonce: string) =>
      (async () => (clean(await pd.registerPushDevice(c, { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t, expectedVersion: v, proofNonce: nonce })) as Answer).status)();
    const A = await person('pf-a');
    const i1 = uuid(), t1 = fakeToken();
    assert.equal((await reg1(A.client, i1, t1, null)).status, 'pending_proof');
    await sql(SUPER, `update private.postona_push_devices set pending_expires_at = now() + interval '2 minutes' where installation_id = '${i1}'`);
    const n1 = await issueNonce(i1);
    assert.equal(await sql(SUPER, `select proof_expires_at <= pending_expires_at from private.postona_push_devices where installation_id = '${i1}'`), 't', 'the nonce outlives the pending registration');
    await sql(SUPER, `update private.postona_push_devices set pending_expires_at = now() - interval '1 second' where installation_id = '${i1}'`);
    assert.equal(await ans(A.client, i1, t1, 1, n1), 'PROOF_EXPIRED', 'an expired pending registration answered');
    assert.match(await row(i1), /^pending:/u);
    assert.deepEqual((await targets(A)).hashes, []);
    const phone = await second(A);
    const i2 = uuid(), t2 = fakeToken();
    assert.equal((await reg1(phone, i2, t2, null)).status, 'pending_proof');
    const n2 = await issueNonce(i2);
    assert.equal(await ans(A.client, i2, t2, 1, n2), 'PROOF_STALE', 'another session answered the nonce');
    await phone.auth.signOut({ scope: 'local' });
    assert.equal(await ans(A.client, i2, t2, 1, n2), 'PROOF_STALE', 'another session answered after the first signed out');
    assert.equal(await sql(SUPER, `select proof_failures from private.postona_push_devices where installation_id = '${i2}'`), '0');
    assert.deepEqual((await targets(A)).hashes, []);
    const B = await person('pf-b');
    const i3 = uuid(), t3 = fakeToken();
    assert.equal((await reg1(B.client, i3, t3, null)).status, 'pending_proof');
    const n3 = await issueNonce(i3);
    await endService(B);
    await restart(B);
    assert.equal(await ans(B.client, i3, t3, 1, n3), 'PROOF_STALE', 'a nonce of an older generation answered');
    assert.deepEqual((await targets(B)).hashes, []);
    const i4 = uuid(), t4 = fakeToken(), t5 = fakeToken();
    assert.equal((await reg1(B.client, i4, t4, null)).status, 'pending_proof');
    const n4 = await issueNonce(i4);
    assert.equal((await reg1(B.client, i4, t5, 1)).status, 'pending_proof');
    assert.equal(await ans(B.client, i4, t5, 2, n4), 'PROOF_EXPIRED', 'a nonce of the earlier registration answered');
    assert.equal(await ans(B.client, i4, t4, 1, n4), 'PROOF_NOT_PENDING');
    const n5 = await issueNonce(i4);
    assert.equal(await ans(B.client, i4, t5, 2, n5), 'registered');
    assert.equal(await ans(B.client, i4, t5, 2, n5), 'PROOF_NOT_PENDING', 'a nonce answered twice');
    assert.deepEqual((await targets(B)).hashes, [await hex(t5)]);
  },
  // (H4 #28 P2) "on" again is the person's explicit, server-recorded act -- never a JWT's age: a registration that turns an installation
  // on (from none, from its own "off" row) needs the live one-time ON grant of that installation, device secret, session and generation.
  // After a pruned "off", an "off" the cap could not record, a handover, a stop: the earlier request (delayed, or retried after a REAL
  // GoTrue session refresh, or carrying a grant asked before the "off") never registers, even with a proven token; a new explicit enable
  // after the "off" does. The grant is spent by its use, and is not valid for another session, installation, secret or generation
  async explicitOnRequired() {
    const A = await person('eo-a');
    const t = fakeToken();
    assert.equal((await reg(A.client, uuid(), t, null)).status, 'registered');   // A's proven token
    const late = (c: SupabaseClient, inst: string, tok: string, v: number | null, g?: string) =>
      (async () => (clean(await pd.registerPushDevice(c, { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: tok, expectedVersion: v, ...(g ? { onGrant: g } : {}) })) as Answer).status)();
    // (a) a pruned "off": the request made before it (with the grant asked before it) -- also after a real session refresh
    const iP = uuid();
    const before = await grantOf(A.client, iP);
    assert.match(before ?? '', /^[0-9a-f]{64}$/u);
    assert.equal((await unreg(A.client, iP, secretOf(iP))).status, 'unregistered');
    await sql(SUPER, `update private.postona_push_devices set revoked_at = now() - interval '2 days' where installation_id = '${iP}'`);
    await seedRevoked(A, 98);
    assert.equal(await countOf(A), 100);
    const iX = uuid();
    assert.equal((await unreg(A.client, iX, secretOf(iX))).status, 'unregistered');   // its room is the pruned "off" row
    assert.equal(await row(iP), 'none');
    await ageRows(A, 1, [iX]);
    assert.equal(await late(A.client, iP, t, null, before), 'ENABLE_REQUIRED', 'the grant asked before the pruned "off" registered');
    assert.equal(await late(A.client, iP, t, null), 'ENABLE_REQUIRED', 'a first registration without a grant');
    await sleep(1_100);
    assert.ok(!(await A.client.auth.refreshSession()).error);
    assert.equal(await late(A.client, iP, t, null, before), 'ENABLE_REQUIRED', 'a session refresh authorized "on"');
    assert.equal(await row(iP), 'none');
    assert.equal(await activeFor(t), '1');
    assert.equal(await late(A.client, iP, t, null, await grantOf(A.client, iP)), 'registered', 'the explicit "on" after the "off"');
    // (b) an "off" the cap could not record, then room
    const B = await person('eo-b');
    const tb = fakeToken();
    assert.equal((await reg(B.client, uuid(), tb, null)).status, 'registered');
    await seedRevoked(B, 99);
    const iF = uuid();
    const gF = await grantOf(B.client, iF);
    const off = clean(await pc.unregisterPushDevice(B.client, iF, secretOf(iF))) as { status: string; recorded?: boolean };
    assert.deepEqual([off.status, off.recorded], ['unregistered', false]);
    await ageRows(B, 2);
    assert.equal(await late(B.client, iF, tb, null, gF), 'ENABLE_REQUIRED', 'the grant asked before the unrecorded "off" registered once room freed up');
    await sleep(1_100);
    assert.ok(!(await B.client.auth.refreshSession()).error);
    assert.equal(await late(B.client, iF, tb, null), 'ENABLE_REQUIRED', 'a session refresh authorized "on"');
    assert.equal(await row(iF), 'none');
    assert.equal(await late(B.client, iF, tb, null, await grantOf(B.client, iF)), 'registered');
    // (c) a handover: the earlier person's grant asked before their "off" does not take the phone back
    const C = await person('eo-c'), D = await person('eo-d');
    const iH = uuid(), tc = fakeToken();
    assert.equal((await reg(C.client, iH, tc, null)).status, 'registered');
    const gC = await grantOf(C.client, iH);
    assert.equal((await unreg(C.client, iH, secretOf(iH))).status, 'unregistered');
    assert.equal(await late(D.client, iH, tc, null), 'ENABLE_REQUIRED', 'a handover without the new person\'s "on"');
    assert.equal((await reg(D.client, iH, tc, null)).status, 'registered', 'the same phone handed over with its device secret and D\'s "on"');
    assert.equal(await late(C.client, iH, tc, null, gC), 'ENABLE_REQUIRED');
    assert.equal(await owner(iH), D.id);
    // (c2) the grant is spent by its use: the same request again, after the phone moved to another account, does not take it back
    const C2 = await person('eo-c2'), D2 = await person('eo-d2');
    const iH2 = uuid(), tc2 = fakeToken();
    const g0 = await grantOf(C2.client, iH2);
    assert.equal(await late(C2.client, iH2, tc2, null, g0), 'pending_proof');
    assert.equal((await reg1(D2.client, iH2, tc2, null)).status, 'pending_proof', 'the same phone handed over to D2');
    assert.equal(await late(C2.client, iH2, tc2, null, g0), 'ENABLE_REQUIRED', 'a used grant took the phone back');
    assert.equal(await owner(iH2), D2.id);
    // (d) the person's own recorded "off" row: "on" from its version needs the grant too; the grant is spent by its use
    const E = await person('eo-e');
    const iE = uuid(), te = fakeToken();
    const gE = await grantOf(E.client, iE);
    assert.equal(await late(E.client, iE, te, null, gE), 'pending_proof', 'a no-claim token with the grant: pending');
    assert.equal((clean(await pd.registerPushDevice(E.client, { installationId: iE, deviceSecret: secretOf(iE), platform: 'ios', pushToken: te, expectedVersion: 1, proofNonce: await issueNonce(iE) })) as Answer).status, 'registered');
    assert.equal((await unreg(E.client, iE)).status, 'unregistered');
    assert.equal(await late(E.client, iE, te, 2), 'ENABLE_REQUIRED', '"on" from the own "off" row without a grant');
    assert.equal(await late(E.client, iE, te, 2, gE), 'ENABLE_REQUIRED', 'a spent grant used again');
    // (e) the grant's binding: another session, another installation, another device secret, another generation
    const s2 = await second(E);
    const g2 = await grantOf(s2, iE);
    assert.equal(await late(E.client, iE, te, 2, g2), 'ENABLE_REQUIRED', 'a grant of another session');
    const iO = uuid();
    assert.equal(await late(E.client, iO, te, null, await grantOf(E.client, iE)), 'ENABLE_REQUIRED', 'a grant of another installation');
    const iS = uuid();
    const gS = await grantOf(E.client, iS, newSecret());
    assert.equal(await late(E.client, iS, te, null, gS), 'ENABLE_REQUIRED', 'a grant asked with another device secret');
    const gL = await grantOf(E.client, iE);
    await endService(E);
    await restart(E);
    assert.equal(await late(E.client, iE, te, 2, gL), 'ENABLE_REQUIRED', 'a grant of an older generation');
    assert.equal(await late(E.client, iE, te, 2, await grantOf(E.client, iE)), 'registered', 'the explicit "on" from the own "off" row (its proven token)');
    // (f) "on" and "off" at once (queued on the person's lock, either order): the phone ends off
    const F = await person('eo-f');
    for (let k = 0; k < 2; k++) {
      const inst = uuid(), tf = fakeToken();
      const g = await grantOf(F.client, inst);
      const holder = new Session(`g5pd-holder-onoff${k}`);
      await holder.send(`begin; select pg_advisory_xact_lock(private.postona_push_lock_key('user', '${F.id}'));`);
      assert.ok(await holding(`g5pd-holder-onoff${k}`));
      const first = k === 0 ? late(F.client, inst, tf, null, g) : (async () => (clean(await pc.unregisterPushDevice(F.client, inst, secretOf(inst))) as Answer).status)();
      assert.ok(await until(async () => (await waitingCalls('postona_push_device_register')) + (await waitingCalls('postona_push_device_unregister')) === 1));
      const second_ = k === 0 ? (async () => (clean(await pc.unregisterPushDevice(F.client, inst, secretOf(inst))) as Answer).status)() : late(F.client, inst, tf, null, g);
      assert.ok(await until(async () => (await waitingCalls('postona_push_device_register')) + (await waitingCalls('postona_push_device_unregister')) === 2));
      await holder.send('commit;');
      assert.ok((await holder.close()).ok);
      const [x, y] = await Promise.all([first, second_]);
      assert.ok([x, y].includes('unregistered'), `${x} ${y}`);
      assert.doesNotMatch(await row(inst), /^(active|pending):/u, `round ${k}: the phone is on after "off" (${x} ${y})`);
    }
    // (g) the stop deletes every grant
    const G = await person('eo-g');
    const iG = uuid();
    const gG = await grantOf(G.client, iG);
    await okFile(STOP);
    await restartPush();
    assert.equal(await late(G.client, iG, fakeToken(), null, gG), 'ENABLE_REQUIRED', 'a grant survived the stop');
    // (h) at most 10 live grants per person
    const H = await person('eo-h');
    for (let k = 0; k < 10; k++) assert.match((await grantOf(H.client, uuid())) ?? '', /^[0-9a-f]{64}$/u);
    assert.equal((clean(await pd.enablePushDevice(H.client, uuid(), newSecret())) as Answer).status, 'DEVICE_LIMIT');
  },
  // (H4 #28 P3) the proof push's own pre-send read: the token only for the live nonce of a still-pending registration delivery would
  // accept now; delivery targets stay active-only. Off, expiry, a wrong nonce or version, sign-out, owner loss, service end / restart, stop
  async proofPresend() {
    const pre = (inst: string, v: number, nonce: string) => sql(OWNER, `select (x->>'verdict') || ':' || coalesce(encode(sha256(convert_to(x->>'push_token', 'UTF8')), 'hex'), '-')
      from (select private.postona_push_proof_presend('${inst}', ${v}, '${nonce}') x) s`);
    const A = await person('ps-a');
    const i1 = uuid(), t1 = fakeToken();
    assert.equal((await reg1(A.client, i1, t1, null)).status, 'pending_proof');
    const n1 = await issueNonce(i1);
    assert.equal(await pre(i1, 1, n1), `send:${await hex(t1)}`);
    assert.deepEqual((await targets(A)).hashes, [], 'delivery targets answered a pending registration');
    assert.equal(await pre(i1, 1, randomNonce()), 'PROOF_INVALID:-');
    assert.equal(await pre(i1, 2, n1), 'PROOF_NOT_PENDING:-');
    await sql(SUPER, `update private.postona_push_devices set proof_expires_at = now() - interval '1 second' where installation_id = '${i1}'`);
    assert.equal(await pre(i1, 1, n1), 'PROOF_EXPIRED:-', 'an expired nonce');
    const i2 = uuid(), t2 = fakeToken();
    assert.equal((await reg1(A.client, i2, t2, null)).status, 'pending_proof');
    const n2 = await issueNonce(i2);
    await sql(SUPER, `update private.postona_push_devices set pending_expires_at = now() - interval '1 second' where installation_id = '${i2}'`);
    assert.equal(await pre(i2, 1, n2), 'PROOF_EXPIRED:-', 'an expired pending registration');
    const i3 = uuid();
    assert.equal((await reg1(A.client, i3, fakeToken(), null)).status, 'pending_proof');
    const n3 = await issueNonce(i3);
    assert.equal((await unreg(A.client, i3)).status, 'unregistered');
    assert.equal(await pre(i3, 1, n3), 'PROOF_NOT_PENDING:-', 'the person turned it off');
    const i4 = uuid();
    assert.equal((await reg1(A.client, i4, fakeToken(), null)).status, 'pending_proof');
    const n4 = await issueNonce(i4);
    await sql(SUPER, `delete from public.brand_memberships where user_id = '${A.id}'`);
    assert.doesNotMatch(await pre(i4, 1, n4), /^send:/u, 'after the owner loss');
    await sql(SUPER, `insert into public.brand_memberships (brand_id, user_id, role) values ('${A.ws}', '${A.id}', 'owner')`);
    assert.match(await pre(i4, 1, n4), /^send:/u);
    await sql(OWNER, `update private.postona_push_control set enabled = false where id`);
    try {
      assert.equal(await pre(i4, 1, n4), 'PUSH_DEVICES_STOPPED:-');
    } finally {
      await sql(OWNER, `update private.postona_push_control set enabled = true where id`);
    }
    const B = await person('ps-b');
    const phone = await second(B);
    const i5 = uuid();
    assert.equal((await reg1(phone, i5, fakeToken(), null)).status, 'pending_proof');
    const n5 = await issueNonce(i5);
    await phone.auth.signOut({ scope: 'local' });
    assert.equal(await pre(i5, 1, n5), 'SESSION_ENDED:-', 'after the registering session signed out');
    const i6 = uuid();
    assert.equal((await reg1(B.client, i6, fakeToken(), null)).status, 'pending_proof');
    const n6 = await issueNonce(i6);
    await endService(B);
    assert.doesNotMatch(await pre(i6, 1, n6), /^send:/u, 'after the service end');
    await restart(B);
    assert.equal(await pre(i6, 1, n6), 'PROOF_STALE:-', 'an older generation');
    // an active row is not a proof target
    const C = await person('ps-c');
    const i7 = uuid();
    assert.equal((await reg(C.client, i7, fakeToken(), null)).status, 'registered');
    assert.equal(await pre(i7, 1, randomNonce()), 'PROOF_NOT_PENDING:-');
  },
  // the rollback refuses while a device is active (its tokens would be dropped unseen; stop erases them first)
  async rollbackRefusesActive() {
    const A = await person('rb');
    assert.equal((await reg(A.client, uuid(), fakeToken(), null)).status, 'registered');
    const before = await catalog();
    const r = await runText(currentRollback);
    assert.equal(r.ok, false, 'the rollback dropped active devices');
    assert.equal(code(r), 'PUSH_ACTIVE_DEVICES');
    assert.equal(await catalog(), before);
  },
};

// =========================================================================================================================================
Deno.test({ name: 'push: BEFORE (as built): POSTONA has no push-device API, and the existing per-app table (public.device_push_tokens, the KabuMori app\'s) cannot carry the contract: the token is readable with the person\'s JWT, another person on the same phone cannot take it over, and sign-out / service end leave it deliverable (no session / workspace / generation binding)', ...opts }, async () => {
  await ensureProfile();
  assert.equal(await sql(SUPER, `select to_regclass('private.postona_push_devices') is null and to_regprocedure('public.postona_push_device_register(uuid,text,text,integer)') is null`), 't');
  const A = await person('before-a'), B = await person('before-b');
  const absent = await A.client.rpc('postona_push_device_register', { p_installation_id: uuid(), p_platform: 'ios', p_push_token: fakeToken(), p_expected_version: null });
  assert.ok(absent.error?.code === 'PGRST202' || absent.error?.code === '42883', `the RPC exists before the install: ${absent.error?.code}`);

  // the KabuMori app's table, exactly as its migration builds it. This throw-away world has the lifecycle fixture's simplified stand-in
  // (no row security, no platform): it is set aside for this test and put back at the end; profiles / the trigger helper only when missing.
  const standIns: string[] = [];
  if (await sql(SUPER, `select to_regclass('public.device_push_tokens') is not null`) === 't') {
    await sql(OWNER, `alter table public.device_push_tokens rename to g5pd_fixture_device_push_tokens`);
    standIns.push('alter table public.g5pd_fixture_device_push_tokens rename to device_push_tokens');
  }
  if (await sql(SUPER, `select to_regclass('public.profiles') is null`) === 't') {
    await sql(OWNER, `create table public.profiles (id uuid primary key references auth.users (id) on delete cascade)`);
    standIns.push('drop table public.profiles');
  }
  if (await sql(SUPER, `select to_regprocedure('public.kabumori_set_updated_at()') is null`) === 't') {
    await sql(OWNER, `create function public.kabumori_set_updated_at() returns trigger language plpgsql as $f$ begin new.updated_at := now(); return new; end $f$`);
    standIns.push('drop function public.kabumori_set_updated_at()');
  }
  const mig = await psql(OWNER, ['-f', `${PUSH}/../../migrations/20260903160000_add_device_push_tokens.sql`]);
  assert.ok(mig.ok, mig.error);
  // the KabuMori profile rows the table needs (its FK): this world's lifecycle guard refuses them (no KabuMori service), so the fixture rows
  // only are written with triggers off, as the superuser
  await sql(SUPER, `set session_replication_role = replica; insert into public.profiles (id) values ('${A.id}'), ('${B.id}') on conflict do nothing`);
  await sql(SUPER, `notify pgrst, 'reload schema'`);
  assert.ok(await until(async () => (await A.client.from('device_push_tokens').select('id').limit(1)).error === null));
  const t = fakeToken();
  const up = (c: SupabaseClient, user: string) => c.from('device_push_tokens').upsert({ user_id: user, expo_push_token: t, platform: 'ios', device_id: null }, { onConflict: 'expo_push_token' });
  assert.equal((await up(A.client, A.id)).error, null);
  // FAIL 1: the secret is readable with the person's JWT (any leaked access token reads it)
  const read = await A.client.from('device_push_tokens').select('expo_push_token');
  assert.equal(await hex((read.data as Array<{ expo_push_token: string }>)[0].expo_push_token), await hex(t));
  // FAIL 2: B signs in on the same phone and registers its token: refused by row security, so the token stays A's (A's notifications
  // keep arriving on the phone B now holds)
  const taken = await up(B.client, B.id);
  assert.notEqual(taken.error, null);
  assert.equal(await sql(SUPER, `select string_agg(user_id::text, ',') from public.device_push_tokens where expo_push_token is not null and user_id in ('${A.id}', '${B.id}')`), A.id);
  // FAIL 3 / 4: sign-out (without the app's best-effort delete) and a service end leave the row: nothing binds it to a session, a
  // workspace or a generation (the table has no such column)
  await A.client.auth.signOut({ scope: 'local' });
  await endService(A);
  assert.equal(await sql(SUPER, `select count(*) from public.device_push_tokens where user_id = '${A.id}'`), '1');
  assert.equal(await sql(SUPER, `select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'device_push_tokens'
    and column_name in ('session_id', 'workspace_id', 'brand_id', 'lifecycle_version')`), '0');
  // the world as it was
  await sql(OWNER, `drop table public.device_push_tokens`);
  for (const s of standIns.reverse()) await sql(OWNER, s);
  await sql(SUPER, `notify pgrst, 'reload schema'`);
});

Deno.test({ name: 'push: BEFORE (PR #667 9140cefd, its own install and client): H4 #24 P2-1 a registration in flight commits after the stop and is a delivery target; P2-2 the client re-sends a stale registration over "off" and over a newer token; P2-3 a leaked installation id or token takes over a live registration of another person', ...opts }, async () => {
  await ensureProfile();
  assert.equal(await sql(SUPER, `select to_regclass('private.postona_push_devices') is null`), 't');
  const inst667 = await psql(OWNER, ['-f', `${PR667}/${INSTALL}`]);
  assert.ok(inst667.ok, inst667.error);
  await reloadApi('present');
  try {
    // P2-1
    const A = await person('b667-a');
    const t = fakeToken();
    const holder = new Session('g5pd-holder-b667');
    await holder.send(`begin; select 1 from public.common_accounts where user_id = '${A.id}' for update;`);
    assert.ok(await holding('g5pd-holder-b667'));
    const pR = reg667(A.client, uuid(), t, null);
    assert.ok(await until(async () => await waitingCalls('postona_push_device_register') === 1));
    const stop = await psql(OWNER, ['-f', `${PR667}/${STOP}`]);
    assert.ok(stop.ok, stop.error);
    await holder.send('commit;');
    assert.ok((await holder.close()).ok);
    assert.equal((await pR).status, 'registered', 'P2-1 (#667): the in-flight registration committed after the stop');
    assert.equal(await activeFor(t), '1', 'P2-1 (#667): an active token after the stop');
    assert.deepEqual((await targets(A)).hashes, [await hex(t)], 'P2-1 (#667): a delivery target after the stop');
    const again = await psql(OWNER, ['-f', `${PR667}/${INSTALL}`]);
    assert.ok(again.ok, again.error);
    await reloadApi('present');
    // P2-2
    const B = await person('b667-b');
    const s2 = await second(B);
    const inst = uuid(), t1 = fakeToken(), t2 = fakeToken();
    assert.equal((await reg667(B.client, inst, t1, null)).status, 'registered');
    assert.equal((clean(await pd667.unregisterPushDevice(B.client, inst)) as Answer).status, 'unregistered');
    const revived = clean(await pd667.syncPushDevice(B.client, { installationId: inst, platform: 'ios', pushToken: t1, expectedVersion: 1 })) as Answer;
    assert.equal(revived.status, 'registered', 'P2-2 (#667): the re-send revived the phone after "off"');
    assert.match(await row(inst), /^active:-:3:/u);
    assert.equal((await reg667(s2, inst, t2, 3)).status, 'registered');
    const overwrote = clean(await pd667.syncPushDevice(B.client, { installationId: inst, platform: 'ios', pushToken: t1, expectedVersion: 3 })) as Answer;
    assert.equal(overwrote.status, 'registered', 'P2-2 (#667): the re-send of the older token');
    assert.deepEqual((await targets(B)).hashes, [await hex(t1)], 'P2-2 (#667): the newer token was overwritten');
    // P2-3
    const V = await person('b667-v'), X = await person('b667-x');
    const iV = uuid(), tv = fakeToken();
    assert.equal((await reg667(V.client, iV, tv, null)).status, 'registered');
    assert.equal((await reg667(X.client, iV, fakeToken(), null)).status, 'registered', 'P2-3 (#667): a leaked installation id took the row');
    assert.equal(await owner(iV), X.id);
    assert.deepEqual((await targets(V)).hashes, []);
    const iV2 = uuid(), tv2 = fakeToken();
    assert.equal((await reg667(V.client, iV2, tv2, null)).status, 'registered');
    assert.equal((await reg667(X.client, uuid(), tv2, null)).status, 'registered', 'P2-3 (#667): a leaked token moved to another account');
    assert.match(await row(iV2), /^revoked:taken_over:/u);
    assert.deepEqual((await targets(V)).hashes, [], 'P2-3 (#667): the victim stops receiving');
    assert.deepEqual((await targets(X)).hashes.includes(await hex(tv2)), true);
  } finally {
    const s = await psql(OWNER, ['-f', `${PR667}/${STOP}`]);
    assert.ok(s.ok, s.error);
    const r = await psql(OWNER, ['-f', `${PR667}/${ROLLBACK}`]);
    assert.ok(r.ok, r.error);
    await reloadApi('absent');
  }
});

Deno.test({ name: 'push: BEFORE (PR #672 a04c1709, its own install and client): H4 #25 P2-1 after the owner signs out, another account takes the token on another installation (and the owner cannot recover it); P2-2 "off" before the first registration leaves nothing, so the delayed first registration succeeds; the client reports an old success while "off"', ...opts }, async () => {
  await ensureProfile();
  assert.equal(await sql(SUPER, `select to_regclass('private.postona_push_devices') is null`), 't');
  const i672 = await psql(OWNER, ['-f', `${PR672}/${INSTALL}`]);
  assert.ok(i672.ok, i672.error);
  await reloadApi('present');
  try {
    // P2-1
    const A = await person('b672-a'), B = await person('b672-b');
    const phone = await second(A);
    const iA = uuid(), iB = uuid(), t = fakeToken();
    assert.equal((clean(await pd672.registerPushDevice(phone, { installationId: iA, deviceSecret: secretOf(iA), platform: 'ios', pushToken: t, expectedVersion: null })) as Answer).status, 'registered');
    await phone.auth.signOut({ scope: 'local' });
    assert.equal((clean(await pd672.registerPushDevice(B.client, { installationId: iB, deviceSecret: secretOf(iB), platform: 'ios', pushToken: t, expectedVersion: null })) as Answer).status, 'registered',
      'P2-1 (#672): another account took the token after the owner signed out');
    assert.match(await row(iA), /^revoked:taken_over:/u);
    assert.deepEqual((await targets(B)).hashes, [await hex(t)], 'P2-1 (#672): the token is now a target of another account');
    const back = await second(A);
    assert.equal((clean(await pd672.registerPushDevice(back, { installationId: iA, deviceSecret: secretOf(iA), platform: 'ios', pushToken: t, expectedVersion: 2 })) as Answer).status, 'DEVICE_IN_USE',
      'P2-1 (#672): the owner cannot recover its own phone');
    // P2-2
    const C = await person('b672-c');
    const inst = uuid(), tc = fakeToken();
    const off = await C.client.rpc('postona_push_device_unregister', { p_installation_id: inst });
    assert.equal((off.data as { status: string }).status, 'not_registered', 'P2-2 (#672): "off" before the first registration keeps nothing');
    const late = clean(await pd672.registerPushDevice(C.client, { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: tc, expectedVersion: null })) as Answer;
    assert.equal(late.status, 'registered', 'P2-2 (#672): the delayed first registration succeeded after "off"');
    assert.deepEqual((await targets(C)).hashes, [await hex(tc)]);
    // the #672 client reports an old success although the person turned notifications off meanwhile
    const D = await person('b672-d');
    const id = uuid();
    let enabled = true;
    let reads = 0;
    const r = clean(await pd672.syncPushDevice(D.client, () => {
      const s = { installationId: id, deviceSecret: secretOf(id), platform: 'ios', pushToken: fakeToken(), expectedVersion: null, notificationsEnabled: enabled };
      if (++reads === 1) enabled = false;
      return Promise.resolve(s);
    })) as Answer;
    assert.equal(r.status, 'registered', 'P2-2 (#672): an old success while "off"');
    assert.match(await row(id), /^active:/u);
  } finally {
    const s = await psql(OWNER, ['-f', `${PR672}/${STOP}`]);
    assert.ok(s.ok, s.error);
    const r = await psql(OWNER, ['-f', `${PR672}/${ROLLBACK}`]);
    assert.ok(r.ok, r.error);
    await reloadApi('absent');
  }
});

Deno.test({ name: 'push: BEFORE (PR #676 6bd753cf, its own install and client): H4 #26 P2-1 a never-proven first registration of a (leaked) token is active and deliverable, and the real phone is then locked out (DEVICE_IN_USE, also after the first registrant signs out); P2-2 at 100 rows "off" of a new installation is refused (DEVICE_LIMIT) while a normal first registration still succeeds (101 rows)', ...opts }, async () => {
  await ensureProfile();
  assert.equal(await sql(SUPER, `select to_regclass('private.postona_push_devices') is null`), 't');
  const i676 = await psql(OWNER, ['-f', `${PR676}/${INSTALL}`]);
  assert.ok(i676.ok, i676.error);
  await reloadApi('present');
  try {
    // P2-1
    const X = await person('b676-x'), V = await person('b676-v');
    const phoneX = await second(X);
    const iX = uuid(), iV = uuid(), t = fakeToken();
    const r676 = (c: SupabaseClient, inst: string) =>
      (async () => clean(await pd676.registerPushDevice(c, { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t, expectedVersion: null })) as Answer)();
    assert.equal((await r676(phoneX, iX)).status, 'registered', 'P2-1 (#676): an unproven first registration is active');
    assert.deepEqual((await targets(X)).hashes, [await hex(t)], 'P2-1 (#676): an unproven token is a delivery target');
    assert.equal((await r676(V.client, iV)).status, 'DEVICE_IN_USE', 'P2-1 (#676): the real phone is locked out');
    await phoneX.auth.signOut({ scope: 'local' });
    assert.equal((await r676(V.client, iV)).status, 'DEVICE_IN_USE', 'P2-1 (#676): still locked out after the first registrant signed out');
    // P2-2
    const A = await person('b676-a');
    const count = async () => Number(await sql(SUPER, `select count(*) from private.postona_push_devices where user_id = '${A.id}'`));
    await seedRevoked(A, 99);
    const i1 = uuid(), i2 = uuid();
    assert.equal((clean(await pd676.unregisterPushDevice(A.client, i1, secretOf(i1))) as Answer).status, 'unregistered');
    assert.equal(await count(), 100);
    assert.equal((clean(await pd676.unregisterPushDevice(A.client, i2, secretOf(i2))) as Answer).status, 'DEVICE_LIMIT', 'P2-2 (#676): "off" of a new installation refused at 100 rows');
    const i3 = uuid();
    assert.equal((clean(await pd676.registerPushDevice(A.client, { installationId: i3, deviceSecret: secretOf(i3), platform: 'ios', pushToken: fakeToken(), expectedVersion: null })) as Answer).status, 'registered',
      'P2-2 (#676): register is outside the cap');
    assert.equal(await count(), 101, 'P2-2 (#676): the cap was passed');
    assert.equal((clean(await pd676.registerPushDevice(A.client, { installationId: i2, deviceSecret: secretOf(i2), platform: 'ios', pushToken: fakeToken(), expectedVersion: null })) as Answer).status, 'registered',
      'P2-2 (#676): the installation whose "off" was refused registered and is deliverable');
  } finally {
    const s = await psql(OWNER, ['-f', `${PR676}/${STOP}`]);
    assert.ok(s.ok, s.error);
    const r = await psql(OWNER, ['-f', `${PR676}/${ROLLBACK}`]);
    assert.ok(r.ok, r.error);
    await reloadApi('absent');
  }
});

Deno.test({ name: 'push: BEFORE (PR #681 9081a151, its own install and client): H4 #27 P2-1 a nonce is issued for a pending registration after its owner lost the workspace and after its service ended (session live, purge not run); P2-2 a nonce outlives its pending registration and activates it after that expired, and another session of the person activates the nonce issued to the first one; P2-3 a first registration made before an "off" is active once the "off" row was pruned and room is there, and once room freed up after an "off" the cap could not record', ...opts }, async () => {
  await ensureProfile();
  assert.equal(await sql(SUPER, `select to_regclass('private.postona_push_devices') is null`), 't');
  const i681 = await psql(OWNER, ['-f', `${PR681}/${INSTALL}`]);
  assert.ok(i681.ok, i681.error);
  await reloadApi('present');
  const r681 = (c: SupabaseClient, inst: string, t: string, v: number | null, nonce?: string) =>
    (async () => (clean(await pd681.registerPushDevice(c, { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t, expectedVersion: v, ...(nonce ? { proofNonce: nonce } : {}) })) as Answer).status)();
  const proven681 = async (c: SupabaseClient, inst: string, t: string) => {
    assert.equal(await r681(c, inst, t, null), 'pending_proof');
    assert.equal(await r681(c, inst, t, 1, await issueNonce(inst)), 'registered');
  };
  try {
    // P2-1
    const A = await person('b681-a');
    const i1 = uuid();
    assert.equal(await r681(A.client, i1, fakeToken(), null), 'pending_proof');
    await sql(SUPER, `delete from public.brand_memberships where user_id = '${A.id}'`);
    assert.match(await issueNonce(i1), /^[0-9a-f]{64}$/u, 'P2-1 (#681): a nonce after the owner loss');
    const B = await person('b681-b');
    const i2 = uuid();
    assert.equal(await r681(B.client, i2, fakeToken(), null), 'pending_proof');
    await endService(B);
    assert.match(await issueNonce(i2), /^[0-9a-f]{64}$/u, 'P2-1 (#681): a nonce after the service end');
    // P2-2
    const C = await person('b681-c');
    const i3 = uuid(), t3 = fakeToken();
    assert.equal(await r681(C.client, i3, t3, null), 'pending_proof');
    await sql(SUPER, `update private.postona_push_devices set pending_expires_at = now() + interval '2 minutes' where installation_id = '${i3}'`);
    const n3 = await issueNonce(i3);
    assert.equal(await sql(SUPER, `select proof_expires_at > pending_expires_at from private.postona_push_devices where installation_id = '${i3}'`), 't', 'P2-2 (#681): the nonce outlives the pending registration');
    await sql(SUPER, `update private.postona_push_devices set pending_expires_at = now() - interval '1 second' where installation_id = '${i3}'`);
    assert.equal(await r681(C.client, i3, t3, 1, n3), 'registered', 'P2-2 (#681): an expired pending registration is activated');
    const phone = await second(C);
    const i4 = uuid(), t4 = fakeToken();
    assert.equal(await r681(phone, i4, t4, null), 'pending_proof');
    const n4 = await issueNonce(i4);
    await phone.auth.signOut({ scope: 'local' });
    assert.equal(await r681(C.client, i4, t4, 1, n4), 'registered', 'P2-2 (#681): another session activated the nonce of the signed-out one');
    assert.ok((await targets(C)).hashes.includes(await hex(t4)));
    // P2-3 (a) the "off" row pruned, room there: a request made before the "off" (two days ago) is a first registration, active at once
    const D = await person('b681-d');
    const t = fakeToken(), iP = uuid();
    await proven681(D.client, uuid(), t);
    const made = (await nowSec()) - 2 * 86400 - 60;
    assert.equal((clean(await pd681.unregisterPushDevice(D.client, iP, secretOf(iP))) as Answer).status, 'unregistered');
    await sql(SUPER, `update private.postona_push_devices set revoked_at = now() - interval '2 days' where installation_id = '${iP}'`);
    await seedRevoked(D, 98);
    const iX = uuid();
    assert.equal((clean(await pd681.unregisterPushDevice(D.client, iX, secretOf(iX))) as Answer).status, 'unregistered');
    assert.equal(await row(iP), 'none');
    await ageRows(D, 1, [iX]);
    assert.equal(await registerAt(D.client, made, iP, t, null), 'registered', 'P2-3 (#681): a request from before the pruned "off"');
    assert.match(await row(iP), /^active:/u);
    // P2-3 (b) an "off" the cap could not record, then room: the delayed first registration (its JWT predates the "off") is active
    const E = await person('b681-e');
    const te = fakeToken();
    await proven681(E.client, uuid(), te);
    await seedRevoked(E, 99);
    const iF = uuid();
    const off = clean(await pd681.unregisterPushDevice(E.client, iF, secretOf(iF))) as { status: string; recorded?: boolean };
    assert.deepEqual([off.status, off.recorded], ['unregistered', false]);
    await ageRows(E, 2);
    assert.equal(await r681(E.client, iF, te, null), 'registered', 'P2-3 (#681): the first registration made before the unrecorded "off"');
    assert.deepEqual((await targets(E)).hashes, [await hex(te)]);
    assert.match(await row(iF), /^active:/u);
  } finally {
    const s = await psql(OWNER, ['-f', `${PR681}/${STOP}`]);
    assert.ok(s.ok, s.error);
    const r = await psql(OWNER, ['-f', `${PR681}/${ROLLBACK}`]);
    assert.ok(r.ok, r.error);
    await reloadApi('absent');
  }
});

Deno.test({ name: 'push: BEFORE (PR #687 fb75e682, its own install and client): H4 #28 P2 a session refresh alone re-enables a phone whose "off" the cap could not record (the same request content, no explicit "on"; a real GoTrue refresh), and a proven token goes active at once; P3 the only pre-send read (delivery targets) does not answer a pending proof target', ...opts }, async () => {
  await ensureProfile();
  assert.equal(await sql(SUPER, `select to_regclass('private.postona_push_devices') is null`), 't');
  const i687 = await psql(OWNER, ['-f', `${PR687}/${INSTALL}`]);
  assert.ok(i687.ok, i687.error);
  await reloadApi('present');
  const r687 = (c: SupabaseClient, inst: string, t: string, v: number | null, nonce?: string) =>
    (async () => (clean(await pd687.registerPushDevice(c, { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t, expectedVersion: v, ...(nonce ? { proofNonce: nonce } : {}) })) as Answer).status)();
  try {
    const A = await person('b687-a');
    const t = fakeToken();
    const i0 = uuid();
    assert.equal(await r687(A.client, i0, t, null), 'pending_proof');
    assert.equal(await r687(A.client, i0, t, 1, await issueNonce(i0)), 'registered');
    await seedRevoked(A, 99);
    const iF = uuid();
    const off = clean(await pd687.unregisterPushDevice(A.client, iF, secretOf(iF))) as { status: string; recorded?: boolean; fenced?: boolean };
    assert.deepEqual([off.status, off.recorded, off.fenced], ['unregistered', false, true]);
    await ageRows(A, 2);
    assert.equal(await r687(A.client, iF, t, null), 'STALE_REGISTRATION');
    await sleep(1_100);
    assert.ok(!(await A.client.auth.refreshSession()).error);
    assert.equal(await r687(A.client, iF, t, null), 'registered', 'P2 (#687): the same request after a session refresh, no explicit "on"');
    assert.match(await row(iF), /^active:/u);
    assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
    // P3: a pending registration with a live nonce: the delivery targets (the read #687 names for the pre-send check) do not answer it
    const B = await person('b687-b');
    const ip = uuid();
    assert.equal(await r687(B.client, ip, fakeToken(), null), 'pending_proof');
    assert.match(await issueNonce(ip), /^[0-9a-f]{64}$/u);
    assert.deepEqual((await targets(B)).hashes, [], 'P3 (#687): the delivery targets do not see the proof target');
    assert.equal(await sql(SUPER, `select to_regprocedure('private.postona_push_proof_presend(uuid,integer,text)') is null`), 't', 'P3 (#687): no pre-send read for proofs');
  } finally {
    const s = await psql(OWNER, ['-f', `${PR687}/${STOP}`]);
    assert.ok(s.ok, s.error);
    const r = await psql(OWNER, ['-f', `${PR687}/${ROLLBACK}`]);
    assert.ok(r.ok, r.error);
    await reloadApi('absent');
  }
});

Deno.test({ name: 'push: install: refused as a superuser, on a squatted name, a foreign-owned function, a changed gate, or a failing postcondition -- each changing nothing (one transaction: no partial state); then idempotent; the table and the worker side reach no API role; only the three RPCs are definers', ...opts }, async () => {
  await ensureProfile();
  const before = await catalog();
  let r = await runFile(INSTALL, SUPER);
  assert.equal(code(r), 'PUSH_SUPERUSER');
  assert.equal(await catalog(), before);
  r = await runText(installText.replace('066b958a4845941133ea3de12630b955', () => '00000000000000000000000000000000'));
  assert.equal(code(r), 'PUSH_GATE_CHANGED');
  assert.equal(await catalog(), before);
  await sql(OWNER, `create table private.postona_push_devices (x integer)`);
  const squatted = await catalog();
  assert.equal(code(await runFile(INSTALL)), 'PUSH_TAKEN');
  assert.equal(await catalog(), squatted);
  await sql(OWNER, `drop table private.postona_push_devices`);
  // (G5-02 #14) the ON grants' name squatted
  await sql(OWNER, `create table private.postona_push_on_grants (x integer)`);
  const squattedGrants = await catalog();
  assert.equal(code(await runFile(INSTALL)), 'PUSH_TAKEN');
  assert.equal(await catalog(), squattedGrants);
  await sql(OWNER, `drop table private.postona_push_on_grants`);
  await sql(SUPER, `create function public.postona_push_device_list() returns jsonb language sql as $f$ select '{}'::jsonb $f$`);
  const foreign = await catalog();
  assert.equal(code(await runFile(INSTALL)), 'PUSH_TAKEN');
  assert.equal(await catalog(), foreign);
  await sql(SUPER, `drop function public.postona_push_device_list()`);
  // a failure at the very end (an extra function of ours trips the postcondition): the table, the functions, the grants -- all undone
  await sql(OWNER, `create function private.postona_push_zz_extra() returns integer language sql as $f$ select 1 $f$`);
  const extra = await catalog();
  r = await runFile(INSTALL);
  assert.match(code(r), /^PUSH_POSTCONDITION_FUNCTION/u);
  assert.equal(await catalog(), extra);
  assert.equal(await sql(SUPER, `select to_regclass('private.postona_push_devices') is null`), 't');
  await sql(OWNER, `drop function private.postona_push_zz_extra()`);
  assert.equal(await catalog(), before);

  await okFile(INSTALL);
  const once = await catalog();
  await okFile(INSTALL);
  assert.equal(await catalog(), once, 'a re-run changed the catalog');
  await reloadApi('present');
  // the ACL as built: nobody but the owner on the table; authenticated EXECUTEs the three RPCs only; no API role the worker side
  assert.equal(await sql(SUPER, `select string_agg(r.rolname || ':' || has_table_privilege(r.oid, 'private.postona_push_on_grants', 'SELECT,INSERT,UPDATE,DELETE'), ',' order by r.rolname)
    from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')`), 'anon:false,authenticated:false,authenticator:false,service_role:false');
  assert.equal(await sql(SUPER, `select string_agg(r.rolname || ':' || has_table_privilege(r.oid, 'private.postona_push_devices', 'SELECT,INSERT,UPDATE,DELETE'), ',' order by r.rolname)
    from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')`), 'anon:false,authenticated:false,authenticator:false,service_role:false');
  assert.equal(await sql(SUPER, `select string_agg(p.proname || ':' || p.prosecdef || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE') || ':' || has_function_privilege('service_role', p.oid, 'EXECUTE'), ',' order by p.proname)
    from pg_proc p where p.proname like 'postona\\_push\\_%'`),
    'postona_push_claims_session:false:false:false,postona_push_delivery_targets:false:false:false,postona_push_device_enable:true:true:false,postona_push_device_invalidate:false:false:false,'
    + 'postona_push_device_json:false:false:false,postona_push_device_list:true:true:false,postona_push_device_register:true:true:false,'
    + 'postona_push_device_unregister:true:true:false,postona_push_devices_purge:false:false:false,postona_push_lock_key:false:false:false,'
    + 'postona_push_make_room:false:false:false,postona_push_proof_hash:false:false:false,postona_push_proof_issue:false:false:false,postona_push_proof_presend:false:false:false,'
    + 'postona_push_session_live:false:false:false,postona_push_writer_gate:false:false:false');
  const sr = await psql(SUPER, ['-c', `set role service_role; select private.postona_push_delivery_targets(null, null)`]);
  assert.equal(sr.ok, false);
  assert.match(sr.error, /permission denied/u);
  // through the API: anon is refused; the service key may not register (no EXECUTE) and cannot reach the private schema
  const anon = await rawRpc(newClient(), 'postona_push_device_register', { p_installation_id: uuid(), p_platform: 'ios', p_push_token: fakeToken(), p_expected_version: null, p_device_secret: newSecret() });
  assert.ok(anon === 'HTTP:42501' || anon === 'AUTH_REQUIRED', anon);
  const svc = createClient(API, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
  assert.equal(await rawRpc(svc, 'postona_push_device_register', { p_installation_id: uuid(), p_device_secret: newSecret(), p_platform: 'ios', p_push_token: fakeToken(), p_expected_version: null }), 'HTTP:42501');
  assert.equal(await sql(SUPER, `select string_agg(r.rolname || ':' || has_table_privilege(r.oid, 'private.postona_push_control', 'SELECT,INSERT,UPDATE,DELETE'), ',' order by r.rolname)
    from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')`), 'anon:false,authenticated:false,authenticator:false,service_role:false');
  assert.notEqual((await svc.schema('private').rpc('postona_push_delivery_targets', { p_user_id: uuid(), p_brand_id: 'u_x' })).error, null);
});

Deno.test({ name: 'push: H4 #25 P2-2 after: "off" before the first registration is kept (the delayed first registration is STALE, "on" again works); the first registration and "off" at once end off in either order; an old success while "off" is completed as off; rapid toggles from two sessions ending "off" end off', ...opts }, async () => {
  await installed();
  await checks.offBeforeFirstRegistration();
  await checks.firstRegistrationVsOff();
  await checks.oldSuccessKeepsOff();
  await checks.rapidTogglesEndOff();
});

Deno.test({ name: 'push: H4 #26 P2-1 / P2-2 after: an unproven first token is pending (never a target, no claim) until the phone answers the provider nonce; wrong / expired / five wrong answers; a wrong first binding never locks the real phone out; the claim is released when the account is gone; one per-person cap and lock for register and "off" (100 rows, "off" never lost: fail-closed), history pruning; retention purge', ...opts }, async () => {
  await installed();
  await checks.firstTokenNeedsProof();
  await checks.wrongFirstBindingRecovers();
  await checks.claimReleaseOnAccountGone();
  await checks.capacityAtomic();
  await checks.retentionPurge();
});

Deno.test({ name: 'push: H4 #27 P2-1 / P2-2 / P2-3 after: a nonce only for a registration delivery would accept now (owner loss, service end, restart, sign-out: none) under one lock order with the stop and lifecycle changes (skipped, never waiting after the fence); the answer only before the pending registration expires, from its own session and generation, once; "off" outlives the prune, the full cap and a handover (no first registration made before it is accepted; "on" again with a fresh session token works); JWT age', ...opts }, async () => {
  await installed();
  await checks.proofIssueEligibility();
  await checks.proofIssueLockOrder();
  await checks.proofAcceptanceFreshness();
});

Deno.test({ name: 'push: H4 #28 P2 / P3 after: "on" again only by the person\'s explicit, one-time ON grant (pruned "off", unrecorded "off", handover, own "off" row, stop; a real session refresh authorizes nothing; the grant bound to session / installation / secret / generation, spent by its use; "on" and "off" at once end off; 10 live grants); the proof pre-send read answers the token only for the live nonce of a pending registration delivery would accept now', ...opts }, async () => {
  await installed();
  await checks.explicitOnRequired();
  await checks.proofPresend();
});

Deno.test({ name: 'push: register -> list -> token update (compare-and-set) -> the same call again (unchanged) -> replays refused -> unregister (idempotent; the token erased) -> register again; bad input; the device limit; the worker\'s targets follow every step, no answer carries a token', ...opts }, async () => {
  await installed();
  const A = await person('flow');
  const inst = uuid(), t1 = fakeToken(), t2 = fakeToken();
  let a = await reg(A.client, inst, t1, null);
  assert.equal(a.status, 'registered');
  assert.equal(a.device?.registration_version, 1);
  assert.deepEqual(await targets(A), { verdict: 'active', hashes: [await hex(t1)] });
  assert.equal((await reg(A.client, inst, t1, null)).status, 'unchanged', 'a lost answer retried');
  a = await reg(A.client, inst, t2, null);
  assert.equal(a.status, 'STALE_REGISTRATION');
  assert.equal(a.registration_version, 1, 'the person is told their own row\'s version');
  assert.equal((await reg(A.client, inst, t2, 1)).status, 'registered');
  assert.equal((await reg(A.client, inst, t1, 1)).status, 'STALE_REGISTRATION');
  assert.deepEqual(await targets(A), { verdict: 'active', hashes: [await hex(t2)] });
  let l = await list(A.client);
  assert.equal(l.delivery, 'active');
  assert.equal(l.devices.length, 1);
  assert.deepEqual([l.devices[0].installation_id, l.devices[0].status, l.devices[0].registration_version, l.devices[0].deliverable, l.devices[0].this_session], [inst, 'active', 2, true, true]);
  // unregister: idempotent, the token and its hash erased, a replayed update refused
  assert.equal((await unreg(A.client, inst)).status, 'unregistered');
  assert.match(await row(inst), /^revoked:unregistered:3:true:true$/u);
  assert.equal((await unreg(A.client, inst)).status, 'unregistered');
  assert.match(await row(inst), /^revoked:unregistered:3:true:true$/u);
  assert.deepEqual(await targets(A), { verdict: 'active', hashes: [] });
  assert.equal((await reg(A.client, inst, t2, 2)).status, 'STALE_REGISTRATION');
  assert.equal((await reg(A.client, inst, t2, 3)).status, 'registered');
  assert.deepEqual(await targets(A), { verdict: 'active', hashes: [await hex(t2)] });
  // bad input: never echoed
  const sec = secretOf(inst);
  for (const [i, p, t, v, k] of [[inst, 'ios', 'not-a-token', 4, sec], [inst, 'web', fakeToken(), 4, sec], [inst, 'ios', fakeToken(), 0, sec], [inst, 'ios', 'ExponentPushToken[short]', 4, sec],
    [inst, 'ios', fakeToken(), 4, 'short-secret'], [inst, 'ios', fakeToken(), 4, null]] as Array<[string, string, string, number, string | null]>) {
    const raw = await rawRpc(A.client, 'postona_push_device_register', { p_installation_id: i, p_device_secret: k, p_platform: p, p_push_token: t, p_expected_version: v });
    assert.equal(raw, 'INVALID_INPUT');
  }
  assert.equal(await rawRpc(A.client, 'postona_push_device_register', { p_installation_id: null, p_device_secret: sec, p_platform: 'ios', p_push_token: fakeToken(), p_expected_version: null }), 'INVALID_INPUT');
  assert.equal(await rawRpc(A.client, 'postona_push_device_unregister', { p_installation_id: null }), 'INVALID_INPUT');
  // the limit: 10 deliverable devices
  const more: string[] = [];
  for (let i = 0; i < 9; i++) {
    const x = uuid();
    more.push(x);
    assert.equal((await reg(A.client, x, fakeToken(), null, i % 2 ? 'android' : 'ios')).status, 'registered');
  }
  assert.equal((await targets(A)).hashes.length, 10);
  assert.equal((await reg(A.client, uuid(), fakeToken(), null)).status, 'DEVICE_LIMIT');
  assert.equal((await unreg(A.client, more[0])).status, 'unregistered');
  assert.equal((await reg(A.client, uuid(), fakeToken(), null)).status, 'registered');
  l = await list(A.client);
  assert.equal(l.devices.filter((d) => d.status === 'active').length, 10);
  assert.equal(await sql(SUPER, `select count(*) from private.postona_push_devices where user_id = '${A.id}' and status = 'revoked' and (push_token is not null or token_sha256 is not null)`), '0');
});

Deno.test({ name: 'push: isolation and takeover (H4 #24 P2-3 after): another person cannot unregister / list A\'s installation, nor take it over or move its token with a leaked installation id or token; the same phone signed in to another account hands over with the device secret; a token moves only from a registration whose session ended; the person\'s own reinstall moves it', ...opts }, async () => {
  await installed();
  await checks.othersCannotUnregister();
  await checks.othersCannotList();
  await checks.leakedTokenRefused();
  await checks.leakedInstallationRefused();
  await checks.handoverWithDeviceSecret();
  await checks.signedOutTokenStaysWithOwner();
  await checks.secretLossRecovery();
  // another person's version probe tells nothing (no version) and changes nothing; neither does their unregister or list
  const A = await person('iso-a'), B = await person('iso-b');
  const inst = uuid(), ta = fakeToken();
  assert.equal((await reg(A.client, inst, ta, null)).status, 'registered');
  const probe = await reg(B.client, inst, fakeToken(), 1, 'ios', newSecret());
  assert.deepEqual([probe.status, probe.registration_version], ['DEVICE_IN_USE', undefined]);
  assert.deepEqual((await list(B.client)).devices, []);
  assert.equal((await unreg(B.client, inst)).status, 'not_registered');
  assert.equal(await owner(inst), A.id);
  assert.deepEqual((await targets(A)).hashes, [await hex(ta)]);
  // A's own reinstall (a new installation id and secret, the same OS token)
  const i1 = uuid(), i2 = uuid(), t = fakeToken();
  assert.equal((await reg(A.client, i1, t, null)).status, 'registered');
  assert.equal((await reg(A.client, i2, t, null)).status, 'registered');
  assert.match(await row(i1), /^revoked:taken_over:/u);
  assert.equal(await activeFor(t), '1');
  assert.deepEqual((await targets(A)).hashes, [await hex(ta), await hex(t)].sort());
});

Deno.test({ name: 'push: H4 #24 P2-1 / P2-2 after: a registration in flight when the stop commits refuses; a stop waits for a registration holding the fence and erases it; deletion fences an in-flight registration; the fence off stops delivery; a long lock answers PUSH_BUSY in 5 s; the client never re-sends a stale registration over a newer "off" or token', ...opts }, async () => {
  await installed();
  await checks.stopFencesInFlightRegistration();
  await checks.stopWaitsForFenceHolder();
  await checks.deletionFencesInFlight();
  await checks.disabledFlagStopsDelivery();
  await checks.lockTimeoutBusy();
  await checks.clientNeverResendsStale();
});

Deno.test({ name: 'push: session / lifecycle / workspace: an old JWT (signed out) and an expired session are refused; sign-out stops delivery without an unregister; a new session re-binds; service end refuses registration and delivery, unregister and list still work; a restart makes old registrations stale until re-registered; lock, owner loss, a second member, deletion in progress; no workspace; an anonymous sign-in', ...opts }, async () => {
  await installed();
  await checks.signOutStopsDelivery();
  await checks.newSessionRebinds();
  await checks.restartMakesOldStale();
  await checks.ownerLossStopsDelivery();
  await checks.serviceEndRefusesRegister();
  await checks.workspaceGateOnRegister();
  const A = await person('lc');
  const inst = uuid(), t = fakeToken();
  assert.equal((await reg(A.client, inst, t, null)).status, 'registered');
  // the old JWT after sign-out (still within its exp): every RPC refused
  const s2 = await second(A);
  const old = createClient(API, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${A.token}` } } });
  await A.client.auth.signOut({ scope: 'local' });
  A.client = s2;
  assert.equal((await reg(old, inst, t, 1)).status, 'SESSION_REVOKED');
  assert.equal((await unreg(old, inst)).status, 'SESSION_REVOKED');
  assert.equal((await list(old)).status, 'SESSION_REVOKED');
  assert.deepEqual(await targets(A), { verdict: 'active', hashes: [] }, 'the row was bound to the signed-out session');
  assert.equal((await reg(s2, inst, t, 1)).status, 'registered');
  assert.deepEqual(await targets(A), { verdict: 'active', hashes: [await hex(t)] });
  // an expired session
  await sql(SUPER, `update auth.sessions set not_after = now() - interval '1 second' where user_id = '${A.id}'`);
  assert.equal((await reg(s2, inst, t, 2)).status, 'SESSION_EXPIRED');
  assert.deepEqual((await targets(A)).hashes, []);
  await sql(SUPER, `update auth.sessions set not_after = null where user_id = '${A.id}'`);
  assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
  // service end: no registration, no delivery; list and unregister still answer
  await endService(A);
  assert.equal((await reg(s2, uuid(), fakeToken(), null)).status, 'SERVICE_NOT_ACTIVE');
  assert.deepEqual(await targets(A), { verdict: 'SERVICE_NOT_ACTIVE', hashes: [] });
  const l = await list(s2);
  assert.equal(l.delivery, 'SERVICE_NOT_ACTIVE');
  assert.equal(l.devices[0].deliverable, false);
  await restart(A);
  assert.deepEqual(await targets(A), { verdict: 'active', hashes: [] });
  assert.equal((await reg(s2, inst, t, 2)).status, 'registered');
  // lock: refused; unlock bumps the generation again
  await sql(SUPER, `update public.common_accounts set status = 'locked' where user_id = '${A.id}'`);
  assert.equal((await reg(s2, inst, t, 3)).status, 'ACCOUNT_LOCKED');
  assert.deepEqual(await targets(A), { verdict: 'ACCOUNT_LOCKED', hashes: [] });
  assert.equal((await unreg(s2, uuid())).status, 'not_registered', 'unregister still answers while locked');
  await sql(SUPER, `update public.common_accounts set status = 'active' where user_id = '${A.id}'`);
  assert.deepEqual((await targets(A)).hashes, [], 'unlocking is a new generation');
  assert.equal((await reg(s2, inst, t, 3)).status, 'registered');
  // a second member in A's workspace: not A's own personal workspace any more
  const B = await person('lc-b');
  await sql(SUPER, `insert into public.brand_memberships (brand_id, user_id, role) values ('${A.ws}', '${B.id}', 'member')`);
  assert.equal((await targets(A)).verdict, 'OWN_WORKSPACE_CONFLICT');
  assert.deepEqual((await targets(A)).hashes, []);
  assert.equal((await reg(s2, inst, t, 4)).status, 'OWN_WORKSPACE_CONFLICT');
  await sql(SUPER, `delete from public.brand_memberships where brand_id = '${A.ws}' and user_id = '${B.id}'`);
  assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
  // a workspace id that is not the person's: nothing
  assert.deepEqual(await targets(A, B.ws), { verdict: 'NOT_PERSONAL_WORKSPACE', hashes: [] });
  // unregister works after a service end too
  await endService(A);
  assert.equal((await unreg(s2, inst)).status, 'unregistered');
  assert.match(await row(inst), /^revoked:unregistered:/u);
  // deletion in progress
  const D = await person('lc-d');
  assert.equal((await reg(D.client, uuid(), fakeToken(), null)).status, 'registered');
  await sql(SUPER, `update public.common_accounts set status = 'deleting' where user_id = '${D.id}'`);
  assert.deepEqual(await targets(D), { verdict: 'ACCOUNT_DELETION_IN_PROGRESS', hashes: [] });
  assert.equal((await reg(D.client, uuid(), fakeToken(), null)).status, 'ACCOUNT_DELETION_IN_PROGRESS');
  // an anonymous sign-in is not a person
  const anon = newClient();
  assert.ok((await anon.auth.signInAnonymously()).data.session);
  assert.equal((await reg(anon, uuid(), fakeToken(), null)).status, 'AUTH_REQUIRED');
});

Deno.test({ name: 'push: races (live sessions hold the lock, the API calls queue behind it): one installation updated twice from the same version -> exactly one wins; one token from two people -> serialized, one active, no error; register vs service end -> refused; register vs unregister -> the final row is the later one\'s', ...opts }, async () => {
  await installed();
  await checks.sameTokenRace();
  // (a) the same installation, the same expected version, two sessions of the same person
  const A = await person('race');
  const s2 = await second(A);
  const inst = uuid(), t1 = fakeToken(), t2 = fakeToken();
  assert.equal((await reg(A.client, inst, fakeToken(), null)).status, 'registered');
  let holder = new Session('g5pd-holder-acct');
  await holder.send(`begin; select 1 from public.common_accounts where user_id = '${A.id}' for update;`);
  assert.ok(await holding('g5pd-holder-acct'));
  const p1 = reg(A.client, inst, t1, 1), p2 = reg(s2, inst, t2, 1);
  assert.ok(await until(async () => await waitingCalls('postona_push_device_register') === 2));
  await holder.send('commit;');
  assert.ok((await holder.close()).ok);
  const both = await Promise.all([p1, p2]);
  assert.deepEqual(both.map((x) => x.status).sort(), ['STALE_REGISTRATION', 'registered']);
  const winner = both[0].status === 'registered' ? t1 : t2;
  assert.deepEqual((await targets(A)).hashes, [await hex(winner)]);
  assert.match(await row(inst), /^active:-:2:/u);
  // (c) register vs service end: T13 sees the end after the wait
  const iEnd = uuid();
  const gEnd = await grantOf(s2, iEnd);
  holder = new Session('g5pd-holder-end');
  await holder.send(`begin; select 1 from public.common_accounts where user_id = '${A.id}' for update;`);
  assert.ok(await holding('g5pd-holder-end'));
  const pe = reg(s2, iEnd, fakeToken(), null, 'ios', secretOf(iEnd), true, gEnd);
  assert.ok(await until(async () => await waitingCalls('postona_push_device_register') === 1));
  await holder.send(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A.id}' and service_key = 'x_autopost'; commit;`);
  assert.ok((await holder.close()).ok);
  assert.equal((await pe).status, 'SERVICE_NOT_ACTIVE');
  assert.equal(await sql(SUPER, `select count(*) from private.postona_push_devices where user_id = '${A.id}'`), '1');
  await restart(A);
  // (d) register vs unregister of one installation
  assert.equal((await reg(s2, inst, winner, 2)).status, 'registered');
  holder = new Session('g5pd-holder-inst');
  await holder.send(`begin; select pg_advisory_xact_lock(private.postona_push_lock_key('installation', '${inst}'));`);
  assert.ok(await holding('g5pd-holder-inst'));
  // supabase-js sends a request only when it is awaited: start both now
  const pu = (async () => await A.client.rpc('postona_push_device_unregister', { p_installation_id: inst }))();
  const pr = (async () => await A.client.rpc('postona_push_device_register', { p_installation_id: inst, p_device_secret: secretOf(inst), p_platform: 'ios', p_push_token: fakeToken(), p_expected_version: 3 }))();
  assert.ok(await until(async () => (await waitingCalls('postona_push_device_unregister')) + (await waitingCalls('postona_push_device_register')) === 2));
  await holder.send('commit;');
  assert.ok((await holder.close()).ok);
  const [u, r] = await Promise.all([pu, pr]);
  const ua = clean(u.data) as { status: string; device: { registration_version: number } };
  const ra = clean(r.data) as { status: string; device?: { registration_version: number }; registration_version?: number };
  assert.equal(ua.status, 'unregistered');
  const final = await row(inst);
  if (ra.status === 'registered' || ra.status === 'pending_proof') {
    // register first (v4), then unregister (v5)
    assert.deepEqual([ra.device?.registration_version, ua.device.registration_version], [4, 5]);
    assert.match(final, /^revoked:unregistered:5:/u);
  } else {
    // unregister first (v4), then the register's version 3 is stale
    assert.deepEqual([ra.status, ra.registration_version, ua.device.registration_version], ['STALE_REGISTRATION', 4, 4]);
    assert.match(final, /^revoked:unregistered:4:/u);
  }
});

Deno.test({ name: 'push: the worker side: a stale provider receipt never revokes a newer registration; purge erases the tokens of rows that can never deliver again (session ended, older generation, account gone / deleting) and leaves deliverable rows alone', ...opts }, async () => {
  await installed();
  await checks.staleReceiptKeepsNewer();
  const keep = await person('pg-keep');
  const tk = fakeToken(), ik = uuid();
  assert.equal((await reg(keep.client, ik, tk, null)).status, 'registered');
  const so = await person('pg-so');
  const phone = await second(so);
  const iso = uuid();
  assert.equal((await reg(phone, iso, fakeToken(), null)).status, 'registered');
  await phone.auth.signOut({ scope: 'local' });
  const st = await person('pg-st');
  const ist = uuid();
  assert.equal((await reg(st.client, ist, fakeToken(), null)).status, 'registered');
  await endService(st);
  await restart(st);
  const del = await person('pg-del');
  const idel = uuid();
  assert.equal((await reg(del.client, idel, fakeToken(), null)).status, 'registered');
  await sql(SUPER, `update public.common_accounts set status = 'deleting' where user_id = '${del.id}'`);
  const counts = JSON.parse(await sql(OWNER, `select private.postona_push_devices_purge()`)) as Record<string, number>;
  assert.ok(counts.account_gone >= 1 && counts.stale_generation >= 1 && counts.session_ended >= 1, JSON.stringify(counts));
  assert.match(await row(iso), /^revoked:session_ended:2:true:true$/u);
  assert.match(await row(ist), /^revoked:stale_generation:2:true:true$/u);
  assert.match(await row(idel), /^revoked:account_gone:2:true:true$/u);
  assert.match(await row(ik), /^active:-:1:false:false$/u);
  assert.deepEqual((await targets(keep)).hashes, [await hex(tk)]);
  const again = JSON.parse(await sql(OWNER, `select private.postona_push_devices_purge()`)) as Record<string, number>;
  assert.deepEqual(Object.keys(again).sort(), ['account_gone', 'claims_expired', 'claims_released', 'grants_deleted', 'history_deleted', 'proof_expired', 'session_ended', 'stale_generation']);
  assert.deepEqual(Object.values(again).filter((v) => v !== 0), [], JSON.stringify(again));
});

Deno.test({ name: 'push: stop / re-install / rollback: rollback refuses while a device is active and while another function names the worker side; stop erases every token and takes EXECUTE away; the install starts it again; stop + rollback restores the catalog as it was before the install', ...opts }, async () => {
  await installed();
  await checks.rollbackRefusesActive();
  const A = await person('stop');
  const inst = uuid(), t = fakeToken();
  assert.equal((await reg(A.client, inst, t, null)).status, 'registered');
  await okFile(STOP);
  await okFile(STOP);
  assert.equal(await sql(SUPER, `select count(*) from private.postona_push_devices where status = 'active' or push_token is not null or token_sha256 is not null`), '0');
  assert.deepEqual(await targets(A), { verdict: 'PUSH_DEVICES_STOPPED', hashes: [] });
  assert.equal(await rawRpc(A.client, 'postona_push_device_register', { p_installation_id: inst, p_device_secret: secretOf(inst), p_platform: 'ios', p_push_token: t, p_expected_version: 2 }), 'HTTP:42501');
  assert.equal(await rawRpc(A.client, 'postona_push_device_list', {}), 'HTTP:42501');
  await installed();
  assert.equal((await reg(A.client, inst, t, 2)).status, 'registered');
  assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
  // a G3 delivery function that calls the targets: the rollback refuses until it is gone
  await okFile(STOP);
  await sql(OWNER, `create function public.g5pd_g3_worker_probe() returns jsonb language plpgsql as $f$ begin return private.postona_push_delivery_targets(null, null); end $f$`);
  const inUse = await catalog();
  const r = await runFile(ROLLBACK);
  assert.equal(code(r), 'PUSH_IN_USE');
  assert.equal(await catalog(), inUse);
  await sql(OWNER, `drop function public.g5pd_g3_worker_probe()`);
  await okFile(ROLLBACK);
  await okFile(ROLLBACK);
  await reloadApi('absent');
  const without = await catalog();
  await okFile(INSTALL);
  await okFile(STOP);
  await okFile(ROLLBACK);
  assert.equal(await catalog(), without, 'install + stop + rollback left something behind');
  await installed();
});

Deno.test({ name: 'push: nothing reaches a push provider: the test process may not open a connection to Expo / APNs / FCM (deny-net)', ...opts }, async () => {
  for (const host of ['exp.host', 'api.expo.dev', 'api.push.apple.com', 'api.sandbox.push.apple.com', 'fcm.googleapis.com']) {
    assert.notEqual((await Deno.permissions.query({ name: 'net', host })).state, 'granted', host);
  }
  await assert.rejects(fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', body: '[]' }), Deno.errors.NotCapable ?? Deno.errors.PermissionDenied);
});

Deno.test({ name: 'push: mutants: each guard taken out (or weakened) makes its contract check fail -- the tests notice every one', ...opts }, async () => {
  await installed();
  const MUTANTS: Array<[string, string | string[], string | string[], string]> = [
    ['M1 targets ignore the session', `\n       and private.postona_push_session_live(d.session_id, p_user_id)), '[]'::jsonb));`, `), '[]'::jsonb));`, 'signOutStopsDelivery'],
    ['M2 targets ignore the generation', `and d.status = 'active' and d.lifecycle_version = v_lv\n`, `and d.status = 'active'\n`, 'restartMakesOldStale'],
    ['M3 targets ignore MV', `  if v_verdict <> 'active' then\n    return pg_catalog.jsonb_build_object('verdict', v_verdict, 'targets'`, `  if false then\n    return pg_catalog.jsonb_build_object('verdict', v_verdict, 'targets'`, 'ownerLossStopsDelivery'],
    ['M4 no compare-and-set', `    if p_expected_version is distinct from r.registration_version then`, `    if false then`, 'staleReplayRefused'],
    ['M5 no token takeover', `  if v_direct and v_holder is not null then`, `  if false then`, 'signedOutTokenStaysWithOwner'],
    ['M6 no token lock', `  perform pg_catalog.pg_advisory_xact_lock(private.postona_push_lock_key('token', pg_catalog.encode(v_hash, 'hex')));\n`, ``, 'sameTokenRace'],
    ['M7 unregister any installation', `where d.installation_id = p_installation_id and d.user_id = v_user for update;`, `where d.installation_id = p_installation_id for update;`, 'othersCannotUnregister'],
    ['M8 list every row', `from private.postona_push_devices d where d.user_id = v_user), '[]'::jsonb));`, `from private.postona_push_devices d), '[]'::jsonb));`, 'othersCannotList'],
    ['M9 receipt ignores the version', `where d.installation_id = p_installation_id and d.registration_version = p_registration_version and d.status = 'active';`,
      `where d.installation_id = p_installation_id and d.status = 'active';`, 'staleReceiptKeepsNewer'],
    ['M10 no workspace gate', `  return case v_state when 'own' then null when 'absent' then 'WORKSPACE_REQUIRED' else coalesce(v_state, 'OWN_WORKSPACE_CONFLICT') end;`, `  return null;`, 'workspaceGateOnRegister'],
    ['M11 unchanged ignores the session', `     and r.session_id = v_session and r.lifecycle_version = v_lv`, `     and r.lifecycle_version = v_lv`, 'newSessionRebinds'],
    ['M12 no T13', `    perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');`, `    null;`, 'serviceEndRefusesRegister'],
    ['M14 register ignores the stop fence', `before any device row.\n  select c.enabled into v_enabled from private.postona_push_control c where c.id for share;\n  if v_enabled is not true then`,
      `before any device row.\n  select c.enabled into v_enabled from private.postona_push_control c where c.id for share;\n  if false then`, 'stopFencesInFlightRegistration'],
    ['M15 targets ignore the stop fence', `no target for anyone\n  if (select c.enabled from private.postona_push_control c where c.id) is not true then\n    return pg_catalog.jsonb_build_object('verdict', 'PUSH_DEVICES_STOPPED'`,
      `no target for anyone\n  if false then\n    return pg_catalog.jsonb_build_object('verdict', 'PUSH_DEVICES_STOPPED'`, 'disabledFlagStopsDelivery'],
    ['M16 no device-secret check', `  if r.installation_id is not null and r.device_secret_sha256 is distinct from v_secret then`, `  if false then`, 'leakedInstallationRefused'],
    ['M17 every token active at once (no proof)', `  v_direct := v_claim_user is not distinct from v_user or (v_claim_inst is not distinct from p_installation_id and r.installation_id is not null);`, `  v_direct := true;`, 'firstTokenNeedsProof'],
    ['M19 "off" before the first registration keeps nothing', `    if p_device_secret is null or exists (select 1 from private.postona_push_devices d where d.installation_id = p_installation_id) then`, `    if true then`, 'offBeforeFirstRegistration'],
    ['M20 the claim never written', `  insert into private.postona_push_token_claims (token_sha256, user_id, installation_id, updated_at)\n  values (v_hash, v_user, p_installation_id, pg_catalog.clock_timestamp())\n  on conflict (token_sha256) do update set user_id = excluded.user_id, installation_id = excluded.installation_id, updated_at = excluded.updated_at;\n`, ``, 'handoverWithDeviceSecret'],
    ['M21 no handover by the device secret', `(v_claim_inst is not distinct from p_installation_id and r.installation_id is not null)`, `false`, 'handoverWithDeviceSecret'],
    ['M22 purge never releases a claim', `  delete from private.postona_push_token_claims c\n   where not exists`, `  delete from private.postona_push_token_claims c\n   where false and not exists`, 'claimReleaseOnAccountGone'],
    ['M24 targets include pending', `d.workspace_id = p_brand_id and d.status = 'active'`, `d.workspace_id = p_brand_id and d.status in ('active', 'pending')`, 'leakedTokenRefused'],
    ['M25 the nonce unchecked', `    if private.postona_push_proof_hash(p_proof_nonce, r.installation_id, r.session_id, r.lifecycle_version, r.registration_version, r.token_sha256)\n         is distinct from r.proof_sha256 then`, `    if false then`, 'firstTokenNeedsProof'],
    ['M26 the nonce never expires', `    if r.proof_sha256 is null or r.proof_expires_at <= pg_catalog.clock_timestamp() then`, `    if r.proof_sha256 is null then`, 'firstTokenNeedsProof'],
    ['M27 register ignores the cap', `  if (r.installation_id is null or r.user_id is distinct from v_user) and not private.postona_push_make_room(v_user) then`, `  if false then`, 'capacityAtomic'],
    ['M28 "off" without the person\'s lock', `lock_key('user', v_user::text));\n  perform pg_catalog.pg_advisory_xact_lock(private.postona_push_lock_key('installation', p_installation_id::text));\n  delete from private.postona_push_on_grants`,
      `lock_key('user-off', v_user::text));\n  perform pg_catalog.pg_advisory_xact_lock(private.postona_push_lock_key('installation', p_installation_id::text));\n  delete from private.postona_push_on_grants`, 'capacityAtomic'],
    ['M29 room prunes fresh rows', `x.revoked_at < pg_catalog.clock_timestamp() - interval '1 day'`, `true`, 'capacityAtomic'],
    ['M30 history kept forever', `where d.status = 'revoked' and d.revoked_at < pg_catalog.clock_timestamp() - interval '30 days';`, `where false;`, 'retentionPurge'],
    ['M31 claims never expire', `   where c.updated_at < pg_catalog.clock_timestamp() - interval '180 days'`, `   where false and c.updated_at < pg_catalog.clock_timestamp() - interval '180 days'`, 'retentionPurge'],
    ['M18 no lock timeout', [`p_on_grant text default null)\nreturns jsonb language plpgsql volatile security definer set search_path = '' set row_security = off set lock_timeout = '5s' as $$`, `register(uuid,text,text,text,integer,text,text)'::pg_catalog.regprocedure\n                    and 'lock_timeout=5s' = any`],
      [`p_on_grant text default null)\nreturns jsonb language plpgsql volatile security definer set search_path = '' set row_security = off set lock_timeout = '0' as $$`, `register(uuid,text,text,text,integer,text,text)'::pg_catalog.regprocedure\n                    and 'lock_timeout=0' = any`], 'lockTimeoutBusy'],
    // (G5-02 #13)
    ['M32 the issue ignores MV', `         or private.postona_personal_worker_verdict(r.user_id, r.workspace_id, 'x_autopost', v_lv) is distinct from 'active'\n`, ``, 'proofIssueEligibility'],
    ['M33 the issue ignores the generation', `         or v_lv is null or r.lifecycle_version is distinct from v_lv\n`, `         or v_lv is null\n`, 'proofIssueEligibility'],
    ['M34 the issue ignores the session', `         or not private.postona_push_session_live(r.session_id, r.user_id) then`, `         or false then`, 'proofIssueEligibility'],
    ['M35 the issue without the stop fence lock', `where c.id for share;\n  if v_enabled is not true then\n    return v_out;`, `where c.id;\n  if v_enabled is not true then\n    return v_out;`, 'proofIssueLockOrder'],
    ['M36 the issue without the account lock', `      perform 1 from public.common_accounts a where a.user_id = x.user_id for share nowait;\n`, ``, 'proofIssueLockOrder'],
    ['M37 the nonce outlives the pending registration', `least(pg_catalog.clock_timestamp() + interval '10 minutes', d.pending_expires_at)`, `pg_catalog.clock_timestamp() + interval '10 minutes'`, 'proofAcceptanceFreshness'],
    ['M38 the answer ignores the pending expiry', `    if r.pending_expires_at <= pg_catalog.clock_timestamp() then\n      return pg_catalog.jsonb_build_object('status', 'PROOF_EXPIRED');`,
      `    if false then\n      return pg_catalog.jsonb_build_object('status', 'PROOF_EXPIRED');`, 'proofAcceptanceFreshness'],
    ['M39 the answer ignores the session and generation', `    if r.session_id is distinct from v_session or r.lifecycle_version is distinct from v_lv or r.workspace_id is distinct from v_ws then`, `    if false then`, 'proofAcceptanceFreshness'],
    // (G5-02 #14)
    ['M40 no ON grant needed', `  if v_on and (p_on_grant is null or not exists (`, `  if false and (p_on_grant is null or not exists (`, 'explicitOnRequired'],
    ['M41 "off" keeps the ON grant', `  delete from private.postona_push_on_grants g where g.user_id = v_user and g.installation_id = p_installation_id;\n  select * into r`,
      `  select * into r`, 'explicitOnRequired'],
    ['M42 the ON grant reusable', `    delete from private.postona_push_on_grants g where g.user_id = v_user and g.installation_id = p_installation_id;\n  end if;`, `    null;\n  end if;`, 'explicitOnRequired'],
    ['M43 the ON grant ignores the session', `          and g.session_id = v_session and g.lifecycle_version = v_lv and g.expires_at`, `          and g.lifecycle_version = v_lv and g.expires_at`, 'explicitOnRequired'],
    ['M44 the own "off" row needs no ON grant', ` or (r.status = 'revoked' and r.revoked_reason = 'unregistered');`, `;`, 'explicitOnRequired'],
    ['M45 the ON grant ignores the generation', `and g.lifecycle_version = v_lv and g.expires_at`, `and g.expires_at`, 'explicitOnRequired'],
    ['M46 the ON grant ignores the device secret', ` and g.device_secret_sha256 = v_secret\n`, `\n`, 'explicitOnRequired'],
    ['M47 the proof pre-send ignores the stop fence', `  if (select c.enabled from private.postona_push_control c where c.id) is not true then\n    return pg_catalog.jsonb_build_object('verdict', 'PUSH_DEVICES_STOPPED');\n  end if;\n  select * into r`,
      `  select * into r`, 'proofPresend'],
    ['M48 the proof pre-send ignores the nonce', `       is distinct from r.proof_sha256 then\n    return pg_catalog.jsonb_build_object('verdict', 'PROOF_INVALID');`, `       is distinct from r.proof_sha256 and false then\n    return pg_catalog.jsonb_build_object('verdict', 'PROOF_INVALID');`, 'proofPresend'],
    ['M49 the proof pre-send ignores the pending expiry', `  if r.pending_expires_at <= pg_catalog.clock_timestamp() or r.proof_sha256 is null`, `  if r.proof_sha256 is null`, 'proofPresend'],
    ['M50 the proof pre-send ignores the session', `    return pg_catalog.jsonb_build_object('verdict', 'SESSION_ENDED');`, `    null;`, 'proofPresend'],
    ['M51 the proof pre-send ignores MV', `  if v_verdict <> 'active' then\n    return pg_catalog.jsonb_build_object('verdict', v_verdict);\n  end if;\n  return pg_catalog.jsonb_build_object('verdict', 'send'`,
      `  return pg_catalog.jsonb_build_object('verdict', 'send'`, 'proofPresend'],
  ];
  const results: string[] = [];
  const swap = async (text: string) => {
    if (await sql(SUPER, `select to_regclass('private.postona_push_devices') is not null`) === 't') {
      await okFile(STOP);
      await okFile(ROLLBACK);
    }
    const r = await runText(text);
    assert.ok(r.ok, r.error);
    currentInstall = text;
    await reloadApi('present');
  };
  try {
    for (const [name, fromAny, toAny, check] of MUTANTS) {
      const froms = Array.isArray(fromAny) ? fromAny : [fromAny];
      const tos = Array.isArray(toAny) ? toAny : [toAny];
      let text = installText;
      froms.forEach((from, i) => {
        assert.equal(text.split(from).length, 2, `${name}: the text to mutate is not there exactly once`);
        text = text.replace(from, () => tos[i]);
      });
      await swap(text);
      let killed = false;
      try {
        await checks[check]();
      } catch {
        killed = true;
      }
      await endHolders();
      results.push(`${name}: ${killed ? 'killed' : 'SURVIVED'}`);
    }
    // the rollback without its active-device refusal
    await swap(installText);
    const from = `    if exists (select 1 from private.postona_push_devices d where d.status in ('active', 'pending')) then`;
    assert.equal(rollbackText.split(from).length, 2);
    currentRollback = rollbackText.replace(from, () => '    if false then');
    let killed = false;
    try {
      await checks.rollbackRefusesActive();
    } catch {
      killed = true;
    }
    results.push(`M13 rollback drops active devices: ${killed ? 'killed' : 'SURVIVED'}`);
    // (G5-02 #11) the client without its "off after any answer" check: loaded from the mutated text
    const cfrom = `  return keepOffAfter(client, readCurrent, await registerPushDevice(client, s));`;
    assert.equal(clientText.split(cfrom).length, 2);
    pc = await import(`data:application/typescript;base64,${btoa(clientText.replace(cfrom, () => '  return registerPushDevice(client, s);'))}`);
    killed = false;
    try {
      await checks.oldSuccessKeepsOff();
    } catch {
      killed = true;
    }
    pc = pd;
    results.push(`M23 client reports an old success while off: ${killed ? 'killed' : 'SURVIVED'}`);
  } finally {
    pc = pd;
    currentRollback = rollbackText;
    await swap(installText);
    currentInstall = installText;
  }
  console.log(results.join('\n'));
  assert.equal(results.filter((x) => x.endsWith('killed')).length, MUTANTS.length + 2, results.join('\n'));
});

Deno.test({ name: 'push: every contract check passes on the candidate as written (the mutants\' targets, run straight)', ...opts }, async () => {
  await installed();
  for (const [name, check] of Object.entries(checks)) {
    try {
      await check();
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  }
});
