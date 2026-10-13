// End to end on a DISPOSABLE local PostgreSQL, in the SOURCE OVERLAY of supabase/tests/common_account_phase6_overlay_run.sh:
//
//   * G5's REAL orchestrator (supabase/functions/account-delete/lifecycle_logic.ts) and REAL registration
//     (provider_registry.ts = the Threads registration candidate),
//   * F4's REAL adapter and RPC store (supabase/functions/_shared/social/threads_provider_cleanup.ts, PR #169),
//   * F4's REAL SQL (Threads cleanup, disconnect, publish stack, writer guards) and G5's REAL Phase 1..6 SQL,
//     on the PostgreSQL the runner built.
//
// STAND-INS (each one SQL statement, named; never in a candidate): the Data API (PostgREST) = the fetch below runs
// `select to_jsonb(public.<fn>(<uuid>))` as role service_role through psql for the two functions the store calls and
// answers 403 when the database refuses; Auth logout / Storage / the managed Auth Admin delete as in the Phase 4
// e2e; the X saga (G3/F3's) = deletes the workspace rows the footprint reads, and answers `blocked` like the real
// saga when a non-X social account is still in the workspace.
//
// Needs CAL_E2E=1, PGHOST / PGPORT / PGUSER and PGDATABASE (the grant applied), PGDATABASE_NOGRANT (not applied).
import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC_NAMES } from '../functions/account-delete/http.ts';
import { bearer, deleteBody, NOW, signIn } from '../functions/account-delete/fake_lifecycle.ts';
import {
  END_POSTONA_CONFIRMATION,
  handleDeleteCommonAccount,
  handleWithdrawPostona,
  type LifecycleDeps,
  type LifecycleResponse,
  type RpcResult,
  type XCleanupOutcome,
} from '../functions/account-delete/lifecycle_logic.ts';
import { providerRegistration } from '../functions/account-delete/provider_registry.ts';

const enabled = Deno.env.get('CAL_E2E') === '1';
const decoder = new TextDecoder();
const GRANTED = Deno.env.get('PGDATABASE') ?? '';
const NOT_GRANTED = Deno.env.get('PGDATABASE_NOGRANT') ?? '';
const SERVICE_KEY = 'overlay-service-key-stand-in';

async function sql(statement: string, db = GRANTED): Promise<string> {
  const out = await new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement],
    env: {
      PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: Deno.env.get('PGUSER') ?? '',
      PGDATABASE: db, LC_ALL: 'C',
    },
    stdout: 'piped', stderr: 'piped',
  }).output();
  if (!out.success) throw new Error(decoder.decode(out.stderr).trim());
  return decoder.decode(out.stdout).trim();
}
const literal = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array[${value.map((item) => `'${String(item).replaceAll("'", "''")}'`).join(',')}]::text[]`;
  return `'${String(value).replaceAll("'", "''")}'`;
};
const asPerson = (user: string, statement: string) =>
  `begin; set local request.jwt.claim.sub = '${user}'; set local request.jwt.claim.role = 'authenticated'; set local role authenticated; ${statement}; commit;`;

let counter = 0;
const newUser = () => `00000000-0000-4000-8000-${String(970_000 + ++counter).padStart(12, '0')}`;

/** A registered person with a verified Threads connection (F4's own fixture; the real OAuth functions). */
async function threadsPerson(db: string, tag: string, options: { kabumori?: boolean } = {}): Promise<{ user: string; account: string }> {
  const user = newUser();
  const account = await sql(`select t13.person('${user}'::uuid, 'p6_${tag}')`, db);
  if (options.kabumori) {
    const answer = JSON.parse(await sql(asPerson(user, 'select to_jsonb(public.start_kabumori_service())'), db));
    assert.equal(answer.status, 'active');
  }
  return { user, account };
}

type Harness = {
  events: string[];
  fetched: string[];
  deps: LifecycleDeps;
  /** What happens "meanwhile": after the connection read / after the removal committed (before its answer). */
  meanwhile: { afterConnectionState?: () => Promise<void>; afterCleanup?: () => Promise<void> };
  control: { dead: boolean; xOutcome: XCleanupOutcome };
};

function harness(db: string, user: string): Harness {
  const events: string[] = [];
  const fetched: string[] = [];
  const meanwhile: Harness['meanwhile'] = {};
  const control = { dead: false, xOutcome: 'done' as XCleanupOutcome };
  // The Data API stand-in for exactly the two functions F4's store calls.
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const fn = url.pathname.replace('/rest/v1/rpc/', '');
    const headers = new Headers(init?.headers);
    if (headers.get('apikey') !== SERVICE_KEY || headers.get('authorization') !== `Bearer ${SERVICE_KEY}`) {
      return new Response('{"message":"invalid credential"}', { status: 401 });
    }
    if (fn !== 'threads_provider_connection_state' && fn !== 'cleanup_threads_provider_footprint') {
      return new Response('{"message":"not found"}', { status: 404 });
    }
    const requestBody = JSON.parse(String(init?.body));
    fetched.push(fn);
    try {
      const out = await sql(`begin; set local role service_role; select to_jsonb(public.${fn}(${literal(requestBody.p_user_id)}::uuid)); commit;`, db);
      if (fn === 'threads_provider_connection_state') await meanwhile.afterConnectionState?.();
      else await meanwhile.afterCleanup?.();
      return new Response(out, { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (failure) {
      const message = String((failure as Error).message);
      return new Response(JSON.stringify({ message }), { status: /permission denied/u.test(message) ? 403 : 400 });
    }
  };
  const registration = providerRegistration({ supabaseUrl: 'http://data-api.stand-in', serviceKey: SERVICE_KEY, fetchImpl });
  const deps: LifecycleDeps = {
    getUser: async () => ({ id: user, providers: ['email'], appleSubjects: [] }),
    rpc: async (name, args): Promise<RpcResult> => {
      if (control.dead) { events.push(`rpc:${name}:process-gone`); return { ok: false }; }
      const named = Object.entries(args).map(([key, value]) => `${key} => ${literal(value)}`).join(', ');
      try {
        const out = await sql(`begin; set local role service_role; select to_jsonb(public.${RPC_NAMES[name]}(${named})); commit;`, db);
        events.push(`rpc:${name}`);
        return { ok: true, data: JSON.parse(out) };
      } catch {
        events.push(`rpc:${name}:error`);
        return { ok: false };
      }
    },
    revokeSessions: async () => { events.push('auth:logout'); await sql(`delete from auth.sessions where user_id = '${user}'`, db); return true; },
    removeStorageObjects: async () => true,
    revokeApple: null,
    x: {
      preview: async () => ({ scope: 'social_only', state: 'none' }),
      run: async () => {
        events.push('x:saga');
        if (control.xOutcome !== 'done') return control.xOutcome;
        const workspace = `public.social_mobile_account_deletion_workspace('${user}'::uuid)`;
        // The real saga sends a non-X social account to an operator: the stand-in does the same.
        const foreign = await sql(`select count(*) from public.social_accounts where brand_id = ${workspace} and platform <> 'x'`, db);
        if (foreign !== '0') return 'blocked';
        await sql(`delete from public.social_account_oauth_states where brand_id = ${workspace} or initiated_by_user_id = '${user}';
                   delete from public.social_accounts where brand_id = ${workspace};
                   delete from public.brand_memberships where brand_id = ${workspace};
                   delete from public.brands where id = ${workspace}`, db);
        return 'done';
      },
    },
    providers: registration.adapters,
    providerRemoteRevoke: registration.remoteRevoke,
    deleteLogin: async () => {
      events.push('auth:delete');
      try { await sql(`delete from auth.users where id = '${user}'`, db); return 'deleted'; } catch { return 'failed'; }
    },
    loginState: async () => ((await sql(`select exists (select 1 from auth.users where id = '${user}')`, db)) === 't' ? 'present' : 'absent'),
    nowSeconds: () => NOW,
  };
  return { events, fetched, deps, meanwhile, control };
}

const withdraw = (user: string, h: Harness, extra: Record<string, unknown> = {}) =>
  handleWithdrawPostona(
    { authorization: bearer(signIn(NOW - 60, user)), body: { confirmation: END_POSTONA_CONFIRMATION, ...extra } },
    h.deps,
  );
const errorOf = (response: LifecycleResponse) => (response.body.ok ? null : response.body.error);
const threadsRows = (db: string, user: string) =>
  sql(`select count(*) from public.social_accounts where brand_id = public.social_mobile_account_deletion_workspace('${user}'::uuid) and platform = 'threads'`, db);
const entitlement = (db: string, user: string, service: string) =>
  sql(`select coalesce((select status from public.service_entitlements where user_id = '${user}' and service_key = '${service}'), 'none')`, db);
const operation = async (db: string, user: string) =>
  JSON.parse(await sql(`select coalesce((select jsonb_build_object('status', status, 'leased', owner_lease is not null, 'results', provider_results,
                                                 'ack', coalesce(remote_unverified_ack_providers, '{}'::text[]))
                         from private.account_lifecycle_operations
                        where user_id = '${user}' and operation_type = 'service_deletion' and service_key = 'x_autopost'
                        order by updated_at desc limit 1), 'null'::jsonb)`, db));
const secretsOf = (db: string, account: string) =>
  sql(`select count(*) from vault.secrets s join public.social_accounts a on a.vault_access_token_secret_id = s.id where a.id = '${account}'`, db);
const expireLease = (db: string, user: string) =>
  sql(`update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 second'
        where user_id = '${user}' and operation_type = 'service_deletion' and status = 'in_progress'`, db);

if (enabled && (!GRANTED || !NOT_GRANTED)) throw new Error('PGDATABASE and PGDATABASE_NOGRANT are required');

test('registration: F4 module is registered, Threads is "unsupported" remote revoke', { skip: !enabled }, () => {
  const registration = providerRegistration({ supabaseUrl: 'http://x', serviceKey: 'k', fetchImpl: fetch });
  assert.deepEqual(registration.adapters.map((a) => a.provider), ['threads']);
  assert.deepEqual(registration.remoteRevoke, { threads: 'unsupported' });
});

test('O1: before the grant the database refuses the adapter, which fails closed: nothing is removed, no X saga', { skip: !enabled }, async () => {
  const { user, account } = await threadsPerson(NOT_GRANTED, 'nogrant');
  const h = harness(NOT_GRANTED, user);
  const response = await withdraw(user, h, { acknowledged_remote_unverified: ['threads'] });
  assert.equal(errorOf(response), 'RECONCILIATION_REQUIRED');
  assert.deepEqual(h.fetched, ['threads_provider_connection_state'], 'the removal function was never reached');
  assert.equal(await threadsRows(NOT_GRANTED, user), '1');
  assert.equal(await secretsOf(NOT_GRANTED, account), '1', 'the credential is still there');
  assert.ok(!h.events.includes('x:saga'), 'X is not touched when the provider could not be read');
  assert.equal(await entitlement(NOT_GRANTED, user, 'x_autopost'), 'deleting', 'not ended, not silently reverted');
  const op = await operation(NOT_GRANTED, user);
  assert.equal(op.status, 'in_progress');
  assert.equal(op.leased, false, 'the lease is given back');
  assert.equal(op.results.threads, 'reconciliation_required');
});

test('O2: without the acknowledgement nothing changes at all (the person is told what stays)', { skip: !enabled }, async () => {
  const { user } = await threadsPerson(GRANTED, 'noack', { kabumori: true });
  const h = harness(GRANTED, user);
  const response = await withdraw(user, h);
  assert.equal(errorOf(response), 'REMOTE_UNVERIFIED_ACK_REQUIRED');
  assert.deepEqual(response.body, { ok: false, error: 'REMOTE_UNVERIFIED_ACK_REQUIRED', providers: [{ provider: 'threads', result: 'pending' }] });
  assert.equal(await threadsRows(GRANTED, user), '1');
  assert.equal(await entitlement(GRANTED, user, 'x_autopost'), 'active');
  assert.equal(await operation(GRANTED, user), null, 'no operation was begun');
  assert.deepEqual(h.fetched, [], 'not even a read of the provider happened');
});

test('O3: POSTONA alone, acknowledged: Threads and X are both accounted for, Kabumori and other people are untouched', { skip: !enabled }, async () => {
  const bystander = await threadsPerson(GRANTED, 'bystander');
  const { user, account } = await threadsPerson(GRANTED, 'alone', { kabumori: true });
  const h = harness(GRANTED, user);
  const response = await withdraw(user, h, { acknowledged_remote_unverified: ['threads'] });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body, {
    ok: true, outcome: 'ended',
    providers: { threads: 'local_removed_remote_unverified', x: 'done' },
    remote_unverified: ['threads'],
  });
  assert.equal(await threadsRows(GRANTED, user), '0');
  assert.equal(await secretsOf(GRANTED, account), '0');
  assert.equal(await entitlement(GRANTED, user, 'x_autopost'), 'ended');
  assert.equal(await entitlement(GRANTED, user, 'kabumori'), 'active', 'the other service keeps its entitlement');
  assert.equal(await sql(`select count(*) from auth.users where id = '${user}'`), '1', 'the login is kept');
  const op = await operation(GRANTED, user);
  assert.deepEqual([op.status, op.leased, op.ack], ['completed', false, ['threads']]);
  // Order: the acknowledgement is recorded before the removal, providers before X, the end last.
  const order = ['rpc:begin_service_deletion', 'rpc:claim_service', 'rpc:acknowledge_unverified', 'x:saga', 'rpc:finish_owned_service'].map((e) => h.events.indexOf(e));
  assert.ok(order.every((index) => index >= 0), `every step ran: ${h.events}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.deepEqual(h.fetched, ['threads_provider_connection_state', 'cleanup_threads_provider_footprint']);
  // Another person's connection, entitlement and credential were not touched.
  assert.equal(await threadsRows(GRANTED, bystander.user), '1');
  assert.equal(await entitlement(GRANTED, bystander.user, 'x_autopost'), 'active');
  assert.equal(await secretsOf(GRANTED, bystander.account), '1');
  assert.equal(await operation(GRANTED, bystander.user), null);
});

test('O4: a lease lost between the read and the removal: the adapter sends nothing; a retry then ends it', { skip: !enabled }, async () => {
  const { user, account } = await threadsPerson(GRANTED, 'leaselost');
  const h = harness(GRANTED, user);
  h.meanwhile.afterConnectionState = async () => {
    // The lease ran out / another owner took over while this request was between its read and its removal.
    h.meanwhile.afterConnectionState = undefined;
    await expireLease(GRANTED, user);
  };
  const first = await withdraw(user, h, { acknowledged_remote_unverified: ['threads'] });
  assert.equal(errorOf(first), 'DELETION_IN_PROGRESS');
  assert.deepEqual(h.fetched, ['threads_provider_connection_state'], 'the removal was never sent');
  assert.equal(await threadsRows(GRANTED, user), '1');
  assert.equal(await secretsOf(GRANTED, account), '1');
  assert.ok(!h.events.includes('x:saga'));
  assert.equal(await entitlement(GRANTED, user, 'x_autopost'), 'deleting');
  const retry = await withdraw(user, harness(GRANTED, user), { acknowledged_remote_unverified: ['threads'] });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(await threadsRows(GRANTED, user), '0');
  assert.equal(await entitlement(GRANTED, user, 'x_autopost'), 'ended');
});

test('O5: a crash after the removal committed: the lease blocks others, a takeover completes it and the remote grant stays unverified', { skip: !enabled }, async () => {
  const { user } = await threadsPerson(GRANTED, 'crash');
  const crashing = harness(GRANTED, user);
  // The process dies once F4's removal committed: no answer is recorded, the lease is not given back.
  crashing.meanwhile.afterCleanup = async () => { crashing.control.dead = true; };
  const first = await withdraw(user, crashing, { acknowledged_remote_unverified: ['threads'] });
  assert.equal(first.status, 409);
  assert.equal(await threadsRows(GRANTED, user), '0', 'the removal committed');
  let op = await operation(GRANTED, user);
  assert.equal(op.leased, true, 'the dead process still holds the lease');
  assert.equal(op.results.threads, 'pending', 'its answer was never recorded');
  assert.deepEqual(op.ack, ['threads'], 'but the acknowledgement was recorded BEFORE the removal');
  // Another request while the lease is live: refused, nothing is done twice.
  const other = harness(GRANTED, user);
  const second = await withdraw(user, other, { acknowledged_remote_unverified: ['threads'] });
  assert.equal(errorOf(second), 'DELETION_IN_PROGRESS');
  assert.deepEqual(other.fetched, []);
  assert.equal(await entitlement(GRANTED, user, 'x_autopost'), 'deleting');
  // The lease ends; the retry takes over, re-reads the provider (nothing left), runs X and ends.
  await expireLease(GRANTED, user);
  const response = await withdraw(user, harness(GRANTED, user), { acknowledged_remote_unverified: ['threads'] });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body, {
    ok: true, outcome: 'ended', providers: { threads: 'not_connected', x: 'done' }, remote_unverified: ['threads'],
  });
  op = await operation(GRANTED, user);
  assert.deepEqual([op.status, op.leased], ['completed', false]);
  assert.equal(await entitlement(GRANTED, user, 'x_autopost'), 'ended');
});

test('O6: a post that may be in flight is never deleted into "not posted"; disconnect is refused; settled, a retry ends it', { skip: !enabled }, async () => {
  await sql(`create or replace function public.threads_disconnect_gate_open() returns boolean language sql immutable set search_path = '' as $$ select true $$`);
  const { user, account } = await threadsPerson(GRANTED, 'inflight');
  const begun = JSON.parse(await sql(`select to_jsonb(t13.as_user('${user}'::uuid, 'begin', '${account}', '${crypto.randomUUID()}', 'overlay'))`));
  assert.equal(begun.status, 'reserved', JSON.stringify(begun));
  const attempt: string = begun.attempt.attempt_id;
  const released = JSON.parse(await sql(`select to_jsonb(t13.release('${user}'::uuid, '${attempt}'::uuid, 'create_container'))`));
  assert.equal(released.status, 'released', JSON.stringify(released));

  const h = harness(GRANTED, user);
  const first = await withdraw(user, h, { acknowledged_remote_unverified: ['threads'] });
  assert.equal(errorOf(first), 'RECONCILIATION_REQUIRED');
  assert.equal(await threadsRows(GRANTED, user), '1', 'nothing was removed');
  assert.equal(await sql(`select count(*) from public.threads_manual_publish_attempts where id = '${attempt}'`), '1', 'the attempt record is kept');
  assert.ok(!h.events.includes('x:saga'));
  assert.equal(await entitlement(GRANTED, user, 'x_autopost'), 'deleting');
  assert.equal((await operation(GRANTED, user)).results.threads, 'reconciliation_required');
  // The person's own Threads disconnect is refused while the deletion owns the removal (F4's policy on G5's decision).
  const disconnect = JSON.parse(await sql(`select to_jsonb(t13.as_user('${user}'::uuid, 'disconnect', '${account}', '${crypto.randomUUID()}'))`));
  assert.deepEqual(disconnect, { code: 'ACCOUNT_LIFECYCLE_BLOCKED', status: 'refused' });
  assert.equal(await threadsRows(GRANTED, user), '1');
  // The person settles the facts of the post (recording stays possible); only then the retry removes.
  const recorded = JSON.parse(await sql(`select to_jsonb(t13.record('${user}'::uuid, '${attempt}'::uuid, 'create_container', '${released.grant}', 'failed', 'THREADS_UNAVAILABLE'))`));
  assert.equal(recorded.status, 'recorded', JSON.stringify(recorded));
  const retry = await withdraw(user, harness(GRANTED, user), { acknowledged_remote_unverified: ['threads'] });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(await threadsRows(GRANTED, user), '0');
  assert.equal(await entitlement(GRANTED, user, 'x_autopost'), 'ended');
});

test('O7: Threads removed, X blocked: nothing is ended; the unverified fact is kept; X done later ends it', { skip: !enabled }, async () => {
  const { user } = await threadsPerson(GRANTED, 'xblocked');
  const h = harness(GRANTED, user);
  h.control.xOutcome = 'blocked';
  const first = await withdraw(user, h, { acknowledged_remote_unverified: ['threads'] });
  assert.equal(errorOf(first), 'X_CLEANUP_BLOCKED');
  assert.equal(await threadsRows(GRANTED, user), '0', 'Threads was removed first');
  assert.equal(await entitlement(GRANTED, user, 'x_autopost'), 'deleting', 'pending / blocked is never success');
  let op = await operation(GRANTED, user);
  assert.deepEqual([op.results.threads, op.results.x, op.leased], ['local_removed_remote_unverified', 'blocked', false]);
  // The saga says it is still running: also not an end.
  const running = harness(GRANTED, user);
  running.control.xOutcome = 'in_progress';
  assert.equal(errorOf(await withdraw(user, running, { acknowledged_remote_unverified: ['threads'] })), 'X_CLEANUP_IN_PROGRESS');
  assert.equal(await entitlement(GRANTED, user, 'x_autopost'), 'deleting');
  // Later X is done: the retry ends, and the earlier unverified fact was not erased by "not connected".
  const done = await withdraw(user, harness(GRANTED, user), { acknowledged_remote_unverified: ['threads'] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body, {
    ok: true, outcome: 'ended', providers: { threads: 'local_removed_remote_unverified', x: 'done' }, remote_unverified: ['threads'],
  });
  op = await operation(GRANTED, user);
  assert.deepEqual([op.status, op.results.threads], ['completed', 'local_removed_remote_unverified']);
});

test('O8: the whole account: Threads, X and Kabumori are ended once, the acknowledgement is required first', { skip: !enabled }, async () => {
  await sql(`alter table private.account_lifecycle_release_gates drop constraint if exists account_lifecycle_release_gates_blocked_only;
             update private.account_lifecycle_release_gates set state = 'open'`);
  const { user } = await threadsPerson(GRANTED, 'whole', { kabumori: true });
  const version = async () => Number(await sql(`select lifecycle_version from public.common_accounts where user_id = '${user}'`));
  const remove = async (h: Harness, extra: Record<string, unknown> = {}) =>
    handleDeleteCommonAccount({ authorization: bearer(signIn(NOW - 60, user)), body: deleteBody(await version(), extra) }, h.deps);

  const refused = harness(GRANTED, user);
  const first = await remove(refused);
  assert.equal(errorOf(first), 'REMOTE_UNVERIFIED_ACK_REQUIRED');
  assert.equal(await threadsRows(GRANTED, user), '1');
  assert.equal(await sql(`select status from public.common_accounts where user_id = '${user}'`), 'active', 'nothing began');

  const h = harness(GRANTED, user);
  const response = await remove(h, { acknowledged_remote_unverified: ['threads'] });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((response.body as { outcome?: string }).outcome, 'deleted');
  assert.deepEqual((response.body as { providers?: unknown }).providers, { threads: 'local_removed_remote_unverified', x: 'done' });
  assert.deepEqual((response.body as { remote_unverified?: unknown }).remote_unverified, ['threads']);
  assert.equal(await sql(`select count(*) from auth.users where id = '${user}'`), '0');
  assert.equal(await sql(`select count(*) from public.social_accounts where platform = 'threads'
                            and brand_id = public.social_mobile_account_deletion_workspace('${user}'::uuid)`), '0');
});
