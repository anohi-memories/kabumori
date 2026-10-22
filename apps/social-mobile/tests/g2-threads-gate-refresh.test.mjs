// G2 QA (Issue #317, task postona-g2-threads-manual-double-publish-qa-gate-refresh-20261022) -- QA only, no product code.
// Threads manual double publish (G2-T1, P2, owner G4) -- QA gate refresh before any real send port is connected.
// No fix candidate exists: the six manual-publish source files are byte-identical on G4 #381 / #388 / #405 / #412 / #418
// and on G2 #391 / #393 (pinned below, so any change flags "re-QA required"). G2 #391 / #393 and G4's server-core tests
// are not re-run or rebuilt. This file adds only crossings they do not cover, with the REAL card + hook (two mounts =
// two screens of the same person) over the same server stand-in as G2 #391 (rules of begin_threads_manual_publish).
// Offline: no Threads, no Meta, no Supabase.
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as publishDomain from '../src/domain/threads-manual-publish.ts';

const root = resolve(import.meta.dirname, '..');
const CARD = 'src/features/threads-publish/threads-publish-card.tsx';
const HOOK = 'src/features/threads-publish/use-threads-manual-publish.ts';
const SQL = resolve(root, '../../supabase/candidates/postona_threads_publish/threads_manual_publish_candidate.sql');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function evaluate(source, path, stubs) {
  const module = { exports: {} };
  const require = (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; };
  vm.runInNewContext(transpile(source), { module, exports: module.exports, require, Response, URL, URLSearchParams }, { filename: path });
  return module.exports;
}
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
const walk = (node, visit) => { if (Array.isArray(node)) return node.forEach((c) => walk(c, visit)); if (node === null || typeof node !== 'object') return; visit(node); walk(node.props?.children, visit); };
const texts = (tree) => { const out = []; walk(tree, (n) => { if (['Text', 'Pill'].includes(n.type)) out.push([n.props.children].flat().filter((c) => typeof c === 'string' || typeof c === 'number').join('')); }); return out; };
const buttons = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'ActionButton') out.push(n.props); }); return out; };
const button = (tree, label) => buttons(tree).find((b) => b.label.includes(label)) ?? null;
const input = (tree) => { let found = null; walk(tree, (n) => { if (n.type === 'TextInput') found = n.props; }); return found; };

/** Hook runtime. `memo: true` (default here) keeps a useCallback result while its deps are equal, as React does; the
 * G2 #391 runtime returned a new callback on every render, which re-ran deps-based effects (an over-refresh). */
function hooks({ memo = true } = {}) {
  const slots = []; const deps = []; let cursor = 0; let effects = [];
  const react = {
    useLayoutEffect: (effect) => { effects.push(effect); },
    useEffect: (effect, d) => { const i = cursor++; const prev = deps[i]; if (!prev || d.some((v, k) => v !== prev[k])) { deps[i] = d; effects.push(effect); } },
    useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback: (cb, d) => { const i = cursor++; if (!memo) return cb; const prev = deps[i]; if (!prev || d.length !== prev.length || d.some((v, k) => v !== prev[k])) { deps[i] = d; slots[i] = cb; } return slots[i]; },
  };
  const jsx = (type, props) => ({ type: typeof type === 'function' ? type.name : type, props });
  const render = (fn) => { cursor = 0; effects = []; const tree = fn(); const run = effects; effects = []; run.forEach((e) => e()); return tree; };
  return { react, runtime: { jsx, jsxs: jsx, Fragment: 'Fragment' }, render };
}

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const threads = (id, over = {}) => ({ id, platform: 'threads', profile: { displayName: `G2-${id}`, handle: `@${id}`, avatarColor: '#000', voice: { tone: '', language: '', avoid: [] } }, connectionStatus: 'connected', postingState: 'paused', ...over });
const CLOSED = new Set(['published', 'published_unidentified', 'failed']);

/**
 * Server stand-in. Rules copied from begin_threads_manual_publish (checked against the SQL text in the last test):
 * same (account, key) -> same caller + same text: replay, else IDEMPOTENCY_CONFLICT; another open attempt for the
 * account -> PUBLISH_IN_PROGRESS; otherwise a new attempt. `outcome(attempt)` scripts what the attempt becomes, `lose`
 * drops the HTTP answer of the next publish (the attempt still exists on the server). `posts` counts attempts that
 * ended public on Threads.
 */
function server({ outcome = () => 'published' } = {}) {
  const attempts = [];
  const calls = [];
  let seq = 0;
  const s = { attempts, calls, lose: false, holdState: null, reconcileTo: null, reconcileOtherId: false, permitted: true };
  const view = (a) => ({ id: a.id, social_account_id: a.account, status: a.status, provider_post_id: a.status === 'published' || a.status === 'publish_returned' ? '17890000000000003' : null, permalink: a.status === 'published' ? `https://www.threads.net/@g2/post/G2qa_${a.n}` : null, error_code: a.status === 'failed' ? 'CONTAINER_OUTCOME_UNKNOWN' : a.status === 'uncertain' || a.status === 'published_unidentified' ? 'READ_BACK_PENDING' : null, replayed: false });
  s.posts = () => attempts.filter((a) => a.status === 'published' || a.status === 'published_unidentified').length;
  s.publishCalls = () => calls.filter((c) => c.action === 'publish');
  s.invoke = async (_name, options) => {
    const body = options.body;
    const user = options.user;
    calls.push({ ...body, user });
    if (body.action === 'account_state') {
      if (s.holdState) await s.holdState;
      const mine = attempts.filter((a) => a.account === body.social_account_id);
      const open = mine.find((a) => !CLOSED.has(a.status)) ?? null;
      const last = [...mine].reverse().find((a) => CLOSED.has(a.status)) ?? null;
      return { data: { success: true, account: { id: body.social_account_id, manual_publish_permitted: s.permitted, open_attempt: open && view(open), last_attempt: last && view(last) } }, error: null };
    }
    if (body.action === 'publish') {
      const same = attempts.find((a) => a.account === body.social_account_id && a.key === body.idempotency_key);
      let answer;
      if (same) {
        answer = same.user !== user || same.text !== body.text ? { data: null, error: { context: new Response(JSON.stringify({ error: 'IDEMPOTENCY_CONFLICT' })) } } : { data: { success: true, attempt: { ...view(same), replayed: true } }, error: null };
      } else if (attempts.some((a) => a.account === body.social_account_id && !CLOSED.has(a.status))) {
        answer = { data: null, error: { context: new Response(JSON.stringify({ error: 'PUBLISH_IN_PROGRESS' })) } };
      } else {
        seq += 1;
        const a = { id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, n: seq, account: body.social_account_id, key: body.idempotency_key, user, text: body.text, status: 'reserved' };
        attempts.push(a);
        a.status = outcome(a);
        answer = { data: { success: true, attempt: view(a) }, error: null };
      }
      if (s.lose) { s.lose = false; return { data: null, error: {} }; } // the answer is lost on the way back
      return answer;
    }
    if (body.action === 'reconcile' || body.action === 'resume') {
      const a = attempts.find((x) => x.id === body.attempt_id);
      if (!a) return { data: null, error: { context: new Response(JSON.stringify({ error: 'ATTEMPT_NOT_FOUND' })) } };
      if (s.reconcileTo) a.status = s.reconcileTo;
      const v = view(a);
      return { data: { success: true, attempt: s.reconcileOtherId ? { ...v, id: '00000000-0000-4000-8000-0000000000ff' } : v }, error: null };
    }
    return { data: null, error: {} };
  };
  return s;
}

/** The real card + hook over the stand-in. `props.account` and `auth.user` can be changed between renders. */
/** One key counter for every mounted screen (randomUUID never repeats across screens; the #391 harness counted per mount). */
const KEYS = { n: 0 };
async function mount(srv, { account = threads('sa_th_a'), cardSource, hookSource, memo = true } = {}) {
  const h = hooks({ memo });
  const auth = { user: USER_A };
  const stubs = {
    react: h.react, 'react/jsx-runtime': h.runtime,
    'react-native': { Text: 'Text', View: 'View', TextInput: 'TextInput', Pressable: 'Pressable', Linking: { openURL: () => { throw new Error('no link may open in QA'); } } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i', success: 's', danger: 'd', border: 'b', muted: 'm', primary: 'p' } },
    '@/domain/threads-manual-publish': publishDomain,
    '@/lib/supabase': { supabase: { functions: { invoke: (name, options) => srv.invoke(name, { ...options, user: auth.user }) } } },
    '@/providers/auth-provider': { useAuth: () => ({ session: { access_token: `rig-jwt-${auth.user.slice(-2)}`, user: { id: auth.user } } }) },
    'expo-crypto': { randomUUID: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++KEYS.n).padStart(12, '0')}` },
  };
  stubs['@/features/threads-publish/use-threads-manual-publish'] = evaluate(hookSource ?? await readFile(resolve(root, HOOK), 'utf8'), HOOK, stubs);
  const card = evaluate(cardSource ?? await readFile(resolve(root, CARD), 'utf8'), CARD, stubs);
  const props = { account, preview: false, releaseEnabled: true };
  const api = {
    props, auth, srv,
    render: () => h.render(() => card.ThreadsPublishCard(props)),
    async settle() { api.render(); await settle(); api.render(); await settle(); return api.render(); },
    async type(text) { await api.settle(); input(api.render()).onChangeText(text); return api.render(); },
    /** 投稿内容を確認する -> 投稿する (pressed twice, as a double tap). */
    async send() {
      const confirm = button(api.render(), '投稿内容を確認');
      assert.ok(confirm && !confirm.disabled, 'the confirm button is there and enabled');
      confirm.onPress();
      const go = button(api.render(), '投稿する');
      go.onPress();
      go.onPress();
      return api.settle();
    },
    composerText: () => input(api.render())?.value ?? null,
    keys: () => srv.publishCalls().map((c) => c.idempotency_key),
  };
  return api;
}

// ---- QA gate: the sources this gate was measured on --------------------------------------------------------------
const PINNED = {
  'src/features/threads-publish/threads-publish-card.tsx': '8826687575192008cb15a0c37d755075f91be6f0cb8e5e54863b80b95dfdf152',
  'src/features/threads-publish/use-threads-manual-publish.ts': '7658af882f12e2195a54ad774c37dd6a59b8b046e0a72be92c2e3f37acd30de7',
  'src/domain/threads-manual-publish.ts': '49f71417dc311e063a6ac7f9e4835a1a7fe16ffd8736bd245d30d631dd33567c',
  '../../supabase/candidates/postona_threads_publish/threads_manual_publish_candidate.sql': '4273e32e3c2ce5a693bb5aee26ffbddd22d025eac086518edaf8b9c67cd3fcef',
  '../../supabase/functions/social-mobile-threads-publish/logic.ts': '493cdfeeddd21f83d98621577dfd1deef7041d2fabd8092cde9da09f91eb9932',
  '../../supabase/functions/_shared/social/threads_manual_publish.ts': '2f4ff5916ee88663653b79e3dd871d215ffb7ef126dea48ae752e4a776ee8341',
};
test('QA GATE G2-TG0: the manual-publish sources are the ones G2-T1 / T2 were measured on (a change = a fix candidate or a regression: re-run G2 #391 / #393 and this file before connecting any send port)', { todo: 'QA GATE: red means re-QA required, not a product failure' }, async () => {
  const changed = [];
  for (const [path, sha] of Object.entries(PINNED)) {
    const now = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex');
    if (now !== sha) changed.push(path);
  }
  assert.deepEqual(changed, []);
});

// ---- two screens of the same person ------------------------------------------------------------------------------
/** Screen B loaded and typed BEFORE screen A sends (B never sees A's lost answer); both show account sa_th_a. */
async function twoScreens(status) {
  const srv = server({ outcome: (a) => (a.n === 1 ? status : 'published') });
  const a = await mount(srv);
  const b = await mount(srv);
  await b.type('一度だけ出したい投稿');
  await a.type('一度だけ出したい投稿');
  srv.lose = true;
  await a.send();
  await a.settle();
  return { srv, a, b };
}

test('G2-TG1: while A\'s attempt is still open (uncertain / publishing, answer lost), the stale screen B sending the same text is refused by the server (PUBLISH_IN_PROGRESS) -- no second attempt, no post; B then shows A\'s open attempt and hides its editor', async () => {
  for (const status of ['uncertain', 'publishing']) {
    const { srv, b } = await twoScreens(status);
    assert.equal(b.composerText(), '一度だけ出したい投稿', `${status}: B still offers its editor (it never saw A's answer)`);
    await b.send();
    const tree = await b.settle();
    assert.equal(srv.attempts.length, 1, `${status}: still one attempt`);
    assert.equal(srv.posts(), status === 'uncertain' ? 0 : 0, `${status}: nothing public from B`);
    assert.equal(input(tree), null, `${status}: after the re-read B hides its editor`);
    assert.ok(texts(tree).includes(status === 'uncertain' ? '投稿されたか確認できていません' : 'Threadsへ投稿しています…'), `${status}: B now shows A's open attempt`);
    assert.equal(srv.calls.filter((c) => c.action === 'publish').length, 2, `${status}: B's request did go out (refused by the server)`);
    assert.equal(texts(tree).some((t) => t.includes('投稿しました')), false, `${status}: no success`);
  }
});

test('KNOWN G2-T1 (P2, same root, another entrance -- not a new finding): once A\'s attempt is resolved as published, the stale screen B still holds the same text and its new key makes a SECOND post (no check on the text, protection only while open)', async () => {
  const { srv, a, b } = await twoScreens('uncertain');
  srv.reconcileTo = 'published';
  button(await a.settle(), '確認する').onPress();
  await a.settle();
  assert.equal(srv.posts(), 1, 'A\'s post is public');
  assert.equal(b.composerText(), '一度だけ出したい投稿', 'B still offers the same text');
  await b.send();
  assert.equal(srv.attempts.length, 2);
  assert.equal(srv.posts(), 2, 'the same text twice (T1, owner G4)');
});

test('G2-TG2: the credential expires or the manual permission is withdrawn while B waits -- B\'s send is refused with that reason, nothing is posted, nothing says posted', async () => {
  for (const [code, line] of [['CREDENTIALS_EXPIRED', 'Threadsとの接続の有効期限が切れているか、まもなく切れます。Threadsアカウントを接続し直してください。'], ['MANUAL_PUBLISH_NOT_PERMITTED', null]]) {
    const srv = server();
    const b = await mount(srv);
    await b.type('期限の切れた投稿');
    const original = srv.invoke;
    srv.invoke = async (name, options) => (options.body.action === 'publish' ? { data: null, error: { context: new Response(JSON.stringify({ error: code })) } } : original(name, options));
    await b.send();
    const tree = await b.settle();
    assert.equal(srv.posts(), 0, code);
    if (line) assert.ok(texts(tree).includes(line), `${code}: its own reason`);
    assert.equal(texts(tree).some((t) => t.includes('投稿しました')), false, `${code}: no success`);
  }
});

test('harness control G2-TH: with React-like useCallback, a screen loaded before the send does NOT re-read the account state on its own (stale, as on a device); the #391-style runtime re-reads on every render', async () => {
  for (const [memo, expectCalls] of [[true, 1], [false, null]]) {
    const srv = server();
    const b = await mount(srv, { memo });
    await b.settle();
    const before = srv.calls.filter((c) => c.action === 'account_state').length;
    await b.settle(); await b.settle();
    const after = srv.calls.filter((c) => c.action === 'account_state').length;
    if (memo) assert.equal(after, before, 'memoized: no extra reads');
    else assert.ok(after > before, 'non-memoized (#391 runtime): extra reads on every render');
    if (expectCalls !== null) assert.equal(before, expectCalls, 'one read on mount');
  }
});

// ---- negative controls -------------------------------------------------------------------------------------------
test('negative controls: (1) a server stand-in WITHOUT the one-open-attempt rule lets G2-TG1 make a second post (so TG1 really rests on that rule); (2) the pinned-source gate notices a one-byte change', async () => {
  const { srv, b } = await twoScreens('uncertain');
  const original = srv.invoke;
  srv.invoke = async (name, options) => {
    if (options.body.action !== 'publish') return original(name, options);
    const open = srv.attempts.filter((x) => !CLOSED.has(x.status));
    open.forEach((x) => { x.status = 'failed'; }); // hidden from the open-attempt check only
    try { return await original(name, options); } finally { open.forEach((x) => { x.status = 'uncertain'; }); }
  };
  await b.send();
  assert.equal(srv.attempts.length, 2, 'mutant stand-in: a second attempt for the same text');
  const sql = await readFile(SQL, 'utf8');
  assert.match(sql, /create unique index threads_manual_publish_one_open_per_account/u, 'the real rule TG1 rests on');
  const card = await readFile(resolve(root, 'src/features/threads-publish/threads-publish-card.tsx'));
  const flipped = Buffer.from(card); flipped[0] ^= 1;
  assert.notEqual(createHash('sha256').update(flipped).digest('hex'), PINNED['src/features/threads-publish/threads-publish-card.tsx']);
});
