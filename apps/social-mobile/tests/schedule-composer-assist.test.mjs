// G1 TASK 26: the REAL schedule-composer.tsx (transpiled) with stubbed React/RN and a scripted stand-in of supabase-js
// functions.invoke for POST /functions/v1/postona-post-assist (non-production: nothing leaves the process). Proves on the
// screen code that the three AI actions only ever fill editable suggestions, that a row's text changes only when the
// person adopts one (and can be undone), that answers for a cancelled request / another session / another workspace /
// a removed row are dropped, that the same Idempotency-Key is re-sent only for retry_same_key, and that the manual
// preview flow keeps working when the AI cannot be used. Nothing here can schedule or post.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as planner from '../src/domain/schedule-planner.ts';
import * as assistModule from '../src/features/schedule/post-assist.ts';

const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'];
const savedGlobals = new Map();
let trapped = 0;
test.before(() => {
  for (const name of NETWORK) {
    savedGlobals.set(name, globalThis[name]);
    globalThis[name] = function forbidden() { trapped += 1; throw new Error(`network entry point ${name} must not be used`); };
  }
});
test.after(() => {
  for (const name of NETWORK) {
    if (savedGlobals.get(name) === undefined) delete globalThis[name];
    else globalThis[name] = savedGlobals.get(name);
  }
  assert.equal(trapped, 0);
});

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node === null || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
};
const flat = (children) => [children].flat(Infinity).filter((c) => typeof c === 'string' || typeof c === 'number').join('');
const texts = (tree) => { const out = []; walk(tree, (n) => { if (['Text', 'Pill'].includes(n.type)) out.push(flat(n.props.children)); }); return out; };
const has = (tree, fragment) => texts(tree).some((t) => t.includes(fragment));
const small = (tree, label) => { const out = []; walk(tree, (n) => { if (n.type === 'SmallButton' && n.props.label === label) out.push(n.props); }); return out; };
const choice = (tree, label) => { let found; walk(tree, (n) => { if (n.type === 'Choice' && n.props.label === label) found = n.props; }); return found; };
const action = (tree, label) => { let found; walk(tree, (n) => { if (n.type === 'ActionButton' && n.props.label === label) found = n.props; }); return found; };
const field = (tree, label) => { let found; walk(tree, (n) => { if (n.type === 'TextInput' && n.props.accessibilityLabel === label) found = n.props; }); return found; };
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const NOTICE = '投稿する前に確認・編集してください';
const candidate = (text, hashtags = [], over = {}) => ({ platform: 'x', text, hashtags, length: 40, limit: 280, editable: true, requiresUserConfirmation: true, ...over });
const ok = (...candidates) => ({ status: 200, body: { candidates, notice: NOTICE } });
const fail = (status, error, retry = false) => ({ status, body: { error, retry_same_key: retry } });

/** Mounts the real composer. `answers` are taken in order; `hold: true` keeps a call pending until `release()`. */
async function mount({ status = 'ready', workspaceId = 'u_1', brandId = 'u_1', signedIn = true, client = true } = {}) {
  const slots = []; let cursor = 0; const effects = []; // effects: { deps, cleanup }
  const pendingEffects = [];
  const slot = (init) => { const i = cursor++; if (!(i in slots)) slots[i] = init(); return i; };
  const react = {
    useState: (initial) => { const i = slot(() => (typeof initial === 'function' ? initial() : initial)); return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => slots[slot(() => ({ current: initial }))],
    useEffect: (effect, deps) => {
      const i = cursor++;
      const previous = effects[i];
      const changed = !previous || !deps || deps.length !== previous.deps.length || deps.some((d, k) => !Object.is(d, previous.deps[k]));
      if (changed) pendingEffects.push({ i, effect, deps });
    },
  };
  const world = { status, workspaceId, shownWorkspaceId: workspaceId, userId: signedIn ? 'user-1' : null, token: signedIn ? 'jwt-1' : null };
  const invokes = [];
  const queue = [];
  const held = [];
  const functions = {
    invoke: (name, options) => {
      invokes.push({ name, body: { ...options.body }, headers: { ...options.headers } });
      const answer = queue.shift() ?? { status: 'throw' };
      const respond = () => {
        if (answer.status === 'throw') return Promise.reject(new Error('API unreachable'));
        if (answer.status === 200) return Promise.resolve({ data: answer.body, error: null });
        return Promise.resolve({ data: null, error: { context: new Response(JSON.stringify(answer.body), { status: answer.status }) } });
      };
      if (!answer.hold) return respond();
      return new Promise((resolve, reject) => held.push(() => respond().then(resolve, reject)));
    },
  };
  let uuidN = 0;
  const stubs = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), jsxs: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }) },
    'react-native': { Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    'expo-crypto': { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}` },
    '@/constants/theme': { colors: { primary: 'p', primarySoft: 'ps', surface: 's', border: 'b', ink: 'i' } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', styles: { muted: {} } },
    '@/features/schedule/post-assist': assistModule,
    '@/lib/supabase': { supabase: client ? { functions } : null },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.token ? { access_token: world.token, user: { id: world.userId } } : null }) },
    // The snapshot pins the person's personal workspace (personalWorkspaceId); `workspace` is only what the app shows.
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status, snapshot: { workspace: world.shownWorkspaceId ? { id: world.shownWorkspaceId } : null, personalWorkspaceId: world.workspaceId } }) },
    '@/domain/schedule-planner': planner,
  };
  // Both real files: the composer and its only way to the backend (use-post-assist-env.ts).
  const load = async (path) => {
    const source = await readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const loaded = { exports: {} };
    vm.runInNewContext(js, { module: loaded, exports: loaded.exports, Promise, Date, Response, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name} in ${path}`); return stubs[name]; } }, { filename: path });
    return loaded.exports;
  };
  stubs['@/features/schedule/use-post-assist-env'] = await load('features/schedule/use-post-assist-env.ts');
  const module = { exports: await load('features/schedule/schedule-composer.tsx') };
  const planned = [];
  const props = {
    context: { owner: { accountId: 'acc-1', brandId, platform: 'x' }, now: new Date('2026-10-29T00:00:00Z'), occupied: [] },
    ai: { frequencyTargetPerWeek: 3, approvalMode: 'manual', source: 'default', status: 'unloaded' },
    onPlanned: (result) => planned.push(result),
    onClose: () => {},
  };
  let mounted = true;
  const commit = () => {
    while (pendingEffects.length) {
      const { i, effect, deps } = pendingEffects.shift();
      effects[i]?.cleanup?.();
      effects[i] = { deps: deps ?? [], cleanup: effect() };
    }
  };
  const render = () => { assert.ok(mounted); cursor = 0; const tree = module.exports.ScheduleComposer(props); commit(); return tree; };
  render();
  const unmount = () => { mounted = false; effects.forEach((e) => e?.cleanup?.()); };
  /** Renders until the effects stop changing the state (as React would re-render after an effect's setState). */
  const view = () => { render(); render(); return render(); };
  const release = async () => { held.shift()(); await settle(); };
  return { render: view, renderOnce: render, world, invokes, queue, planned, release, unmount, rowText: (n = 1) => field(view(), `${n}件目の本文`).value };
}

const type = (h, label, value) => field(h.render(), label).onChangeText(value);
const press = (h, label, index = 0) => { const button = small(h.render(), label)[index]; assert.ok(button, `button ${label}`); assert.notEqual(button.disabled, true, `${label} is enabled`); button.onPress(); };
const openWith = (h, mode) => { press(h, 'AIアシスト'); if (mode) choice(h.render(), mode).onPress(); };

test('AIで下書き: one request with the person\'s token and a fresh key; the answer is an editable suggestion, the row only changes on 「本文に使う」, and it can be undone', async () => {
  const h = await mount();
  type(h, '1件目の本文', '手で書いた本文');
  openWith(h);
  type(h, 'AIへのメモ', '金曜に新メニュー。やわらかく');
  h.queue.push(ok(candidate('新メニューが金曜に始まります。', ['#新メニュー']), candidate('金曜から、新しいメニューをどうぞ。')));
  press(h, 'AIに依頼する');
  await settle();
  let tree = h.render();
  assert.equal(h.invokes.length, 1);
  assert.deepEqual(h.invokes[0], {
    name: 'postona-post-assist',
    body: { brand_id: 'u_1', mode: 'draft', platform: 'x', notes: '金曜に新メニュー。やわらかく' },
    headers: { Authorization: 'Bearer jwt-1', 'Idempotency-Key': 'pa-00000000-0000-4000-8000-000000000001' },
  });
  assert.ok(has(tree, NOTICE));
  assert.ok(has(tree, 'ハッシュタグ: #新メニュー'));
  assert.equal(h.rowText(), '手で書いた本文', 'the answer alone never touches the row');
  assert.equal(h.planned.length, 0, 'nothing is planned, scheduled or posted by an answer');
  // The person edits the second suggestion and adopts it.
  type(h, '案2の本文', '金曜から、新しいメニューをどうぞ。ぜひ。');
  press(h, '本文に使う', 1);
  tree = h.render();
  assert.equal(h.rowText(), '金曜から、新しいメニューをどうぞ。ぜひ。');
  assert.ok(has(tree, '確認・編集してから「プレビューを作成」を押してください'));
  assert.equal(small(tree, 'AIに依頼する').length, 0, 'the panel is closed after adopting');
  press(h, '元に戻す');
  assert.equal(h.rowText(), '手で書いた本文');
  assert.equal(h.planned.length, 0);
  assert.equal(h.invokes.length, 1);
});

test('書き直し and ハッシュタグ案: the row text is the draft; tags are appended without changing the text; preview is still the person\'s own press', async () => {
  const h = await mount();
  type(h, '1件目の本文', '今日はカフェで新作を出しました');
  openWith(h, '書き直し');
  type(h, '書き直しの指示', 'もっと短く');
  h.queue.push(ok(candidate('カフェの新作が出ました', ['#カフェ', '#新作'])));
  press(h, 'AIに依頼する');
  await settle();
  assert.deepEqual(h.invokes[0].body, { brand_id: 'u_1', mode: 'refine', platform: 'x', draft: '今日はカフェで新作を出しました', instruction: 'もっと短く' });
  press(h, 'タグ付きで本文に使う');
  assert.equal(h.rowText(), 'カフェの新作が出ました\n\n#カフェ #新作');

  openWith(h, 'ハッシュタグ案');
  h.queue.push(ok(candidate('カフェの新作が出ました\n\n#カフェ #新作', ['#カフェ', '#コーヒー'])));
  press(h, 'AIに依頼する');
  await settle();
  assert.deepEqual(h.invokes[1].body, { brand_id: 'u_1', mode: 'hashtags', platform: 'x', draft: 'カフェの新作が出ました\n\n#カフェ #新作' });
  assert.notEqual(h.invokes[1].headers['Idempotency-Key'], h.invokes[0].headers['Idempotency-Key'], 'a new key per press');
  assert.equal(field(h.render(), '案1の本文'), undefined, 'hashtags mode offers no text to replace the person\'s own');
  press(h, 'タグを本文に追加');
  assert.equal(h.rowText(), 'カフェの新作が出ました\n\n#カフェ #新作\n\n#コーヒー');
  assert.equal(h.planned.length, 0);
  action(h.render(), 'プレビューを作成').onPress();
  assert.equal(h.planned.length, 1, 'only the person\'s preview press plans -- a local preview, nothing is sent');
  assert.equal(h.planned[0].drafts[0].text, 'カフェの新作が出ました\n\n#カフェ #新作\n\n#コーヒー');
  assert.equal(h.invokes.length, 2);
});

test('one request at a time; キャンセル drops the answer (the row stays as it is); after it a new press uses a new key', async () => {
  const h = await mount();
  type(h, '1件目の本文', 'そのままの本文');
  openWith(h, 'ハッシュタグ案');
  h.queue.push({ ...ok(candidate('そのままの本文', ['#a'])), hold: true });
  press(h, 'AIに依頼する');
  let tree = h.render();
  assert.ok(has(tree, 'AIが考えています'));
  assert.equal(small(tree, 'AIに依頼する').length, 0, 'no second request while one is running');
  assert.equal(small(tree, 'AIアシスト')[0].disabled, true);
  assert.equal(choice(tree, 'AIで下書き').disabled, true);
  press(h, 'キャンセル');
  tree = h.render();
  assert.equal(small(tree, 'タグを本文に追加').length, 0);
  assert.equal(h.rowText(), 'そのままの本文');
  // The person can ask again at once, before the cancelled answer has arrived; it never overrides the new one.
  h.queue.push(ok(candidate('そのままの本文', ['#b'])));
  press(h, 'AIに依頼する');
  await settle();
  assert.equal(h.invokes.length, 2);
  assert.notEqual(h.invokes[1].headers['Idempotency-Key'], h.invokes[0].headers['Idempotency-Key']);
  assert.ok(has(h.render(), 'ハッシュタグ: #b'));
  await h.release();
  tree = h.render();
  assert.ok(has(tree, 'ハッシュタグ: #b'));
  assert.ok(!has(tree, 'ハッシュタグ: #a'), 'the cancelled answer is never shown');
  assert.equal(h.rowText(), 'そのままの本文');
});

test('retry_same_key re-sends the very same key and body; new_key_needed / unavailable ask again with a new key', async () => {
  const h = await mount();
  openWith(h);
  type(h, 'AIへのメモ', '最初のメモ');
  h.queue.push(fail(409, 'POST_ASSIST_IN_PROGRESS', true));
  press(h, 'AIに依頼する');
  await settle();
  assert.ok(has(h.render(), '混み合っています'));
  type(h, 'AIへのメモ', '書き換えたメモ');
  h.queue.push(fail(502, 'POST_ASSIST_AI_FAILED'));
  press(h, '再試行');
  await settle();
  assert.deepEqual(h.invokes[1], h.invokes[0], 'same key, same body -- the stored request, not the edited memo');
  assert.ok(has(h.render(), '受け取れませんでした'));
  assert.equal(small(h.render(), '再試行').length, 0, 'no same-key retry after a stored result');
  h.queue.push(fail(503, 'POST_ASSIST_BUSY', false));
  press(h, 'もう一度依頼');
  await settle();
  assert.notEqual(h.invokes[2].headers['Idempotency-Key'], h.invokes[0].headers['Idempotency-Key']);
  assert.equal(h.invokes[2].body.notes, '書き換えたメモ');
  assert.ok(has(h.render(), '手で書いて続けられます'));
  h.queue.push(ok(candidate('できた案')));
  press(h, 'もう一度依頼');
  await settle();
  assert.equal(new Set(h.invokes.map((c) => c.headers['Idempotency-Key'])).size, 3);
  assert.ok(field(h.render(), '案1の本文'));
});

test('relogin / quota / invalid input end without a retry button; a request that is not ready is not sent', async () => {
  const h = await mount();
  openWith(h);
  press(h, 'AIに依頼する');
  assert.ok(has(h.render(), 'AIへのメモを入力してください'));
  assert.equal(h.invokes.length, 0);
  type(h, 'AIへのメモ', 'メモ');
  for (const [answer, words] of [[fail(429, 'POST_ASSIST_QUOTA_EXCEEDED'), '利用上限'], [fail(400, 'POST_ASSIST_REQUEST_INVALID'), '見直してください'], [fail(401, 'POST_ASSIST_AUTH_REQUIRED'), 'ログインし直す']]) {
    h.queue.push(answer);
    press(h, 'AIに依頼する');
    await settle();
    const tree = h.render();
    assert.ok(has(tree, words), words);
    assert.equal(small(tree, '再試行').length + small(tree, 'もう一度依頼').length, 0, words);
  }
  assert.equal(h.invokes.length, 3);
});

test('an answer for another session or workspace is dropped; the panel then refuses to send for a workspace that is not the person\'s own', async () => {
  for (const change of [(w) => { w.userId = 'user-2'; w.token = 'jwt-2'; }, (w) => { w.workspaceId = 'u_2'; }]) {
    const h = await mount();
    type(h, '1件目の本文', '本文');
    openWith(h, 'ハッシュタグ案');
    h.queue.push({ ...ok(candidate('本文', ['#漏れてはいけない'])), hold: true });
    press(h, 'AIに依頼する');
    change(h.world);
    const switched = h.render();
    if (h.world.userId === 'user-2') {
      // The new person is not left waiting on the earlier person's request: they can ask at once.
      assert.ok(!has(switched, 'AIが考えています'));
      h.queue.push(ok(candidate('本文', ['#二人目'])));
      press(h, 'AIに依頼する');
      await settle();
      assert.equal(h.invokes.length, 2);
      assert.equal(h.invokes[1].headers.Authorization, 'Bearer jwt-2', 'the new person\'s own token');
      assert.notEqual(h.invokes[1].headers['Idempotency-Key'], h.invokes[0].headers['Idempotency-Key']);
    }
    await h.release();
    const tree = h.render();
    assert.ok(!has(tree, '#漏れてはいけない'), 'the earlier session/workspace answer is never shown');
    assert.equal(h.rowText(), '本文');
    if (h.world.workspaceId === 'u_2') {
      assert.ok(has(tree, 'このアカウントのワークスペースでは'));
      assert.equal(small(tree, 'AIに依頼する').length, 0);
      assert.equal(h.invokes.length, 1);
    } else {
      assert.ok(has(tree, 'ハッシュタグ: #二人目'), 'the new person\'s answer stays');
    }
  }
});

test('fail-closed before sending: another workspace, signed out, sample data or no backend -- nothing is sent, the manual preview still works', async () => {
  const cases = [
    [{ brandId: 'shared-brand' }, 'このアカウントのワークスペースでは'],
    [{ signedIn: false }, 'ログインが確認できない'],
    [{ status: 'mock_preview' }, 'サンプル表示では'],
    [{ client: false }, 'サンプル表示では'],
    [{ workspaceId: null }, 'ワークスペースを確認できない'],
  ];
  for (const [options, words] of cases) {
    const h = await mount(options);
    openWith(h);
    const tree = h.render();
    assert.ok(has(tree, words), words);
    assert.equal(small(tree, 'AIに依頼する').length, 0, words);
    type(h, '1件目の本文', '手で書いた投稿');
    action(h.render(), 'プレビューを作成').onPress();
    assert.equal(h.planned.length, 1, `${words}: manual flow continues`);
    assert.equal(h.invokes.length, 0, words);
  }
});

test('the API unreachable: a plain message, the typed text kept, and the manual preview goes on', async () => {
  const h = await mount();
  type(h, '1件目の本文', '自分で書いた本文');
  openWith(h, '書き直し');
  type(h, '書き直しの指示', '短く');
  h.queue.push({ status: 'throw' });
  press(h, 'AIに依頼する');
  await settle();
  assert.ok(has(h.render(), 'いまはAIを使えません'));
  assert.equal(h.rowText(), '自分で書いた本文');
  assert.equal(field(h.render(), '書き直しの指示').value, '短く', 'the instruction is kept for another try');
  action(h.render(), 'プレビューを作成').onPress();
  assert.equal(h.planned.length, 1);
  assert.equal(h.planned[0].drafts[0].text, '自分で書いた本文');
});

test('a removed row, a switch to AI自動予約 or a closed composer drops the pending answer; rows keep their own text', async () => {
  const h = await mount();
  type(h, '1件目の本文', '一件目');
  press(h, '＋ 本文を追加');
  type(h, '2件目の本文', '二件目');
  press(h, 'AIアシスト', 1);
  choice(h.render(), 'ハッシュタグ案').onPress();
  h.queue.push({ ...ok(candidate('二件目', ['#x'])), hold: true });
  press(h, 'AIに依頼する');
  press(h, '削除', 1);
  await h.release();
  let tree = h.render();
  assert.equal(h.rowText(1), '一件目');
  assert.equal(field(tree, '2件目の本文'), undefined);
  assert.equal(small(tree, 'タグを本文に追加').length, 0);

  openWith(h, 'ハッシュタグ案');
  h.queue.push({ ...ok(candidate('一件目', ['#y'])), hold: true });
  press(h, 'AIに依頼する');
  choice(h.render(), 'AI自動予約').onPress();
  await h.release();
  choice(h.render(), '指定日時').onPress();
  tree = h.render();
  assert.equal(small(tree, 'タグを本文に追加').length, 0);
  assert.equal(h.rowText(1), '一件目');

  openWith(h, 'ハッシュタグ案');
  h.queue.push({ ...ok(candidate('一件目', ['#z'])), hold: true });
  press(h, 'AIに依頼する');
  h.unmount();
  await h.release(); // must not throw or render: the closed composer ignores it
  assert.equal(h.invokes.length, 3);
  assert.equal(h.planned.length, 0);
});

test('rows keep their identity: reordering does not move a suggestion to another row', async () => {
  const h = await mount();
  type(h, '1件目の本文', 'A');
  press(h, '＋ 本文を追加');
  type(h, '2件目の本文', 'B');
  press(h, 'AIアシスト', 1);
  choice(h.render(), 'ハッシュタグ案').onPress();
  h.queue.push({ ...ok(candidate('B', ['#b'])), hold: true });
  press(h, 'AIに依頼する');
  press(h, '↑', 1);
  await h.release();
  assert.equal(h.rowText(1), 'B');
  press(h, 'タグを本文に追加');
  assert.equal(h.rowText(1), 'B\n\n#b');
  assert.equal(h.rowText(2), 'A');
});

test('timing: a double tap sends once; a session switch before any re-render still drops the answer; a stale frame never shows or adopts it', async () => {
  // Two taps on the same rendered button, before React re-renders.
  const h = await mount();
  type(h, '1件目の本文', '本文');
  openWith(h, 'ハッシュタグ案');
  h.queue.push({ ...ok(candidate('本文', ['#once'])), hold: true });
  const button = small(h.render(), 'AIに依頼する')[0];
  button.onPress();
  button.onPress();
  assert.equal(h.invokes.length, 1, 'a double tap is one request');
  // The person changes while the answer is in flight, and nothing re-renders before it arrives.
  h.world.userId = 'user-2';
  h.world.token = 'jwt-2';
  await h.release();
  assert.ok(!texts(h.renderOnce()).some((t) => t.includes('#once')), 'not shown in the first frame of the new session');
  assert.ok(!has(h.render(), '#once'));

  // An answer shown for workspace u_1, then the workspace changes: the very next frame shows nothing to adopt,
  // and a button taken from the earlier frame does nothing.
  const g = await mount();
  type(g, '1件目の本文', '本文');
  openWith(g, 'ハッシュタグ案');
  g.queue.push(ok(candidate('本文', ['#stale'])));
  press(g, 'AIに依頼する');
  await settle();
  const staleAdopt = small(g.render(), 'タグを本文に追加')[0];
  g.world.workspaceId = 'u_2';
  g.world.workspaceId = 'u_1';
  g.world.userId = 'user-2';
  g.world.token = 'jwt-2';
  const frame = g.renderOnce();
  assert.ok(!texts(frame).some((t) => t.includes('#stale')), 'not shown even for one frame');
  staleAdopt.onPress();
  assert.equal(field(g.render(), '1件目の本文').value, '本文', 'a stale adopt is refused');
});

test('the person keeps control of the row: tags go onto the text as it is now; undo disappears once they edit it; deleting a busy row frees the others at once', async () => {
  const h = await mount();
  type(h, '1件目の本文', '最初');
  openWith(h, 'ハッシュタグ案');
  h.queue.push({ ...ok(candidate('最初', ['#tag'])), hold: true });
  press(h, 'AIに依頼する');
  type(h, '1件目の本文', '最初に少し足した');
  await h.release();
  press(h, 'タグを本文に追加');
  assert.equal(h.rowText(), '最初に少し足した\n\n#tag', 'appended to the current text, not to the one that was sent');
  assert.equal(small(h.render(), '元に戻す').length, 1);
  type(h, '1件目の本文', '最初に少し足した\n\n#tag さらに');
  assert.equal(small(h.render(), '元に戻す').length, 0, 'no undo over the person\'s own later edits');

  press(h, '＋ 本文を追加');
  press(h, 'AIアシスト', 1);
  choice(h.render(), 'AIで下書き').onPress();
  type(h, 'AIへのメモ', 'メモ');
  h.queue.push({ ...ok(candidate('案')), hold: true });
  press(h, 'AIに依頼する');
  assert.equal(small(h.render(), 'AIアシスト')[0].disabled, true);
  press(h, '削除', 1);
  assert.notEqual(small(h.render(), 'AIアシスト')[0].disabled, true, 'the other rows can ask again at once');
  await h.release();
  assert.equal(h.rowText(), '最初に少し足した\n\n#tag さらに');
});

test('boundary: the composer reaches the backend only through use-post-assist-env, and nothing on that path can save, schedule or post', async () => {
  const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
  const composer = await read('features/schedule/schedule-composer.tsx');
  const hook = await read('features/schedule/use-post-assist-env.ts');
  const decisions = await read('features/schedule/post-assist.ts');
  const client = await read('data/post-assist-client.ts');
  const importsOf = (source) => [...source.matchAll(/from ["']([^"']+)["']/gu)].map((m) => m[1]).sort();
  assert.deepEqual(importsOf(composer).filter((name) => name.startsWith('@/') && !['@/constants/theme', '@/components/ui', '@/domain/schedule-planner'].includes(name)),
    ['@/features/schedule/post-assist', '@/features/schedule/use-post-assist-env']);
  assert.deepEqual(importsOf(hook), ['@/features/schedule/post-assist', '@/lib/supabase', '@/providers/auth-provider', '@/providers/data-provider']);
  assert.deepEqual(importsOf(decisions), ['../../data/post-assist-client.ts']);
  assert.deepEqual(importsOf(client), []);
  const writes = /\.from\(|\.rpc\(|\.insert\(|\.upsert\(|\.update\(|\.delete\(|fetch\(|AsyncStorage|SecureStore|localStorage|saveConfirmed|publish\w*\(|manual-publish|scheduled_posts/u;
  for (const [name, source] of [['composer', composer], ['hook', hook], ['decisions', decisions], ['client', client]]) {
    assert.doesNotMatch(source, writes, name);
    assert.doesNotMatch(source, /予約しました|投稿しました|予約確定/u, `${name}: no wording that pretends a post was scheduled or sent`);
  }
  // One endpoint, called in one place.
  assert.equal((client.match(/functions\.invoke\(/gu) ?? []).length, 1);
  assert.match(client, /export const POST_ASSIST_FUNCTION = "postona-post-assist";/u);
  assert.doesNotMatch(composer + hook + decisions, /functions\.invoke|requestPostAssist\(client|Authorization/u);
});

// G1 TASK 28 (G6-26 F1): a 401 -- from Supabase's gateway or the endpoint -- asks the person to sign in again. Until they have (a new
// access token), nothing more is sent, for any row; the typed text and the manual preview are untouched; the request's key is never
// re-sent. A new token (refresh or a new sign-in) opens it again with a new key. Another person's token is never refused for it.
const GATEWAY_401 = { status: 401, body: { code: 'UNAUTHORIZED_INVALID_JWT_FORMAT', message: 'Invalid JWT format', msg: 'Invalid JWT format' } };

test('gateway 401: "sign in again", no request until a new token, text and manual preview kept, no key re-used', async () => {
  const h = await mount();
  type(h, '1件目の本文', '手で書いた本文');
  openWith(h, 'ハッシュタグ案');
  h.queue.push(GATEWAY_401);
  press(h, 'AIに依頼する');
  await settle();
  let tree = h.render();
  assert.ok(has(tree, 'ログインし直すまでAIには依頼できません'), 'the relogin guidance, not "unavailable"');
  assert.ok(!has(tree, 'いまはAIを使えません'));
  assert.equal(small(tree, 'AIに依頼する').length + small(tree, '再試行').length + small(tree, 'もう一度依頼').length, 0, 'no way to send again');
  assert.equal(h.rowText(), '手で書いた本文', 'the typed text is kept');
  // Closing and reopening the panel, or another row, does not send either.
  press(h, 'AIアシストを閉じる');
  press(h, '＋ 本文を追加');
  press(h, 'AIアシスト', 1);
  tree = h.render();
  assert.ok(has(tree, 'ログインし直すまでAIには依頼できません'));
  assert.equal(small(tree, 'AIに依頼する').length, 0);
  assert.equal(h.invokes.length, 1);
  // The manual flow goes on.
  type(h, '2件目の本文', '二件目');
  { let time; walk(h.render(), (n) => { if (n.type === 'Field' && n.props.label === '時刻') time = n.props; }); time.onChange('12:00'); } // row 2: not too close to row 1
  action(h.render(), 'プレビューを作成').onPress();
  assert.equal(h.planned.length, 1);
  assert.deepEqual(h.planned[0].drafts.map((d) => d.text), ['手で書いた本文', '二件目']);
  // After signing in again (a new token for the same person) it can ask again -- with a new key and the new token.
  h.world.token = 'jwt-1-renewed';
  tree = h.render();
  assert.ok(!has(tree, 'ログインし直すまでAIには依頼できません'));
  choice(h.render(), 'ハッシュタグ案').onPress();
  h.queue.push(ok(candidate('二件目', ['#ok'])));
  press(h, 'AIに依頼する');
  await settle();
  assert.equal(h.invokes.length, 2);
  assert.equal(h.invokes[1].headers.Authorization, 'Bearer jwt-1-renewed');
  assert.notEqual(h.invokes[1].headers['Idempotency-Key'], h.invokes[0].headers['Idempotency-Key']);
  assert.ok(has(h.render(), 'ハッシュタグ: #ok'));
});

test('every 401 body form blocks the same way (empty, non-JSON, expired JWT); a 401 for an earlier token never blocks the current one', async () => {
  for (const body of ['', '<html>401</html>', { code: 'UNAUTHORIZED_INVALID_JWT', message: 'JWT expired', msg: 'JWT expired' }]) {
    const h = await mount();
    type(h, '1件目の本文', '本文');
    openWith(h, 'ハッシュタグ案');
    h.queue.push({ status: 401, body });
    press(h, 'AIに依頼する');
    await settle();
    assert.ok(has(h.render(), 'ログインし直すまでAIには依頼できません'), JSON.stringify(body));
  }
  // The token changes while the request is in flight (a refresh): the late 401 is about the old token only.
  const g = await mount();
  type(g, '1件目の本文', '本文');
  openWith(g, 'ハッシュタグ案');
  g.queue.push({ ...GATEWAY_401, hold: true });
  press(g, 'AIに依頼する');
  g.world.token = 'jwt-1-refreshed';
  g.render();
  await g.release();
  const tree = g.render();
  assert.ok(!has(tree, 'ログインし直すまでAIには依頼できません'), 'the refreshed token is not refused');
  assert.equal(small(tree, 'AIに依頼する').length, 1);
});

test('the AI asks only for the pinned personal workspace: a shown (first-read) workspace that equals the brand is not enough', async () => {
  const h = await mount({ workspaceId: null });
  h.world.shownWorkspaceId = 'u_1'; // what the app shows matches the account's brand, but no personal workspace was pinned
  openWith(h);
  const tree = h.render();
  assert.ok(has(tree, 'ご自身の個人ワークスペースを確認できない'));
  assert.equal(small(tree, 'AIに依頼する').length, 0);
  assert.equal(h.invokes.length, 0);
});
