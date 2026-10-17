// F4 (postona-f4-threads-oauth-stack-integration-ios-return-20261017): how the Threads HTTPS OAuth callback returns
// into the app. Threads registers HTTPS redirect URIs only; on iOS, expo-web-browser 57 catches an HTTPS return in the
// auth session only with `preferUniversalLinks: true` on iOS 17.4+ (and the Associated Domains entitlement for the
// host) -- otherwise it falls back to a scheme-only session that never returns. Android returns via a verified App
// Link. X keeps its custom scheme, unchanged. Fake hosts only; no network, no real OAuth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as domain from '../src/domain/threads-connect.ts';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';

// The starter imports through the app's `@/` alias: load the real file with a module map (as the other harnesses do).
const starterSource = await readFile(new URL('../src/features/threads-connect/threads-connect-starter.ts', import.meta.url), 'utf8');
const starterModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(starterSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module: starterModule, exports: starterModule.exports, URL, require: (name) => { assert.equal(name, '@/domain/threads-connect'); return domain; } });
const { createThreadsConnectStarter } = starterModule.exports;

const CALLBACK = 'https://links.postona.example/threads/callback';
const IOS = { platform: 'ios', callback: CALLBACK, associatedDomains: ['applinks:links.postona.example'] };
const ANDROID_FILTER = { action: 'VIEW', autoVerify: true, data: [{ scheme: 'https', host: 'links.postona.example', pathPrefix: '/threads/callback' }], category: ['BROWSABLE', 'DEFAULT'] };
const OPTIONS = { preferEphemeralSession: true, preferUniversalLinks: true };

test('iOS 17.4+ with the Associated Domain: the universal-link auth session (ephemeral + preferUniversalLinks)', () => {
  for (const iosVersion of ['17.4', '17.4.1', '18.0', 18, '26.1']) {
    assert.deepEqual(domain.threadsCallbackDelivery({ ...IOS, iosVersion }), { ok: true, callback: CALLBACK, authSessionOptions: OPTIONS }, String(iosVersion));
  }
});

test('iOS before 17.4 is refused up front (it could never return), not left waiting', () => {
  for (const iosVersion of ['17.3', '17.3.1', '16.7', '15', undefined, 'unknown']) {
    assert.deepEqual(domain.threadsCallbackDelivery({ ...IOS, iosVersion }), { ok: false, code: 'UNIVERSAL_LINK_UNSUPPORTED' }, String(iosVersion));
  }
});

test('iOS without the exact applinks entry, or a callback that is not a plain HTTPS URL: not configured', () => {
  const cases = [
    { ...IOS, iosVersion: '18.0', associatedDomains: undefined },
    { ...IOS, iosVersion: '18.0', associatedDomains: ['applinks:other.example'] },
    { ...IOS, iosVersion: '18.0', associatedDomains: ['webcredentials:links.postona.example'] },
    { ...IOS, iosVersion: '18.0', callback: 'http://links.postona.example/threads/callback' },
    { ...IOS, iosVersion: '18.0', callback: `${CALLBACK}?x=1` },
    { ...IOS, iosVersion: '18.0', callback: 'https://links.postona.example:8443/threads/callback' },
    { ...IOS, iosVersion: '18.0', callback: 'kabumori-social://oauth-callback' },
    { ...IOS, iosVersion: '18.0', callback: null },
  ];
  for (const input of cases) assert.deepEqual(domain.threadsCallbackDelivery(input), { ok: false, code: 'CALLBACK_NOT_CONFIGURED' }, JSON.stringify(input));
});

test('Android: a verified App Link (VIEW + autoVerify + https host + covering path) and no extra session option', () => {
  assert.deepEqual(domain.threadsCallbackDelivery({ platform: 'android', callback: CALLBACK, androidIntentFilters: [ANDROID_FILTER] }), { ok: true, callback: CALLBACK });
  assert.deepEqual(domain.threadsCallbackDelivery({ platform: 'android', callback: CALLBACK, androidIntentFilters: [{ ...ANDROID_FILTER, data: { scheme: 'https', host: 'links.postona.example', path: '/threads/callback' } }] }), { ok: true, callback: CALLBACK });
  for (const filter of [{ ...ANDROID_FILTER, autoVerify: false }, { ...ANDROID_FILTER, data: [{ scheme: 'https', host: 'other.example', pathPrefix: '/' }] }, { ...ANDROID_FILTER, data: [{ scheme: 'https', host: 'links.postona.example', pathPrefix: '/other' }] }, { ...ANDROID_FILTER, data: [{ scheme: 'http', host: 'links.postona.example', pathPrefix: '/' }] }]) {
    assert.deepEqual(domain.threadsCallbackDelivery({ platform: 'android', callback: CALLBACK, androidIntentFilters: [filter] }), { ok: false, code: 'CALLBACK_NOT_CONFIGURED' }, JSON.stringify(filter));
  }
  assert.deepEqual(domain.threadsCallbackDelivery({ platform: 'web', callback: CALLBACK }), { ok: false, code: 'CALLBACK_NOT_CONFIGURED' });
});

// J2 V2 R1 (P2): a filter Android would never deliver the portless HTTPS callback through must not count. Expo 57
// renders `category` as given (absent -> no category; DEFAULT/BROWSABLE are NOT added) and keeps an explicit `port`;
// Android delivers a browser VIEW only to a filter with BROWSABLE and DEFAULT, and an authority with an explicit
// port never matches a URI without one (Uri.getPort() is -1, even for 443).
test('Android (J2 R1): DEFAULT and BROWSABLE are both required, and an explicit port never covers the portless callback', () => {
  const delivery = (filter) => domain.threadsCallbackDelivery({ platform: 'android', callback: CALLBACK, androidIntentFilters: [filter] });
  const NOT_CONFIGURED = { ok: false, code: 'CALLBACK_NOT_CONFIGURED' };
  const withoutCategory = { ...ANDROID_FILTER }; delete withoutCategory.category;
  for (const filter of [withoutCategory, { ...ANDROID_FILTER, category: [] }, { ...ANDROID_FILTER, category: ['DEFAULT'] },
    { ...ANDROID_FILTER, category: ['BROWSABLE'] }, { ...ANDROID_FILTER, category: 'BROWSABLE' }, { ...ANDROID_FILTER, category: null },
    { ...ANDROID_FILTER, category: ['android.intent.category.DEFAULT', 'android.intent.category.BROWSABLE'] }]) {
    assert.deepEqual(delivery(filter), NOT_CONFIGURED, `categories ${JSON.stringify(filter.category)}`);
  }
  for (const port of ['8443', '443', 443, '']) {
    assert.deepEqual(delivery({ ...ANDROID_FILTER, data: [{ ...ANDROID_FILTER.data[0], port }] }), NOT_CONFIGURED, `port ${JSON.stringify(port)}`);
    assert.deepEqual(delivery({ ...ANDROID_FILTER, data: { scheme: 'https', host: 'links.postona.example', path: '/threads/callback', port } }), NOT_CONFIGURED, `single data, port ${JSON.stringify(port)}`);
  }
  // A malformed filter is not rescued by another malformed one.
  assert.deepEqual(domain.threadsCallbackDelivery({ platform: 'android', callback: CALLBACK,
    androidIntentFilters: [{ ...ANDROID_FILTER, category: [] }, { ...ANDROID_FILTER, data: [{ ...ANDROID_FILTER.data[0], port: '8443' }] }] }), NOT_CONFIGURED);
  // Still valid: either order, extra categories, the exact path or a covering prefix, and a portless data entry next to
  // one with a port (Android gives that filter both authorities; the portless one matches).
  const OK = { ok: true, callback: CALLBACK };
  assert.deepEqual(delivery({ ...ANDROID_FILTER, category: ['DEFAULT', 'BROWSABLE'] }), OK);
  assert.deepEqual(delivery({ ...ANDROID_FILTER, category: ['BROWSABLE', 'DEFAULT', 'APP_BROWSER'] }), OK);
  assert.deepEqual(delivery({ ...ANDROID_FILTER, data: { scheme: 'https', host: 'links.postona.example', path: '/threads/callback' } }), OK);
  assert.deepEqual(delivery({ ...ANDROID_FILTER, data: [{ scheme: 'https', host: 'links.postona.example', pathPrefix: '/threads/' }] }), OK);
  assert.deepEqual(delivery({ ...ANDROID_FILTER, data: [{ scheme: 'https', host: 'links.postona.example', port: '8443', pathPrefix: '/x' }, ANDROID_FILTER.data[0]] }), OK);
  assert.deepEqual(domain.threadsCallbackDelivery({ platform: 'android', callback: CALLBACK,
    androidIntentFilters: [{ ...ANDROID_FILTER, category: [] }, ANDROID_FILTER] }), OK, 'one deliverable filter is enough');
});

test('the starter reports the device reason and makes no request when there is no usable callback', async () => {
  for (const unavailableCode of [undefined, 'CALLBACK_NOT_CONFIGURED', 'UNIVERSAL_LINK_UNSUPPORTED']) {
    let calls = 0;
    const starter = createThreadsConnectStarter({
      registeredCallback: null, unavailableCode, session: () => { calls += 1; return { userId: 'u1', token: 't' }; },
      invoke: async () => { calls += 1; return { ok: true, payload: null }; }, openAuthSession: async () => { calls += 1; return { type: 'cancel' }; },
      dismissAuthSession() {}, onAppLink: () => () => {}, wait: async () => {}, now: () => 0,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await starter.start())), { kind: 'unavailable', code: unavailableCode ?? 'CALLBACK_NOT_CONFIGURED' });
    assert.equal(calls, 0, 'not even the session is read');
  }
  assert.match(domain.connectFailureCopy('UNIVERSAL_LINK_UNSUPPORTED'), /iOS 17\.4/u);
});

async function runtimeWith({ os, version, extra, ios, android }) {
  const opened = [];
  const modules = {
    'expo-constants': { __esModule: true, default: { expoConfig: { extra, ios, android } } },
    'expo-linking': { addEventListener: () => ({ remove() {} }) },
    'expo-web-browser': { openAuthSessionAsync: async (...args) => { opened.push(args); return { type: 'cancel' }; }, dismissAuthSession() {} },
    'react-native': { Platform: { OS: os, Version: version } },
    '@/domain/threads-connect': domain,
    '@/lib/supabase': { supabase: null },
  };
  const source = await readFile(new URL('../src/features/threads-connect/threads-connect-runtime.ts', import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (name) => { assert.ok(Object.hasOwn(modules, name), `unexpected import ${name}`); return modules[name]; }, setTimeout });
  return { runtime: module.exports, opened };
}

test('the real runtime wires the decision: iOS 17.4+ opens with preferUniversalLinks, older iOS and missing config never open', async () => {
  const ok = await runtimeWith({ os: 'ios', version: '17.4', extra: { threadsConnectCallbackUrl: CALLBACK }, ios: { associatedDomains: ['applinks:links.postona.example'] } });
  const deps = ok.runtime.productionThreadsConnectDeps(() => null);
  assert.equal(deps.registeredCallback, CALLBACK); assert.equal(deps.unavailableCode, undefined);
  await deps.openAuthSession('https://threads.com/oauth/authorize?x', CALLBACK);
  assert.deepEqual(JSON.parse(JSON.stringify(ok.opened[0][2])), OPTIONS);

  const old = await runtimeWith({ os: 'ios', version: '17.2', extra: { threadsConnectCallbackUrl: CALLBACK }, ios: { associatedDomains: ['applinks:links.postona.example'] } });
  const oldDeps = old.runtime.productionThreadsConnectDeps(() => null);
  assert.equal(oldDeps.registeredCallback, null); assert.equal(oldDeps.unavailableCode, 'UNIVERSAL_LINK_UNSUPPORTED');

  const none = await runtimeWith({ os: 'ios', version: '18.0', extra: undefined, ios: undefined });
  assert.equal(none.runtime.productionThreadsConnectDeps(() => null).unavailableCode, 'CALLBACK_NOT_CONFIGURED');

  const android = await runtimeWith({ os: 'android', version: 34, extra: { threadsConnectCallbackUrl: CALLBACK }, android: { intentFilters: [ANDROID_FILTER] } });
  const aDeps = android.runtime.productionThreadsConnectDeps(() => null);
  await aDeps.openAuthSession('https://threads.com/oauth/authorize?x', CALLBACK);
  assert.equal(android.opened[0][2], undefined, 'Android needs no extra auth-session option');

  // J2 R1: with a filter Android would not deliver through (no categories / an explicit port), the production adapter
  // exposes no callback, so the starter refuses before any request and nothing is opened.
  for (const filter of [{ ...ANDROID_FILTER, category: [] }, { ...ANDROID_FILTER, data: [{ ...ANDROID_FILTER.data[0], port: '8443' }] }]) {
    const bad = await runtimeWith({ os: 'android', version: 34, extra: { threadsConnectCallbackUrl: CALLBACK }, android: { intentFilters: [filter] } });
    const badDeps = bad.runtime.productionThreadsConnectDeps(() => null);
    assert.equal(badDeps.registeredCallback, null, JSON.stringify(filter)); assert.equal(badDeps.unavailableCode, 'CALLBACK_NOT_CONFIGURED');
    let requests = 0;
    const starter = createThreadsConnectStarter({ ...badDeps, session: () => { requests += 1; return { userId: 'u1', token: 't' }; },
      invoke: async () => { requests += 1; return { ok: true, payload: null }; } });
    assert.deepEqual(JSON.parse(JSON.stringify(await starter.start())), { kind: 'unavailable', code: 'CALLBACK_NOT_CONFIGURED' });
    assert.equal(requests, 0); assert.equal(bad.opened.length, 0);
  }
});

test('X keeps its custom-scheme auth session, unchanged (no universal links)', async () => {
  assert.deepEqual(xConnectAuthSessionOptions('ios'), { preferEphemeralSession: true });
  assert.equal(xConnectAuthSessionOptions('android'), undefined);
  const x = await readFile(new URL('../src/features/x-connect/use-x-connect.ts', import.meta.url), 'utf8');
  assert.match(x, /Linking\.createURL\('oauth-callback', \{ scheme: 'kabumori-social' \}\)/u);
  assert.doesNotMatch(x, /preferUniversalLinks/u);
});

test('app.json still has no real callback host, app links or bundle id (operator step; documented contract)', async () => {
  const app = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8')).expo;
  assert.equal(app.extra?.threadsConnectCallbackUrl, undefined);
  assert.equal(app.ios?.associatedDomains, undefined);
  assert.equal(app.android?.intentFilters, undefined);
  assert.equal(app.scheme, 'kabumori-social');
});
