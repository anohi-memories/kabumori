// End to end on a DISPOSABLE local PostgreSQL: the real whole-account deletion orchestrator
// (supabase/functions/account-delete/lifecycle_logic.ts, unmodified) drives the REAL Phase 1/2/3a SQL state
// machine, the Phase 3b writer guard and the Phase 4 fence through psql. Only the managed services are
// stand-ins, each a single SQL statement named below. Run by common_account_core_fence_run.sh (section e2e);
// it needs CAL_E2E=1 and PGHOST/PGPORT/PGUSER/PGDATABASE of the disposable database. Fake data only.
//
// STAND-INS (never in a candidate): Auth global logout = delete from auth.sessions; Storage API remove =
// delete from storage.objects; the managed Auth Admin delete = delete from auth.users (the Phase 1 guard
// trigger still decides it); the X saga = nothing to clean (no X workspace is created by a login); the
// release gate is opened by TEST-ONLY DDL in this throwaway database.
import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC_NAMES } from '../functions/account-delete/http.ts';
import { bearer, deleteBody, NOW, signIn } from '../functions/account-delete/fake_lifecycle.ts';
import {
  handleDeleteCommonAccount,
  handlePreview,
  type LifecycleDeps,
  type LifecycleResponse,
  type RpcResult,
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
/** The statement's error message, or null when it succeeded (a refusal is an answer, not a crash). */
async function refusal(statement: string): Promise<string | null> {
  try {
    await sql(statement);
    return null;
  } catch (failure) {
    return String((failure as Error).message).replace(/^ERROR:\s+/u, '').split('\n')[0];
  }
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
const newUser = () => `00000000-0000-4000-8000-${String(990_000 + ++counter).padStart(12, '0')}`;
async function person(services: ('kabumori' | 'x_autopost')[]): Promise<string> {
  const user = newUser();
  await sql(`select public.fixture_login('${user}'::uuid)`);
  for (const service of services) {
    const answer = JSON.parse(await sql(asPerson(user, `select to_jsonb(public.start_${service}_service())`)));
    assert.equal(answer.status, 'active');
  }
  return user;
}

function depsFor(user: string, events: string[], options: { providers?: ProviderCleanupAdapter[] } = {}): LifecycleDeps {
  return {
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
    revokeSessions: async () => {
      events.push('auth:logout');
      await sql(`delete from auth.sessions where user_id = '${user}'`);
      return true;
    },
    removeStorageObjects: async (bucketId, names) => {
      events.push('storage:remove');
      await sql(`delete from storage.objects where bucket_id = ${literal(bucketId)} and name in (${names.map(literal).join(',')})`);
      return true;
    },
    revokeApple: null,
    x: {
      preview: async () => ({ scope: 'social_only', state: 'none' }),
      run: async () => { events.push('x:saga'); return 'done'; },
    },
    providers: options.providers,
    deleteLogin: async () => {
      events.push('auth:delete');
      try {
        await sql(`delete from auth.users where id = '${user}'`);
        return 'deleted';
      } catch {
        return 'failed';
      }
    },
    loginState: async () => ((await sql(`select exists (select 1 from auth.users where id = '${user}')`)) === 't' ? 'present' : 'absent'),
    nowSeconds: () => NOW,
  };
}
const token = (user: string) => signIn(NOW - 60, user);
const preview = (user: string, deps: LifecycleDeps) => handlePreview({ authorization: bearer(token(user)) }, deps);
const version = async (user: string) => Number(await sql(`select lifecycle_version from public.common_accounts where user_id = '${user}'`));
const remove = async (user: string, deps: LifecycleDeps) =>
  handleDeleteCommonAccount({ authorization: bearer(token(user)), body: deleteBody(await version(user)) }, deps);
const error = (response: LifecycleResponse) => (response.body.ok ? null : response.body.error);
const one = async (statement: string) => sql(statement);

test('E2E: a release-blocked managed delete is refused by the real gate before anything changes', { skip: !enabled }, async () => {
  const user = await person(['kabumori']);
  const events: string[] = [];
  const deps = depsFor(user, events);
  const before = await preview(user, deps);
  assert.equal((before.body as unknown as { deletion_available: boolean }).deletion_available, false, 'the real gate is blocked');
  const response = await remove(user, deps);
  assert.equal(error(response), 'COMMON_ACCOUNT_DELETION_UNAVAILABLE');
  assert.equal(await one(`select status from public.common_accounts where user_id = '${user}'`), 'active');
  assert.equal(await one(`select count(*) from public.profiles where id = '${user}'`), '1');
  assert.ok(!events.includes('auth:delete') && !events.includes('auth:logout'));
});

test('E2E: with the gate opened (test-only DDL) the whole person is deleted in the canonical order and only a read-back says so', { skip: !enabled }, async () => {
  await sql(`alter table private.account_lifecycle_release_gates drop constraint if exists account_lifecycle_release_gates_blocked_only;
             update private.account_lifecycle_release_gates set state = 'open'`);
  const user = await person(['kabumori', 'x_autopost']);
  await sql(`insert into storage.buckets (id, owner_id) values ('p4-e2e', null) on conflict (id) do nothing;
             insert into storage.objects (bucket_id, name, owner_id) values ('p4-e2e', 'a-${user}.png', '${user}'), ('p4-e2e', 'b-${user}.png', '${user}')`);
  await sql(`insert into public.tracked_stocks (user_id) values ('${user}')`);
  const events: string[] = [];
  const providerCalls: string[] = [];
  const provider: ProviderCleanupAdapter = {
    provider: 'threads',
    hasConnection: async () => { events.push('provider:has'); return true; },
    cleanup: async (): Promise<ProviderOutcome> => { providerCalls.push('cleanup'); events.push('provider:cleanup'); return 'confirmed_remote_revoked'; },
  };
  const deps = depsFor(user, events, { providers: [provider] });
  const response = await remove(user, deps);
  assert.deepEqual(response.body, { ok: true, outcome: 'deleted', providers: { threads: 'confirmed_remote_revoked', x: 'done' } });
  const order = ['rpc:begin_account_deletion', 'rpc:claim', 'rpc:claim_service', 'x:saga', 'provider:cleanup', 'rpc:finish_owned_service', 'rpc:withdraw_kabumori',
    'auth:logout', 'storage:remove', 'rpc:owned_prepare', 'rpc:begin_external_step', 'auth:delete', 'rpc:complete'].map((e) => events.indexOf(e));
  assert.ok(order.every((index) => index >= 0), `every step ran: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the canonical order');
  assert.equal(providerCalls.length, 1);
  assert.equal(await one(`select count(*) from auth.users where id = '${user}'`), '0');
  assert.equal(await one(`select count(*) from public.profiles where id = '${user}'`), '0');
  assert.equal(await one(`select count(*) from public.tracked_stocks where user_id = '${user}'`), '0');
  assert.equal(await one(`select count(*) from storage.objects where owner_id = '${user}'`), '0');
  assert.equal(await one(`select count(*) from public.service_entitlements where user_id = '${user}' and status <> 'ended'`), '0');
  // The raw id is cleared with the login; the operation is found by its subject hash.
  assert.equal(await one(`select status || '/' || (verified_at is not null) || '/' || (user_id is null) from private.account_lifecycle_operations
                            where subject_sha256 = public.social_mobile_account_deletion_subject('${user}'::uuid) and operation_type = 'account_deletion'`),
               'completed/true/true');
  // Phase 6: the POSTONA operation kept what X and Threads answered, and holds no lease any more.
  assert.equal(await one(`select provider_results::text || '/' || (owner_lease is null) from private.account_lifecycle_operations
                            where subject_sha256 = public.social_mobile_account_deletion_subject('${user}'::uuid) and operation_type = 'service_deletion'
                              and service_key = 'x_autopost'`),
               '{"x": "done", "threads": "confirmed_remote_revoked"}/true');
});

test('E2E: during the freeze every stale-token write is refused by the real database, then the deletion completes', { skip: !enabled }, async () => {
  const user = await person(['kabumori', 'x_autopost']);
  const events: string[] = [];
  const attempts: Record<string, string | null> = {};
  const provider: ProviderCleanupAdapter = {
    provider: 'threads',
    hasConnection: async () => true,
    cleanup: async () => {
      // The account is frozen here (begin and claim happened). A still-valid token of the person writes:
      await sql(`delete from public.profiles where id = '${user}'`); // stand-in: the root was not there
      attempts.profile = await refusal(asPerson(user, `insert into public.profiles (id) values ('${user}')`));
      attempts.ensure = await refusal(asPerson(user, 'select public.ensure_my_profile()'));
      attempts.fenced = await refusal(asPerson(user, `insert into public.fixture_fenced_rows (owner_id) values ('${user}')`));
      const started = JSON.parse(await sql(asPerson(user, 'select to_jsonb(public.start_x_autopost_service())')));
      attempts.start = `${started.status}/${started.reason}`;
      // The Kabumori profile is expected to be gone at the Kabumori step; put it back so withdraw has work.
      await sql(`alter table public.profiles disable trigger account_lifecycle_profile_root_fence;
                 insert into public.profiles (id) values ('${user}');
                 alter table public.profiles enable trigger account_lifecycle_profile_root_fence`);
      return 'confirmed_remote_revoked';
    },
  };
  const deps = depsFor(user, events, { providers: [provider] });
  const response = await remove(user, deps);
  assert.equal(response.status, 200);
  assert.equal((response.body as { outcome?: string }).outcome, 'deleted');
  assert.equal(attempts.profile, 'ACCOUNT_DELETION_IN_PROGRESS');
  assert.equal(attempts.ensure, 'ACCOUNT_DELETION_IN_PROGRESS');
  assert.equal(attempts.fenced, 'ACCOUNT_DELETION_IN_PROGRESS');
  assert.equal(attempts.start, 'blocked/ACCOUNT_DELETION_IN_PROGRESS');
  assert.equal(await one(`select count(*) from public.fixture_fenced_rows where owner_id = '${user}'`), '0');
});

test('E2E: a blocked provider stops the deletion with the account frozen and the code kept; a retry resumes the same operation', { skip: !enabled }, async () => {
  const user = await person(['kabumori', 'x_autopost']);
  const events: string[] = [];
  let answer: ProviderOutcome = 'blocked';
  const provider: ProviderCleanupAdapter = { provider: 'threads', hasConnection: async () => true, cleanup: async () => answer };
  const deps = depsFor(user, events, { providers: [provider] });
  const first = await remove(user, deps);
  assert.equal(error(first), 'PROVIDER_CLEANUP_BLOCKED');
  assert.equal(await one(`select status from public.common_accounts where user_id = '${user}'`), 'deleting');
  assert.equal(await one(`select status || '/' || coalesce(last_error_code, '') from private.account_lifecycle_operations
                            where user_id = '${user}' and operation_type = 'account_deletion'`), 'in_progress/PROVIDER_CLEANUP_BLOCKED');
  assert.equal(await one(`select status from public.service_entitlements where user_id = '${user}' and service_key = 'x_autopost'`), 'deleting');
  assert.ok(!events.includes('auth:delete'));
  // Frozen: the person's own writes are refused meanwhile.
  assert.equal(await refusal(asPerson(user, 'select public.ensure_my_profile()')), 'ACCOUNT_DELETION_IN_PROGRESS');
  answer = 'confirmed_remote_revoked';
  const operationBefore = await one(`select id from private.account_lifecycle_operations where user_id = '${user}' and operation_type = 'account_deletion'`);
  const second = await handleDeleteCommonAccount({ authorization: bearer(token(user)), body: deleteBody(await version(user)) }, deps);
  assert.deepEqual(second.body, { ok: true, outcome: 'deleted', providers: { threads: 'confirmed_remote_revoked', x: 'done' } });
  assert.equal(await one(`select count(*) from private.account_lifecycle_operations where id = '${operationBefore}'`), '1', 'the same operation completed');
});
