// Per-account automatic-publishing switch (client side): the pure domain rules plus the real hook and
// card (transpiled) driven through stubbed React / React Native / Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as domain from '../src/domain/publish-setting.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

const account = (over = {}) => ({ id: 'sa_1', brandId: 'u_1', platform: 'x', profile: {}, connectionStatus: 'connected', postingState: 'paused', ...over });
const context = (acct = account(), preview = false, userId = 'user-1') => domain.publishActionContext(acct, preview, userId);

// ---------------------------------------------------------------- domain

test('the view tells the truth about the real state', () => {
  assert.equal(domain.publishSettingView(account({ postingState: 'active' })).statusLabel, '自動投稿: ON');
  assert.equal(domain.publishSettingView(account({ postingState: 'paused' })).statusLabel, '自動投稿: OFF');
  assert.equal(domain.publishSettingView(account({ postingState: 'active' })).enabled, true);
});

test('ON is offered only for a connected X account; OFF only when currently ON', () => {
  const offConnected = domain.publishSettingView(account());
  assert.deepEqual([offConnected.canTurnOn, offConnected.canTurnOff], [true, false]);
  const onConnected = domain.publishSettingView(account({ postingState: 'active' }));
  assert.deepEqual([onConnected.canTurnOn, onConnected.canTurnOff], [false, true]);
});

test('a disconnected account cannot be turned ON (explained), but a degraded ON account can always be turned OFF', () => {
  for (const connectionStatus of ['needs_attention', 'not_connected']) {
    const off = domain.publishSettingView(account({ connectionStatus }));
    assert.equal(off.canTurnOn, false);
    assert.match(off.note, /接続/u);
    const on = domain.publishSettingView(account({ connectionStatus, postingState: 'active' }));
    assert.equal(on.canTurnOff, true);
    assert.equal(on.canTurnOn, false);
  }
});

test('mock preview and non-X platforms cannot request ON; nothing is switchable in the preview', () => {
  const preview = domain.publishSettingView(account({ postingState: 'active' }), true);
  assert.deepEqual([preview.canTurnOn, preview.canTurnOff], [false, false]);
  assert.match(preview.note, /プレビュー/u);
  const instagram = domain.publishSettingView(account({ platform: 'instagram' }));
  assert.equal(instagram.canTurnOn, false);
});

test('an action is pinned to the account, the state seen and the signed-in user; the request carries exactly three fields', () => {
  const on = domain.pinPublishAction(context(account({ id: 'sa_9' })), true);
  assert.deepEqual({ ...on }, { accountId: 'sa_9', desiredEnabled: true, expectedEnabled: false, userId: 'user-1' });
  assert.deepEqual({ ...domain.buildPublishSettingRequest(on) }, { social_account_id: 'sa_9', desired_enabled: true, expected_current_enabled: false });
  const off = domain.pinPublishAction(context(account({ postingState: 'active' })), false);
  assert.deepEqual({ ...domain.buildPublishSettingRequest(off) }, { social_account_id: 'sa_1', desired_enabled: false, expected_current_enabled: true });
});

test('an action that is not on offer cannot be pinned', () => {
  assert.equal(domain.pinPublishAction(context(account(), true), true), null, 'preview');
  assert.equal(domain.pinPublishAction(context(account(), false, null), true), null, 'no signed-in user');
  assert.equal(domain.pinPublishAction(context(account({ connectionStatus: 'needs_attention' })), true), null, 'not eligible');
  assert.equal(domain.pinPublishAction(context(account({ postingState: 'active' })), true), null, 'already ON');
  assert.equal(domain.pinPublishAction(context(account()), false), null, 'already OFF');
  assert.equal(domain.pinPublishAction(context(account({ platform: 'instagram' })), true), null, 'not X');
});

test('a pinned action stays valid only while everything it was pinned to is unchanged', () => {
  const action = domain.pinPublishAction(context(), true);
  assert.equal(domain.publishActionStillValid(action, context()), true);
  const changed = {
    'another account': context(account({ id: 'sa_2' })),
    'state changed (now ON)': context(account({ postingState: 'active' })),
    'preview': context(account(), true),
    'no longer eligible': context(account({ connectionStatus: 'needs_attention' })),
    'another user': context(account(), false, 'user-2'),
    'signed out': context(account(), false, null),
  };
  for (const [label, current] of Object.entries(changed)) {
    assert.equal(domain.publishActionStillValid(action, current), false, label);
  }
  // OFF is pinned the same way, but does not depend on the connection.
  const off = domain.pinPublishAction(context(account({ postingState: 'active' })), false);
  assert.equal(domain.publishActionStillValid(off, context(account({ postingState: 'active', connectionStatus: 'needs_attention' }))), true);
  assert.equal(domain.publishActionStillValid(off, context(account({ id: 'sa_2', postingState: 'active' }))), false);
  assert.equal(domain.publishActionStillValid(off, context(account({ postingState: 'paused' }))), false);
});

test('copy: ON asks for confirmation and is a permission, not a promise; OFF is conditional and never claims deletion or recall', () => {
  assert.match(domain.PUBLISH_ENABLE_CONFIRMATION, /自動でXへ投稿される可能性/u);
  assert.match(domain.PUBLISH_ENABLE_NOTE, /許可/u);
  assert.match(domain.PUBLISH_ENABLE_NOTE, /投稿が行われない場合/u);
  assert.doesNotMatch(domain.PUBLISH_DISABLE_NOTE, /(削除しました|削除されます|消去|解除されます)/u);
  assert.match(domain.PUBLISH_DISABLE_NOTE, /削除されません/u);
  assert.match(domain.PUBLISH_DISABLE_NOTE, /新しく始まる自動投稿は行われなくなります/u);
  assert.match(domain.PUBLISH_DISABLE_NOTE, /すでに送信が始まっている投稿は取り消せません/u, 'no recall of an in-flight send');
  assert.doesNotMatch(domain.PUBLISH_DISABLE_NOTE, /いつでも/u, 'turning back ON is conditional');
  assert.match(domain.PUBLISH_DISABLE_NOTE, /条件を満たしている必要があります/u);
});

test('every server error code maps to safe Japanese copy; unknown or malformed payloads never leak raw text', () => {
  const codes = ['AUTH_REQUIRED', 'REQUEST_INVALID', 'ACCOUNT_NOT_FOUND', 'PUBLISH_CONTROL_FORBIDDEN', 'STALE_STATE', 'PLATFORM_NOT_SUPPORTED', 'BRAND_INACTIVE', 'BRAND_PUBLISHING_NOT_LIVE', 'CONNECTION_NOT_VERIFIED', 'CONNECTION_DEGRADED', 'CREDENTIALS_MISSING', 'CREDENTIALS_INVALID', 'ACCOUNT_BUSY', 'PUBLISH_SETTING_UNAVAILABLE'];
  for (const code of codes) {
    const failure = domain.publishSettingFailure({ success: false, error: code });
    assert.equal(failure.code, code);
    assert.match(failure.message, /[ぁ-んァ-ン一-龥]/u);
    assert.doesNotMatch(failure.message, /[A-Z_]{6,}/u, code);
  }
  for (const payload of [null, undefined, 'boom', 42, {}, { error: 'SOMETHING_NEW' }, { error: 'constructor' }, { error: '__proto__' }, { error: { message: 'password=hunter2' } }]) {
    const failure = domain.publishSettingFailure(payload);
    assert.equal(failure.code, 'PUBLISH_SETTING_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(failure), /hunter2|SOMETHING_NEW|constructor/u);
  }
  assert.equal(domain.publishSettingFailure({ error: 'STALE_STATE' }).reload, true);
  assert.equal(domain.publishSettingFailure({ error: 'PUBLISH_CONTROL_FORBIDDEN' }).reload, false);
});

test('the server and the client agree on the bounded error codes', async () => {
  const server = await readFile(resolve(root, '../../supabase/functions/social-mobile-publish-setting/logic.ts'), 'utf8');
  const union = server.slice(server.indexOf('export type PublishSettingBlockedReason'), server.indexOf('export const BLOCKED_REASONS'));
  const codes = [...union.matchAll(/"([A-Z_]+)"/gu)].map((match) => match[1]).filter((code) => code !== 'METHOD_NOT_ALLOWED');
  assert.ok(codes.length >= 14);
  for (const code of new Set(codes)) assert.equal(domain.publishSettingFailure({ error: code }).code, code, code);
});

test('success is accepted only when the server confirms this exact account and the requested value', () => {
  const request = domain.buildPublishSettingRequest(domain.pinPublishAction(context(), true));
  const ok = { success: true, status: 'updated', account: { id: 'sa_1', publish_enabled: true } };
  assert.deepEqual({ ...domain.parsePublishSettingSuccess(ok, request) }, { status: 'updated', accountId: 'sa_1', enabled: true });
  assert.equal(domain.parsePublishSettingSuccess({ ...ok, status: 'unchanged' }, request)?.status, 'unchanged');
  for (const bad of [null, {}, { ...ok, success: false }, { ...ok, status: 'weird' }, { ...ok, account: { id: 'sa_2', publish_enabled: true } }, { ...ok, account: { id: 'sa_1', publish_enabled: false } }, { ...ok, account: null }]) {
    assert.equal(domain.parsePublishSettingSuccess(bad, request), null);
  }
});

// ---------------------------------------------------------------- hook + card (real source, transpiled)

/**
 * Renders the real card with stubbed React. `props` and `auth` are mutable: a test changes them and
 * calls render() again, exactly like a parent re-rendering with another account, preview mode or user.
 */
async function cardHarness({ account: acct = account(), preview = false, invoke = async () => ({ data: null, error: null }), session = { access_token: 'user-jwt-fixture', user: { id: 'user-1' } } } = {}) {
  const slots = []; let cursor = 0; let effects = [];
  const react = {
    // Layout effects run synchronously after each render is committed (see render() below).
    useLayoutEffect: (effect) => { effects.push(effect); },
    useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    // The real hook depends only on `reload`; keep the FIRST callback to model a memoized callback that
    // outlives later renders (it must still read the latest screen, not the one it was created in).
    useCallback: (cb) => { const i = cursor++; if (!(i in slots)) slots[i] = cb; return slots[i]; },
  };
  const jsx = (type, props) => ({ type: typeof type === 'function' ? type.name : type, fn: type, props });
  const reloads = [];
  const calls = [];
  const auth = { session };
  const stubs = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text', View: 'View' },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i', success: 's', danger: 'd' } },
    '@/domain/publish-setting': domain,
    '@/lib/supabase': { supabase: { functions: { invoke: async (name, options) => { calls.push({ name, options }); return invoke(name, options, calls.length); } } } },
    '@/providers/auth-provider': { useAuth: () => ({ session: auth.session }) },
  };
  const load = async (path) => {
    const source = await read(path);
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} };
    const require = (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; };
    vm.runInNewContext(js, { module, exports: module.exports, require, Response, console }, { filename: path });
    return module.exports;
  };
  stubs['@/features/publish-setting/use-publish-setting'] = await load('src/features/publish-setting/use-publish-setting.ts');
  const cardModule = await load('src/features/publish-setting/publish-setting-card.tsx');
  const props = { account: acct, preview, reload: () => reloads.push(1) };
  const render = () => {
    cursor = 0; effects = [];
    const tree = cardModule.PublishSettingCard(props);
    effects.forEach((effect) => effect());
    return tree;
  };
  return { render, props, auth, calls, reloads };
}

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node === null || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
};
const texts = (tree) => { const out = []; walk(tree, (n) => { if (['Text', 'Pill'].includes(n.type)) out.push([n.props.children].flat().filter((c) => typeof c === 'string').join('')); }); return out; };
const buttons = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'ActionButton') out.push(n.props); }); return out; };
const buttonByLabel = (tree, text) => buttons(tree).find((b) => b.label.includes(text));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const isConfirming = (tree) => texts(tree).includes(domain.PUBLISH_ENABLE_CONFIRMATION);
/** Opens the ON confirmation and returns the confirm button of that render. */
const openConfirmation = (h) => {
  buttonByLabel(h.render(), '自動投稿をONにする').onPress();
  const tree = h.render();
  assert.ok(isConfirming(tree), 'confirmation is open');
  return buttonByLabel(tree, 'ONにする');
};

const success = (enabled, id = 'sa_1') => ({ data: { success: true, status: 'updated', account: { id, publish_enabled: enabled } }, error: null });

test('ON requires an explicit confirmation; cancelling sends nothing', async () => {
  const h = await cardHarness();
  buttonByLabel(h.render(), '自動投稿をONにする').onPress();
  const confirming = h.render();
  assert.ok(isConfirming(confirming));
  assert.ok(texts(confirming).includes(domain.PUBLISH_ENABLE_NOTE));
  assert.equal(h.calls.length, 0, 'no request before confirmation');
  buttonByLabel(confirming, 'キャンセル').onPress();
  const after = h.render();
  assert.equal(h.calls.length, 0);
  assert.ok(buttonByLabel(after, '自動投稿をONにする'), 'back to the normal view');
  assert.ok(!isConfirming(after));
});

test('confirming sends exactly one request for the exact account with the state the person saw, then reloads the shared data', async () => {
  const h = await cardHarness({ invoke: async () => success(true) });
  openConfirmation(h).onPress();
  await settle();
  assert.equal(h.calls.length, 1);
  const [{ name, options }] = h.calls;
  assert.equal(name, 'social-mobile-publish-setting');
  assert.deepEqual({ ...options.body }, { social_account_id: 'sa_1', desired_enabled: true, expected_current_enabled: false });
  assert.equal(options.headers.Authorization, 'Bearer user-jwt-fixture');
  assert.equal(h.reloads.length, 1);
  assert.ok(texts(h.render()).includes('自動投稿をONにしました。'));
});

// ---- R5: the confirmation is pinned to what was on screen -------------------------------------------

test('R5: a confirmation opened for account A is closed when the card is given account B; confirming sends nothing', async () => {
  const h = await cardHarness({ invoke: async () => success(true, 'sa_2') });
  const staleConfirm = openConfirmation(h);
  // The parent now shows another, equally eligible account in the same card.
  h.props.account = account({ id: 'sa_2' });
  const tree = h.render();
  assert.ok(!isConfirming(tree), 'the confirmation for A is not shown on B');
  assert.equal(buttonByLabel(tree, 'ONにする')?.label, '自動投稿をONにする', 'only the normal ON button for B');
  // Even the confirm button captured from the earlier render cannot send (for A or for B).
  staleConfirm.onPress();
  await settle();
  assert.equal(h.calls.length, 0, 'zero requests');
  // Going back to A does not resurrect the confirmation: the person has to ask again.
  h.props.account = account({ id: 'sa_1' });
  assert.ok(!isConfirming(h.render()));
  assert.equal(h.calls.length, 0);
});

test('R5: a confirm tap that lands after the account changed but before any re-render still sends nothing', async () => {
  const h = await cardHarness({ invoke: async () => success(true, 'sa_2') });
  const confirm = openConfirmation(h);
  h.props.account = account({ id: 'sa_2' });
  h.render(); // the screen is now B; the old button object is still held by the test
  confirm.onPress();
  await settle();
  assert.equal(h.calls.length, 0);
});

test('R5: preview turning on closes the confirmation and blocks the request', async () => {
  const h = await cardHarness({ invoke: async () => success(true) });
  const staleConfirm = openConfirmation(h);
  h.props.preview = true;
  const tree = h.render();
  assert.ok(!isConfirming(tree));
  assert.equal(buttons(tree).length, 0, 'no switch at all in preview');
  staleConfirm.onPress();
  await settle();
  assert.equal(h.calls.length, 0);
  // Leaving preview again does not bring the confirmation back.
  h.props.preview = false;
  assert.ok(!isConfirming(h.render()));
});

test('R5: the state or eligibility changing under an open confirmation requires a new confirmation', async () => {
  for (const [label, change] of [
    ['the account is already ON after a reload', (h) => { h.props.account = account({ postingState: 'active' }); }],
    ['the connection is no longer verified', (h) => { h.props.account = account({ connectionStatus: 'needs_attention' }); }],
    ['another user is signed in', (h) => { h.auth.session = { access_token: 'other-jwt', user: { id: 'user-2' } }; }],
    ['signed out', (h) => { h.auth.session = null; }],
  ]) {
    const h = await cardHarness({ invoke: async () => success(true) });
    const staleConfirm = openConfirmation(h);
    change(h);
    assert.ok(!isConfirming(h.render()), label);
    staleConfirm.onPress();
    await settle();
    assert.equal(h.calls.length, 0, label);
    assert.equal(h.reloads.length, 0, label);
  }
  // Unchanged context after a plain re-render (e.g. unrelated parent update): the confirmation stays.
  const h = await cardHarness({ invoke: async () => success(true) });
  openConfirmation(h);
  h.props.account = account(); // a new object with the same content
  const tree = h.render();
  assert.ok(isConfirming(tree));
  buttonByLabel(tree, 'ONにする').onPress();
  await settle();
  assert.equal(h.calls.length, 1);
});

test('R5: a new confirmation after the context changed is for the new account only', async () => {
  const h = await cardHarness({ invoke: async () => success(true, 'sa_2') });
  openConfirmation(h);
  h.props.account = account({ id: 'sa_2' });
  h.render();
  openConfirmation(h).onPress();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.deepEqual({ ...h.calls[0].options.body }, { social_account_id: 'sa_2', desired_enabled: true, expected_current_enabled: false });
});

test('R5: OFF is pinned at the tap; an OFF button from an earlier render cannot switch another account off', async () => {
  const h = await cardHarness({ account: account({ postingState: 'active' }), invoke: async () => success(false, 'sa_2') });
  const staleOff = buttonByLabel(h.render(), '自動投稿をOFFにする');
  h.props.account = account({ id: 'sa_2', postingState: 'active' });
  h.render();
  staleOff.onPress();
  await settle();
  assert.equal(h.calls.length, 0);
});

test('a result that arrives after the card moved to another account is not shown there', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await cardHarness({ invoke: async () => { await gate; return success(true); } });
  openConfirmation(h).onPress();
  h.props.account = account({ id: 'sa_2' });
  release();
  await settle();
  const shown = texts(h.render());
  assert.ok(!shown.some((t) => t.includes('ONにしました')), 'A\'s result is not displayed on B');
  assert.equal(h.reloads.length, 1, 'the shared data is still reloaded');
});

// ---- in-flight, OFF, errors --------------------------------------------------------------------------

test('while a request is in flight a second request is not sent and the buttons are disabled', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await cardHarness({ account: account({ postingState: 'active' }), invoke: async () => { await gate; return success(false); } });
  const off = buttonByLabel(h.render(), '自動投稿をOFFにする');
  off.onPress();
  off.onPress();
  assert.equal(h.calls.length, 1);
  assert.equal(buttonByLabel(h.render(), '変更しています').disabled, true);
  release();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.reloads.length, 1);
});

test('a double tap on the confirm button sends one request', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await cardHarness({ invoke: async () => { await gate; return success(true); } });
  const confirm = openConfirmation(h);
  confirm.onPress();
  confirm.onPress();
  h.render();
  confirm.onPress();
  release();
  await settle();
  assert.equal(h.calls.length, 1);
});

test('OFF is one tap, sends desired=false against the seen ON state, and its copy never claims deletion or recall', async () => {
  const h = await cardHarness({ account: account({ postingState: 'active' }), invoke: async () => success(false) });
  const tree = h.render();
  assert.ok(texts(tree).includes(domain.PUBLISH_DISABLE_NOTE));
  assert.ok(!texts(tree).some((t) => /削除(しました|されます)|いつでもON/u.test(t)));
  buttonByLabel(tree, '自動投稿をOFFにする').onPress();
  await settle();
  assert.deepEqual({ ...h.calls[0].options.body }, { social_account_id: 'sa_1', desired_enabled: false, expected_current_enabled: true });
  assert.ok(texts(h.render()).includes('自動投稿をOFFにしました。'));
});

test('a stale-state conflict reloads the shared data and says so; the shown state is not changed locally', async () => {
  const response = new Response(JSON.stringify({ success: false, error: 'STALE_STATE', current_enabled: true }), { status: 409 });
  const h = await cardHarness({ invoke: async () => ({ data: null, error: { context: response } }) });
  openConfirmation(h).onPress();
  await settle();
  assert.equal(h.reloads.length, 1);
  assert.ok(texts(h.render()).some((t) => t.includes('最新の状態を読み込み直しました')));
  assert.ok(texts(h.render()).includes('自動投稿: OFF'), 'the label still reflects the real (reloaded) data, not an optimistic guess');
});

test('server refusals show safe copy and do not pretend success; a viewer refusal does not reload', async () => {
  const response = new Response(JSON.stringify({ success: false, error: 'PUBLISH_CONTROL_FORBIDDEN' }), { status: 403 });
  const h = await cardHarness({ invoke: async () => ({ data: null, error: { context: response } }) });
  openConfirmation(h).onPress();
  await settle();
  const shown = texts(h.render());
  assert.ok(shown.some((t) => t.includes('オーナーまたは管理者')));
  assert.ok(!shown.some((t) => t.includes('しました。')));
  assert.equal(h.reloads.length, 0);
});

test('a network failure or malformed success is a safe error, never a success', async () => {
  for (const invoke of [async () => { throw new Error('socket hang up host=10.0.0.1'); }, async () => ({ data: { success: true, status: 'updated', account: { id: 'other', publish_enabled: true } }, error: null }), async () => ({ data: null, error: { message: 'FunctionsFetchError' } })]) {
    const h = await cardHarness({ invoke });
    openConfirmation(h).onPress();
    await settle();
    const shown = texts(h.render()).join('|');
    assert.match(shown, /設定を変更できませんでした/u);
    assert.doesNotMatch(shown, /10\.0\.0\.1|socket|FunctionsFetchError|ONにしました/u);
    assert.equal(h.reloads.length, 0);
  }
});

test('without a signed-in user no switch action can even be pinned', async () => {
  const h = await cardHarness({ session: null });
  buttonByLabel(h.render(), '自動投稿をONにする').onPress();
  assert.ok(!isConfirming(h.render()));
  assert.equal(h.calls.length, 0);
});

test('a disconnected account shows no ON button (explained); a degraded ON account still shows OFF and can be switched off', async () => {
  const off = await cardHarness({ account: account({ connectionStatus: 'needs_attention' }) });
  const offTree = off.render();
  assert.equal(buttonByLabel(offTree, 'ONにする'), undefined);
  assert.ok(texts(offTree).some((t) => t.includes('Xとの接続を確認できるまで')));
  const on = await cardHarness({ account: account({ connectionStatus: 'needs_attention', postingState: 'active' }), invoke: async () => success(false) });
  buttonByLabel(on.render(), '自動投稿をOFFにする').onPress();
  await settle();
  assert.equal(on.calls.length, 1);
  assert.deepEqual({ ...on.calls[0].options.body }, { social_account_id: 'sa_1', desired_enabled: false, expected_current_enabled: true });
});

test('mock preview offers no switch at all', async () => {
  const h = await cardHarness({ preview: true, account: account({ postingState: 'active' }) });
  assert.equal(buttons(h.render()).length, 0);
});

// ---------------------------------------------------------------- wiring / scope

test('the account detail screen wires the card per account (keyed), with the real shared-data reload and the exact route account', async () => {
  const screen = await read('src/app/accounts/[id].tsx');
  assert.match(screen, /<PublishSettingCard key=\{account\.id\} account=\{account\} preview=\{status === 'mock_preview'\} reload=\{reload\} \/>/u);
  assert.match(screen, /accounts\.find\(\(item\) => item\.id === id\)/u);
});

test('publish_enabled stays separate from approvalMode, and no G3 consultation / content-settings code is imported', async () => {
  for (const path of ['src/domain/publish-setting.ts', 'src/features/publish-setting/use-publish-setting.ts', 'src/features/publish-setting/publish-setting-card.tsx']) {
    const code = await read(path);
    assert.doesNotMatch(code, /approvalMode|content-settings|consult/iu, path);
    assert.doesNotMatch(code, /from\s+['"][^'"]*(x-oauth|vault|openai)/iu, path);
  }
});

test('the client never writes the table or calls the database function directly, and sends no brand or user id', async () => {
  const code = await read('src/features/publish-setting/use-publish-setting.ts');
  assert.doesNotMatch(code, /\.from\(|\.rpc\(|\.update\(|brand_id|user_id/u);
  assert.match(code, /functions\.invoke/u);
});
