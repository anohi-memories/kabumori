// F1 manual X single post: the REAL route file (src/app/manual-publish.tsx, transpiled) driven with stubbed
// React / React Native / providers and fake send ports. Proves the wiring, not only the pure model:
// what the user is shown, that the send stays impossible without a fresh account-bound `ready` answer, that a
// double tap sends once, that an unknown outcome is never presented as sent, and that nothing leaks across
// accounts or users. Offline: no network, no secret, no X post.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as model from '../src/features/manual-publish/manual-publish-model.ts';
import * as realFlow from '../src/features/manual-publish/manual-publish-flow.ts';
import * as realPort from '../src/features/manual-publish/manual-publish-port.ts';

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
    'react-native': { Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    'expo-router': { Link: 'Link', Stack: { Screen: 'StackScreen' } },
    'expo-crypto': { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    '@/constants/theme': { colors: new Proxy({}, { get: (_t, name) => String(name) }), spacing: { xs: 6, sm: 10, md: 16, lg: 22, xl: 32 } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: { muted: true } } },
    '@/features/manual-publish/manual-post-preview': { ManualPostPreview: 'ManualPostPreview' },
    '@/features/manual-publish/manual-publish-flow': { ...realFlow, attemptMemory: world.memory },
    '@/features/manual-publish/manual-publish-model': model,
    '@/features/manual-publish/manual-publish-port': { ...realPort, getManualPublishPort: () => world.port },
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: world.accounts, activeAccount: world.accounts.find((a) => a.id === world.active) ?? null }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.userId === null ? null : { user: { id: world.userId } } }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status, reason: null, snapshot: null }) },
  };
  const source = await readFile(new URL('../src/app/manual-publish.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, Promise, Date, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: 'manual-publish.tsx' });
  return { mod, slots, getCursor: () => cursor, setCursor: (v) => { cursor = v; }, pendingEffects };
}

async function mount({ status = 'ready', userId = 'U1', accounts = [account('X_A')], active = 'X_A', port = fakePort(), memory = realFlow.createAttemptMemory(), clock = { t: 100_000 } } = {}) {
  const world = { status, userId, accounts, active, port: port.port, memory };
  const rt = await loadRoute(world);
  let ids = 0;
  // Stable function identities, like the real defaults (Date.now / a module function): unstable ones would re-run the effects.
  const nowFn = () => clock.t;
  const idFn = () => `req-${++ids}`;
  const props = () => ({ userId: world.userId, now: nowFn, newRequestId: idFn });
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
    world, port, clock, rt, flush, unmount,
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
  assert.ok(t.includes(model.SEND_BLOCK_MESSAGES.port_not_connected));
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  assert.equal(await ui.press('Xに投稿する'), false);
  await ui.pressIgnoringDisabled('Xに投稿する'); // even a forced press must not send or change anything
  assert.equal(ui.state().phase, 'confirming');
  assertNoSentClaim(ui);
  // Going back works and a new confirmation asks again.
  await ui.press('編集に戻る');
  assert.equal(ui.state().phase, 'editing');
  assert.equal(ui.state().draft, 'こんにちは');
});

test('a cached "connected" account is not enough: with readiness not_connected the send never reaches the port', async () => {
  const fp = fakePort({ readiness: { kind: 'not_connected' } });
  const ui = await mount({ port: fp, accounts: [account('X_A', { connectionStatus: 'connected' })] });
  await ui.typeText('hi');
  await ui.press('内容を確認する');
  await ui.pressIgnoringDisabled('Xに投稿する');
  assert.deepEqual(fp.calls.check, ['X_A']);
  assert.equal(fp.calls.send.length, 0);
});

test('demo (mock_preview) data gets the same gate: no readiness, no send', async () => {
  const fp = fakePort({ readiness: { kind: 'not_connected' } });
  const ui = await mount({ status: 'mock_preview', port: fp });
  await ui.typeText('hi');
  await ui.press('内容を確認する');
  assert.equal(ui.button('Xに投稿する').props.disabled, true);
  assert.equal(fp.calls.send.length, 0);
});

test('signed out: the send is blocked even with a ready port', async () => {
  const fp = fakePort();
  const ui = await mount({ port: fp, userId: null });
  await ui.typeText('hi');
  await ui.press('内容を確認する');
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
  assert.equal(fp.calls.send[0].targetId, 'req-1');
  assert.equal(fp.calls.send[0].connectedAccountId, 'X_A');
  assert.equal(fp.calls.send[0].renderedText, 'こんにちは');
  assert.equal(ui.state().phase, 'sending');
  assert.equal(ui.button('送信中…').props.disabled, true);
  assert.equal(ui.button('編集に戻る').props.disabled, true);
  assertNoSentClaim(ui);
  await ui.pressIgnoringDisabled('送信中…');
  assert.equal(fp.calls.send.length, 1, 'still one');
});

test('published is the only road to "sent"; the text then shows the provider post id and no invented reconciliation', async () => {
  const { ui, fp } = await readyConfirmation();
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ kind: 'published', targetId: 'req-1', providerPostId: '1234567890' });
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
  fp.pending[0].resolve({ kind: 'rejected', targetId: 'req-1', code: 'X_REJECTED_403' });
  await ui.flush();
  const t = ui.text();
  assert.ok(t.includes('投稿されませんでした'));
  assert.ok(t.includes('コード: X_REJECTED_403'));
  assert.ok(!t.includes('Xが投稿を受け付けました'));
  await ui.press('編集に戻る');
  assert.equal(ui.state().draft, 'こんにちは');
  await ui.press('内容を確認する');
  await ui.press('Xに投稿する');
  assert.equal(fp.calls.send.length, 2);
  assert.equal(fp.calls.send[1].targetId, 'req-2');
});

test('uncertain: warned, no resend, no send button, and only an explicit acknowledgement unlocks the screen', async () => {
  const { ui, fp } = await readyConfirmation();
  await ui.press('Xに投稿する');
  fp.pending[0].resolve({ kind: 'uncertain', targetId: 'req-1', code: 'X_TIMEOUT' });
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
  const fp = fakePort();
  const first = await mount({ port: fp, memory });
  await first.typeText('こんにちは');
  await first.press('内容を確認する');
  await first.press('Xに投稿する');
  first.unmount(); // the user navigates away while the send is pending
  const second = await mount({ port: fp, memory });
  assert.equal(second.state().phase, 'result', 'the new visit opens on the unresolved attempt');
  assert.equal(second.state().result.code, model.UNRESOLVED_FROM_EARLIER_VISIT);
  assert.equal(second.button('Xに投稿する'), null);
  assert.equal(second.all('TextInput').length, 0, 'no input while an attempt is unresolved');
  fp.pending[0].resolve({ kind: 'published', targetId: 'req-1', providerPostId: '9' });
  await settle();
  assert.equal(memory.get('U1'), null, 'the flow itself clears the memory when the late answer proves it');
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
  assert.equal(keyOf(), 'U1');
  world.userId = 'U2';
  assert.equal(keyOf(), 'U2');
  world.userId = null;
  assert.equal(keyOf(), 'signed-out');
  assert.equal(element().props.userId, null);
});

test('another signed-in user never inherits an unresolved attempt', async () => {
  const memory = realFlow.createAttemptMemory();
  memory.mark('U1', { accountId: 'X_A', requestId: 'r9' });
  const other = await mount({ userId: 'U2', memory });
  assert.equal(other.state().phase, 'editing');
  const same = await mount({ userId: 'U1', memory });
  assert.equal(same.state().phase, 'result');
});

test('the header is set by the route itself (the root layout is not touched)', async () => {
  const ui = await mount();
  const header = ui.all('StackScreen')[0];
  assert.deepEqual({ ...header.props.options }, { headerShown: true, title: '手入力でXに投稿' });
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
