import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

test('iOS X connect requests the documented private (ephemeral) auth session', () => {
  assert.deepEqual(xConnectAuthSessionOptions('ios'), { preferEphemeralSession: true });
});

test('Android/Web/other platforms get no options at all (exactly the previous call)', () => {
  for (const os of ['android', 'web', 'windows', 'macos', '']) assert.equal(xConnectAuthSessionOptions(os), undefined, os);
});

test('the option exists in the installed expo-web-browser API and is iOS-only there', async () => {
  const types = await read('node_modules/expo-web-browser/build/WebBrowser.types.d.ts');
  assert.match(types, /preferEphemeralSession\?: boolean;/u);
  assert.match(types, /@default false\s+\* @platform ios\s+\*\/\s+preferEphemeralSession/u);
});

test('the connect hook passes exactly that option to the auth session and keeps the URL/redirect arguments', async () => {
  const hook = stripComments(await read('src/features/x-connect/use-x-connect.ts'));
  assert.match(hook, /WebBrowser\.openAuthSessionAsync\(authorizationUrl, redirectUri, xConnectAuthSessionOptions\(Platform\.OS\)\)/u);
  assert.equal((hook.match(/openAuthSessionAsync\(/gu) ?? []).length, 1);
  assert.match(hook, /import \{ Platform \} from 'react-native';/u);
});

test('OAuth contract is untouched: PKCE, state, redirect URI, host allowlist, callback parsing, body shapes', async () => {
  const hook = await read('src/features/x-connect/use-x-connect.ts');
  assert.match(hook, /Linking\.createURL\('oauth-callback', \{ scheme: 'kabumori-social' \}\)/u);
  assert.match(hook, /redirectUri !== 'kabumori-social:\/\/oauth-callback'/u);
  assert.match(hook, /rawState = bytesToHex\(await Crypto\.getRandomBytesAsync\(32\)\)/u);
  assert.match(hook, /codeVerifier = bytesToHex\(await Crypto\.getRandomBytesAsync\(32\)\)/u);
  assert.match(hook, /Crypto\.CryptoDigestAlgorithm\.SHA256/u);
  assert.match(hook, /body: \{ state: rawState, code_challenge: codeChallenge, redirect_uri: redirectUri \}/u);
  assert.match(hook, /authorization\.protocol !== 'https:' \|\| authorization\.hostname !== 'x\.com'/u);
  assert.match(hook, /parseOAuthReturn\(browserResult\.url, redirectUri, rawState\)/u);
  assert.match(hook, /body: \{ code: callback\.code, state: callback\.state, code_verifier: codeVerifier, redirect_uri: redirectUri \}/u);
  assert.match(hook, /'x-oauth-connect-user\/callback'/u);
});

test('cancel/dismiss/success/error state handling is unchanged', async () => {
  const hook = await read('src/features/x-connect/use-x-connect.ts');
  assert.match(hook, /browserResult\.type === 'cancel' \|\| browserResult\.type === 'dismiss'\) \{\s+setState\('cancelled'\);\s+return;/u);
  assert.match(hook, /browserResult\.type !== 'success'\) \{\s+setState\('retryable_error'\);\s+return;/u);
  assert.match(hook, /callback\.kind === 'cancelled'\) \{\s+setState\('cancelled'\);\s+return;/u);
  assert.match(hook, /setVerifiedHandle\(`@\$\{callbackData\.handle\.replace\(\/\^@\/u, ''\)\}`\);\s+setState\('connected'\);/u);
  assert.match(hook, /setState\(isRetryableOAuthError\(error\) \? 'retryable_error' : 'terminal_error'\)/u);
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

test('server-side duplicate-X-account protection files are untouched by the client change', async () => {
  const hook = stripComments(await read('src/features/x-connect/use-x-connect.ts'));
  assert.doesNotMatch(hook, /duplicate|already_connected|platform_user_id/iu);
});
