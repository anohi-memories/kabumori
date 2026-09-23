import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountDeleteError, bearerToken, deleteOwnAccount, resolveCallerUserId } from './delete_logic.ts';

const SUPABASE_URL = 'https://project.supabase.co';
const ANON = 'anon-key';
const SERVICE_ROLE = 'service-role-key-value';

type Call = { url: string; init?: RequestInit };

function fakeFetch(
  handlers: { user?: () => Response; adminDelete?: (url: string) => Response },
  calls: Call[] = [],
) {
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/v1/user')) {
      return handlers.user?.() ?? Response.json({ id: 'user-1' });
    }
    if (url.includes('/auth/v1/admin/users/')) {
      return handlers.adminDelete?.(url) ?? new Response(null, { status: 200 });
    }
    throw new Error(`unexpected call: ${url}`);
  };
  return { impl, calls };
}

function args(overrides: Partial<Parameters<typeof deleteOwnAccount>[0]> = {}) {
  return {
    authorizationHeader: 'Bearer caller-token',
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON,
    serviceRoleKey: SERVICE_ROLE,
    ...overrides,
  };
}

test('a missing or malformed Authorization header is rejected before any call', async () => {
  for (const header of [null, '', 'Bearer', 'Basic abc', 'Bearer    ']) {
    const { impl, calls } = fakeFetch({});
    await assert.rejects(
      () => deleteOwnAccount(args({ authorizationHeader: header, fetchImpl: impl })),
      (error: unknown) => {
        assert.ok(error instanceof AccountDeleteError);
        assert.equal(error.message, 'ACCOUNT_DELETE_AUTH_REQUIRED');
        assert.equal(error.status, 401);
        return true;
      },
    );
    assert.equal(calls.length, 0, `header ${JSON.stringify(header)} should not reach the network`);
  }
});

test('a token the auth server rejects never reaches the admin endpoint', async () => {
  const { impl, calls } = fakeFetch({ user: () => new Response('{}', { status: 401 }) });
  await assert.rejects(
    () => deleteOwnAccount(args({ fetchImpl: impl })),
    (error: unknown) => (error as AccountDeleteError).status === 401,
  );
  assert.deepEqual(calls.map((call) => call.url), [`${SUPABASE_URL}/auth/v1/user`]);
});

test('a verified caller deletes exactly their own id with the service role key', async () => {
  const { impl, calls } = fakeFetch({ user: () => Response.json({ id: 'user-abc' }) });
  const result = await deleteOwnAccount(args({ fetchImpl: impl }));
  assert.deepEqual(result, { userId: 'user-abc', alreadyDeleted: false });

  const adminCall = calls[1];
  assert.equal(adminCall.url, `${SUPABASE_URL}/auth/v1/admin/users/user-abc`);
  assert.equal(adminCall.init?.method, 'DELETE');
  const headers = adminCall.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${SERVICE_ROLE}`);
  // No body at all: nothing the client sent can influence what is deleted, and no
  // should_soft_delete flag is passed, so the delete stays a hard delete that cascades.
  assert.equal(adminCall.init?.body, undefined);

  // The caller's own token is only ever presented to the auth verification endpoint.
  const userCall = calls[0];
  assert.equal(
    (userCall.init?.headers as Record<string, string>).Authorization,
    'Bearer caller-token',
  );
});

test('a spoofed user id in the request cannot target another user', async () => {
  // deleteOwnAccount takes no id argument at all; the only id that can reach the admin endpoint is
  // the one the auth server returned for the caller's token. This test pins that shape: even when
  // the auth server says the caller is user-1, no other id appears in any call.
  const { impl, calls } = fakeFetch({ user: () => Response.json({ id: 'user-1' }) });
  await deleteOwnAccount(args({ fetchImpl: impl }));
  const victimId = 'victim-9999';
  for (const call of calls) {
    assert.ok(!call.url.includes(victimId));
    assert.ok(!JSON.stringify(call.init ?? {}).includes(victimId));
  }
  assert.ok(calls[1].url.endsWith('/user-1'));
});

test('an auth response without a usable id fails closed', async () => {
  for (const body of [{}, { id: '' }, { id: 42 }]) {
    const { impl, calls } = fakeFetch({ user: () => Response.json(body) });
    await assert.rejects(
      () => resolveCallerUserId({
        authorizationHeader: 'Bearer caller-token',
        supabaseUrl: SUPABASE_URL,
        anonKey: ANON,
        fetchImpl: impl,
      }),
      (error: unknown) => (error as AccountDeleteError).status === 401,
    );
    assert.equal(calls.length, 1);
  }
});

test('repeating the call after the user is gone reports success, not failure', async () => {
  const { impl } = fakeFetch({ adminDelete: () => new Response(null, { status: 404 }) });
  const result = await deleteOwnAccount(args({ fetchImpl: impl }));
  assert.deepEqual(result, { userId: 'user-1', alreadyDeleted: true });
});

test('an admin endpoint failure is reported as a failure, never as a deletion', async () => {
  for (const status of [400, 403, 429, 500, 503]) {
    const { impl } = fakeFetch({ adminDelete: () => new Response('nope', { status }) });
    await assert.rejects(
      () => deleteOwnAccount(args({ fetchImpl: impl })),
      (error: unknown) => {
        assert.equal((error as AccountDeleteError).message, 'ACCOUNT_DELETE_FAILED');
        assert.equal((error as AccountDeleteError).status, 500);
        return true;
      },
    );
  }
});

test('a network failure on either hop fails closed', async () => {
  const throwing = () => Promise.reject(new Error('network down'));
  await assert.rejects(
    () => deleteOwnAccount(args({ fetchImpl: throwing as never })),
    (error: unknown) => (error as AccountDeleteError).status === 401,
  );

  const impl = async (url: string) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user-1' });
    throw new Error('network down');
  };
  await assert.rejects(
    () => deleteOwnAccount(args({ fetchImpl: impl as never })),
    (error: unknown) => (error as AccountDeleteError).status === 500,
  );
});

test('no thrown error carries the service role key or the caller token', async () => {
  const cases: Array<() => Promise<unknown>> = [
    () => deleteOwnAccount(args({ authorizationHeader: null })),
    () => deleteOwnAccount(args({
      fetchImpl: fakeFetch({ user: () => new Response('{}', { status: 401 }) }).impl,
    })),
    () => deleteOwnAccount(args({
      fetchImpl: fakeFetch({ adminDelete: () => new Response('x', { status: 500 }) }).impl,
    })),
  ];
  for (const run of cases) {
    const error = await run().then(() => null, (thrown: Error) => thrown);
    assert.ok(error);
    const text = `${error.message} ${error.stack ?? ''}`;
    assert.ok(!text.includes(SERVICE_ROLE));
    assert.ok(!text.includes('caller-token'));
  }
});

test('bearerToken accepts only a real bearer value', () => {
  assert.equal(bearerToken('Bearer abc'), 'abc');
  assert.equal(bearerToken('bearer  abc  '), 'abc');
  assert.equal(bearerToken('Bearer '), null);
  assert.equal(bearerToken('abc'), null);
  assert.equal(bearerToken(null), null);
});
