import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIRMATION, handleAccountDeletion, lastAuthenticatedAt, RECENT_AUTH_SECONDS, type DeletionDeps } from './delete_logic.ts';

const NOW = 1_800_000_000;
const USER = '11111111-1111-4111-8111-111111111111';
const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;
const fresh = jwt({ sub: USER, amr: [{ method: 'oauth', timestamp: NOW - 3600 }, { method: 'password', timestamp: NOW - 60 }] });

type Call = [string, unknown];

function deps(overrides: Partial<DeletionDeps> & { providers?: string[]; begin?: unknown; creds?: unknown; purgeCode?: string | null } = {}) {
  const calls: Call[] = [];
  const d: DeletionDeps = {
    getUser: async () => ({ id: USER, providers: overrides.providers ?? ['email'], appleSubjects: (overrides.providers ?? []).includes('apple') ? ['apple-sub-1'] : [] }),
    rpc: async (name, args) => {
      calls.push([`rpc:${name}`, args]);
      if (name === 'begin') return { ok: true, data: overrides.begin ?? { status: 'ready', workspace: true, x_accounts: 1 } };
      if (name === 'credentials') return { ok: true, data: overrides.creds ?? [{ social_account_id: 'sa_x', access_token: 'FAKE_ACCESS', refresh_token: 'FAKE_REFRESH' }] };
      if (name === 'purge') return overrides.purgeCode !== undefined ? { ok: false, code: overrides.purgeCode } : { ok: true, data: { status: 'purged' } };
      return { ok: true, data: null };
    },
    revokeX: async (token, hint) => { calls.push(['revokeX', `${hint}:${token}`]); return true; },
    revokeApple: null,
    deleteAuthUser: async (id) => { calls.push(['deleteAuthUser', id]); return true; },
    nowSeconds: () => NOW,
    ...overrides,
  };
  return { d, calls, names: () => calls.map(([name, args]) => name === 'rpc:record' ? `record:${(args as { p_step: string }).p_step}` : name) };
}

const request = (body: unknown = { confirmation: CONFIRMATION }, token = fresh) => ({ authorization: `Bearer ${token}`, body });

test('happy path: exact order, the verified user only, success only after the auth user is gone', async () => {
  const { d, calls, names } = deps();
  const result = await handleAccountDeletion(request({ confirmation: CONFIRMATION, user_id: 'someone-else', p_user_id: 'x' }), d);
  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.deepEqual(names(), [
    'record:requested', 'rpc:begin', 'rpc:credentials', 'revokeX', 'revokeX', 'record:credentials_revoked', 'rpc:purge', 'deleteAuthUser', 'record:auth_user_deleted',
  ]);
  for (const [name, args] of calls) {
    if (name.startsWith('rpc:')) assert.equal((args as { p_user_id: string }).p_user_id, USER, 'never a body-supplied id');
  }
  assert.deepEqual(calls.filter(([name]) => name === 'revokeX').map(([, v]) => v), ['refresh_token:FAKE_REFRESH', 'access_token:FAKE_ACCESS']);
  assert.deepEqual(calls.find(([name]) => name === 'deleteAuthUser'), ['deleteAuthUser', USER]);
});

test('authentication, confirmation and recent-auth gates run before any side effect', async () => {
  const cases: [Parameters<typeof handleAccountDeletion>[0], Partial<DeletionDeps>, number, string][] = [
    [{ authorization: null, body: { confirmation: CONFIRMATION } }, {}, 401, 'AUTH_REQUIRED'],
    [{ authorization: 'Basic abc', body: { confirmation: CONFIRMATION } }, {}, 401, 'AUTH_REQUIRED'],
    [request(), { getUser: async () => null }, 401, 'AUTH_REQUIRED'],
    [request(), { getUser: async () => { throw new Error('network'); } }, 401, 'AUTH_REQUIRED'],
    [request({}), {}, 400, 'CONFIRMATION_REQUIRED'],
    [request({ confirmation: 'yes' }), {}, 400, 'CONFIRMATION_REQUIRED'],
    [request(null), {}, 400, 'CONFIRMATION_REQUIRED'],
    [request(undefined, jwt({ sub: USER, amr: [{ method: 'password', timestamp: NOW - RECENT_AUTH_SECONDS - 1 }] })), {}, 403, 'REAUTH_REQUIRED'],
    [request(undefined, jwt({ sub: 'another-user', amr: [{ method: 'password', timestamp: NOW }] })), {}, 403, 'REAUTH_REQUIRED'],
    [request(undefined, jwt({ sub: USER })), {}, 403, 'REAUTH_REQUIRED'],
    [request(undefined, 'not-a-jwt'), {}, 403, 'REAUTH_REQUIRED'],
  ];
  for (const [input, overrides, status, error] of cases) {
    const { d, calls } = deps(overrides);
    assert.deepEqual(await handleAccountDeletion(input, d), { status, body: { ok: false, error } }, error);
    assert.deepEqual(calls, [], `${error}: no side effect`);
  }
  assert.equal(lastAuthenticatedAt(jwt({ sub: USER, amr: [{ method: 'otp', timestamp: NOW - RECENT_AUTH_SECONDS }] }), USER), NOW - RECENT_AUTH_SECONDS);
});

test('Sign in with Apple users: refused up front without revocation config or a fresh code; revoked before the purge', async () => {
  const noConfig = deps({ providers: ['apple'] });
  assert.deepEqual(await handleAccountDeletion(request(), noConfig.d), { status: 409, body: { ok: false, error: 'APPLE_REVOCATION_UNAVAILABLE' } });
  assert.deepEqual(noConfig.calls, []);
  const noCode = deps({ providers: ['email', 'apple'], revokeApple: async () => true });
  assert.deepEqual(await handleAccountDeletion(request(), noCode.d), { status: 400, body: { ok: false, error: 'APPLE_REAUTH_REQUIRED' } });
  assert.deepEqual(noCode.calls, []);
  const codes: string[] = [];
  const ok = deps({ providers: ['apple'], revokeApple: async (code, subjects) => { codes.push(`${code}@${subjects.join(',')}`); ok.calls.push(['revokeApple', code]); return true; } });
  assert.equal((await handleAccountDeletion(request({ confirmation: CONFIRMATION, apple_authorization_code: 'fresh-code' }), ok.d)).status, 200);
  assert.deepEqual(codes, ['fresh-code@apple-sub-1'], 'revocation is bound to the user\'s own Apple identity');
  const order = ok.names();
  assert.ok(order.indexOf('revokeApple') > order.indexOf('record:credentials_revoked') && order.indexOf('revokeApple') < order.indexOf('rpc:purge'));
  const failing = deps({ providers: ['apple'], revokeApple: async () => false });
  assert.deepEqual(await handleAccountDeletion(request({ confirmation: CONFIRMATION, apple_authorization_code: 'c' }), failing.d), { status: 502, body: { ok: false, error: 'APPLE_REVOKE_FAILED' } });
  assert.ok(!failing.names().includes('rpc:purge') && !failing.names().includes('deleteAuthUser'));
});

test('blocked by the DB boundary: fixed code, nothing revoked, purged or deleted', async () => {
  for (const [reason, expected] of [['SHARED_WORKSPACE', 'DELETION_BLOCKED_SHARED_WORKSPACE'], ['POSTING_IN_PROGRESS', 'DELETION_BLOCKED_POSTING_IN_PROGRESS'], ['<script>', 'DELETION_BLOCKED_UNKNOWN']]) {
    const { d, names } = deps({ begin: { status: 'blocked', reason } });
    assert.deepEqual(await handleAccountDeletion(request(), d), { status: 409, body: { ok: false, error: expected } });
    assert.deepEqual(names(), ['record:requested', 'rpc:begin']);
  }
});

test('X revocation failure stops before any destructive step (posting already off, retry-safe)', async () => {
  for (const revokeX of [async () => false, async () => { throw new Error('timeout'); }]) {
    const { d, names } = deps({ revokeX });
    assert.deepEqual(await handleAccountDeletion(request(), d), { status: 502, body: { ok: false, error: 'X_REVOKE_FAILED' } });
    assert.ok(!names().includes('rpc:purge') && !names().includes('deleteAuthUser'));
    assert.equal(names().at(-1), 'record:failed');
  }
});

test('purge and auth-user failures never report success; DB codes are mapped, never passed through', async () => {
  const cases: [string | null, number, string][] = [
    ['SOCIAL_MOBILE_DELETION_UNEXPECTED_DEPENDENT_DATA', 409, 'DELETION_BLOCKED_UNEXPECTED_DEPENDENT_DATA'],
    ['SOCIAL_MOBILE_DELETION_BLOCKED_SHARED_WORKSPACE', 409, 'DELETION_BLOCKED_SHARED_WORKSPACE'],
    ['SOCIAL_MOBILE_DELETION_BLOCKED_DROP_TABLE', 409, 'DELETION_BLOCKED_UNKNOWN'],
    [null, 500, 'PURGE_FAILED'],
  ];
  for (const [purgeCode, status, error] of cases) {
    const { d, names } = deps({ purgeCode });
    assert.deepEqual(await handleAccountDeletion(request(), d), { status, body: { ok: false, error } });
    assert.ok(!names().includes('deleteAuthUser'));
  }
  const authFail = deps({ deleteAuthUser: async () => false });
  assert.deepEqual(await handleAccountDeletion(request(), authFail.d), { status: 500, body: { ok: false, error: 'AUTH_DELETE_FAILED' } });
  const beginFail = deps({ rpc: async (name) => name === 'begin' ? { ok: false, code: null } : { ok: true, data: null } });
  assert.deepEqual(await handleAccountDeletion(request(), beginFail.d), { status: 500, body: { ok: false, error: 'FAILED' } });
});

test('repeating a deletion is idempotent: nothing left to revoke or purge, auth user already gone is success', async () => {
  const { d, names } = deps({ begin: { status: 'ready', workspace: false, x_accounts: 0 }, creds: [], deleteAuthUser: async () => true });
  assert.deepEqual(await handleAccountDeletion(request(), d), { status: 200, body: { ok: true } });
  assert.ok(!names().includes('revokeX'));
  const missingTokens = deps({ creds: [{ social_account_id: 'sa_x', access_token: null, refresh_token: '' }] });
  assert.equal((await handleAccountDeletion(request(), missingTokens.d)).status, 200);
  assert.ok(!missingTokens.names().includes('revokeX'));
});

test('audit failures never change the outcome; responses never contain tokens', async () => {
  const { d } = deps({ rpc: async (name) => {
    if (name === 'record') throw new Error('audit down');
    if (name === 'begin') return { ok: true, data: { status: 'ready' } };
    if (name === 'credentials') return { ok: true, data: [{ access_token: 'FAKE_ACCESS', refresh_token: 'FAKE_REFRESH' }] };
    return { ok: true, data: { status: 'purged' } };
  } });
  const result = await handleAccountDeletion(request(), d);
  assert.equal(result.status, 200);
  for (const revokeX of [async () => false]) {
    const failing = deps({ revokeX });
    assert.doesNotMatch(JSON.stringify(await handleAccountDeletion(request(), failing.d)), /FAKE_|eyJ|Bearer/u);
  }
});

test('function sources: no body-supplied user id, no logging, service role only server-side', async () => {
  const dir = new URL('.', import.meta.url);
  for (const file of ['index.ts', 'delete_logic.ts', 'apple_revoke.ts']) {
    const source = await Deno.readTextFile(new URL(file, dir));
    assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)/u, file);
    assert.doesNotMatch(source, /body\.(user_id|p_user_id|userId|id)\b/u, file);
  }
  const logic = await Deno.readTextFile(new URL('delete_logic.ts', dir));
  assert.equal((logic.match(/p_user_id: userId/gu) ?? []).length, 4, 'every RPC gets the verified id');
});
