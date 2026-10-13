// Phase 8 (F5): the common account + F3's X service-end saga + F4's Threads cleanup, END TO END over the REAL
// sources of the three stacks (assembled, unmodified, in a throw-away tree by common_account_phase8_integrated_run.sh):
//
//   F5 account-delete Edge handler (createHandler)  ->  fake network  ->  F3 social-mobile-account-delete Edge handler
//        |                                                   |                (real saga TS: stop, X revoke, purge)
//        |  F4's real Threads adapter (registration candidate)|
//        v                                                   v
//   real SQL of Phase 1..8 + F3 reservations / entitlement guard / saga stop + F4 cleanup / disconnect / guards
//
// STAND-INS (each a single statement or a function, never in a candidate): the Data API (PostgREST) = psql as role
// service_role; Auth `getUser` = a fake token check; Auth logout / admin delete = SQL on auth.sessions / auth.users;
// the X revoke endpoint = a recording fake (no X call is ever made); Storage = accept. The tokens are fake HS256-shaped
// strings. Fake data only; needs CAL_E2E=1 and PGHOST / PGPORT / PGUSER / PGDATABASE (+ PGDATABASE_NOGRANT).
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler as createCommonHandler, X_BLOCK_REASONS, xResultOf } from '../functions/account-delete/http.ts';
import { providerRegistration as emptyRegistration } from '../functions/account-delete/provider_registry.empty.ts';
import { providerRegistration as threadsRegistration } from '../functions/account-delete/provider_registry.ts';
import { BLOCK_REASONS } from '../functions/social-mobile-account-delete/delete_logic.ts';
import { createHandler as createXHandler } from '../functions/social-mobile-account-delete/http.ts';
import { xServiceEndOutcomeOf, xServiceEndRequest } from '../functions/social-mobile-account-delete/x_service_end_contract.ts';

const enabled = Deno.env.get('CAL_E2E') === '1';
const GRANTED = Deno.env.get('PGDATABASE') ?? '';
const NOT_GRANTED = Deno.env.get('PGDATABASE_NOGRANT') ?? '';
const decoder = new TextDecoder();
const URL_BASE = 'https://p8.supabase.invalid';
const KEYS = { anon: 'anon-stand-in', service: 'service-stand-in' };
const env = {
  get: (name: string) => ({
    SUPABASE_URL: URL_BASE, SUPABASE_ANON_KEY: KEYS.anon, SUPABASE_SERVICE_ROLE_KEY: KEYS.service,
    X_CLIENT_ID: 'x-client-stand-in', X_CLIENT_SECRET: 'x-secret-stand-in',
  } as Record<string, string>)[name],
};

// ---- psql ------------------------------------------------------------------------------------------------------------
async function psql(statement: string, db: string): Promise<{ ok: boolean; out: string; error: string }> {
  const out = await new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement],
    env: {
      PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: Deno.env.get('PGUSER') ?? '',
      PGDATABASE: db, LC_ALL: 'C',
    },
    stdout: 'piped', stderr: 'piped',
  }).output();
  const error = decoder.decode(out.stderr).trim();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error };
}
async function sql(statement: string, db: string): Promise<string> {
  const r = await psql(statement, db);
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
const voidFunctions = new Map<string, Set<string>>();
async function isVoid(db: string, fn: string) {
  let names = voidFunctions.get(db);
  if (!names) {
    names = new Set((await sql(`select proname from pg_proc where prorettype = 'void'::regtype and pronamespace = 'public'::regnamespace`, db)).split('\n'));
    voidFunctions.set(db, names);
  }
  return names.has(fn);
}

// ---- the fake network -------------------------------------------------------------------------------------------------
type Net = {
  db: string;
  xCalls: { hint: string; token: string; status: number }[];
  /** answer of the X revoke endpoint, per call */
  xRevoke: () => boolean;
  /** Awaited after the X handler (the saga) answered and before the answer reaches the caller. */
  afterSaga?: () => Promise<void>;
  /** Awaited at every X revoke call, before its answer. */
  onXRevoke?: () => Promise<void>;
  /** Awaited once, before the named Data API function runs (the moment an end is open and nothing is removed yet). */
  beforeRpc?: Record<string, () => Promise<void>>;
  /** After true: every Data API call fails (the process "died"). */
  dead: boolean;
  unrouted: string[];
  rpcCalls: string[];
  /** Messages of Data API calls that failed (a deadlock or a lock timeout inside a handler's RPC shows up here). */
  rpcErrors: string[];
  /** The F3 saga answers, as (status, body), and the action of each request. */
  sagaAnswers: { status: number; body: unknown }[];
  sagaActions: string[];
  /** The complete bodies of the requests that reached the X saga (never a token: the person's token is a header). */
  sagaBodies: unknown[];
  users: Set<string>;
};
function makeNet(db: string, extra: Partial<Net> = {}): { net: Net; fetch: (input: string, init?: RequestInit) => Promise<Response> } {
  const net: Net = { db, xCalls: [], xRevoke: () => true, dead: false, unrouted: [], rpcCalls: [], rpcErrors: [], sagaAnswers: [], sagaActions: [], sagaBodies: [], users: new Set(), ...extra };
  const claimsOf = (header: string | null) => {
    const token = header?.replace(/^Bearer\s+/iu, '') ?? '';
    try {
      return JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as { sub?: string };
    } catch {
      return {};
    }
  };
  const xHandler = createXHandler(env, async (input, init) => await network(input, init));
  const network = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    const path = url.pathname;
    if (url.origin === 'https://api.x.com' && path === '/2/oauth2/revoke') {
      const form = new URLSearchParams(String(init?.body));
      if (net.onXRevoke) await net.onXRevoke();
      const ok = net.xRevoke();
      net.xCalls.push({ hint: form.get('token_type_hint') ?? '', token: form.get('token') ?? '', status: ok ? 200 : 500 });
      return new Response('{}', { status: ok ? 200 : 500 });
    }
    if (url.origin !== URL_BASE) {
      net.unrouted.push(input);
      return new Response('{}', { status: 404 });
    }
    if (path === '/auth/v1/user') {
      const sub = claimsOf(headers.get('Authorization')).sub;
      if (!sub || !net.users.has(sub)) return new Response('{}', { status: 401 });
      return Response.json({ id: sub, identities: [{ provider: 'email', id: sub }] });
    }
    if (path.startsWith('/rest/v1/rpc/')) {
      if (headers.get('apikey') !== KEYS.service || headers.get('Authorization') !== `Bearer ${KEYS.service}`) {
        return Response.json({ message: 'invalid credential' }, { status: 401 });
      }
      if (net.dead) return Response.json({ message: 'process gone' }, { status: 500 });
      const fn = path.slice('/rest/v1/rpc/'.length);
      net.rpcCalls.push(fn);
      const hook = net.beforeRpc?.[fn];
      if (hook) {
        delete net.beforeRpc![fn];
        await hook();
      }
      const args = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const named = Object.entries(args).map(([key, value]) => `${key} => ${lit(value)}`).join(', ');
      const call = `public.${fn}(${named})`;
      // PostgREST answers JSON: a text result is a JSON string, a jsonb result its object, void is null.
      const text = (await isVoid(net.db, fn))
        ? `(select count(*) from (select ${call}) x)::text`
        : `to_jsonb(${call})::text`;
      const r = await psql(`begin; set local role service_role; select ${text}; commit;`, net.db);
      if (!r.ok) {
        const message = /ERROR:\s+(.*)/u.exec(r.error)?.[1] ?? 'error';
        net.rpcErrors.push(`${fn}: ${message}`);
        const status = /permission denied/u.test(message) ? 403 : /does not exist/u.test(message) ? 404 : 400;
        return Response.json({ message }, { status });
      }
      return new Response((await isVoid(net.db, fn)) || r.out === '' ? 'null' : r.out, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/functions/v1/social-mobile-account-delete') {
      try {
        const sent = JSON.parse(String(init?.body ?? '{}')) as { action?: unknown };
        net.sagaActions.push(String(sent.action));
        net.sagaBodies.push(sent);
      } catch {
        net.sagaActions.push('?');
      }
      const response = await xHandler(new Request(input, { method: 'POST', headers, body: String(init?.body ?? '') }));
      const copy = response.clone();
      net.sagaAnswers.push({ status: copy.status, body: await copy.json().catch(() => null) });
      // only the run (a delete), never the read-only preview
      if (net.afterSaga && net.sagaActions[net.sagaActions.length - 1] === 'delete') await net.afterSaga();
      return response;
    }
    if (path === '/auth/v1/logout') {
      const sub = claimsOf(headers.get('Authorization')).sub;
      if (sub) await sql(`delete from auth.sessions where user_id = ${q(sub)}`, net.db);
      return new Response(null, { status: 204 });
    }
    if (path.startsWith('/auth/v1/admin/users/')) {
      const id = decodeURIComponent(path.slice('/auth/v1/admin/users/'.length));
      const exists = (await sql(`select exists (select 1 from auth.users where id = ${q(id)})`, net.db)) === 't';
      if (init?.method === 'DELETE') {
        if (!exists) return new Response(null, { status: 404 });
        const r = await psql(`delete from auth.users where id = ${q(id)}`, net.db);
        return new Response(null, { status: r.ok ? 200 : 500 });
      }
      return new Response(null, { status: exists ? 200 : 404 });
    }
    if (path.startsWith('/storage/v1/')) return Response.json({}, { status: 200 });
    net.unrouted.push(input);
    return new Response('{}', { status: 404 });
  };
  return { net, fetch: network };
}

// ---- people -----------------------------------------------------------------------------------------------------------
let counter = 0;
const newUser = () => `00000000-0000-4000-8000-${String(950_000 + ++counter).padStart(12, '0')}`;
const tokenOf = (user: string) => {
  const b64 = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: user, session_id: `session-${user.slice(-6)}`, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 30 }] })}.sig`;
};
const asPerson = (user: string, statement: string) =>
  `begin; set local request.jwt.claim.sub = '${user}'; set local request.jwt.claim.role = 'authenticated'; set local role authenticated; ${statement}; commit;`;

type Person = { user: string; workspace: string; xAccount: string; threadsAccount: string | null; reservations: string[] };
/** A POSTONA person: X workspace (fixture) with tokens, publish authority, two planned reservations; optionally a
 *  verified Threads connection (F4's real OAuth functions) and Kabumori. */
async function person(db: string, net: Net, options: { threads?: boolean; kabumori?: boolean; tag: string }): Promise<Person> {
  const user = newUser();
  net.users.add(user);
  await sql(`select t13.login('${user}'::uuid)`, db);
  assert.equal(await sql(`select t13.register('${user}'::uuid)`, db), 'active');
  const workspace = await sql(`select public.fixture_user_with_workspace('${user}'::uuid, ${q(options.tag)})`, db);
  const xAccount = await sql(`select id from public.social_accounts where brand_id = ${q(workspace)} and platform = 'x'`, db);
  await sql(`insert into public.x_account_publish_authority (social_account_id, state, starts_at, expires_at, reason_code)
             values (${q(xAccount)}, 'enabled', now() - interval '1 minute', now() + interval '7 days', 'TEST_STAND_IN')`, db);
  const batch = await sql(`insert into postona_x_resv.batches (user_id, brand_id, social_account_id, client_batch_id, revision, mode, origin, time_zone, band, payload_sha256)
             values ('${user}'::uuid, ${q(workspace)}, ${q(xAccount)}, gen_random_uuid(), 1, 'manual_exact', 'user_authored', 'Asia/Tokyo', null, repeat('a', 64)) returning id::text`, db);
  await sql(`insert into postona_x_resv.reservations (batch_id, user_id, brand_id, social_account_id, draft_id, position, origin, mode, body, content_sha256,
               scheduled_at, fixed, status, consent_state, expires_at)
             select '${batch}'::uuid, '${user}'::uuid, ${q(workspace)}, ${q(xAccount)}, ${q(options.tag)} || g, g, 'user_authored', 'manual_exact', 'b', repeat('c', 64),
                    now() + (g + 1) * interval '1 day', true, 'planned', 'confirmed', now() + interval '30 days' from generate_series(0, 1) g`, db);
  await sql(`insert into postona_x_resv.audit (user_id, batch_id, action) values ('${user}'::uuid, '${batch}'::uuid, 'create_batch')`, db);
  const reservations = (await sql(`select id::text from postona_x_resv.reservations where brand_id = ${q(workspace)} order by position`, db)).split('\n');
  let threadsAccount: string | null = null;
  if (options.threads) {
    threadsAccount = await sql(`select t13.complete_oauth('${user}'::uuid, t13.begin_oauth('${user}'::uuid, ${q('th_' + options.tag)}), ${q('th_' + options.tag)})`, db);
  }
  if (options.kabumori) {
    assert.equal(JSON.parse(await sql(asPerson(user, 'select to_jsonb(public.start_kabumori_service())'), db)).status, 'active');
    await sql(`insert into public.profiles (id) values ('${user}'::uuid) on conflict do nothing`, db);
  }
  return { user, workspace, xAccount, threadsAccount, reservations };
}

// ---- observations --------------------------------------------------------------------------------------------------------
const entitlement = (db: string, user: string, service = 'x_autopost') =>
  sql(`select coalesce((select status from public.service_entitlements where user_id = '${user}'::uuid and service_key = '${service}'), 'none')`, db);
const count = async (db: string, statement: string) => Number(await sql(statement, db));
const accountsLeft = (db: string, workspace: string, platform?: string) =>
  count(db, `select count(*) from public.social_accounts where brand_id = ${q(workspace)}${platform ? ` and platform = ${q(platform)}` : ''}`);
const authority = (db: string, account: string) =>
  sql(`select coalesce((select state from public.x_account_publish_authority where social_account_id = ${q(account)}), 'none')`, db);
const reservationStates = async (db: string, workspace: string) =>
  (await sql(`select coalesce(string_agg(status, ',' order by position), '') from postona_x_resv.reservations where brand_id = ${q(workspace)}`, db));
type OpView = { status: string; leased: boolean; results: Record<string, string>; ack: string[]; reconciliation: Record<string, number> } | null;
const operation = async (db: string, user: string): Promise<OpView> =>
  JSON.parse(await sql(`select coalesce((select jsonb_build_object('status', status, 'leased', owner_lease is not null and owner_lease_expires_at > clock_timestamp(),
      'results', provider_results, 'ack', coalesce(remote_unverified_ack_providers, '{}'::text[]), 'reconciliation', reconciliation)
      from private.account_lifecycle_operations where user_id = '${user}'::uuid and operation_type = 'service_deletion' and service_key = 'x_autopost'
      order by updated_at desc limit 1), 'null'::jsonb)`, db));
const expireServiceLease = (db: string, user: string) =>
  sql(`update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 second'
        where user_id = '${user}'::uuid and operation_type = 'service_deletion' and status = 'in_progress'`, db);

async function call(handler: (req: Request) => Promise<Response>, user: string, body: Record<string, unknown>) {
  const response = await handler(new Request(`${URL_BASE}/functions/v1/account-delete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenOf(user)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
const END = { action: 'withdraw_postona', confirmation: 'END_POSTONA_SERVICE' };
const ACK = { acknowledged_remote_unverified: ['threads'] };

if (enabled && (!GRANTED || !NOT_GRANTED)) throw new Error('PGDATABASE and PGDATABASE_NOGRANT are required');

function setup(db: string, extra: Partial<Net> = {}) {
  const { net, fetch } = makeNet(db, extra);
  const handler = createCommonHandler(env, fetch, threadsRegistration);
  return { net, handler, fetch };
}
/** A bystander with the same shape: nothing of it may change. */
async function bystanderOf(db: string, net: Net) {
  const b = await person(db, net, { threads: true, kabumori: true, tag: `by${counter}` });
  const snapshot = async () => JSON.stringify({
    authority: await authority(db, b.xAccount), reservations: await reservationStates(db, b.workspace),
    accounts: await accountsLeft(db, b.workspace), entitlement: await entitlement(db, b.user), kabumori: await entitlement(db, b.user, 'kabumori'),
    operation: await operation(db, b.user),
  });
  const before = await snapshot();
  return { b, same: async (label: string) => assert.equal(await snapshot(), before, `${label}: the bystander is untouched`) };
}

test('I0 the contract: F5\'s mapper equals F3\'s on every answer the saga can give', { skip: !enabled }, () => {
  assert.deepEqual([...X_BLOCK_REASONS].sort(), [...BLOCK_REASONS].sort(), 'the two lists of block reasons are the same');
  const cases: [number, unknown][] = [
    [200, { ok: true, login_deleted: false }], [200, { ok: true, login_deleted: false, x_posts_unconfirmed: 2 }],
    [200, { ok: true, login_deleted: true }], [200, { ok: true }], [200, { ok: true, login_deleted: false, x_posts_unconfirmed: 0 }],
    [200, { ok: true, login_deleted: false, x_posts_unconfirmed: 'x' }],
    ...BLOCK_REASONS.map((reason): [number, unknown] => [409, { ok: false, error: `DELETION_BLOCKED_${reason}` }]),
    [409, { ok: false, error: 'DELETION_BLOCKED_SOMETHING_NEW' }],
    [409, { ok: false, error: 'DELETION_OPERATOR_REQUIRED' }], [409, { ok: false, error: 'DELETION_IN_PROGRESS' }],
    [409, { ok: false, error: 'SCOPE_CHANGED' }], [400, { ok: false, error: 'SCOPE_REQUIRED' }],
    [502, { ok: false, error: 'X_REVOKE_FAILED' }], [409, { ok: false, error: 'CREDENTIALS_CHANGED' }], [500, { ok: false, error: 'FINALIZE_FAILED' }],
    [401, { ok: false, error: 'AUTH_REQUIRED' }], [403, { ok: false, error: 'REAUTH_REQUIRED' }], [500, { ok: false, error: 'FAILED' }], [500, null],
  ];
  // F3's word for each outcome, mapped onto F5's outcome vocabulary
  const word = (status: string) => ({
    done: 'done', blocked: 'blocked', operator_required: 'blocked', reconciliation_required: 'failed', in_progress: 'in_progress',
    scope_refused: 'scope_refused', auth_required: 'failed', login_deleted: 'login_deleted', failed: 'failed',
  } as Record<string, string>)[status];
  for (const [status, body] of cases) {
    const theirs = xServiceEndOutcomeOf(status, body);
    const ours = xResultOf(status, body);
    assert.equal(ours.outcome, word(theirs.status), `${status} ${JSON.stringify(body)}`);
    if (theirs.status === 'done') assert.equal(ours.unconfirmedPosts ?? 0, theirs.unconfirmedPosts);
    if (theirs.status === 'blocked') assert.equal(ours.reason, theirs.reason);
    if (theirs.status === 'reconciliation_required') assert.equal(ours.reason, theirs.reason);
  }
  // F3's request body is what F5 sends; the route's `action: 'delete'` is part of F3's body from PR #192 on and is added
  // here for PR #189 (where F3's helper leaves it out). Both ways the same complete body results.
  assert.deepEqual({ action: 'delete', ...xServiceEndRequest() }, { action: 'delete', confirmation: 'DELETE_MY_ACCOUNT', expected_scope: 'social_only' });
});

test('I1 POSTONA alone: X publishing stops and X is revoked, Threads goes with the person\'s consent, nothing else moves', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, handler } = setup(db);
  const by = await bystanderOf(db, net);
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'one' });
  const midway: Record<string, string> = {};
  net.onXRevoke = async () => {
    // At the moment X is revoked: publishing is already stopped, and Threads is already gone.
    midway.authority = await authority(db, p.xAccount);
    midway.reservations = await reservationStates(db, p.workspace);
    midway.threads = String(await accountsLeft(db, p.workspace, 'threads'));
  };
  const response = await call(handler, p.user, { ...END, ...ACK });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body, {
    ok: true, outcome: 'ended', providers: { threads: 'local_removed_remote_unverified', x: 'done' }, remote_unverified: ['threads'],
  });
  assert.deepEqual(midway, { authority: 'revoked', reservations: 'cancelled,cancelled', threads: '0' });
  assert.deepEqual(net.sagaBodies.filter((b) => (b as { action?: string }).action !== 'preview'),
    [{ action: 'delete', ...xServiceEndRequest() }], 'F5 sends F3\'s own request, once, and nothing else');
  assert.deepEqual(net.xCalls.map((c) => [c.hint, c.status]), [['refresh_token', 200], ['access_token', 200]], 'X revoked once each');
  assert.equal(await accountsLeft(db, p.workspace), 0, 'the workspace is purged');
  assert.equal(await authority(db, p.xAccount), 'none');
  assert.equal(await entitlement(db, p.user), 'ended');
  assert.equal(await entitlement(db, p.user, 'kabumori'), 'active', 'Kabumori keeps its entitlement');
  assert.equal(await count(db, `select count(*) from auth.users where id = '${p.user}'`), 1, 'the login stays');
  assert.equal(await count(db, `select count(*) from public.profiles where id = '${p.user}'`), 1, 'Kabumori data stays');
  const op = await operation(db, p.user);
  assert.deepEqual([op?.status, op?.leased, op?.ack], ['completed', false, ['threads']]);
  assert.deepEqual(net.unrouted, []);
  await by.same('I1');
});

test('I2 without the person\'s consent nothing changes at all: X is not stopped, not revoked, Threads is not read', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'noack' });
  const response = await call(handler, p.user, END);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'REMOTE_UNVERIFIED_ACK_REQUIRED');
  assert.equal(await authority(db, p.xAccount), 'enabled');
  assert.equal(await reservationStates(db, p.workspace), 'planned,planned');
  assert.equal(await accountsLeft(db, p.workspace, 'threads'), 1);
  assert.equal(await entitlement(db, p.user), 'active');
  assert.deepEqual(net.xCalls, []);
  assert.ok(!net.sagaActions.includes('delete'), 'the X saga was not run (a read-only preview is not)');
  assert.ok(!net.rpcCalls.includes('threads_provider_connection_state'), 'the provider was not even read');
  assert.equal(await operation(db, p.user), null);
});

test('I3 the shipped registry is empty: a person with a Threads connection is refused before X or Threads is touched', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, fetch } = makeNet(db);
  const empty = createCommonHandler(env, fetch, emptyRegistration);
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'empty' });
  assert.deepEqual(emptyRegistration({ supabaseUrl: URL_BASE, serviceKey: 'k', fetchImpl: fetch }), { adapters: [], remoteRevoke: {} });
  const response = await call(empty, p.user, { ...END, ...ACK });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'PROVIDER_ADAPTER_MISSING');
  assert.equal(await authority(db, p.xAccount), 'enabled');
  assert.equal(await accountsLeft(db, p.workspace, 'threads'), 1);
  assert.ok(!net.sagaActions.includes('delete'), 'the X saga was not run');
  assert.deepEqual(net.xCalls, []);
  assert.equal(await operation(db, p.user), null, 'nothing was begun');
});

test('I4 the cleanup grant is not applied: the adapter is refused by the database; X is untouched', { skip: !enabled }, async () => {
  const db = NOT_GRANTED;
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'nogrant' });
  const response = await call(handler, p.user, { ...END, ...ACK });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'RECONCILIATION_REQUIRED');
  assert.equal(await accountsLeft(db, p.workspace, 'threads'), 1, 'Threads is intact');
  assert.equal(await authority(db, p.xAccount), 'enabled', 'publishing was not stopped by a half-done end... until the saga runs');
  assert.deepEqual(net.xCalls, []);
  assert.ok(!net.sagaActions.includes('delete'), 'the X saga was not run');
  assert.equal(await entitlement(db, p.user), 'deleting', 'not ended, not silently reverted');
});

test('I5 a post in flight blocks with a typed reason; publishing is already stopped; settled, the retry ends', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, handler } = setup(db);
  const by = await bystanderOf(db, net);
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'flight' });
  await sql(`update postona_x_resv.reservations set status = 'claimed', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes'
              where id = '${p.reservations[0]}'::uuid`, db);
  const first = await call(handler, p.user, { ...END, ...ACK });
  assert.equal(first.status, 409);
  assert.equal(first.body.error, 'X_CLEANUP_BLOCKED');
  assert.deepEqual(first.body.reasons, ['POSTING_IN_PROGRESS']);
  assert.equal(await authority(db, p.xAccount), 'revoked', 'publishing is already stopped');
  assert.equal(await accountsLeft(db, p.workspace, 'threads'), 0, 'Threads went first and stays gone');
  assert.deepEqual(net.xCalls, [], 'no X credential was read or revoked');
  assert.equal(await entitlement(db, p.user), 'deleting');
  assert.equal((await operation(db, p.user))?.results.x, 'blocked');
  // The post settles; the retry ends it, and the earlier Threads fact is still there.
  await sql(`update postona_x_resv.reservations set status = 'cancelled', lease_token = null, lease_expires_at = null where id = '${p.reservations[0]}'::uuid`, db);
  const second = await call(handler, p.user, { ...END, ...ACK });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(second.body.providers, { threads: 'local_removed_remote_unverified', x: 'done' });
  assert.deepEqual(second.body.remote_unverified, ['threads']);
  await by.same('I5');
});

test('I6 X revoke unknown: nothing is purged, nothing ended; the remote authorization is never claimed revoked; retry ends it', { skip: !enabled }, async () => {
  const db = GRANTED;
  const answers = [false, true, true];
  const { net, handler } = setup(db, { xRevoke: () => answers.shift() ?? true });
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'revoke' });
  const first = await call(handler, p.user, { ...END, ...ACK });
  assert.equal(first.status, 502);
  assert.equal(first.body.error, 'X_CLEANUP_FAILED');
  assert.deepEqual(first.body.reasons, ['X_REVOKE_FAILED']);
  assert.equal(await entitlement(db, p.user), 'deleting');
  assert.equal(await accountsLeft(db, p.workspace, 'x'), 1, 'the X account and its credentials are still here');
  assert.equal((await operation(db, p.user))?.results.x, 'reconciliation_required');
  const second = await call(handler, p.user, { ...END, ...ACK });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(net.xCalls.map((c) => c.status), [500, 200, 200]);
  assert.equal(await entitlement(db, p.user), 'ended');
});

test('I7 X posts whose result was never known are reported and kept: on the answer, on the record, on a later read', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: false, kabumori: true, tag: 'uncertain' });
  await sql(`update postona_x_resv.reservations set status = 'claimed', lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 minute'
              where id = '${p.reservations[0]}'::uuid`, db);
  const response = await call(handler, p.user, END);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.outcome, 'ended');
  assert.equal(response.body.x_posts_unconfirmed, 1);
  assert.deepEqual((await operation(db, p.user))?.reconciliation, { x_posts_unconfirmed: 1 });
  // another device / a retry that lost the answer reads the same thing; the saga has nothing left to say
  const again = await call(handler, p.user, END);
  assert.equal(again.status, 200);
  assert.equal(again.body.outcome, 'already_ended');
  assert.equal(again.body.x_posts_unconfirmed, 1);
  // Where F3's saga keeps its own durable checkpoint (PR #192 on): F5 recorded the fact first and then acknowledged it,
  // so the saga does not keep repeating it. With PR #189 there is no such table and nothing to acknowledge.
  if ((await sql(`select to_regclass('public.social_mobile_account_deletion_x_unconfirmed') is not null`, db)) === 't') {
    assert.equal(await count(db, `select count(*) from public.social_mobile_account_deletion_x_unconfirmed
                                   where subject_sha256 = public.social_mobile_account_deletion_subject('${p.user}'::uuid)`), 0,
      'the saga\'s checkpoint was acknowledged after the fact was on record here');
    assert.ok(net.rpcCalls.includes('social_mobile_account_deletion_x_unconfirmed_ack'));
  }
});

test('I8 a process that dies after X was revoked and Threads removed: the lease holds others off; a takeover completes it once', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'crash' });
  net.afterSaga = () => { net.dead = true; return Promise.resolve(); };   // the saga answered; F5's process "dies" before recording it
  const first = await call(handler, p.user, { ...END, ...ACK });
  assert.notEqual(first.status, 200, 'the dead process cannot report a success');
  net.dead = false; net.afterSaga = undefined;
  assert.equal(await entitlement(db, p.user), 'deleting');
  assert.equal(await accountsLeft(db, p.workspace), 0, 'X and Threads are already gone');
  assert.equal((await operation(db, p.user))?.leased, true, 'the dead process still holds the lease');
  const duplicate = await call(handler, p.user, { ...END, ...ACK });
  assert.equal(duplicate.body.error, 'DELETION_IN_PROGRESS', 'nothing is done twice while the lease lives');
  await expireServiceLease(db, p.user);
  const sagaCallsBefore = net.xCalls.length;
  const takeover = await call(handler, p.user, END);
  assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
  assert.equal(net.xCalls.length, sagaCallsBefore, 'X was not revoked a second time');
  assert.equal(await entitlement(db, p.user), 'ended');
  assert.deepEqual(takeover.body.remote_unverified, ['threads'], 'the consent given before the removal still reports the grant as unverified');
});

test('I9 two identical requests at once: one ends it, the other is told; X is revoked once, Threads removed once', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'dup' });
  const [a, b] = await Promise.all([call(handler, p.user, { ...END, ...ACK }), call(handler, p.user, { ...END, ...ACK })]);
  const outcomes = [a, b].map((r) => r.status === 200 ? String(r.body.outcome) : String(r.body.error)).sort();
  assert.ok(outcomes.includes('ended'), JSON.stringify([a.body, b.body]));
  assert.ok(outcomes.every((o) => ['ended', 'already_ended', 'DELETION_IN_PROGRESS', 'X_CLEANUP_IN_PROGRESS', 'WITHDRAW_BLOCKED'].includes(o)), JSON.stringify(outcomes));
  assert.equal(net.xCalls.length, 2, 'X revoked once each, never twice');
  assert.equal(await entitlement(db, p.user), 'ended');
});

test('I10 the lease ends while the saga runs: the lost owner ends nothing; the retry finishes without a second revoke', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'lost' });
  net.onXRevoke = async () => { net.onXRevoke = undefined; await expireServiceLease(db, p.user); };
  const first = await call(handler, p.user, { ...END, ...ACK });
  assert.equal(first.body.error, 'DELETION_IN_PROGRESS');
  assert.equal(await entitlement(db, p.user), 'deleting', 'not ended by the lost owner');
  const calls = net.xCalls.length;
  const second = await call(handler, p.user, END);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(net.xCalls.length, calls, 'no second revoke');
  assert.equal(await entitlement(db, p.user), 'ended');
});

test('I11 the saga alone refuses a workspace that holds a non-X account, before any X call (F3\'s guard, F5 bypassed)', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, fetch } = makeNet(db);
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'nonx' });
  const response = await fetch(`${URL_BASE}/functions/v1/social-mobile-account-delete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenOf(p.user)}`, apikey: KEYS.anon, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'delete', ...xServiceEndRequest() }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, 'DELETION_BLOCKED_NON_X_ACCOUNT_PRESENT');
  assert.deepEqual(net.xCalls, []);
  assert.equal(await accountsLeft(db, p.workspace), 2);
  assert.equal(await authority(db, p.xAccount), 'enabled');
});

test('I12 while an end is open (entitlement deleting, lease live, nothing removed yet) every competing write is refused', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'compete' });
  const seen: Record<string, string> = {};
  const asApi = async (statement: string) => {
    const r = await psql(`begin; set local request.jwt.claim.sub = '${p.user}'; set local request.jwt.claim.role = 'authenticated';
                          set local request.jwt.claims = '{"sub":"${p.user}","role":"authenticated"}'; set local role postona_resv_api; ${statement}; commit;`, db);
    return r.ok ? `OK ${r.out}` : (/ERROR:\s+(.*)/u.exec(r.error)?.[1] ?? r.error);
  };
  net.beforeRpc = {
    threads_provider_connection_state: async () => {
      // (a) a new reservation batch through the person's API role
      seen.create = await asApi(`select count(*)::text from postona_x_resv.create_batch(${q(p.xAccount)}, gen_random_uuid(), 1, 'manual_exact', null,
        jsonb_build_array(jsonb_build_object('draft_id', 'late1', 'scheduled_at', now() + interval '3 days', 'body', 'late',
          'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to('late', 'UTF8')), 'hex')))))`);
      // (b) the reservation list of the person's own account
      seen.list = await asApi(`select count(*)::text from postona_x_resv.list_reservations(${q(p.xAccount)})`);
      // (c) a new Threads connection (F4's / PR #124's owner channel with the person's claims)
      seen.reconnect = await sql(`select t13.call('${p.user}'::uuid, format('select public.begin_social_mobile_threads_oauth_connection(%L, %L, now() + interval ''9 minutes'')',
        t13.h('again'), 'https://postona.example/threads/callback'), 'owner')`, db);
      // (d) the person's own Threads disconnect (F4: refused while a deletion owns the removal)
      seen.disconnect = await sql(`select t13.as_user('${p.user}'::uuid, 'disconnect', ${q(p.threadsAccount ?? '')}, gen_random_uuid()::text)::text`, db);
      // (e) what the worker and F3's reservation decision read
      seen.worker = await sql(`select public.common_account_brand_service_state(${q(p.workspace)}, 'x_autopost')`, db);
      seen.reservationDecision = await sql(`select postona_x_resv.g5_x_autopost_allowed('${p.user}'::uuid)::text`, db);
      // (f) the cleanup function for a person whose end is open and leased is the owner's lawful call: it is NOT run
      //     here (it would remove). Anyone else's call would be refused: the grant is service_role only.
      seen.authenticatedCleanup = await sql(`select has_function_privilege('authenticated', 'public.cleanup_threads_provider_footprint(uuid)', 'EXECUTE')::text`, db);
    },
  };
  // TEST STAND-IN (as F4's own suite): F4's release gate for the disconnect is open, so that the LIFECYCLE decision
  // (not "disconnect is disabled") is what answers.
  await sql(`create or replace function public.threads_disconnect_gate_open() returns boolean language sql immutable set search_path = '' as $$ select true $$`, db);
  const response = await call(handler, p.user, { ...END, ...ACK });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(seen.create, /POSTONA_RESV_[A-Z_]+/u, `create: ${seen.create}`);
  assert.doesNotMatch(seen.create, /^OK /u, 'a new reservation is not created while the end is open');
  assert.match(seen.list, /POSTONA_RESV_SERVICE_NOT_ACTIVE/u, `list: ${seen.list}`);
  assert.doesNotMatch(seen.reconnect, /^OK/u, `reconnect: ${seen.reconnect}`);
  assert.deepEqual(JSON.parse(seen.disconnect), { code: 'ACCOUNT_LIFECYCLE_BLOCKED', status: 'refused' }, `disconnect: ${seen.disconnect}`);
  assert.equal(seen.worker, 'SERVICE_DELETION_IN_PROGRESS');
  assert.equal(seen.reservationDecision, 'false');
  assert.equal(seen.authenticatedCleanup, 'false');
  // after the end nobody can use the cleanup function on this person (no deletion in progress)
  const after = await sql(`select public.cleanup_threads_provider_footprint('${p.user}'::uuid)->>'outcome' || '/' || (public.cleanup_threads_provider_footprint('${p.user}'::uuid)->>'code')`, db);
  assert.equal(after, 'blocked/DELETION_NOT_IN_PROGRESS');
  console.log('I12 observed: ' + JSON.stringify(seen));
});

test('I13 the whole account: acknowledgement first, X and Threads settled before the login goes; the answer is readable by the subject hash', { skip: !enabled }, async () => {
  const db = GRANTED;
  await sql(`alter table private.account_lifecycle_release_gates drop constraint if exists account_lifecycle_release_gates_blocked_only;
             update private.account_lifecycle_release_gates set state = 'open'`, db);
  const { net, handler } = setup(db);
  const by = await bystanderOf(db, net);
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'whole' });
  const version = Number(await sql(`select lifecycle_version from public.common_accounts where user_id = '${p.user}'`, db));
  const body = { action: 'delete_common_account', confirmation: 'DELETE_COMMON_ACCOUNT', expected_lifecycle_version: version };
  const refused = await call(handler, p.user, body);
  assert.equal(refused.body.error, 'REMOTE_UNVERIFIED_ACK_REQUIRED');
  assert.equal(await accountsLeft(db, p.workspace), 2);
  assert.equal(await count(db, `select count(*) from auth.users where id = '${p.user}'`), 1);
  const done = await call(handler, p.user, { ...body, ...ACK });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.outcome, 'deleted');
  assert.deepEqual(done.body.providers, { threads: 'local_removed_remote_unverified', x: 'done' });
  assert.deepEqual(done.body.remote_unverified, ['threads']);
  assert.equal(await count(db, `select count(*) from auth.users where id = '${p.user}'`), 0);
  assert.deepEqual(net.xCalls.map((c) => c.hint), ['refresh_token', 'access_token']);
  assert.equal(await sql(`select status || '/' || (provider_results ->> 'x') || '/' || (provider_results ->> 'threads') from private.account_lifecycle_operations
                           where subject_sha256 = public.social_mobile_account_deletion_subject('${p.user}'::uuid) and operation_type = 'service_deletion'
                             and service_key = 'x_autopost'`, db), 'completed/done/local_removed_remote_unverified');
  await by.same('I13');
});

test('I13a the SHIPPED release gate: the whole-account delete is refused before X, Threads or the login is touched (managed_auth_delete stays BLOCKED)', { skip: !enabled }, async () => {
  const db = NOT_GRANTED;   // never opened by any test
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: false, kabumori: true, tag: 'gate' });
  assert.equal(await sql(`select state || '/' || reason from private.account_lifecycle_release_gates where gate = 'managed_auth_delete'`, db), 'blocked/IDENTITY_CHANGE_FENCE_MISSING');
  assert.equal(await count(db, `select count(*) from pg_constraint where conrelid = 'private.account_lifecycle_release_gates'::regclass and conname = 'account_lifecycle_release_gates_blocked_only'`), 1);
  const version = Number(await sql(`select lifecycle_version from public.common_accounts where user_id = '${p.user}'`, db));
  const response = await call(handler, p.user, { action: 'delete_common_account', confirmation: 'DELETE_COMMON_ACCOUNT', expected_lifecycle_version: version });
  console.log('I13a observed: ' + JSON.stringify({ status: response.status, body: response.body }));
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'COMMON_ACCOUNT_DELETION_UNAVAILABLE');
  assert.deepEqual(net.xCalls, [], 'no X revoke');
  assert.ok(!net.sagaActions.includes('delete'), 'the X saga was not run');
  assert.equal(await count(db, `select count(*) from auth.users where id = '${p.user}'`), 1, 'the login stays');
  assert.equal(await accountsLeft(db, p.workspace), 1, 'the workspace stays');
  assert.equal(await authority(db, p.xAccount), 'enabled');
  assert.equal(await entitlement(db, p.user), 'active');
});

test('I14 a POSTONA-only person (no Kabumori profile): the saga would delete the login, so both flows are refused and nothing changes', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: false, tag: 'only' });
  const preview = await call(handler, p.user, { action: 'preview' });
  assert.equal(preview.body.x_cleanup, 'unsupported');
  const end = await call(handler, p.user, END);
  assert.equal(end.status, 409);
  assert.equal(end.body.error, 'X_CLEANUP_UNSUPPORTED');
  assert.equal(await entitlement(db, p.user), 'active');
  assert.equal(await authority(db, p.xAccount), 'enabled');
  assert.deepEqual(net.xCalls, []);
  assert.equal(await operation(db, p.user), null, 'nothing was begun');
  // the saga's own answer to a service-only request for this person: its scope is social_and_login
  const direct = JSON.parse(await sql(`select to_jsonb(public.social_mobile_account_deletion_preview('${p.user}'::uuid))`, db));
  assert.equal(direct.scope, 'social_and_login');
});

test('I14b (observed) the LEGACY saga for a POSTONA-only person who has a common account: what it does to the login', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, fetch } = makeNet(db);
  const p = await person(db, net, { threads: false, tag: 'legacyonly' });
  const sagaCall = (body: Record<string, unknown>) => fetch(`${URL_BASE}/functions/v1/social-mobile-account-delete`, {
    method: 'POST', headers: { authorization: `Bearer ${tokenOf(p.user)}`, apikey: KEYS.anon, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
  const preview = await sagaCall({ action: 'preview' });
  const scope = String(preview.body.scope);
  const first = await sagaCall({ action: 'delete', confirmation: xServiceEndRequest().confirmation, expected_scope: scope });
  const state = {
    scope, status: first.status, body: first.body,
    login: await count(db, `select count(*) from auth.users where id = '${p.user}'`),
    commonAccount: await count(db, `select count(*) from public.common_accounts where user_id = '${p.user}'`),
    entitlement: await entitlement(db, p.user),
    workspace: await accountsLeft(db, p.workspace),
    xCalls: net.xCalls.length,
  };
  console.log('I14b observed: ' + JSON.stringify(state));
  assert.equal(scope, 'social_and_login', 'for the saga this person owns nothing else: it would delete the login');
  // PINNED OBSERVATION (Phase 1's auth_delete_guard is 'shadow': it observes, it does not refuse): the legacy screen is a
  // second, uncoordinated path to a login deletion. It revokes X once each and removes the common account with the login.
  // If G5 ever enforces the guard, or F3 refuses this scope for a person with a common account, this changes on purpose.
  assert.deepEqual([state.status, state.login, state.commonAccount, state.workspace, state.xCalls], [200, 0, 0, 0, 2]);
});

test('I15 (known gap, observed) the X onboarding RPCs are not behind the Phase 3b guard: an end that is open can be reconnected', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net } = setup(db);
  const p = await person(db, net, { threads: false, kabumori: true, tag: 'xreconnect' });
  // An open POSTONA end, as G5's own RPCs leave it (begun and claimed).
  const begun = JSON.parse(await sql(`begin; set local role service_role; select to_jsonb(public.begin_service_deletion('${p.user}'::uuid, 'x_autopost')); commit;`, db));
  assert.equal(begun.status, 'started');
  assert.equal(await entitlement(db, p.user), 'deleting');
  const attempt = await psql(asPerson(p.user, `select to_jsonb(t) from public.begin_social_mobile_x_oauth_connection(${q('a'.repeat(64))}, 'https://postona.example/x/callback', now() + interval '9 minutes') t`), db);
  console.log('I15 observed: ' + JSON.stringify({ ok: attempt.ok, out: attempt.out.slice(0, 120), error: attempt.error.slice(0, 160) }));
  assert.ok(typeof attempt.ok === 'boolean');
});

test('I16 (observed) a reconnection started while the saga runs: what the end does', { skip: !enabled }, async () => {
  const db = GRANTED;
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: false, kabumori: true, tag: 'midreconnect' });
  let attempt: { ok: boolean; out: string; error: string } | null = null;
  net.onXRevoke = async () => {
    net.onXRevoke = undefined;
    attempt = await psql(asPerson(p.user, `select to_jsonb(t) from public.begin_social_mobile_x_oauth_connection(${q('b'.repeat(64))}, 'https://postona.example/x/callback', now() + interval '9 minutes') t`), db);
  };
  const response = await call(handler, p.user, END);
  const op = await operation(db, p.user);
  const state = await sql(`select coalesce((select state || '/' || coalesce(operator_reason, '-') from public.social_mobile_account_deletions where user_id = '${p.user}'::uuid), 'none')`, db);
  console.log('I16 observed: ' + JSON.stringify({
    reconnect: (attempt as { ok: boolean } | null)?.ok, response: response.body, entitlement: await entitlement(db, p.user),
    xResult: op?.results.x, sagaState: state, accountsLeft: await accountsLeft(db, p.workspace),
  }));
});

// ======================================================================================================================
// Lock order, deadlock and timeout, OBSERVED across the three stacks (PGDATABASE_ORDER = a copy of the granted world in
// which F3's own test double for G4's "X account verified" predicate answers true, so that a reservation write can
// SUCCEED and hold its locks; the double is the one F3's g5_binding suite uses, a single statement).
// ======================================================================================================================
const ORDER = Deno.env.get('PGDATABASE_ORDER') ?? '';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Seen = { kind: 'ok' | 'deadlock' | 'lock_timeout' | 'busy' | 'refused'; text: string };
function seenOf(r: { ok: boolean; out: string; error: string }): Seen {
  if (r.ok) return { kind: 'ok', text: r.out };
  const message = /ERROR:\s+(.*)/u.exec(r.error)?.[1] ?? r.error;
  if (/deadlock detected/u.test(message)) return { kind: 'deadlock', text: message };
  if (/lock timeout|canceling statement/u.test(message)) return { kind: 'lock_timeout', text: message };
  if (/_BUSY/u.test(message)) return { kind: 'busy', text: message };
  return { kind: 'refused', text: message };
}
/** The reservation API as the person (role postona_resv_api with the person's claims); optionally keeps its locks
 *  (the transaction stays open) for `holdSeconds` after the statement. */
async function asResvApi(db: string, user: string, statement: string, holdSeconds = 0): Promise<Seen> {
  return seenOf(await psql(`begin; set local request.jwt.claim.sub = '${user}'; set local request.jwt.claim.role = 'authenticated';
    set local request.jwt.claims = '{"sub":"${user}","role":"authenticated"}'; set local role postona_resv_api; ${statement}; reset role;
    ${holdSeconds > 0 ? `select pg_sleep(${holdSeconds});` : ''} commit;`, db));
}
const createBatchSql = (account: string, tag: string, day: number) =>
  `select count(*)::text from postona_x_resv.create_batch(${q(account)}, gen_random_uuid(), 1, 'manual_exact', null,
     jsonb_build_array(jsonb_build_object('draft_id', ${q(tag)}, 'scheduled_at', now() + interval '${day} days', 'body', 'late',
       'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to('late', 'UTF8')), 'hex')))))`;
const asService = async (db: string, statement: string, holdSeconds = 0): Promise<Seen> =>
  seenOf(await psql(`begin; set local role service_role; ${statement}; reset role; ${holdSeconds > 0 ? `select pg_sleep(${holdSeconds});` : ''} commit;`, db));
async function lockWaiters(db: string, like: string): Promise<number> {
  return Number(await sql(`select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
                            and query like ${q('%' + like + '%')} and pid <> pg_backend_pid()`, db));
}
async function makePublishable(db: string, workspace: string) {
  await sql(`update postona_x_resv.reservations set consent_sha256 = content_sha256, consent_scheduled_at = scheduled_at, consent_revision = revision
              where brand_id = ${q(workspace)}`, db);
}
const openReservations = (db: string, workspace: string) =>
  count(db, `select count(*) from postona_x_resv.reservations where brand_id = ${q(workspace)} and status in ('planned', 'claimed')`);

test('O0 the order database is sane: a reservation write can succeed for an active person (so that a held lock means something)', { skip: !enabled || !ORDER }, async () => {
  const db = ORDER;
  const { net } = setup(db);
  const p = await person(db, net, { threads: false, kabumori: true, tag: 'o0' });
  const seen = await asResvApi(db, p.user, createBatchSql(p.xAccount, 'o0d', 3));
  assert.equal(seen.kind, 'ok', JSON.stringify(seen));
  assert.equal(await openReservations(db, p.workspace), 3);
});

test('O1 a reservation write that holds the account lock when an end arrives: the end WAITS (observed), then ends; the new reservation is cancelled with the rest', { skip: !enabled || !ORDER }, async () => {
  const db = ORDER;
  const { net, handler } = setup(db);
  const by = await bystanderOf(db, net);
  const p = await person(db, net, { threads: false, kabumori: true, tag: 'o1' });
  const writer = asResvApi(db, p.user, createBatchSql(p.xAccount, 'o1d', 4), 2.2);
  await sleep(500);
  let waiting = 0;
  const watcher = (async () => { for (let i = 0; i < 25 && waiting === 0; i++) { waiting = await lockWaiters(db, 'begin_service_deletion'); await sleep(100); } })();
  const end = await call(handler, p.user, END);
  await watcher;
  const w = await writer;
  assert.equal(w.kind, 'ok', JSON.stringify(w));
  assert.equal(end.status, 200, JSON.stringify(end.body));
  assert.equal(end.body.outcome, 'ended');
  assert.ok(waiting >= 1, 'the begin of the end waited on the writer\'s lock (observed in pg_stat_activity)');
  assert.equal(await entitlement(db, p.user), 'ended');
  assert.equal(await openReservations(db, p.workspace), 0, 'nothing planned or claimed is left, the writer\'s new row included');
  assert.equal(net.xCalls.length, 2, 'X revoked once each');
  await by.same('O1');
});

test('O2 an end that holds the account lock when a reservation write arrives: the write waits, then is refused (typed); past the lock timeout it is BUSY (typed, nothing written)', { skip: !enabled || !ORDER }, async () => {
  const db = ORDER;
  const { net } = setup(db);
  const p = await person(db, net, { threads: false, kabumori: true, tag: 'o2' });
  const before = await openReservations(db, p.workspace);
  // the end's begin, kept open for 5 s (the locks of the begin are held to its commit)
  const holder = asService(db, `select to_jsonb(public.begin_service_deletion('${p.user}'::uuid, 'x_autopost'))`, 5);
  await sleep(500);
  const started = Date.now();
  const slow = await asResvApi(db, p.user, createBatchSql(p.xAccount, 'o2a', 3));
  const waited = Date.now() - started;
  assert.equal(slow.kind, 'busy', `past the lock timeout: ${JSON.stringify(slow)}`);
  assert.match(slow.text, /POSTONA_RESV_SERVICE_BUSY/u);
  assert.ok(waited >= 2500 && waited < 4900, `waited ${waited} ms (lock timeout 3 s)`);
  assert.equal((await holder).kind, 'ok');
  const after = await asResvApi(db, p.user, createBatchSql(p.xAccount, 'o2b', 3));
  assert.match(after.text, /POSTONA_RESV_SERVICE_NOT_ACTIVE/u, JSON.stringify(after));
  assert.equal(await openReservations(db, p.workspace), before, 'nothing was written by either refused write');
  console.log('O2 observed: ' + JSON.stringify({ busyAfterMs: waited, busy: slow.text, after: after.text }));
});

test('O3 an owner cancel (reservation row first, account lock second) against the end: no deadlock, either order', { skip: !enabled || !ORDER }, async () => {
  const db = ORDER;
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: false, kabumori: true, tag: 'o3' });
  await makePublishable(db, p.workspace);
  // The cancel takes the row lock and then the account lock (F3 lock_own -> G5 decision). The end takes the account
  // lock only. Held by the cancel for 1.5 s, the end must wait and then still end; nobody is aborted.
  const cancel = asResvApi(db, p.user, `select count(*)::text from postona_x_resv.cancel('${p.reservations[0]}'::uuid, 1)`, 1.5);
  await sleep(400);
  const end = await call(handler, p.user, END);
  const c = await cancel;
  assert.equal(c.kind, 'ok', JSON.stringify(c));
  assert.equal(end.status, 200, JSON.stringify(end.body));
  assert.equal(await entitlement(db, p.user), 'ended');
});

test('O4 the worker (reservation row first, then the G5 decision) against the end: a claimed row blocks the end with a typed reason; nothing is sent', { skip: !enabled || !ORDER }, async () => {
  const db = ORDER;
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: false, kabumori: true, tag: 'o4' });
  await makePublishable(db, p.workspace);
  await sql(`update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute'
              where id = '${p.reservations[0]}'::uuid`, db);
  await sql(`update postona_x_resv.reservations set consent_scheduled_at = scheduled_at where id = '${p.reservations[0]}'::uuid`, db);
  const claimed = await sql(`select count(*) from postona_x_resv.claim_due('worker-o4', 60, 5)`, db);
  assert.equal(claimed, '1', 'the worker claimed the due row');
  const end = await call(handler, p.user, END);
  assert.equal(end.body.error, 'X_CLEANUP_BLOCKED');
  assert.deepEqual(end.body.reasons, ['POSTING_IN_PROGRESS']);
  // after the end began, the worker's last check before it would send is refused (the entitlement is deleting)
  const check = await sql(`select postona_x_resv.pre_publish_check('${p.reservations[0]}'::uuid, (select lease_token from postona_x_resv.reservations where id = '${p.reservations[0]}'::uuid))`, db);
  assert.equal(check, 'NOT_PUBLISHABLE');
  assert.deepEqual(net.xCalls, []);
  assert.equal(await entitlement(db, p.user), 'deleting');
});

// ---- randomized interleavings of the real functions of the three stacks ---------------------------------------------
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const kindOfText = (text: string): Seen['kind'] =>
  /deadlock detected/u.test(text) ? 'deadlock' : /lock timeout|canceling statement/u.test(text) ? 'lock_timeout' : /_BUSY/u.test(text) ? 'busy' : /^OK/u.test(text) ? 'ok' : 'refused';

test('O5 randomized interleavings (seeded): the end against reservation writers, Threads writers, the legacy saga, the worker and the whole-account delete -- no deadlock, no raw lock timeout, a coherent end state', { skip: !enabled || !ORDER }, async () => {
  const db = ORDER;
  const rnd = prng(20261013);
  const jitter = async <T>(fn: () => Promise<T>, max = 90): Promise<T> => { await sleep(Math.floor(rnd() * max)); return await fn(); };
  const deadlocksOf = async () => { await sleep(1300); return Number(await sql(`select deadlocks from pg_stat_database where datname = current_database()`, db)); };
  const deadlocksBefore = await deadlocksOf();
  const census: Record<string, number> = { ok: 0, refused: 0, busy: 0, deadlock: 0, lock_timeout: 0 };
  const problems: string[] = [];
  let legacyDeadlocks = 0;
  const tally = (label: string, kind: Seen['kind'], text: string, legacy = false) => {
    census[kind]++;
    if (kind === 'deadlock' && legacy) { legacyDeadlocks++; return; }
    if (kind === 'deadlock' || kind === 'lock_timeout') problems.push(`${label}: ${kind}: ${text}`);
  };
  const maxWaiters = { value: 0 };
  let polling = true;
  const poller = (async () => {
    while (polling) {
      maxWaiters.value = Math.max(maxWaiters.value, Number(await sql(`select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`, db)));
      await sleep(40);
    }
  })();
  const { net: bnet } = setup(db);
  const by = await bystanderOf(db, bnet);

  // Each writer keeps its transaction (and so its locks, to COMMIT: the contract of both stacks) open for a random
  // 0-0.4 s after its statement: the windows the interleavings can land in are widened on purpose.
  const hold = () => Math.round(rnd() * 400) / 1000;
  const reservationWriters = (p: Person, round: number) => [
    jitter(() => asResvApi(db, p.user, createBatchSql(p.xAccount, `s${round}`, 5 + (round % 20)), hold())),
    jitter(() => asResvApi(db, p.user, `select count(*)::text from postona_x_resv.reschedule('${p.reservations[0]}'::uuid, 1, now() + interval '${6 + (round % 10)} days')`, hold())),
    jitter(() => asResvApi(db, p.user, `select count(*)::text from postona_x_resv.cancel('${p.reservations[1]}'::uuid, 1)`, hold())),
    jitter(() => asResvApi(db, p.user, `select count(*)::text from postona_x_resv.list_reservations(${q(p.xAccount)})`, hold())),
  ];
  const endUntilDone = async (handler: (req: Request) => Promise<Response>, p: Person, body: Record<string, unknown>, done: (r: { status: number; body: Record<string, unknown> }) => boolean) => {
    let last = { status: 0, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 5; attempt++) {
      last = await call(handler, p.user, body);
      if (done(last)) return last;
      await sleep(150);
    }
    return last;
  };

  const ROUNDS = 30;
  for (let round = 0; round < ROUNDS; round++) {
    const kind = ['A reservation writers', 'B Threads writers', 'C legacy saga', 'D whole account', 'E worker'][round % 5];
    const label = `round ${round} (${kind})`;
    const { net, handler, fetch } = setup(db);
    const wholeBody = async (p: Person) => ({
      action: 'delete_common_account', confirmation: 'DELETE_COMMON_ACCOUNT', ...ACK,
      expected_lifecycle_version: Number(await sql(`select lifecycle_version from public.common_accounts where user_id = '${p.user}'`, db)),
    });
    if (round % 5 === 0) { // A
      const p = await person(db, net, { threads: false, kabumori: true, tag: `st${round}` });
      await makePublishable(db, p.workspace);
      const [end, ...writers] = await Promise.all([jitter(() => call(handler, p.user, END)), ...reservationWriters(p, round)]);
      for (const w of writers as Seen[]) tally(label, w.kind, w.text);
      const done = (end as { status: number }).status === 200 ? end as { status: number; body: Record<string, unknown> } : await endUntilDone(handler, p, END, (r) => r.status === 200);
      assert.equal(done.status, 200, `${label}: ${JSON.stringify(done.body)}`);
      assert.equal(await entitlement(db, p.user), 'ended', label);
      assert.equal(await openReservations(db, p.workspace), 0, `${label}: nothing planned or claimed remains`);
      assert.equal(net.xCalls.length, 2, `${label}: X revoked once each`);
    } else if (round % 5 === 1) { // B
      const p = await person(db, net, { threads: true, kabumori: true, tag: `st${round}` });
      const u = p.user;
      const threadsWrite = async (statement: string) => {
        const text = await sql(`select t13.call('${u}'::uuid, ${q(statement)}, 'owner'); select pg_sleep(${hold()})`, db);
        return { kind: kindOfText(text), text };
      };
      const [end, ...writers] = await Promise.all([
        jitter(() => call(handler, u, { ...END, ...ACK })),
        jitter(async () => {
          const text = (await sql(`select coalesce((select 'OK ' || t13.complete_oauth('${u}'::uuid, t13.begin_oauth('${u}'::uuid, 'rc${round}'), 'rc${round}')), 'none'); select pg_sleep(${hold()})`, db).catch((e: Error) => `ERR ${e.message}`)).split('\n')[0];
          return { kind: kindOfText(text), text };
        }),
        jitter(() => threadsWrite(`select public.begin_social_mobile_threads_oauth_connection(t13.h('x${round}'), 'https://postona.example/threads/callback', now() + interval '9 minutes')`)),
        jitter(async () => {
          const out = (await sql(`select coalesce(t13.as_user('${u}'::uuid, 'disconnect', ${q(p.threadsAccount ?? '')}, gen_random_uuid()::text)::text, 'null'); select pg_sleep(${hold()})`, db).catch((e: Error) => `ERR ${e.message}`)).split('\n')[0];
          return { kind: kindOfText(out), text: out };
        }),
      ]);
      for (const w of writers as Seen[]) tally(label, w.kind, w.text);
      const first = end as { status: number; body: Record<string, unknown> };
      const done = first.status === 200 ? first : await endUntilDone(handler, p, { ...END, ...ACK }, (r) => r.status === 200);
      assert.equal(done.status, 200, `${label}: ${JSON.stringify(done.body)}`);
      assert.equal(await entitlement(db, p.user), 'ended', label);
      assert.equal(await accountsLeft(db, p.workspace), 0, `${label}: the workspace (X and Threads) is gone`);
    } else if (round % 5 === 2) { // C
      const p = await person(db, net, { threads: false, kabumori: true, tag: `st${round}` });
      await makePublishable(db, p.workspace);
      const saga = () => fetch(`${URL_BASE}/functions/v1/social-mobile-account-delete`, {
        method: 'POST', headers: { authorization: `Bearer ${tokenOf(p.user)}`, apikey: KEYS.anon, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'delete', ...xServiceEndRequest() }),
      }).then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
      const [first, ...writers] = await Promise.all([jitter(saga), ...reservationWriters(p, round)]);
      for (const w of writers as Seen[]) tally(label, w.kind, w.text, true);
      let result = first as { status: number; body: Record<string, unknown> };
      for (let attempt = 0; attempt < 4 && result.status !== 200; attempt++) { await sleep(150); result = await saga(); }
      assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
      assert.equal(await accountsLeft(db, p.workspace), 0, `${label}: purged`);
      assert.equal(await openReservations(db, p.workspace), 0, `${label}: nothing planned or claimed remains`);
    } else if (round % 5 === 3) { // D
      const p = await person(db, net, { threads: true, kabumori: true, tag: `st${round}` });
      await makePublishable(db, p.workspace);
      const [first, ...writers] = await Promise.all([jitter(async () => call(handler, p.user, await wholeBody(p))), ...reservationWriters(p, round)]);
      for (const w of writers as Seen[]) tally(label, w.kind, w.text);
      let result = first as { status: number; body: Record<string, unknown> };
      for (let attempt = 0; attempt < 5 && result.status !== 200; attempt++) { await sleep(150); result = await call(handler, p.user, await wholeBody(p)); }
      assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
      assert.equal(await count(db, `select count(*) from auth.users where id = '${p.user}'`), 0, `${label}: the login is gone`);
      assert.equal(await count(db, `select count(*) from postona_x_resv.reservations where user_id = '${p.user}'`), 0, `${label}: no reservation of the person remains`);
    } else { // E
      const p = await person(db, net, { threads: false, kabumori: true, tag: `st${round}` });
      await makePublishable(db, p.workspace);
      await sql(`update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute'
                  where id = '${p.reservations[0]}'::uuid`, db);
      const [end, claim] = await Promise.all([
        jitter(() => call(handler, p.user, END), 200),
        jitter(async () => { const r = await psql(`select count(*) from postona_x_resv.claim_due('worker-${round}', 60, 5)`, db); return seenOf(r); }, 200),
      ]);
      tally(label, (claim as Seen).kind, (claim as Seen).text);
      const claimedRows = await count(db, `select count(*) from postona_x_resv.reservations where id = '${p.reservations[0]}'::uuid and status = 'claimed'`);
      if (claimedRows === 1) {
        // the worker won: the end is blocked with a typed reason, nothing was sent, and the last check before a send says no
        const state = await entitlement(db, p.user);
        if (state === 'deleting') {
          const check = await sql(`select postona_x_resv.pre_publish_check('${p.reservations[0]}'::uuid, (select lease_token from postona_x_resv.reservations where id = '${p.reservations[0]}'::uuid))`, db);
          assert.notEqual(check, 'OK', `${label}: a claimed row must not pass the last check while the end is open`);
        }
        assert.equal(net.xCalls.length, 0, `${label}: X was not revoked with a post in flight`);
        // the last check marked the row failed (never sent); a row that is still claimed is released by its lease holder
        if (await count(db, `select count(*) from postona_x_resv.reservations where id = '${p.reservations[0]}'::uuid and status = 'claimed'`) === 1) {
          await sql(`select postona_x_resv.finish('${p.reservations[0]}'::uuid, (select lease_token from postona_x_resv.reservations where id = '${p.reservations[0]}'::uuid), 'failed_before_send', null, 'TEST_RELEASE')`, db);
        }
      }
      const done = (end as { status: number }).status === 200 && claimedRows === 0
        ? end as { status: number; body: Record<string, unknown> }
        : await endUntilDone(handler, p, END, (r) => r.status === 200);
      assert.equal(done.status, 200, `${label}: ${JSON.stringify(done.body)}`);
      assert.equal(await entitlement(db, p.user), 'ended', label);
      assert.equal(await openReservations(db, p.workspace), 0, label);
    }
    const rpcDeadlocks = net.rpcErrors.filter((m) => /deadlock/u.test(m));
    if (round % 5 === 2) legacyDeadlocks += rpcDeadlocks.length;   // the legacy saga path: finding F3-L1 (see O6)
    else assert.deepEqual(rpcDeadlocks, [], `${label}: no deadlock inside a Data API call of the F5 flow`);
    assert.deepEqual(net.rpcErrors.filter((m) => /lock timeout/u.test(m)), [], `${label}: no raw lock timeout inside a Data API call`);
    assert.deepEqual(net.unrouted, [], label);
  }
  polling = false;
  await poller;
  const deadlocksAfter = await deadlocksOf();
  await by.same('O5');
  console.log('O5 observed: ' + JSON.stringify({ rounds: ROUNDS, seed: 20261013, writerAnswers: census, maxConcurrentLockWaiters: maxWaiters.value,
    deadlocksReportedByDatabase: deadlocksAfter - deadlocksBefore, deadlocksInLegacySagaRounds: legacyDeadlocks }));
  assert.deepEqual(problems, []);
  assert.equal(deadlocksAfter - deadlocksBefore, legacyDeadlocks, 'every deadlock the database reports happened on the legacy saga path (finding F3-L1), none in the F5 flow');
  assert.ok(maxWaiters.value >= 1, 'the interleavings produced real lock waits (otherwise this run proves nothing)');
});

// ---- finding F3-L1: the legacy saga stop against two reservation writers (a three-way lock cycle) -------------------
/**
 * Three real functions and one holder, in a fixed order:
 *   stop   F3's social_mobile_account_deletion_stop_x     social_accounts row FOR UPDATE -> authority row -> reservation rows
 *   create F3's postona_x_resv.create_batch               G5 locks (account FOR UPDATE) -> INSERT: FK key-share on social_accounts
 *   cancel F3's postona_x_resv.cancel (lock_own)          reservation row FOR UPDATE -> G5 locks (account FOR UPDATE)
 * A holder keeps the authority row so that the stop is parked WITH the social_accounts lock; on its release the
 * stop wants the reservation row the cancel holds; the cancel wants the account lock the create holds; the create
 * wants the social_accounts row the stop holds.
 */
async function sagaStopAgainstWriters(db: string, tag: string) {
  const { net } = setup(db);
  const p = await person(db, net, { threads: false, kabumori: true, tag });
  await makePublishable(db, p.workspace);
  const acquired = JSON.parse((await asService(db, `select to_jsonb(public.social_mobile_account_deletion_acquire('${p.user}'::uuid, 'social_only', false))`)).text) as { status: string; lease: string };
  assert.equal(acquired.status, 'acquired');
  const dbDeadlocks = async () => { await sleep(1300); return Number(await sql(`select deadlocks from pg_stat_database where datname = current_database()`, db)); };
  const before = await dbDeadlocks();
  const holder = psql(`begin; select 1 from public.x_account_publish_authority where social_account_id = ${q(p.xAccount)} for update; select pg_sleep(1.2); commit;`, db);
  await sleep(250);
  const stop = asService(db, `select to_jsonb(public.social_mobile_account_deletion_stop_x('${p.user}'::uuid, '${acquired.lease}'::uuid))`);
  await sleep(250);
  const create = asResvApi(db, p.user, createBatchSql(p.xAccount, `dl-${tag}`, 6));
  await sleep(250);
  const cancel = asResvApi(db, p.user, `select count(*)::text from postona_x_resv.cancel('${p.reservations[0]}'::uuid, 1)`);
  const [, stopped, created, cancelled] = await Promise.all([holder, stop, create, cancel]);
  const after = await dbDeadlocks();
  return { p, stopped, created, cancelled, deadlocks: after - before,
    states: await reservationStates(db, p.workspace), authorityState: await authority(db, p.xAccount) };
}

test('O6 FINDING F3-L1 (pinned): the legacy saga stop, a reservation create and an owner cancel form a three-way lock cycle; the database aborts one (fail-closed, retryable)', { skip: !enabled || !ORDER }, async () => {
  const r = await sagaStopAgainstWriters(ORDER, 'o6');
  const kinds = [r.stopped.kind, r.created.kind, r.cancelled.kind];
  console.log('O6 observed: ' + JSON.stringify({ stop: r.stopped, create: r.created, cancel: r.cancelled, deadlocks: r.deadlocks, states: r.states, authority: r.authorityState }));
  assert.equal(r.deadlocks, 1, 'the database reports exactly one deadlock');
  assert.equal(kinds.filter((k) => k === 'deadlock').length, 1, `exactly one of the three is the victim: ${JSON.stringify(kinds)}`);
  // fail-closed: nothing half-done. Either the stop ran (authority revoked, every planned row cancelled) or it was the victim
  // and rolled back as a whole (authority enabled, rows as they were) -- and a retry of the stop is idempotent.
  if (r.stopped.kind === 'deadlock') assert.equal(r.authorityState, 'enabled', 'the aborted stop left nothing behind');
  else assert.equal(r.authorityState, 'revoked');
});

test('O7 the repair (F3\'s lock_own takes G5\'s locks BEFORE the reservation row, proof overlay): the same three sessions complete, no deadlock', { skip: !enabled || !Deno.env.get('PGDATABASE_ORDER_FIX') }, async () => {
  const r = await sagaStopAgainstWriters(Deno.env.get('PGDATABASE_ORDER_FIX')!, 'o7');
  console.log('O7 observed: ' + JSON.stringify({ stop: r.stopped, create: r.created, cancel: r.cancelled, deadlocks: r.deadlocks, states: r.states, authority: r.authorityState }));
  assert.equal(r.deadlocks, 0);
  assert.deepEqual([r.stopped.kind, r.created.kind].filter((k) => k === 'deadlock'), []);
  assert.notEqual(r.cancelled.kind, 'deadlock');
  assert.equal(r.stopped.kind, 'ok', JSON.stringify(r.stopped));
  assert.equal(r.authorityState, 'revoked');
});

// ---- rollback of Phase 8 under running code ------------------------------------------------------------------------
// PGDATABASE_P8_ROLLED_BACK = the granted world after the Phase 8 rollback (the two functions are gone, the column stays).
// "Code first, then the migration" is the rollback order; these two show what each side does when it is not followed.
const ROLLED_BACK = Deno.env.get('PGDATABASE_P8_ROLLED_BACK') ?? '';
test('R1 the Phase 8 code on a database whose Phase 8 was rolled back: an end stops before anything is touched, X and Threads are intact', { skip: !enabled || !ROLLED_BACK }, async () => {
  const db = ROLLED_BACK;
  const { net, handler } = setup(db);
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'rb1' });
  const response = await call(handler, p.user, { ...END, ...ACK });
  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'FAILED');
  assert.deepEqual(net.xCalls, [], 'no X revoke');
  assert.ok(!net.sagaActions.includes('delete'), 'the saga did not run');
  assert.equal(await accountsLeft(db, p.workspace), 2, 'X and Threads are intact');
  assert.equal(await authority(db, p.xAccount), 'enabled');
  assert.ok(net.rpcErrors.some((m) => /common_account_service_end_result/u.test(m)), 'the missing read is what stopped it');
  assert.equal(await operation(db, p.user).then((o) => o?.leased), false, 'the lease was given back');
});

test('R2 the Phase 7 code (before Phase 8) on a database whose Phase 8 was rolled back: the same flows work', { skip: !enabled || !ROLLED_BACK }, async () => {
  const db = ROLLED_BACK;
  const p7 = await import('../functions/account-delete-p7/http.ts');
  const { net, fetch } = makeNet(db);
  const handler = p7.createHandler(env, fetch) as (req: Request) => Promise<Response>;
  const p = await person(db, net, { threads: true, kabumori: true, tag: 'rb2' });
  const response = await call(handler, p.user, { ...END, ...ACK });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body, { ok: true, outcome: 'ended', providers: { threads: 'local_removed_remote_unverified', x: 'done' }, remote_unverified: ['threads'] });
  assert.equal(net.xCalls.length, 2);
  assert.equal(await entitlement(db, p.user), 'ended');
  assert.deepEqual(net.rpcErrors, [], 'the older code never asks for what the rollback removed');
});
