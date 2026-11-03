// G4-45 (Issue #319; H1 #306 20th review, P2 F2): disconnect() through the REAL @supabase/supabase-js client (the lockfile's
// version). Only Auth is synthetic: auth.getSession answers from a script, one entry per read, so the signed-in session can change
// between the hook's own check and the SDK reading the token at send time. No network: the client's fetch only records the
// request. The hook is the real use-x-connect.ts, transpiled. X_CONNECT_HOOK_SOURCE=<path> runs the same cases against another
// copy of the hook (used to show the fail-before on the reviewed head #523).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import vm from 'node:vm';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';
import * as oauth from '../src/lib/x-oauth-onboarding.ts';
import * as recoveryBinding from '../src/domain/recovery-binding.ts';

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A synthetic session: user id + session id claim; a different label is a refreshed token of the same session. */
const sessionOf = (userId, sessionId, label = '1') => ({
  access_token: `${b64url({ alg: 'none' })}.${b64url({ sub: userId, session_id: sessionId })}.${label}`,
  user: { id: userId },
});
const A = sessionOf('user-a', 'sess-a');
const A_REFRESHED = sessionOf('user-a', 'sess-a', '2');
const A_NEW_SESSION = sessionOf('user-a', 'sess-a2');
const B = sessionOf('user-b', 'sess-b');
const hookSource = process.env.X_CONNECT_HOOK_SOURCE
  ? await readFile(process.env.X_CONNECT_HOOK_SOURCE, 'utf8')
  : await readFile(new URL('../src/features/x-connect/use-x-connect.ts', import.meta.url), 'utf8');

/** script: the session each auth.getSession() read answers, in order (the last one repeats). */
function harness(script, { status = 200 } = {}) {
  const slots = [], requests = [];
  let cursor = 0, completed = 0, reads = 0;
  const client = createClient('https://example.supabase.co', 'sb_publishable_fake_0123456789', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({ url: String(input), authorization: headers.get('Authorization') });
        return status === 200
          ? new Response(JSON.stringify('unconnected'), { status, headers: { 'content-type': 'application/json' } })
          : new Response(JSON.stringify({ message: 'OWN_WORKSPACE_CONFLICT', code: 'P0001' }), {
            status, headers: { 'content-type': 'application/json' } });
      },
    },
  });
  // Synthetic Auth only: the SDK's own token read (fetchWithAuth -> _getSessionToken -> auth.getSession) goes through this too.
  client.auth.getSession = async () => {
    const session = script[Math.min(reads, script.length - 1)];
    reads += 1;
    return { data: { session }, error: null };
  };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback: (cb) => cb,
  };
  const modules = {
    react,
    'react-native': { Platform: { OS: 'android' } },
    'expo-crypto': { getRandomBytesAsync: async (n) => new Uint8Array(n), digestStringAsync: async () => '', CryptoDigestAlgorithm: {}, CryptoEncoding: {} },
    'expo-linking': { createURL: () => 'kabumori-social://oauth-callback' },
    'expo-web-browser': { maybeCompleteAuthSession() {}, openAuthSessionAsync: async () => ({ type: 'cancel' }) },
    '@/features/x-connect/auth-session-options': { xConnectAuthSessionOptions },
    '@/domain/recovery-binding': recoveryBinding,
    '@/lib/x-oauth-onboarding': oauth,
    '@/providers/auth-provider': { useAuth: () => ({ session: A }) },  // the screen shows A
    '@/lib/supabase': { supabase: client },
  };
  const js = ts.transpileModule(hookSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, URL,
    require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; } }, { filename: 'use-x-connect.ts' });
  const render = () => { cursor = 0; return mod.exports.useXConnect(() => { completed += 1; }); };
  return { client, requests, render, completed: () => completed, reads: () => reads };
}

const rpcUrl = 'https://example.supabase.co/rest/v1/rpc/disconnect_social_mobile_x_connection';

test('control: A throughout -> one request with A\'s token, disconnected, one reload', async () => {
  const h = harness([A]);
  await h.render().disconnect();
  assert.deepEqual(h.requests, [{ url: rpcUrl, authorization: `Bearer ${A.access_token}` }]);
  assert.equal(h.render().state, 'disconnected');
  assert.equal(h.completed(), 1);
});

test('H1 F2: A checked, then B is signed in when the SDK reads the token -> the request still carries A\'s token; B sees no success', async () => {
  const h = harness([A, B, B]);
  await h.render().disconnect();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].authorization, `Bearer ${A.access_token}`, 'never B\'s token');
  assert.equal(h.render().state, 'session_changed');
  assert.equal(h.completed(), 0);
});

test('sign-out while the request is out -> A\'s token was sent; nothing is shown as done', async () => {
  const h = harness([A, null, null]);
  await h.render().disconnect();
  assert.equal(h.requests[0]?.authorization, `Bearer ${A.access_token}`);
  assert.equal(h.render().state, 'session_changed');
  assert.equal(h.completed(), 0);
});

test('A -> B -> A: a NEW session of A by the answer -> not the session that started; nothing shown', async () => {
  const h = harness([A, A_NEW_SESSION, A_NEW_SESSION]);
  await h.render().disconnect();
  assert.equal(h.requests[0]?.authorization, `Bearer ${A.access_token}`);
  assert.equal(h.render().state, 'session_changed');
  assert.equal(h.completed(), 0);
});

test('the owner changes while the answer is awaited (B after the send) -> nothing shown, no reload', async () => {
  const h = harness([A, A, B]);
  await h.render().disconnect();
  assert.equal(h.requests[0]?.authorization, `Bearer ${A.access_token}`);
  assert.equal(h.render().state, 'session_changed');
  assert.equal(h.completed(), 0);
});

test('the same session refreshed its token meanwhile -> still the owner; disconnected', async () => {
  const h = harness([A, A_REFRESHED, A_REFRESHED]);
  await h.render().disconnect();
  assert.equal(h.requests[0]?.authorization, `Bearer ${A.access_token}`, 'the token that was checked');
  assert.equal(h.render().state, 'disconnected');
  assert.equal(h.completed(), 1);
});

test('a refusal is shown only to the same person (A checked, B by the answer)', async () => {
  const same = harness([A], { status: 400 });
  await same.render().disconnect();
  assert.equal(same.render().state, 'workspace_blocked');
  const changed = harness([A, A, B], { status: 400 });
  await changed.render().disconnect();
  assert.equal(changed.render().state, 'session_changed');
});

test('the shared client is not changed: a later plain RPC on it carries the SDK\'s current session (B), not A\'s pinned token', async () => {
  const h = harness([A, B, B, B]);
  await h.render().disconnect();
  await h.client.rpc('some_other_rpc');
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].authorization, `Bearer ${A.access_token}`, 'the disconnect: A\'s token, for that request only');
  assert.equal(h.requests[1].authorization, `Bearer ${B.access_token}`, 'the next call: the SDK\'s own read');
});
