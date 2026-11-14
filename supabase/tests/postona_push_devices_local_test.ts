// G5-02 task 9: POSTONA push devices (supabase/candidates/postona_push_devices) on the REAL local Supabase runtime, run by
// postona_personal_workspace_local_run.sh after the workspace and media box suites: GoTrue ES256 JWTs and real sessions (sign-out deletes
// the session row), PostgREST, Kong, PG 17.6.1.165. The person's calls go through the G5-owned client module (client.ts) over supabase-js
// 2.115.0, as G1 will make them; the worker side is called as the lifecycle owner, as a G3 delivery function owned by it would.
// No push is sent: every token is a fake made here at run time ("ExponentPushToken[g5ptok...]"); no test prints one (only SHA-256 hashes are
// compared) and the runner scans every container log for the marker afterwards. Network: only the local API port (the runner's --allow-net).
// G5-02 task 10: H4 #331 task 24's three P2 are first reproduced on PR #667's own files (G5LS_PR667: install / stop / rollback / client.ts
// at 9140cefd), then the same cases pass on this tree's.
import assert from 'node:assert/strict';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0';

const API = Deno.env.get('G5LS_API') ?? '';
const PUBLISHABLE = Deno.env.get('G5LS_PUBLISHABLE') ?? '';
const SECRET = Deno.env.get('G5LS_SECRET') ?? '';
const DB_PORT = Deno.env.get('G5LS_DB_PORT') ?? '';
const MVP = Deno.env.get('G5LS_MVP') ?? '';
const PUSH = Deno.env.get('G5LS_PUSH') ?? '';
const PR667 = Deno.env.get('G5LS_PR667') ?? '';
const enabled = API !== '' && PUBLISHABLE !== '' && SECRET !== '' && MVP !== '' && PUSH !== '' && DB_PORT !== '' && PR667 !== '';
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };
const OWNER = 'postgres';
const SUPER = 'supabase_admin';
const INSTALL = '001_push_devices.sql';
const STOP = '001_push_devices_stop.sql';
const ROLLBACK = '001_push_devices_rollback.sql';
const decoder = new TextDecoder();
const pd = enabled ? await import(`file://${PUSH}/client.ts`) : null;
const pd667 = enabled ? await import(`file://${PR667}/client.ts`) : null;
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
const holding = (name: string) => until(async () => (await sql(SUPER, `select coalesce(string_agg(state, ','), 'gone') from pg_stat_activity where application_name = '${name}'`)) === 'idle in transaction');
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
  return btoa(String.fromCharCode(...b)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
const secrets = new Map<string, string>();
const secretOf = (inst: string) => { if (!secrets.has(inst)) secrets.set(inst, newSecret()); return secrets.get(inst) as string; };
// every answer the app gets: never a token (the marker), never a hash
function clean<T>(x: T): T {
  const s = JSON.stringify(x);
  assert.ok(!s.includes('g5ptok') && !s.includes('PushToken'), 'an answer carried a token');
  return x;
}
type Answer = { ok: boolean; status: string; device?: { registration_version: number; status: string; deliverable: boolean; this_session: boolean }; registration_version?: number | null };
const reg = async (c: SupabaseClient, inst: string, token: string, expected: number | null, platform = 'ios', secret = secretOf(inst)) =>
  clean(await pd.registerPushDevice(c, { installationId: inst, deviceSecret: secret, platform, pushToken: token, expectedVersion: expected })) as Answer;
// PR #667's register (no device secret) through PR #667's client
const reg667 = async (c: SupabaseClient, inst: string, token: string, expected: number | null) =>
  clean(await pd667.registerPushDevice(c, { installationId: inst, platform: 'ios', pushToken: token, expectedVersion: expected })) as Answer;
async function restartPush() {
  const r = await runText(currentInstall);
  assert.ok(r.ok, r.error);
  await reloadApi('present');
}
const unreg = async (c: SupabaseClient, inst: string) => clean(await pd.unregisterPushDevice(c, inst)) as Answer;
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
    assert.equal((await reg(B.client, iB, t, null)).status, 'DEVICE_IN_USE');
    assert.match(await row(iA), /^active:-:1:false:false$/u);
    assert.equal(await row(iB), 'none');
    assert.deepEqual((await targets(A)).hashes, [await hex(t)]);
    assert.deepEqual((await targets(B)).hashes, []);
    // still live while the session is (a restart makes the generation stale, not the phone free)
    await endService(A);
    await restart(A);
    assert.equal((await reg(B.client, iB, t, null)).status, 'DEVICE_IN_USE');
    assert.equal(await activeFor(t), '1');
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
  // the same phone signed in to another account (A never signed out there): the device secret proves the phone, so B takes it over
  async handoverWithDeviceSecret() {
    const A = await person('ho-a'), B = await person('ho-b');
    const inst = uuid(), t = fakeToken();
    assert.equal((await reg(A.client, inst, t, null)).status, 'registered');
    assert.equal((await reg(B.client, inst, t, null)).status, 'registered');
    assert.equal(await owner(inst), B.id);
    assert.deepEqual((await targets(A)).hashes, []);
    assert.deepEqual((await targets(B)).hashes, [await hex(t)]);
    assert.equal(await activeFor(t), '1');
  },
  // a token moves from a registration whose session has ended (the phone signed out, then another account on a reinstalled app)
  async tokenMovesAfterSignOut() {
    const A = await person('tm-a'), B = await person('tm-b');
    const phone = await second(A);
    const iA = uuid(), iB = uuid(), t = fakeToken();
    assert.equal((await reg(phone, iA, t, null)).status, 'registered');
    await phone.auth.signOut({ scope: 'local' });
    assert.equal((await reg(B.client, iB, t, null)).status, 'registered');
    assert.match(await row(iA), /^revoked:taken_over:2:true:true$/u);
    assert.deepEqual((await targets(A)).hashes, []);
    assert.deepEqual((await targets(B)).hashes, [await hex(t)]);
    assert.equal(await activeFor(t), '1');
    // and the person's own reinstall (a new installation, the same OS token) always moves it
    const iB2 = uuid();
    assert.equal((await reg(B.client, iB2, t, null)).status, 'registered');
    assert.match(await row(iB), /^revoked:taken_over:/u);
    assert.equal(await activeFor(t), '1');
  },
  // two registrations of one token at once (A on a new installation, B on its existing one): serialized; B (first) holds it, A is refused
  // (B's registration is live), exactly one active, no error
  async sameTokenRace() {
    const A = await person('rc-a'), B = await person('rc-b');
    const iA = uuid(), iB = uuid(), t = fakeToken();
    assert.equal((await reg(B.client, iB, fakeToken(), null)).status, 'registered');
    const holder = new Session('g5pd-holder-token');
    await holder.send(`begin; select 1 from private.postona_push_devices where installation_id = '${iB}' for update;`);
    assert.ok(await holding('g5pd-holder-token'));
    const pB = reg(B.client, iB, t, 1);
    assert.ok(await until(async () => await waitingCalls('postona_push_device_register') === 1), 'B did not queue behind the row lock');
    let aDone = false;
    const pA = reg(A.client, iA, t, null).finally(() => { aDone = true; });
    await until(async () => aDone || await waitingCalls('postona_push_device_register') === 2, 5_000);
    await holder.send('commit;');
    assert.ok((await holder.close()).ok);
    const [rB, rA] = await Promise.all([pB, pA]);
    assert.equal(rB.status, 'registered', `B: ${rB.status}`);
    assert.equal(rA.status, 'DEVICE_IN_USE', `A: ${rA.status}`);
    assert.equal(await activeFor(t), '1');
    assert.match(await row(iB), /^active:-:2:/u, 'B registered first (it held the token); A may not take it from a live registration');
    assert.deepEqual((await targets(A)).hashes, []);
    assert.deepEqual((await targets(B)).hashes, [await hex(t)]);
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
    const holder = new Session('g5pd-holder-sf');
    await holder.send(`begin; select 1 from public.common_accounts where user_id = '${A.id}' for update;`);
    assert.ok(await holding('g5pd-holder-sf'));
    const pR = reg(A.client, inst, t, null);
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
    const pR = reg(A.client, inst, t, null);
    assert.ok(await until(async () => await waitingCalls('postona_push_device_register') === 1));
    const pS = runFile(STOP);
    assert.ok(await until(async () => await waitingStop() === 1), 'the stop did not wait for the registration holding the fence');
    await holder.send('commit;');
    assert.ok((await holder.close()).ok);
    const [r, stop] = await Promise.all([pR, pS]);
    try {
      assert.ok(stop.ok, stop.error);
      assert.equal(r.status, 'registered');
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
    const holder = new Session('g5pd-holder-df');
    await holder.send(`begin; select 1 from public.common_accounts where user_id = '${A.id}' for update;`);
    assert.ok(await holding('g5pd-holder-df'));
    const pR = reg(A.client, uuid(), fakeToken(), null);
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
    const holder = new Session('g5pd-holder-lk');
    await holder.send(`begin; select 1 from private.postona_push_control c where c.id for update;`);
    assert.ok(await holding('g5pd-holder-lk'));
    const release = sleep(7_000).then(async () => { await holder.send('commit;'); return holder.close(); });
    const t0 = Date.now();
    const r = await reg(A.client, inst, fakeToken(), null);
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
    const state = { installationId: inst, deviceSecret: secretOf(inst), platform: 'ios', pushToken: t1, expectedVersion: null as number | null, notificationsEnabled: true };
    const now = () => Promise.resolve({ ...state });
    const first = clean(await pd.syncPushDevice(A.client, now)) as Answer;
    assert.equal(first.status, 'registered');
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
    assert.equal((await unreg(B.client, inst)).status, 'unregistered');
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
  assert.equal(await sql(SUPER, `select string_agg(r.rolname || ':' || has_table_privilege(r.oid, 'private.postona_push_devices', 'SELECT,INSERT,UPDATE,DELETE'), ',' order by r.rolname)
    from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')`), 'anon:false,authenticated:false,authenticator:false,service_role:false');
  assert.equal(await sql(SUPER, `select string_agg(p.proname || ':' || p.prosecdef || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE') || ':' || has_function_privilege('service_role', p.oid, 'EXECUTE'), ',' order by p.proname)
    from pg_proc p where p.proname like 'postona\\_push\\_%'`),
    'postona_push_claims_session:false:false:false,postona_push_delivery_targets:false:false:false,postona_push_device_invalidate:false:false:false,'
    + 'postona_push_device_json:false:false:false,postona_push_device_list:true:true:false,postona_push_device_register:true:true:false,'
    + 'postona_push_device_unregister:true:true:false,postona_push_devices_purge:false:false:false,postona_push_lock_key:false:false:false,'
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
  await checks.tokenMovesAfterSignOut();
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
  holder = new Session('g5pd-holder-end');
  await holder.send(`begin; select 1 from public.common_accounts where user_id = '${A.id}' for update;`);
  assert.ok(await holding('g5pd-holder-end'));
  const pe = reg(s2, uuid(), fakeToken(), null);
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
  if (ra.status === 'registered') {
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
  assert.equal(await sql(OWNER, `select private.postona_push_devices_purge()::text`), '{"account_gone": 0, "session_ended": 0, "stale_generation": 0}');
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
    ['M3 targets ignore MV', `  if v_verdict <> 'active' then`, `  if false then`, 'ownerLossStopsDelivery'],
    ['M4 no compare-and-set', `    if p_expected_version is distinct from r.registration_version then`, `    if false then`, 'staleReplayRefused'],
    ['M5 no token takeover', `  if v_holder is not null then\n    update`, `  if false then\n    update`, 'tokenMovesAfterSignOut'],
    ['M6 no token lock', `  perform pg_catalog.pg_advisory_xact_lock(private.postona_push_lock_key('token', pg_catalog.encode(v_hash, 'hex')));\n`, ``, 'sameTokenRace'],
    ['M7 unregister any installation', `where d.installation_id = p_installation_id and d.user_id = v_user for update;`, `where d.installation_id = p_installation_id for update;`, 'othersCannotUnregister'],
    ['M8 list every row', `from private.postona_push_devices d where d.user_id = v_user), '[]'::jsonb));`, `from private.postona_push_devices d), '[]'::jsonb));`, 'othersCannotList'],
    ['M9 receipt ignores the version', `where d.installation_id = p_installation_id and d.registration_version = p_registration_version and d.status = 'active';`,
      `where d.installation_id = p_installation_id and d.status = 'active';`, 'staleReceiptKeepsNewer'],
    ['M10 no workspace gate', `  return case v_state when 'own' then null when 'absent' then 'WORKSPACE_REQUIRED' else coalesce(v_state, 'OWN_WORKSPACE_CONFLICT') end;`, `  return null;`, 'workspaceGateOnRegister'],
    ['M11 unchanged ignores the session', ` and r.session_id = v_session\n`, `\n`, 'newSessionRebinds'],
    ['M12 no T13', `    perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');`, `    null;`, 'serviceEndRefusesRegister'],
    ['M14 register ignores the stop fence', `  if v_enabled is not true then\n    return pg_catalog.jsonb_build_object('status', 'PUSH_DEVICES_STOPPED');`,
      `  if false then\n    return pg_catalog.jsonb_build_object('status', 'PUSH_DEVICES_STOPPED');`, 'stopFencesInFlightRegistration'],
    ['M15 targets ignore the stop fence', `  if (select c.enabled from private.postona_push_control c where c.id) is not true then\n    return pg_catalog.jsonb_build_object('verdict', 'PUSH_DEVICES_STOPPED'`,
      `  if false then\n    return pg_catalog.jsonb_build_object('verdict', 'PUSH_DEVICES_STOPPED'`, 'disabledFlagStopsDelivery'],
    ['M16 no device-secret check', `  if r.installation_id is not null and r.device_secret_sha256 is distinct from v_secret then`, `  if false then`, 'leakedInstallationRefused'],
    ['M17 a live holder gives its token up', `  if v_holder is not null and v_holder_user is distinct from v_user and v_holder_live then`, `  if false then`, 'leakedTokenRefused'],
    ['M18 no lock timeout', [`set row_security = off set lock_timeout = '5s' as $$`, `'lock_timeout=5s' = any`], [`set row_security = off set lock_timeout = '0' as $$`, `'lock_timeout=0' = any`], 'lockTimeoutBusy'],
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
      results.push(`${name}: ${killed ? 'killed' : 'SURVIVED'}`);
    }
    // the rollback without its active-device refusal
    await swap(installText);
    const from = `    if exists (select 1 from private.postona_push_devices d where d.status = 'active') then`;
    assert.equal(rollbackText.split(from).length, 2);
    currentRollback = rollbackText.replace(from, () => '    if false then');
    let killed = false;
    try {
      await checks.rollbackRefusesActive();
    } catch {
      killed = true;
    }
    results.push(`M13 rollback drops active devices: ${killed ? 'killed' : 'SURVIVED'}`);
  } finally {
    currentRollback = rollbackText;
    await swap(installText);
    currentInstall = installText;
  }
  console.log(results.join('\n'));
  assert.equal(results.filter((x) => x.endsWith('killed')).length, MUTANTS.length + 1, results.join('\n'));
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
