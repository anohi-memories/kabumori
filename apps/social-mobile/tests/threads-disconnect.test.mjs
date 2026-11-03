// Threads disconnect (client side, F4): the pure rules and copy, parity with the server contract (the real
// server handler fed with the database's exact answers), the real disconnector (transpiled) with an injected
// server, and the real card + hook (transpiled) driven through stubbed React / React Native.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as domain from '../src/domain/threads-disconnect.ts';

const root = resolve(import.meta.dirname, '..');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
async function load(path, stubs, extraGlobals = {}) {
  const module = { exports: {} };
  const require = (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; };
  vm.runInNewContext(transpile(await readFile(resolve(root, path), 'utf8')), { module, exports: module.exports, require, URL, URLSearchParams, Response, ...extraGlobals }, { filename: path });
  return module.exports;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((r) => setTimeout(r, 0));

const USER = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT = { id: 'sa_0123456789abcdef01234567', platform: 'threads', profile: { displayName: 'alice', handle: '@alice' }, connectionStatus: 'connected' };
const TARGET = { id: ACCOUNT.id, handle: 'alice' };
const edge = (status, code, extra = {}) => ({
  ok: true, payload: {
    ok: true, status, code, publish_permission: 'withdrawn',
    local_credentials: status === 'disconnected' ? 'removed' : status === 'stopped' ? 'kept' : 'none', remote_access: 'not_revoked_by_app', ...extra,
  },
});

// ---------------------------------------------------------------- pure rules

test('the release flag is OFF in source: "in preparation", a disabled button, nothing can start', () => {
  assert.equal(domain.THREADS_DISCONNECT_UI_ENABLED, false);
  const view = domain.threadsDisconnectView({ releaseEnabled: false, preview: false });
  assert.deepEqual([view.mode, view.canStart], ['preparing', false]);
  assert.match(view.buttonLabel, /（準備中）/u);
  assert.deepEqual([domain.threadsDisconnectView({ releaseEnabled: true, preview: true }).canStart], [false]);
  assert.equal(domain.threadsDisconnectView({ releaseEnabled: true, preview: false }).canStart, true);
  assert.match(domain.threadsDisconnectView({ releaseEnabled: true, preview: false }).note, /X連携.*そのまま残ります/u);
});

test('the target is the shown Threads account (id + handle); anything else cannot be disconnected', () => {
  assert.deepEqual(domain.disconnectTarget(ACCOUNT), TARGET);
  assert.equal(domain.disconnectTarget({ ...ACCOUNT, platform: 'x' }), null);
  for (const handle of ['', '@', 'al ice', '@@a', 'a'.repeat(64)]) assert.equal(domain.disconnectTarget({ ...ACCOUNT, profile: { handle } }), null, handle);
  assert.equal(domain.disconnectTarget({ ...ACCOUNT, id: 'SA-1' }), null);
});

test('the confirmation names the account, says X / POSTONA / common account stay, and that Threads keeps its own permission', () => {
  const lines = domain.disconnectConfirmLines(TARGET);
  assert.match(lines[0], /@alice/u);
  assert.ok(lines.some((l) => /X連携、POSTONAの利用登録、共通ID（かぶモリ）はそのまま残ります/u.test(l)));
  assert.ok(lines.includes(domain.THREADS_REMOTE_NOTE));
  assert.match(domain.THREADS_REMOTE_NOTE, /取り消せません/u);
});

test('results: the POSTONA line and the Threads line are separate; nothing ever says Threads revoked it', () => {
  const all = [{ kind: 'disconnected' }, { kind: 'not_connected' }, { kind: 'stopped', code: 'PUBLISH_IN_FLIGHT' }, { kind: 'stopped', code: 'SECRET_SHARED' },
    { kind: 'stopped', code: 'DISCONNECT_FAILED' }, { kind: 'failed', code: 'BUSY', uncertain: false }];
  for (const result of all) {
    const lines = domain.disconnectResultLines(result);
    assert.match(lines.local, /[ぁ-んァ-ン一-龥]/u);
    if (result.kind !== 'failed') assert.equal(lines.remote, domain.THREADS_REMOTE_NOTE, result.kind);
    assert.doesNotMatch(`${lines.local}${lines.remote ?? ''}`, /Threads側.*(取り消しました|削除しました|解除しました)/u);
  }
  assert.match(domain.disconnectResultLines({ kind: 'stopped', code: 'PUBLISH_IN_FLIGHT' }).local, /認証情報は残しています/u);
  assert.doesNotMatch(domain.disconnectResultLines({ kind: 'stopped', code: 'SECRET_SHARED' }).local, /削除しました/u);
});

test('every failure code has safe Japanese copy; unknown codes fall back to "could not confirm"', () => {
  for (const [code, copy] of Object.entries(domain.DISCONNECT_FAILURE_COPY)) {
    assert.match(copy, /[ぁ-んァ-ン一-龥]/u, code);
    assert.doesNotMatch(copy, /[A-Z]+_[A-Z_]+/u, code);
  }
  assert.equal(domain.disconnectFailureCopy('SOMETHING_NEW'), domain.DISCONNECT_FAILURE_COPY.STORE_UNAVAILABLE);
});

test('parse: only the exact server answers; anything else (or a lost answer) is uncertain, never a success', () => {
  assert.deepEqual(domain.parseDisconnectResponse(edge('disconnected', 'LOCAL_REMOVED').payload, true), { kind: 'disconnected' });
  assert.deepEqual(domain.parseDisconnectResponse(edge('stopped', 'PUBLISH_IN_FLIGHT').payload, true), { kind: 'stopped', code: 'PUBLISH_IN_FLIGHT' });
  assert.deepEqual(domain.parseDisconnectResponse(edge('not_connected', 'ALREADY_REMOVED', { publish_permission: 'already_off' }).payload, true), { kind: 'not_connected' });
  const uncertain = { kind: 'failed', code: 'STORE_UNAVAILABLE', uncertain: true };
  for (const bad of [edge('disconnected', 'LOCAL_REMOVED', { remote_access: 'revoked' }), edge('disconnected', 'LOCAL_REMOVED', { local_credentials: 'kept' }),
    edge('stopped', 'LOCAL_REMOVED'), edge('not_connected', 'ALREADY_REMOVED'), edge('disconnected', 'LOCAL_REMOVED', { extra: 1 }),
    { ok: true, payload: null }, { ok: true, payload: { ok: true } }, { ok: false, payload: null }, { ok: false, payload: { ok: false, error: 'NEW_CODE' } }]) {
    assert.deepEqual(domain.parseDisconnectResponse(bad.payload, bad.ok), uncertain, JSON.stringify(bad));
  }
  assert.deepEqual(domain.parseDisconnectResponse({ ok: false, error: 'ACCOUNT_CHANGED' }, false), { kind: 'failed', code: 'ACCOUNT_CHANGED', uncertain: false });
});

test('parity: the database\'s exact answers through the REAL server handler parse in the app as intended', async () => {
  const flat = (text) => new Map(Object.entries(JSON.parse(text)));
  const server = await load('../../supabase/functions/_shared/social/threads_disconnect.ts', { '../../social-mobile-threads-publish/logic.ts': { parseFlatJsonObject: flat } }, { TextDecoder, Headers });
  const sql = [
    ['{"code": "LOCAL_REMOVED", "status": "disconnected", "remote_access": "not_revoked_by_app", "local_credentials": "removed", "publish_permission": "withdrawn"}', { kind: 'disconnected' }],
    ['{"code": "PUBLISH_IN_FLIGHT", "status": "stopped", "remote_access": "not_revoked_by_app", "local_credentials": "kept", "publish_permission": "withdrawn"}', { kind: 'stopped', code: 'PUBLISH_IN_FLIGHT' }],
    ['{"code": "SECRET_SHARED", "status": "stopped", "remote_access": "not_revoked_by_app", "local_credentials": "kept", "publish_permission": "already_off"}', { kind: 'stopped', code: 'SECRET_SHARED' }],
    ['{"code": "ALREADY_REMOVED", "status": "not_connected", "remote_access": "not_revoked_by_app", "local_credentials": "none", "publish_permission": "already_off"}', { kind: 'not_connected' }],
    ['{"code": "ACCOUNT_CHANGED", "status": "refused"}', { kind: 'failed', code: 'ACCOUNT_CHANGED', uncertain: false }],
    ['{"code": "DISCONNECT_DISABLED", "status": "refused"}', { kind: 'failed', code: 'DISCONNECT_DISABLED', uncertain: false }],
    ['{"code": "LOCAL_REMOVED", "status": "disconnected", "remote_access": "revoked", "local_credentials": "removed", "publish_permission": "withdrawn"}', { kind: 'failed', code: 'STORE_UNAVAILABLE', uncertain: true }],
  ];
  for (const [db, expected] of sql) {
    const response = await server.handleThreadsDisconnect(new Request('https://edge.example', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ action: 'disconnect', social_account_id: TARGET.id, expected_handle: TARGET.handle }),
    }), { getUser: async () => ({ id: USER }), disconnect: async () => JSON.parse(db) });
    assert.deepEqual(domain.parseDisconnectResponse(plain(await response.json()), response.ok), expected, db);
  }
});

// ---------------------------------------------------------------- the real disconnector, injected

async function disconnector(over = {}) {
  const calls = [];
  const runner = await load('src/features/threads-disconnect/threads-disconnect-runner.ts', { '@/domain/threads-disconnect': domain });
  const d = runner.createThreadsDisconnector({
    session: () => ('session' in over ? over.session : { userId: USER, token: 'jwt-1' }),
    invoke: async (body, token) => {
      calls.push({ body: plain(body), token });
      if (over.gate) await over.gate;
      if (over.throws) throw new Error('network');
      return over.answer ?? edge('disconnected', 'LOCAL_REMOVED');
    },
  });
  return { d, calls };
}

test('golden path: the confirmed account, the person\'s own token, one request', async () => {
  const { d, calls } = await disconnector();
  assert.deepEqual(plain(await d.disconnect(TARGET, USER)), { kind: 'disconnected' });
  assert.deepEqual(calls, [{ body: { action: 'disconnect', social_account_id: TARGET.id, expected_handle: 'alice' }, token: 'jwt-1' }]);
});

test('another person signed in since the confirmation, or signed out: nothing is sent', async () => {
  const changed = await disconnector({ session: { userId: '00000000-0000-4000-8000-0000000000b1', token: 'jwt-b' } });
  assert.deepEqual(plain(await changed.d.disconnect(TARGET, USER)), { kind: 'failed', code: 'SESSION_CHANGED', uncertain: false });
  assert.deepEqual(changed.calls, []);
  const out = await disconnector({ session: null });
  assert.deepEqual(plain(await out.d.disconnect(TARGET, USER)), { kind: 'failed', code: 'AUTH_REQUIRED', uncertain: false });
  assert.deepEqual(out.calls, []);
  const bad = await disconnector();
  assert.deepEqual(plain(await bad.d.disconnect({ id: TARGET.id, handle: 'a b' }, USER)), { kind: 'failed', code: 'REQUEST_INVALID', uncertain: false });
  assert.deepEqual(bad.calls, []);
});

test('a second tap while one runs sends nothing; a lost answer is not retried', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { d, calls } = await disconnector({ gate });
  const first = d.disconnect(TARGET, USER);
  assert.deepEqual(plain(await d.disconnect(TARGET, USER)), { kind: 'failed', code: 'IN_PROGRESS', uncertain: false });
  release();
  assert.deepEqual(plain(await first), { kind: 'disconnected' });
  assert.equal(calls.length, 1);
  const lost = await disconnector({ throws: true });
  assert.deepEqual(plain(await lost.d.disconnect(TARGET, USER)), { kind: 'failed', code: 'STORE_UNAVAILABLE', uncertain: true });
  assert.equal(lost.calls.length, 1);
});

test('nothing is logged and no result carries the token', async () => {
  const spy = { log: 0, info: 0, warn: 0, error: 0, debug: 0 };
  const original = globalThis.console;
  globalThis.console = Object.fromEntries(Object.keys(spy).map((k) => [k, () => { spy[k] += 1; }]));
  try {
    for (const over of [{}, { throws: true }, { answer: { ok: false, payload: { ok: false, error: 'BUSY' } } }]) {
      const { d } = await disconnector(over);
      assert.ok(!JSON.stringify(await d.disconnect(TARGET, USER)).includes('jwt-1'));
    }
  } finally {
    globalThis.console = original;
  }
  assert.deepEqual(spy, { log: 0, info: 0, warn: 0, error: 0, debug: 0 });
});

// ---------------------------------------------------------------- card + hook (real source, transpiled)

async function cardHarness(props, user = USER) {
  const slots = []; let cursor = 0; let effects = [];
  const react = {
    useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
    useRef: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback: (cb) => { cursor++; return cb; },
    useLayoutEffect: (e) => { effects.push(e); },
  };
  const jsx = (type, p) => ({ type: typeof type === 'function' ? type.name : type, props: p });
  const auth = { session: { access_token: 'jwt-1', user: { id: user } } };
  const stubs = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Text: 'Text', View: 'View' },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i' } },
    '@/domain/threads-disconnect': domain,
    '@/providers/auth-provider': { useAuth: () => auth },
    '@/features/threads-disconnect/threads-disconnect-runtime': { productionThreadsDisconnectDeps: () => { throw new Error('the production flow must not be built in tests'); } },
    '@/features/threads-disconnect/threads-disconnect-runner': { createThreadsDisconnector: () => { throw new Error('unused'); } },
  };
  stubs['@/features/threads-disconnect/use-threads-disconnect'] = await load('src/features/threads-disconnect/use-threads-disconnect.ts', stubs);
  const card = await load('src/features/threads-disconnect/threads-disconnect-card.tsx', stubs);
  const render = () => { cursor = 0; effects = []; const tree = card.ThreadsDisconnectCard(props); effects.forEach((e) => e()); return tree; };
  return { render, props, auth };
}
const find = (node, type, out = []) => { if (Array.isArray(node)) node.forEach((c) => find(c, type, out)); else if (node && typeof node === 'object') { if (node.type === type) out.push(node.props); find(node.props?.children, type, out); } return out; };
const texts = (tree) => find(tree, 'Text').map((t) => t.children);
const button = (tree, label) => find(tree, 'ActionButton').find((b) => b.label === label);

test('card, flag OFF (default): "in preparation", disabled button; pressing it opens nothing and sends nothing', async () => {
  let sent = 0;
  const h = await cardHarness({ threadsAccount: ACCOUNT, accounts: [ACCOUNT], reload: () => {}, preview: false, disconnector: { disconnect: async () => { sent += 1; return { kind: 'disconnected' }; } } });
  const tree = h.render();
  const b = button(tree, 'Threads連携を解除（準備中）');
  assert.equal(b.disabled, true);
  b.onPress();
  await tick();
  assert.equal(button(h.render(), '解除する'), undefined, 'no confirmation');
  assert.equal(sent, 0);
});

test('card: no Threads account and nothing pending -> nothing rendered', async () => {
  const h = await cardHarness({ threadsAccount: null, accounts: [], reload: () => {}, preview: false, releaseEnabled: true });
  assert.equal(h.render(), null);
});

test('card, flag ON: confirm the exact account; "やめる" sends nothing; "解除する" sends once; disconnected only after the reload', async () => {
  const sent = [];
  let reloads = 0;
  const h = await cardHarness({ threadsAccount: ACCOUNT, accounts: [ACCOUNT], reload: () => { reloads += 1; }, preview: false, releaseEnabled: true,
    disconnector: { disconnect: async (target, by) => { sent.push(plain({ target, by })); return { kind: 'disconnected' }; } } });
  button(h.render(), 'Threads連携を解除').onPress();
  let tree = h.render();
  assert.ok(texts(tree).includes('@alice のThreads連携を解除しますか？'));
  assert.ok(texts(tree).includes(domain.THREADS_REMOTE_NOTE));
  button(tree, 'やめる').onPress();
  assert.equal(button(h.render(), '解除する'), undefined);
  assert.equal(sent.length, 0);
  button(h.render(), 'Threads連携を解除').onPress();
  const confirmButton = button(h.render(), '解除する');
  const p1 = confirmButton.onPress();
  const p2 = confirmButton.onPress();
  await Promise.all([p1, p2]);
  await tick();
  assert.deepEqual(sent, [{ target: TARGET, by: USER }], 'one request, for the confirmed account and person');
  assert.equal(reloads, 1);
  tree = h.render();
  assert.ok(texts(tree).includes('解除を確認しています…'), 'the account is still in the data');
  // The reloaded data no longer has it (the parent passes threadsAccount null now; the card stays mounted).
  h.props.accounts = [];
  h.props.threadsAccount = null;
  tree = h.render();
  const shown = texts(tree);
  assert.ok(shown.includes(domain.disconnectResultLines({ kind: 'disconnected' }).local));
  assert.ok(shown.includes(domain.THREADS_REMOTE_NOTE), 'the Threads side is its own line');
});

test('card, flag ON: a post that may be in flight keeps the credential and says so; no reload claims a removal', async () => {
  let reloads = 0;
  const h = await cardHarness({ threadsAccount: ACCOUNT, accounts: [ACCOUNT], reload: () => { reloads += 1; }, preview: false, releaseEnabled: true,
    disconnector: { disconnect: async () => ({ kind: 'stopped', code: 'PUBLISH_IN_FLIGHT' }) } });
  button(h.render(), 'Threads連携を解除').onPress();
  button(h.render(), '解除する').onPress();
  await tick();
  const shown = texts(h.render());
  assert.ok(shown.includes(domain.disconnectResultLines({ kind: 'stopped', code: 'PUBLISH_IN_FLIGHT' }).local));
  assert.ok(!shown.some((t) => typeof t === 'string' && t.startsWith('Threads連携を解除しました')));
  assert.equal(reloads, 0);
});

test('card, flag ON: an uncertain answer reloads and asks the person to check; a refusal shows its copy', async () => {
  let reloads = 0;
  const h = await cardHarness({ threadsAccount: ACCOUNT, accounts: [ACCOUNT], reload: () => { reloads += 1; }, preview: false, releaseEnabled: true,
    disconnector: { disconnect: async () => ({ kind: 'failed', code: 'STORE_UNAVAILABLE', uncertain: true }) } });
  button(h.render(), 'Threads連携を解除').onPress();
  button(h.render(), '解除する').onPress();
  await tick();
  assert.ok(texts(h.render()).includes(domain.DISCONNECT_FAILURE_COPY.STORE_UNAVAILABLE));
  assert.equal(reloads, 1);
  const r = await cardHarness({ threadsAccount: ACCOUNT, accounts: [ACCOUNT], reload: () => {}, preview: false, releaseEnabled: true,
    disconnector: { disconnect: async () => ({ kind: 'failed', code: 'ACCOUNT_CHANGED', uncertain: false }) } });
  button(r.render(), 'Threads連携を解除').onPress();
  button(r.render(), '解除する').onPress();
  await tick();
  assert.ok(texts(r.render()).includes(domain.DISCONNECT_FAILURE_COPY.ACCOUNT_CHANGED));
});

test('card: preview never starts', async () => {
  const h = await cardHarness({ threadsAccount: ACCOUNT, accounts: [ACCOUNT], reload: () => {}, preview: true, releaseEnabled: true });
  assert.equal(button(h.render(), 'Threads連携を解除').disabled, true);
});
