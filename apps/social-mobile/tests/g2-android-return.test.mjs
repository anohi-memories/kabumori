// G2 independent QA (2026-10-20, Issue #317 generation 6): Android-specific returns into POSTONA, on top of F4's Draft
// PR #260 (Threads connect, Android App Link contract). Offline only. What F4's own suites already cover (golden paths,
// DEFAULT+BROWSABLE, explicit port, foreign link ignored, forwarded once, session change, expiry) is NOT repeated here.
// Added: filter shapes F4 does not exercise, the forms in which Android can hand a link to the app, a stale return
// arriving during a newer attempt, and the app config this build actually ships.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as domain from '../src/domain/threads-connect.ts';
import { AUTH_CALLBACK_URL, parseAuthCallbackUrl } from '../src/domain/auth-flows.ts';
import { parseOAuthReturn } from '../src/lib/x-oauth-onboarding.ts';

const starterSource = readFileSync(new URL('../src/features/threads-connect/threads-connect-starter.ts', import.meta.url), 'utf8');
const starterModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(starterSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module: starterModule, exports: starterModule.exports, URL, require: (name) => { assert.equal(name, '@/domain/threads-connect'); return domain; } });
const { createThreadsConnectStarter } = starterModule.exports;

const HOST = 'links.postona.example';
const CALLBACK = `https://${HOST}/threads/callback`;
const filter = (over = {}, data = {}) => ({ action: 'VIEW', autoVerify: true, category: ['DEFAULT', 'BROWSABLE'], data: [{ scheme: 'https', host: HOST, pathPrefix: '/threads/callback', ...data }], ...over });
const android = (filters) => domain.threadsCallbackDelivery({ platform: 'android', callback: CALLBACK, androidIntentFilters: filters });
const NOT = { ok: false, code: 'CALLBACK_NOT_CONFIGURED' };

// ---------------------------------------------------------------- what this build ships

test('this build declares no Android App Link (and no android.package): the Threads connect is refused on Android before anything starts', () => {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;
  assert.equal(app.android, undefined, 'no android block: prebuild invents a package name and adds only the custom-scheme filter');
  assert.equal(app.scheme, 'kabumori-social');
  assert.deepEqual(android(app.android?.intentFilters), NOT);
});

// ---------------------------------------------------------------- filter shapes (fail closed unless the callback is truly covered)

test('filters that cannot carry the HTTPS callback are refused', () => {
  for (const [label, filters] of [
    ['http scheme', [filter({}, { scheme: 'http' })]],
    ['wildcard host', [filter({}, { host: `*.${HOST.split('.').slice(1).join('.')}` })]],
    ['other host', [filter({}, { host: 'postona.example' })]],
    ['pathPattern only (not evaluated)', [filter({}, { pathPrefix: undefined, pathPattern: '/threads/.*' })]],
    ['path that differs', [filter({}, { pathPrefix: undefined, path: '/threads/callback/' })]],
    ['autoVerify as a string', [filter({ autoVerify: 'true' })]],
    ['action array', [filter({ action: ['VIEW'] })]],
    ['categories split across two filters', [filter({ category: ['DEFAULT'] }), filter({ autoVerify: false, category: ['BROWSABLE'] })]],
    ['verified filter without data', [filter({ data: [] })]],
    ['empty list', []],
    ['not an array', { action: 'VIEW' }],
  ]) assert.deepEqual(android(filters), NOT, label);
});

test('a filter with several data entries is accepted only through the entry that really covers the callback', () => {
  assert.deepEqual(android([filter({ data: [{ scheme: 'https', host: 'other.example', pathPrefix: '/' }, { scheme: 'https', host: HOST, path: '/threads/callback' }] })]), { ok: true, callback: CALLBACK });
  assert.deepEqual(android([filter({ data: [{ scheme: 'https', host: 'other.example', pathPrefix: '/' }, { scheme: 'https', host: HOST, port: '443', path: '/threads/callback' }] })]), NOT);
});

test('OBSERVATION: a host-wide pathPrefix "/" is accepted (it does cover the callback); App Link verification of the host remains the guard', () => {
  assert.deepEqual(android([filter({}, { pathPrefix: '/' })]), { ok: true, callback: CALLBACK });
});

// ---------------------------------------------------------------- forms in which Android may hand a link over

test('Android intent: URIs and scheme-only forms are not returns', () => {
  const intentUri = 'intent://auth-callback?sb_flow_id=flowAAAA11112222&code=c1#Intent;scheme=kabumori-social;package=evil.app;end';
  assert.deepEqual(parseAuthCallbackUrl(intentUri), { kind: 'invalid' });
  assert.throws(() => parseOAuthReturn('intent://oauth-callback?code=c&state=s#Intent;scheme=kabumori-social;end', 'kabumori-social://oauth-callback', 's'), /REDIRECT_MISMATCH/u);
  assert.equal(domain.threadsCallbackForward(`intent://${HOST}/threads/callback?code=c&state=s#Intent;scheme=https;end`, CALLBACK), null);
  assert.equal(domain.threadsCallbackForward(`intent://${HOST}/threads/callback?code=c&state=s`, CALLBACK), null, 'intent scheme without a fragment');
  assert.equal(domain.threadsCallbackForward(`kabumori-social://${HOST}/threads/callback?code=c&state=s`, CALLBACK), null, 'custom scheme carrying the callback path');
  assert.equal(domain.threadsCallbackForward(`https://${HOST}.evil.example/threads/callback?code=c&state=s`, CALLBACK), null, 'look-alike host');
  for (const url of ['kabumori-social:auth-callback?sb_flow_id=flowAAAA11112222&code=c1', 'kabumori-social:///auth-callback?sb_flow_id=flowAAAA11112222&code=c1']) {
    assert.deepEqual(parseAuthCallbackUrl(url), { kind: 'invalid' }, url);
  }
});

test('OBSERVATION: scheme and host case are normalised by the URL parser (Android only dispatches the lowercase scheme it registered)', () => {
  assert.equal(parseAuthCallbackUrl(`KABUMORI-SOCIAL://auth-callback?sb_flow_id=flowAAAA11112222&code=c1`).kind, 'code');
  const upper = `https://${HOST.toUpperCase()}/threads/callback?code=c&state=s`;
  assert.deepEqual(domain.threadsCallbackForward(upper, CALLBACK), { action: 'callback', callback_url: upper }, 'forwarded unchanged: the server must compare its own normalised form');
  assert.equal(AUTH_CALLBACK_URL, 'kabumori-social://auth-callback');
});

// ---------------------------------------------------------------- singleTask re-delivery: a stale return during a newer attempt

function flow() {
  const calls = { invoke: [], dismiss: 0 };
  let linkListener = null;
  const now = Date.parse('2026-10-20T04:00:00Z');
  const STATE = 'Zx9_-ab0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabc';
  const authUrl = `https://threads.com/oauth/authorize?client_id=990602627938098&redirect_uri=${encodeURIComponent(CALLBACK)}&scope=threads_basic%2Cthreads_content_publish&response_type=code&state=${STATE}`;
  const deps = {
    registeredCallback: CALLBACK,
    session: () => ({ userId: 'user-1', token: 'jwt-1' }),
    invoke: async (body) => {
      calls.invoke.push({ ...body });
      if (body.action === 'start') return { ok: true, payload: { ok: true, provider: 'threads', authorization_url: authUrl, expires_at: new Date(now + 9 * 60_000).toISOString() } };
      return { ok: false, payload: { ok: false, error: 'CALLBACK_REFUSED' } }; // the server rejects a return whose state is not this attempt's
    },
    openAuthSession: () => new Promise(() => {}),
    dismissAuthSession: () => { calls.dismiss += 1; },
    onAppLink: (listener) => { linkListener = listener; return () => { linkListener = null; }; },
    wait: () => new Promise(() => {}),
    now: () => now,
  };
  return { starter: createThreadsConnectStarter(deps), calls, link: (url) => linkListener?.(url), listening: () => linkListener !== null };
}

test('OBSERVATION (by design): the app never reads state, so a stale return of an earlier attempt re-delivered during a new one is forwarded ONCE and the server refusal is shown — no retry, no second forward', async () => {
  const f = flow();
  const pending = f.starter.start();
  await new Promise((r) => setImmediate(r));
  const stale = `${CALLBACK}?code=OLD_CODE&state=OLD_STATE_0123456789abcdefghijklmnopqrstuvwxyzAB`;
  f.link(stale);
  f.link(stale); // Android may deliver the same VIEW intent again (singleTask onNewIntent)
  const result = JSON.parse(JSON.stringify(await pending));
  assert.deepEqual(result, { kind: 'failed', code: 'CALLBACK_REFUSED', reconcile: false });
  assert.equal(f.calls.invoke.filter((c) => c.action === 'callback').length, 1);
  assert.equal(f.listening(), false, 'the listener is removed: later re-deliveries reach nothing');
  f.link(stale);
  assert.equal(f.calls.invoke.filter((c) => c.action === 'callback').length, 1);
});
