import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIRMATION, handleAccountDeletion, handlePreview, lastAuthenticatedAt, RECENT_AUTH_SECONDS, type DeletionDeps, type RpcResult } from './delete_logic.ts';
import { sha256Hex } from './http.ts';

const NOW = 1_800_000_000;
const USER = '11111111-1111-4111-8111-111111111111';
const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;
const fresh = jwt({ sub: USER, amr: [{ method: 'oauth', timestamp: NOW - 3600 }, { method: 'password', timestamp: NOW - 60 }] });

type Account = { id: string; revoke_required: boolean; access_token: string | null; refresh_token: string | null };

/** Minimal fake of the DB state machine (the real one is proven in supabase/tests). */
function fakeDb(options: { scope?: 'social_only' | 'social_and_login'; accounts?: Account[]; blocked?: string; operatorAtCredentials?: boolean; purgeError?: string | null; finalizeLoginDeleted?: boolean } = {}) {
  const calls: string[] = [];
  let tombstone: null | { state: string; scope: string; appleRequired: boolean; appleRevoked: boolean; lease: string | null } = null;
  let purgeError = options.purgeError ?? null;
  const accounts = options.accounts ?? [{ id: 'sa_x', revoke_required: true, access_token: 'FAKE_ACCESS', refresh_token: 'FAKE_REFRESH' }];
  let leases = 0;
  const leaseLost = (args: Record<string, unknown>): RpcResult | null => (!tombstone || tombstone.lease !== args.p_lease ? { ok: false, code: 'SOCIAL_MOBILE_DELETION_LEASE_LOST' } : null);
  const rpc = async (name: string, args: Record<string, unknown>): Promise<RpcResult> => {
    calls.push(name === 'record' ? `record:${args.p_step}` : name);
    assert.equal(args.p_user_id, USER, `${name} gets the verified user`);
    switch (name) {
      case 'preview':
        return { ok: true, data: { state: tombstone?.state ?? 'none', scope: tombstone?.scope ?? options.scope ?? 'social_and_login', apple_revoked: tombstone?.appleRevoked ?? false } };
      case 'acquire': {
        if (options.blocked) return { ok: true, data: { status: 'blocked', reason: options.blocked } };
        if (tombstone?.state === 'operator_required') return { ok: true, data: { status: 'operator_required' } };
        if (tombstone?.lease) return { ok: true, data: { status: 'in_progress' } };
        tombstone ??= { state: 'started', scope: String(args.p_expected_scope), appleRequired: false, appleRevoked: false, lease: null };
        tombstone.appleRequired ||= args.p_apple_required === true;
        tombstone.lease = `lease-${++leases}`;
        return { ok: true, data: { status: 'acquired', lease: tombstone.lease, state: tombstone.state, apple_revoked: tombstone.appleRevoked } };
      }
      case 'release':
        if (tombstone && tombstone.lease === args.p_lease) tombstone.lease = null;
        return { ok: true, data: null };
      case 'credentials': {
        const lost = leaseLost(args); if (lost) return lost;
        if (tombstone!.state !== 'started') return { ok: true, data: { status: 'not_needed' } };
        if (options.operatorAtCredentials) { tombstone!.state = 'operator_required'; tombstone!.lease = null; return { ok: true, data: { status: 'operator_required', reason: 'CREDENTIAL_MATERIAL_MISSING' } }; }
        return { ok: true, data: { status: 'ok', accounts } };
      }
      case 'mark_x_revoked': {
        const lost = leaseLost(args); if (lost) return lost;
        const expected = await Promise.all(accounts.filter((a) => a.revoke_required).map(async (a) => ({ id: a.id, access_sha256: await sha256Hex(a.access_token!), refresh_sha256: await sha256Hex(a.refresh_token!) })));
        if (JSON.stringify(args.p_revoked) !== JSON.stringify(expected)) return { ok: true, data: { status: 'credentials_changed' } };
        tombstone!.state = 'x_revoked';
        return { ok: true, data: { status: 'x_revoked' } };
      }
      case 'mark_apple_revoked': {
        const lost = leaseLost(args); if (lost) return lost;
        tombstone!.appleRevoked = true;
        return { ok: true, data: { status: 'apple_revoked' } };
      }
      case 'purge': {
        const lost = leaseLost(args); if (lost) return lost;
        if (purgeError) { const code = purgeError; purgeError = null; return { ok: false, code }; }
        if (tombstone!.appleRequired && !tombstone!.appleRevoked) return { ok: true, data: { status: 'apple_revoke_required' } };
        if (tombstone!.state !== 'x_revoked' && tombstone!.state !== 'purged') return { ok: true, data: { status: 'not_ready' } };
        tombstone!.state = 'purged';
        return { ok: true, data: { status: 'purged' } };
      }
      case 'finalize': {
        const lost = leaseLost(args); if (lost) return lost;
        const loginDeleted = tombstone!.scope === 'social_and_login' && (options.finalizeLoginDeleted ?? true);
        tombstone = null;
        return { ok: true, data: { status: 'completed', login_deleted: loginDeleted, reason: loginDeleted || options.scope === 'social_only' ? null : 'MAIN_APP_ACCOUNT_PRESENT' } };
      }
      default:
        return { ok: true, data: null };
    }
  };
  return { rpc, calls, tombstone: () => tombstone };
}

function deps(db: ReturnType<typeof fakeDb>, overrides: Partial<DeletionDeps> & { providers?: string[] } = {}) {
  const external: string[] = [];
  const d: DeletionDeps = {
    getUser: async () => ({ id: USER, providers: overrides.providers ?? ['email'], appleSubjects: (overrides.providers ?? []).includes('apple') ? ['apple-sub-1'] : [] }),
    rpc: db.rpc as DeletionDeps['rpc'],
    revokeX: async (token, hint) => { external.push(`x:${hint}:${token}`); return true; },
    revokeApple: null,
    sha256Hex,
    nowSeconds: () => NOW,
    ...overrides,
  };
  return { d, external };
}

const del = (extra: Record<string, unknown> = {}, token = fresh) => ({ authorization: `Bearer ${token}`, body: { confirmation: CONFIRMATION, expected_scope: 'social_and_login', ...extra } });

test('happy path: acquire -> revoke -> mark by fingerprint -> purge -> finalize; success only after finalize', async () => {
  const db = fakeDb();
  const { d, external } = deps(db);
  const result = await handleAccountDeletion(del({ user_id: 'someone-else' }), d);
  assert.deepEqual(result, { status: 200, body: { ok: true, login_deleted: true } });
  assert.deepEqual(db.calls, ['preview', 'record:requested', 'acquire', 'credentials', 'mark_x_revoked', 'purge', 'finalize']);
  assert.deepEqual(external, ['x:refresh_token:FAKE_REFRESH', 'x:access_token:FAKE_ACCESS']);
  assert.equal(db.tombstone(), null);
});

test('gates run before any side effect', async () => {
  const cases: [Parameters<typeof handleAccountDeletion>[0], Partial<DeletionDeps>, number, string][] = [
    [{ authorization: null, body: {} }, {}, 401, 'AUTH_REQUIRED'],
    [del(), { getUser: async () => null }, 401, 'AUTH_REQUIRED'],
    [del(), { getUser: async () => { throw new Error('down'); } }, 401, 'AUTH_REQUIRED'],
    [{ authorization: `Bearer ${fresh}`, body: { expected_scope: 'social_only' } }, {}, 400, 'CONFIRMATION_REQUIRED'],
    [del({}, jwt({ sub: USER, amr: [{ method: 'password', timestamp: NOW - RECENT_AUTH_SECONDS - 1 }] })), {}, 403, 'REAUTH_REQUIRED'],
    [del({}, jwt({ sub: 'another', amr: [{ method: 'password', timestamp: NOW }] })), {}, 403, 'REAUTH_REQUIRED'],
    [del({ expected_scope: 'everything' }), {}, 400, 'SCOPE_REQUIRED'],
    [del(), { providers: ['apple'] }, 409, 'APPLE_REVOCATION_UNAVAILABLE'],
  ];
  for (const [input, overrides, status, error] of cases) {
    const db = fakeDb();
    const { d, external } = deps(db, overrides);
    assert.deepEqual(await handleAccountDeletion(input, d), { status, body: { ok: false, error } }, error);
    assert.deepEqual(db.calls, [], `${error}: no DB call`);
    assert.deepEqual(external, []);
  }
  assert.equal(lastAuthenticatedAt(jwt({ sub: USER, amr: [{ method: 'otp', timestamp: NOW - 5 }] }), USER), NOW - 5);
});

test('scope shown to the user must be the scope executed (no hidden cascade)', async () => {
  const db = fakeDb({ scope: 'social_only' });
  const { d } = deps(db);
  assert.deepEqual(await handleAccountDeletion(del(), d), { status: 409, body: { ok: false, error: 'SCOPE_CHANGED' } });
  assert.deepEqual(db.calls, ['preview']);
  const ok = fakeDb({ scope: 'social_only' });
  const run = deps(ok, { providers: ['apple', 'email'], revokeApple: null });
  assert.deepEqual(await handleAccountDeletion(del({ expected_scope: 'social_only' }), run.d), { status: 200, body: { ok: true, login_deleted: false } });
  assert.ok(!ok.calls.includes('mark_apple_revoked'), 'login kept: Apple sign-in is not revoked');
});

test('preview is read-only and truthful about Apple needs', async () => {
  const db = fakeDb();
  assert.deepEqual(await handlePreview({ authorization: `Bearer ${fresh}` }, deps(db, { providers: ['apple'], revokeApple: async () => true }).d),
    { status: 200, body: { ok: true, scope: 'social_and_login', state: 'none', apple_supported: true, apple_code_required: true } });
  assert.deepEqual(await handlePreview({ authorization: `Bearer ${fresh}` }, deps(fakeDb({ scope: 'social_only' }), { providers: ['apple'] }).d),
    { status: 200, body: { ok: true, scope: 'social_only', state: 'none', apple_supported: true, apple_code_required: false } });
  assert.deepEqual(await handlePreview({ authorization: `Bearer ${fresh}` }, deps(fakeDb(), { providers: ['apple'] }).d),
    { status: 200, body: { ok: true, scope: 'social_and_login', state: 'none', apple_supported: false, apple_code_required: true } });
  assert.deepEqual(db.calls, ['preview']);
  assert.deepEqual(await handlePreview({ authorization: null }, deps(fakeDb()).d), { status: 401, body: { ok: false, error: 'AUTH_REQUIRED' } });
});

test('blocked, in progress and operator states: fixed codes, nothing external', async () => {
  for (const [db, error] of [[fakeDb({ blocked: 'CREDENTIAL_OWNERSHIP_AMBIGUOUS' }), 'DELETION_BLOCKED_CREDENTIAL_OWNERSHIP_AMBIGUOUS'], [fakeDb({ blocked: '<x>' }), 'DELETION_BLOCKED_UNKNOWN']] as const) {
    const { d, external } = deps(db);
    assert.deepEqual(await handleAccountDeletion(del(), d), { status: 409, body: { ok: false, error } });
    assert.deepEqual(external, []);
  }
  const busy = fakeDb();
  await busy.rpc('acquire', { p_user_id: USER, p_expected_scope: 'social_and_login', p_apple_required: false });
  assert.deepEqual(await handleAccountDeletion(del(), deps(busy).d), { status: 409, body: { ok: false, error: 'DELETION_IN_PROGRESS' } });
});

test('H2 R4: connected account with missing material goes to the operator; never a silent skip', async () => {
  const db = fakeDb({ operatorAtCredentials: true });
  const { d, external } = deps(db);
  assert.deepEqual(await handleAccountDeletion(del(), d), { status: 409, body: { ok: false, error: 'DELETION_OPERATOR_REQUIRED' } });
  assert.deepEqual(external, []);
  assert.ok(!db.calls.includes('mark_x_revoked') && !db.calls.includes('purge') && !db.calls.includes('finalize'));
  assert.deepEqual(await handleAccountDeletion(del(), d), { status: 409, body: { ok: false, error: 'DELETION_OPERATOR_REQUIRED' } }, 'stays with the operator');
  // Defensive: a revoke-required account without material is never marked.
  const odd = fakeDb({ accounts: [{ id: 'sa_x', revoke_required: true, access_token: null, refresh_token: null }] });
  assert.deepEqual(await handleAccountDeletion(del(), deps(odd).d), { status: 500, body: { ok: false, error: 'FAILED' } });
  assert.ok(!odd.calls.includes('mark_x_revoked') && odd.calls.includes('release'));
  // Truly never connected: no revoke, still completes.
  const never = fakeDb({ accounts: [{ id: 'sa_x', revoke_required: false, access_token: null, refresh_token: null }] });
  const run = deps(never);
  assert.equal((await handleAccountDeletion(del(), run.d)).status, 200);
  assert.deepEqual(run.external, []);
});

test('X failure or changed material: stop, release the lease, retry resumes', async () => {
  const db = fakeDb();
  let fail = true;
  const { d, external } = deps(db, { revokeX: async (token, hint) => { external.push(`${hint}:${token}`); return !fail; } });
  assert.deepEqual(await handleAccountDeletion(del(), d), { status: 502, body: { ok: false, error: 'X_REVOKE_FAILED' } });
  assert.ok(db.calls.includes('release') && !db.calls.includes('mark_x_revoked') && !db.calls.includes('purge'));
  fail = false;
  assert.equal((await handleAccountDeletion(del(), d)).status, 200, 'retry after release');
  const changed = fakeDb();
  const wrongHash = deps(changed, { sha256Hex: async () => '0'.repeat(64) });
  assert.deepEqual(await handleAccountDeletion(del(), wrongHash.d), { status: 409, body: { ok: false, error: 'CREDENTIALS_CHANGED' } });
  assert.ok(!changed.calls.includes('purge'));
});

test('H2 R5: Apple revoked, then purge fails; the retry needs no (consumed) code and skips Apple', async () => {
  const db = fakeDb({ purgeError: 'SOCIAL_MOBILE_DELETION_SOMETHING' });
  const apple: string[] = [];
  const { d } = deps(db, { providers: ['apple'], revokeApple: async (code, subjects) => { apple.push(`${code}@${subjects.join(',')}`); return true; } });
  assert.deepEqual(await handleAccountDeletion(del({ apple_authorization_code: 'code-1' }), d), { status: 500, body: { ok: false, error: 'FAILED' } });
  assert.deepEqual(apple, ['code-1@apple-sub-1']);
  assert.equal(db.tombstone()?.appleRevoked, true, 'durable checkpoint');
  assert.deepEqual(await handleAccountDeletion(del(), d), { status: 200, body: { ok: true, login_deleted: true } }, 'retry without a code');
  assert.deepEqual(apple, ['code-1@apple-sub-1'], 'Apple not called again');
  // Without the checkpoint a code is required up front (no side effect).
  const fresh2 = fakeDb();
  const f = deps(fresh2, { providers: ['apple'], revokeApple: async () => true });
  assert.deepEqual(await handleAccountDeletion(del(), f.d), { status: 400, body: { ok: false, error: 'APPLE_REAUTH_REQUIRED' } });
  assert.deepEqual(fresh2.calls, ['preview']);
  // Apple failure: no checkpoint, no purge.
  const failing = fakeDb();
  const g = deps(failing, { providers: ['apple'], revokeApple: async () => false });
  assert.deepEqual(await handleAccountDeletion(del({ apple_authorization_code: 'c' }), g.d), { status: 502, body: { ok: false, error: 'APPLE_REVOKE_FAILED' } });
  assert.ok(!failing.calls.includes('mark_apple_revoked') && !failing.calls.includes('purge'));
});

test('purge/finalize failures never report success', async () => {
  const dep = fakeDb({ purgeError: 'SOCIAL_MOBILE_DELETION_UNEXPECTED_DEPENDENT_DATA' });
  assert.deepEqual(await handleAccountDeletion(del(), deps(dep).d), { status: 409, body: { ok: false, error: 'DELETION_BLOCKED_UNEXPECTED_DEPENDENT_DATA' } });
  assert.ok(!dep.calls.includes('finalize'));
  const lost = fakeDb({ purgeError: 'SOCIAL_MOBILE_DELETION_LEASE_LOST' });
  assert.deepEqual(await handleAccountDeletion(del(), deps(lost).d), { status: 409, body: { ok: false, error: 'DELETION_IN_PROGRESS' } });
  const kept = fakeDb({ finalizeLoginDeleted: false });
  assert.deepEqual(await handleAccountDeletion(del(), deps(kept).d), { status: 200, body: { ok: true, login_deleted: false, login_kept_reason: 'MAIN_APP_ACCOUNT_PRESENT' } });
});

test('responses never carry tokens; sources never log or trust a body user id', async () => {
  const db = fakeDb();
  const { d } = deps(db, { revokeX: async () => false });
  assert.doesNotMatch(JSON.stringify(await handleAccountDeletion(del(), d)), /FAKE_|eyJ|Bearer|lease/u);
  const dir = new URL('.', import.meta.url);
  for (const file of ['index.ts', 'http.ts', 'delete_logic.ts', 'apple_revoke.ts']) {
    const source = await Deno.readTextFile(new URL(file, dir));
    assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)/u, file);
    assert.doesNotMatch(source, /body\??\.(user_id|p_user_id|userId|id)\b/u, file);
  }
});
