// Phase 7 (F5): the provider-state matrix of POSTONA's end, against the REAL SQL (Phase 1..6 chain) through psql, with
// G5's real orchestrator (account-delete/lifecycle_logic.ts, unmodified). Generic fake adapters stand in for providers
// (F4's real adapter is exercised in the Phase 6 overlay); the X saga is a one-statement stand-in. Fake data only.
//
// What it proves, for every case and as invariants:
//   I1  no fake success: `ok` implies the entitlement ended, the operation completed, every recorded answer settled,
//       and a provider is reported as confirmed-revoked ONLY when its adapter said so;
//   I2  nothing but a success ends the service or completes the operation;
//   I3  an unverified remote grant is never ended without the person's acknowledgement being on the record, and the
//       acknowledgement was recorded BEFORE the destructive call (checked inside the adapter);
//   I4  a lease that was lost (expired/taken over) means nothing is recorded or ended by the lost owner afterwards;
//   I5  other people's connections, entitlements and operations are untouched;
//   I6  Kabumori's entitlement is untouched by ending POSTONA.
// Needs CAL_E2E=1 and PGHOST / PGPORT / PGUSER / PGDATABASE of a disposable database with the whole chain applied
// (run by supabase/tests/common_account_release_preflight_run.sh).
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
import type { ProviderCleanupAdapter, ProviderOutcome } from '../functions/account-delete/provider_cleanup.ts';

const enabled = Deno.env.get('CAL_E2E') === '1';
const decoder = new TextDecoder();

async function sql(statement: string): Promise<string> {
  const out = await new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement],
    env: {
      PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: Deno.env.get('PGUSER') ?? '',
      PGDATABASE: Deno.env.get('PGDATABASE') ?? '', LC_ALL: 'C',
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
const newUser = () => `00000000-0000-4000-8000-${String(960_000 + ++counter).padStart(12, '0')}`;
const workspaceOf = (user: string) => `public.social_mobile_account_deletion_workspace('${user}'::uuid)`;

type Person = { user: string };
async function person(options: { threads: boolean; kabumori?: boolean }): Promise<Person> {
  const user = newUser();
  await sql(`select public.fixture_login('${user}'::uuid)`);
  assert.equal(JSON.parse(await sql(asPerson(user, 'select to_jsonb(public.start_x_autopost_service())'))).status, 'active');
  if (options.kabumori) assert.equal(JSON.parse(await sql(asPerson(user, 'select to_jsonb(public.start_kabumori_service())'))).status, 'active');
  await sql(`insert into public.brands (id, code_profile_key) values (${workspaceOf(user)}, 'social_mobile_user_v1') on conflict (id) do nothing;
             insert into public.brand_memberships (brand_id, user_id, role) values (${workspaceOf(user)}, '${user}', 'owner') on conflict do nothing`);
  if (options.threads) {
    await sql(`insert into public.social_accounts (id, brand_id, platform, handle)
               values ('threads_${user.slice(24)}', ${workspaceOf(user)}, 'threads', 'h')`);
  }
  return { user };
}
const threadsRows = async (user: string) =>
  Number(await sql(`select count(*) from public.social_accounts where brand_id = ${workspaceOf(user)} and platform = 'threads'`));
const entitlement = (user: string, service: string) =>
  sql(`select coalesce((select status from public.service_entitlements where user_id = '${user}' and service_key = '${service}'), 'none')`);
type OperationView = { status: string; leased: boolean; results: Record<string, string>; ack: string[] } | null;
const operation = async (user: string): Promise<OperationView> =>
  JSON.parse(await sql(`select coalesce((select jsonb_build_object('status', status, 'leased', owner_lease is not null and owner_lease_expires_at > clock_timestamp(),
                                                 'results', provider_results, 'ack', coalesce(remote_unverified_ack_providers, '{}'::text[]))
                         from private.account_lifecycle_operations
                        where user_id = '${user}' and operation_type = 'service_deletion' and service_key = 'x_autopost'
                        order by updated_at desc limit 1), 'null'::jsonb)`));
const expireLease = (user: string) =>
  sql(`update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 second'
        where user_id = '${user}' and operation_type = 'service_deletion' and status = 'in_progress'`);

// ---- the case runner ----------------------------------------------------------------------------------------------
type AdapterAnswer = ProviderOutcome | 'unreadable';
type Attempt = {
  adapter: AdapterAnswer;
  remoteRevoke: 'supported' | 'unsupported';
  ack: string[];
  x: XCleanupOutcome;
  /** where the lease is taken away during the attempt */
  leaseLoss?: 'before_provider' | 'in_adapter' | 'before_x';
  /** whole-account deletion instead of POSTONA alone */
  whole?: boolean;
};
type Observed = {
  response: LifecycleResponse;
  adapterCalls: string[];
  /** acknowledgement list on record at the moment the destructive call was made */
  ackAtCleanup: string[] | null;
  xCalled: boolean;
  resultsAtLoss: Record<string, string> | null;
};

async function attempt(user: string, a: Attempt): Promise<Observed> {
  const events: string[] = [];
  const observed: Observed = { response: undefined as unknown as LifecycleResponse, adapterCalls: [], ackAtCleanup: null, xCalled: false, resultsAtLoss: null };
  const loseLease = async () => {
    await expireLease(user);
    observed.resultsAtLoss = (await operation(user))?.results ?? null;
  };
  const adapter: ProviderCleanupAdapter = {
    provider: 'threads',
    hasConnection: async () => {
      observed.adapterCalls.push('has');
      if (a.leaseLoss === 'before_provider') { a.leaseLoss = undefined; await loseLease(); }
      if (a.adapter === 'unreadable') return null;
      return (await threadsRows(user)) > 0;
    },
    cleanup: async (): Promise<ProviderOutcome> => {
      observed.adapterCalls.push('cleanup');
      observed.ackAtCleanup = (await operation(user))?.ack ?? [];
      if (a.leaseLoss === 'in_adapter') { a.leaseLoss = undefined; await loseLease(); }
      const answer = a.adapter as ProviderOutcome;
      if (answer === 'confirmed_remote_revoked' || answer === 'local_removed_remote_unverified') {
        await sql(`delete from public.social_accounts where brand_id = ${workspaceOf(user)} and platform = 'threads'`);
      }
      return answer;
    },
  };
  const deps: LifecycleDeps = {
    getUser: async () => ({ id: user, providers: ['email'], appleSubjects: [] }),
    rpc: async (name, args): Promise<RpcResult> => {
      const named = Object.entries(args).map(([key, value]) => `${key} => ${literal(value)}`).join(', ');
      try {
        const out = await sql(`begin; set local role service_role; select to_jsonb(public.${RPC_NAMES[name]}(${named})); commit;`);
        events.push(`rpc:${name}`);
        return { ok: true, data: JSON.parse(out) };
      } catch {
        events.push(`rpc:${name}:error`);
        return { ok: false };
      }
    },
    revokeSessions: async () => { await sql(`delete from auth.sessions where user_id = '${user}'`); return true; },
    removeStorageObjects: async () => true,
    revokeApple: null,
    x: {
      preview: async () => ({ scope: 'social_only', state: 'none' }),
      run: async () => {
        observed.xCalled = true;
        if (a.leaseLoss === 'before_x') { a.leaseLoss = undefined; await loseLease(); }
        if (a.x !== 'done') return a.x;
        // like the real saga: a non-X social account of the workspace sends it to an operator
        const foreign = Number(await sql(`select count(*) from public.social_accounts where brand_id = ${workspaceOf(user)} and platform <> 'x'`));
        if (foreign > 0) return 'blocked';
        await sql(`delete from public.brand_memberships where brand_id = ${workspaceOf(user)};
                   delete from public.brands where id = ${workspaceOf(user)}`);
        return 'done';
      },
    },
    providers: [adapter],
    providerRemoteRevoke: { threads: a.remoteRevoke },
    deleteLogin: async () => {
      try { await sql(`delete from auth.users where id = '${user}'`); return 'deleted'; } catch { return 'failed'; }
    },
    loginState: async () => ((await sql(`select exists (select 1 from auth.users where id = '${user}')`)) === 't' ? 'present' : 'absent'),
    nowSeconds: () => NOW,
  };
  const token = bearer(signIn(NOW - 60, user));
  if (a.whole) {
    const version = Number(await sql(`select lifecycle_version from public.common_accounts where user_id = '${user}'`));
    observed.response = await handleDeleteCommonAccount(
      { authorization: token, body: deleteBody(version, a.ack.length ? { acknowledged_remote_unverified: a.ack } : {}) }, deps);
  } else {
    observed.response = await handleWithdrawPostona(
      { authorization: token, body: { confirmation: END_POSTONA_CONFIRMATION, ...(a.ack.length ? { acknowledged_remote_unverified: a.ack } : {}) } }, deps);
  }
  return observed;
}

type Bystander = { user: string; rows: number; entitlementStatus: string; operation: OperationView };
async function bystander(): Promise<Bystander> {
  const p = await person({ threads: true });
  return { user: p.user, rows: await threadsRows(p.user), entitlementStatus: await entitlement(p.user, 'x_autopost'), operation: await operation(p.user) };
}

const SETTLED = new Set(['done', 'not_connected', 'confirmed_remote_revoked', 'local_removed_remote_unverified']);

async function checkInvariants(label: string, who: Person, a: Attempt, observed: Observed, by: Bystander, kabumori: string | null) {
  const body = observed.response.body as Record<string, unknown>;
  const op = await operation(who.user);
  const ended = (await entitlement(who.user, 'x_autopost')) === 'ended';
  const ok = observed.response.status === 200 && body.ok === true;
  if (ok) {
    // I1
    if (a.whole) {
      assert.equal(body.outcome, 'deleted', `${label}: whole-account success`);
    } else {
      assert.equal(ended, true, `${label}: I1 ok => ended`);
      assert.equal(op?.status, 'completed', `${label}: I1 ok => completed`);
    }
    const providers = (body.providers ?? {}) as Record<string, string>;
    for (const [provider, result] of Object.entries(providers)) {
      assert.ok(SETTLED.has(result), `${label}: I1 settled result for ${provider}: ${result}`);
      if (result === 'confirmed_remote_revoked') assert.equal(a.adapter, 'confirmed_remote_revoked', `${label}: I1 confirmed only if the adapter said so`);
    }
    if (a.adapter === 'local_removed_remote_unverified' && providers.threads !== undefined) {
      assert.ok(((body.remote_unverified ?? []) as string[]).includes('threads'), `${label}: I1 the unverified grant is reported`);
    }
  } else if (!a.whole) {
    // I2
    assert.equal(ended, false, `${label}: I2 not ok => not ended`);
    assert.notEqual(op?.status, 'completed', `${label}: I2 not ok => not completed`);
  }
  // I3
  if (op && Object.values(op.results).includes('local_removed_remote_unverified') && ended) {
    assert.deepEqual(op.ack.includes('threads'), true, `${label}: I3 ended with an unverified grant => acknowledged on record`);
  }
  if (observed.adapterCalls.includes('cleanup') && a.remoteRevoke === 'unsupported') {
    assert.ok(observed.ackAtCleanup?.includes('threads'), `${label}: I3 acknowledged BEFORE the destructive call (was ${JSON.stringify(observed.ackAtCleanup)})`);
  }
  // I4: nothing recorded by the lost owner after the loss
  if (observed.resultsAtLoss !== null && op) {
    for (const [provider, result] of Object.entries(observed.resultsAtLoss)) {
      assert.equal(op.results[provider], result, `${label}: I4 ${provider} changed after the lease was lost`);
    }
    assert.equal(ended, false, `${label}: I4 a lost owner cannot end the service`);
  }
  // I5, I6
  assert.equal(await threadsRows(by.user), by.rows, `${label}: I5 bystander connection`);
  assert.equal(await entitlement(by.user, 'x_autopost'), by.entitlementStatus, `${label}: I5 bystander entitlement`);
  assert.deepEqual(await operation(by.user), by.operation, `${label}: I5 bystander operation`);
  if (kabumori !== null && !a.whole) assert.equal(await entitlement(who.user, 'kabumori'), kabumori, `${label}: I6 Kabumori untouched`);
}

type Expectation = {
  ok: boolean;
  error?: string;
  threadsRemains: boolean;
  xCalled: boolean;
  entitlement: 'ended' | 'deleting' | 'active';
  providers?: Record<string, string>;
  remoteUnverified?: string[];
};
const errorOf = (r: LifecycleResponse) => (r.body.ok ? null : r.body.error);

async function runCase(label: string, first: Attempt, expected: Expectation, retry?: { attempt: Partial<Attempt>; expected: Expectation }) {
  const by = await bystander();
  const who = await person({ threads: true, kabumori: true });
  const kabumori = await entitlement(who.user, 'kabumori');
  const run = async (a: Attempt, e: Expectation, tag: string) => {
    const observed = await attempt(who.user, { ...a });
    const name = `${label}${tag}`;
    assert.equal(observed.response.status === 200 && observed.response.body.ok === true, e.ok, `${name}: ok (${JSON.stringify(observed.response.body)})`);
    if (e.error) assert.equal(errorOf(observed.response), e.error, `${name}: error`);
    assert.equal((await threadsRows(who.user)) > 0, e.threadsRemains, `${name}: threads remains`);
    assert.equal(observed.xCalled, e.xCalled, `${name}: X saga called`);
    if (!a.whole) assert.equal(await entitlement(who.user, 'x_autopost'), e.entitlement, `${name}: entitlement`);
    if (e.providers) assert.deepEqual((observed.response.body as { providers?: unknown }).providers, e.providers, `${name}: providers`);
    if (e.remoteUnverified) assert.deepEqual((observed.response.body as { remote_unverified?: unknown }).remote_unverified, e.remoteUnverified, `${name}: remote_unverified`);
    await checkInvariants(name, who, a, observed, by, a.whole ? null : kabumori);
    return observed;
  };
  await run(first, expected, '');
  if (retry) await run({ ...first, ack: first.ack, leaseLoss: undefined, ...retry.attempt }, retry.expected, ' (retry)');
}

const base: Attempt = { adapter: 'local_removed_remote_unverified', remoteRevoke: 'unsupported', ack: ['threads'], x: 'done' };
const ended = (providers: Record<string, string>, remoteUnverified?: string[]): Expectation => ({
  ok: true, threadsRemains: false, xCalled: true, entitlement: 'ended', providers, remoteUnverified,
});
const untouched = (error: string): Expectation => ({ ok: false, error, threadsRemains: true, xCalled: false, entitlement: 'active' });

const CASES: { name: string; first: Attempt; expected: Expectation; retry?: { attempt: Partial<Attempt>; expected: Expectation } }[] = [
  { name: 'unverified + acknowledged: ended, X done, the unverified grant reported',
    first: base, expected: ended({ threads: 'local_removed_remote_unverified', x: 'done' }, ['threads']) },
  { name: 'unverified + NOT acknowledged: nothing changes, the provider is not even read',
    first: { ...base, ack: [] }, expected: untouched('REMOTE_UNVERIFIED_ACK_REQUIRED') },
  { name: 'a provider that can confirm the revoke needs no acknowledgement',
    first: { ...base, adapter: 'confirmed_remote_revoked', remoteRevoke: 'supported', ack: [] },
    expected: ended({ threads: 'confirmed_remote_revoked', x: 'done' }) },
  { name: 'a provider registered as unsupported needs it even when the adapter could confirm',
    first: { ...base, adapter: 'confirmed_remote_revoked', ack: [] }, expected: untouched('REMOTE_UNVERIFIED_ACK_REQUIRED') },
  { name: 'reconciliation_required: nothing removed, X untouched, not ended; settled facts then end it',
    first: { ...base, adapter: 'reconciliation_required' },
    expected: { ok: false, error: 'RECONCILIATION_REQUIRED', threadsRemains: true, xCalled: false, entitlement: 'deleting' },
    retry: { attempt: { adapter: 'local_removed_remote_unverified' }, expected: ended({ threads: 'local_removed_remote_unverified', x: 'done' }, ['threads']) } },
  { name: 'blocked: nothing removed, X untouched, not ended; unblocked then ends',
    first: { ...base, adapter: 'blocked' },
    expected: { ok: false, error: 'PROVIDER_CLEANUP_BLOCKED', threadsRemains: true, xCalled: false, entitlement: 'deleting' },
    retry: { attempt: { adapter: 'local_removed_remote_unverified' }, expected: ended({ threads: 'local_removed_remote_unverified', x: 'done' }, ['threads']) } },
  { name: 'unreadable provider: fails closed like reconciliation',
    first: { ...base, adapter: 'unreadable' },
    expected: { ok: false, error: 'RECONCILIATION_REQUIRED', threadsRemains: true, xCalled: false, entitlement: 'deleting' } },
  { name: 'X blocked after Threads was removed: never ended; the fact is kept; X done later ends it',
    first: { ...base, x: 'blocked' },
    expected: { ok: false, error: 'X_CLEANUP_BLOCKED', threadsRemains: false, xCalled: true, entitlement: 'deleting' },
    retry: { attempt: { x: 'done' }, expected: ended({ threads: 'local_removed_remote_unverified', x: 'done' }, ['threads']) } },
  { name: 'X in progress: not an end',
    first: { ...base, x: 'in_progress' },
    expected: { ok: false, error: 'X_CLEANUP_IN_PROGRESS', threadsRemains: false, xCalled: true, entitlement: 'deleting' } },
  { name: 'X failed: not an end, 502',
    first: { ...base, x: 'failed' },
    expected: { ok: false, error: 'X_CLEANUP_FAILED', threadsRemains: false, xCalled: true, entitlement: 'deleting' } },
  { name: 'lease lost before the provider is touched: nothing removed, nothing recorded, retry ends',
    first: { ...base, leaseLoss: 'before_provider' },
    expected: { ok: false, error: 'DELETION_IN_PROGRESS', threadsRemains: true, xCalled: false, entitlement: 'deleting' },
    retry: { attempt: {}, expected: ended({ threads: 'local_removed_remote_unverified', x: 'done' }, ['threads']) } },
  { name: 'lease lost while the adapter removes: its answer is not used; the retry accounts for it',
    first: { ...base, leaseLoss: 'in_adapter' },
    expected: { ok: false, error: 'DELETION_IN_PROGRESS', threadsRemains: false, xCalled: false, entitlement: 'deleting' },
    retry: { attempt: {}, expected: ended({ threads: 'not_connected', x: 'done' }, ['threads']) } },
  { name: 'lease lost before X: not ended by the lost owner; retry ends',
    first: { ...base, leaseLoss: 'before_x' },
    expected: { ok: false, error: 'DELETION_IN_PROGRESS', threadsRemains: false, xCalled: true, entitlement: 'deleting' },
    retry: { attempt: {}, expected: ended({ threads: 'local_removed_remote_unverified', x: 'done' }, ['threads']) } },
  { name: 'a registration that says "supported" cannot turn an unverified answer into a success without consent; consent on the retry ends it',
    first: { ...base, remoteRevoke: 'supported', ack: [] },
    expected: { ok: false, error: 'PROVIDER_REMOTE_UNVERIFIED', threadsRemains: false, xCalled: false, entitlement: 'deleting' },
    retry: { attempt: { ack: ['threads'] }, expected: ended({ threads: 'local_removed_remote_unverified', x: 'done' }, ['threads']) } },
  { name: 'the same, and the retry brings NO consent: stopped again before anything is touched, then consent ends it',
    first: { ...base, remoteRevoke: 'supported', ack: [] },
    expected: { ok: false, error: 'PROVIDER_REMOTE_UNVERIFIED', threadsRemains: false, xCalled: false, entitlement: 'deleting' },
    retry: { attempt: { ack: [] }, expected: { ok: false, error: 'REMOTE_UNVERIFIED_ACK_REQUIRED', threadsRemains: false, xCalled: false, entitlement: 'deleting' } } },
  { name: 'a resumed end after a crash that lost the answer: the earlier consent is on record, none is asked again',
    first: { ...base, leaseLoss: 'in_adapter' },
    expected: { ok: false, error: 'DELETION_IN_PROGRESS', threadsRemains: false, xCalled: false, entitlement: 'deleting' },
    retry: { attempt: { ack: [] }, expected: ended({ threads: 'not_connected', x: 'done' }, ['threads']) } },
];

for (const c of CASES) {
  test(`P7 matrix: ${c.name}`, { skip: !enabled }, async () => {
    await runCase(c.name, c.first, c.expected, c.retry);
  });
}

test('P7 matrix: the whole account — acknowledgement first, then one chain of ownership', { skip: !enabled }, async () => {
  await sql(`alter table private.account_lifecycle_release_gates drop constraint if exists account_lifecycle_release_gates_blocked_only;
             update private.account_lifecycle_release_gates set state = 'open'`);
  const by = await bystander();
  const who = await person({ threads: true, kabumori: true });
  const refused = await attempt(who.user, { ...base, ack: [], whole: true });
  assert.equal(errorOf(refused.response), 'REMOTE_UNVERIFIED_ACK_REQUIRED');
  assert.equal(await threadsRows(who.user), 1);
  assert.equal(await sql(`select status from public.common_accounts where user_id = '${who.user}'`), 'active', 'nothing began');
  const done = await attempt(who.user, { ...base, whole: true });
  assert.equal(done.response.status, 200, JSON.stringify(done.response.body));
  const body = done.response.body as Record<string, unknown>;
  assert.equal(body.outcome, 'deleted');
  assert.deepEqual(body.remote_unverified, ['threads']);
  assert.equal(await sql(`select count(*) from auth.users where id = '${who.user}'`), '0');
  // the durable result is readable by the subject hash after the login is gone (the read-back)
  assert.equal(await sql(`select status || '/' || (provider_results ->> 'threads') from private.account_lifecycle_operations
                            where subject_sha256 = public.social_mobile_account_deletion_subject('${who.user}'::uuid)
                              and operation_type = 'service_deletion' and service_key = 'x_autopost'`),
               'completed/local_removed_remote_unverified');
  assert.equal(await threadsRows(by.user), 1);
  assert.equal(await entitlement(by.user, 'x_autopost'), 'active');
});
