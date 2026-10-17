// Phase 13 D-2 (F5): the POSTONA service-exit path with the X saga STAND-IN, END TO END on a local PostgreSQL 17:
//
//   REAL account-delete handler (createHandler)  ->  fake network  ->  { Data API = psql as service_role (REAL Phase 1..10 SQL) |
//                                                                         Auth stand-ins | the X saga STAND-IN (simulated) }
//
// The stand-in replaces F3's saga AND its acknowledgement RPC at the harness' network boundary; F3's SQL and code are not part of
// this run, nothing of F3 is touched. Every outcome that depends on the stand-in is asserted with a [SIMULATED X] label: a PASS here is
// not a real revoke, purge, Vault read, OAuth call or managed M12. Fake data only; needs CAL_E2E=1 and PGHOST / PGPORT / PGUSER / PGDATABASE
// (common_account_phase13_d2_standin_run.sh sets them).
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler } from '../functions/account-delete/http.ts';
import { providerRegistration } from '../functions/account-delete/provider_registry.ts';
import { ackResponder, assertSimulated, REPORT_BANNER, simulated, simulatedReport, sagaResponder } from '../preflight/managed_disposable/x_saga_standin/harness.ts';
import { createXSagaStandIn, disabledStandIn, standInSnapshot, type StandInConfig, type StandInStep, type XSagaStandIn } from '../preflight/managed_disposable/x_saga_standin/standin.ts';
import { withTripwires } from '../preflight/managed_disposable/x_saga_standin/tripwire.ts';

const enabled = Deno.env.get('CAL_E2E') === '1';
const db = Deno.env.get('PGDATABASE') ?? '';
const decoder = new TextDecoder();
const URL_BASE = 'https://p13d2.supabase.invalid';
const KEYS = { anon: 'anon-stand-in', service: 'service-stand-in' };
const env = { get: (name: string) => ({ SUPABASE_URL: URL_BASE, SUPABASE_ANON_KEY: KEYS.anon, SUPABASE_SERVICE_ROLE_KEY: KEYS.service } as Record<string, string>)[name] };
const ACK_FUNCTION = 'social_mobile_account_deletion_x_unconfirmed_ack';
if (enabled && !db) throw new Error('PGDATABASE is required');

// ---- psql --------------------------------------------------------------------------------------------------------------------
async function psql(statement: string): Promise<{ ok: boolean; out: string; error: string }> {
  const out = await new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement],
    env: { PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: Deno.env.get('PGUSER') ?? '', PGDATABASE: db, LC_ALL: 'C' },
    clearEnv: true, stdout: 'piped', stderr: 'piped',
  }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
async function sql(statement: string): Promise<string> {
  const r = await psql(statement);
  if (!r.ok) throw new Error(r.error);
  return r.out;
}
const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
function lit(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) return `array[${value.map(q).join(',')}]::text[]`;
  if (typeof value === 'object') return `${q(JSON.stringify(value))}::jsonb`;
  return q(String(value));
}
let voidNames: Set<string> | null = null;
async function isVoid(fn: string) {
  voidNames ??= new Set((await sql(`select proname from pg_proc where prorettype = 'void'::regtype and pronamespace = 'public'::regnamespace`)).split('\n'));
  return voidNames.has(fn);
}

// ---- the stand-in's database observer: the stand-in call changes NOTHING of the X side ------------------------------------------------
const X_SIDE_TABLES = [
  'public.social_accounts', 'public.brands', 'public.brand_memberships', 'public.scheduled_posts', 'public.post_execution_logs', 'public.publish_claims',
  'public.social_account_oauth_states', 'public.social_mobile_account_deletions', 'public.x_account_refresh_state_v2', 'vault.secrets',
];
const xSideSnapshot = () => sql(`select md5(concat_ws('|', ${X_SIDE_TABLES.map((t) => `(select count(*)::text || coalesce(md5(string_agg(x::text, ',' order by x::text)), '') from ${t} x)`).join(', ')}))`);

// ---- the fake network ------------------------------------------------------------------------------------------------------------------
type Net = {
  users: Set<string>;
  requests: { method: string; path: string }[];
  unrouted: string[];
  rpcCalls: string[];
  /** every stand-in `run` is bracketed by an X-side snapshot; a difference is recorded here */
  observerFailures: string[];
  observed: number;
};
function makeNet(standIn: XSagaStandIn) {
  const net: Net = { users: new Set(), requests: [], unrouted: [], rpcCalls: [], observerFailures: [], observed: 0 };
  const around = async <T>(run: () => Promise<T>): Promise<T> => {
    const before = await xSideSnapshot();
    const result = await run();
    const after = await xSideSnapshot();
    net.observed += 1;
    if (before !== after) net.observerFailures.push('the X side of the synthetic database changed during a stand-in call');
    return result;
  };
  const saga = sagaResponder(standIn, around);
  const ack = ackResponder(standIn);
  const claimsOf = (header: string | null) => {
    try {
      return JSON.parse(atob((header?.replace(/^Bearer\s+/iu, '') ?? '').split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as { sub?: string };
    } catch {
      return {};
    }
  };
  const network = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    net.requests.push({ method: init?.method ?? 'GET', path: `${url.origin}${url.pathname}` });
    if (url.origin !== URL_BASE) {
      net.unrouted.push(input);
      return new Response('{}', { status: 404 });
    }
    const path = url.pathname;
    if (path === '/auth/v1/user') {
      const sub = claimsOf(headers.get('Authorization')).sub;
      if (!sub || !net.users.has(sub)) return new Response('{}', { status: 401 });
      return Response.json({ id: sub, identities: [{ provider: 'email', id: sub }] });
    }
    if (path.startsWith('/rest/v1/rpc/')) {
      if (headers.get('apikey') !== KEYS.service || headers.get('Authorization') !== `Bearer ${KEYS.service}`) return Response.json({ message: 'invalid credential' }, { status: 401 });
      const fn = path.slice('/rest/v1/rpc/'.length);
      net.rpcCalls.push(fn);
      const args = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (fn === ACK_FUNCTION) return await ack(args);   // F3's acknowledgement RPC: answered by the stand-in, never by the database
      const named = Object.entries(args).map(([key, value]) => `${key} => ${lit(value)}`).join(', ');
      const call = `public.${fn}(${named})`;
      const text = (await isVoid(fn)) ? `(select count(*) from (select ${call}) x)::text` : `to_jsonb(${call})::text`;
      const r = await psql(`begin; set local role service_role; select ${text}; commit;`);
      if (!r.ok) {
        const message = /ERROR:\s+(.*)/u.exec(r.error)?.[1] ?? 'error';
        return Response.json({ message }, { status: /permission denied/u.test(message) ? 403 : /does not exist/u.test(message) ? 404 : 400 });
      }
      return new Response((await isVoid(fn)) || r.out === '' ? 'null' : r.out, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/functions/v1/social-mobile-account-delete') return await saga(new Request(input, { method: 'POST', headers, body: String(init?.body ?? '') }));
    net.unrouted.push(input);
    return new Response('{}', { status: 404 });
  };
  const handler = createHandler(env, network, providerRegistration);
  return { net, handler };
}

// ---- people -------------------------------------------------------------------------------------------------------------------------------
let counter = 0;
const newUser = () => `00000000-0000-4000-8000-${String(950_100 + ++counter).padStart(12, '0')}`;
const tokenOf = (user: string) => {
  const b64 = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: user, session_id: `session-${user.slice(-6)}`, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 30 }] })}.sig`;
};
const asPerson = (user: string, statement: string) =>
  `begin; set local request.jwt.claim.sub = '${user}'; set local request.jwt.claim.role = 'authenticated'; set local role authenticated; ${statement}; commit;`;
type Person = { user: string; workspace: string };
/** A POSTONA person. `kabumori`: a Kabumori entitlement and profile; `xFootprint`: an X workspace (fixture) the stand-in cannot remove; `threads`: a Threads account. */
async function person(net: Net, options: { kabumori?: boolean; xFootprint?: boolean; threads?: boolean; tag: string }): Promise<Person> {
  const user = newUser();
  net.users.add(user);
  const workspace = await sql(`select public.social_mobile_account_deletion_workspace('${user}'::uuid)`);
  if (options.xFootprint) await sql(`select public.fixture_user_with_workspace('${user}'::uuid, ${q(options.tag)})`);
  else await sql(`insert into auth.users (id) values ('${user}'::uuid) on conflict do nothing`);
  assert.equal(JSON.parse(await sql(asPerson(user, 'select to_jsonb(public.start_x_autopost_service())'))).status, 'active');
  if (options.kabumori) {
    assert.equal(JSON.parse(await sql(asPerson(user, 'select to_jsonb(public.start_kabumori_service())'))).status, 'active');
    await sql(`insert into public.profiles (id) values ('${user}'::uuid) on conflict do nothing`);
  }
  if (options.threads) {
    await sql(`alter table public.social_accounts drop constraint if exists social_accounts_platform_check`);   // the synthetic world models the multi-provider migration
    await sql(`insert into public.social_accounts (id, brand_id, platform) values (${q(`sa_th_${user.slice(-6)}`)}, ${q(workspace)}, 'threads')`);
  }
  return { user, workspace };
}

// ---- observations -----------------------------------------------------------------------------------------------------------------------------
const entitlement = (user: string, service = 'x_autopost') =>
  sql(`select coalesce((select status from public.service_entitlements where user_id = '${user}'::uuid and service_key = '${service}'), 'none')`);
const lifecycleVersion = (user: string) => sql(`select lifecycle_version from public.common_accounts where user_id = '${user}'::uuid`);
type OpView = { status: string; leased: boolean; fence: number; results: Record<string, string>; reconciliation: { x_posts_unconfirmed?: number; x_unconfirmed_snapshots?: string[] } } | null;
const operation = async (user: string): Promise<OpView> =>
  JSON.parse(await sql(`select coalesce((select jsonb_build_object('status', status, 'leased', owner_lease is not null and owner_lease_expires_at > clock_timestamp(),
      'fence', owner_fence, 'results', provider_results, 'reconciliation', reconciliation)
      from private.account_lifecycle_operations where user_id = '${user}'::uuid and operation_type = 'service_deletion' and service_key = 'x_autopost'
      order by updated_at desc limit 1), 'null'::jsonb)`));
const completions = (user: string) => sql(`select count(*) from private.account_lifecycle_operations where user_id = '${user}'::uuid and operation_type = 'service_deletion' and status = 'completed'`).then(Number);
const expireServiceLease = (user: string) =>
  sql(`update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 second'
        where user_id = '${user}'::uuid and operation_type = 'service_deletion' and status = 'in_progress'`);
const hasLogin = (user: string) => sql(`select exists (select 1 from auth.users where id = '${user}'::uuid)`).then((v) => v === 't');
const hasProfile = (user: string) => sql(`select exists (select 1 from public.profiles where id = '${user}'::uuid)`).then((v) => v === 't');

const END = { action: 'withdraw_postona', confirmation: 'END_POSTONA_SERVICE' };
type Harness = ReturnType<typeof makeNet> & { standIn: XSagaStandIn };
function harness(script: StandInStep[], options: { standIn?: Partial<StandInConfig>; disabled?: boolean } = {}): Harness {
  const standIn = options.disabled
    ? disabledStandIn()
    : createXSagaStandIn({
      armed: true, script,
      persons: { hasKabumoriProfile: async (user) => (await sql(`select exists (select 1 from public.profiles where id = '${user}'::uuid)`)) === 't' },
      ...options.standIn,
    });
  return { ...makeNet(standIn), standIn };
}
async function request(h: Harness, user: string, body: Record<string, unknown>) {
  const response = await h.handler(new Request(`${URL_BASE}/functions/v1/account-delete`, {
    method: 'POST', headers: { authorization: `Bearer ${tokenOf(user)}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
/** One request with the tripwires armed (psql is the only subprocess; the network, secrets and every other way out are armed against). */
async function call(h: Harness, user: string, body: Record<string, unknown> = END) {
  const { result, hits } = await withTripwires(() => request(h, user, body));
  assert.deepEqual(hits, [], 'no tripwire fired during the request');
  return result;
}
const error = (r: { body: Record<string, unknown> }): string | null => (r.body.ok ? null : String(r.body.error));
const runs = (h: Harness) => h.standIn.records.filter((r) => r.call === 'run').length;
const acks = (h: Harness) => h.standIn.records.filter((r) => r.call === 'ack').map((r) => r.answered);
/** The attestation every test ends with: nothing left the synthetic world, the stand-in changed nothing, every record is simulated. */
function attest(h: Harness, label: string) {
  assert.deepEqual(h.net.unrouted, [], simulated(`${label}: no request outside the synthetic network`));
  assert.ok(h.net.requests.every((r) => r.path.startsWith(URL_BASE)), simulated(`${label}: every request stayed on the synthetic origin`));
  assert.ok(!h.net.requests.some((r) => /x\.com|twitter|threads|meta|facebook|openai|anthropic|smtp|mail/iu.test(r.path)), simulated(`${label}: no X, Threads, Meta, AI or mail endpoint was addressed`));
  assert.deepEqual(h.net.observerFailures, [], simulated(`${label}: the X side of the database did not change during any stand-in call`));
  assertSimulated(h.standIn.records);
  assert.equal(simulatedReport(h.standIn.records)[0], REPORT_BANNER);
}

test('POSTONA-only person (no Kabumori profile): the real database says R2\', the end is refused before anything changes, the saga is never run', { skip: !enabled }, async () => {
  const h = harness([{ scenario: 'clean' }]);
  const p = await person(h.net, { tag: 'a1' });
  const version = await lifecycleVersion(p.user);
  const r = await call(h, p.user);
  assert.deepEqual([r.status, error(r)], [409, 'X_CLEANUP_UNSUPPORTED'], simulated('the stand-in reproduces the limitation, it does not fix it'));
  assert.equal(await entitlement(p.user), 'active');
  assert.equal(await operation(p.user), null, 'no operation was opened');
  assert.equal(await lifecycleVersion(p.user), version);
  assert.deepEqual(h.standIn.records.map((x) => `${x.call}:${x.answered}`), ['preview:social_and_login/none']);
  attest(h, 'R2\'');
});

test('a Kabumori person with no X footprint: the clean answer ends POSTONA only; the login, Kabumori and the profile stay; a bystander is untouched; retries are idempotent', { skip: !enabled }, async () => {
  const h = harness([{ scenario: 'clean' }]);
  const p = await person(h.net, { kabumori: true, tag: 'b1' });
  const by = await person(h.net, { kabumori: true, xFootprint: true, tag: 'b2' });
  const bystander = async () => JSON.stringify([await entitlement(by.user), await entitlement(by.user, 'kabumori'), await operation(by.user), await xSideSnapshot()]);
  const before = await bystander();
  const r = await call(h, p.user);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, outcome: 'ended', providers: { x: 'done' } }, simulated('"x: done" is the stand-in\'s answer, nothing was revoked'));
  assert.equal(await entitlement(p.user), 'ended');
  assert.equal(await entitlement(p.user, 'kabumori'), 'active');
  assert.ok(await hasLogin(p.user) && await hasProfile(p.user), 'the login and the Kabumori profile stay');
  assert.deepEqual(await operation(p.user), { status: 'completed', leased: false, fence: 1, results: { x: 'done' }, reconciliation: {} });
  assert.equal(await bystander(), before, 'the bystander is untouched');
  const again = await call(h, p.user);
  assert.deepEqual([again.status, again.body.outcome], [200, 'already_ended']);
  assert.equal(runs(h), 1, 'idempotent: the stand-in is not asked again');
  assert.equal(await completions(p.user), 1);
  assert.ok(h.net.observed >= 1, 'the observer bracketed the stand-in call');
  attest(h, 'clean end');
});

test('a clean answer cannot end POSTONA while a real X footprint remains: the DATABASE refuses, the operation stays resumable, the lease is returned', { skip: !enabled }, async () => {
  const h = harness([{ scenario: 'clean' }, { scenario: 'clean' }]);
  const p = await person(h.net, { kabumori: true, xFootprint: true, tag: 'c1' });
  const r = await call(h, p.user);
  assert.deepEqual([r.status, error(r)], [409, 'SERVICE_CLEANUP_INCOMPLETE'], simulated('a stand-in "done" does not make a real footprint disappear'));
  assert.equal(await entitlement(p.user), 'deleting');
  const view = await operation(p.user);
  assert.deepEqual([view?.status, view?.leased, view?.results.x], ['in_progress', false, 'done']);
  assert.equal(await completions(p.user), 0);
  attest(h, 'footprint');
});

test('simulated blocks (a booking, an ongoing post), a busy saga and a revoke failure: nothing is ended, the lease is returned, the fence only moves forward, a later clean answer finishes', { skip: !enabled }, async () => {
  const h = harness([
    { scenario: 'blocked', reason: 'UNEXPECTED_DEPENDENT_DATA' }, { scenario: 'blocked', reason: 'POSTING_IN_PROGRESS' }, { scenario: 'in_progress' },
    { scenario: 'reconciliation_required', reason: 'X_REVOKE_FAILED' }, { scenario: 'failed' }, { scenario: 'clean' },
  ]);
  const p = await person(h.net, { kabumori: true, tag: 'd1' });
  const seen: [number, string | null, unknown][] = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await call(h, p.user);
    seen.push([r.status, error(r), r.body.reasons]);
    assert.equal(await entitlement(p.user), 'deleting', `attempt ${i + 1}: not ended`);
    assert.equal((await operation(p.user))?.leased, false, `attempt ${i + 1}: F5's lease was returned`);
  }
  assert.deepEqual(seen, [
    [409, 'X_CLEANUP_BLOCKED', ['UNEXPECTED_DEPENDENT_DATA']], [409, 'X_CLEANUP_BLOCKED', ['POSTING_IN_PROGRESS']], [409, 'X_CLEANUP_IN_PROGRESS', undefined],
    [502, 'X_CLEANUP_FAILED', ['X_REVOKE_FAILED']], [502, 'X_CLEANUP_FAILED', undefined],
  ], simulated('the typed answers of the saga, as the real handler maps them'));
  assert.equal(await completions(p.user), 0);
  const done = await call(h, p.user);
  assert.equal(done.status, 200);
  const view = await operation(p.user);
  assert.deepEqual([view?.status, view?.fence, view?.results.x], ['completed', 6, 'done'], 'one lease per attempt, and the fence only moves forward');
  assert.equal(await entitlement(p.user), 'ended');
  assert.equal(await completions(p.user), 1);
  attest(h, 'typed outcomes');
});

test('unconfirmed posts: the pair is on record in the database BEFORE the stand-in acknowledges it; a stale snapshot is recorded and acknowledged; the person is told the highest count', { skip: !enabled }, async () => {
  const h = harness([{ scenario: 'clean', unconfirmedPosts: 2 }], { standIn: { staleAcks: 1 } });
  const p = await person(h.net, { kabumori: true, tag: 'e1' });
  const r = await call(h, p.user);
  assert.deepEqual(r.body, { ok: true, outcome: 'ended', providers: { x: 'done' }, x_posts_unconfirmed: 3 });
  const view = await operation(p.user);
  assert.deepEqual(view?.reconciliation, { x_posts_unconfirmed: 3, x_unconfirmed_snapshots: [await standInSnapshot(p.user, 1), await standInSnapshot(p.user, 2)] }, 'both sets are on record');
  assert.deepEqual(acks(h), ['snapshot_changed', 'acknowledged'], simulated('the stale snapshot was changed, the new one acknowledged'));
  assert.ok(h.net.rpcCalls.includes('record_owned_service_deletion_x_unconfirmed') && h.net.rpcCalls.includes(ACK_FUNCTION));
  assert.ok(h.net.rpcCalls.indexOf('record_owned_service_deletion_x_unconfirmed') < h.net.rpcCalls.indexOf(ACK_FUNCTION), 'recorded before acknowledged');
  const later = await call(h, p.user);
  assert.deepEqual([later.body.outcome, later.body.x_posts_unconfirmed], ['already_ended', 3], 'a later read says the same');
  attest(h, 'unconfirmed');
});

test('a Threads-connected service: the shipped registry has no adapter, so everything stops before the saga is asked to run, and nothing changes', { skip: !enabled }, async () => {
  const h = harness([{ scenario: 'clean' }]);
  const p = await person(h.net, { kabumori: true, xFootprint: true, threads: true, tag: 'f1' });
  const before = await xSideSnapshot();
  const r = await call(h, p.user, { ...END, acknowledged_remote_unverified: ['threads'] });
  assert.deepEqual([r.status, error(r)], [409, 'PROVIDER_ADAPTER_MISSING']);
  assert.equal(await entitlement(p.user), 'active');
  assert.equal(runs(h), 0);
  assert.equal(await xSideSnapshot(), before);
  attest(h, 'threads');
});

test('lease and fence: a busy saga never holds F5\'s lease; concurrent ends are told it is in progress; an expired lease is taken over, the stale owner ends nothing, a stale completion is refused', { skip: !enabled }, async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  let n = 0;
  const h = harness([{ scenario: 'clean' }, { scenario: 'clean' }], { standIn: { onRun: async () => { n += 1; if (n === 1) { entered(); await gate; } } } });
  const p = await person(h.net, { kabumori: true, tag: 'g1' });
  // one tripwire scope around the whole overlapping scenario (the tripwires are not re-entrant)
  const { hits } = await withTripwires(async () => {
    // (1) concurrency: the first end waits inside the stand-in
    const first = request(h, p.user, END);
    await inside;
    const during = await request(h, p.user, END);
    assert.deepEqual([during.status, error(during)], [409, 'DELETION_IN_PROGRESS'], 'a second request while the first holds the lease');
    assert.equal(runs(h), 0, 'the stand-in has not answered and was not asked again');
    const heldView = await operation(p.user);
    assert.deepEqual([heldView?.status, heldView?.leased, heldView?.fence], ['in_progress', true, 1]);
    // (2) the lease expires on the database clock; a second owner takes over and finishes
    await expireServiceLease(p.user);
    const second = await request(h, p.user, END);
    assert.equal(second.status, 200, 'the second owner finished');
    const afterSecond = await operation(p.user);
    assert.deepEqual([afterSecond?.status, afterSecond?.fence], ['completed', 2]);
    const versionAtEnd = await lifecycleVersion(p.user);
    const operationId = await sql(`select id::text from private.account_lifecycle_operations where user_id = '${p.user}'::uuid and operation_type = 'service_deletion' order by updated_at desc limit 1`);
    // (3) the stale owner wakes up: it ends nothing
    release();
    const stale = await first;
    assert.deepEqual([stale.status, error(stale)], [409, 'DELETION_IN_PROGRESS'], 'the stale owner learns it lost the lease');
    assert.equal(await lifecycleVersion(p.user), versionAtEnd, 'the entitlement was ended exactly once');
    assert.equal(await completions(p.user), 1);
    // (4) a stale completion attempt is refused by the database itself
    const refused = JSON.parse(await sql(`begin; set local role service_role; select to_jsonb(public.finish_owned_service_deletion('${p.user}'::uuid, 'x_autopost', '${operationId}'::uuid, '00000000-0000-4000-8000-000000000001'::uuid)); commit;`));
    assert.deepEqual(refused, { status: 'lease_lost' }, 'a stale completion is refused by the database');
    assert.equal(await entitlement(p.user), 'ended');
  });
  assert.deepEqual(hits, [], 'no tripwire fired');
  assert.equal(runs(h), 2, 'both owners asked the stand-in; only the current one could record and finish');
  attest(h, 'lease');
});

test('a saga that is busy (the stand-in\'s in_progress) never holds F5\'s lease: another device can take it at once, with a higher fence', { skip: !enabled }, async () => {
  const h = harness([{ scenario: 'in_progress' }, { scenario: 'clean' }]);
  const p = await person(h.net, { kabumori: true, tag: 'g2' });
  const first = await call(h, p.user);
  assert.deepEqual([first.status, error(first)], [409, 'X_CLEANUP_IN_PROGRESS']);
  const view = await operation(p.user);
  assert.deepEqual([view?.status, view?.leased, view?.fence], ['in_progress', false, 1]);
  const second = await call(h, p.user);
  assert.equal(second.status, 200);
  assert.deepEqual([(await operation(p.user))?.status, (await operation(p.user))?.fence], ['completed', 2]);
  attest(h, 'busy saga');
});

test('a disabled stand-in is "unsupported": the preview is not answered, nothing runs, nothing changes', { skip: !enabled }, async () => {
  const h = harness([], { disabled: true });
  const p = await person(h.net, { kabumori: true, tag: 'h1' });
  const r = await call(h, p.user);
  assert.deepEqual([r.status, error(r)], [409, 'X_CLEANUP_UNSUPPORTED']);
  assert.equal(await entitlement(p.user), 'active');
  assert.equal(await operation(p.user), null);
  assert.deepEqual(h.standIn.records.map((x) => `${x.call}:${x.answered}:${x.disabled}`), ['preview:stand_in_disabled:true']);
  attest(h, 'disabled');
});

test('repeat runs are identical: two harnesses with the same script give the same responses and the same records on fresh people', { skip: !enabled }, async () => {
  const play = async (tag: string) => {
    const h = harness([{ scenario: 'blocked', reason: 'SHARED_WORKSPACE' }, { scenario: 'clean' }]);
    const p = await person(h.net, { kabumori: true, tag });
    const out = [await call(h, p.user), await call(h, p.user)];
    const normalise = (text: string) => text.replaceAll(p.user, '<user>');
    return normalise(JSON.stringify({ out, records: h.standIn.records, requests: h.net.requests.map((r) => r.path) }));
  };
  assert.equal(await play('i1'), await play('i2'));
});
