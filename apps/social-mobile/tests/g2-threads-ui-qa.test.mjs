// G2 independent QA (2026-10-19, Issue #317 G2-01): the Threads connect / manual publish / disconnect screens of
// Draft PRs #140 -> #144 -> #154 -> #167, driven offline through their REAL hook and card sources (transpiled) with
// stubbed React / React Native / Supabase. Nothing here reaches Threads, Meta, Supabase or any network: every server
// answer is injected. Tests named "FINDING" reproduce the current behaviour of a defect handed to its owner (G4/F4);
// they pin what the source does today, so a fix is expected to change them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as publishDomain from '../src/domain/threads-manual-publish.ts';
import * as connectDomain from '../src/domain/threads-connect.ts';
import * as disconnectDomain from '../src/domain/threads-disconnect.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
async function load(path, stubs) {
  const module = { exports: {} };
  const require = (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; };
  vm.runInNewContext(transpile(await read(path)), { module, exports: module.exports, require, Response, URL, URLSearchParams }, { filename: path });
  return module.exports;
}
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };
const walk = (node, visit) => { if (Array.isArray(node)) return node.forEach((c) => walk(c, visit)); if (node === null || typeof node !== 'object') return; visit(node); walk(node.props?.children, visit); };
const texts = (tree) => { const out = []; walk(tree, (n) => { if (['Text', 'Pill'].includes(n.type)) out.push([n.props.children].flat().filter((c) => typeof c === 'string' || typeof c === 'number').join('')); }); return out; };
const buttons = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'ActionButton') out.push(n.props); }); return out; };
const button = (tree, label) => buttons(tree).find((b) => b.label.includes(label));
const input = (tree) => { let found = null; walk(tree, (n) => { if (n.type === 'TextInput') found = n.props; }); return found; };

function hooks() {
  const slots = []; const deps = []; let cursor = 0; let effects = [];
  const react = {
    useLayoutEffect: (effect) => { effects.push(effect); },
    useEffect: (effect, d) => { const i = cursor++; const prev = deps[i]; if (!prev || d.some((v, k) => v !== prev[k])) { deps[i] = d; effects.push(effect); } },
    useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback: (cb) => { cursor++; return cb; },
  };
  const jsx = (type, props) => ({ type: typeof type === 'function' ? type.name : type, props });
  const render = (fn) => { cursor = 0; effects = []; const tree = fn(); const run = effects; effects = []; run.forEach((e) => e()); return tree; };
  return { react, runtime: { jsx, jsxs: jsx, Fragment: 'Fragment' }, render };
}

const USER = '00000000-0000-4000-8000-0000000000a1';
const OTHER_USER = '00000000-0000-4000-8000-0000000000b2';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000001';
const PERMALINK = 'https://www.threads.net/@postona_g2/post/G2qa_1';
const threads = (over = {}) => ({ id: 'sa_th_1', platform: 'threads', profile: { displayName: 'G2検証', handle: '@postona_g2', avatarColor: '#000', voice: { tone: '', language: '', avoid: [] } }, connectionStatus: 'connected', postingState: 'paused', ...over });
const attempt = (over = {}) => ({ id: ATTEMPT_ID, social_account_id: 'sa_th_1', status: 'published', provider_post_id: '17890000000000003', permalink: PERMALINK, error_code: null, replayed: false, ...over });

// ---------------------------------------------------------------- publish card harness

async function publishCard({ acct = threads(), releaseEnabled = true, preview = false, server = { permitted: true, open_attempt: null, last_attempt: null }, onPublish, user = USER } = {}) {
  const h = hooks();
  const calls = [];
  const state = { ...server };
  let keySeq = 0;
  const invoke = async (name, options) => {
    calls.push({ name, body: { ...options.body }, auth: options.headers.Authorization });
    if (options.body.action === 'account_state') {
      if (state.unavailable) return { data: null, error: {} };
      return { data: { success: true, account: { id: acct.id, manual_publish_permitted: state.permitted, open_attempt: state.open_attempt, last_attempt: state.last_attempt } }, error: null };
    }
    if (options.body.action === 'publish') return onPublish(options.body, state);
    return { data: null, error: {} };
  };
  const auth = { session: { access_token: 'user-jwt-fixture', user: { id: user } } };
  const stubs = {
    react: h.react, 'react/jsx-runtime': h.runtime,
    'react-native': { Text: 'Text', View: 'View', TextInput: 'TextInput', Pressable: 'Pressable', Linking: { openURL: () => { throw new Error('no link may open in QA'); } } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i', success: 's', danger: 'd', border: 'b', muted: 'm', primary: 'p' } },
    '@/domain/threads-manual-publish': publishDomain,
    '@/lib/supabase': { supabase: { functions: { invoke } } },
    '@/providers/auth-provider': { useAuth: () => ({ session: auth.session }) },
    // A distinct, valid v4 UUID per call, so a re-confirmation is distinguishable from a same-key retry.
    'expo-crypto': { randomUUID: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++keySeq).padStart(12, '0')}` },
  };
  stubs['@/features/threads-publish/use-threads-manual-publish'] = await load('src/features/threads-publish/use-threads-manual-publish.ts', stubs);
  const card = await load('src/features/threads-publish/threads-publish-card.tsx', stubs);
  const props = { account: acct, preview };
  if (releaseEnabled !== null) props.releaseEnabled = releaseEnabled;
  return { render: () => h.render(() => card.ThreadsPublishCard(props)), props, calls, state, auth };
}
const publishes = (calls) => calls.filter((c) => c.body.action === 'publish');

async function typeAndSend(c, text) {
  c.render();
  await settle();
  input(c.render()).onChangeText(text);
  button(c.render(), '投稿内容を確認').onPress();
  const send = button(c.render(), '投稿する');
  send.onPress();
  send.onPress(); // a double tap must still be one request
  await settle();
}

// ---------------------------------------------------------------- gate OFF: nothing reaches a server

test('gate OFF (source flags): publish / connect / disconnect release flags are all false', () => {
  assert.equal(publishDomain.THREADS_MANUAL_PUBLISH_UI_ENABLED, false);
  assert.equal(connectDomain.THREADS_CONNECT_UI_ENABLED, false);
  assert.equal(disconnectDomain.THREADS_DISCONNECT_UI_ENABLED, false);
});

test('gate OFF: the publish card for every account state offers no input and sends zero requests', async () => {
  for (const acct of [threads(), threads({ connectionStatus: 'needs_attention' }), threads({ connectionStatus: 'not_connected' })]) {
    const c = await publishCard({ acct, releaseEnabled: null, onPublish: async () => { throw new Error('must not publish'); } });
    const tree = c.render();
    await settle();
    assert.equal(input(tree), null, acct.connectionStatus);
    assert.equal(buttons(c.render()).length, 0, acct.connectionStatus);
    assert.ok(texts(c.render()).some((t) => t.includes('準備中')));
    assert.equal(c.calls.length, 0, `no request for ${acct.connectionStatus}`);
  }
});

test('gate OFF: the connect card button is disabled and pressing its handler starts nothing', async () => {
  const h = hooks();
  let started = 0;
  const stubs = {
    react: h.react, 'react/jsx-runtime': h.runtime, 'react-native': { Text: 'Text' },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i' } },
    '@/domain/threads-connect': connectDomain,
    '@/providers/auth-provider': { useAuth: () => ({ session: { access_token: 'jwt', user: { id: USER } } }) },
    '@/features/threads-connect/threads-connect-runtime': { productionThreadsConnectDeps: () => { throw new Error('production flow must not be built'); } },
    '@/features/threads-connect/threads-connect-starter': { createThreadsConnectStarter: () => { throw new Error('production flow must not be built'); } },
  };
  stubs['@/features/threads-connect/use-threads-connect'] = await load('src/features/threads-connect/use-threads-connect.ts', stubs);
  const card = await load('src/features/threads-connect/threads-connect-card.tsx', stubs);
  for (const threadsAccount of [null, threads({ connectionStatus: 'needs_attention' })]) {
    const props = { threadsAccount, accounts: threadsAccount ? [threadsAccount] : [], reload: () => {}, preview: false, starter: { start: async () => { started += 1; return { kind: 'canceled' }; } } };
    const tree = h.render(() => card.ThreadsConnectCard(props));
    const b = buttons(tree)[0];
    assert.equal(b.disabled, true);
    assert.match(b.label, /（準備中）/u);
    await b.onPress();
    await settle();
  }
  assert.equal(started, 0);
});

// ---------------------------------------------------------------- publish: unknown / uncertain / cross-account

test('a lost publish answer is never auto-resent; while the server shows the attempt open, the composer is hidden', async () => {
  const c = await publishCard({ onPublish: async (_body, state) => { state.open_attempt = attempt({ status: 'publishing', provider_post_id: null, permalink: null }); return { data: null, error: {} }; } });
  await typeAndSend(c, '通信が切れる投稿');
  const tree = c.render();
  assert.equal(publishes(c.calls).length, 1, 'one request; nothing resent by the app');
  assert.equal(input(tree), null, 'busy: no composer');
  assert.ok(texts(tree).includes('Threadsへ投稿しています…'));
  assert.ok(!texts(tree).includes('Threadsに投稿しました'));
});

test('a lost publish answer with an unreadable server state: no composer, nothing claims success', async () => {
  const c = await publishCard({ onPublish: async (_body, state) => { state.unavailable = true; return { data: null, error: {} }; } });
  await typeAndSend(c, '状態も読めない投稿');
  const tree = c.render();
  assert.equal(publishes(c.calls).length, 1);
  assert.equal(input(tree), null);
  assert.ok(!texts(tree).includes('Threadsに投稿しました'));
});

test('an answer about ANOTHER account is not an answer: nothing is shown as posted for this one', async () => {
  const c = await publishCard({ onPublish: async () => ({ data: { success: true, attempt: attempt({ social_account_id: 'sa_th_other' }) }, error: null }) });
  await typeAndSend(c, '別アカウントの返答');
  const shown = texts(c.render());
  assert.ok(!shown.includes('Threadsに投稿しました'));
  assert.equal(publishes(c.calls).length, 1);
  assert.equal(publishes(c.calls)[0].body.social_account_id, 'sa_th_1', 'sent only for the shown account');
});

test('uncertain: the only action is a read-only check (reconcile); no publish is offered or sent', async () => {
  const open = attempt({ status: 'uncertain', provider_post_id: null, permalink: null });
  const c = await publishCard({ server: { permitted: true, open_attempt: open, last_attempt: null }, onPublish: async () => { throw new Error('must not publish'); } });
  c.render();
  await settle();
  const tree = c.render();
  assert.equal(input(tree), null);
  assert.deepEqual(buttons(tree).map((b) => b.label), ['確認する']);
  assert.equal(publishes(c.calls).length, 0);
});

test('a different signed-in person: a confirmation pinned for user A is never sent as user B', async () => {
  const c = await publishCard();
  c.render();
  await settle();
  input(c.render()).onChangeText('Aの確認');
  button(c.render(), '投稿内容を確認').onPress();
  const stale = button(c.render(), '投稿する');
  c.auth.session = { access_token: 'jwt-b', user: { id: OTHER_USER } };
  c.render();
  stale.onPress();
  await settle();
  assert.equal(publishes(c.calls).length, 0);
});

test('FINDING G2-T1 (P2, owner G4): after a lost answer the post may already be public, yet the old text stays and a re-confirm sends a SECOND publish with a NEW idempotency key', async () => {
  // The server posted it (the read-back shows it as the last attempt), but the app never got the answer.
  const c = await publishCard({ onPublish: async (_body, state) => {
    if (!state.posted) { state.posted = true; state.last_attempt = attempt(); return { data: null, error: {} }; }
    return { data: { success: true, attempt: attempt({ id: '00000000-0000-4000-8000-000000000002' }) }, error: null };
  } });
  await typeAndSend(c, '一度だけ公開したい投稿');
  let tree = c.render();
  assert.ok(texts(tree).includes('Threadsに投稿しました'), 'the read-back shows the post as public');
  assert.ok(texts(tree).some((t) => t.includes('「確認する」で確かめられます')), 'the message points at a 確認する button…');
  assert.equal(buttons(tree).find((b) => b.label === '確認する'), undefined, '…that is not on screen (published attempts offer no check)');
  assert.equal(input(tree).value, '一度だけ公開したい投稿', 'the published text is still in the composer');
  assert.equal(button(tree, '投稿内容を確認').disabled, false, 'and can be confirmed again');
  button(tree, '投稿内容を確認').onPress();
  button(c.render(), '投稿する').onPress();
  await settle();
  const sent = publishes(c.calls);
  assert.equal(sent.length, 2, 'a second publish of the same text is sent');
  assert.equal(sent[0].body.text, sent[1].body.text);
  assert.notEqual(sent[0].body.idempotency_key, sent[1].body.idempotency_key, 'with a fresh key, so the server cannot treat it as a retry');
});

// ---------------------------------------------------------------- disconnect: verification step

async function disconnectCard(props) {
  const h = hooks();
  const stubs = {
    react: h.react, 'react/jsx-runtime': h.runtime, 'react-native': { Text: 'Text', View: 'View' },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i' } },
    '@/domain/threads-disconnect': disconnectDomain,
    '@/providers/auth-provider': { useAuth: () => ({ session: { access_token: 'jwt', user: { id: USER } } }) },
    '@/features/threads-disconnect/threads-disconnect-runtime': { productionThreadsDisconnectDeps: () => { throw new Error('production flow must not be built'); } },
    '@/features/threads-disconnect/threads-disconnect-runner': { createThreadsDisconnector: () => { throw new Error('unused'); } },
  };
  stubs['@/features/threads-disconnect/use-threads-disconnect'] = await load('src/features/threads-disconnect/use-threads-disconnect.ts', stubs);
  const card = await load('src/features/threads-disconnect/threads-disconnect-card.tsx', stubs);
  return { render: () => h.render(() => card.ThreadsDisconnectCard(props)), props };
}

test('gate OFF: the disconnect button is disabled and pressing its handler opens no confirmation and sends nothing', async () => {
  let sent = 0;
  const acct = threads();
  const c = await disconnectCard({ threadsAccount: acct, accounts: [acct], reload: () => {}, preview: false, disconnector: { disconnect: async () => { sent += 1; return { kind: 'disconnected' }; } } });
  const b = button(c.render(), 'Threads連携を解除（準備中）');
  assert.equal(b.disabled, true);
  b.onPress();
  await settle();
  assert.equal(button(c.render(), '解除する'), undefined);
  assert.equal(sent, 0);
});

test('FINDING G2-T2 (P3, owner F4): while the account list reloads (it is empty until loaded), the card already says "解除しました" — the read-back check is skipped', async () => {
  const acct = threads();
  const c = await disconnectCard({ threadsAccount: acct, accounts: [acct], reload: () => {}, preview: false, releaseEnabled: true,
    disconnector: { disconnect: async () => ({ kind: 'disconnected' }) } });
  button(c.render(), 'Threads連携を解除').onPress();
  await button(c.render(), '解除する').onPress();
  await settle();
  assert.ok(texts(c.render()).includes('解除を確認しています…'));
  // ActiveAccountProvider gives [] while DataProvider is "loading" / "unavailable" — the same as "the account is gone".
  c.props.accounts = [];
  c.props.threadsAccount = null;
  const during = texts(c.render());
  assert.ok(during.includes(disconnectDomain.disconnectResultLines({ kind: 'disconnected' }).local), 'claims the removal before any read-back');
  // The reload then still shows the account: the claim is withdrawn again.
  c.props.accounts = [acct];
  c.props.threadsAccount = acct;
  assert.ok(texts(c.render()).includes('解除を確認しています…'));
});
