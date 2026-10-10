// The Apple step through the ACTUAL production wiring (H2 rereview R2): createHandler with its real
// adapters -- the typed Apple adapter, Auth / PostgREST / Storage / Admin calls -- over a mock network: the
// fake lifecycle database behind the RPC endpoints and a mock Apple that consumes single-use codes. A
// throwaway EC key, no real credential, no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { APPLE_SUBJECT, appleServer, fakeAppleConfig, type ExchangeBehavior, type RevokeBehavior } from './fake_apple.ts';
import { b64, SETTLE_SECONDS, USER, world, type World, type WorldOptions } from './fake_lifecycle.ts';
import { createHandler, RPC_NAMES, X_DELETION_FUNCTION } from './http.ts';
import { DELETE_CONFIRMATION, LEASE_SECONDS } from './lifecycle_logic.ts';

const URL_ = 'https://fixture.supabase.co';
const ENDPOINT_RPC = Object.fromEntries(Object.entries(RPC_NAMES).map(([name, endpoint]) => [endpoint, name])) as Record<string, keyof typeof RPC_NAMES>;
let sessions = 0;
/** A fresh sign-in now (the handler checks the recent sign-in against the real clock). */
const freshToken = () => `${b64({ alg: 'HS256' })}.${b64({ sub: USER, session_id: `wired-${++sessions}`, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 30 }] })}.sig`;

/** Routes the handler's real requests to the fake world and the mock Apple. */
function network(w: World, apple: ReturnType<typeof appleServer>) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (input.startsWith('https://appleid.apple.com/')) return apple.fetchImpl(input, init);
    const path = input.slice(URL_.length);
    const token = (new Headers(init.headers).get('Authorization') ?? '').replace(/^Bearer /u, '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (path === '/auth/v1/user') {
      const user = await w.deps.getUser(token);
      if (!user) return Response.json({ message: 'invalid' }, { status: 401 });
      return Response.json({ id: user.id, identities: [{ provider: 'email', id: 'e' }, ...(w.state.apple ? [{ provider: 'apple', id: APPLE_SUBJECT }] : [])] });
    }
    if (path === '/auth/v1/logout?scope=global') return new Response(null, { status: (await w.deps.revokeSessions(token)) ? 204 : 500 });
    if (path.startsWith('/rest/v1/rpc/')) {
      const result = await w.deps.rpc(ENDPOINT_RPC[path.slice('/rest/v1/rpc/'.length)], body ?? {});
      return result.ok ? Response.json(result.data) : Response.json({ message: 'fixture error' }, { status: 500 });
    }
    if (path.startsWith('/storage/v1/object/')) {
      const ok = await w.deps.removeStorageObjects(decodeURIComponent(path.slice('/storage/v1/object/'.length)), body.prefixes);
      return ok ? Response.json([]) : new Response('no', { status: 500 });
    }
    if (path.startsWith('/auth/v1/admin/users/')) {
      const id = decodeURIComponent(path.slice('/auth/v1/admin/users/'.length));
      if (init.method === 'DELETE') {
        const deleted = await w.deps.deleteLogin(id);
        return new Response('{}', { status: deleted === 'deleted' ? 200 : deleted === 'not_found' ? 404 : 500 });
      }
      const state = await w.deps.loginState(id);
      return new Response('{}', { status: state === 'present' ? 200 : state === 'absent' ? 404 : 500 });
    }
    if (path === `/functions/v1/${X_DELETION_FUNCTION}`) {
      if (body.action === 'preview') return Response.json({ ok: true, ...(await w.deps.x.preview(token)) });
      const outcome = await w.deps.x.run(token);
      return outcome === 'done' ? Response.json({ ok: true, login_deleted: false }) : Response.json({ ok: false, error: 'FAILED' }, { status: 500 });
    }
    return Response.json({ message: 'not in fixture' }, { status: 404 });
  };
}

async function wired(worldOptions: WorldOptions, appleOptions: { exchange?: ExchangeBehavior[]; revoke?: RevokeBehavior[]; onRevoke?: (w: World) => void }) {
  const w = world({ apple: true, ...worldOptions });
  const apple = appleServer({ exchange: appleOptions.exchange, revoke: appleOptions.revoke, onRevoke: () => appleOptions.onRevoke?.(w) });
  const config = await fakeAppleConfig();
  const env = new Map(Object.entries({
    SUPABASE_URL: URL_, SUPABASE_ANON_KEY: 'fixture-anon', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service',
    APPLE_TEAM_ID: config.teamId, APPLE_KEY_ID: config.keyId, APPLE_CLIENT_ID: config.clientId, APPLE_PRIVATE_KEY: config.privateKeyPem,
  }));
  const handler = createHandler({ get: (name) => env.get(name) }, network(w, apple));
  const remove = async (code: string) => {
    const response = await handler(new Request('https://edge.fixture/account-delete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${freshToken()}` },
      body: JSON.stringify({ action: 'delete_common_account', confirmation: DELETE_CONFIRMATION, expected_lifecycle_version: w.state.version, apple_authorization_code: code }),
    }));
    return { status: response.status, body: await response.json() };
  };
  return { w, apple, remove };
}

test('H2_R2_ADAPTER_AMBIGUOUS_502_CLEARED_AND_REPLAYED is now impossible: a 502 after the revocation keeps the intent and never exchanges the code twice', async () => {
  const { w, apple, remove } = await wired({}, { revoke: ['applied_then_502'] });
  const first = await remove('code-1');
  assert.deepEqual(first.body, { ok: false, error: 'RECONCILIATION_REQUIRED', sessions_revoked: true });
  assert.deepEqual([apple.state.exchanges, apple.state.revocations], [1, 1]);
  assert.equal(w.state.op?.external, 'apple_revocation', 'the durable intent stays');
  assert.equal(w.state.op?.checkpoints.has('apple_revocation'), false, 'not assumed either way');
  assert.equal((await remove('code-1')).body.error, 'DELETION_IN_PROGRESS', 'right after: in progress');
  w.state.clock += LEASE_SECONDS + SETTLE_SECONDS + 1;
  assert.equal((await remove('code-1')).body.error, 'RECONCILIATION_REQUIRED', 'after the lease and the settle window: reconciliation');
  assert.equal(apple.state.exchanges, 1, 'the consumed code was sent once');
  assert.equal(w.state.calls.delete, 0, 'no managed delete while unsettled');
});

test('ambiguous answers through the real wiring -- 5xx, transport failure, a lost revoke, an unexpected identity -- all keep the intent', async () => {
  for (const [label, exchange, revoke] of [
    ['token endpoint 500', ['server_error'], []],
    ['token endpoint transport failure', ['throw'], []],
    ['token endpoint 429', ['rate_limited'], []],
    ['revoke transport failure', ['ok'], ['throw']],
    ['revoke refused after the code was consumed', ['ok'], ['refused_400']],
    ['code of another Apple identity', ['wrong_subject'], []],
  ] as [string, ExchangeBehavior[], RevokeBehavior[]][]) {
    const { w, apple, remove } = await wired({}, { exchange, revoke });
    assert.equal((await remove('code-1')).body.error, 'RECONCILIATION_REQUIRED', label);
    assert.equal(w.state.op?.external, 'apple_revocation', `${label}: intent kept`);
    w.state.clock += LEASE_SECONDS + SETTLE_SECONDS + 1;
    assert.equal((await remove('code-1')).body.error, 'RECONCILIATION_REQUIRED', `${label}: retry`);
    assert.equal(apple.state.exchanges, 1, `${label}: never exchanged twice`);
    assert.equal(w.state.calls.delete, 0);
  }
});

test('a definitive refusal of the token request clears the intent; a new code then completes', async () => {
  const { w, apple, remove } = await wired({}, { exchange: ['invalid_grant'] });
  const first = await remove('code-1');
  assert.deepEqual(first.body, { ok: false, error: 'APPLE_REVOKE_FAILED', sessions_revoked: true });
  assert.equal(w.state.op?.external, null);
  const second = await remove('code-2');
  assert.deepEqual(second.body, { ok: true, outcome: 'deleted' });
  assert.deepEqual(apple.state.codesSent, ['code-1', 'code-2'], 'each code exchanged once');
  assert.equal(apple.state.revocations, 1);
  assert.equal(w.state.calls.delete, 1);
});

test('Apple succeeded but the database could not record it -- reconciliation, never a second exchange', async () => {
  const { w, apple, remove } = await wired({ rpcFailOnce: { settle_external_step: 1 } }, {});
  assert.equal((await remove('code-1')).body.error, 'RECONCILIATION_REQUIRED');
  assert.deepEqual([apple.state.exchanges, apple.state.revocations], [1, 1]);
  w.state.clock += LEASE_SECONDS + SETTLE_SECONDS + 1;
  assert.equal((await remove('code-1')).body.error, 'RECONCILIATION_REQUIRED');
  assert.equal(apple.state.exchanges, 1);
  // An operator confirms the revocation out of band; the person resumes without Apple.
  w.resolveApple(true);
  assert.deepEqual((await remove('code-1')).body, { ok: true, outcome: 'deleted' });
  assert.equal(apple.state.exchanges, 1);
});

test('the owner lost its lease while Apple was answering -- nothing recorded, never replayed', async () => {
  const { w, apple, remove } = await wired({}, { onRevoke: (world_) => { world_.state.clock += LEASE_SECONDS + 1; } });
  assert.equal((await remove('code-1')).body.error, 'RECONCILIATION_REQUIRED');
  assert.equal(w.state.op?.checkpoints.has('apple_revocation'), false);
  assert.equal(w.state.op?.external, 'apple_revocation');
  assert.equal((await remove('code-1')).body.error, 'DELETION_IN_PROGRESS', 'the step may still be settling');
  w.state.clock += SETTLE_SECONDS + 1;
  assert.equal((await remove('code-1')).body.error, 'RECONCILIATION_REQUIRED');
  assert.equal(apple.state.exchanges, 1);
});

test('the normal path through the real wiring: Apple once, then the verified deletion', async () => {
  const { w, apple, remove } = await wired({}, {});
  assert.deepEqual((await remove('code-1')).body, { ok: true, outcome: 'deleted' });
  assert.deepEqual([apple.state.exchanges, apple.state.revocations], [1, 1]);
  assert.deepEqual([...apple.state.revoked], ['grant-for-code-1']);
  assert.equal(w.state.calls.delete, 1);
});
