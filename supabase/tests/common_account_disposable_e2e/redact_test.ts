// Deterministic evidence redaction (Phase 3c offline readiness). Every "secret" below is fake and assembled at
// run time, so the repository holds no token-shaped literal.
import assert from 'node:assert/strict';
import test from 'node:test';

import { allowlist, E1_CONFIG_ALLOWLIST, redact } from './redact.ts';

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const FAKE = {
  jwt: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'fake-subject', role: 'authenticated' })}.ZmFrZXNpZ25hdHVyZQ`,
  sbSecret: ['sb', 'secret', 'FAKEfakeFAKEfake0123'].join('_'),
  sbPublishable: ['sb', 'publishable', 'FAKEpublishable0123'].join('_'),
  basic: btoa('fake-client:fake-secret'),
  code: 'FAKEauthorizationCODE123',
  state: 'FAKEstateVALUE456',
  refresh: 'FAKErefreshTOKEN789',
  email: 'fake.person+proof@example.test',
  uuid: '6f1c2a9e-0b7d-4c3e-9a5f-1e2d3c4b5a69',
  uuid2: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  ip: '203.0.113.7',
  ref: 'fakedisposableaaaaaa',
  pem: [`-----BEGIN ${'PRIVATE'} KEY-----`, 'RkFLRUtFWUZBS0VLRVk=', `-----END ${'PRIVATE'} KEY-----`].join('\n'),
};
const RAW = [
  `POST https://${FAKE.ref}.supabase.co/auth/v1/token?grant_type=refresh_token`,
  `Authorization: Bearer ${FAKE.jwt}`,
  `apikey: ${FAKE.sbPublishable}`,
  `x-proof-basic: Basic ${FAKE.basic}`,
  `GET /auth/v1/callback?code=${FAKE.code}&state=${FAKE.state}`,
  `{"refresh_token": "${FAKE.refresh}", "access_token": "${FAKE.jwt}", "service_key": "${FAKE.sbSecret}", "user": {"id": "${FAKE.uuid}", "email": "${FAKE.email}"}}`,
  `db read-back: identity of ${FAKE.uuid} linked after ban; session ${FAKE.uuid2}; from ${FAKE.ip}`,
  `project ${FAKE.ref} health ok`,
  FAKE.pem,
].join('\n');

test('nothing secret, personal or project-identifying survives', async () => {
  const out = await redact(RAW, 'p3c-run-20261011-01', [FAKE.ref]);
  for (const [name, value] of Object.entries(FAKE)) {
    assert.ok(!out.includes(value), `${name} leaked`);
  }
  for (const part of ['RkFLRUtFWUZBS0VLRVk', 'fake-subject', 'eyJ', 'sb_secret_', 'sb_publishable_', '@example.test']) assert.ok(!out.includes(part), `${part} leaked`);
  // Structure stays readable for the reviewer.
  for (const kept of ['/auth/v1/token?grant_type=refresh_token', 'Authorization: ', '/auth/v1/callback?code=', '&state=', 'linked after ban', 'health ok', '"refresh_token": "']) {
    assert.ok(out.includes(kept), `structure lost: ${kept}`);
  }
});

test('deterministic within a run, unlinkable across runs, and idempotent', async () => {
  const a = await redact(RAW, 'p3c-run-20261011-01', [FAKE.ref]);
  const b = await redact(RAW, 'p3c-run-20261011-01', [FAKE.ref]);
  const c = await redact(RAW, 'p3c-run-20261011-02', [FAKE.ref]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(await redact(a, 'p3c-run-20261011-01', [FAKE.ref]), a, 'redacting twice changes nothing');
  // The same person is the same placeholder everywhere in one run (correlation without identification).
  const placeholder = (await redact(FAKE.uuid, 'p3c-run-20261011-01')).trim();
  assert.match(placeholder, /^<uuid:[0-9a-f]{8}>$/u);
  assert.equal(a.split(placeholder).length - 1, 2, 'both mentions of the fake user share one placeholder');
});

test('refuses to run without a salt, or with a malformed ref to strip', async () => {
  await assert.rejects(redact('x', ''), /REDACTION_SALT_REQUIRED/u);
  await assert.rejects(redact('x', 'run', ['NOT-A-REF']), /REDACTION_REF_INVALID/u);
});

test('the E1 config capture is an allowlist of non-secret scalars', () => {
  const config = {
    security_manual_linking_enabled: true, api_max_request_duration: 10, jwt_exp: 3600,
    external_apple_secret: 'FAKE-SECRET', hook_custom_access_token_secrets: 'FAKE', smtp_pass: 'FAKE', sessions_timebox: { nested: 1 },
  };
  const kept = allowlist(config, E1_CONFIG_ALLOWLIST);
  assert.deepEqual(Object.keys(kept), [...E1_CONFIG_ALLOWLIST]);
  assert.equal(kept.security_manual_linking_enabled, true);
  assert.equal(kept.sessions_timebox, null, 'a non-scalar is dropped');
  assert.equal(kept.jwt_exp, 3600);
  assert.ok(!JSON.stringify(kept).includes('FAKE'), 'no secret-named field is copied');
  assert.throws(() => allowlist(config, ['external_apple_secret']), /ALLOWLIST_FIELD_LOOKS_SECRET/u);
  assert.throws(() => allowlist(config, ['smtp_pass']), /ALLOWLIST_FIELD_LOOKS_SECRET/u);
});
