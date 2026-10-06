// Common-account Phase 2: X autopost enrolls every real-data session through the reviewed lifecycle RPC
// public.start_x_autopost_service() before any workspace data loads. The decision logic is exercised with
// an injected client; the gate wiring and its boundaries are pinned from source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  createEnrollmentGate,
  EnrollmentUnavailableError,
  enrollService,
} from '../src/domain/service-enrollment.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(join(root, path), 'utf8');
// Code only: comments may explain what the code does not do.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');

function fakeClient(rows, start, readError = null) {
  const calls = { reads: 0, starts: 0 };
  return {
    calls,
    readOwnEntitlements: () => { calls.reads += 1; return Promise.resolve({ data: readError ? null : rows, error: readError }); },
    startService: () => { calls.starts += 1; return Promise.resolve(start); },
  };
}
const STARTED = { data: { status: 'active', service: 'x_autopost', started: true }, error: null };
const EXISTING = { data: { status: 'active', service: 'x_autopost', started: false }, error: null };

test('a new Auth user gets the X autopost entitlement through the start RPC', async () => {
  const client = fakeClient([], STARTED);
  assert.deepEqual(await enrollService(client, 'x_autopost'), { kind: 'ready', started: true, sharedAccountNotice: false });
  assert.deepEqual(client.calls, { reads: 1, starts: 1 });
});

test('a common account that only uses Kabumori gets X added, with the shared-account notice', async () => {
  const client = fakeClient([{ service_key: 'kabumori', status: 'active' }], STARTED);
  assert.deepEqual(await enrollService(client, 'x_autopost'), { kind: 'ready', started: true, sharedAccountNotice: true });
});

test('an active X entitlement is idempotent', async () => {
  const client = fakeClient([{ service_key: 'x_autopost', status: 'active' }], EXISTING);
  assert.deepEqual(await enrollService(client, 'x_autopost'), { kind: 'ready', started: false, sharedAccountNotice: false });
});

test('an ended X entitlement needs the person\'s explicit re-enrollment', async () => {
  const silent = fakeClient([{ service_key: 'x_autopost', status: 'ended' }], STARTED);
  assert.deepEqual(await enrollService(silent, 'x_autopost'), { kind: 'reenroll_required' });
  assert.equal(silent.calls.starts, 0);
  const explicit = fakeClient([{ service_key: 'x_autopost', status: 'ended' }], STARTED);
  assert.equal((await enrollService(explicit, 'x_autopost', { allowReenroll: true })).kind, 'ready');
});

test('lifecycle refusals and unknown answers fail closed; a removed login is blocked; transient failures are retryable', async () => {
  const blocked = fakeClient([], { data: { status: 'blocked', reason: 'ACCOUNT_DELETION_IN_PROGRESS' }, error: null });
  assert.deepEqual(await enrollService(blocked, 'x_autopost'), { kind: 'blocked', reason: 'ACCOUNT_DELETION_IN_PROGRESS' });
  const wrongService = fakeClient([], { data: { status: 'active', service: 'kabumori', started: true }, error: null });
  assert.deepEqual(await enrollService(wrongService, 'x_autopost'), { kind: 'blocked', reason: 'UNKNOWN' });
  const gone = fakeClient([], { data: null, error: { message: 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', code: '42501' } });
  assert.deepEqual(await enrollService(gone, 'x_autopost'), { kind: 'blocked', reason: 'ACCOUNT_NOT_FOUND' });
  const offline = fakeClient([], { data: null, error: { message: 'Network request failed' } });
  await assert.rejects(enrollService(offline, 'x_autopost'), EnrollmentUnavailableError);
});

test('repeated session restores share one enrollment per person', async () => {
  let runs = 0;
  const gate = createEnrollmentGate(() => { runs += 1; return Promise.resolve({ kind: 'ready', started: false, sharedAccountNotice: false }); });
  await Promise.all([gate.ensure('u1'), gate.ensure('u1'), gate.ensure('u1')]);
  await gate.ensure('u1');
  assert.equal(runs, 1);
  gate.reset();
  await gate.ensure('u1');
  assert.equal(runs, 2);
});

test('the X logic is the same reviewed logic as Kabumori\'s (only the header differs)', async () => {
  const x = await read('src/domain/service-enrollment.ts');
  const kabumori = await readFile(join(root, '../../src/lib/service-enrollment.ts'), 'utf8');
  const body = (text) => text.split('\n').slice(6).join('\n');
  assert.equal(body(x), body(kabumori));
});

test('enrollment only calls the reviewed X RPC and reads its own entitlement rows; no posting authorization, credentials or publish enablement', async () => {
  const gate = await read('src/features/service-enrollment/service-enrollment-gate.tsx');
  assert.match(gate, /client\.rpc\('start_x_autopost_service'\)/u);
  assert.match(gate, /client\.from\('service_entitlements'\)\.select\('service_key,status'\)/u);
  const rpcs = [...gate.matchAll(/\.rpc\('([a-z_]+)'/gu)].map((m) => m[1]);
  assert.deepEqual(rpcs, ['start_x_autopost_service']);
  for (const text of [code(gate), code(await read('src/domain/service-enrollment.ts'))]) {
    assert.doesNotMatch(text, /functions\.invoke|x-oauth|oauth_state|publish|vault|brand_memberships|from\('brands'\)|social_accounts/iu);
    assert.doesNotMatch(text, /\.(insert|update|upsert|delete)\(/u, 'no direct client write');
    assert.doesNotMatch(text, /start_kabumori_service/u, 'X never enrolls the other app');
    assert.doesNotMatch(text, /email/iu, 'no e-mail based matching or merge');
  }
  const auth = await read('src/providers/auth-provider.tsx');
  assert.doesNotMatch(auth, /\.rpc\(|start_x_autopost_service/u, 'login itself still calls no RPC');
});

test('routing: auth, then service enrollment, then data and onboarding; mock preview is not gated; sign-out and deletion stay reachable', async () => {
  const layout = await read('src/app/_layout.tsx');
  const auth = layout.indexOf('if (!session) return <AuthScreen />');
  const recovery = layout.indexOf('if (recoveryMode) return <NewPasswordScreen />');
  const enrollment = layout.indexOf('<ServiceEnrollmentGate>');
  const data = layout.indexOf('<DataProvider>');
  const onboarding = layout.indexOf('<OnboardingGate>');
  assert.ok(auth > -1 && recovery > auth && enrollment > recovery && data > enrollment && onboarding > data);
  assert.match(layout, /<\/DataProvider><\/ServiceEnrollmentGate>/u);
  const gate = await read('src/features/service-enrollment/service-enrollment-gate.tsx');
  assert.match(gate, /if \(selection\.kind === 'mock'\) return <>\{children\}<\/>;/u);
  assert.match(gate, /<SignOutButton \/>/u);
  assert.match(gate, /<AccountDeletionScreen \/>/u);
  assert.match(gate, /useEffect\(\(\) => \(\) => enrollment\.reset\(\), \[\]\)/u, 'leaving the signed-in tree forgets the outcome');
  assert.match(gate, /current\.outcome\.kind === 'ready' && \(!current\.outcome\.sharedAccountNotice \|\| current\.noticeAcknowledged\)/u,
    'only a ready enrollment opens the app');
});
