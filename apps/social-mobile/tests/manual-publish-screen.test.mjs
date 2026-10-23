// F1 manual X single post: the REAL route file (src/app/manual-publish.tsx, transpiled) driven with stubbed
// React / React Native / providers and fake send ports. Proves the wiring, not only the pure model:
// what the user is shown, that the send stays impossible without a fresh account-bound `ready` answer, that a
// double tap sends once, that an unknown outcome is never presented as sent, and that nothing leaks across
// accounts or users. Offline: no network, no secret, no X post.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as model from '../src/features/manual-publish/manual-publish-model.ts';
import * as realFlow from '../src/features/manual-publish/manual-publish-flow.ts';
import * as realPort from '../src/features/manual-publish/manual-publish-port.ts';
import * as realStore from '../src/features/manual-publish/manual-publish-store.ts';
import * as realDraft from '../src/features/manual-publish/manual-publish-draft-store.ts';


/** A device storage that can fail in every way: a thrown read / write / remove, or a write that silently stores nothing. */
function fakeKV() {
  const data = new Map();
  const fail = { get: false, set: false, remove: false, drop: false };
  return {
    data,
    fail,
    getItem: async (key) => { if (fail.get) throw new Error('read failed'); return data.has(key) ? data.get(key) : null; },
    setItem: async (key, value) => { if (fail.set) throw new Error('write failed'); if (!fail.drop) data.set(key, value); },
    removeItem: async (key) => { if (fail.remove) throw new Error('remove failed'); data.delete(key); },
  };
}

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REAL = { simulated: false, afterFreeze: false };
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node === null || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
};

const account = (id, over = {}) => ({
  id,
  brandId: 'A',
  platform: 'x',
  profile: { displayName: `name-${id}`, handle: `@${id}`, avatarColor: '#123456' },
  connectionStatus: 'connected',
  postingState: 'active',
  ...over,
});

/** A controllable send port: readiness is scripted, `send` stays pending until the test resolves it. */
function fakePort({ readiness = { kind: 'ready' } } = {}) {
  const calls = { check: [], send: [] };
  const pending = [];
  return {
    calls,
    pending,
    port: {
      checkReadiness: async (accountId) => { calls.check.push(accountId); return typeof readiness === 'function' ? readiness(accountId) : readiness; },
      send: (target) => new Promise((resolve, reject) => { calls.send.push(target); pending.push({ target, resolve, reject }); }),
    },
  };
}

async function loadRoute(world) {
  const slots = [];
  let cursor = 0;
  const pendingEffects = [];
  const slot = (init) => { const i = cursor++; if (!(i in slots)) slots[i] = init(); return i; };
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));
  const react = {
    useState: (initial) => {
      const i = slot(() => ({ v: typeof initial === 'function' ? initial() : initial }));
      return [slots[i].v, (next) => { slots[i].v = typeof next === 'function' ? next(slots[i].v) : next; }];
    },
    useReducer: (reducer, arg, init) => {
      const i = slot(() => ({ v: init ? init(arg) : arg }));
      return [slots[i].v, (action) => { slots[i].v = reducer(slots[i].v, action); }];
    },
    useRef: (initial) => slots[slot(() => ({ current: initial }))],
    useMemo: (factory, deps) => {
      const i = slot(() => ({ deps: undefined, value: undefined, ready: false }));
      if (!slots[i].ready || !sameDeps(slots[i].deps, deps)) { slots[i].value = factory(); slots[i].deps = deps; slots[i].ready = true; }
      return slots[i].value;
    },
    useEffect: (effect, deps) => {
      const i = slot(() => ({ deps: undefined, cleanup: undefined, ran: false }));
      if (!slots[i].ran || !sameDeps(slots[i].deps, deps)) { slots[i].deps = deps; slots[i].ran = true; pendingEffects.push({ i, effect }); }
    },
  };
  const jsx = (type, props, key) => ({ type: typeof type === 'function' ? type.name : type, props, key });
  const stubs = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Platform: { OS: world.os ?? 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    'expo-router': { Link: 'Link', Stack: { Screen: 'StackScreen' } },
    'expo-crypto': { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    '@/constants/theme': { colors: new Proxy({}, { get: (_t, name) => String(name) }), spacing: { xs: 6, sm: 10, md: 16, lg: 22, xl: 32 } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: { muted: true } } },
    '@/features/manual-publish/manual-post-preview': { ManualPostPreview: 'ManualPostPreview' },
    '@/features/manual-publish/manual-publish-flow': { ...realFlow, attemptMemory: world.memory, inFlightSends: world.inflight },
    '@/features/manual-publish/manual-publish-model': model,
    '@/features/manual-publish/manual-publish-port': { ...realPort, getManualPublishPort: () => world.port },
    '@/features/manual-publish/manual-publish-storage': { attemptStore: world.store, draftStore: world.draftStore },
    '@/features/manual-publish/manual-publish-draft-store': realDraft,
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: world.accounts, activeAccount: world.accounts.find((a) => a.id === world.active) ?? null }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.userId === null ? null : (world.session ?? { user: { id: world.userId } }) }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status, reason: null, snapshot: null }) },
  };
  const source = await readFile(new URL('../src/app/manual-publish.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, Promise, Date, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: 'manual-publish.tsx' });
  return { mod, slots, getCursor: () => cursor, setCursor: (v) => { cursor = v; }, pendingEffects };
}

async function mount({ status = 'ready', userId = 'U1', accounts = [account('X_A')], active = 'X_A', port = fakePort(), memory = realFlow.createAttemptMemory(), kv = fakeKV(), draftKv = fakeKV(), sessionMark = 'S1', inflight = realFlow.createInFlightSends(), clock = { t: 100_000 }, os = 'ios', idBase = 0 } = {}) {
  const store = realStore.createAttemptStore(kv);
  const draftStore = realDraft.createDraftStore(draftKv);
  const world = { status, userId, accounts, active, port: port.port, memory, store, draftStore, inflight, os };
  const rt = await loadRoute(world);
  let ids = idBase;
  // Stable function identities, like the real defaults (Date.now / a module function): unstable ones would re-run the effects.
  const nowFn = () => clock.t;
  const idFn = () => ID(++ids);
  const props = () => ({ userId: world.userId, sessionMark, now: nowFn, newRequestId: idFn });
  const render = () => { rt.setCursor(0); return rt.mod.exports.ManualPublishScreen(props()); };
  const flush = async () => {
    for (let round = 0; round < 12; round += 1) {
      render();
      await settle();
      if (rt.pendingEffects.length === 0) { render(); if (rt.pendingEffects.length === 0) break; }
      const batch = rt.pendingEffects.splice(0);
      for (const { i, effect } of batch) {
        rt.slots[i].cleanup?.();
        const cleanup = effect();
        rt.slots[i].cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      }
    }
    return render();
  };
  const unmount = () => { rt.slots.forEach((s) => s?.cleanup?.()); };
  const api = {
    world, port, clock, rt, flush, unmount, kv, store, memory, draftKv, draftStore,
    tree: () => render(),
    all: (type) => { const out = []; walk(render(), (n) => { if (n.type === type) out.push(n); }); return out; },
    text: () => {
      // One line per element: its direct text children are concatenated (JSX splits `a {b}` into two children).
      const out = [];
      const visit = (node) => {
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (node === null || typeof node !== 'object') return;
        if (node.props?.label) out.push(node.props.label);
        const kids = [node.props?.children].flat(Infinity);
        const own = kids.filter((k) => typeof k === 'string' || typeof k === 'number').join('');
        if (own !== '') out.push(own);
        kids.forEach((k) => { if (k !== null && typeof k === 'object') visit(k); });
      };
      visit(render());
      return out.join('\n');
    },
    button: (label) => api.all('ActionButton').find((b) => b.props.label === label) ?? null,
    async press(label) {
      const b = api.button(label);
      assert.ok(b, `button "${label}" exists`);
      if (b.props.disabled) return false; // a disabled Pressable never fires
      b.props.onPress();
      await flush();
      return true;
    },
    /** Call the handler even though the button is disabled: the handler must still refuse. */
    async pressIgnoringDisabled(label) { api.button(label).props.onPress(); await flush(); },
    /** Tick (or untick) the explicit consent checkbox of the confirmation. */
    async tick() {
      const box = api.all('Pressable').find((n) => n.props.accessibilityRole === 'checkbox');
      assert.ok(box, 'the consent checkbox exists');
      if (box.props.accessibilityState.disabled) return false;
      box.props.onPress();
      await flush();
      return true;
    },
    checkbox: () => api.all('Pressable').find((n) => n.props.accessibilityRole === 'checkbox') ?? null,
    async typeText(value) { api.all('TextInput')[0].props.onChangeText(value); await flush(); },
    state: () => rt.slots[0].v,
  };
  await flush();
  return api;
}

const NOT_SENT_CLAIMS = ['Xが投稿を受け付けました', '投稿されました', '投稿しました', '送信しました', '送信済み'];
const assertNoSentClaim = (ui) => { const t = ui.text(); for (const claim of NOT_SENT_CLAIMS) assert.ok(!t.includes(claim), `must not claim "${claim}"`); };

// ---- what the user sees -------------------------------------------------------------------------------------------------

test('no X account: the screen says so, nothing can be typed or confirmed, and nothing claims a post', async () => {
  const ui = await mount({ accounts: [account('T_1', { platform: 'threads' })], active: 'T_1' });
  assert.ok(ui.text().includes('Xアカウントが接続されていません。'));
  assert.ok(ui.text().includes('Xアカウント未接続'));
  assert.equal(ui.all('TextInput')[0].props.editable, false);
  assert.equal(ui.button('内容を確認する').props.disabled, true);
  assert.equal(ui.button('Xに投稿する'), null);
  assert.ok(ui.button('アカウント画面を開く'));
  assertNoSentClaim(ui);
  assert.equal(ui.port.calls.check.length, 0);
});

test('accounts still loading: unavailable, not "connected"', async () => {
  for (const status of ['loading', 'blocked', 'unavailable']) {
    const ui = await mount({ status, accounts: [], active: '' });
    assert.ok(ui.text().includes('アカウント情報を読み込めていません。'), status);
    assert.equal(ui.button('内容を確認する').props.disabled, true);
  }
});

test('an X account is picked up, text can be typed, and the preview shows exactly what would be sent', async () => {
  const ui = await mount();
  assert.equal(ui.state().accountId, 'X_A', 'the active X account is suggested');
  assert.equal(ui.all('TextInput')[0].props.editable, true);
  assert.equal(ui.button('内容を確認する').props.disabled, true, 'empty text');
  await ui.typeText('  こんにちは\r\n世界  ');
  const preview = ui.all('ManualPostPreview')[0];
  assert.equal(preview.props.text, 'こんにちは\n世界');
  assert.equal(preview.props.account.id, 'X_A');
  assert.ok(ui.text().includes('まだ投稿されていません') === false, 'that sentence lives inside the preview component, which is a separate element');
  assert.equal(ui.button('内容を確認する').props.disabled, false);
  assertNoSentClaim(ui);
});

test('over the X limit: an error with the numbers, the confirmation stays disabled, the preview is still shown', async () => {
  const ui = await mount();
  await ui.typeText('あ'.repeat(141));
  assert.ok(ui.text().includes('Xの上限（280）を2超えています（282 / 280）'));
  assert.equal(ui.button('内容を確認する').props.disabled, true);
  assert.equal(ui.all('ManualPostPreview')[0].props.text, 'あ'.repeat(141));
  await ui.typeText('a\u0000');
  assert.ok(ui.text().includes('使えない文字が含まれています。'));
  assert.equal(ui.button('内容を確認する').props.disabled, true);
});

test('only X accounts are offered; choosing one is local to the screen', async () => {
  const ui = await mount({ accounts: [account('X_A'), account('T_1', { platform: 'threads' }), account('X_B', { brandId: 'B' })], active: 'T_1' });
  const rows = ui.all('Pressable');
  assert.deepEqual(rows.map((r) => r.props.accessibilityRole), ['radio', 'radio']);
  assert.equal(ui.state().accountId, null, 'a Threads active account is not a suggestion');
  rows[1].props.onPress();
  await ui.flush();
  assert.equal(ui.state().accountId, 'X_B');
});

// ---- the send stays impossible in this build ------------------------------------------------------------------------

test('this build: the confirmation shows the content, the readiness is not_connected, the send is disabled and cannot fire', async () => {
  const ui = await mount({ port: { calls: { check: [], send: [] }, port: realPort.getManualPublishPort() } });
  await ui.typeText('こんにちは');
  await ui.press('内容を確認する');
  const t = ui.text();
  assert.ok(t.includes('送信前の確認'));
  assert.ok(t.includes('name-X_A'));
  assert.ok(t.includes('こんにちは'));
  assert.ok(t.includes('送信するとXに公開されます。この画面から取り消すことはできません。'));
  assert.ok(t.includes(model.SEND_BLOCK_MESSAGES.consent_missing), 'the explicit consent comes first');
  assert.equal(ui.checkbox().props.accessibilityState.checked, false);
  await ui.tick();
  assert.ok(ui.text().includes(model.SEND_BLOCK_MESSAGES.port_not_connected));
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  assert.equal(await ui.press('Xに投稿する'), false);
  await ui.pressIgnoringDisabled('Xに投稿する'); // even a forced press must not send or change anything
  assert.equal(ui.state().phase, 'confirming');
  assertNoSentClaim(ui);
  // Going back works and a new confirmation asks again (and drops the consent).
  await ui.press('戻る');
  assert.equal(ui.state().phase, 'editing');
  assert.equal(ui.state().draft, 'こんにちは');
});

test('a cached "connected" account is not enough: with readiness not_connected the send never reaches the port', async () => {
  const fp = fakePort({ readiness: { kind: 'not_connected' } });
  const ui = await mount({ port: fp, accounts: [account('X_A', { connectionStatus: 'connected' })] });
  await ui.typeText('hi');
  await ui.press('内容を確認する');
  await ui.tick();
  await ui.pressIgnoringDisabled('Xに投稿する');
  assert.deepEqual(fp.calls.check, ['X_A']);
  assert.equal(fp.calls.send.length, 0);
});

test('demo (mock_preview) data gets the same gate: no readiness, no send', async () => {
  const fp = fakePort({ readiness: { kind: 'not_connected' } });
  const ui = await mount({ status: 'mock_preview', port: fp });
  await ui.typeText('hi');
  await ui.press('内容を確認する');
  await ui.tick();
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  assert.equal(fp.calls.send.length, 0);
});

// ---- N2: demo data is never sendable, even when the send port says "ready" -------------------------------------------------------------------

const NO_NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'];
const savedNetwork = new Map();
let networkTouches = 0;
test.before(() => {
  for (const name of NO_NETWORK) {
    savedNetwork.set(name, globalThis[name]);
    globalThis[name] = function forbidden() { networkTouches += 1; throw new Error(`network entry point ${name} must not be used`); };
  }
});
test.after(() => {
  for (const name of NO_NETWORK) {
    if (savedNetwork.get(name) === undefined) delete globalThis[name];
    else globalThis[name] = savedNetwork.get(name);
  }
});

test('N2: demo (mock_preview) data with a READY send port still cannot send -- the server is not even asked about the demo accounts', async () => {
  const fp = fakePort(); // readiness: ready, send: would answer
  const ui = await mount({ status: 'mock_preview', port: fp });
  await ui.typeText('デモの本文');
  await ui.press('内容を確認する');
  await ui.tick();
  assert.equal(ui.state().phase, 'confirming');
  assert.equal(fp.calls.check.length, 0, 'no readiness request for made-up accounts');
  assert.ok(ui.text().includes(model.SEND_BLOCK_MESSAGES.demo_data));
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  await ui.pressIgnoringDisabled('Xに投稿する');
  await ui.pressIgnoringDisabled('Xに投稿する');
  assert.equal(fp.calls.send.length, 0, 'a forced press sends nothing');
  assert.equal(ui.state().phase, 'confirming');
  assertNoSentClaim(ui);
});

test('N2: every data status other than "ready" blocks a send that was open a moment ago -- also values this code does not know', async () => {
  for (const status of ['mock_preview', 'loading', 'blocked', 'unavailable', 'error', 'READY', '', undefined, null]) {
    const { ui, fp } = await readyConfirmation();
    assert.equal(ui.button('Xに投稿する').props.disabled, false, 'open with ready data');
    ui.world.status = status;
    await ui.flush();
    assert.equal(ui.button('Xに投稿する').props.disabled, true, String(status));
    await ui.pressIgnoringDisabled('Xに投稿する');
    assert.equal(fp.calls.send.length, 0, `${String(status)}: nothing sent`);
    assert.equal(ui.state().phase, 'confirming');
    // And coming back to ready data does not send by itself: the person still has to press.
    ui.world.status = 'ready';
    await ui.flush();
    assert.equal(fp.calls.send.length, 0);
  }
});

test('N2: re-asking an unresolved attempt is blocked on demo data too (same id, same text, but never on made-up accounts)', async () => {
  const memory = realFlow.createAttemptMemory();
  memory.mark('U1', { accountId: 'X_A', requestId: ID(9), contentSha256: sha('earlier text'), text: 'earlier text', kind: 'pending' });
  const fp = fakePort();
  const ui = await mount({ memory, port: fp, status: 'mock_preview' });
  await ui.press('同じ内容・同じ送信IDで確認し直す');
  await ui.tick();
  assert.equal(fp.calls.check.length, 0);
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  assert.ok(ui.text().includes(model.SEND_BLOCK_MESSAGES.demo_data));
  await ui.pressIgnoringDisabled('Xに投稿する');
  assert.equal(fp.calls.send.length, 0);
  assert.equal(memory.get('U1').requestId, ID(9), 'the unresolved attempt is untouched');
});

test('N2: readiness is asked only for real data -- real data still asks exactly the chosen account', async () => {
  const { fp } = await readyConfirmation();
  assert.deepEqual(fp.calls.check, ['X_A']);
  const demo = fakePort();
  const ui = await mount({ status: 'mock_preview', port: demo });
  await ui.typeText('x');
  await ui.press('内容を確認する');
  assert.deepEqual(demo.calls.check, []);
});

test('N2: no network entry point was touched by the demo-data steps', () => {
  assert.equal(networkTouches, 0);
});

test('signed out: the send is blocked even with a ready port', async () => {
  const fp = fakePort();
  const ui = await mount({ port: fp, userId: null });
  await ui.typeText('hi');
  await ui.press('内容を確認する');
  await ui.tick();
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  assert.ok(ui.text().includes(model.SEND_BLOCK_MESSAGES.not_signed_in));
  await ui.pressIgnoringDisabled('Xに投稿する');
  assert.equal(fp.calls.send.length, 0);
});

// ---- with a (future) ready port ----------------------------------------------------------------------------------------

async function readyConfirmation(over = {}) {
  const fp = fakePort();
  const ui = await mount({ port: fp, ...over });
  await ui.typeText('こんにちは');
  await ui.press('内容を確認する');
  await ui.tick();
  return { ui, fp };
}

test('ready port: the send is enabled only after the server-side readiness, and a double tap sends once', async () => {
  const { ui, fp } = await readyConfirmation();
  assert.deepEqual(fp.calls.check, ['X_A'], 'readiness asked for exactly the chosen account');
  assert.ok(ui.text().includes('サーバーで送信できる状態を確認できました。'));
  assert.equal(ui.button('Xに投稿する').props.disabled, false);
  const b = ui.button('Xに投稿する');
  b.props.onPress();
  b.props.onPress(); // a second tap in the same frame
  await ui.flush();
  assert.equal(fp.calls.send.length, 1, 'exactly one send');
  assert.equal(fp.calls.send[0].targetId, ID(1));
  assert.equal(fp.calls.send[0].connectedAccountId, 'X_A');
  assert.equal(fp.calls.send[0].renderedText, 'こんにちは');
  assert.deepEqual(fp.calls.send[0].consent, { confirmed: true, contentSha256: sha('こんにちは') }, 'the consent is bound to the exact text');
  assert.equal(ui.state().phase, 'sending');
  assert.equal(ui.button('送信中…').props.disabled, true);
  assert.equal(ui.button('戻る').props.disabled, true);
  assert.equal(ui.checkbox().props.accessibilityState.disabled, true, 'the consent cannot be changed while sending');
  assertNoSentClaim(ui);
  await ui.pressIgnoringDisabled('送信中…');
  assert.equal(fp.calls.send.length, 1, 'still one');
});

test('published is the only road to "sent"; the text then shows the provider post id and no invented reconciliation', async () => {
  const { ui, fp } = await readyConfirmation();
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ kind: 'published', marks: REAL, targetId: ID(1), providerPostId: '1234567890' });
  await ui.flush();
  const t = ui.text();
  assert.ok(t.includes('Xが投稿を受け付けました'));
  assert.ok(t.includes('Xから返された投稿ID: 1234567890'));
  assert.ok(t.includes('アプリ内の履歴との照合は、この画面ではまだ行っていません。'));
  assert.equal(ui.state().draft, '');
  await ui.press('新しい投稿を作る');
  assert.equal(ui.state().phase, 'editing');
  assert.equal(ui.world.memory.get('U1'), null);
});

test('rejected: "not posted", the text is kept, editing is possible and a new attempt gets a new id', async () => {
  const { ui, fp } = await readyConfirmation();
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ kind: 'rejected', targetId: ID(1), code: 'X_REJECTED_403' });
  await ui.flush();
  const t = ui.text();
  assert.ok(t.includes('投稿されませんでした'));
  assert.ok(t.includes('コード: X_REJECTED_403'));
  assert.ok(!t.includes('Xが投稿を受け付けました'));
  await ui.press('編集に戻る');
  assert.equal(ui.state().draft, 'こんにちは');
  await ui.press('内容を確認する');
  await ui.tick();
  await ui.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 2);
  assert.equal(fp.calls.send[1].targetId, ID(2));
});

test('uncertain: warned, no resend, no send button, and only an explicit acknowledgement unlocks the screen', async () => {
  const { ui, fp } = await readyConfirmation();
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ kind: 'uncertain', targetId: ID(1), code: 'X_TIMEOUT' });
  await ui.flush();
  const t = ui.text();
  assert.ok(t.includes('投稿されたか確認できません'));
  assert.ok(t.includes('Xで確認するまで、同じ内容を再送信しないでください。'));
  assertNoSentClaim(ui);
  assert.equal(ui.button('Xに投稿する'), null);
  assert.equal(ui.button('編集に戻る'), null);
  assert.equal(ui.button('新しい投稿を作る'), null);
  assert.notEqual(ui.world.memory.get('U1'), null, 'remembered');
  assert.equal(fp.calls.send.length, 1);
  await ui.press('Xで確認しました（この下書きを破棄）');
  assert.equal(ui.state().phase, 'editing');
  assert.equal(ui.state().draft, '');
  assert.equal(ui.world.memory.get('U1'), null);
});

test('a port that throws mid-send is shown as uncertain, never as failed or sent', async () => {
  const { ui, fp } = await readyConfirmation();
  await ui.press('Xに投稿する');
  fp.pending[0].reject(new Error('socket hang up'));
  await ui.flush();
  assert.ok(ui.text().includes('投稿されたか確認できません'));
  assert.equal(ui.state().result.code, 'SEND_THREW');
});

test('leaving the screen mid-send cannot make a second identical send look safe', async () => {
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  const first = await mount({ port: fp, memory, inflight });
  await first.typeText('こんにちは');
  await first.press('内容を確認する');
  await first.tick();
  await first.press('Xに投稿する');
  first.unmount(); // the user navigates away while the send is pending
  const second = await mount({ port: fp, memory, inflight });
  // The first request is still out: the new visit is "sending" too -- it does not call it unconfirmed and offers no re-ask.
  assert.equal(second.state().phase, 'sending', 'the new visit takes over the send that is still out');
  assert.equal(second.state().result, null);
  assert.equal(second.state().unresolved.requestId, ID(1), 'the SAME attempt id is kept');
  assert.equal(second.button('送信中…').props.disabled, true);
  assert.equal(second.button('同じ内容・同じ送信IDで確認し直す'), null);
  assert.equal(second.all('TextInput').length, 0, 'no input while an attempt is unresolved');
  fp.pending[0].resolve({ kind: 'published', marks: REAL, targetId: ID(1), providerPostId: '9' });
  await second.flush();
  assert.equal(memory.get('U1'), null, 'the flow itself clears the memory when the late answer proves it');
  assert.equal(second.state().result.kind, 'sent', 'and the screen that took over shows the real answer');
  assert.equal(fp.calls.send.length, 1);
});

test('readiness older than a minute blocks the send and can be re-checked on request', async () => {
  const { ui, fp } = await readyConfirmation();
  assert.equal(ui.button('Xに投稿する').props.disabled, false);
  ui.clock.t += realPort.READINESS_MAX_AGE_MS + 1;
  await ui.flush();
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  assert.ok(ui.text().includes(model.SEND_BLOCK_MESSAGES.readiness_stale));
  await ui.pressIgnoringDisabled('Xに投稿する');
  assert.equal(fp.calls.send.length, 0);
  await ui.press('送信できる状態を再確認する');
  assert.equal(fp.calls.check.length, 2);
  assert.equal(ui.button('Xに投稿する').props.disabled, false);
});

test('a readiness failure of the port keeps the send disabled', async () => {
  const fp = fakePort({ readiness: () => { throw new Error('down'); } });
  const ui = await mount({ port: fp });
  await ui.typeText('hi');
  await ui.press('内容を確認する');
  await ui.tick();
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  assert.ok(ui.text().includes(model.SEND_BLOCK_MESSAGES.port_unavailable));
  assert.ok(ui.button('送信できる状態を再確認する'));
});

// ---- accounts, brands and users -----------------------------------------------------------------------------------------

test('account list change: a chosen account that is gone is dropped and the confirmation closes', async () => {
  const ui = await mount({ accounts: [account('X_A'), account('X_B', { brandId: 'B' })], active: 'X_B' });
  assert.equal(ui.state().accountId, 'X_B');
  await ui.typeText('hi');
  await ui.press('内容を確認する');
  assert.equal(ui.state().phase, 'confirming');
  // The workspace switches to brand A: only A's account is left.
  ui.world.accounts = [account('X_A')];
  ui.world.active = 'X_A';
  await ui.flush();
  assert.equal(ui.state().phase, 'editing', 'the confirmation of a vanished account is closed');
  assert.equal(ui.state().readiness, null);
  assert.notEqual(ui.state().accountId, 'X_B', 'brand B\'s account is never kept for brand A');
});

test('the route re-creates the screen for a different user (and signed out), so nothing carries over', async () => {
  const world = { memory: realFlow.createAttemptMemory(), port: fakePort().port, status: 'ready', userId: 'U1', accounts: [account('X_A')], active: 'X_A' };
  const rt = await loadRoute(world);
  const keyOf = () => { rt.setCursor(0); return rt.mod.exports.default({}).key; };
  const element = () => { rt.setCursor(0); return rt.mod.exports.default({}); };
  assert.equal(element().type, 'ManualPublishScreen');
  assert.equal(element().props.userId, 'U1');
  assert.equal(keyOf(), 'U1:', 'no session mark yet');
  world.userId = 'U2';
  assert.equal(keyOf(), 'U2:');
  world.userId = null;
  assert.equal(keyOf(), 'signed-out');
  assert.equal(element().props.userId, null);
});

test('another signed-in user never inherits an unresolved attempt', async () => {
  const memory = realFlow.createAttemptMemory();
  memory.mark('U1', { accountId: 'X_A', requestId: ID(9), contentSha256: sha('earlier'), text: 'earlier', kind: 'pending' });
  const other = await mount({ userId: 'U2', memory });
  assert.equal(other.state().phase, 'editing');
  const same = await mount({ userId: 'U1', memory });
  assert.equal(same.state().phase, 'result');
});

test('the header is set by the route itself (the root layout is not touched)', async () => {
  const ui = await mount();
  const header = ui.all('StackScreen')[0];
  // Fixed light header + dark status bar text (the theme colors are echoed by name in this harness).
  assert.deepEqual(JSON.parse(JSON.stringify(header.props.options)), {
    headerShown: true,
    title: '手入力でXに投稿',
    headerStyle: { backgroundColor: 'background' },
    headerTintColor: 'ink',
    headerTitleStyle: { color: 'ink' },
  });
});

// ---- the handler is its own last line of defence --------------------------------------------------------------------------

test('a forced press is refused by the handler itself when the gate no longer holds (data status / account state changed after the readiness)', async () => {
  const { ui, fp } = await readyConfirmation();
  assert.equal(ui.button('Xに投稿する').props.disabled, false);
  // The reducer alone would accept this send; only the gate knows the data / account state changed.
  ui.world.status = 'blocked';
  await ui.flush();
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  await ui.pressIgnoringDisabled('Xに投稿する');
  assert.equal(fp.calls.send.length, 0, 'data not ready');
  ui.world.status = 'ready';
  ui.world.accounts = [account('X_A', { connectionStatus: 'needs_attention' })];
  await ui.flush();
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  assert.ok(ui.text().includes(model.SEND_BLOCK_MESSAGES.account_needs_attention));
  await ui.pressIgnoringDisabled('Xに投稿する');
  assert.equal(fp.calls.send.length, 0, 'account needs attention');
  assert.equal(ui.state().phase, 'confirming');
});

// ---- explicit consent bound to the exact text -------------------------------------------------------------------------------

async function readyUnticked() {
  const fp = fakePort();
  const ui = await mount({ port: fp });
  await ui.typeText('こんにちは');
  await ui.press('内容を確認する');
  return { ui, fp };
}

test('consent: without the explicit tick the send is disabled even with a ready port, and a forced press sends nothing', async () => {
  const { ui, fp } = await readyUnticked();
  assert.deepEqual(fp.calls.check, ['X_A'], 'the server-side readiness is fine');
  assert.equal(ui.checkbox().props.accessibilityState.checked, false);
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  assert.ok(ui.text().includes(model.SEND_BLOCK_MESSAGES.consent_missing));
  assert.ok(ui.text().includes('同意するまで送信できません。'));
  await ui.pressIgnoringDisabled('Xに投稿する');
  assert.equal(fp.calls.send.length, 0);
  assert.equal(ui.state().phase, 'confirming');
});

test('consent: ticking enables the send and names the exact text by its hash; unticking disables it again', async () => {
  const { ui, fp } = await readyUnticked();
  await ui.tick();
  assert.equal(ui.checkbox().props.accessibilityState.checked, true);
  assert.equal(ui.button('Xに投稿する').props.disabled, false);
  assert.ok(ui.text().includes(`照合コード ${sha('こんにちは').slice(0, 12)}`));
  assert.equal(fp.calls.send.length, 0, 'ticking sends nothing');
  await ui.tick();
  assert.equal(ui.checkbox().props.accessibilityState.checked, false);
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
});

test('consent: it does not survive leaving the confirmation -- reopening asks again', async () => {
  const { ui } = await readyUnticked();
  await ui.tick();
  await ui.press('戻る');
  await ui.press('内容を確認する');
  assert.equal(ui.checkbox().props.accessibilityState.checked, false);
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
});

test('the request leaves with the consent hash of the EXACT confirmed text (CRLF and padding normalised before, never after)', async () => {
  const fp = fakePort();
  const ui = await mount({ port: fp });
  await ui.typeText('  一行目\r\n二行目  ');
  await ui.press('内容を確認する');
  await ui.tick();
  await ui.press('Xに投稿する');
  assert.equal(fp.calls.send[0].renderedText, '一行目\n二行目');
  assert.deepEqual(fp.calls.send[0].consent, { confirmed: true, contentSha256: sha('一行目\n二行目') });
});

// ---- pending / unconfirmed / refused: not posted-for-sure, not uncertain, retried with the same id ----------------------------

test('pending: "not sent yet", never shown as posted or as uncertain; the retry reuses the SAME attempt id and body', async () => {
  const { ui, fp } = await readyConfirmation();
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ kind: 'pending', targetId: ID(1), code: 'IN_PROGRESS' });
  await ui.flush();
  let t = ui.text();
  assert.ok(t.includes('まだ送信されていません'));
  assert.ok(t.includes('コード: IN_PROGRESS'));
  assert.ok(!t.includes('投稿されたか確認できません'), 'pending is not uncertain');
  assertNoSentClaim(ui);
  assert.equal(ui.state().result.kind, 'pending');
  assert.equal(ui.button('Xに投稿する'), null, 'no send from the result');
  assert.equal(ui.all('TextInput').length, 0, 'the text is locked');
  assert.equal(ui.world.memory.get('U1').kind, 'pending');

  await ui.press('同じ内容・同じ送信IDで確認し直す');
  t = ui.text();
  assert.equal(ui.state().phase, 'confirming');
  assert.ok(t.includes('前回と同じ内容・同じ送信IDで確認します。'));
  assert.equal(ui.button('Xに投稿する').props.disabled, true, 'a retry needs a fresh explicit consent');
  assert.ok(t.includes(model.SEND_BLOCK_MESSAGES.consent_missing));
  await ui.tick();
  assert.equal(ui.button('Xに投稿する').props.disabled, false);
  await ui.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 2);
  assert.equal(fp.calls.send[1].targetId, fp.calls.send[0].targetId, 'the SAME attempt id');
  assert.deepEqual(fp.calls.send[1], fp.calls.send[0], 'the same target, consent included');
  fp.pending[1].resolve({ kind: 'published', marks: REAL, targetId: ID(1), providerPostId: '55' });
  await ui.flush();
  assert.ok(ui.text().includes('Xから返された投稿ID: 55'));
  assert.equal(ui.world.memory.get('U1'), null);
});

test('pending: leaving the retry returns to the unresolved result and never to the editor', async () => {
  const { ui, fp } = await readyConfirmation();
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ kind: 'pending', targetId: ID(1), code: null });
  await ui.flush();
  await ui.press('同じ内容・同じ送信IDで確認し直す');
  await ui.press('戻る');
  assert.equal(ui.state().phase, 'result');
  assert.equal(ui.state().result.kind, 'pending');
  assert.equal(ui.all('TextInput').length, 0);
});

test('unconfirmed (nothing known: transport / 503 / unreadable): retry with the same id or acknowledge; never "failed", never "sent"', async () => {
  const { ui, fp } = await readyConfirmation();
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ kind: 'unavailable', targetId: ID(1), code: 'TRANSPORT_FAILED' });
  await ui.flush();
  const t = ui.text();
  assert.ok(t.includes('結果を確認できません'));
  assert.ok(t.includes('同じ送信IDで行います（サーバーは2回送りません）'));
  assert.ok(!t.includes('投稿されませんでした'), 'unknown is not "not posted"');
  assertNoSentClaim(ui);
  assert.equal(ui.state().result.kind, 'unconfirmed');
  assert.ok(ui.button('同じ内容・同じ送信IDで確認し直す'));
  assert.ok(ui.button('Xで確認しました（この下書きを破棄）'));
  assert.equal(ui.button('編集に戻る'), null, 'no way back to the editor');
  await ui.press('Xで確認しました（この下書きを破棄）');
  assert.equal(ui.state().phase, 'editing');
  assert.equal(ui.world.memory.get('U1'), null);
});

test('refused (4xx, nothing written): the text is kept and the next attempt gets a NEW id', async () => {
  const { ui, fp } = await readyConfirmation();
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ kind: 'refused', targetId: ID(1), code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE', retryable: false });
  await ui.flush();
  const t = ui.text();
  assert.ok(t.includes('送信は受け付けられませんでした'));
  assert.ok(t.includes('サーバーは何も記録していません。'));
  assert.ok(t.includes('コード: POSTONA_RESV_SERVICE_NOT_ACTIVE'));
  assertNoSentClaim(ui);
  assert.equal(ui.world.memory.get('U1'), null);
  await ui.press('編集に戻る');
  assert.equal(ui.state().draft, 'こんにちは');
  await ui.press('内容を確認する');
  await ui.tick();
  await ui.press('Xに投稿する');
  assert.equal(fp.calls.send[1].targetId, ID(2));
});

test('uncertain keeps no retry button at all (a retry would be a resend)', async () => {
  const { ui, fp } = await readyConfirmation();
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ kind: 'uncertain', targetId: ID(1), code: 'X_TIMEOUT' });
  await ui.flush();
  assert.equal(ui.button('同じ内容・同じ送信IDで確認し直す'), null);
  assert.ok(ui.button('Xで確認しました（この下書きを破棄）'));
});

test('an attempt that was still pending when the screen was left is picked up again with its own id, text and account', async () => {
  const memory = realFlow.createAttemptMemory();
  memory.mark('U1', { accountId: 'X_A', requestId: ID(9), contentSha256: sha('earlier text'), text: 'earlier text', kind: 'pending' });
  const fp = fakePort();
  const ui = await mount({ port: fp, memory });
  assert.equal(ui.state().result.kind, 'pending');
  assert.equal(ui.state().draft, 'earlier text');
  await ui.press('同じ内容・同じ送信IDで確認し直す');
  assert.equal(ui.all('TextInput').length, 0, 'the text is still known in this process: nothing to type again');
  assert.ok(!ui.text().includes('前回と同じ本文を入力'));
  await ui.tick();
  assert.equal(ui.button('Xに投稿する').props.disabled, false);
  await ui.press('Xに投稿する');
  assert.equal(fp.calls.send[0].targetId, ID(9), 'the SAME attempt id as before');
  assert.equal(fp.calls.send[0].renderedText, 'earlier text');
  assert.deepEqual(fp.calls.send[0].consent, { confirmed: true, contentSha256: sha('earlier text') });
});

test('an uncertain attempt from an earlier visit cannot be retried, only acknowledged', async () => {
  const memory = realFlow.createAttemptMemory();
  memory.mark('U1', { accountId: 'X_A', requestId: ID(9), contentSha256: sha('earlier'), text: 'earlier', kind: 'uncertain' });
  const ui = await mount({ memory });
  assert.equal(ui.state().result.kind, 'uncertain');
  assert.equal(ui.button('同じ内容・同じ送信IDで確認し直す'), null);
  await ui.press('Xで確認しました（この下書きを破棄）');
  assert.equal(ui.state().phase, 'editing');
  assert.equal(memory.get('U1'), null);
});

// ---- an app restart: only the hash-only record on the device is left -----------------------------------------------------------------

const RESTORED = (over = {}) => ({ v: 1, accountId: 'X_A', requestId: ID(9), contentSha256: sha('earlier text'), kind: 'pending', savedAt: 1_000, ...over });
const deviceWith = (record) => { const kv = fakeKV(); kv.data.set(store.storeKeyOf('U1'), JSON.stringify(record)); return kv; };
const store = { storeKeyOf: realStore.storeKeyOf };
const RESTART_NOTE = 'アプリが再起動されたため、本文は端末に残っていません。Xのプロフィールで、最近の投稿を確認してください。';

test('restart: while the record is being read nothing can be typed or confirmed, and the screen says it is checking', async () => {
  const kv = fakeKV();
  let release;
  kv.getItem = () => new Promise((resolve) => { release = () => resolve(null); });
  const ui = await mount({ kv });
  assert.equal(ui.state().store.kind, 'loading');
  const t = ui.text();
  assert.ok(t.includes('前回の送信記録を確認しています'));
  assert.ok(t.includes('前回の送信記録を確認できていません'), 'the pill');
  assert.equal(ui.all('TextInput').length, 0, 'no editor');
  assert.equal(ui.button('内容を確認する'), null);
  assert.equal(ui.button('Xに投稿する'), null);
  assertNoSentClaim(ui);
  release();
  await ui.flush();
  assert.equal(ui.state().store.kind, 'ready');
  assert.equal(ui.all('TextInput')[0].props.editable, true, 'the editor appears once the record is known to be empty');
  assert.equal(ui.state().accountId, 'X_A');
});

test('restart: a pending attempt comes back as "not sent yet", without text, and the editor and the send stay out of reach', async () => {
  const fp = fakePort();
  const ui = await mount({ port: fp, kv: deviceWith(RESTORED()) });
  assert.equal(ui.state().result.kind, 'pending');
  assert.equal(ui.state().result.code, model.UNRESOLVED_AFTER_RESTART);
  assert.equal(ui.state().draft, '');
  assert.equal(ui.state().unresolved.text, null);
  const t = ui.text();
  assert.ok(t.includes('まだ送信されていません'));
  assert.ok(t.includes(RESTART_NOTE));
  assert.ok(t.includes('押すと、この記録は消え、同じ内容も新しい投稿として送れるようになります'));
  assert.equal(ui.all('TextInput').length, 0, 'no editor: the earlier text is not on the device and a new text is not a retry');
  assert.equal(ui.button('内容を確認する'), null);
  assert.equal(ui.button('Xに投稿する'), null);
  assert.ok(ui.button('前回と同じ本文を入力して確認し直す'));
  assert.equal(ui.button('同じ内容・同じ送信IDで確認し直す'), null);
  assertNoSentClaim(ui);
  assert.equal(fp.calls.send.length + fp.calls.check.length, 0, 'reading the record asks and sends nothing');
  assert.notEqual(ui.memory.get('U1'), null, 'the process now remembers it too');
});

test('restart: the same text is asked for again; only a matching text, a fresh readiness and a fresh consent re-ask it -- with the stored id', async () => {
  const fp = fakePort();
  const ui = await mount({ port: fp, kv: deviceWith(RESTORED()) });
  await ui.press('前回と同じ本文を入力して確認し直す');
  assert.equal(ui.state().phase, 'confirming');
  assert.ok(ui.text().includes('前回と同じ本文を入力'));
  assert.ok(ui.all('SectionTitle').some((node) => node.props.detail === `前回の本文の照合コード ${model.shortHash(sha('earlier text'))}`), 'the code of the earlier text is shown, never the text');
  assert.ok(ui.text().includes(model.SEND_BLOCK_MESSAGES.restored_text_mismatch));
  assert.equal(ui.button('Xに投稿する').props.disabled, true);

  await ui.typeText('another text');
  assert.ok(ui.text().includes(model.SEND_BLOCK_MESSAGES.restored_text_mismatch), 'a different text is a different post');
  await ui.tick();
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  await ui.pressIgnoringDisabled('Xに投稿する');
  assert.equal(fp.calls.send.length, 0, 'a forced press with the wrong text sends nothing');

  await ui.typeText('earlier text');
  assert.equal(ui.checkbox().props.accessibilityState.checked, false, 'typing the text again asks for the consent again');
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  await ui.tick();
  assert.equal(ui.button('Xに投稿する').props.disabled, false);
  const b = ui.button('Xに投稿する');
  b.props.onPress();
  b.props.onPress(); // a double tap
  await ui.flush();
  assert.equal(fp.calls.send.length, 1, 'exactly one send');
  assert.equal(fp.calls.send[0].targetId, ID(9), 'the SAME attempt id as before the restart');
  assert.equal(fp.calls.send[0].renderedText, 'earlier text');
  assert.deepEqual(fp.calls.send[0].consent, { confirmed: true, contentSha256: sha('earlier text') });
  fp.pending[0].resolve({ kind: 'published', marks: REAL, targetId: ID(9), providerPostId: '1234567890' });
  await ui.flush();
  assert.ok(ui.text().includes('Xが投稿を受け付けました'));
  assert.equal(ui.kv.data.size, 0, 'a proven end removes the record');
  assert.equal(ui.memory.get('U1'), null);
});

test('restart: leaving the re-entry returns to the unresolved result and never to an editor', async () => {
  const ui = await mount({ kv: deviceWith(RESTORED({ kind: 'in_flight' })) });
  assert.equal(ui.state().result.kind, 'unconfirmed', 'a send that was in flight when the app closed is unconfirmed');
  await ui.press('前回と同じ本文を入力して確認し直す');
  await ui.typeText('earlier text');
  await ui.press('戻る');
  assert.equal(ui.state().phase, 'result');
  assert.equal(ui.state().result.kind, 'unconfirmed');
  assert.ok(ui.state().unresolved !== null);
  assert.equal(ui.all('TextInput').length, 0);
});

test('restart: an uncertain attempt cannot be retried -- only acknowledged, and only after the record is really removed', async () => {
  const kv = deviceWith(RESTORED({ kind: 'uncertain' }));
  const fp = fakePort();
  const ui = await mount({ port: fp, kv });
  assert.equal(ui.state().result.kind, 'uncertain');
  assert.ok(ui.text().includes('Xに投稿された可能性があります'));
  assert.equal(ui.button('前回と同じ本文を入力して確認し直す'), null);
  assert.equal(ui.button('同じ内容・同じ送信IDで確認し直す'), null);
  assert.equal(ui.all('TextInput').length, 0);
  kv.fail.remove = true;
  await ui.press('Xで確認しました（この記録を破棄）');
  assert.ok(ui.text().includes('記録を消去できませんでした。送信は引き続きできません。'));
  assert.equal(ui.state().phase, 'result', 'nothing is unlocked when the record cannot be removed');
  assert.notEqual(ui.memory.get('U1'), null);
  assert.equal(kv.data.size, 1);
  kv.fail.remove = false;
  await ui.press('Xで確認しました（この記録を破棄）');
  assert.equal(ui.state().phase, 'editing');
  assert.equal(kv.data.size, 0);
  assert.equal(ui.memory.get('U1'), null);
  assert.ok(!ui.text().includes('記録を消去できませんでした'));
  assert.equal(fp.calls.send.length, 0);
});

test('restart: a record of another user does not appear, and a sign-out leaves it where it is', async () => {
  const kv = deviceWith(RESTORED());
  const other = await mount({ kv, userId: 'U2' });
  assert.equal(other.state().unresolved, null);
  assert.equal(other.state().store.kind, 'ready');
  assert.equal(other.all('TextInput')[0].props.editable, true);
  const out = await mount({ kv, userId: null });
  assert.equal(out.state().unresolved, null, 'signed out: the record is not read');
  assert.equal(out.state().store.kind, 'ready');
  assert.equal(kv.data.size, 1, "neither visit touched U1's record");
  const back = await mount({ kv, userId: 'U1' });
  assert.equal(back.state().result.kind, 'pending', 'U1 signing in again meets it again');
});

test('restart: an account that is gone cannot re-ask the attempt, and the screen does not switch it to another account', async () => {
  const ui = await mount({ kv: deviceWith(RESTORED()), accounts: [account('X_B')], active: 'X_B' });
  assert.equal(ui.state().accountId, 'X_A', 'still bound to the account of the attempt');
  await ui.press('前回と同じ本文を入力して確認し直す');
  await ui.typeText('earlier text');
  await ui.tick();
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  await ui.pressIgnoringDisabled('Xに投稿する');
  assert.equal(ui.port.calls.send.length, 0);
  assert.equal(ui.state().accountId, 'X_A');
});

test('restart: a record that cannot be read blocks everything and can only be read again', async () => {
  const kv = fakeKV();
  kv.fail.get = true;
  const fp = fakePort();
  const ui = await mount({ kv, port: fp });
  assert.deepEqual(ui.state().store, { kind: 'unreadable', reason: 'io' });
  const t = ui.text();
  assert.ok(t.includes('前回の送信記録を読み込めません'));
  assert.ok(t.includes(model.SEND_BLOCK_MESSAGES.store_unreadable));
  assert.equal(ui.all('TextInput').length, 0);
  assert.equal(ui.button('内容を確認する'), null);
  assert.equal(ui.button('Xで確認しました（記録を消去して続ける）'), null, 'an I/O failure is never acknowledged away');
  await ui.press('もう一度読み込む');
  assert.equal(ui.state().store.kind, 'unreadable', 'still unreadable');
  kv.fail.get = false;
  await ui.press('もう一度読み込む');
  assert.equal(ui.state().store.kind, 'ready');
  assert.equal(ui.all('TextInput')[0].props.editable, true);
  assert.equal(fp.calls.send.length, 0);
});

test('restart: a corrupt or newer-version record needs the explicit acknowledgement, which removes it first', async () => {
  for (const [raw, line] of [['{broken', '記録が壊れているため、読めません。'], [JSON.stringify({ ...RESTORED(), v: 7 }), '新しい版のアプリが残した記録のため、この版では読めません。']]) {
    const kv = fakeKV();
    kv.data.set(store.storeKeyOf('U1'), raw);
    const ui = await mount({ kv });
    assert.ok(ui.text().includes(line), line);
    assert.equal(ui.all('TextInput').length, 0);
    assert.equal(ui.button('内容を確認する'), null);
    kv.fail.remove = true;
    await ui.press('Xで確認しました（記録を消去して続ける）');
    assert.equal(ui.state().store.kind, 'unreadable', 'not unlocked when the record cannot be removed');
    assert.ok(ui.text().includes('記録を消去できませんでした。送信は引き続きできません。'));
    kv.fail.remove = false;
    await ui.press('Xで確認しました（記録を消去して続ける）');
    assert.equal(ui.state().store.kind, 'ready');
    assert.equal(kv.data.size, 0);
    assert.equal(ui.all('TextInput')[0].props.editable, true);
  }
});

test('send: the record is written before the port is called -- and when it cannot be, nothing is sent and the screen says so', async () => {
  for (const mode of ['set', 'drop']) {
    const kv = fakeKV();
    const fp = fakePort();
    const ui = await mount({ kv, port: fp });
    await ui.typeText('こんにちは');
    await ui.press('内容を確認する');
    await ui.tick();
    kv.fail[mode] = true;
    await ui.press('Xに投稿する');
    assert.equal(fp.calls.send.length, 0, `${mode}: the port was never called`);
    assert.equal(ui.state().result.kind, 'refused');
    assert.equal(ui.state().result.code, 'LOCAL_STORE_UNAVAILABLE');
    assert.equal(ui.state().unresolved, null, 'nothing was sent, so nothing is unresolved');
    assertNoSentClaim(ui);
    assert.equal(ui.memory.get('U1'), null);
  }
});

test('send: a pending answer leaves a record, and a restart then shows exactly that attempt (id, account, hash) without the text', async () => {
  const kv = fakeKV();
  const fp = fakePort();
  const first = await mount({ kv, port: fp });
  await first.typeText('こんにちは');
  await first.press('内容を確認する');
  await first.tick();
  await first.press('Xに投稿する');
  assert.equal(JSON.parse(kv.data.get(store.storeKeyOf('U1'))).kind, 'in_flight', 'written before the answer');
  fp.pending[0].resolve({ kind: 'pending', targetId: ID(1), code: 'IN_PROGRESS' });
  await first.flush();
  assert.deepEqual(JSON.parse(kv.data.get(store.storeKeyOf('U1'))), { v: 1, accountId: 'X_A', requestId: ID(1), contentSha256: sha('こんにちは'), kind: 'pending', savedAt: 100_000 });
  assert.ok(!kv.data.get(store.storeKeyOf('U1')).includes('こんにちは'));
  first.unmount();

  const second = await mount({ kv, port: fakePort() }); // the app restarted: a new process memory, the same device
  assert.equal(second.state().result.kind, 'pending');
  assert.equal(second.state().unresolved.requestId, ID(1));
  assert.equal(second.state().unresolved.accountId, 'X_A');
  assert.equal(second.state().unresolved.contentSha256, sha('こんにちは'));
  assert.equal(second.state().unresolved.text, null);
  assert.equal(second.state().draft, '');
});

test('send: a retry whose record cannot be written stays unresolved (never "refused") and sends nothing', async () => {
  const kv = deviceWith(RESTORED());
  const fp = fakePort();
  const ui = await mount({ kv, port: fp });
  await ui.press('前回と同じ本文を入力して確認し直す');
  await ui.typeText('earlier text');
  await ui.tick();
  kv.fail.drop = true;
  await ui.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 0);
  assert.equal(ui.state().result.kind, 'unconfirmed');
  assert.equal(ui.state().result.code, 'LOCAL_STORE_UNAVAILABLE');
  assert.equal(ui.state().unresolved.requestId, ID(9), 'still the same attempt');
  assert.equal(ui.button('Xに投稿する'), null);
  assert.equal(ui.all('TextInput').length, 0, 'and still no editor');
});

test('restart: a double tap on "I checked X" clears the record once', async () => {
  const kv = deviceWith(RESTORED({ kind: 'uncertain' }));
  let removes = 0;
  const remove = kv.removeItem;
  kv.removeItem = async (key) => { removes += 1; return remove(key); };
  const ui = await mount({ kv });
  const b = ui.button('Xで確認しました（この記録を破棄）');
  b.props.onPress();
  b.props.onPress();
  await ui.flush();
  assert.equal(removes, 1);
  assert.equal(ui.state().phase, 'editing');
});

// ---- M3: the result marks of the F3 contract (simulated / afterFreeze) --------------------------------------------------------------

const SIM_NOTE = 'サーバーはこの結果を模擬（テスト用）として返しました。実際のXへの投稿の証拠ではありません。';
const FREEZE_NOTE = 'アカウントの停止または利用終了の手続きと重なって記録された結果です。';

async function sendAndAnswer(outcome, over = {}) {
  const { ui, fp } = await readyConfirmation(over);
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ targetId: ID(1), ...outcome });
  await ui.flush();
  return { ui, fp };
}

test('simulated: an answer without marks, or marked simulated, is a TEST result -- never "Xが投稿を受け付けました", no post id, no resend', async () => {
  for (const marks of [undefined, { simulated: true, afterFreeze: false }, {}, { simulated: 'false' }]) {
    const { ui, fp } = await sendAndAnswer({ kind: 'published', providerPostId: '1234567890', ...(marks === undefined ? {} : { marks }) });
    const t = ui.text();
    assert.equal(ui.state().result.kind, 'simulated', JSON.stringify(marks));
    assert.ok(t.includes('模擬（テスト）の結果です'));
    assert.ok(t.includes('サーバーはこの結果を模擬として返しました。実際のXへの投稿としては扱いません。'));
    assert.ok(t.includes('模擬の結果は、実際にXへ投稿された証拠でも、投稿されていない証拠でもありません。Xで確認するまで、同じ内容を再送信しないでください。'));
    assert.ok(!t.includes('Xが投稿を受け付けました'));
    assert.ok(!t.includes('Xから返された投稿ID'), 'a test result shows no post id');
    assert.ok(!t.includes('1234567890'));
    assertNoSentClaim(ui);
    assert.equal(ui.button('Xに投稿する'), null, 'no send button on a result');
    assert.equal(ui.button('同じ内容・同じ送信IDで確認し直す'), null, 'no resend of a test result');
    assert.equal(ui.button('新しい投稿を作る'), null);
    assert.equal(ui.all('TextInput').length, 0, 'no editor: another text is not offered');
    assert.ok(ui.button('Xで確認しました（この下書きを破棄）'));
    assert.equal(JSON.parse(ui.kv.data.get(realStore.storeKeyOf('U1'))).kind, 'uncertain', 'still blocking after a restart');
    assert.equal(fp.calls.send.length, 1);
  }
});

test('simulated: only the explicit acknowledgement unlocks, and the next attempt is a NEW attempt with a NEW id', async () => {
  const { ui, fp } = await sendAndAnswer({ kind: 'published', providerPostId: '1' });
  await ui.press('Xで確認しました（この下書きを破棄）');
  assert.equal(ui.state().phase, 'editing');
  assert.equal(ui.kv.data.size, 0);
  await ui.typeText('こんにちは');
  await ui.press('内容を確認する');
  await ui.tick();
  await ui.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 2);
  assert.equal(fp.calls.send[1].targetId, ID(2));
});

test('simulated: after an app restart the test result comes back as "uncertain" -- no retry, no editor, acknowledgement only', async () => {
  const kv = fakeKV();
  const first = await sendAndAnswer({ kind: 'published', providerPostId: '1' }, { kv });
  first.ui.unmount();
  const second = await mount({ kv, port: fakePort() });
  assert.equal(second.state().result.kind, 'uncertain');
  assert.ok(second.text().includes('Xに投稿された可能性があります'));
  assert.equal(second.button('前回と同じ本文を入力して確認し直す'), null);
  assert.equal(second.all('TextInput').length, 0);
  assertNoSentClaim(second);
});

test('afterFreeze: a real post is shown as posted WITH the note; the post id is the one the server stored', async () => {
  const { ui } = await sendAndAnswer({ kind: 'published', providerPostId: '1234567890', marks: { simulated: false, afterFreeze: true } });
  const t = ui.text();
  assert.equal(ui.state().result.kind, 'sent');
  assert.ok(t.includes('Xが投稿を受け付けました'));
  assert.ok(t.includes('Xから返された投稿ID: 1234567890'));
  assert.ok(t.includes('この投稿は、アカウントの停止または利用終了の手続きと重なって記録されました。投稿そのものはXが受け付けています。'));
  assert.equal(ui.kv.data.size, 0);
  const plain = await sendAndAnswer({ kind: 'published', providerPostId: '1234567890', marks: REAL });
  assert.ok(!plain.ui.text().includes('停止または利用終了'), 'no note without the mark');
});

test('afterFreeze: an unknown result is never a success -- uncertain and pending keep their rules and add the note', async () => {
  const uncertain = await sendAndAnswer({ kind: 'uncertain', code: 'X_TIMEOUT', marks: { simulated: false, afterFreeze: true } });
  const t = uncertain.ui.text();
  assert.equal(uncertain.ui.state().result.kind, 'uncertain');
  assert.ok(t.includes('Xに投稿された可能性があります'));
  assert.ok(t.includes(FREEZE_NOTE));
  assert.ok(!t.includes('Xが投稿を受け付けました'));
  assertNoSentClaim(uncertain.ui);
  assert.equal(uncertain.ui.button('同じ内容・同じ送信IDで確認し直す'), null, 'uncertain is never resent');
  assert.equal(uncertain.fp.calls.send.length, 1);

  const pending = await sendAndAnswer({ kind: 'pending', code: 'IN_PROGRESS', marks: { simulated: false, afterFreeze: true } });
  assert.equal(pending.ui.state().result.kind, 'pending');
  assert.ok(pending.ui.text().includes(FREEZE_NOTE));
  assert.ok(pending.ui.button('同じ内容・同じ送信IDで確認し直す'), 'pending is still retried with the same id');
  assertNoSentClaim(pending.ui);
});

test('marks on pending / failed / uncertain are explained, never acted on: a simulated one says so and keeps its class', async () => {
  for (const [outcome, kind] of [
    [{ kind: 'pending', code: null }, 'pending'],
    [{ kind: 'rejected', code: 'X_REJECTED_403' }, 'failed'],
    [{ kind: 'uncertain', code: 'X_TIMEOUT' }, 'uncertain'],
  ]) {
    const { ui } = await sendAndAnswer({ ...outcome, marks: { simulated: true, afterFreeze: false } });
    assert.equal(ui.state().result.kind, kind);
    assert.ok(ui.text().includes(SIM_NOTE), kind);
    assertNoSentClaim(ui);
  }
  const unmarked = await sendAndAnswer({ kind: 'pending', code: null });
  assert.ok(unmarked.ui.text().includes(SIM_NOTE), 'a missing mark is read as simulated');
});

test('marks: a restored (after restart) result states nothing about them', async () => {
  const ui = await mount({ kv: deviceWith(RESTORED({ kind: 'uncertain' })) });
  assert.ok(!ui.text().includes(SIM_NOTE));
  assert.ok(!ui.text().includes(FREEZE_NOTE));
});

test('this build: the send stays unreachable -- the unconnected port refuses, nothing is simulated or shown as sent', async () => {
  const ui = await mount({ port: { calls: { check: [], send: [] }, port: realPort.getManualPublishPort() } });
  await ui.typeText('こんにちは');
  await ui.press('内容を確認する');
  await ui.tick();
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  await ui.pressIgnoringDisabled('Xに投稿する');
  assert.equal(ui.state().phase, 'confirming');
  assertNoSentClaim(ui);
});

// ---- P2 keyboard avoidance / P3 dark status bar / P3 IME (G2 QA 2026-10-19: A03 B11 B17 A07) -------------------------------------------

const insideScroll = (ui, predicate) => {
  const found = [];
  walk(ui.all('ScrollView')[0].props.children, (node) => { if (predicate(node)) found.push(node); });
  return found;
};

test('P2 keyboard: the whole form is inside ONE scroll view that makes room for the soft keyboard, keeps taps working and lets a drag dismiss it', async () => {
  const ui = await mount();
  await ui.typeText('こんにちは');
  const scrolls = ui.all('ScrollView');
  assert.equal(scrolls.length, 1);
  const props = scrolls[0].props;
  assert.equal(props.automaticallyAdjustKeyboardInsets, true, 'iOS: the keyboard becomes a bottom inset, so the end of the form can be scrolled above it');
  assert.equal(props.keyboardShouldPersistTaps, 'handled', 'a tap on a button works while the keyboard is up');
  assert.equal(props.keyboardDismissMode, 'interactive', 'iOS: the keyboard stays up while the content is scrolled; only a drag over the keyboard closes it');
  assert.ok(props.contentContainerStyle.paddingBottom >= 32, 'room below the last control');
  // The editor, the preview and the confirm button are all content of that scroll view -- none sits outside it.
  assert.equal(insideScroll(ui, (n) => n.type === 'TextInput').length, 1);
  assert.equal(insideScroll(ui, (n) => n.type === 'ManualPostPreview').length, 1);
  assert.equal(insideScroll(ui, (n) => n.type === 'ActionButton' && n.props.label === '内容を確認する').length, 1);
});

test('P2 keyboard: the confirmation, its consent and every result are inside the same scroll view too', async () => {
  const { ui, fp } = await readyConfirmation();
  assert.equal(ui.all('ScrollView').length, 1);
  assert.equal(insideScroll(ui, (n) => n.type === 'ActionButton' && n.props.label === 'Xに投稿する').length, 1);
  assert.equal(insideScroll(ui, (n) => n.type === 'Pressable' && n.props.accessibilityRole === 'checkbox').length, 1);
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ targetId: ID(1), kind: 'pending', code: null, marks: REAL });
  await ui.flush();
  assert.equal(ui.all('ScrollView').length, 1);
  assert.equal(insideScroll(ui, (n) => n.type === 'ActionButton' && n.props.label === '同じ内容・同じ送信IDで確認し直す').length, 1);
  assert.equal(ui.all('ScrollView')[0].props.automaticallyAdjustKeyboardInsets, true);
});

test('P2 keyboard: the re-entry field of a restored attempt and the record-error screens keep the same scroll behaviour', async () => {
  const restored = await mount({ kv: deviceWith(RESTORED()) });
  await restored.press('前回と同じ本文を入力して確認し直す');
  assert.equal(restored.all('TextInput').length, 1);
  assert.equal(insideScroll(restored, (n) => n.type === 'TextInput').length, 1);
  assert.equal(restored.all('ScrollView')[0].props.automaticallyAdjustKeyboardInsets, true);
  const kv = fakeKV();
  kv.fail.get = true;
  const broken = await mount({ kv });
  assert.equal(broken.all('ScrollView')[0].props.automaticallyAdjustKeyboardInsets, true);
});

test('P3 status bar: dark text on the fixed light screen in EVERY situation -- editing, confirming, results, loading and record errors', async () => {
  const styleOf = (ui) => ui.all('StatusBar').map((node) => node.props.style);
  const editing = await mount();
  assert.deepEqual(styleOf(editing), ['dark']);
  const { ui: confirming, fp } = await readyConfirmation();
  assert.deepEqual(styleOf(confirming), ['dark']);
  await confirming.press('Xに投稿する');
  fp.pending[0].resolve({ targetId: ID(1), kind: 'uncertain', code: 'X_TIMEOUT', marks: REAL });
  await confirming.flush();
  assert.deepEqual(styleOf(confirming), ['dark']);
  const kv = fakeKV();
  let release;
  kv.getItem = () => new Promise((resolve) => { release = () => resolve(null); });
  const loading = await mount({ kv });
  assert.deepEqual(styleOf(loading), ['dark']);
  release();
  const broken = fakeKV();
  broken.fail.get = true;
  assert.deepEqual(styleOf(await mount({ kv: broken })), ['dark']);
  assert.deepEqual(styleOf(await mount({ kv: deviceWith(RESTORED({ kind: 'uncertain' })) })), ['dark']);
});

test('P3 status bar: the header is as fixed as the page (light header, dark text and tint) so the status bar text sits on a light surface in both device appearances', async () => {
  const ui = await mount();
  const options = JSON.parse(JSON.stringify(ui.all('StackScreen')[0].props.options));
  assert.equal(options.headerStyle.backgroundColor, 'background', 'the same light color as the page');
  assert.equal(options.headerTintColor, 'ink');
  assert.equal(options.headerTitleStyle.color, 'ink');
});

// IME: an unfinished composition is already in the draft (so the counter and the preview follow what is on screen),
// but the consent, the confirmation and the request are bound to the text AT THE MOMENT OF CONFIRMATION.

test('IME: the counter and the preview follow every step of a composition, and an empty / blank step cannot be confirmed', async () => {
  const ui = await mount();
  for (const [step, used] of [['こ', 2], ['こん', 4], ['こんに', 6], ['こんにちは', 10]]) {
    await ui.typeText(step);
    assert.equal(ui.all('ManualPostPreview')[0].props.text, step);
    assert.ok(ui.text().includes(`${used} / 280`), `${step}: ${used}`);
    assert.equal(ui.button('内容を確認する').props.disabled, false);
  }
  for (const blank of ['', '  ', '\n']) {
    await ui.typeText(blank);
    assert.equal(ui.button('内容を確認する').props.disabled, true, JSON.stringify(blank));
  }
});

test('IME: a composition that is finished AFTER the confirmation opened cannot change the confirmed text, its hash or the request', async () => {
  const { ui, fp } = await (async () => {
    const fp = fakePort();
    const ui = await mount({ port: fp });
    await ui.typeText('こんにち');
    const lateChange = ui.all('TextInput')[0].props.onChangeText; // the callback the native input would still call
    await ui.press('内容を確認する');
    assert.equal(ui.all('TextInput').length, 0, 'the editor is gone while confirming');
    lateChange('こんにちは！'); // the composition is committed after the confirmation opened
    await ui.flush();
    return { ui, fp };
  })();
  assert.equal(ui.state().draft, 'こんにち', 'the late change was ignored');
  assert.ok(ui.text().includes('こんにち'));
  assert.ok(!ui.text().includes('こんにちは！'));
  await ui.tick();
  assert.equal(ui.checkbox().props.accessibilityState.checked, true);
  assert.ok(ui.text().includes(model.shortHash(sha('こんにち'))), 'the consent names the confirmed text');
  await ui.press('Xに投稿する');
  assert.equal(fp.calls.send[0].renderedText, 'こんにち');
  assert.deepEqual(fp.calls.send[0].consent, { confirmed: true, contentSha256: sha('こんにち') });
});

test('IME: a change that arrives after the consent was given can never reach the request (the consent hash is recomputed from the draft)', async () => {
  const fp = fakePort();
  const ui = await mount({ port: fp });
  await ui.typeText('こんにちは');
  await ui.press('内容を確認する');
  await ui.tick();
  const before = ui.state();
  const forged = model.manualPublishReducer(before, { type: 'draft_changed', text: 'こんにちは！' });
  assert.equal(forged, before, 'no edit while confirming');
  // Even a state whose draft were swapped after the consent would lose the consent (hash mismatch) and so the send.
  assert.equal(model.consentForSend({ ...before, draft: 'こんにちは！' }), null);
  await ui.press('Xに投稿する');
  assert.equal(fp.calls.send[0].renderedText, 'こんにちは');
});

// ---- G2 QA S1 (development red box) and the keyboard-up scroll (G2 K2 report 2026-10-19) ---------------------------------------------------

test('S1 red box: NO screen option about the status bar is passed (react-native-screens demands UIViewControllerBasedStatusBarAppearance=YES for any of them)', async () => {
  for (const status of ['ready', 'mock_preview', 'loading']) {
    const ui = await mount({ status });
    const options = ui.all('StackScreen')[0].props.options;
    assert.deepEqual(Object.keys(options).filter((key) => /^statusBar/u.test(key)), [], status);
  }
  // Every other situation of the screen renders the same single header configuration.
  const { ui, fp } = await readyConfirmation();
  assert.deepEqual(Object.keys(ui.all('StackScreen')[0].props.options).filter((key) => /^statusBar/u.test(key)), []);
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ targetId: ID(1), kind: 'uncertain', code: 'X_TIMEOUT', marks: REAL });
  await ui.flush();
  assert.deepEqual(Object.keys(ui.all('StackScreen')[0].props.options).filter((key) => /^statusBar/u.test(key)), []);
  // The status bar color still comes from the one <StatusBar> (the header keeps its fixed light colors).
  assert.deepEqual(ui.all('StatusBar').map((node) => node.props.style), ['dark']);
});

test('keyboard up: iOS keeps the keyboard while the content is scrolled (interactive); Android, which has no such mode, dismisses on drag', async () => {
  const ios = await mount({ os: 'ios' });
  assert.equal(ios.all('ScrollView')[0].props.keyboardDismissMode, 'interactive');
  const android = await mount({ os: 'android' });
  assert.equal(android.all('ScrollView')[0].props.keyboardDismissMode, 'on-drag');
  for (const ui of [ios, android]) {
    assert.equal(ui.all('ScrollView')[0].props.keyboardShouldPersistTaps, 'handled', 'a tap on a button works while the keyboard is up');
    assert.equal(ui.all('ScrollView')[0].props.automaticallyAdjustKeyboardInsets, true);
  }
});

// ---- G2-U1: what was typed survives a callback route replacing the screen --------------------------------------------------------------------

const TWO = { accounts: [account('X_A'), account('X_B')], active: 'X_A' };
const DKEY = (userId = 'U1') => realDraft.draftKeyOf(userId);
const draftOf = (ui) => (ui.draftKv.data.has(DKEY()) ? JSON.parse(ui.draftKv.data.get(DKEY())) : null);
const chooseSecond = async (ui) => {
  ui.all('Pressable').filter((n) => n.props.accessibilityRole === 'radio')[1].props.onPress();
  await ui.flush();
};
/** The route unmounts (a callback route redirected to home); the person comes back later: a new mount over the same device. */
const comeBack = async (first, over = {}) => {
  first.unmount();
  return mount({ ...TWO, draftKv: first.draftKv, kv: first.kv, ...over });
};

test('U1: the text and the chosen account are still there after the screen was replaced and opened again', async () => {
  const first = await mount(TWO);
  await chooseSecond(first);
  await first.typeText('下書きの本文');
  assert.equal(first.state().accountId, 'X_B');
  assert.deepEqual(draftOf(first), { v: 1, accountId: 'X_B', text: '下書きの本文', sessionMark: 'S1', savedAt: 100_000 });
  const second = await comeBack(first);
  assert.equal(second.state().draft, '下書きの本文');
  assert.equal(second.state().accountId, 'X_B', 'not the suggested account: the one the person chose');
  assert.equal(second.all('TextInput')[0].props.value, '下書きの本文');
  assert.equal(second.all('ManualPostPreview')[0].props.text, '下書きの本文');
  assert.equal(second.state().phase, 'editing');
});

test('U1: only the editor comes back -- no consent, no confirmation, no readiness, no attempt id, and the send stays disabled', async () => {
  const fp = fakePort();
  const first = await mount({ ...TWO, port: fp });
  await first.typeText('こんにちは');
  await first.press('内容を確認する');
  await first.tick();
  assert.equal(first.state().phase, 'confirming');
  assert.ok(first.state().consent !== null);
  const second = await comeBack(first, { port: fp });
  assert.equal(second.state().draft, 'こんにちは');
  assert.equal(second.state().phase, 'editing', 'back in the editor, not in the confirmation');
  for (const key of ['consent', 'readiness', 'requestId', 'result', 'unresolved']) assert.equal(second.state()[key], null, key);
  assert.equal(second.button('Xに投稿する'), null);
  assert.equal(fp.calls.send.length, 0);
  await second.press('内容を確認する');
  assert.equal(second.checkbox().props.accessibilityState.checked, false, 'a new explicit consent is needed');
  assert.equal(second.button('Xに投稿する').props.disabled, true);
  const raw = second.draftKv.data.get(DKEY());
  for (const forbidden of ['consent', 'contentSha256', 'clientRequestId', 'requestId', 'token']) assert.ok(!raw.includes(forbidden), forbidden);
});

test('U1: another user never gets the draft, and another sign-in session of the same user does not either (the record is removed)', async () => {
  const first = await mount(TWO);
  await first.typeText('秘密の下書き');
  first.unmount();
  const other = await mount({ ...TWO, userId: 'U2', draftKv: first.draftKv });
  assert.equal(other.state().draft, '');
  assert.ok(first.draftKv.data.has(DKEY('U1')), "another user's visit leaves U1's record alone");
  const newSession = await mount({ ...TWO, draftKv: first.draftKv, sessionMark: 'S2' });
  assert.equal(newSession.state().draft, '', 'signed out and in again: a new session');
  assert.equal(first.draftKv.data.has(DKEY('U1')), false, 'and the old text is gone from the device');
});

test('U1: an account that is gone or disconnected, an expired draft and a corrupt record are discarded -- and removed', async () => {
  const seed = async (record) => { const kv = fakeKV(); kv.data.set(DKEY(), typeof record === 'string' ? record : JSON.stringify({ v: 1, ...record })); return kv; };
  const fresh = { accountId: 'X_B', text: '下書き', sessionMark: 'S1', savedAt: 100_000 - 1000 };
  for (const [label, record, over] of [
    ['account no longer listed', fresh, { accounts: [account('X_A')], active: 'X_A' }],
    ['account disconnected', fresh, { accounts: [account('X_A'), account('X_B', { connectionStatus: 'not_connected' })], active: 'X_A' }],
    ['expired (24h + 1ms)', { ...fresh, savedAt: 100_000 - realDraft.DRAFT_MAX_AGE_MS - 1 }, {}],
    ['from the future', { ...fresh, savedAt: 100_000 + 10 * 60 * 1000 }, {}],
    ['corrupt', '{broken', {}],
    ['newer version', JSON.stringify({ ...fresh, v: 9 }), {}],
    ['a record that smuggles a consent', JSON.stringify({ v: 1, ...fresh, consent: { confirmed: true } }), {}],
  ]) {
    const draftKv = await seed(record);
    const ui = await mount({ ...TWO, ...over, draftKv });
    assert.equal(ui.state().draft, '', label);
    assert.equal(ui.state().phase, 'editing', label);
    assert.equal(draftKv.data.has(DKEY()), false, `${label}: removed`);
    assert.equal(ui.all('TextInput')[0].props.editable, true, `${label}: the editor is usable`);
  }
});

test('U1: while the account list is not usable the draft waits (loading/unavailable) or is discarded (blocked) -- it is never judged blind', async () => {
  const record = JSON.stringify({ v: 1, accountId: 'X_B', text: '待機中の下書き', sessionMark: 'S1', savedAt: 100_000 - 1000 });
  for (const status of ['loading', 'unavailable']) {
    const draftKv = fakeKV();
    draftKv.data.set(DKEY(), record);
    const ui = await mount({ ...TWO, status, draftKv });
    assert.equal(ui.state().draftRestore, 'pending', status);
    assert.equal(ui.state().draft, '', status);
    assert.equal(draftKv.data.has(DKEY()), true, `${status}: kept for when the list is usable`);
  }
  const draftKv = fakeKV();
  draftKv.data.set(DKEY(), record);
  const blocked = await mount({ ...TWO, status: 'blocked', draftKv });
  assert.equal(blocked.state().draft, '');
  assert.equal(draftKv.data.has(DKEY()), false, 'blocked: discarded');
});

test('U1: emptying the text removes the stored draft, and "下書きを消す" empties it at once; a cleared draft is not put back', async () => {
  const first = await mount(TWO);
  await first.typeText('消すための下書き');
  assert.ok(draftOf(first) !== null);
  assert.ok(first.text().includes('入力中の本文と投稿先は、この端末に最大24時間まで保存され'));
  await first.press('下書きを消す');
  assert.equal(first.state().draft, '');
  assert.equal(draftOf(first), null);
  assert.equal(first.button('下書きを消す'), null, 'nothing to discard');
  const second = await comeBack(first);
  assert.equal(second.state().draft, '');
  await second.typeText('x');
  await second.typeText('   ');
  assert.equal(draftOf(second), null, 'a blank text is not kept either');
  const third = await mount({ ...TWO, draftKv: fakeKV() });
  await third.typeText('あ'.repeat(realDraft.DRAFT_MAX_TEXT_UNITS + 1));
  assert.equal(draftOf(third), null, 'a text nobody can post is not kept');
});

test('U1: starting a send removes the stored draft at once -- the text then lives only in that attempt, whose record holds no text', async () => {
  const kv = fakeKV();
  const fp = fakePort();
  const first = await mount({ ...TWO, port: fp, kv });
  await first.typeText('送信する本文');
  assert.ok(draftOf(first) !== null);
  await first.press('内容を確認する');
  await first.tick();
  assert.ok(draftOf(first) !== null, 'confirming keeps the editor draft');
  await first.press('Xに投稿する');
  assert.equal(draftOf(first), null, 'removed when the send starts');
  assert.ok(!kv.data.get(realStore.storeKeyOf('U1')).includes('送信する本文'), 'the attempt record holds no text');
  fp.pending[0].resolve({ targetId: ID(1), kind: 'pending', code: null, marks: REAL });
  await first.flush();
  assert.equal(draftOf(first), null, 'an unresolved attempt leaves no draft behind');
  const restarted = await mount({ ...TWO, kv, draftKv: first.draftKv });
  assert.equal(restarted.state().result.kind, 'pending');
  assert.equal(restarted.state().draft, '');
  assert.equal(draftOf(restarted), null);
});

test('U1: a draft written before an unresolved attempt is never put in front of it, and is removed', async () => {
  const memory = realFlow.createAttemptMemory();
  memory.mark('U1', { accountId: 'X_A', requestId: ID(9), contentSha256: sha('earlier'), text: 'earlier', kind: 'pending' });
  const draftKv = fakeKV();
  draftKv.data.set(DKEY(), JSON.stringify({ v: 1, accountId: 'X_A', text: '古い下書き', sessionMark: 'S1', savedAt: 100_000 - 1000 }));
  const ui = await mount({ memory, draftKv });
  assert.equal(ui.state().result.kind, 'pending');
  assert.equal(ui.state().draft, 'earlier', "the attempt's own text, not the draft");
  assert.equal(draftKv.data.has(DKEY()), false);
});

test('U1: a failed answer returns the text to the editor and it is kept again; a sent text is not kept', async () => {
  const failed = await sendAndAnswer({ kind: 'rejected', code: 'X_REJECTED_403', marks: REAL });
  assert.equal(draftOf(failed.ui), null, 'nothing while the result is shown');
  await failed.ui.press('編集に戻る');
  assert.equal(failed.ui.state().draft, 'こんにちは');
  assert.equal(draftOf(failed.ui).text, 'こんにちは', 'back in the editor: kept again');
  const sent = await sendAndAnswer({ kind: 'published', providerPostId: '1234567890', marks: REAL });
  await sent.ui.press('新しい投稿を作る');
  assert.equal(draftOf(sent.ui), null);
});

test('U1: typing before the stored draft has been read wins; the stored one is never put over it', async () => {
  const draftKv = fakeKV();
  draftKv.data.set(DKEY(), JSON.stringify({ v: 1, accountId: 'X_B', text: '古い保存', sessionMark: 'S1', savedAt: 100_000 - 1000 }));
  let release;
  const read = draftKv.getItem;
  draftKv.getItem = (key) => new Promise((resolve) => { release = () => resolve(read(key)); });
  const ui = await mount({ ...TWO, draftKv });
  await ui.typeText('先に入力した本文');
  release();
  await ui.flush();
  assert.equal(ui.state().draft, '先に入力した本文');
  assert.equal(JSON.parse(draftKv.data.get(DKEY())).text, '先に入力した本文', 'and the device now holds what is on screen');
});

test('U1: a device storage that fails to read or write never breaks the screen, and the draft is simply not kept', async () => {
  const draftKv = fakeKV();
  draftKv.fail.get = true;
  draftKv.fail.set = true;
  const ui = await mount({ ...TWO, draftKv });
  assert.equal(ui.all('TextInput')[0].props.editable, true);
  await ui.typeText('保存できない本文');
  assert.equal(ui.state().draft, '保存できない本文');
  await ui.press('内容を確認する');
  assert.equal(ui.state().phase, 'confirming');
  assertNoSentClaim(ui);
});

test('U1: the signed-out screen reads and writes no draft', async () => {
  const draftKv = fakeKV();
  draftKv.data.set(DKEY(), JSON.stringify({ v: 1, accountId: null, text: '誰かの下書き', sessionMark: '', savedAt: 100_000 - 1000 }));
  const ui = await mount({ ...TWO, userId: null, draftKv });
  assert.equal(ui.state().draft, '');
  await ui.typeText('ログアウト中の入力');
  assert.equal(draftKv.data.size, 1, 'untouched');
});

test('U1: the route passes the sign-in session mark of the user (a re-login changes it, a token refresh does not)', async () => {
  const world = { memory: realFlow.createAttemptMemory(), port: fakePort().port, status: 'ready', userId: 'U1', accounts: [account('X_A')], active: 'X_A', draftStore: realDraft.createDraftStore(fakeKV()), store: realStore.createAttemptStore(fakeKV()) };
  const rt = await loadRoute(world);
  const element = () => { rt.setCursor(0); return rt.mod.exports.default({}); };
  assert.equal(element().props.sessionMark, '');
  world.session = { user: { id: 'U1', last_sign_in_at: '2026-10-20T01:00:00Z' } };
  assert.equal(element().props.sessionMark, '2026-10-20T01:00:00Z');
});

// ---- G2 SM1 / SM3 / N1 ---------------------------------------------------------------------------------------------------------------------------

const withSession = (world, userId, mark, token = 'ACCESS-TOKEN-1') => { world.userId = userId; world.session = { access_token: token, user: { id: userId, ...(mark === undefined ? {} : { last_sign_in_at: mark }) } }; };

test('SM3: the route re-creates the screen when the SIGN-IN SESSION changes -- also for the same person and without a sign-out in between', async () => {
  const world = { memory: realFlow.createAttemptMemory(), port: fakePort().port, status: 'ready', userId: 'U1', accounts: [account('X_A')], active: 'X_A', draftStore: realDraft.createDraftStore(fakeKV()), store: realStore.createAttemptStore(fakeKV()) };
  const rt = await loadRoute(world);
  const element = () => { rt.setCursor(0); return rt.mod.exports.default({}); };
  withSession(world, 'U1', '2026-10-20T01:00:00Z');
  const first = element();
  assert.equal(first.key, 'U1:2026-10-20T01:00:00Z');
  assert.equal(first.props.sessionMark, '2026-10-20T01:00:00Z');
  // A token refresh: the same person, the same sign-in time, a new access token -> the same screen (nothing is lost).
  withSession(world, 'U1', '2026-10-20T01:00:00Z', 'ACCESS-TOKEN-2');
  assert.equal(element().key, first.key);
  // A new sign-in of the same person (no sign-out event needed): a new sign-in time -> a NEW screen.
  withSession(world, 'U1', '2026-10-20T09:30:00Z');
  const second = element();
  assert.notEqual(second.key, first.key);
  assert.equal(second.props.sessionMark, '2026-10-20T09:30:00Z');
  // Another person, signed out, and a session without a sign-in time.
  withSession(world, 'U2', '2026-10-20T09:30:00Z');
  assert.equal(element().key, 'U2:2026-10-20T09:30:00Z');
  withSession(world, 'U1', undefined);
  assert.equal(element().key, 'U1:');
  assert.equal(element().props.sessionMark, '');
  world.userId = null;
  assert.equal(element().key, 'signed-out');
  // Nothing of the access token is in the element (key or props).
  withSession(world, 'U1', 'S', 'SECRET-ACCESS-TOKEN');
  assert.ok(!JSON.stringify(element().key).includes('SECRET') && !JSON.stringify(element().props).includes('SECRET'));
});

test('SM3: text typed in one session never reaches the next one -- not on screen, and not under the next session\'s mark on the device', async () => {
  const first = await mount({ ...TWO, sessionMark: 'S1' });
  await first.typeText('前のセッションの本文');
  assert.equal(JSON.parse(first.draftKv.data.get(DKEY())).sessionMark, 'S1');
  first.unmount(); // the route re-created the screen because the mark changed
  const second = await mount({ ...TWO, draftKv: first.draftKv, sessionMark: 'S2' });
  assert.equal(second.state().draft, '');
  assert.equal(first.draftKv.data.has(DKEY()), false, 'the old session\'s text is removed');
  await second.typeText('新');
  const record = JSON.parse(second.draftKv.data.get(DKEY()));
  assert.equal(record.text, '新');
  assert.equal(record.sessionMark, 'S2', 'only what the person types in THIS session is kept, under this session\'s mark');
  assert.ok(!second.draftKv.data.get(DKEY()).includes('前のセッション'));
});

test('SM1: without a usable session mark the screen keeps nothing and restores nothing, and removes what it finds', async () => {
  for (const mark of ['', 'm'.repeat(65)]) {
    const draftKv = fakeKV();
    draftKv.data.set(DKEY(), JSON.stringify({ v: 1, accountId: 'X_B', text: '印の無い下書き', sessionMark: mark === '' ? '' : 'S1', savedAt: 100_000 - 1000 }));
    const ui = await mount({ ...TWO, draftKv, sessionMark: mark });
    assert.equal(ui.state().draft, '', JSON.stringify(mark));
    assert.equal(draftKv.data.has(DKEY()), false, `${mark.length}: the record is removed`);
    let writes = 0;
    const set = draftKv.setItem;
    draftKv.setItem = async (key, value) => { writes += 1; return set(key, value); };
    await ui.typeText('保存されない本文');
    assert.equal(writes, 0, 'the device storage is not even asked to write');
    assert.equal(ui.state().draft, '保存されない本文', 'the editor works as usual');
    assert.equal(draftKv.data.has(DKEY()), false, 'but nothing is written without a usable mark');
    assert.equal(ui.all('TextInput')[0].props.editable, true);
  }
  // Same for an earlier build's record with an empty mark when the mark IS usable now.
  const old = fakeKV();
  old.data.set(DKEY(), JSON.stringify({ v: 1, accountId: null, text: '昔の下書き', sessionMark: '', savedAt: 100_000 - 1000 }));
  const ui = await mount({ ...TWO, draftKv: old, sessionMark: 'S1' });
  assert.equal(ui.state().draft, '');
  assert.equal(old.data.has(DKEY()), false);
});

test('N1: a FIRST send does not say "same content, same send id" -- only a real re-ask does', async () => {
  const SENTENCE = '前回と同じ内容・同じ送信IDで確認します';
  const { ui, fp } = await readyConfirmation();
  assert.ok(!ui.text().includes(SENTENCE), 'a fresh confirmation');
  await ui.press('Xに投稿する');
  assert.equal(ui.state().phase, 'sending');
  assert.equal(ui.state().retrying, false);
  assert.ok(!ui.text().includes(SENTENCE), 'a first send under way');
  fp.pending[0].resolve({ targetId: ID(1), kind: 'pending', code: null, marks: REAL });
  await ui.flush();
  assert.ok(!ui.text().includes(SENTENCE), 'the result');
  // Re-asking the same attempt: the sentence is true, in the confirmation and while sending.
  await ui.press('同じ内容・同じ送信IDで確認し直す');
  assert.equal(ui.state().phase, 'confirming');
  assert.ok(ui.text().includes(SENTENCE), 'confirming a re-ask');
  await ui.tick();
  await ui.press('Xに投稿する');
  assert.equal(ui.state().phase, 'sending');
  assert.equal(ui.state().retrying, true);
  assert.ok(ui.text().includes(SENTENCE), 'a re-ask under way');
  assert.equal(fp.calls.send[1].targetId, ID(1), 'the same attempt id');
  fp.pending[1].resolve({ targetId: ID(1), kind: 'published', providerPostId: '9', marks: REAL });
  await ui.flush();
  assert.ok(!ui.text().includes(SENTENCE));
  assert.equal(ui.state().retrying, false);
});

// ---- G2-SM3R: the screen is re-created while a send is OUT ------------------------------------------------------------------------------------

async function sendThenRecreate(over = {}) {
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const kv = fakeKV();
  const draftKv = fakeKV();
  const fp = fakePort();
  const first = await mount({ ...TWO, port: fp, memory, inflight, kv, draftKv, sessionMark: 'T1' });
  await first.typeText('送信中の本文');
  await first.press('内容を確認する');
  await first.tick();
  await first.press('Xに投稿する');
  assert.equal(first.state().phase, 'sending');
  first.unmount(); // the route re-created the screen because the sign-in session mark changed
  const second = await mount({ ...TWO, port: fp, memory, inflight, kv, draftKv, sessionMark: 'T2', ...over });
  return { fp, memory, inflight, kv, draftKv, first, second };
}

test('SM3R: a screen re-created while the send is out does NOT say "unconfirmed", offers no re-ask, and sends nothing a second time', async () => {
  const { fp, second } = await sendThenRecreate();
  assert.equal(second.state().phase, 'sending');
  const t = second.text();
  assert.ok(!t.includes('結果を確認できません'), 'no verdict on a request that is still on its way');
  assert.ok(!t.includes('通信できず、投稿されたかどうか分かりません'));
  assert.ok(!t.includes('前回と同じ内容・同じ送信IDで確認します'), 'it is not a re-ask');
  assert.equal(second.button('同じ内容・同じ送信IDで確認し直す'), null);
  assert.equal(second.button('Xで確認しました（この下書きを破棄）'), null, 'it cannot be discarded while it is out');
  assert.equal(second.button('送信中…').props.disabled, true);
  assert.equal(second.button('戻る').props.disabled, true);
  await second.pressIgnoringDisabled('送信中…');
  await second.pressIgnoringDisabled('送信中…');
  assert.equal(fp.calls.send.length, 1, 'exactly ONE request, the first one');
  assertNoSentClaim(second);
});

test('SM3R: when the answer arrives, the re-created screen shows IT -- pending, sent, rejected, uncertain, simulated, a thrown port', async () => {
  const cases = [
    [{ kind: 'pending', code: 'IN_PROGRESS', marks: REAL }, 'pending', true],
    [{ kind: 'published', providerPostId: '1234567890', marks: REAL }, 'sent', false],
    [{ kind: 'published', providerPostId: '1234567890' }, 'simulated', false],
    [{ kind: 'rejected', code: 'X_REJECTED_403', marks: REAL }, 'failed', false],
    [{ kind: 'uncertain', code: 'X_TIMEOUT', marks: REAL }, 'uncertain', false],
    [{ kind: 'unavailable', code: 'TRANSPORT_FAILED' }, 'unconfirmed', true],
  ];
  for (const [answer, kind, mayRetry] of cases) {
    const { fp, second, memory } = await sendThenRecreate();
    fp.pending[0].resolve({ targetId: ID(1), ...answer });
    await second.flush();
    assert.equal(second.state().phase, 'result', kind);
    assert.equal(second.state().result.kind, kind, kind);
    assert.equal(Boolean(second.button('同じ内容・同じ送信IDで確認し直す')), mayRetry, `${kind}: a same-id re-ask only where it is allowed`);
    if (kind === 'sent') assert.ok(second.text().includes('Xから返された投稿ID: 1234567890'));
    if (kind === 'sent' || kind === 'failed') assert.equal(memory.get('U1'), null, kind);
    else assert.equal(memory.get('U1').requestId, ID(1), `${kind}: still an unresolved attempt`);
    assert.equal(fp.calls.send.length, 1, kind);
  }
  const thrown = await sendThenRecreate();
  thrown.fp.pending[0].reject(new Error('socket closed'));
  await thrown.second.flush();
  assert.equal(thrown.second.state().result.kind, 'uncertain', 'a thrown port may have sent');
  assert.equal(thrown.second.state().result.code, 'SEND_THREW');
  assert.equal(thrown.second.button('同じ内容・同じ送信IDで確認し直す'), null);
});

test('SM3R: the record on the device and the memory are final BEFORE the waiting screen is told (the re-ask afterwards uses the same id)', async () => {
  const { fp, second, kv, memory } = await sendThenRecreate();
  fp.pending[0].resolve({ targetId: ID(1), kind: 'pending', code: null, marks: REAL });
  await second.flush();
  assert.equal(JSON.parse(kv.data.get(realStore.storeKeyOf('U1'))).kind, 'pending');
  assert.equal(memory.get('U1').kind, 'pending');
  await second.press('同じ内容・同じ送信IDで確認し直す');
  await second.tick();
  await second.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 2);
  assert.equal(fp.calls.send[1].targetId, ID(1), 'the SAME attempt id');
});

test('SM3R: re-created TWICE (or several times) while the send is out -- each new screen waits, the answer reaches the last one, still one request', async () => {
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  const kv = fakeKV();
  const draftKv = fakeKV();
  const first = await mount({ ...TWO, port: fp, memory, inflight, kv, draftKv, sessionMark: 'T1' });
  await first.typeText('二重に再作成');
  await first.press('内容を確認する');
  await first.tick();
  await first.press('Xに投稿する');
  first.unmount();
  const second = await mount({ ...TWO, port: fp, memory, inflight, kv, draftKv, sessionMark: 'T2' });
  second.unmount();
  const third = await mount({ ...TWO, port: fp, memory, inflight, kv, draftKv, sessionMark: 'T3' });
  assert.equal(third.state().phase, 'sending');
  fp.pending[0].resolve({ targetId: ID(1), kind: 'published', providerPostId: '42', marks: REAL });
  await third.flush();
  assert.equal(third.state().result.kind, 'sent');
  assert.equal(fp.calls.send.length, 1);
});

test('SM3R: an account change while the take-over screen waits does not turn into a verdict or a send', async () => {
  const { fp, second } = await sendThenRecreate();
  second.world.accounts = [account('X_B')];
  second.world.active = 'X_B';
  await second.flush();
  assert.equal(second.state().phase, 'sending');
  assert.equal(second.state().accountId, 'X_A', 'the attempt stays with its account');
  assert.equal(fp.calls.send.length, 1);
  fp.pending[0].resolve({ targetId: ID(1), kind: 'uncertain', code: 'X_TIMEOUT', marks: REAL });
  await second.flush();
  assert.equal(second.state().result.kind, 'uncertain');
});

test('SM3R: the send is gone from the registry (nothing to wait for) -> uncertain, never sent, never "not posted", no re-ask', async () => {
  // The registry shows the send when the screen is created, but has lost it by the time the screen asks again.
  const real = realFlow.createInFlightSends();
  const handle = real.begin('U1', { accountId: 'X_A', requestId: ID(5), contentSha256: sha('lost'), text: 'lost', kind: 'in_flight' }, false);
  let asked = 0;
  const lying = { ...real, takeOver: (userId) => { asked += 1; return asked === 1 ? real.takeOver(userId) : null; } };
  assert.ok(handle);
  const ui = await mount({ inflight: lying });
  assert.equal(ui.state().result.kind, 'uncertain');
  assert.equal(ui.state().result.code, 'SEND_STATE_LOST');
  assert.equal(ui.button('同じ内容・同じ送信IDで確認し直す'), null);
  assertNoSentClaim(ui);
});

test('SM3R: only a send that is REALLY still out is taken over -- after the answer, after a restart, or without the text, the earlier behaviour holds', async () => {
  // (a) the answer already came: the memory has the final kind -> a normal "unresolved" visit
  const done = await sendThenRecreate();
  done.fp.pending[0].resolve({ targetId: ID(1), kind: 'pending', code: null, marks: REAL });
  await done.second.flush();
  done.second.unmount();
  const later = await mount({ ...TWO, port: done.fp, memory: done.memory, inflight: done.inflight, kv: done.kv, draftKv: done.draftKv, sessionMark: 'T3' });
  assert.equal(later.state().phase, 'result');
  assert.equal(later.state().result.kind, 'pending');
  assert.equal(later.state().result.code, model.UNRESOLVED_FROM_EARLIER_VISIT);
  // (b) in_flight in the memory but NOT out in this process (e.g. restored after a restart: no text) -> unconfirmed, same-id re-ask
  const restarted = await mount({ kv: deviceWith(RESTORED({ kind: 'in_flight' })), inflight: realFlow.createInFlightSends() });
  assert.equal(restarted.state().result.kind, 'unconfirmed');
  assert.ok(restarted.button('前回と同じ本文を入力して確認し直す'));
  // (c) in_flight with text in the memory, but the registry does not know it is out -> the earlier behaviour (unconfirmed)
  const memory = realFlow.createAttemptMemory();
  memory.mark('U1', { accountId: 'X_A', requestId: ID(6), contentSha256: sha('x'), text: 'x', kind: 'in_flight' });
  const other = await mount({ memory, inflight: realFlow.createInFlightSends() });
  assert.equal(other.state().result.kind, 'unconfirmed');
});

test('SM3R: the take-over keeps the draft rules -- nothing of the sending text is on the device as a draft', async () => {
  const { second, draftKv, kv } = await sendThenRecreate();
  assert.equal(draftKv.data.size, 0, 'no draft copy of the text that is being sent');
  assert.ok(!kv.data.get(realStore.storeKeyOf('U1')).includes('送信中の本文'), 'the attempt record holds no text');
  assert.equal(second.state().consent, null, 'no consent is carried over');
});

test('SM3R: a screen\'s OWN send is never mistaken for a take-over -- even when its effects run before the send has been registered', async () => {
  const fp = fakePort();
  const ui = await mount({ port: fp });
  await ui.typeText('自分の送信');
  await ui.press('内容を確認する');
  await ui.tick();
  // In a real app the effects run right after the render, BEFORE the (asynchronous) record write of the send has finished.
  ui.button('Xに投稿する').props.onPress();
  ui.tree();
  const batch = ui.rt.pendingEffects.splice(0);
  for (const { i, effect } of batch) {
    ui.rt.slots[i].cleanup?.();
    const cleanup = effect();
    ui.rt.slots[i].cleanup = typeof cleanup === 'function' ? cleanup : undefined;
  }
  assert.equal(ui.state().phase, 'sending', 'not turned into an uncertain result by the take-over logic');
  assert.equal(ui.state().result, null);
  await ui.flush();
  assert.equal(ui.state().phase, 'sending');
  assert.equal(fp.calls.send.length, 1);
  fp.pending[0].resolve({ targetId: ID(1), kind: 'published', providerPostId: '5', marks: REAL });
  await ui.flush();
  assert.equal(ui.state().result.kind, 'sent');
});

test('SM3R: an in_flight attempt restored from the device (no text) is not taken over; another user\'s unfinished send does not touch this user\'s screen', async () => {
  const inflight = realFlow.createInFlightSends();
  assert.ok(inflight.begin('U2', { accountId: 'X_A', requestId: ID(8), contentSha256: sha('x'), text: 'x', kind: 'in_flight' }, false));
  const ui = await mount({ kv: deviceWith(RESTORED({ kind: 'in_flight', requestId: ID(8) })), inflight });
  assert.equal(ui.state().phase, 'result');
  assert.equal(ui.state().result.kind, 'unconfirmed', 'the earlier restart behaviour');
  assert.ok(ui.button('前回と同じ本文を入力して確認し直す'));
});

// ---- H1 P2-1 / P2-2: a send that is still being PREPARED, or already answered but not yet recorded ---------------------------------------------

/** A device storage whose next read-back after a write, or whose next write of a given record, can be held back by the test. */
function stallableKV() {
  const kv = fakeKV();
  const realGet = kv.getItem;
  const realSet = kv.setItem;
  const ctl = { kv, armReadBack: false, stallSetWhen: null, held: [] };
  let justWrote = false;
  const hold = () => new Promise((resolve) => { ctl.held.push(resolve); });
  kv.setItem = async (key, value) => {
    if (ctl.stallSetWhen !== null && ctl.stallSetWhen(value)) { ctl.stallSetWhen = null; await hold(); }
    await realSet(key, value);
    if (ctl.armReadBack) { ctl.armReadBack = false; justWrote = true; }
  };
  kv.getItem = async (key) => {
    if (justWrote) { justWrote = false; await hold(); }
    return realGet(key);
  };
  ctl.release = () => { for (const resolve of ctl.held.splice(0)) resolve(); };
  return ctl;
}

async function startSendWithStalledReadBack() {
  const stall = stallableKV();
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  const draftKv = fakeKV();
  const first = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T1' });
  await first.typeText('保存中の本文');
  await first.press('内容を確認する');
  await first.tick();
  stall.armReadBack = true;
  await first.press('Xに投稿する');
  return { stall, memory, inflight, fp, draftKv, first };
}

test('P2-1: the screen is re-created while the first record is still being written -- it waits, offers no re-ask, and the first send goes out ONCE', async () => {
  const { stall, memory, inflight, fp, draftKv, first } = await startSendWithStalledReadBack();
  assert.equal(first.state().phase, 'sending');
  assert.equal(fp.calls.send.length, 0, 'nothing is sent before the record on the device is confirmed');
  first.unmount(); // the sign-in session mark changed: the route re-created the screen
  const second = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T2' });
  assert.equal(second.state().phase, 'sending', 'the send is under way, it is not "unconfirmed"');
  assert.ok(!second.text().includes('結果を確認できません'));
  assert.equal(second.button('前回と同じ本文を入力して確認し直す'), null, 'no re-ask while the first request is not even out yet');
  assert.equal(second.button('同じ内容・同じ送信IDで確認し直す'), null);
  stall.release();
  await second.flush();
  assert.equal(fp.calls.send.length, 1, 'the first request goes out');
  assert.equal(second.state().phase, 'sending', 'still waiting for the answer of that request');
  await second.pressIgnoringDisabled('送信中…');
  assert.equal(fp.calls.send.length, 1, 'a forced press does not send a second time');
  fp.pending[0].resolve({ targetId: ID(1), kind: 'published', providerPostId: '98765', marks: REAL });
  await second.flush();
  assert.equal(second.state().result.kind, 'sent', 'the real answer reaches the waiting screen');
  assert.equal(fp.calls.send.length, 1);
});

test('P2-1: a re-ask tried from the re-created screen can never put a second request with the same id on the wire', async () => {
  const { stall, memory, inflight, fp, draftKv, first } = await startSendWithStalledReadBack();
  first.unmount();
  const second = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T2' });
  const reask = second.button('前回と同じ本文を入力して確認し直す') ?? second.button('同じ内容・同じ送信IDで確認し直す');
  if (reask !== null) {
    await second.press(reask.props.label);
    if (second.state().phase === 'confirming') {
      if (second.all('TextInput').length > 0 && second.state().draft === '') await second.typeText('保存中の本文');
      await second.tick();
    }
    if (second.button('Xに投稿する') !== null) await second.press('Xに投稿する');
  }
  stall.release();
  await second.flush();
  assert.equal(fp.calls.send.length, 1, 'exactly one request for the attempt');
  assert.deepEqual(new Set(fp.calls.send.map((target) => target.targetId)), new Set([ID(1)]));
});

async function startSendAnsweredButNotRecorded() {
  const stall = stallableKV();
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  const draftKv = fakeKV();
  const first = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T1' });
  await first.typeText('応答済みの本文');
  await first.press('内容を確認する');
  await first.tick();
  await first.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 1);
  stall.stallSetWhen = (value) => value.includes('"kind":"pending"');
  fp.pending[0].resolve({ targetId: ID(1), kind: 'pending', code: 'FIRST_PENDING', marks: REAL });
  await first.flush();
  return { stall, memory, inflight, fp, draftKv, first };
}

test('P2-2: the first answer is "pending" but its record on the device is not written yet -- a re-created screen waits and cannot re-ask', async () => {
  const { stall, memory, inflight, fp, draftKv, first } = await startSendAnsweredButNotRecorded();
  assert.equal(memory.get('U1').kind, 'pending', 'the memory already has the answer');
  first.unmount();
  const second = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T2' });
  assert.equal(second.state().phase, 'sending', 'the record is not final yet: no result, no re-ask');
  assert.equal(second.button('同じ内容・同じ送信IDで確認し直す'), null);
  assert.equal(fp.calls.send.length, 1);
  stall.release();
  await second.flush();
  assert.equal(second.state().result.kind, 'pending', 'once the record is final the screen shows the real answer');
  assert.equal(second.state().result.code, 'FIRST_PENDING');
  assert.ok(second.button('同じ内容・同じ送信IDで確認し直す'), 'only now a same-id re-ask is possible');
});

const outstanding = (fp) => fp.pending.filter((p) => p.settled !== true).length;
const answer = (fp, index, outcome) => { fp.pending[index].settled = true; fp.pending[index].resolve({ targetId: ID(1), ...outcome }); };

test('P2-2: the old answer never ends a newer request (A/B/A) -- at most one request is out, and the real answer of the re-ask reaches the screen that waits', async () => {
  const { stall, memory, inflight, fp, draftKv, first } = await startSendAnsweredButNotRecorded();
  first.settledFirst = true;
  fp.pending[0].settled = true;
  first.unmount();
  const second = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T2' });
  // The re-ask is tried while the record of the first answer is still not written (what a re-created screen used to allow).
  const reask = second.button('同じ内容・同じ送信IDで確認し直す');
  if (reask !== null) {
    await second.press('同じ内容・同じ送信IDで確認し直す');
    await second.tick();
    await second.press('Xに投稿する');
  }
  assert.ok(outstanding(fp) <= 1);
  second.unmount();
  const third = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T3' });
  assert.equal(third.state().phase, 'sending', 'whatever is out, the new screen waits and offers no re-ask');
  assert.equal(third.button('同じ内容・同じ送信IDで確認し直す'), null);
  stall.release();
  await third.flush();
  if (outstanding(fp) === 1) {
    // a request is really out (only possible if the re-ask was let through): its real answer must reach the screen
    answer(fp, fp.pending.findIndex((p) => p.settled !== true), { kind: 'published', providerPostId: '98765', marks: REAL });
    await third.flush();
    assert.equal(third.state().result.kind, 'sent', 'the real answer is not lost');
  } else {
    assert.equal(third.state().result.kind, 'pending', 'the first answer, once its record is final');
    await third.press('同じ内容・同じ送信IDで確認し直す');
    await third.tick();
    await third.press('Xに投稿する');
    assert.equal(outstanding(fp), 1);
    answer(fp, fp.pending.findIndex((p) => p.settled !== true), { kind: 'published', providerPostId: '98765', marks: REAL });
    await third.flush();
    assert.equal(third.state().result.kind, 'sent', 'the real answer of the re-ask reaches the screen');
    assert.equal(third.state().result.providerPostId, '98765');
  }
  assert.ok(fp.calls.send.every((target) => target.targetId === ID(1)), 'one attempt id throughout');
});

// ---- the rest of the H1 P2 negative set (screen level) -----------------------------------------------------------------------------------------

test('P2-1: re-created several times while the first record is being written -- every screen waits, the last one gets the answer, one request', async () => {
  const { stall, memory, inflight, fp, draftKv, first } = await startSendWithStalledReadBack();
  first.unmount();
  const second = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T2' });
  assert.equal(second.state().phase, 'sending');
  second.unmount();
  const third = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T3' });
  assert.equal(third.state().phase, 'sending');
  assert.equal(third.state().draft, '保存中の本文', 'it shows the attempt that is being sent');
  stall.release();
  await third.flush();
  assert.equal(fp.calls.send.length, 1);
  fp.pending[0].resolve({ targetId: ID(1), kind: 'rejected', code: 'X_REJECTED_403', marks: REAL });
  await third.flush();
  assert.equal(third.state().result.kind, 'failed');
  assert.equal(memory.get('U1'), null);
  assert.equal(fp.calls.send.length, 1);
});

test('P2-1: the record cannot be written -- the waiting screen is released with the refusal, nothing was sent, and the fresh editor works again', async () => {
  const stall = stallableKV();
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  const draftKv = fakeKV();
  const first = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T1' });
  await first.typeText('書けない本文');
  await first.press('内容を確認する');
  await first.tick();
  stall.stallSetWhen = () => true;
  await first.press('Xに投稿する');
  first.unmount();
  const second = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T2' });
  assert.equal(second.state().phase, 'sending');
  stall.kv.fail.set = true; // the write fails once it is let through
  stall.release();
  await second.flush();
  assert.equal(second.state().phase, 'result');
  assert.equal(second.state().result.kind, 'refused');
  assert.equal(second.state().result.code, 'LOCAL_STORE_UNAVAILABLE');
  assert.equal(second.state().unresolved, null, 'it was never sent: nothing unresolved');
  assert.equal(fp.calls.send.length, 0);
  assert.equal(memory.get('U1'), null);
  assertNoSentClaim(second);
});

test('P2-1: a record that is read late by a screen which was opened BEFORE the send began does not turn that send into "unconfirmed"', async () => {
  const stall = stallableKV();
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  const draftKv = fakeKV();
  // B opens first: its read of the device record is held back (late store_loaded).
  const realGet = stall.kv.getItem;
  const heldReads = [];
  stall.kv.getItem = async (key) => {
    if (heldReads.length === 0 && stall.holdFirstRead === true) { stall.holdFirstRead = false; await new Promise((resolve) => heldReads.push(resolve)); }
    return realGet(key);
  };
  stall.holdFirstRead = true;
  const slow = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T1' });
  assert.equal(slow.state().store.kind, 'loading');
  // A (another screen of the same user) sends meanwhile.
  const sender = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T1' });
  await sender.typeText('先に送る');
  await sender.press('内容を確認する');
  await sender.tick();
  await sender.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 1);
  // Now B's read comes back and finds the record the send wrote.
  for (const resolve of heldReads.splice(0)) resolve();
  await slow.flush();
  assert.equal(slow.state().phase, 'sending', 'the record is the send\'s own, not an earlier run\'s');
  assert.equal(slow.button('前回と同じ本文を入力して確認し直す'), null);
  assert.equal(slow.state().result, null);
  fp.pending[0].resolve({ targetId: ID(1), kind: 'published', providerPostId: '4711', marks: REAL });
  await slow.flush();
  assert.equal(slow.state().result.kind, 'sent');
  assert.equal(memory.get('U1'), null);
  assert.equal(fp.calls.send.length, 1);
});

test('P2-2: another user, and another account of the same user, are not held back by an unfinished send of this user', async () => {
  const { stall, memory, inflight, fp, draftKv, first } = await startSendAnsweredButNotRecorded();
  first.unmount();
  const otherUser = await mount({ ...TWO, userId: 'U2', port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T9' });
  assert.equal(otherUser.state().phase, 'editing', 'a different user starts with a free editor');
  assert.ok(otherUser.state().unresolved === null);
  const sameUser = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T2' });
  sameUser.world.accounts = [account('X_B')];
  sameUser.world.active = 'X_B';
  await sameUser.flush();
  assert.equal(sameUser.state().phase, 'sending', 'the attempt stays with its account and its user');
  assert.equal(sameUser.state().accountId, 'X_A');
  assert.equal(sameUser.button('同じ内容・同じ送信IDで確認し直す'), null);
  stall.release();
  await sameUser.flush();
  assert.equal(sameUser.state().result.kind, 'pending');
  assert.equal(fp.calls.send.length, 1);
});

test('P2-2: a request that never gets an answer keeps the screens waiting -- no verdict, no re-ask, no second request (transport timeout is the transport owner\'s)', async () => {
  const { memory, inflight, fp, draftKv, first, stall } = await startSendWithStalledReadBack();
  stall.release();
  await first.flush();
  assert.equal(fp.calls.send.length, 1);
  first.unmount();
  const second = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T2' });
  for (let i = 0; i < 5; i += 1) await second.flush();
  assert.equal(second.state().phase, 'sending');
  assert.equal(second.button('同じ内容・同じ送信IDで確認し直す'), null);
  await second.pressIgnoringDisabled('送信中…');
  assert.equal(fp.calls.send.length, 1);
  assertNoSentClaim(second);
});

test('P2-2: the answer is a simulated or marks-less success -- the waiting screen shows it as a test result, never as sent', async () => {
  const { stall, memory, inflight, fp, draftKv, first } = await startSendWithStalledReadBack();
  first.unmount();
  const second = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T2' });
  stall.release();
  await second.flush();
  fp.pending[0].resolve({ targetId: ID(1), kind: 'published', providerPostId: '1234567890' });
  await second.flush();
  assert.equal(second.state().result.kind, 'simulated');
  assert.equal(memory.get('U1').kind, 'uncertain', 'kept unresolved, never resent');
  assert.equal(second.button('同じ内容・同じ送信IDで確認し直す'), null);
  assertNoSentClaim(second);
});

test('P2-2: a screen that takes over a RE-ASK that is out says it is a re-ask, and offers neither another re-ask nor a discard', async () => {
  const SENTENCE = '前回と同じ内容・同じ送信IDで確認します';
  const { stall, memory, inflight, fp, draftKv, first } = await startSendAnsweredButNotRecorded();
  stall.release();
  await first.flush();
  assert.equal(first.state().result.kind, 'pending');
  await first.press('同じ内容・同じ送信IDで確認し直す');
  await first.tick();
  await first.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 2, 'the re-ask: the same id');
  assert.equal(first.state().retrying, true);
  first.unmount();
  const second = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv, sessionMark: 'T2' });
  assert.equal(second.state().phase, 'sending');
  assert.equal(second.state().retrying, true, 'it is a re-ask that is out');
  assert.ok(second.text().includes(SENTENCE));
  assert.equal(second.button('同じ内容・同じ送信IDで確認し直す'), null);
  assert.equal(second.button('Xで確認しました（この下書きを破棄）'), null);
  fp.pending[1].resolve({ targetId: ID(1), kind: 'published', providerPostId: '98765', marks: REAL });
  await second.flush();
  assert.equal(second.state().result.kind, 'sent');
  assert.equal(second.state().retrying, false);
  assert.ok(!second.text().includes(SENTENCE));
});

test('P2-2: two screens of one user both offer the re-ask -- the second press is refused as "in progress", the attempt stays unresolved, one request', async () => {
  const memory = realFlow.createAttemptMemory();
  memory.mark('U1', { accountId: 'X_A', requestId: ID(1), contentSha256: sha('二つの画面'), text: '二つの画面', kind: 'pending' });
  const inflight = realFlow.createInFlightSends();
  const kv = deviceWith(RESTORED({ kind: 'pending', requestId: ID(1), contentSha256: sha('二つの画面') }));
  const fp = fakePort();
  const a = await mount({ ...TWO, port: fp, memory, inflight, kv, draftKv: fakeKV(), sessionMark: 'T1' });
  const b = await mount({ ...TWO, port: fp, memory, inflight, kv, draftKv: fakeKV(), sessionMark: 'T1' });
  for (const ui of [a, b]) {
    assert.equal(ui.state().result.kind, 'pending');
    await ui.press('同じ内容・同じ送信IDで確認し直す');
    await ui.tick();
  }
  await a.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 1, 'a re-ask is out');
  await b.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 1, 'the second screen could not put a second request on the wire');
  assert.equal(b.state().result.kind, 'unconfirmed');
  assert.equal(b.state().result.code, 'LOCAL_SEND_IN_PROGRESS');
  assert.notEqual(b.state().unresolved, null, 'the attempt stays unresolved');
  assertNoSentClaim(b);
  fp.pending[0].resolve({ targetId: ID(1), kind: 'published', providerPostId: '55', marks: REAL });
  await a.flush();
  assert.equal(a.state().result.kind, 'sent');
});

test('P2-2: a registry that hands out a different send the second time never turns the answer of another attempt into this screen\'s result', async () => {
  const real = realFlow.createInFlightSends();
  assert.ok(real.begin('U1', { accountId: 'X_A', requestId: ID(5), contentSha256: sha('five'), text: 'five', kind: 'in_flight' }, false));
  const other = realFlow.createInFlightSends();
  const handle = other.begin('U1', { accountId: 'X_A', requestId: ID(6), contentSha256: sha('six'), text: 'six', kind: 'in_flight' }, false);
  const otherTaken = other.takeOver('U1');
  let asked = 0;
  const lying = { ...real, takeOver: (userId) => { asked += 1; return asked === 1 ? real.takeOver(userId) : otherTaken; } };
  const ui = await mount({ inflight: lying });
  other.end(handle, { kind: 'published', targetId: ID(6), providerPostId: '123', marks: REAL });
  await ui.flush();
  assert.equal(ui.state().result.kind, 'uncertain', 'the answer of an attempt it does not show is not applied');
  assert.equal(ui.state().result.code, 'SEND_STATE_LOST');
  assertNoSentClaim(ui);
});

test('P2-1: a record read late by an older screen while a RE-ASK is out is taken over as a re-ask', async () => {
  const SENTENCE = '前回と同じ内容・同じ送信IDで確認します';
  const stall = stallableKV();
  const realGet = stall.kv.getItem;
  const heldReads = [];
  stall.holdFirstRead = false;
  stall.kv.getItem = async (key) => {
    if (stall.holdFirstRead === true) { stall.holdFirstRead = false; await new Promise((resolve) => heldReads.push(resolve)); }
    return realGet(key);
  };
  stall.kv.data.set(realStore.storeKeyOf('U1'), JSON.stringify(RESTORED({ kind: 'pending', requestId: ID(1), contentSha256: sha('二度目') })));
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  stall.holdFirstRead = true;
  const slow = await mount({ ...TWO, port: fp, memory: realFlow.createAttemptMemory(), inflight, kv: stall.kv, draftKv: fakeKV(), sessionMark: 'T1' });
  assert.equal(slow.state().store.kind, 'loading');
  const memory = realFlow.createAttemptMemory();
  memory.mark('U1', { accountId: 'X_A', requestId: ID(1), contentSha256: sha('二度目'), text: '二度目', kind: 'pending' });
  const sender = await mount({ ...TWO, port: fp, memory, inflight, kv: stall.kv, draftKv: fakeKV(), sessionMark: 'T1' });
  await sender.press('同じ内容・同じ送信IDで確認し直す');
  await sender.tick();
  await sender.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 1, 'the re-ask is out');
  for (const resolve of heldReads.splice(0)) resolve();
  await slow.flush();
  assert.equal(slow.state().phase, 'sending');
  assert.equal(slow.state().retrying, true);
  assert.ok(slow.text().includes(SENTENCE));
  assert.equal(slow.button('同じ内容・同じ送信IDで確認し直す'), null);
  fp.pending[0].resolve({ targetId: ID(1), kind: 'published', providerPostId: '31', marks: REAL });
  await slow.flush();
  assert.equal(slow.state().result.kind, 'sent');
});

// ---- H1 C1 9th review, residual P2: a STALE read of the device record that comes back after the send has ended -------------------------------------------

/** A device storage whose read can be made to RETURN late: the value is read at once, but handed back only when the test lets it. */
function lateReadKV() {
  const kv = fakeKV();
  const realGet = kv.getItem;
  const ctl = { kv, holdNextReturn: false, held: [], failWhenReleased: false };
  kv.getItem = async (key) => {
    const value = await realGet(key);
    if (ctl.holdNextReturn) {
      ctl.holdNextReturn = false;
      await new Promise((resolve) => { ctl.held.push(resolve); });
      if (ctl.failWhenReleased) throw new Error('read failed late');
    }
    return value;
  };
  ctl.release = () => { for (const resolve of ctl.held.splice(0)) resolve(); };
  return ctl;
}

const SAME_TEXT = '同じ本文の二度目';

/** A reads and is ready; B is opened and its read of the (empty) record is held back; A sends and the send ENDS unresolved. */
async function staleNoneAfterEndedSend(answer) {
  const late = lateReadKV();
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  const draftKv = fakeKV();
  const a = await mount({ ...TWO, port: fp, memory, inflight, kv: late.kv, draftKv, sessionMark: 'T1' });
  late.holdNextReturn = true;
  const b = await mount({ ...TWO, port: fp, memory, inflight, kv: late.kv, draftKv, sessionMark: 'T1', idBase: 100 });
  assert.equal(b.state().store.kind, 'loading', 'B is still waiting for its (empty) snapshot of the record');
  await a.typeText(SAME_TEXT);
  await a.press('内容を確認する');
  await a.tick();
  await a.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 1);
  fp.pending[0].resolve({ targetId: ID(1), ...answer });
  await a.flush();
  return { late, memory, inflight, fp, draftKv, a, b };
}

/** What a person would do on a screen that offers an empty editor: type the same text, confirm, consent, send. */
async function tryToSendAgain(ui) {
  if (ui.state().phase !== 'editing') return;
  await ui.typeText(SAME_TEXT);
  if (!(await ui.press('内容を確認する'))) return;
  await ui.tick();
  if (ui.button('Xに投稿する') !== null) await ui.press('Xに投稿する');
}

const UNRESOLVED_ANSWERS = [
  ['uncertain / OFFLINE', { kind: 'uncertain', code: 'OFFLINE', marks: REAL }, 'uncertain'],
  ['pending', { kind: 'pending', code: 'IN_PROGRESS', marks: REAL }, 'pending'],
  ['unavailable', { kind: 'unavailable', code: 'TRANSPORT_FAILED' }, 'unconfirmed'],
  ['simulated (marks missing)', { kind: 'published', providerPostId: '1234567890' }, 'uncertain'],
];

test('STALE-NONE: an old "nothing on the device" that returns AFTER the send ended unresolved never lets the same user send again with another id', async () => {
  for (const [label, answer, resultKind] of UNRESOLVED_ANSWERS) {
    const { late, memory, fp, b } = await staleNoneAfterEndedSend(answer);
    assert.ok(memory.get('U1') !== null, `${label}: the attempt is unresolved in the memory`);
    late.release();
    await b.flush();
    await tryToSendAgain(b);
    assert.equal(fp.calls.send.length, 1, `${label}: ONE request in total -- the second screen cannot send another one`);
    assert.deepEqual(new Set(fp.calls.send.map((target) => target.targetId)), new Set([ID(1)]), label);
    assert.equal(b.state().phase, 'result', `${label}: it shows the unresolved attempt, not an empty editor`);
    assert.equal(b.state().result.kind, resultKind, label);
    assert.equal(b.state().unresolved.requestId, ID(1), label);
    assert.equal(b.button('内容を確認する'), null, `${label}: nothing new can be confirmed`);
    assertNoSentClaim(b);
  }
});

test('STALE-NONE: the common memory is not touched by the late "nothing", and the record on the device keeps the first attempt', async () => {
  const { late, memory, b } = await staleNoneAfterEndedSend({ kind: 'uncertain', code: 'OFFLINE', marks: REAL });
  late.release();
  await b.flush();
  await tryToSendAgain(b);
  assert.equal(memory.get('U1').requestId, ID(1));
  assert.equal(memory.get('U1').kind, 'uncertain');
  assert.equal(JSON.parse(late.kv.data.get(realStore.storeKeyOf('U1'))).requestId, ID(1));
});

test('STALE-LOADED: an old record returned late is shown only as far as the NEWER memory of this process allows -- the memory wins', async () => {
  const late = lateReadKV();
  late.kv.data.set(realStore.storeKeyOf('U1'), JSON.stringify(RESTORED({ kind: 'pending', requestId: ID(9), contentSha256: sha('older') })));
  late.holdNextReturn = true;
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  const b = await mount({ ...TWO, port: fp, memory, inflight, kv: late.kv, draftKv: fakeKV(), sessionMark: 'T1' });
  assert.equal(b.state().store.kind, 'loading');
  // meanwhile another screen of this process finished a NEWER attempt that is unresolved (the old record was acknowledged and replaced)
  memory.mark('U1', { accountId: 'X_A', requestId: ID(2), contentSha256: sha('newer'), text: 'newer', kind: 'uncertain' });
  late.kv.data.set(realStore.storeKeyOf('U1'), JSON.stringify(RESTORED({ kind: 'uncertain', requestId: ID(2), contentSha256: sha('newer') })));
  late.release();
  await b.flush();
  assert.equal(b.state().unresolved.requestId, ID(2), 'the newer attempt, not the old record');
  assert.equal(b.state().result.kind, 'uncertain');
  assert.equal(memory.get('U1').requestId, ID(2), 'the memory was not replaced by the old record');
  assert.equal(fp.calls.send.length, 0);
});

test('STALE-NONE: a late "nothing" after a PROVEN end is not over-blocked -- the user may write and send a new attempt', async () => {
  const { late, memory, fp, b } = await staleNoneAfterEndedSend({ kind: 'published', providerPostId: '5550001', marks: REAL });
  assert.equal(memory.get('U1'), null, 'a proven end leaves nothing unresolved');
  late.release();
  await b.flush();
  assert.equal(b.state().phase, 'editing');
  await tryToSendAgain(b);
  assert.equal(fp.calls.send.length, 2, 'the new attempt goes out');
  assert.equal(fp.calls.send[1].targetId, ID(101), 'with its own id');
});

test('STALE-NONE: after a "pending" end the other screen shows it and only a SAME-id re-ask is possible', async () => {
  const { late, fp, b } = await staleNoneAfterEndedSend({ kind: 'pending', code: 'IN_PROGRESS', marks: REAL });
  late.release();
  await b.flush();
  assert.equal(b.state().result.kind, 'pending');
  assert.equal(b.state().consent, null, 'no consent is carried to the other screen');
  assert.equal(b.state().result.requestId, ID(1));
  assert.equal(b.state().draft, SAME_TEXT, 'it shows the text of the attempt (memory of this process)');
  assert.ok(!late.kv.data.get(realStore.storeKeyOf('U1')).includes(SAME_TEXT), 'the record on the device stays hash-only');
  await b.press('同じ内容・同じ送信IDで確認し直す');
  await b.tick();
  await b.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 2, 'the re-ask');
  assert.equal(fp.calls.send[1].targetId, ID(1), 'with the SAME id');
});

test('STALE-NONE: several screens re-created after the late "nothing" all see the one unresolved attempt', async () => {
  const { late, memory, inflight, fp, draftKv, b } = await staleNoneAfterEndedSend({ kind: 'uncertain', code: 'OFFLINE', marks: REAL });
  late.release();
  await b.flush();
  b.unmount();
  const c = await mount({ ...TWO, port: fp, memory, inflight, kv: late.kv, draftKv, sessionMark: 'T2', idBase: 200 });
  assert.equal(c.state().result.kind, 'uncertain');
  assert.equal(c.state().unresolved.requestId, ID(1));
  await tryToSendAgain(c);
  assert.equal(fp.calls.send.length, 1);
});

test('STALE-NONE: another user\'s screen is not touched by this user\'s unresolved attempt', async () => {
  const late = lateReadKV();
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  const draftKv = fakeKV();
  const a = await mount({ ...TWO, port: fp, memory, inflight, kv: late.kv, draftKv, sessionMark: 'T1' });
  late.holdNextReturn = true;
  const other = await mount({ ...TWO, userId: 'U2', port: fp, memory, inflight, kv: late.kv, draftKv, sessionMark: 'T1', idBase: 300 });
  await a.typeText(SAME_TEXT);
  await a.press('内容を確認する');
  await a.tick();
  await a.press('Xに投稿する');
  fp.pending[0].resolve({ targetId: ID(1), kind: 'uncertain', code: 'OFFLINE', marks: REAL });
  await a.flush();
  late.release();
  await other.flush();
  assert.equal(other.state().phase, 'editing', 'U2 has nothing unresolved');
  assert.equal(other.state().unresolved, null);
  await tryToSendAgain(other);
  assert.equal(fp.calls.send.length, 2);
  assert.equal(fp.calls.send[1].targetId, ID(301), 'U2\'s own attempt');
});

test('STALE-NONE: a late failure of the read does not hide the unresolved attempt either', async () => {
  const { late, b } = await staleNoneAfterEndedSend({ kind: 'uncertain', code: 'OFFLINE', marks: REAL });
  late.failWhenReleased = true;
  late.release();
  await b.flush();
  assert.equal(b.state().result.kind, 'uncertain', 'the memory wins over a snapshot that could not even be read');
  assert.equal(b.state().store.kind, 'ready');
});

test('STALE-NONE: a screen that is opened while this process already knows an unresolved attempt shows it AT ONCE, without waiting for the device', async () => {
  const late = lateReadKV();
  late.holdNextReturn = true; // the device never answers during this test
  const memory = realFlow.createAttemptMemory();
  memory.mark('U1', { accountId: 'X_A', requestId: ID(4), contentSha256: sha('known'), text: 'known', kind: 'pending' });
  const ui = await mount({ ...TWO, memory, inflight: realFlow.createInFlightSends(), kv: late.kv, draftKv: fakeKV(), sessionMark: 'T1' });
  assert.equal(ui.state().store.kind, 'ready', 'no waiting for a snapshot of something the process already knows');
  assert.equal(ui.state().result.kind, 'pending');
  assert.equal(ui.state().unresolved.requestId, ID(4));
  assert.equal(ui.all('TextInput')[0]?.props.editable ?? false, false);
});

// ---- H1 C1 10th review, residual P2: an OLD "pending" confirmation must not re-ask an attempt that is uncertain NOW -----------------------------------

const TWO_SCREENS_TEXT = '二つの確認画面';

/** Two screens of one user and session, both in the confirmation of a re-ask of the same pending attempt. */
async function twoScreensConfirmingTheSameReAsk(userId = 'U1') {
  const memory = realFlow.createAttemptMemory();
  memory.mark(userId, { accountId: 'X_A', requestId: ID(1), contentSha256: sha(TWO_SCREENS_TEXT), text: TWO_SCREENS_TEXT, kind: 'pending' });
  const inflight = realFlow.createInFlightSends();
  const kv = fakeKV();
  kv.data.set(realStore.storeKeyOf(userId), JSON.stringify(RESTORED({ kind: 'pending', requestId: ID(1), contentSha256: sha(TWO_SCREENS_TEXT) })));
  const fp = fakePort();
  const a = await mount({ ...TWO, userId, port: fp, memory, inflight, kv, draftKv: fakeKV(), sessionMark: 'T1' });
  const b = await mount({ ...TWO, userId, port: fp, memory, inflight, kv, draftKv: fakeKV(), sessionMark: 'T1' });
  for (const ui of [a, b]) {
    assert.equal(ui.state().result.kind, 'pending');
    await ui.press('同じ内容・同じ送信IDで確認し直す');
    await ui.tick();
    assert.equal(ui.state().phase, 'confirming');
    assert.equal(ui.state().unresolved.kind, 'pending', 'both screens believe it is pending');
  }
  return { memory, inflight, kv, fp, a, b };
}

const NOT_RE_ASKABLE_ANSWERS = [
  ['uncertain / OFFLINE', { kind: 'uncertain', code: 'OFFLINE', marks: REAL }],
  ['published without marks (a test result, kept as uncertain)', { kind: 'published', providerPostId: '1234567890' }],
  ['a thrown port (SEND_THREW)', null],
];

test('LIVE-KIND: the other screen\'s re-ask ended UNCERTAIN -- the old "pending" confirmation cannot send again (port 1, not 2), and nothing is downgraded', async () => {
  for (const [label, answer] of NOT_RE_ASKABLE_ANSWERS) {
    const { memory, kv, fp, a, b } = await twoScreensConfirmingTheSameReAsk();
    await a.press('Xに投稿する');
    assert.equal(fp.calls.send.length, 1, `${label}: A's re-ask is out`);
    if (answer === null) fp.pending[0].reject(new Error('socket closed'));
    else fp.pending[0].resolve({ targetId: ID(1), ...answer });
    await a.flush();
    assert.equal(memory.get('U1').kind, 'uncertain', `${label}: the shared attempt is uncertain now`);
    const recordBefore = kv.data.get(realStore.storeKeyOf('U1'));
    await b.press('Xに投稿する'); // an ordinary tap on the button that was enabled when the page was drawn
    assert.equal(fp.calls.send.length, 1, `${label}: ONE request in total`);
    assert.equal(memory.get('U1').kind, 'uncertain', `${label}: the memory is not overwritten by a new in_flight`);
    assert.equal(memory.get('U1').requestId, ID(1));
    assert.equal(kv.data.get(realStore.storeKeyOf('U1')), recordBefore, `${label}: the record on the device is untouched`);
    assert.equal(b.state().result.kind, 'uncertain', `${label}: the old screen now shows what it is`);
    assert.equal(b.state().unresolved.kind, 'uncertain', `${label}: not downgraded to unconfirmed`);
    assert.equal(b.button('同じ内容・同じ送信IDで確認し直す'), null, `${label}: no re-ask is offered`);
    assertNoSentClaim(b);
  }
});

test('LIVE-KIND: the other screen\'s re-ask ended UNCONFIRMED or PENDING again -- the old confirmation is still a legitimate re-ask with the SAME id', async () => {
  for (const [label, answer, kind] of [
    ['unavailable (-> unconfirmed)', { kind: 'unavailable', code: 'TRANSPORT_FAILED' }, 'unconfirmed'],
    ['pending again', { kind: 'pending', code: 'IN_PROGRESS', marks: REAL }, 'pending'],
  ]) {
    const { memory, fp, a, b } = await twoScreensConfirmingTheSameReAsk();
    await a.press('Xに投稿する');
    fp.pending[0].resolve({ targetId: ID(1), ...answer });
    await a.flush();
    assert.equal(memory.get('U1').kind, kind, label);
    await b.press('Xに投稿する');
    assert.equal(fp.calls.send.length, 2, `${label}: the second re-ask goes out`);
    assert.equal(fp.calls.send[1].targetId, ID(1), `${label}: with the SAME id`);
    assert.equal(b.state().phase, 'sending', label);
    fp.pending[1].resolve({ targetId: ID(1), kind: 'published', providerPostId: '4242', marks: REAL });
    await b.flush();
    assert.equal(b.state().result.kind, 'sent', label);
  }
});

test('LIVE-KIND: the refused screen shows the same as a screen opened later; the record on the device keeps hash-only and no consent is carried', async () => {
  const { memory, inflight, kv, fp, a, b } = await twoScreensConfirmingTheSameReAsk();
  await a.press('Xに投稿する');
  fp.pending[0].resolve({ targetId: ID(1), kind: 'uncertain', code: 'OFFLINE', marks: REAL });
  await a.flush();
  await b.press('Xに投稿する');
  const fresh = await mount({ ...TWO, port: fp, memory, inflight, kv, draftKv: fakeKV(), sessionMark: 'T1' });
  for (const key of ['phase', 'draft', 'accountId', 'requestId']) assert.deepEqual(b.state()[key], fresh.state()[key], key);
  assert.deepEqual(b.state().result, fresh.state().result);
  assert.deepEqual(b.state().unresolved, fresh.state().unresolved);
  assert.equal(b.state().consent, null);
  assert.ok(!kv.data.get(realStore.storeKeyOf('U1')).includes(TWO_SCREENS_TEXT), 'hash-only');
  assert.equal(fp.calls.send.length, 1);
});

test('LIVE-KIND: a screen that started a FRESH attempt and is refused keeps its typed text (nothing is resynced over it)', async () => {
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  const ui = await mount({ ...TWO, port: fp, memory, inflight, kv: fakeKV(), draftKv: fakeKV(), sessionMark: 'T1' });
  await ui.typeText('新しく書いた本文');
  await ui.press('内容を確認する');
  await ui.tick();
  // another screen of this user leaves an unresolved attempt after this one was drawn
  memory.mark('U1', { accountId: 'X_A', requestId: ID(9), contentSha256: sha('他の試行'), text: '他の試行', kind: 'uncertain' });
  await ui.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 0, 'nothing is sent');
  assert.equal(ui.state().result.kind, 'refused');
  assert.equal(ui.state().result.code, 'LOCAL_UNRESOLVED_ATTEMPT');
  assert.equal(ui.state().draft, '新しく書いた本文', 'the typed text is still there');
  assert.equal(memory.get('U1').requestId, ID(9), 'the other attempt is untouched');
  assertNoSentClaim(ui);
});

test('LIVE-KIND: another user and another account are not touched by the uncertain attempt of this user', async () => {
  const { memory, inflight, fp, a } = await twoScreensConfirmingTheSameReAsk();
  await a.press('Xに投稿する');
  fp.pending[0].resolve({ targetId: ID(1), kind: 'uncertain', code: 'OFFLINE', marks: REAL });
  await a.flush();
  const other = await mount({ ...TWO, userId: 'U2', port: fp, memory, inflight, kv: fakeKV(), draftKv: fakeKV(), sessionMark: 'T1', idBase: 500 });
  await other.typeText('別のユーザーの本文');
  await other.press('内容を確認する');
  await other.tick();
  await other.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 2, 'U2 sends its own attempt');
  assert.equal(fp.calls.send[1].targetId, ID(501));
  assert.equal(memory.get('U1').kind, 'uncertain');
});

test('LIVE-KIND: the same holds for any user id -- the old confirmation of user U7 is brought to the attempt of U7, not to another user\'s', async () => {
  const { memory, fp, a, b } = await twoScreensConfirmingTheSameReAsk('U7');
  memory.mark('U1', { accountId: 'X_A', requestId: ID(77), contentSha256: sha('他人'), text: '他人', kind: 'uncertain' });
  await a.press('Xに投稿する');
  fp.pending[0].resolve({ targetId: ID(1), kind: 'uncertain', code: 'OFFLINE', marks: REAL });
  await a.flush();
  await b.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 1);
  assert.equal(b.state().unresolved.requestId, ID(1), 'its own attempt');
  assert.equal(b.state().result.kind, 'uncertain');
});

// ---- H1 C1 11th review, P2: the acknowledge of an OLD result screen must not erase the record of a send that is out -----------------------------------

const ACK_TEXT = '送信中に確認される本文';
const ACK_LABEL = 'Xで確認しました（この下書きを破棄）';

/** A device storage whose removal can be held back and whose writes are logged, to see what is on the device at any moment. */
function removalKV() {
  const kv = fakeKV();
  const realRemove = kv.removeItem;
  const ctl = { kv, holdRemove: false, held: [], removed: 0 };
  kv.removeItem = async (key) => {
    if (ctl.holdRemove) { ctl.holdRemove = false; await new Promise((resolve) => { ctl.held.push(resolve); }); }
    ctl.removed += 1;
    return realRemove(key);
  };
  ctl.release = () => { for (const resolve of ctl.held.splice(0)) resolve(); };
  return ctl;
}

/** Screens A and B of one user and session, both showing the same pending attempt R1 (memory and device record agree). */
async function twoScreensShowingTheSamePending(userId = 'U1') {
  const device = removalKV();
  const memory = realFlow.createAttemptMemory();
  memory.mark(userId, { accountId: 'X_A', requestId: ID(1), contentSha256: sha(ACK_TEXT), text: ACK_TEXT, kind: 'pending' });
  const inflight = realFlow.createInFlightSends();
  device.kv.data.set(realStore.storeKeyOf(userId), JSON.stringify(RESTORED({ kind: 'pending', requestId: ID(1), contentSha256: sha(ACK_TEXT) })));
  const fp = fakePort();
  const a = await mount({ ...TWO, userId, port: fp, memory, inflight, kv: device.kv, draftKv: fakeKV(), sessionMark: 'T1' });
  const b = await mount({ ...TWO, userId, port: fp, memory, inflight, kv: device.kv, draftKv: fakeKV(), sessionMark: 'T1', idBase: 100 });
  for (const ui of [a, b]) assert.equal(ui.state().result.kind, 'pending');
  return { device, memory, inflight, fp, a, b, userId };
}

async function aStartsTheReAsk(a) {
  await a.press('同じ内容・同じ送信IDで確認し直す');
  await a.tick();
  await a.press('Xに投稿する');
}

test('ACK-INFLIGHT: the old result screen\'s acknowledge does not erase the record or the memory of the re-ask that is out', async () => {
  const { device, memory, inflight, fp, a, b } = await twoScreensShowingTheSamePending();
  await aStartsTheReAsk(a);
  assert.equal(fp.calls.send.length, 1, 'A\'s re-ask is out');
  assert.equal(inflight.isOut('U1', ID(1)), true);
  await b.press(ACK_LABEL); // an ordinary tap on the button B shows
  const record = device.kv.data.get(realStore.storeKeyOf('U1'));
  assert.ok(record !== undefined, 'the record of the send that is out is still on the device');
  assert.equal(JSON.parse(record).kind, 'in_flight');
  assert.equal(JSON.parse(record).requestId, ID(1));
  assert.ok(memory.get('U1') !== null, 'the memory still knows the attempt');
  assert.equal(inflight.isOut('U1', ID(1)), true, 'the send is still out');
  assert.notEqual(b.state().phase, 'editing', 'the screen is not released to an empty editor');
  assert.ok(b.state().unresolved !== null, 'it still shows an unresolved attempt');
});

test('ACK-INFLIGHT (cold start): after the old screen\'s acknowledge, a restart cannot send ANOTHER id while the first request is still on its way', async () => {
  const { device, fp, a, b } = await twoScreensShowingTheSamePending();
  await aStartsTheReAsk(a);
  assert.equal(fp.calls.send.length, 1, 'A\'s re-ask is out');
  await b.press(ACK_LABEL);
  // the app is closed before the answer: a new process reads the same device (its own memory and registry), the request is still on its way
  const cold = await mount({ ...TWO, port: fp, memory: realFlow.createAttemptMemory(), inflight: realFlow.createInFlightSends(), kv: device.kv, draftKv: fakeKV(), sessionMark: 'T9', idBase: 200 });
  await tryToSendAgain(cold);
  assert.equal(fp.calls.send.length, 1, 'no other request can be started after a restart');
  assert.equal(cold.state().result.kind, 'unconfirmed');
});

test('ACK-INFLIGHT: an acknowledge that is still clearing cannot be overtaken by a send that starts meanwhile (the reverse order)', async () => {
  const { device, memory, inflight, fp, a, b } = await twoScreensShowingTheSamePending();
  await a.press('同じ内容・同じ送信IDで確認し直す');
  await a.tick();
  device.holdRemove = true;
  device.holdRemove = true;
  void b.button(ACK_LABEL).props.onPress(); // B's acknowledge starts clearing and is held on the device
  await b.flush();
  await a.press('Xに投稿する'); // A's re-ask starts while the clear is not finished
  const outstanding = fp.calls.send.length - fp.pending.filter((p) => p.settled === true).length;
  const recordNow = device.kv.data.get(realStore.storeKeyOf('U1'));
  device.release();
  await b.flush();
  await a.flush();
  const recordAfter = device.kv.data.get(realStore.storeKeyOf('U1'));
  if (fp.calls.send.length > 0) assert.ok(recordAfter !== undefined, 'a request is on the wire, so its record must be on the device');
  assert.equal(fp.calls.send.length, 0, 'the send did not start while the acknowledge was clearing');
  assert.ok(outstanding >= 0 && (recordNow === undefined || recordNow !== null));
  assert.ok(memory !== null && inflight !== null);
});

test('ACK-INFLIGHT: the refused screen waits for the re-ask that is out and shows ITS answer; nothing is released to an empty editor', async () => {
  const { memory, fp, a, b } = await twoScreensShowingTheSamePending();
  await aStartsTheReAsk(a);
  await b.press(ACK_LABEL);
  assert.equal(b.state().phase, 'sending', 'B follows the send that is out');
  assert.ok(!b.text().includes('記録を消去できませんでした'), 'a refusal is not a failed clear');
  assert.equal(b.state().retrying, true);
  assert.equal(b.button(ACK_LABEL), null, 'nothing to acknowledge while it is out');
  assert.equal(b.button('同じ内容・同じ送信IDで確認し直す'), null);
  fp.pending[0].resolve({ targetId: ID(1), kind: 'uncertain', code: 'OFFLINE', marks: REAL });
  await b.flush();
  await a.flush();
  assert.equal(b.state().result.kind, 'uncertain');
  assert.equal(memory.get('U1').kind, 'uncertain');
  assert.equal(fp.calls.send.length, 1);
});

test('ACK-INFLIGHT: after the send ended, the same acknowledge works -- the record and the memory are cleared and the editor is empty', async () => {
  const { device, memory, fp, a, b } = await twoScreensShowingTheSamePending();
  await aStartsTheReAsk(a);
  fp.pending[0].resolve({ targetId: ID(1), kind: 'published', providerPostId: '8675309', marks: REAL });
  await a.flush();
  assert.equal(memory.get('U1'), null, 'a proven end leaves nothing unresolved');
  const single = await twoScreensShowingTheSamePending('U5');
  await single.b.press(ACK_LABEL);
  assert.equal(single.b.state().phase, 'editing');
  assert.equal(single.b.state().unresolved, null);
  assert.equal(single.memory.get('U5'), null);
  assert.equal(single.device.kv.data.has(realStore.storeKeyOf('U5')), false);
  assert.equal(b.state().result.kind, 'pending', 'B is not changed by the answer of A (it shows the earlier result until it looks again)');
  assert.ok(device.kv.data.size === 0, 'the device holds nothing after the proven end');
});

test('ACK-INFLIGHT: an OLD result screen\'s acknowledge cannot erase a NEWER unresolved attempt -- it is brought to the newer one', async () => {
  const { device, memory, b } = await twoScreensShowingTheSamePending();
  memory.mark('U1', { accountId: 'X_A', requestId: ID(2), contentSha256: sha('newer'), text: 'newer', kind: 'uncertain' });
  device.kv.data.set(realStore.storeKeyOf('U1'), JSON.stringify(RESTORED({ kind: 'uncertain', requestId: ID(2), contentSha256: sha('newer') })));
  await b.press(ACK_LABEL);
  assert.equal(memory.get('U1').requestId, ID(2), 'the newer attempt is still known');
  assert.equal(JSON.parse(device.kv.data.get(realStore.storeKeyOf('U1'))).requestId, ID(2), 'and its record is still on the device');
  assert.equal(b.state().unresolved.requestId, ID(2));
  assert.equal(b.state().result.kind, 'uncertain');
  assert.equal(b.state().phase, 'result', 'not an empty editor');
  assert.ok(!b.text().includes('記録を消去できませんでした'), 'a refusal is not a failed clear');
});

test('ACK-INFLIGHT: a record that cannot be removed keeps the screen where it is and says so; another user\'s acknowledge touches nothing of this user', async () => {
  const { device, memory, a, b } = await twoScreensShowingTheSamePending();
  device.kv.fail.remove = true;
  await b.press(ACK_LABEL);
  assert.equal(b.state().phase, 'result');
  assert.equal(b.state().unresolved.requestId, ID(1));
  assert.ok(b.text().includes('記録を消去できませんでした。送信は引き続きできません。'), 'it says so');
  assert.equal(memory.get('U1').requestId, ID(1));
  device.kv.fail.remove = false;
  const other = await twoScreensShowingTheSamePending('U6');
  await other.b.press(ACK_LABEL);
  assert.equal(memory.get('U1').requestId, ID(1), 'U1 is untouched by the acknowledge of U6');
  assert.ok(device.kv.data.has(realStore.storeKeyOf('U1')));
  assert.equal(a.state().unresolved.requestId, ID(1));
});

test('ACK-INFLIGHT: the refusal follows the send of the screen\'s OWN user (any user id), and the answer reaches the screen', async () => {
  const { memory, fp, a, b } = await twoScreensShowingTheSamePending('U6');
  memory.mark('U1', { accountId: 'X_A', requestId: ID(55), contentSha256: sha('他人'), text: '他人', kind: 'uncertain' });
  await aStartsTheReAsk(a);
  await b.press(ACK_LABEL);
  assert.equal(b.state().phase, 'sending');
  assert.equal(b.state().requestId, ID(1));
  fp.pending[0].resolve({ targetId: ID(1), kind: 'published', providerPostId: '31337', marks: REAL });
  await b.flush();
  assert.equal(b.state().result.kind, 'sent');
  assert.equal(memory.get('U1').requestId, ID(55), 'another user\'s attempt is untouched');
});

test('ACK-INFLIGHT: the stale refusal brings the screen to the attempt of ITS OWN user (any user id)', async () => {
  const { device, memory, b } = await twoScreensShowingTheSamePending('U6');
  memory.mark('U1', { accountId: 'X_A', requestId: ID(55), contentSha256: sha('他人'), text: '他人', kind: 'uncertain' });
  memory.mark('U6', { accountId: 'X_A', requestId: ID(2), contentSha256: sha('newer'), text: 'newer', kind: 'uncertain' });
  await b.press(ACK_LABEL);
  assert.equal(b.state().unresolved.requestId, ID(2), 'U6\'s newer attempt, not another user\'s');
  assert.equal(b.state().result.kind, 'uncertain');
  assert.ok(device.kv.data.has(realStore.storeKeyOf('U6')), 'nothing was cleared');
});

// ---- post-acknowledge: an OLD re-ask confirmation must not send the acknowledged attempt again ---------------------------------------------------------

test('POST-ACK: A acknowledged the attempt (record and memory gone) -- B\'s old re-ask confirmation sends NOTHING, and B is not left believing it is unresolved', async () => {
  const { device, memory, fp, a, b } = await twoScreensShowingTheSamePending();
  await b.press('同じ内容・同じ送信IDで確認し直す');
  await b.tick();
  assert.equal(b.state().phase, 'confirming', 'B holds the old re-ask confirmation');
  await a.press(ACK_LABEL);
  assert.equal(a.state().phase, 'editing', 'A acknowledged normally');
  assert.equal(memory.get('U1'), null);
  assert.equal(device.kv.data.has(realStore.storeKeyOf('U1')), false);
  await b.press('Xに投稿する'); // the button B shows is still enabled
  assert.equal(fp.calls.send.length, 0, 'the acknowledged attempt is not sent again from the old screen');
  assert.equal(memory.get('U1'), null, 'the memory stays empty (no new in_flight)');
  assert.equal(device.kv.data.has(realStore.storeKeyOf('U1')), false, 'nothing is written to the device');
  assert.notEqual(b.state().phase, 'sending');
  assert.equal(b.state().unresolved, null, 'B does not keep a re-askable attempt that no longer exists');
  assert.equal(b.button('同じ内容・同じ送信IDで確認し直す'), null);
  assert.equal(b.state().consent, null, 'no consent is carried');
  assertNoSentClaim(b);
});

const CLEARED_NOTE = 'この送信記録は別の画面で確認済み（または完了）になっていたため、送信しませんでした。Xのプロフィールで投稿を確認してください。';

test('POST-ACK: the dropped screen says why nothing was sent, offers an empty editor, and a NEW attempt from it goes out with a new id', async () => {
  const { fp, a, b } = await twoScreensShowingTheSamePending();
  await b.press('同じ内容・同じ送信IDで確認し直す');
  await b.tick();
  await a.press(ACK_LABEL);
  await b.press('Xに投稿する');
  assert.equal(b.state().phase, 'editing');
  assert.equal(b.state().draft, '', 'no old text is kept');
  assert.ok(b.text().includes(CLEARED_NOTE), 'it says why');
  await b.typeText('確認後の新しい本文');
  await b.press('内容を確認する');
  await b.tick();
  await b.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 1, 'a new attempt is a normal send');
  assert.equal(fp.calls.send[0].targetId, ID(101), 'with a new id');
  assert.ok(!b.text().includes(CLEARED_NOTE), 'the note is gone once a new send starts');
});

test('POST-ACK: after the acknowledge, another screen started a NEW attempt -- the old re-ask is brought to the new attempt, not sent', async () => {
  const { memory, fp, a, b } = await twoScreensShowingTheSamePending();
  await b.press('同じ内容・同じ送信IDで確認し直す');
  await b.tick();
  await a.press(ACK_LABEL);
  memory.mark('U1', { accountId: 'X_A', requestId: ID(2), contentSha256: sha('次の試行'), text: '次の試行', kind: 'pending' });
  await b.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 0);
  assert.equal(b.state().unresolved.requestId, ID(2), 'the attempt the process knows now');
  assert.equal(b.state().result.kind, 'pending');
  assert.equal(memory.get('U1').requestId, ID(2), 'untouched');
});

test('POST-ACK: a re-ask pressed while the acknowledge is still clearing, and again after it finished -- nothing is ever sent', async () => {
  const { device, memory, fp, a, b } = await twoScreensShowingTheSamePending();
  await b.press('同じ内容・同じ送信IDで確認し直す');
  await b.tick();
  device.holdRemove = true;
  a.button(ACK_LABEL).props.onPress();
  await a.flush();
  await b.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 0, 'not while the clear runs');
  device.release();
  await a.flush();
  await b.flush();
  assert.equal(memory.get('U1'), null);
  if (b.button('同じ内容・同じ送信IDで確認し直す') !== null) {
    await b.press('同じ内容・同じ送信IDで確認し直す');
    await b.tick();
    await b.press('Xに投稿する');
  }
  assert.equal(fp.calls.send.length, 0, 'not after it finished either');
  assert.equal(device.kv.data.has(realStore.storeKeyOf('U1')), false);
  assert.equal(memory.get('U1'), null);
});

test('POST-ACK: the same holds for any user id, and the acknowledge of one user never drops another user\'s re-ask', async () => {
  const u7 = await twoScreensShowingTheSamePending('U7');
  await u7.b.press('同じ内容・同じ送信IDで確認し直す');
  await u7.b.tick();
  u7.memory.mark('U1', { accountId: 'X_A', requestId: ID(1), contentSha256: sha(ACK_TEXT), text: ACK_TEXT, kind: 'pending' });
  await u7.a.press(ACK_LABEL);
  assert.equal(u7.memory.get('U1').requestId, ID(1), 'U1 is untouched by U7\'s acknowledge');
  await u7.b.press('Xに投稿する');
  assert.equal(u7.fp.calls.send.length, 0, 'U7\'s acknowledged attempt is not sent');
  assert.equal(u7.b.state().phase, 'editing');
  const other = await twoScreensShowingTheSamePending('U8');
  await other.b.press('同じ内容・同じ送信IDで確認し直す');
  await other.b.tick();
  await other.b.press('Xに投稿する');
  assert.equal(other.fp.calls.send.length, 1, 'U8 was not acknowledged: its re-ask goes out');
  assert.equal(other.fp.calls.send[0].targetId, ID(1));
});

test('POST-ACK: a legitimate re-ask after a restart (text-less record, retyped text) still goes out with the same id', async () => {
  const kv = deviceWith(RESTORED({ kind: 'pending', requestId: ID(9), contentSha256: sha('earlier text') }));
  const fp = fakePort();
  const ui = await mount({ kv, port: fp, memory: realFlow.createAttemptMemory(), inflight: realFlow.createInFlightSends() });
  assert.equal(ui.state().result.kind, 'pending');
  await ui.press('前回と同じ本文を入力して確認し直す');
  await ui.typeText('earlier text');
  await ui.tick();
  await ui.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 1);
  assert.equal(fp.calls.send[0].targetId, ID(9), 'the SAME id as the record');
});

// ---- H1 C1 13th review, P2: a read of the device record that began BEFORE an acknowledge must not bring the attempt back after it -------------------------

const DELAYED_TEXT = '確認済みになる本文';
const RESTORED_ACK_LABEL = 'Xで確認しました（この記録を破棄）';
const RESTORED_REASK_LABEL = '前回と同じ本文を入力して確認し直す';

/**
 * After a restart: the device holds the pending attempt R1 (hash only), the memory is empty. Screen L starts its first read and
 * the snapshot (R1 found) is held back; screen A reads normally and shows R1 (the memory now knows it). Optionally screen B opens
 * from the memory and holds a confirmed re-ask of R1.
 */
async function delayedReadBeforeAcknowledge({ withB = false, userId = 'U1' } = {}) {
  const late = lateReadKV();
  late.kv.data.set(realStore.storeKeyOf(userId), JSON.stringify(RESTORED({ kind: 'pending', requestId: ID(1), contentSha256: sha(DELAYED_TEXT) })));
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  late.holdNextReturn = true;
  const l = await mount({ ...TWO, userId, port: fp, memory, inflight, kv: late.kv, draftKv: fakeKV(), sessionMark: 'T1', idBase: 300 });
  assert.equal(l.state().store.kind, 'loading', 'L holds an old snapshot of R1');
  const a = await mount({ ...TWO, userId, port: fp, memory, inflight, kv: late.kv, draftKv: fakeKV(), sessionMark: 'T1' });
  assert.equal(a.state().result.kind, 'pending');
  assert.equal(memory.get(userId).requestId, ID(1));
  let b = null;
  if (withB) {
    b = await mount({ ...TWO, userId, port: fp, memory, inflight, kv: late.kv, draftKv: fakeKV(), sessionMark: 'T1', idBase: 100 });
    await b.press(RESTORED_REASK_LABEL);
    await b.typeText(DELAYED_TEXT);
    await b.tick();
    assert.equal(b.state().phase, 'confirming', 'B holds a confirmed re-ask of R1');
  }
  await a.press(RESTORED_ACK_LABEL);
  assert.equal(memory.get(userId), null, 'A acknowledged: the memory is empty');
  assert.equal(late.kv.data.has(realStore.storeKeyOf(userId)), false, 'and the device holds nothing');
  late.release(); // the old snapshot of L arrives only now
  await l.flush();
  return { late, memory, inflight, fp, l, a, b, userId };
}

test('DELAYED-READ (2 screens): an old snapshot that arrives after the acknowledge does not bring R1 back -- memory empty, device empty, nothing re-askable', async () => {
  const { late, memory, fp, l, userId } = await delayedReadBeforeAcknowledge();
  assert.equal(memory.get(userId), null, 'R1 is not put back into the memory');
  assert.equal(late.kv.data.has(realStore.storeKeyOf(userId)), false);
  // what a person on L would do if R1 were offered again
  if (l.button(RESTORED_REASK_LABEL) !== null) {
    await l.press(RESTORED_REASK_LABEL);
    await l.typeText(DELAYED_TEXT);
    await l.tick();
    if (l.button('Xに投稿する') !== null) await l.press('Xに投稿する');
  }
  assert.equal(fp.calls.send.length, 0, 'the acknowledged attempt is not sent again');
  assert.equal(late.kv.data.has(realStore.storeKeyOf(userId)), false, 'nothing written');
  assert.equal(l.state().unresolved, null, 'L does not show the acknowledged attempt');
  assert.equal(l.state().store.kind, 'ready');
});

test('DELAYED-READ (3 screens): B\'s confirmed re-ask of R1 sends nothing after A\'s acknowledge, even when L\'s old snapshot arrives first', async () => {
  const { late, memory, fp, b, userId } = await delayedReadBeforeAcknowledge({ withB: true });
  await b.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 0, 'the acknowledged attempt is not sent again');
  assert.equal(memory.get(userId), null);
  assert.equal(late.kv.data.has(realStore.storeKeyOf(userId)), false);
  assert.equal(b.state().unresolved, null);
});

test('DELAYED-READ: after the old snapshot was dropped, L is a normal empty editor -- a NEW attempt from it goes out with a new id', async () => {
  const { fp, l } = await delayedReadBeforeAcknowledge();
  assert.equal(l.state().phase, 'editing');
  await l.typeText('確認後に書いた新しい本文');
  await l.press('内容を確認する');
  await l.tick();
  await l.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 1);
  assert.equal(fp.calls.send[0].targetId, ID(301), 'a new id, not R1');
});

test('DELAYED-READ: the snapshot arrives while the acknowledge is still clearing -- L shows R1 for now, but its re-ask after the clear sends nothing', async () => {
  const late = lateReadKV();
  late.kv.data.set(realStore.storeKeyOf('U1'), JSON.stringify(RESTORED({ kind: 'pending', requestId: ID(1), contentSha256: sha(DELAYED_TEXT) })));
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  late.holdNextReturn = true;
  const l = await mount({ ...TWO, port: fp, memory, inflight, kv: late.kv, draftKv: fakeKV(), sessionMark: 'T1', idBase: 300 });
  const a = await mount({ ...TWO, port: fp, memory, inflight, kv: late.kv, draftKv: fakeKV(), sessionMark: 'T1' });
  const realRemove = late.kv.removeItem;
  const removals = [];
  late.kv.removeItem = async (key) => { await new Promise((resolve) => { removals.push(resolve); }); return realRemove(key); };
  a.button(RESTORED_ACK_LABEL).props.onPress(); // the clear starts and is held
  await a.flush();
  late.release(); // L's old snapshot arrives while the clear runs
  await l.flush();
  assert.equal(l.state().unresolved.requestId, ID(1), 'R1 is still the attempt of the process for now');
  for (const resolve of removals.splice(0)) resolve();
  await a.flush();
  assert.equal(memory.get('U1'), null, 'the acknowledge finished');
  await l.press(RESTORED_REASK_LABEL);
  await l.typeText(DELAYED_TEXT);
  await l.tick();
  if (l.button('Xに投稿する') !== null) await l.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 0, 'the acknowledged attempt is not sent again');
  assert.equal(memory.get('U1'), null);
  assert.equal(late.kv.data.has(realStore.storeKeyOf('U1')), false);
});

test('DELAYED-READ: R1 acknowledged and a NEW attempt R2 begun before L\'s old snapshot arrives -- L shows R2, never R1', async () => {
  const late = lateReadKV();
  late.kv.data.set(realStore.storeKeyOf('U1'), JSON.stringify(RESTORED({ kind: 'pending', requestId: ID(1), contentSha256: sha(DELAYED_TEXT) })));
  const memory = realFlow.createAttemptMemory();
  const inflight = realFlow.createInFlightSends();
  const fp = fakePort();
  late.holdNextReturn = true;
  const l = await mount({ ...TWO, port: fp, memory, inflight, kv: late.kv, draftKv: fakeKV(), sessionMark: 'T1', idBase: 300 });
  const a = await mount({ ...TWO, port: fp, memory, inflight, kv: late.kv, draftKv: fakeKV(), sessionMark: 'T1', idBase: 500 });
  await a.press(RESTORED_ACK_LABEL);
  await a.typeText('次の本文');
  await a.press('内容を確認する');
  await a.tick();
  await a.press('Xに投稿する');
  fp.pending[0].resolve({ targetId: ID(501), kind: 'pending', code: 'IN_PROGRESS', marks: REAL });
  await a.flush();
  assert.equal(memory.get('U1').requestId, ID(501));
  late.release();
  await l.flush();
  assert.equal(l.state().unresolved.requestId, ID(501), 'the newer attempt');
  assert.equal(memory.get('U1').requestId, ID(501), 'R1 never comes back');
});

test('DELAYED-READ: the same for any user id, and another user\'s acknowledge never drops this user\'s restored attempt', async () => {
  const u7 = await delayedReadBeforeAcknowledge({ withB: true, userId: 'U7' });
  await u7.b.press('Xに投稿する');
  assert.equal(u7.fp.calls.send.length, 0);
  assert.equal(u7.memory.get('U7'), null);
  const late = lateReadKV();
  late.kv.data.set(realStore.storeKeyOf('U9'), JSON.stringify(RESTORED({ kind: 'pending', requestId: ID(9), contentSha256: sha(DELAYED_TEXT) })));
  const memory = realFlow.createAttemptMemory();
  late.holdNextReturn = true;
  const l9 = await mount({ ...TWO, userId: 'U9', memory, inflight: realFlow.createInFlightSends(), kv: late.kv, draftKv: fakeKV(), sessionMark: 'T1' });
  memory.mark('U1', { accountId: 'X_A', requestId: ID(1), contentSha256: sha('x'), text: 'x', kind: 'pending' });
  memory.clear('U1');
  late.release();
  await l9.flush();
  assert.equal(l9.state().unresolved.requestId, ID(9), 'U9\'s restored attempt is shown');
  assert.equal(memory.get('U9').requestId, ID(9));
});
