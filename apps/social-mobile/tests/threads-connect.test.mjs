// Threads connect / reconnect (client side): the pure rules, parity with the server contract, the real
// connect flow (threads-connect-starter.ts, transpiled) with injected browser / app link / server, and the
// real card + hook (transpiled) driven through stubbed React / React Native.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as domain from '../src/domain/threads-connect.ts';

const root = resolve(import.meta.dirname, '..');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
async function load(path, stubs, extraGlobals = {}) {
  const module = { exports: {} };
  const require = (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; };
  vm.runInNewContext(transpile(await readFile(resolve(root, path), 'utf8')), { module, exports: module.exports, require, URL, URLSearchParams, Response, ...extraGlobals }, { filename: path });
  return module.exports;
}

const CALLBACK = 'https://postona.example/threads/callback';
const STATE = 'Zx9_-ab0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabc';
const CODE = 'AQBfakeAuthorizationCode_0123456789';
const AUTH_URL = `https://threads.com/oauth/authorize?client_id=990602627938098&redirect_uri=${encodeURIComponent(CALLBACK)}&scope=threads_basic%2Cthreads_content_publish&response_type=code&state=${STATE}`;
const RETURN = `${CALLBACK}?code=${CODE}&state=${STATE}#_`;
const ACCOUNT = 'sa_0123456789abcdef01234567';
const NOW = Date.parse('2026-10-12T03:00:00Z');
const startOk = (over = {}) => ({ ok: true, payload: { ok: true, provider: 'threads', authorization_url: AUTH_URL, expires_at: new Date(NOW + 9 * 60_000).toISOString(), ...over } });
const receipt = (over = {}) => ({ ok: true, payload: { ok: true, status: 'connected', provider: 'threads', social_account_id: ACCOUNT, publish_enabled: false, token_expires_at: new Date(NOW + 59 * 86400_000).toISOString(), ...over } });

// ---------------------------------------------------------------- pure rules

test('the release flag is OFF in source: "in preparation", a disabled button, nothing can start', () => {
  assert.equal(domain.THREADS_CONNECT_UI_ENABLED, false);
  for (const account of [null, { connectionStatus: 'needs_attention' }]) {
    const view = domain.threadsConnectView(account, { releaseEnabled: false, preview: false });
    assert.deepEqual([view.mode, view.canStart], ['preparing', false]);
    assert.match(view.buttonLabel, /（準備中）/u);
  }
});

test('with the flag on: connect, reconnect or connected; preview never starts; connecting never enables posting', () => {
  const on = (account, preview = false) => domain.threadsConnectView(account, { releaseEnabled: true, preview });
  assert.deepEqual([on(null).mode, on(null).canStart], ['connect', true]);
  assert.deepEqual([on({ connectionStatus: 'needs_attention' }).mode, on({ connectionStatus: 'needs_attention' }).canStart], ['reconnect', true]);
  assert.deepEqual([on({ connectionStatus: 'connected' }).mode, on({ connectionStatus: 'connected' }).canStart], ['connected', false]);
  assert.match(on(null).note, /自動では有効になりません/u);
  assert.deepEqual([on(null, true).mode, on(null, true).canStart], ['preview', false]);
});

test('callback handoff: only the exact registered HTTPS callback is forwarded, unchanged', () => {
  assert.deepEqual(domain.threadsCallbackForward(RETURN, CALLBACK), { action: 'callback', callback_url: RETURN });
  for (const bad of [`http://postona.example/threads/callback?code=a&state=b`, `https://evil.example/threads/callback?code=a&state=b`,
    `${CALLBACK}?code=a&state=b&next=x`, `${CALLBACK}?code=a&code=b&state=c`, `${CALLBACK}?code=a&state=b#token=x`, CALLBACK, 'nope']) {
    assert.equal(domain.threadsCallbackForward(bad, CALLBACK), null, bad);
  }
});

test('parity: the app accepts exactly the authorization URLs the server contract accepts', async () => {
  const server = await load('../../supabase/functions/_shared/social/threads_connect_edge.ts', { '../../social-mobile-threads-publish/logic.ts': { parseFlatJsonObject: () => new Map() } }, { TextDecoder, Date });
  const corpus = [AUTH_URL, AUTH_URL.replace('https://threads.com', 'https://evil.example'), AUTH_URL.replace('https:', 'http:'),
    AUTH_URL.replace(encodeURIComponent(CALLBACK), encodeURIComponent('https://evil.example/cb')), AUTH_URL.replace('%2Cthreads_content_publish', ''),
    `${AUTH_URL}&prompt=none`, `${AUTH_URL}#x`, AUTH_URL.replace(STATE, 'short'), AUTH_URL.replace('response_type=code', 'response_type=token'), 'x', 42];
  for (const url of corpus) assert.equal(domain.isThreadsAuthorizationUrl(url, CALLBACK), server.isThreadsAuthorizationUrl(url, CALLBACK), String(url));
  assert.equal(domain.THREADS_AUTHORIZE_ENDPOINT, server.THREADS_AUTHORIZE_ENDPOINT);
  assert.equal(domain.THREADS_REQUIRED_SCOPE, server.THREADS_REQUIRED_SCOPE);
});

test('every failure code has safe Japanese copy; unknown codes fall back', () => {
  for (const [code, copy] of Object.entries(domain.CONNECT_FAILURE_COPY)) {
    assert.match(copy, /[ぁ-んァ-ン一-龥]/u, code);
    assert.doesNotMatch(copy, /[A-Z]+_[A-Z_]+/u, code);
  }
  assert.equal(domain.connectFailureCopy('SOMETHING_NEW'), domain.CONNECT_FAILURE_COPY.THREADS_CONNECT_RUNTIME_UNAVAILABLE);
});

// ---------------------------------------------------------------- the real flow, injected

async function flow(over = {}) {
  const calls = { invoke: [], open: [], dismiss: 0, links: [] };
  let linkListener = null;
  let browserResolve;
  const browser = new Promise((r) => { browserResolve = r; });
  let waitResolve;
  const state = { now: NOW, session: { userId: 'user-1', token: 'jwt-1' } };
  const deps = {
    registeredCallback: CALLBACK,
    session: () => state.session,
    invoke: async (body, token) => { calls.invoke.push({ body: { ...body }, token }); return body.action === 'start' ? (over.start ?? startOk()) : (over.callback ?? receipt()); },
    openAuthSession: (url, redirect) => { calls.open.push({ url, redirect }); return over.browser ? Promise.resolve(over.browser) : browser; },
    dismissAuthSession: () => { calls.dismiss += 1; },
    onAppLink: (listener) => { linkListener = listener; return () => { linkListener = null; }; },
    wait: () => new Promise((r) => { waitResolve = r; }),
    now: () => state.now,
    ...over.deps,
  };
  const starter = await load('src/features/threads-connect/threads-connect-starter.ts', { '@/domain/threads-connect': domain });
  const real = starter.createThreadsConnectStarter(deps);
  // Results are created inside the vm realm; compare them as plain data.
  return {
    starter: { start: async () => JSON.parse(JSON.stringify(await real.start())) }, calls, state,
    browserReturns: (result) => browserResolve(result),
    link: (url) => { calls.links.push(url); linkListener?.(url); },
    deadline: () => waitResolve?.(),
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test('golden path through the auth browser: start with the bearer, open the exact URL, forward the exact return, receipt', async () => {
  const f = await flow();
  const pending = f.starter.start();
  await tick();
  assert.deepEqual(f.calls.invoke[0], { body: { action: 'start' }, token: 'jwt-1' });
  assert.deepEqual(f.calls.open, [{ url: AUTH_URL, redirect: CALLBACK }]);
  f.browserReturns({ type: 'success', url: RETURN });
  assert.deepEqual(await pending, { kind: 'connected', socialAccountId: ACCOUNT });
  assert.deepEqual(f.calls.invoke[1], { body: { action: 'callback', callback_url: RETURN }, token: 'jwt-1' });
  assert.equal(f.calls.invoke.length, 2);
});

test('golden path through the app link: the browser is dismissed, a foreign link is ignored, the return is forwarded once', async () => {
  const f = await flow();
  const pending = f.starter.start();
  await tick();
  f.link('https://evil.example/threads/callback?code=x&state=y');
  f.link(RETURN);
  f.link(RETURN);
  f.browserReturns({ type: 'success', url: RETURN });
  assert.deepEqual(await pending, { kind: 'connected', socialAccountId: ACCOUNT });
  assert.equal(f.calls.dismiss, 1);
  assert.equal(f.calls.invoke.filter((c) => c.body.action === 'callback').length, 1, 'exactly once');
});

test('cancel, decline on Threads and the deadline end the attempt without forwarding anything', async () => {
  for (const [label, act, expected] of [
    ['cancel', (f) => f.browserReturns({ type: 'cancel' }), { kind: 'canceled' }],
    ['dismiss', (f) => f.browserReturns({ type: 'dismiss' }), { kind: 'canceled' }],
    ['declined', (f) => f.browserReturns({ type: 'success', url: `${CALLBACK}?error=access_denied&error_reason=user_denied&state=${STATE}` }), { kind: 'canceled' }],
    ['deadline', (f) => f.deadline(), { kind: 'expired' }],
  ]) {
    const f = await flow();
    const pending = f.starter.start();
    await tick();
    act(f);
    assert.deepEqual(await pending, expected, label);
    assert.equal(f.calls.invoke.filter((c) => c.body.action === 'callback').length, 0, label);
  }
});

test('another person signed in (or signed out) by the time Threads returns: nothing is forwarded', async () => {
  for (const next of [{ userId: 'user-2', token: 'jwt-2' }, null]) {
    const f = await flow();
    const pending = f.starter.start();
    await tick();
    f.state.session = next;
    f.browserReturns({ type: 'success', url: RETURN });
    assert.deepEqual(await pending, { kind: 'failed', code: 'SESSION_CHANGED', reconcile: false });
    assert.equal(f.calls.invoke.length, 1, 'only the start');
  }
});

test('a return after the attempt expired, or a malformed return, is not forwarded', async () => {
  const late = await flow();
  const p1 = late.starter.start();
  await tick();
  late.state.now = NOW + 10 * 60_000;
  late.browserReturns({ type: 'success', url: RETURN });
  assert.deepEqual(await p1, { kind: 'expired' });
  for (const url of [`${CALLBACK}?code=a&state=b&next=https://evil.example`, `${CALLBACK}?code=a&state=b#access_token=x`]) {
    const f = await flow();
    const p = f.starter.start();
    await tick();
    f.browserReturns({ type: 'success', url });
    assert.deepEqual(await p, { kind: 'failed', code: 'CALLBACK_INVALID', reconcile: false });
    assert.equal(f.calls.invoke.length, 1);
  }
});

test('a duplicate tap while one attempt runs starts nothing', async () => {
  const f = await flow();
  const first = f.starter.start();
  assert.deepEqual(await f.starter.start(), { kind: 'unavailable', code: 'IN_PROGRESS' });
  await tick();
  f.browserReturns({ type: 'cancel' });
  await first;
  assert.equal(f.calls.invoke.filter((c) => c.body.action === 'start').length, 1);
});

test('not configured or signed out: nothing is requested', async () => {
  const f = await flow({ deps: { registeredCallback: null } });
  assert.deepEqual(await f.starter.start(), { kind: 'unavailable', code: 'CALLBACK_NOT_CONFIGURED' });
  const g = await flow({ deps: { registeredCallback: 'http://postona.example/cb' } });
  assert.deepEqual(await g.starter.start(), { kind: 'unavailable', code: 'CALLBACK_NOT_CONFIGURED' });
  const h = await flow({ deps: { session: () => null } });
  assert.deepEqual(await h.starter.start(), { kind: 'failed', code: 'AUTH_REQUIRED', reconcile: false });
  assert.equal(f.calls.invoke.length + g.calls.invoke.length + h.calls.invoke.length, 0);
});

test('a refused or off-contract start never opens a browser', async () => {
  for (const [start, code] of [
    [{ ok: false, payload: { ok: false, error: 'START_REFUSED', restart_required: true } }, 'START_REFUSED'],
    [{ ok: false, payload: { ok: false, error: 'THREADS_CONNECT_DISABLED' } }, 'THREADS_CONNECT_DISABLED'],
    [startOk({ authorization_url: AUTH_URL.replace('https://threads.com', 'https://evil.example') }), 'THREADS_CONNECT_RUNTIME_UNAVAILABLE'],
    [startOk({ expires_at: new Date(NOW - 1).toISOString() }), 'THREADS_CONNECT_RUNTIME_UNAVAILABLE'],
    [{ ok: true, payload: null }, 'THREADS_CONNECT_RUNTIME_UNAVAILABLE'],
  ]) {
    const f = await flow({ start });
    assert.deepEqual(await f.starter.start(), { kind: 'failed', code, reconcile: false });
    assert.equal(f.calls.open.length, 0, code);
  }
});

test('server answers after the return keep their meaning; a receipt claiming publishing is not a connection', async () => {
  for (const [callback, expected] of [
    [{ ok: false, payload: { ok: false, error: 'CALLBACK_REFUSED', restart_required: true, reconciliation_required: false } }, { kind: 'failed', code: 'CALLBACK_REFUSED', reconcile: false }],
    [{ ok: false, payload: { ok: false, error: 'EXCHANGE_OUTCOME_UNCERTAIN', restart_required: true, reconciliation_required: true } }, { kind: 'failed', code: 'EXCHANGE_OUTCOME_UNCERTAIN', reconcile: true }],
    [{ ok: false, payload: { ok: false, error: 'COMPLETE_OUTCOME_UNKNOWN', restart_required: true, reconciliation_required: true } }, { kind: 'failed', code: 'COMPLETE_OUTCOME_UNKNOWN', reconcile: true }],
    [receipt({ publish_enabled: true }), { kind: 'failed', code: 'THREADS_CONNECT_RUNTIME_UNAVAILABLE', reconcile: true }],
    [receipt({ provider: 'x' }), { kind: 'failed', code: 'THREADS_CONNECT_RUNTIME_UNAVAILABLE', reconcile: true }],
  ]) {
    const f = await flow({ callback, browser: { type: 'success', url: RETURN } });
    assert.deepEqual(await f.starter.start(), expected);
  }
});

test('nothing is logged and no result carries the code, state or token', async () => {
  const spy = { log: 0, info: 0, warn: 0, error: 0, debug: 0 };
  const consoleStub = Object.fromEntries(Object.keys(spy).map((k) => [k, () => { spy[k] += 1; }]));
  const f = await flow({ browser: { type: 'success', url: RETURN } });
  const original = globalThis.console;
  globalThis.console = consoleStub;
  try {
    const result = await f.starter.start();
    const text = JSON.stringify(result);
    for (const secret of [CODE, STATE, 'jwt-1']) assert.ok(!text.includes(secret), secret);
  } finally {
    globalThis.console = original;
  }
  assert.deepEqual(spy, { log: 0, info: 0, warn: 0, error: 0, debug: 0 });
});

// ---------------------------------------------------------------- card + hook (real source, transpiled)

async function cardHarness(props) {
  const slots = []; let cursor = 0; let effects = [];
  const react = {
    useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
    useRef: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback: (cb) => { cursor++; return cb; },
    useLayoutEffect: (e) => { effects.push(e); },
  };
  const jsx = (type, p) => ({ type: typeof type === 'function' ? type.name : type, props: p });
  const stubs = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text' },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i' } },
    '@/domain/threads-connect': domain,
    '@/providers/auth-provider': { useAuth: () => ({ session: { access_token: 'jwt-1', user: { id: 'user-1' } } }) },
    '@/features/threads-connect/threads-connect-runtime': { productionThreadsConnectDeps: () => { throw new Error('the production flow must not be built in tests'); } },
    '@/features/threads-connect/threads-connect-starter': { createThreadsConnectStarter: () => { throw new Error('unused'); } },
  };
  stubs['@/features/threads-connect/use-threads-connect'] = await load('src/features/threads-connect/use-threads-connect.ts', stubs);
  const card = await load('src/features/threads-connect/threads-connect-card.tsx', stubs);
  const render = () => { cursor = 0; effects = []; const tree = card.ThreadsConnectCard(props); effects.forEach((e) => e()); return tree; };
  return { render, props };
}
const find = (node, type, out = []) => { if (Array.isArray(node)) node.forEach((c) => find(c, type, out)); else if (node && typeof node === 'object') { if (node.type === type) out.push(node.props); find(node.props?.children, type, out); } return out; };
const texts = (tree) => find(tree, 'Text').map((t) => t.children);

test('card, flag OFF (default): disabled button; pressing it starts nothing', async () => {
  let starts = 0;
  const h = await cardHarness({ threadsAccount: null, accounts: [], reload: () => {}, preview: false, starter: { start: async () => { starts += 1; return { kind: 'canceled' }; } } });
  const [button] = find(h.render(), 'ActionButton');
  assert.equal(button.disabled, true);
  button.onPress();
  await tick();
  assert.equal(starts, 0);
});

test('card, flag ON: a receipt is only "confirming" until the reloaded accounts show the Threads account connected', async () => {
  let reloads = 0;
  const h = await cardHarness({ threadsAccount: null, accounts: [], reload: () => { reloads += 1; }, preview: false, releaseEnabled: true,
    starter: { start: async () => ({ kind: 'connected', socialAccountId: ACCOUNT }) } });
  find(h.render(), 'ActionButton')[0].onPress();
  await tick();
  assert.equal(reloads, 1);
  assert.ok(texts(h.render()).includes('接続を確認しています…'));
  h.props.accounts = [{ id: ACCOUNT, platform: 'threads', connectionStatus: 'needs_attention' }];
  assert.ok(texts(h.render()).includes('接続を確認しています…'), 'not connected yet in the data');
  h.props.accounts = [{ id: ACCOUNT, platform: 'threads', connectionStatus: 'connected' }];
  assert.ok(texts(h.render()).some((t) => typeof t === 'string' && t.startsWith('Threadsアカウントを接続しました')));
});

test('card, flag ON: failures show safe copy', async () => {
  const h = await cardHarness({ threadsAccount: { connectionStatus: 'needs_attention' }, accounts: [], reload: () => {}, preview: false, releaseEnabled: true,
    starter: { start: async () => ({ kind: 'failed', code: 'EXCHANGE_OUTCOME_UNCERTAIN', reconcile: true }) } });
  find(h.render(), 'ActionButton')[0].onPress();
  await tick();
  assert.ok(texts(h.render()).includes(domain.CONNECT_FAILURE_COPY.EXCHANGE_OUTCOME_UNCERTAIN));
});
