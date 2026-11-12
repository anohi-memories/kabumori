// Threads "post now" (client side): the pure domain rules, parity with the server's text rules, and the
// real hook and card (transpiled) driven through stubbed React / React Native / Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as domain from '../src/domain/threads-manual-publish.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');
const transpileCjs = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

/** The server's own text rules, loaded from its source (no Deno APIs in that file). */
async function serverContract() {
  const module = { exports: {} };
  vm.runInNewContext(transpileCjs(await read('../../supabase/functions/_shared/social/threads_publish_contract.ts')), { module, exports: module.exports, URL, URLSearchParams, TextEncoder, AbortController, setTimeout, clearTimeout, Response, JSON });
  return module.exports;
}

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000001';
const PERMALINK = 'https://www.threads.net/@postona_tester/post/AbC_123';
const account = (over = {}) => ({ id: 'sa_th_1', brandId: 'u_1', platform: 'threads', profile: { displayName: 'テスター', handle: '@postona_tester', avatarColor: '#000', voice: { tone: '', language: '', avoid: [] } }, connectionStatus: 'connected', postingState: 'paused', ...over });
const attempt = (over = {}) => ({ id: ATTEMPT_ID, social_account_id: 'sa_th_1', status: 'published', provider_post_id: '17890000000000003', permalink: PERMALINK, error_code: null, replayed: false, ...over });

// ---------------------------------------------------------------- domain

test('the release flag is OFF in source; the card then offers nothing', () => {
  assert.equal(domain.THREADS_MANUAL_PUBLISH_UI_ENABLED, false);
  assert.equal(domain.threadsCardMode(account(), { releaseEnabled: false, preview: false, server: { kind: 'loaded', permitted: true, open: null, last: null } }), 'release_disabled');
  assert.match(domain.MODE_COPY.release_disabled, /準備中/u);
});

test('text rules match the server exactly (length, links, refusals) over a mixed corpus', async () => {
  const server = await serverContract();
  const corpus = ['', ' ', '\n', 'こんにちは', 'a'.repeat(500), 'a'.repeat(501), 'あ'.repeat(500), 'a'.repeat(496) + '😀', 'a'.repeat(497) + '😀', '👨‍👩‍👧 家族', '1️⃣ 🇯🇵 ❤️ 👍🏽',
    Array.from({ length: 5 }, (_, i) => `https://example.com/${i}`).join(' '), Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join(' '),
    'a\u0000b', 'a\u001bb', '\ud800', '一行目\n二行目\tタブ', '　'];
  const issue = { EMPTY: 'empty', TOO_LONG: 'too_long', TOO_MANY_LINKS: 'too_many_links', INVALID_CHARACTERS: 'invalid_characters' };
  for (const text of corpus) {
    const s = server.checkThreadsText(text);
    const c = domain.checkThreadsComposerText(text);
    assert.equal(c.length, s.length, JSON.stringify(text));
    assert.equal(c.links, s.links, JSON.stringify(text));
    assert.equal(c.ok, s.ok, JSON.stringify(text));
    assert.equal(c.issue, s.refusal === null ? null : issue[s.refusal], JSON.stringify(text));
  }
});

test('CRLF typed on some keyboards becomes LF; the server never sees a carriage return', () => {
  assert.equal(domain.normalizeThreadsText('a\r\nb\rc'), 'a\nb\nc');
  assert.equal(domain.checkThreadsComposerText('a\r\nb').ok, true);
});

test('card modes: not Threads, preview, reconnect, loading, unavailable, consent, ready, busy', () => {
  const loaded = (permitted, open = null) => ({ kind: 'loaded', permitted, open, last: null });
  const mode = (acct, preview, server) => domain.threadsCardMode(acct, { releaseEnabled: true, preview, server });
  assert.equal(mode(account({ platform: 'x' }), false, loaded(true)), 'not_threads');
  assert.equal(mode(account(), true, loaded(true)), 'preview');
  assert.equal(mode(account({ connectionStatus: 'needs_attention' }), false, loaded(true)), 'reconnect');
  assert.equal(mode(account(), false, { kind: 'loading' }), 'loading');
  assert.equal(mode(account(), false, { kind: 'unavailable' }), 'unavailable');
  assert.equal(mode(account(), false, loaded(false)), 'consent_required');
  assert.equal(mode(account(), false, loaded(true)), 'ready');
  assert.equal(mode(account(), false, loaded(true, domain.parseAttempt(attempt({ status: 'uncertain', provider_post_id: null, permalink: null }), 'sa_th_1'))), 'busy');
});

test('an attempt is accepted only for this account and in a known shape; "published" needs id AND permalink', () => {
  assert.equal(domain.parseAttempt(attempt(), 'sa_th_1').status, 'published');
  assert.equal(domain.parseAttempt(attempt(), 'sa_th_2'), null, 'another account');
  assert.equal(domain.parseAttempt(attempt({ status: 'hacked' }), 'sa_th_1'), null);
  assert.equal(domain.parseAttempt(attempt({ permalink: null }), 'sa_th_1'), null, 'published without a permalink');
  assert.equal(domain.parseAttempt(attempt({ permalink: 'https://evil.example/x' }), 'sa_th_1'), null, 'foreign permalink');
  assert.equal(domain.parseAttempt(attempt({ id: 'nope' }), 'sa_th_1'), null);
  assert.equal(domain.parseAttempt(attempt({ status: 'publish_returned', permalink: PERMALINK }), 'sa_th_1').permalink, null, 'no link before confirmation');
});

test('only a confirmed post is shown as success; uncertain offers a check and no resend; failures say nothing was published', () => {
  const show = (over) => domain.attemptDisplay(domain.parseAttempt(attempt(over), 'sa_th_1'));
  assert.equal(show({}).tone, 'success');
  assert.match(show({}).title, /投稿しました/u);
  const returned = show({ status: 'publish_returned', permalink: null });
  assert.notEqual(returned.tone, 'success');
  assert.doesNotMatch(returned.title, /投稿しました/u);
  assert.equal(returned.canContinue, true);
  const uncertain = show({ status: 'uncertain', provider_post_id: null, permalink: null, error_code: 'THREADS_UNAVAILABLE' });
  assert.deepEqual([uncertain.canCheck, uncertain.allowsNewPost, uncertain.canContinue], [true, false, false]);
  assert.match(uncertain.detail, /送り直すことはしません/u);
  for (const code of ['CONTAINER_EXPIRED', 'CONTAINER_OUTCOME_UNKNOWN', 'ATTEMPT_EXPIRED', 'STEP_INTERRUPTED']) {
    assert.match(show({ status: 'failed', provider_post_id: null, permalink: null, error_code: code }).detail, /公開されていません/u, code);
  }
  assert.match(show({ status: 'failed', provider_post_id: null, permalink: null, error_code: 'THREADS_TOKEN_INVALID' }).detail, /接続し直して/u);
  for (const status of ['reserved', 'creating_container', 'publishing', 'container_created']) {
    assert.notEqual(show({ status, provider_post_id: null, permalink: null }).tone, 'success', status);
  }
});

test('every server error code has safe Japanese copy; unknown or malformed payloads never leak', async () => {
  const shared = await read('../../supabase/functions/_shared/social/threads_manual_publish.ts');
  const list = shared.slice(shared.indexOf('export const THREADS_STORE_REFUSALS'), shared.indexOf('export type ThreadsStoreRefusal'));
  const codes = [...list.matchAll(/"([A-Z_]+)"/gu)].map((m) => m[1]).concat(['THREADS_PUBLISH_DISABLED', 'METHOD_NOT_ALLOWED']);
  assert.ok(codes.length >= 20);
  for (const code of codes) {
    const refusal = domain.threadsRefusal({ success: false, error: code });
    assert.equal(refusal.code, code, code);
    assert.match(refusal.message, /[ぁ-んァ-ン一-龥]/u);
    assert.doesNotMatch(refusal.message, /[A-Z]+_[A-Z_]+/u, code);
  }
  for (const payload of [null, 'x', {}, { error: 'NEW_CODE' }, { error: '__proto__' }, { error: { token: 'THQVJsecret' } }]) {
    const refusal = domain.threadsRefusal(payload);
    assert.equal(refusal.code, 'STORE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(refusal), /THQVJ|NEW_CODE|__proto__/u);
  }
});

test('a publish is pinned to the ready account, the user, the normalized text and one fresh key', () => {
  const ctx = (over = {}) => ({ accountId: 'sa_th_1', mode: 'ready', userId: 'user-1', ...over });
  const pinned = domain.pinThreadsPublish(ctx(), 'こんにちは\r\n2行目', () => KEY);
  assert.deepEqual(pinned, { accountId: 'sa_th_1', userId: 'user-1', text: 'こんにちは\n2行目', idempotencyKey: KEY });
  assert.deepEqual(domain.buildPublishRequest(pinned), { action: 'publish', social_account_id: 'sa_th_1', idempotency_key: KEY, text: 'こんにちは\n2行目' });
  for (const [label, c, text] of [['preview', ctx({ mode: 'preview' }), 'x'], ['consent', ctx({ mode: 'consent_required' }), 'x'], ['busy', ctx({ mode: 'busy' }), 'x'], ['signed out', ctx({ userId: null }), 'x'], ['empty', ctx(), '  '], ['too long', ctx(), 'a'.repeat(501)]]) {
    assert.equal(domain.pinThreadsPublish(c, text, () => KEY), null, label);
  }
  assert.equal(domain.pinThreadsPublish(ctx(), 'x', () => 'not-a-uuid'), null);
  assert.equal(domain.pinnedStillValid(pinned, ctx()), true);
  for (const changed of [ctx({ accountId: 'sa_th_2' }), ctx({ userId: 'user-2' }), ctx({ mode: 'busy' }), ctx({ mode: 'preview' })]) {
    assert.equal(domain.pinnedStillValid(pinned, changed), false);
  }
});

test('copy: consent says manual only and revocable; confirmation says it cannot be undone from the app', () => {
  assert.match(domain.CONSENT_COPY, /自動では投稿しません/u);
  assert.match(domain.CONSENT_COPY, /取り消せます/u);
  assert.match(domain.PUBLISH_CONFIRM_COPY, /取り消せません/u);
});

// ---------------------------------------------------------------- hook + card (real source, transpiled)

async function cardHarness({ acct = account(), preview = false, releaseEnabled = true, serverState = { permitted: true, open_attempt: null, last_attempt: null }, onPublish = async () => ({ data: { success: true, attempt: attempt() }, error: null }), onAction = null, stableCallbacks = false } = {}) {
  const slots = []; let cursor = 0; let effects = []; const deps = [];
  const react = {
    useLayoutEffect: (effect) => { effects.push(effect); },
    useEffect: (effect, d) => { const i = cursor++; const prev = deps[i]; if (!prev || d.some((v, k) => v !== prev[k])) { deps[i] = d; effects.push(effect); } },
    useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    // G1 TASK 48: `stableCallbacks` keeps a callback while its dependencies are the same, as React does (default: a new one each render).
    useCallback: (cb, d) => { const i = cursor++; if (stableCallbacks && slots[i]?.deps && d.every((v, k) => v === slots[i].deps[k])) return slots[i].cb; slots[i] = stableCallbacks ? { cb, deps: d } : cb; return cb; },
  };
  const jsx = (type, props) => ({ type: typeof type === 'function' ? type.name : type, fn: type, props });
  const calls = [];
  const state = { ...serverState };
  const invoke = async (name, options) => {
    calls.push({ name, body: options.body, auth: options.headers.Authorization });
    if (options.body.action === 'account_state') return { data: { success: true, account: { id: acct.id, manual_publish_permitted: state.permitted, open_attempt: state.open_attempt, last_attempt: state.last_attempt } }, error: null };
    if (options.body.action === 'set_permission') { state.permitted = options.body.desired_enabled; return { data: { success: true, status: 'updated', account: { id: acct.id, manual_publish_permitted: state.permitted } }, error: null }; }
    if (options.body.action === 'publish') return onPublish(options.body);
    // G1 TASK 48: resume / reconcile answers a test scripts (otherwise the old empty answer).
    if (onAction) { const scripted = await onAction(options.body, state); if (scripted) return scripted; }
    return { data: null, error: null };
  };
  const auth = { session: { access_token: 'user-jwt-fixture', user: { id: 'user-1' } } };
  const stubs = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text', View: 'View', TextInput: 'TextInput', Pressable: 'Pressable', Linking: { openURL: () => {} } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i', success: 's', danger: 'd', border: 'b', muted: 'm', primary: 'p' } },
    '@/domain/threads-manual-publish': domain,
    '@/lib/supabase': { supabase: { functions: { invoke } } },
    '@/providers/auth-provider': { useAuth: () => ({ session: auth.session }) },
    'expo-crypto': { randomUUID: () => KEY },
    // G1 TASK 48: the reconnect entry is the connect card (its own tests drive it), as an element here.
    '@/features/threads-connect/threads-connect-card': { ThreadsConnectCard: 'ThreadsConnectCard' },
  };
  const load = async (path) => {
    const module = { exports: {} };
    const require = (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; };
    vm.runInNewContext(transpileCjs(await read(path)), { module, exports: module.exports, require, Response, console }, { filename: path });
    return module.exports;
  };
  stubs['@/features/threads-publish/use-threads-manual-publish'] = await load('src/features/threads-publish/use-threads-manual-publish.ts');
  stubs['@/features/threads-publish/threads-recovery-copy'] = await load('src/features/threads-publish/threads-recovery-copy.ts');
  const card = await load('src/features/threads-publish/threads-publish-card.tsx');
  const props = { account: acct, preview, releaseEnabled };
  const render = () => { cursor = 0; effects = []; const tree = card.ThreadsPublishCard(props); const run = effects; effects = []; run.forEach((e) => e()); return tree; };
  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
  return { render, props, calls, state, auth, settle };
}
const walk = (node, visit) => { if (Array.isArray(node)) return node.forEach((c) => walk(c, visit)); if (node === null || typeof node !== 'object') return; visit(node); walk(node.props?.children, visit); };
const texts = (tree) => { const out = []; walk(tree, (n) => { if (['Text', 'Pill'].includes(n.type)) out.push([n.props.children].flat().filter((c) => typeof c === 'string' || typeof c === 'number').join('')); }); return out; };
const buttons = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'ActionButton') out.push(n.props); }); return out; };
const button = (tree, label) => buttons(tree).find((b) => b.label.includes(label));
const input = (tree) => { let found = null; walk(tree, (n) => { if (n.type === 'TextInput') found = n.props; }); return found; };

test('release flag OFF (the default): "in preparation", no input, no button, no request at all', async () => {
  const h = await cardHarness({ releaseEnabled: null }); // the card's own default: the source flag
  const tree = h.render();
  await h.settle();
  assert.ok(texts(h.render()).some((t) => t.includes('準備中')));
  assert.equal(input(tree), null);
  assert.equal(buttons(tree).length, 0);
  assert.equal(h.calls.length, 0);
});

test('an X account gets no Threads card', async () => {
  const h = await cardHarness({ acct: account({ platform: 'x' }) });
  assert.equal(h.render(), null);
});

test('preview: the composer is visible but nothing can be sent and nothing is requested', async () => {
  const h = await cardHarness({ preview: true });
  const tree = h.render();
  await h.settle();
  assert.ok(input(tree));
  assert.equal(button(tree, 'プレビューのため').disabled, true);
  assert.equal(button(tree, '投稿内容を確認'), undefined);
  assert.equal(h.calls.length, 0);
});

test('consent first: the account shows what will happen, and the permission is requested against the seen state', async () => {
  const h = await cardHarness({ serverState: { permitted: false, open_attempt: null, last_attempt: null } });
  h.render();
  await h.settle();
  const tree = h.render();
  assert.ok(texts(tree).includes(domain.CONSENT_COPY));
  assert.equal(input(tree), null, 'no composer before consent');
  button(tree, '投稿を許可する').onPress();
  await h.settle();
  const permission = h.calls.find((c) => c.body.action === 'set_permission');
  assert.deepEqual({ ...permission.body }, { action: 'set_permission', social_account_id: 'sa_th_1', desired_enabled: true, expected_current_enabled: false });
  assert.ok(input(h.render()), 'composer after consent (from the reloaded server state)');
});

test('ready: type, confirm, ONE publish with the exact text and key; the result is shown only as the server reports it', async () => {
  const h = await cardHarness();
  h.render();
  await h.settle();
  input(h.render()).onChangeText('はじめてのThreads投稿\r\n2行目');
  let tree = h.render();
  assert.ok(texts(tree).some((t) => t.startsWith('18 / 500')));
  button(tree, '投稿内容を確認').onPress();
  tree = h.render();
  assert.ok(texts(tree).includes(domain.PUBLISH_CONFIRM_COPY));
  assert.equal(h.calls.filter((c) => c.body.action === 'publish').length, 0, 'nothing before the explicit tap');
  const confirm = button(tree, '投稿する');
  confirm.onPress();
  confirm.onPress();
  await h.settle();
  const publishes = h.calls.filter((c) => c.body.action === 'publish');
  assert.equal(publishes.length, 1, 'a double tap sends once');
  assert.deepEqual({ ...publishes[0].body }, { action: 'publish', social_account_id: 'sa_th_1', idempotency_key: KEY, text: 'はじめてのThreads投稿\n2行目' });
  assert.equal(publishes[0].auth, 'Bearer user-jwt-fixture');
  tree = h.render();
  assert.ok(texts(tree).includes('Threadsに投稿しました'));
  assert.ok(texts(tree).includes('Threadsで投稿を見る'));
});

test('a provider id without read-back is NOT shown as posted', async () => {
  const h = await cardHarness({ onPublish: async () => ({ data: { success: true, attempt: attempt({ status: 'publish_returned', permalink: null }) }, error: null }) });
  h.render();
  await h.settle();
  input(h.render()).onChangeText('テスト');
  button(h.render(), '投稿内容を確認').onPress();
  button(h.render(), '投稿する').onPress();
  await h.settle();
  const shown = texts(h.render());
  assert.ok(!shown.includes('Threadsに投稿しました'));
  assert.ok(shown.includes('Threadsの返答を確認しています'));
});

test('a confirmation opened for account A sends nothing once the card shows account B', async () => {
  const h = await cardHarness();
  h.render();
  await h.settle();
  input(h.render()).onChangeText('Aに投稿');
  button(h.render(), '投稿内容を確認').onPress();
  const stale = button(h.render(), '投稿する');
  h.props.account = account({ id: 'sa_th_2' });
  h.render();
  stale.onPress();
  await h.settle();
  assert.equal(h.calls.filter((c) => c.body.action === 'publish').length, 0);
});

test('a refusal shows safe copy and keeps the text; nothing is resent', async () => {
  const response = new Response(JSON.stringify({ success: false, error: 'MANUAL_PUBLISH_NOT_PERMITTED' }), { status: 409 });
  const h = await cardHarness({ onPublish: async () => ({ data: null, error: { context: response } }) });
  h.render();
  await h.settle();
  input(h.render()).onChangeText('テスト');
  button(h.render(), '投稿内容を確認').onPress();
  button(h.render(), '投稿する').onPress();
  await h.settle();
  const tree = h.render();
  assert.ok(texts(tree).some((t) => t.includes('まだ許可されていません')));
  assert.equal(h.calls.filter((c) => c.body.action === 'publish').length, 1);
});

test('an open uncertain attempt blocks the composer and offers only a read-only check', async () => {
  const open = attempt({ status: 'uncertain', provider_post_id: null, permalink: null, error_code: 'THREADS_UNAVAILABLE' });
  const h = await cardHarness({ serverState: { permitted: true, open_attempt: open, last_attempt: null } });
  h.render();
  await h.settle();
  const tree = h.render();
  assert.equal(input(tree), null, 'no new post while one is uncertain');
  assert.ok(button(tree, '確認する'));
  button(tree, '確認する').onPress();
  await h.settle();
  const reconcile = h.calls.find((c) => c.body.action === 'reconcile');
  assert.deepEqual({ ...reconcile.body }, { action: 'reconcile', attempt_id: ATTEMPT_ID });
  assert.equal(h.calls.filter((c) => c.body.action === 'publish').length, 0);
});

// ---- G1 TASK 48: G4's contract on the real card (docs/postona/threads-connect-publish-contract-for-g1-g3-20261113.md) ------------
const recovery = await import('../src/features/threads-publish/threads-recovery-copy.ts');
const refused = (code, status = 409) => ({ data: null, error: { context: new Response(JSON.stringify({ error: code }), { status, headers: { 'content-type': 'application/json' } }) } });
const elements = (tree, type) => { const out = []; walk(tree, (n) => { if (n.type === type) out.push(n.props); }); return out; };
const sends = (h, action) => h.calls.filter((c) => c.body.action === action).length;
async function shown(h) { h.render(); await h.settle(); return h.render(); }

test('T48 uncertain + 確認する refused 409 CREDENTIALS_EXPIRED: the requested copy, a reconnect entry for THIS account (same Threads account), no new post, nothing resent', async () => {
  const open = attempt({ status: 'uncertain', provider_post_id: null, permalink: null, error_code: null });
  const h = await cardHarness({ serverState: { permitted: true, open_attempt: open, last_attempt: null }, onAction: (body) => (body.action === 'reconcile' ? refused('CREDENTIALS_EXPIRED') : null) });
  const reloads = [];
  Object.assign(h.props, { accounts: [account()], reload: () => reloads.push(1), refreshKey: 0 });
  let tree = await shown(h);
  assert.equal(elements(tree, 'ThreadsConnectCard').length, 0, 'no reconnect entry before the refusal');
  button(tree, '確認する').onPress();
  await h.settle();
  tree = h.render();
  assert.ok(texts(tree).includes(recovery.UNCERTAIN_EXPIRED_COPY), texts(tree).join(' / '));
  const [entry] = elements(tree, 'ThreadsConnectCard');
  assert.ok(entry, 'the reconnect entry is offered on this card');
  assert.deepEqual([entry.threadsAccount.connectionStatus, entry.openPost, entry.accounts.length], ['needs_attention', true, 1]);
  assert.equal(input(tree), null, 'still no new post while the outcome is unknown');
  assert.equal(sends(h, 'publish'), 0, 'nothing resent');
  assert.equal(sends(h, 'reconcile'), 1);
  assert.ok(!texts(tree).some((t) => t.includes('投稿しました')), 'never shown as posted');
});

test('T48 after the reconnect the screen reads the accounts again (refreshKey): the card reads its state again, the old refusal and entry go, the settled post shows without a link', async () => {
  const open = attempt({ status: 'uncertain', provider_post_id: null, permalink: null, error_code: null });
  const h = await cardHarness({ serverState: { permitted: true, open_attempt: open, last_attempt: null }, onAction: (body) => (body.action === 'reconcile' ? refused('CREDENTIALS_EXPIRED') : null) });
  Object.assign(h.props, { accounts: [account()], reload: () => {}, refreshKey: 3 });
  let tree = await shown(h);
  button(tree, '確認する').onPress();
  await h.settle();
  assert.equal(elements(h.render(), 'ThreadsConnectCard').length, 1);
  // G4's reconnect recovery settled the post from the container: published, but which post is not provable (no id, no link)
  Object.assign(h.state, { open_attempt: null, last_attempt: attempt({ status: 'published_unidentified', provider_post_id: null, permalink: PERMALINK, error_code: 'PUBLISHED_POST_NOT_FOUND' }) });
  const reads = sends(h, 'account_state');
  h.props.refreshKey = 4;
  tree = await shown(h);
  assert.ok(sends(h, 'account_state') > reads, 'read again (this harness re-runs callbacks\' effects on each render, so only "again" is asserted)');
  assert.equal(elements(tree, 'ThreadsConnectCard').length, 0, 'the entry goes with the old refusal');
  assert.ok(!texts(tree).includes(recovery.UNCERTAIN_EXPIRED_COPY));
  assert.ok(texts(tree).includes('Threadsへの投稿は確認できました'));
  assert.ok(!texts(tree).includes('Threadsで投稿を見る'), 'published_unidentified never gets a link, even if one were sent');
  assert.ok(input(tree), 'a new post may begin');
  assert.equal(sends(h, 'publish'), 0);
});

test('T48 a publish refused CREDENTIALS_EXPIRED (no open post): the refusal copy and the reconnect entry without the open-post note; the text is kept', async () => {
  const h = await cardHarness({ onPublish: async () => refused('CREDENTIALS_EXPIRED') });
  Object.assign(h.props, { accounts: [account()], reload: () => {} });
  let tree = await shown(h);
  input(tree).onChangeText('期限切れの前の投稿');
  tree = h.render();
  button(tree, '投稿内容を確認する').onPress();
  tree = h.render();
  button(tree, '投稿する').onPress();
  await h.settle();
  tree = h.render();
  assert.ok(texts(tree).includes(domain.threadsRefusal({ error: 'CREDENTIALS_EXPIRED' }).message));
  const [entry] = elements(tree, 'ThreadsConnectCard');
  assert.equal(entry?.openPost, false);
  assert.equal(input(tree)?.value, '期限切れの前の投稿');
  assert.equal(sends(h, 'publish'), 1, 'one send, not repeated');
});

test('T48 no entry where it does not belong: a screen without accounts/reload, flag OFF, preview, other refusals', async () => {
  const open = attempt({ status: 'uncertain', provider_post_id: null, permalink: null, error_code: null });
  const bare = await cardHarness({ serverState: { permitted: true, open_attempt: open, last_attempt: null }, onAction: (body) => (body.action === 'reconcile' ? refused('CREDENTIALS_EXPIRED') : null) });
  let tree = await shown(bare);
  button(tree, '確認する').onPress();
  await bare.settle();
  tree = bare.render();
  assert.ok(texts(tree).includes(recovery.UNCERTAIN_EXPIRED_COPY));
  assert.equal(elements(tree, 'ThreadsConnectCard').length, 0, 'no accounts / reload given: no entry');
  const busy = await cardHarness({ serverState: { permitted: true, open_attempt: open, last_attempt: null }, onAction: (body) => (body.action === 'reconcile' ? refused('PUBLISH_IN_PROGRESS') : null) });
  Object.assign(busy.props, { accounts: [account()], reload: () => {} });
  tree = await shown(busy);
  button(tree, '確認する').onPress();
  await busy.settle();
  assert.equal(elements(busy.render(), 'ThreadsConnectCard').length, 0, 'a refusal another way out is not a reconnect');
  for (const options of [{ releaseEnabled: false }, { preview: true }]) {
    const h = await cardHarness(options);
    Object.assign(h.props, { accounts: [account()], reload: () => {} });
    tree = await shown(h);
    assert.equal(elements(tree, 'ThreadsConnectCard').length, 0, JSON.stringify(options));
    assert.equal(h.calls.length, 0, `${JSON.stringify(options)}: no request`);
  }
});

test('T48 person A -> B on the same account: A\'s answer, refusal and state are never shown to B; B\'s state is read with B\'s token', async () => {
  const open = attempt({ status: 'uncertain', provider_post_id: null, permalink: null, error_code: null });
  const h = await cardHarness({ serverState: { permitted: true, open_attempt: open, last_attempt: null }, onAction: (body) => (body.action === 'reconcile' ? refused('CREDENTIALS_EXPIRED') : null) });
  Object.assign(h.props, { accounts: [account()], reload: () => {} });
  let tree = await shown(h);
  button(tree, '確認する').onPress();
  await h.settle();
  assert.ok(texts(h.render()).includes(recovery.UNCERTAIN_EXPIRED_COPY));
  h.auth.session = { access_token: 'user-2-jwt-fixture', user: { id: 'user-2' } };
  Object.assign(h.state, { open_attempt: null, last_attempt: null });
  const frames = [h.render()];
  await h.settle();
  frames.push(h.render());
  for (const f of frames) {
    assert.ok(!texts(f).includes(recovery.UNCERTAIN_EXPIRED_COPY), 'A\'s refusal is not B\'s');
    assert.equal(elements(f, 'ThreadsConnectCard').length, 0);
    assert.ok(!texts(f).includes('投稿されたか確認できていません'), 'A\'s open post is not shown to B');
  }
  assert.equal(h.calls.at(-1).auth, 'Bearer user-2-jwt-fixture');
});

test('T48 a lost answer to a publish: the next state read shows the open attempt; no new post, repeated taps of 確認する send one request at a time', async () => {
  let held = null;
  const open = attempt({ status: 'uncertain', provider_post_id: null, permalink: null, error_code: null });
  const h = await cardHarness({
    onPublish: async () => { h.state.open_attempt = open; return { data: null, error: new TypeError('Network request failed') }; },
    onAction: (body) => (body.action === 'reconcile' ? new Promise((resolve) => { held = resolve; }) : null),
  });
  let tree = await shown(h);
  input(tree).onChangeText('答えの消えた投稿');
  tree = h.render();
  button(tree, '投稿内容を確認する').onPress();
  button(h.render(), '投稿する').onPress();
  await h.settle();
  tree = h.render();
  assert.equal(input(tree), null, 'the open attempt blocks the composer');
  assert.equal(sends(h, 'publish'), 1);
  const check = button(tree, '確認する');
  check.onPress(); check.onPress(); check.onPress();
  await h.settle();
  assert.equal(sends(h, 'reconcile'), 1, 'one at a time');
  held({ data: { success: true, attempt: open }, error: null });
  await h.settle();
  assert.equal(sends(h, 'publish'), 1, 'never resent');
});

test('T48 with React\'s stable callbacks: the state is read once per refreshKey change, not on every render', async () => {
  const h = await cardHarness({ stableCallbacks: true });
  Object.assign(h.props, { accounts: [account()], reload: () => {}, refreshKey: 1 });
  await shown(h);
  const reads = sends(h, 'account_state');
  await shown(h);
  assert.equal(sends(h, 'account_state'), reads, 'no new read without a new account-data read');
  h.props.refreshKey = 2;
  await shown(h);
  assert.equal(sends(h, 'account_state'), reads + 1, 'one read for the new account-data read');
});

test('T48 A\'s posted answer is not shown to B; an answer to A that arrives after B signed in is dropped', async () => {
  const h = await cardHarness({ serverState: { permitted: true, open_attempt: null, last_attempt: null } });
  let tree = await shown(h);
  input(tree).onChangeText('Aの投稿');
  button(h.render(), '投稿内容を確認する').onPress();
  button(h.render(), '投稿する').onPress();
  await h.settle();
  assert.ok(texts(h.render()).includes('Threadsに投稿しました'), 'A sees A\'s answer');
  h.auth.session = { access_token: 'user-2-jwt-fixture', user: { id: 'user-2' } };
  await h.settle();
  assert.ok(!texts(h.render()).includes('Threadsに投稿しました'), 'B does not');

  let held = null;
  const open = attempt({ status: 'uncertain', provider_post_id: null, permalink: null, error_code: null });
  const late = await cardHarness({ serverState: { permitted: true, open_attempt: open, last_attempt: null }, onAction: (body) => (body.action === 'reconcile' ? new Promise((resolve) => { held = resolve; }) : null) });
  Object.assign(late.props, { accounts: [account()], reload: () => {} });
  tree = await shown(late);
  button(tree, '確認する').onPress();
  await late.settle();
  late.auth.session = { access_token: 'user-2-jwt-fixture', user: { id: 'user-2' } };
  Object.assign(late.state, { open_attempt: null });
  late.render();
  held(refused('CREDENTIALS_EXPIRED'));
  await late.settle();
  tree = late.render();
  assert.ok(!texts(tree).includes(recovery.UNCERTAIN_EXPIRED_COPY), 'A\'s late refusal is not shown to B');
  assert.equal(elements(tree, 'ThreadsConnectCard').length, 0);
});
