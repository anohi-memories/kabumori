// The typed Apple outcome (H2 rereview R2) against a mock of Apple's endpoints with a throwaway EC key: an
// answer is a definitive failure only when nothing reached Apple or Apple refused the token request
// itself; everything after dispatch that is not a confirmed revocation is 'unknown'.
import assert from 'node:assert/strict';
import test from 'node:test';

import { revokeAppleGrantOutcome } from './apple_outcome.ts';
import { APPLE_SUBJECT, appleServer, fakeAppleConfig, type ExchangeBehavior, type RevokeBehavior } from './fake_apple.ts';

const NOW_S = Math.floor(Date.now() / 1000);

test('outcomes: only a confirmed revocation succeeds; only a refusal of the token request is definitive', async () => {
  const config = await fakeAppleConfig();
  const cases: [string, ExchangeBehavior[], RevokeBehavior[], string, number, number][] = [
    ['exchange ok, revoke ok', ['ok'], ['ok'], 'succeeded', 1, 1],
    ['revoke applied by Apple, then a gateway 502 (H2 counterexample)', ['ok'], ['applied_then_502'], 'unknown', 1, 1],
    ['revoke refused with 400 after the code was consumed', ['ok'], ['refused_400'], 'unknown', 1, 1],
    ['revoke transport failure', ['ok'], ['throw'], 'unknown', 1, 1],
    ['exchange refused: invalid_grant', ['invalid_grant'], [], 'definitively_failed', 1, 0],
    ['exchange refused: invalid_client (401)', ['invalid_client'], [], 'definitively_failed', 1, 0],
    ['exchange 400 with an unknown error', ['refused_unknown_error'], [], 'unknown', 1, 0],
    ['exchange 400 that is not an OAuth error', ['refused_unparsable'], [], 'unknown', 1, 0],
    ['exchange 500', ['server_error'], [], 'unknown', 1, 0],
    ['exchange 429', ['rate_limited'], [], 'unknown', 1, 0],
    ['exchange transport failure', ['throw'], [], 'unknown', 1, 0],
    ['exchange accepted without an id_token', ['no_id_token'], [], 'unknown', 1, 0],
    ['exchange accepted for another Apple identity', ['wrong_subject'], [], 'unknown', 1, 0],
    ['exchange accepted without a grant token', ['no_token'], [], 'unknown', 1, 0],
  ];
  for (const [label, exchange, revoke, expected, exchanges, revocations] of cases) {
    const apple = appleServer({ exchange, revoke });
    const outcome = await revokeAppleGrantOutcome(config, 'code-1', [APPLE_SUBJECT], NOW_S, apple.fetchImpl);
    assert.equal(outcome, expected, label);
    assert.equal(apple.state.exchanges, exchanges, `${label}: exchanges`);
    assert.equal(apple.state.revocations, revocations, `${label}: revocations`);
  }
});

test('a timeout after the request was sent is unknown (the code may be consumed)', async () => {
  const config = await fakeAppleConfig();
  const onExchange = appleServer({ exchange: ['hang'] });
  assert.equal(await revokeAppleGrantOutcome(config, 'code-1', [APPLE_SUBJECT], NOW_S, onExchange.fetchImpl, 20), 'unknown');
  const onRevoke = appleServer({ revoke: ['hang'] });
  assert.equal(await revokeAppleGrantOutcome(config, 'code-1', [APPLE_SUBJECT], NOW_S, onRevoke.fetchImpl, 20), 'unknown');
  assert.equal(onRevoke.state.revocations, 1);
});

test('nothing is sent when the client secret cannot be signed: definitive, the code is untouched', async () => {
  const apple = appleServer();
  const broken = { teamId: 'T', keyId: 'K', clientId: 'C', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----' };
  assert.equal(await revokeAppleGrantOutcome(broken, 'code-1', [APPLE_SUBJECT], NOW_S, apple.fetchImpl), 'definitively_failed');
  assert.equal(apple.state.exchanges, 0);
});

test('the request is what Apple expects: a signed ES256 client secret, the code once, the grant revoked', async () => {
  const config = await fakeAppleConfig();
  const apple = appleServer();
  assert.equal(await revokeAppleGrantOutcome(config, 'code-1', [APPLE_SUBJECT], NOW_S, apple.fetchImpl), 'succeeded');
  assert.deepEqual(apple.state.codesSent, ['code-1']);
  assert.deepEqual([...apple.state.revoked], ['grant-for-code-1']);
  const [header, payload] = apple.state.clientSecrets[0].split('.').slice(0, 2).map((part) => JSON.parse(atob(part.replace(/-/gu, '+').replace(/_/gu, '/'))));
  assert.deepEqual([header.alg, header.kid, payload.iss, payload.sub, payload.aud], ['ES256', 'FIXTUREKEY', 'FIXTURETEAM', 'jp.example.fixture', 'https://appleid.apple.com']);
});

test('the adapter logs nothing and returns only a fixed word', async () => {
  const config = await fakeAppleConfig();
  const logged: unknown[] = [];
  const original = { ...console };
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = (...args: unknown[]) => { logged.push(args); };
  const outcomes: string[] = [];
  try {
    for (const exchange of ['ok', 'throw', 'server_error', 'invalid_grant', 'wrong_subject'] as ExchangeBehavior[]) {
      outcomes.push(await revokeAppleGrantOutcome(config, 'secret-code', [APPLE_SUBJECT], NOW_S, appleServer({ exchange: [exchange] }).fetchImpl));
    }
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(logged, []);
  assert.ok(outcomes.every((o) => ['succeeded', 'definitively_failed', 'unknown'].includes(o)));
  const source = await Deno.readTextFile(new URL('./apple_outcome.ts', import.meta.url));
  assert.ok(!/console\./u.test(source));
});
