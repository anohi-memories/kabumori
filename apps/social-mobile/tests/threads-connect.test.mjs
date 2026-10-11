// Threads connect / reconnect entry (client side): the pure view rules, the callback handoff design, and the
// real card (transpiled) driven through stubbed React / React Native.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as domain from '../src/domain/threads-connect.ts';

const root = resolve(import.meta.dirname, '..');
const REGISTERED = 'https://postona.example/threads/callback';

test('the release flag is OFF in source: "in preparation", a disabled button, nothing can start', () => {
  assert.equal(domain.THREADS_CONNECT_UI_ENABLED, false);
  for (const account of [null, { connectionStatus: 'needs_attention' }]) {
    const view = domain.threadsConnectView(account, { releaseEnabled: false, preview: false });
    assert.equal(view.mode, 'preparing');
    assert.equal(view.canStart, false);
    assert.match(view.note, /準備中/u);
    assert.match(view.buttonLabel, /（準備中）/u);
  }
});

test('with the flag on: connect, reconnect or connected; preview never starts; connecting never enables posting', () => {
  const on = (account, preview = false) => domain.threadsConnectView(account, { releaseEnabled: true, preview });
  assert.deepEqual([on(null).mode, on(null).canStart], ['connect', true]);
  assert.deepEqual([on({ connectionStatus: 'needs_attention' }).mode, on({ connectionStatus: 'needs_attention' }).canStart], ['reconnect', true]);
  assert.deepEqual([on({ connectionStatus: 'connected' }).mode, on({ connectionStatus: 'connected' }).canStart], ['connected', false]);
  assert.match(on({ connectionStatus: 'connected' }).note, /投稿を許可/u);
  assert.match(on(null).note, /自動では有効になりません/u);
  assert.deepEqual([on(null, true).mode, on(null, true).canStart], ['preview', false]);
});

test('the disabled production starter never opens anything', async () => {
  assert.deepEqual(await domain.disabledThreadsConnectStarter.start(), { kind: 'unavailable', code: 'THREADS_CONNECT_DISABLED' });
});

test('callback handoff: only the exact registered HTTPS callback is forwarded, unchanged; nothing else', () => {
  const good = `${REGISTERED}?code=AQBfake_code-123&state=Zx9_-ab0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabc#_`;
  assert.deepEqual(domain.threadsCallbackForward(good, REGISTERED), { action: 'callback', callback_url: good });
  assert.ok(domain.threadsCallbackForward(`${REGISTERED}?error=access_denied&error_reason=user_denied&state=x`, REGISTERED));
  for (const bad of [
    `http://postona.example/threads/callback?code=a&state=b`,
    `https://evil.example/threads/callback?code=a&state=b`,
    `https://postona.example/threads/callback/extra?code=a&state=b`,
    `https://user:pw@postona.example/threads/callback?code=a&state=b`,
    `${REGISTERED}?code=a&state=b&redirect=https://evil.example`,
    `${REGISTERED}?code=a&code=b&state=c`,
    `${REGISTERED}?code=a&state=b#token=x`,
    `${REGISTERED}`,
    `postona-social://threads/callback?code=a&state=b`,
    `${REGISTERED}?code=${'a'.repeat(5000)}&state=b`,
    'not a url',
  ]) {
    assert.equal(domain.threadsCallbackForward(bad, REGISTERED), null, bad);
  }
  assert.equal(domain.threadsCallbackForward(good, 'http://postona.example/threads/callback'), null, 'the registered callback itself must be https');
});

// ---------------------------------------------------------------- card (real source, transpiled)

async function cardHarness(props) {
  const slots = []; let cursor = 0;
  const react = {
    useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
    useRef: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
  };
  const jsx = (type, p) => ({ type: typeof type === 'function' ? type.name : type, props: p });
  const stubs = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text' },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i' } },
    '@/domain/threads-connect': domain,
  };
  const source = await readFile(resolve(root, 'src/features/threads-connect/threads-connect-card.tsx'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } });
  const render = () => { cursor = 0; return module.exports.ThreadsConnectCard(props); };
  return { render };
}
const find = (node, type, out = []) => { if (Array.isArray(node)) node.forEach((c) => find(c, type, out)); else if (node && typeof node === 'object') { if (node.type === type) out.push(node.props); find(node.props?.children, type, out); } return out; };
const settle = () => new Promise((r) => setImmediate(r));

test('card, flag OFF (default): disabled button; pressing it starts nothing', async () => {
  let starts = 0;
  const h = await cardHarness({ threadsAccount: null, preview: false, starter: { start: async () => { starts += 1; return { kind: 'opened' }; } } });
  const [button] = find(h.render(), 'ActionButton');
  assert.equal(button.disabled, true);
  button.onPress();
  await settle();
  assert.equal(starts, 0);
});

test('card, flag ON with an injected starter: one start per tap in flight, honest message', async () => {
  let starts = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = await cardHarness({ threadsAccount: null, preview: false, releaseEnabled: true, starter: { start: async () => { starts += 1; await gate; return { kind: 'unavailable', code: 'THREADS_CONNECT_DISABLED' }; } } });
  const [button] = find(h.render(), 'ActionButton');
  assert.equal(button.disabled, false);
  button.onPress();
  button.onPress();
  release();
  await settle();
  assert.equal(starts, 1);
  const texts = find(h.render(), 'Text').map((t) => t.children);
  assert.ok(texts.includes('Threadsとの接続は、まだ利用できません。'));
});
