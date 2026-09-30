import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';
import * as oauth from '../src/lib/x-oauth-onboarding.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
const plain = (value) => JSON.parse(JSON.stringify(value));

// Execute the actual hook with synthetic dependencies. Browser/Functions calls
// are captured locally; neither network access nor provider credentials exist.
async function hookHarness({ os = 'ios', browserResult, authorizationUrl = 'https://x.com/i/oauth2/authorize', startError = null, callbackError = null, callbackData = { success: true, handle: 'fixture_x' } } = {}) {
  const slots = [], browserCalls = [], requests = [];
  let cursor = 0, randomRound = 0, completed = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useCallback: (callback) => callback,
  };
  const modules = {
    react,
    'react-native': { Platform: { OS: os } },
    'expo-crypto': {
      getRandomBytesAsync: async (length) => new Uint8Array(length).fill(++randomRound),
      digestStringAsync: async (_, value) => createHash('sha256').update(value).digest('base64'),
      CryptoDigestAlgorithm: { SHA256: 'SHA256' }, CryptoEncoding: { BASE64: 'BASE64' },
    },
    'expo-linking': { createURL: () => 'kabumori-social://oauth-callback' },
    'expo-web-browser': {
      maybeCompleteAuthSession() {},
      openAuthSessionAsync: async (...args) => {
        browserCalls.push(args);
        const state = requests.at(-1).options.body.state;
        return browserResult ? browserResult({ state, redirect: args[1] }) : { type: 'success', url: `${args[1]}?state=${state}&code=fixture_code` };
      },
    },
    '@/features/x-connect/auth-session-options': { xConnectAuthSessionOptions },
    '@/lib/x-oauth-onboarding': oauth,
    '@/providers/auth-provider': { useAuth: () => ({ session: { access_token: 'synthetic_app_jwt' } }) },
    '@/lib/supabase': { supabase: { functions: { invoke: async (name, options) => {
      requests.push({ name, options: plain(options) });
      return name.endsWith('/callback') ? { data: callbackData, error: callbackError } : { data: { authorization_url: authorizationUrl }, error: startError };
    } } } },
  };
  const source = await read('src/features/x-connect/use-x-connect.ts');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, URL,
    require: (name) => { assert.ok(Object.hasOwn(modules, name), `unexpected import ${name}`); return modules[name]; },
    fetch: () => { throw new Error('live network forbidden'); },
  }, { filename: 'use-x-connect.ts' });
  const render = () => { cursor = 0; return module.exports.useXConnect(() => { completed++; }); };
  return { render, browserCalls, requests, get completed() { return completed; } };
}

test('iOS X connect requests the documented private (ephemeral) auth session', () => {
  assert.deepEqual(xConnectAuthSessionOptions('ios'), { preferEphemeralSession: true });
});

test('Android/Web/other platforms get no options (Expo retains its default behavior)', () => {
  for (const os of ['android', 'web', 'windows', 'macos', '']) assert.equal(xConnectAuthSessionOptions(os), undefined, os);
});

test('the option exists in the installed expo-web-browser API and is iOS-only there', async () => {
  const types = await read('node_modules/expo-web-browser/build/WebBrowser.types.d.ts');
  assert.match(types, /preferEphemeralSession\?: boolean;/u);
  assert.match(types, /@default false\s+\* @platform ios\s+\*\/\s+preferEphemeralSession/u);
});

test('executed hook passes ephemeral options only on iOS with the exact URL and redirect', async () => {
  for (const os of ['ios', 'android', 'web']) {
    const harness = await hookHarness({ os });
    await harness.render().connect();
    const [url, redirect, options] = harness.browserCalls[0];
    assert.equal(url, 'https://x.com/i/oauth2/authorize');
    assert.equal(redirect, 'kabumori-social://oauth-callback');
    if (os === 'ios') assert.deepEqual(plain(options), { preferEphemeralSession: true });
    else assert.equal(options, undefined);
    assert.equal(harness.render().state, 'connected');
  }
});

test('executed success preserves PKCE/state, callback body and authenticated ownership header', async () => {
  const harness = await hookHarness();
  await harness.render().connect();
  const state = '01'.repeat(32), verifier = '02'.repeat(32), redirect = 'kabumori-social://oauth-callback';
  const headers = { Authorization: 'Bearer synthetic_app_jwt' };
  assert.deepEqual(harness.requests, [
    { name: 'x-oauth-connect-user', options: { headers, body: { state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), redirect_uri: redirect } } },
    { name: 'x-oauth-connect-user/callback', options: { headers, body: { code: 'fixture_code', state, code_verifier: verifier, redirect_uri: redirect } } },
  ]);
  assert.equal(harness.render().verifiedHandle, '@fixture_x');
  assert.equal(harness.completed, 1);
});

test('executed cancel/dismiss/provider denial do not complete or claim a connected account', async () => {
  for (const browserResult of [() => ({ type: 'cancel' }), () => ({ type: 'dismiss' }), ({ state, redirect }) => ({ type: 'success', url: `${redirect}?state=${state}&error=access_denied` })]) {
    const harness = await hookHarness({ browserResult });
    await harness.render().connect();
    assert.equal(harness.render().state, 'cancelled');
    assert.equal(harness.render().verifiedHandle, null);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.completed, 0);
  }
});

test('executed callback rejects wrong redirect/state/missing code before the server callback', async () => {
  for (const browserResult of [({ state }) => ({ type: 'success', url: `other://oauth-callback?state=${state}&code=fixture` }), ({ redirect }) => ({ type: 'success', url: `${redirect}?state=wrong&code=fixture` }), ({ state, redirect }) => ({ type: 'success', url: `${redirect}?state=${state}` })]) {
    const harness = await hookHarness({ browserResult });
    await harness.render().connect();
    assert.equal(harness.render().state, 'terminal_error');
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.completed, 0);
  }
});

test('executed authorization URL validation still blocks unsafe host/protocol before opening a browser', async () => {
  for (const authorizationUrl of ['http://x.com/i/oauth2/authorize', 'https://other.invalid/authorize']) {
    const harness = await hookHarness({ authorizationUrl });
    await harness.render().connect();
    assert.equal(harness.render().state, 'terminal_error');
    assert.equal(harness.browserCalls.length, 0);
  }
});

test('executed unsupported result, transient errors and invalid server success stay truthful', async () => {
  for (const [options, state] of [
    [{ browserResult: () => ({ type: 'locked' }) }, 'retryable_error'],
    [{ startError: { status: 503 } }, 'retryable_error'],
    [{ callbackError: { name: 'FunctionsFetchError' } }, 'retryable_error'],
    [{ callbackData: { success: false, handle: 'fixture' } }, 'terminal_error'],
    [{ callbackData: { success: true } }, 'terminal_error'],
  ]) {
    const harness = await hookHarness(options);
    await harness.render().connect();
    assert.equal(harness.render().state, state);
    assert.equal(harness.render().verifiedHandle, null);
    assert.equal(harness.completed, 0);
  }
});

test('executed duplicate press is single-flight and reconnect requests another private session with fresh PKCE', async () => {
  const harness = await hookHarness();
  const first = harness.render();
  await Promise.all([first.connect(), first.connect()]);
  assert.equal(harness.browserCalls.length, 1);
  await harness.render().connect();
  assert.equal(harness.browserCalls.length, 2);
  assert.notEqual(harness.requests[0].options.body.state, harness.requests[2].options.body.state);
  assert.notEqual(harness.requests[1].options.body.code_verifier, harness.requests[3].options.body.code_verifier);
  assert.equal(harness.browserCalls[1][2].preferEphemeralSession, true);
});

test('installed Expo JS forwards the iOS option to the native bridge; undefined keeps previous defaults', async () => {
  const calls = [];
  const modules = {
    'expo-modules-core': { UnavailabilityError: Error },
    'react-native': { Platform: { OS: 'ios' }, AppState: { currentState: 'active' }, Linking: {}, processColor: (value) => value },
    './ExpoWebBrowser': { __esModule: true, default: { openAuthSessionAsync: async (...args) => { calls.push(args); return { type: 'cancel' }; } } },
    './WebBrowser.types': {},
  };
  const source = await read('node_modules/expo-web-browser/src/WebBrowser.ts');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: (name) => { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; } });
  const open = module.exports.openAuthSessionAsync;
  await open('https://x.com/i/oauth2/authorize', 'kabumori-social://oauth-callback', xConnectAuthSessionOptions('ios'));
  assert.equal(calls[0][2].preferEphemeralSession, true);
  await open('https://x.com/i/oauth2/authorize', 'kabumori-social://oauth-callback');
  await open('https://x.com/i/oauth2/authorize', 'kabumori-social://oauth-callback', undefined);
  assert.deepEqual(plain(calls[1]), plain(calls[2]));
});

test('no cookie/browsing-data clearing or extra provider parameters are introduced anywhere in the X connect feature', async () => {
  for (const path of ['src/features/x-connect/use-x-connect.ts', 'src/features/x-connect/auth-session-options.ts']) {
    const code = stripComments(await read(path));
    assert.doesNotMatch(code, /clearCookies|removeAllCookies|deleteCookies|CookieManager|clearBrowsingData|Cookies\./iu, path);
    assert.doesNotMatch(code, /force_login|prompt=|login_hint|screen_name|&lang=/iu, path);
  }
  assert.doesNotMatch(stripComments(await read('src/features/x-connect/use-x-connect.ts')), /authorization\.searchParams|new URL\(authorizationUrl\)\.searchParams\.set/u);
});

test('the app-login provider flows are unchanged (separate trust step)', async () => {
  const flows = await read('src/lib/auth-client-flows.ts');
  assert.match(flows, /openAuthSessionAsync\(authorizeUrl, AUTH_CALLBACK_URL\)/u);
  assert.doesNotMatch(flows, /preferEphemeralSession/u);
});

test('account-choice hint is shown on both connect surfaces and does not promise a chooser', async () => {
  for (const path of ['src/app/accounts/index.tsx', 'src/features/onboarding/onboarding-gate.tsx']) {
    const source = await read(path);
    assert.match(source, /接続時に、Xのログイン画面で接続したいアカウントを選んで（またはログインして）ください。/u, path);
    assert.match(source, /ブラウザの状態によっては、以前ログインしたアカウントが表示される場合があります。/u, path);
  }
  for (const path of ['src/app/accounts/index.tsx', 'src/features/onboarding/onboarding-gate.tsx']) {
    assert.doesNotMatch(await read(path), /必ず.{0,20}(選べ|選択でき)|アカウント選択画面が(必ず)?表示/u, path);
  }
});
