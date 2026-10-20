// G2 QA (Issue #317, task postona-g2-threads-manual-duplicate-publish-crosslayer-qa-20261020) -- QA only, no product code.
// G2-T1 (P2, owner G4) across the layers: the REAL Threads card + hook (transpiled, unchanged since G2 PR #342's base)
// against a server stand-in that follows the database candidate begin_threads_manual_publish
// (supabase/candidates/postona_threads_publish/threads_manual_publish_candidate.sql): the same key replays the same
// attempt, a new key is refused while an attempt is open (not published / published_unidentified / failed), and a new
// key after a closed attempt creates a NEW attempt -- there is no check on the text. Offline: no Threads, no Supabase.
//
// PR #342 already pins the base case (lost answer -> already published -> re-confirm -> second publish) and the
// open / uncertain / other-account / other-user / double-tap boundaries; they are not rebuilt here. This file adds only
// the cross-layer conditions #342 does not cover. "FINDING .." passes while the gap exists and FAILS once fixed.
import test from 'node:test';
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
async function mount(srv, { account = threads('sa_th_a'), cardSource, hookSource } = {}) {
  const h = hooks();
  const auth = { user: USER_A };
  let keySeq = 0;
  const stubs = {
    react: h.react, 'react/jsx-runtime': h.runtime,
    'react-native': { Text: 'Text', View: 'View', TextInput: 'TextInput', Pressable: 'Pressable', Linking: { openURL: () => { throw new Error('no link may open in QA'); } } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', styles: { muted: {} } },
    '@/constants/theme': { colors: { ink: 'i', success: 's', danger: 'd', border: 'b', muted: 'm', primary: 'p' } },
    '@/domain/threads-manual-publish': publishDomain,
    '@/lib/supabase': { supabase: { functions: { invoke: (name, options) => srv.invoke(name, { ...options, user: auth.user }) } } },
    '@/providers/auth-provider': { useAuth: () => ({ session: { access_token: `rig-jwt-${auth.user.slice(-2)}`, user: { id: auth.user } } }) },
    'expo-crypto': { randomUUID: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++keySeq).padStart(12, '0')}` },
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

/** Type, send with a lost answer; the attempt on the server ends as `status`. */
async function lostAnswer(status, opts = {}) {
  const srv = server({ outcome: (a) => (a.n === 1 ? status : 'published') }); // a later attempt is a normal post
  const card = await mount(srv, opts);
  await card.type('一度だけ出したい投稿');
  srv.lose = true;
  await card.send();
  return { srv, card };
}

// ---- new cross-layer conditions -----------------------------------------------------------------------------------

test('FINDING G2-T1-U (P2 path, owner G4): lost answer -> server "uncertain" (composer hidden, safe) -> 確認する says published -> the OLD text is back in the composer -> a re-confirm makes a SECOND post with a NEW key', async () => {
  const { srv, card } = await lostAnswer('uncertain');
  let tree = await card.settle();
  assert.equal(input(tree), null, 'while uncertain the composer is hidden (as #342 pins)');
  srv.reconcileTo = 'published';
  button(tree, '確認する').onPress();
  tree = await card.settle();
  assert.ok(texts(tree).includes('Threadsに投稿しました'), 'the card says it was posted');
  assert.equal(card.composerText(), '一度だけ出したい投稿', 'and the same text is offered again');
  await card.send();
  const keys = card.keys();
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], 'a NEW idempotency key');
  assert.equal(srv.posts(), 2, 'two public posts of the same text');
});

test('FINDING G2-T1-PU (P2 path, owner G4): lost answer -> server "published_unidentified" (posted, link unknown) -> the old text stays -> a re-confirm makes a SECOND post', async () => {
  const { srv, card } = await lostAnswer('published_unidentified');
  const tree = await card.settle();
  assert.ok(texts(tree).includes('Threadsへの投稿は確認できました'));
  assert.equal(card.composerText(), '一度だけ出したい投稿');
  await card.send();
  assert.equal(srv.publishCalls().length, 2);
  assert.equal(srv.posts(), 2);
});

test('G2-T1-F (guard for the fix): lost answer -> server "failed" (nothing public) -> sending the same text again is a legitimate retry: 2 requests, 1 post', async () => {
  const srv = server({ outcome: (a) => (a.n === 1 ? 'failed' : 'published') });
  const card = await mount(srv);
  await card.type('一度だけ出したい投稿');
  srv.lose = true;
  await card.send();
  const tree = await card.settle();
  assert.ok(texts(tree).includes('投稿できませんでした'));
  await card.send();
  assert.equal(srv.publishCalls().length, 2);
  assert.equal(srv.posts(), 1, 'a fix must keep this retry possible');
});

test('G2-T1-W (window): a re-confirm made while the first attempt is still open is refused by the server (PUBLISH_IN_PROGRESS) -- the protection only lasts while the attempt is open', async () => {
  const srv = server({ outcome: (a) => (a.n === 1 ? 'publishing' : 'published') });
  const card = await mount(srv);
  await card.type('一度だけ出したい投稿');
  let release;
  srv.holdState = new Promise((r) => { release = r; });
  srv.lose = true;
  await card.send(); // the state read after the lost answer is held: the card still shows the composer
  assert.equal(card.composerText(), '一度だけ出したい投稿');
  await card.send();
  assert.equal(srv.publishCalls().length, 2, 'the app does send the second request');
  assert.equal(srv.posts(), 0, 'nothing public yet');
  assert.equal(srv.attempts.length, 1, 'but the server refused it: still one attempt');
  srv.attempts[0].status = 'published'; // the first one finishes
  srv.holdState = null;
  release();
  await card.settle();
  await card.send(); // the same old text, a third confirmation
  assert.equal(srv.attempts.length, 2, 'once closed, a new key is a new attempt');
  assert.equal(srv.posts(), 2);
});

test('FINDING G2-T1-A (P3, owner G4): the typed text belongs to the card, not to the account -- when the same card shows another account, the text (even one already posted) is offered for that account', async () => {
  const { srv, card } = await lostAnswer('published', { account: threads('sa_th_a') });
  await card.settle();
  card.props.account = threads('sa_th_b'); // the same card instance now shows account B
  await card.settle();
  assert.equal(card.composerText(), '一度だけ出したい投稿', "A's text is in B's composer");
  await card.send();
  const calls = srv.publishCalls();
  assert.equal(calls[1].social_account_id, 'sa_th_b');
  assert.equal(calls[1].text, '一度だけ出したい投稿');
  assert.equal(srv.posts(), 2, 'the same text public on A and on B');
});

test('FINDING G2-T1-P (P3, owner G4): the typed text survives a change of the signed-in person while the card stays mounted (the confirmation does not, as #342 pins)', async () => {
  const srv = server();
  const card = await mount(srv);
  await card.type('Aさんが入力した文章');
  card.auth.user = USER_B;
  await card.settle();
  assert.equal(card.composerText(), 'Aさんが入力した文章', 'B sees what A typed');
  assert.equal(srv.publishCalls().length, 0);
});

test('G2-T1-R: a re-check answer about ANOTHER attempt id is not taken as the answer; nothing is published', async () => {
  const { srv, card } = await lostAnswer('uncertain');
  const tree = await card.settle();
  srv.reconcileOtherId = true;
  srv.reconcileTo = 'published';
  button(tree, '確認する').onPress();
  await card.settle();
  assert.equal(srv.publishCalls().length, 1);
  assert.ok(srv.calls.some((c) => c.action === 'reconcile'));
});

test('the stand-in follows the database candidate: replay on the same key, PUBLISH_IN_PROGRESS while open, one open attempt per account, and no check on the text', async () => {
  const sql = await readFile(SQL, 'utf8');
  const begin = sql.slice(sql.indexOf('create function public.begin_threads_manual_publish'), sql.indexOf('create function public.claim_threads_manual_publish_step'));
  assert.match(begin, /return pg_catalog\.jsonb_build_object\('status', 'replayed'/u);
  assert.match(begin, /status not in \('published', 'published_unidentified', 'failed'\)\) then\s+return public\.threads_manual_publish_refused\('PUBLISH_IN_PROGRESS'\)/u);
  assert.match(sql, /create unique index threads_manual_publish_one_open_per_account[\s\S]{0,160}where status not in \('published', 'published_unidentified', 'failed'\)/u);
  assert.doesNotMatch(begin, /text_sha256 = v_hash and|post_text = p_text/u, 'no "same text recently published" check in begin');
  // and the client mints a new key per confirmation; the only reuse is a re-press of the SAME confirmation
  const card = await readFile(resolve(root, CARD), 'utf8');
  assert.match(card, /setPinned\(null\);\s+void publish\(confirming\)/u, 'the confirmation is dropped before the answer comes back');
  assert.match(card, /if \(accepted\) setText\(''\)/u, 'the text is cleared only on an answered publish');
});

// ---- negative control: a naive fix sketch flips the FINDINGs but breaks the legitimate retry --------------------------

test('negative control: re-using the last unanswered key for the same text (a naive fix) stops both second posts, and G2-T1-F catches that it also blocks the retry after "failed"', async () => {
  const original = await readFile(resolve(root, CARD), 'utf8');
  const once = (src, from, to) => { assert.equal(src.split(from).length - 1, 1, `target once: ${from.slice(0, 40)}`); return src.replace(from, to); };
  let sketch = once(original, 'export function ThreadsPublishCard(', 'let lastSent = null;\nexport function ThreadsPublishCard(');
  sketch = once(sketch, '    const next = pin(text);', "    const same = lastSent && lastSent.accountId === context.accountId && lastSent.userId === context.userId && lastSent.text === text.replace(/\\r\\n?/gu, '\\n');\n    const next = same ? lastSent : pin(text);");
  sketch = once(sketch, '    setPinned(null);\n    void publish(confirming)', '    setPinned(null);\n    lastSent = confirming;\n    void publish(confirming)');

  for (const status of ['uncertain', 'published_unidentified']) {
    const srv = server({ outcome: () => status });
    const card = await mount(srv, { cardSource: sketch });
    await card.type('一度だけ出したい投稿');
    srv.lose = true;
    await card.send();
    let tree = await card.settle();
    if (status === 'uncertain') { srv.reconcileTo = 'published'; button(tree, '確認する').onPress(); tree = await card.settle(); }
    await card.send();
    assert.equal(srv.posts(), 1, `${status}: with the sketch the second confirmation replays the first attempt`);
    const keys = card.keys();
    assert.equal(keys[0], keys[1], `${status}: same key`);
  }
  const srv = server({ outcome: (a) => (a.n === 1 ? 'failed' : 'published') });
  const card = await mount(srv, { cardSource: sketch });
  await card.type('一度だけ出したい投稿');
  srv.lose = true;
  await card.send();
  await card.settle();
  await card.send();
  assert.equal(srv.posts(), 0, 'the sketch replays the FAILED attempt forever: the legitimate retry is gone (G2-T1-F fails on it)');
});
