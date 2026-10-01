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

test('the request carries exactly the three fields, the exact account id and the state the person saw', () => {
  assert.deepEqual(domain.buildPublishSettingRequest(account({ id: 'sa_9' }), true), {
    social_account_id: 'sa_9', desired_enabled: true, expected_current_enabled: false,
  });
  assert.deepEqual(domain.buildPublishSettingRequest(account({ postingState: 'active' }), false), {
    social_account_id: 'sa_1', desired_enabled: false, expected_current_enabled: true,
  });
});

test('copy: ON asks for explicit confirmation; OFF never claims deletion', () => {
  assert.match(domain.PUBLISH_ENABLE_CONFIRMATION, /自動でXへ投稿される可能性/u);
  assert.doesNotMatch(domain.PUBLISH_DISABLE_NOTE, /(削除しました|削除されます|消去|取り消し|解除されます)/u);
  assert.match(domain.PUBLISH_DISABLE_NOTE, /削除されず/u);
  assert.match(domain.PUBLISH_DISABLE_NOTE, /自動投稿は行われなくなります/u);
});

test('every server error code maps to safe Japanese copy; unknown or malformed payloads never leak raw text', () => {
  const codes = ['AUTH_REQUIRED', 'REQUEST_INVALID', 'ACCOUNT_NOT_FOUND', 'PUBLISH_CONTROL_FORBIDDEN', 'STALE_STATE', 'PLATFORM_NOT_SUPPORTED', 'BRAND_INACTIVE', 'BRAND_PUBLISHING_NOT_LIVE', 'CONNECTION_NOT_VERIFIED', 'CONNECTION_DEGRADED', 'CREDENTIALS_MISSING', 'ACCOUNT_BUSY', 'PUBLISH_SETTING_UNAVAILABLE'];
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

test('success is accepted only when the server confirms this exact account and the requested value', () => {
  const request = domain.buildPublishSettingRequest(account(), true);
  const ok = { success: true, status: 'updated', account: { id: 'sa_1', publish_enabled: true } };
  assert.deepEqual({ ...domain.parsePublishSettingSuccess(ok, request) }, { status: 'updated', accountId: 'sa_1', enabled: true });
  assert.equal(domain.parsePublishSettingSuccess({ ...ok, status: 'unchanged' }, request)?.status, 'unchanged');
  for (const bad of [null, {}, { ...ok, success: false }, { ...ok, status: 'weird' }, { ...ok, account: { id: 'sa_2', publish_enabled: true } }, { ...ok, account: { id: 'sa_1', publish_enabled: false } }, { ...ok, account: null }]) {
    assert.equal(domain.parsePublishSettingSuccess(bad, request), null);
  }
});

// ---------------------------------------------------------------- hook + card (real source, transpiled)

function makeRuntime({ session = { access_token: 'user-jwt-fixture' }, invoke }) {
  const slots = []; let cursor = 0;
  const react = {
    useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback: (cb) => cb,
  };
  const jsx = (type, props) => ({ type: typeof type === 'function' ? type.name : type, fn: type, props });
  const reloads = [];
  const calls = [];
  const sources = {};
  const stubs = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text', View: 'View' },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i', success: 's', danger: 'd' } },
    '@/domain/publish-setting': domain,
    '@/lib/supabase': { supabase: { functions: { invoke: async (name, options) => { calls.push({ name, options }); return invoke(name, options, calls.length); } } } },
    '@/providers/auth-provider': { useAuth: () => ({ session }) },
  };
  const load = async (path) => {
    if (sources[path]) return sources[path];
    const source = await read(path);
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} };
    const require = (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; };
    vm.runInNewContext(js, { module, exports: module.exports, require, Response, console }, { filename: path });
    return (sources[path] = module.exports);
  };
  return { stubs, load, calls, reloads, reset: () => { cursor = 0; }, reload: () => reloads.push(1) };
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

async function cardHarness({ account: acct = account(), preview = false, invoke = async () => ({ data: null, error: null }), session } = {}) {
  const runtime = makeRuntime({ invoke, ...(session === undefined ? {} : { session }) });
  const hookModule = await runtime.load('src/features/publish-setting/use-publish-setting.ts');
  runtime.stubs['@/features/publish-setting/use-publish-setting'] = hookModule;
  const cardModule = await runtime.load('src/features/publish-setting/publish-setting-card.tsx');
  const props = { account: acct, preview, reload: runtime.reload };
  const render = () => { runtime.reset(); return cardModule.PublishSettingCard(props); };
  return { render, runtime, props };
}

const success = (enabled) => ({ data: { success: true, status: 'updated', account: { id: 'sa_1', publish_enabled: enabled } }, error: null });

test('ON requires an explicit confirmation; cancelling sends nothing', async () => {
  const h = await cardHarness();
  buttonByLabel(h.render(), '自動投稿をONにする').onPress();
  const confirming = h.render();
  assert.ok(texts(confirming).includes(domain.PUBLISH_ENABLE_CONFIRMATION));
  assert.equal(h.runtime.calls.length, 0, 'no request before confirmation');
  buttonByLabel(confirming, 'キャンセル').onPress();
  const after = h.render();
  assert.equal(h.runtime.calls.length, 0);
  assert.ok(buttonByLabel(after, '自動投稿をONにする'), 'back to the normal view');
  assert.ok(!texts(after).includes(domain.PUBLISH_ENABLE_CONFIRMATION));
});

test('confirming sends exactly one request for the exact account with the state the person saw, then reloads the shared data', async () => {
  const h = await cardHarness({ invoke: async () => success(true) });
  buttonByLabel(h.render(), '自動投稿をONにする').onPress();
  buttonByLabel(h.render(), 'ONにする').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.runtime.calls.length, 1);
  const [{ name, options }] = h.runtime.calls;
  assert.equal(name, 'social-mobile-publish-setting');
  assert.deepEqual({ ...options.body }, { social_account_id: 'sa_1', desired_enabled: true, expected_current_enabled: false });
  assert.equal(options.headers.Authorization, 'Bearer user-jwt-fixture');
  assert.equal(h.runtime.reloads.length, 1);
  assert.ok(texts(h.render()).includes('自動投稿をONにしました。'));
});

test('while a request is in flight a second request is not sent and the buttons are disabled', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await cardHarness({ account: account({ postingState: 'active' }), invoke: async () => { await gate; return success(false); } });
  const off = buttonByLabel(h.render(), '自動投稿をOFFにする');
  off.onPress();
  off.onPress();
  assert.equal(h.runtime.calls.length, 1);
  assert.equal(buttonByLabel(h.render(), '変更しています').disabled, true);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.runtime.calls.length, 1);
  assert.equal(h.runtime.reloads.length, 1);
});

test('OFF is one tap, sends desired=false against the seen ON state, and its copy never claims deletion', async () => {
  const h = await cardHarness({ account: account({ postingState: 'active' }), invoke: async () => success(false) });
  const tree = h.render();
  assert.ok(texts(tree).includes(domain.PUBLISH_DISABLE_NOTE));
  assert.ok(!texts(tree).some((t) => /削除(しました|されます)/u.test(t)));
  buttonByLabel(tree, '自動投稿をOFFにする').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({ ...h.runtime.calls[0].options.body }, { social_account_id: 'sa_1', desired_enabled: false, expected_current_enabled: true });
  assert.ok(texts(h.render()).includes('自動投稿をOFFにしました。'));
});

test('a stale-state conflict reloads the shared data and says so; the shown state is not changed locally', async () => {
  const response = new Response(JSON.stringify({ success: false, error: 'STALE_STATE', current_enabled: true }), { status: 409 });
  const h = await cardHarness({ invoke: async () => ({ data: null, error: { context: response } }) });
  buttonByLabel(h.render(), '自動投稿をONにする').onPress();
  buttonByLabel(h.render(), 'ONにする').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.runtime.reloads.length, 1);
  assert.ok(texts(h.render()).some((t) => t.includes('最新の状態を読み込み直しました')));
  assert.ok(texts(h.render()).includes('自動投稿: OFF'), 'the label still reflects the real (reloaded) data, not an optimistic guess');
});

test('server refusals show safe copy and do not pretend success; a viewer refusal does not reload', async () => {
  const response = new Response(JSON.stringify({ success: false, error: 'PUBLISH_CONTROL_FORBIDDEN' }), { status: 403 });
  const h = await cardHarness({ invoke: async () => ({ data: null, error: { context: response } }) });
  buttonByLabel(h.render(), '自動投稿をONにする').onPress();
  buttonByLabel(h.render(), 'ONにする').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  const shown = texts(h.render());
  assert.ok(shown.some((t) => t.includes('オーナーまたは管理者')));
  assert.ok(!shown.some((t) => t.includes('しました。')));
  assert.equal(h.runtime.reloads.length, 0);
});

test('a network failure or malformed success is a safe error, never a success', async () => {
  for (const invoke of [async () => { throw new Error('socket hang up host=10.0.0.1'); }, async () => ({ data: { success: true, status: 'updated', account: { id: 'other', publish_enabled: true } }, error: null }), async () => ({ data: null, error: { message: 'FunctionsFetchError' } })]) {
    const h = await cardHarness({ invoke });
    buttonByLabel(h.render(), '自動投稿をONにする').onPress();
    buttonByLabel(h.render(), 'ONにする').onPress();
    await new Promise((resolve) => setImmediate(resolve));
    const shown = texts(h.render()).join('|');
    assert.match(shown, /設定を変更できませんでした/u);
    assert.doesNotMatch(shown, /10\.0\.0\.1|socket|FunctionsFetchError|ONにしました/u);
    assert.equal(h.runtime.reloads.length, 0);
  }
});

test('without a session nothing is sent', async () => {
  const h = await cardHarness({ session: null });
  buttonByLabel(h.render(), '自動投稿をONにする').onPress();
  buttonByLabel(h.render(), 'ONにする').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.runtime.calls.length, 0);
  assert.ok(texts(h.render()).some((t) => t.includes('ログイン')));
});

test('a disconnected account shows no ON button (explained); a degraded ON account still shows OFF', async () => {
  const off = await cardHarness({ account: account({ connectionStatus: 'needs_attention' }) });
  const offTree = off.render();
  assert.equal(buttonByLabel(offTree, 'ONにする'), undefined);
  assert.ok(texts(offTree).some((t) => t.includes('Xとの接続を確認できるまで')));
  const on = await cardHarness({ account: account({ connectionStatus: 'needs_attention', postingState: 'active' }) });
  assert.ok(buttonByLabel(on.render(), '自動投稿をOFFにする'));
});

test('mock preview offers no switch at all', async () => {
  const h = await cardHarness({ preview: true, account: account({ postingState: 'active' }) });
  assert.equal(buttons(h.render()).length, 0);
});

// ---------------------------------------------------------------- wiring / scope

test('the account detail screen wires the card with the real shared-data reload and the exact route account', async () => {
  const screen = await read('src/app/accounts/[id].tsx');
  assert.match(screen, /<PublishSettingCard account=\{account\} preview=\{status === 'mock_preview'\} reload=\{reload\} \/>/u);
  assert.match(screen, /accounts\.find\(\(item\) => item\.id === id\)/u);
});

test('publish_enabled stays separate from approvalMode, and no G3 consultation / content-settings code is imported', async () => {
  for (const path of ['src/domain/publish-setting.ts', 'src/features/publish-setting/use-publish-setting.ts', 'src/features/publish-setting/publish-setting-card.tsx']) {
    const code = await read(path);
    assert.doesNotMatch(code, /approvalMode|content-settings|consult/iu, path);
    assert.doesNotMatch(code, /from\s+['"][^'"]*(x-oauth|vault|openai)/iu, path);
  }
});

test('the client never writes the table directly and sends no brand id', async () => {
  const code = await read('src/features/publish-setting/use-publish-setting.ts');
  assert.doesNotMatch(code, /\.from\(|\.rpc\(|\.update\(|brand_id/u);
  assert.match(code, /functions\.invoke/u);
});
