// F4 (postona-f4-pr211-r2c-final-preview-identity-fix-20261015): J4 V4 P2-R2c on PR211's POSTONA service-end
// client. After the mutation answered, the FINAL read-back may observe that another person (B) or nobody is signed
// in now. The helper's return value must then carry NONE of person A's answer: no X unconfirmed count, no Threads
// remote-authorization line, no completion. When A is still the one observed (a failed or refused read-back, a
// session read that throws, A on a refreshed session), A's own validated warnings stay, without a completion.
// These tests FAIL on PR211 eb1011f2 (the late-switch cases) and pin the fix. Synthetic transport and sessions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Buffer } from 'node:buffer';
import ts from 'typescript';
import * as account from '../src/domain/account-deletion.ts';
import * as endDomain from '../src/domain/postona-service-end.ts';
import * as notices from '../src/domain/postona-end-notices.ts';
import * as flows from '../src/domain/auth-flows.ts';
import * as recovery from '../src/domain/recovery-binding.ts';
import { createPostonaEndClient } from '../src/lib/postona-service-end-client.ts';

const { POSTONA_END_CONFIRM_PHRASE, POSTONA_END_SOURCE_ENABLED } = endDomain;
const previewBody = (status = 'active') => ({ ok: true, account_status: 'active', lifecycle_version: 7,
  services: [{ service: 'kabumori', status: 'active' }, { service: 'x_autopost', status }], blockers: [], deletion_in_progress: false,
  deletion_available: false, apple: { required: false, supported: true, code_required: false }, x_cleanup: 'supported',
  providers: [{ provider: 'x', adapter: 'saga', remote_revoke: 'saga' }, { provider: 'threads', adapter: 'registered', remote_revoke: 'unsupported' }],
  acknowledgement_required: ['threads'], postona_end_available: true });
const ended = { ok: true, outcome: 'ended', providers: { x: 'done', threads: 'local_removed_remote_unverified' }, remote_unverified: ['threads'], x_posts_unconfirmed: 2 };
const A = { userId: 'person-a', sessionId: 'session-a', accessToken: 'token-a' };
const A2 = { userId: 'person-a', sessionId: 'session-a-2', accessToken: 'token-a-2' };   // A, refreshed session
const B = { userId: 'person-b', sessionId: 'session-b', accessToken: 'token-b' };
const context = { userId: A.userId, sessionId: A.sessionId };
const answer = (body, status = 200) => ({ status, body });
const THREADS_LINE = notices.REMOTE_UNVERIFIED.threads.remote;
const aFacts = (r) => r.lines.some((s) => s === THREADS_LINE || s.includes('予約が2件'));
const both = (r) => r.lines.includes(THREADS_LINE) && r.lines.some((s) => s.includes('予約が2件'));
const completed = (r) => r.lines.some((s) => s.includes('利用を終了しました') || s.includes('すでに終了'));

/** The real client. `sessions[i]` answers the i-th session() read (an Error throws; a function is called); after the
 *  script the CURRENT value (set by `switchTo`) is answered. Responses are queued (a function may await). */
function harness({ responses = [answer(previewBody()), answer(ended), answer(previewBody('ended'))], sessions = [] } = {}) {
  const calls = []; const queue = [...responses]; const script = [...sessions]; let current = A;
  const client = createPostonaEndClient({
    enabled: true,
    session: async () => {
      const next = script.length ? script.shift() : current;
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next() : next;
    },
    call: async (body, token) => {
      calls.push({ action: body.action, token });
      const next = queue.shift();
      if (typeof next === 'function') return next();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('offline');
      return next;
    },
  });
  return { client, calls, switchTo: (s) => { current = s; } };
}
const input = (preview) => ({ context, preview, phrase: POSTONA_END_CONFIRM_PHRASE, acknowledged: ['threads'] });
// Session reads: preview (1: before, 2: after), end (3: before the mutation), 4: right after the mutation,
// final read-back preview (5: before its request, 6: after it), 7: the last check before the answer is returned.

test('the shipped source flag stays OFF', () => assert.equal(POSTONA_END_SOURCE_ENABLED, false));

// ---------------------------------------------------------------- R2c: positive switch at the final read-back

for (const [label, other] of [['another person', B], ['nobody', null]]) {
  test(`R2c: the final read-back finds ${label} signed in before its request -> none of A's answer is returned`, async () => {
    const h = harness({ sessions: [A, A, A, A, other] });
    const result = await h.client.end(input(await h.client.preview()));
    assert.equal(result.ok, false); assert.equal(result.code, 'SESSION_CHANGED');
    assert.ok(!aFacts(result), 'no X count, no Threads line of A'); assert.ok(!completed(result));
    assert.ok(h.calls.every((c) => c.token === A.accessToken), 'no request is made with the other login');
  });

  test(`R2c (J4 repro, stale callback): the final read-back answer arrives after a switch to ${label}`, async () => {
    let release; const held = new Promise((r) => { release = r; });
    const h = harness({ responses: [answer(previewBody()), answer(ended), async () => { await held; return answer(previewBody('ended')); }] });
    const p = await h.client.preview(); const ending = h.client.end(input(p));
    await new Promise((r) => setImmediate(r)); h.switchTo(other); release();
    const result = await ending;
    assert.equal(result.ok, false); assert.equal(result.code, 'SESSION_CHANGED');
    assert.ok(!aFacts(result)); assert.ok(!completed(result));
  });

  test(`R2c: a switch to ${label} after the read-back succeeded (the last check) returns no completion and no facts`, async () => {
    const h = harness({ sessions: [A, A, A, A, A, A, other] });
    const result = await h.client.end(input(await h.client.preview()));
    assert.equal(result.ok, false); assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result)); assert.ok(!completed(result));
  });

  test(`R2c: a failed read-back followed by a switch to ${label} returns none of A's facts`, async () => {
    const h = harness({ responses: [answer(previewBody()), answer(ended), new Error('offline')], sessions: [A, A, A, A, A, other] });
    const result = await h.client.end(input(await h.client.preview()));
    assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result));
  });

  test(`R2c: a session read that throws, then ${label} observed, returns none of A's facts`, async () => {
    const h = harness({ sessions: [A, A, A, new Error('session store'), other] });
    const result = await h.client.end(input(await h.client.preview()));
    assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result));
  });
}

test('R2c: once another person was seen, a later (switched-back or stale, out-of-order) read of A never brings A\'s facts back', async () => {
  for (const sessions of [[A, A, A, B, A, A, A], [A, A, A, A, B, A, A], [A, A, A, A, A, null, A], [A, A, A, A, A, A, B]]) {
    const h = harness({ sessions });
    const result = await h.client.end(input(await h.client.preview()));
    assert.equal(result.code, 'SESSION_CHANGED', JSON.stringify(sessions.map((s) => s?.userId ?? null)));
    assert.ok(!aFacts(result)); assert.ok(!completed(result));
  }
});

// ---------------------------------------------------------------- A still observed: warnings stay, no completion

test('A still signed in, the read-back transport fails -> both warnings, no completion', async () => {
  const h = harness({ responses: [answer(previewBody()), answer(ended), new Error('offline')] });
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.code, 'RESULT_UNCONFIRMED'); assert.ok(both(result)); assert.ok(!completed(result));
});

test('A still signed in, the server refuses the read-back -> both warnings, no completion', async () => {
  for (const refused of [answer({ ok: false, error: 'AUTH_REQUIRED' }, 401), answer({ ok: false, error: 'FAILED' }, 500), answer(null)]) {
    const h = harness({ responses: [answer(previewBody()), answer(ended), refused] });
    const result = await h.client.end(input(await h.client.preview()));
    assert.equal(result.code, 'RESULT_UNCONFIRMED'); assert.ok(both(result)); assert.ok(!completed(result));
  }
});

test('session reads that throw (identity unknown) keep A\'s warnings, without a completion', async () => {
  for (const sessions of [[A, A, A, new Error('x')], [A, A, A, A, new Error('x')], [A, A, A, A, A, new Error('x')], [A, A, A, A, A, A, new Error('x')]]) {
    const h = harness({ sessions });
    const result = await h.client.end(input(await h.client.preview()));
    assert.equal(result.code, 'RESULT_UNCONFIRMED', JSON.stringify(sessions.map(String))); assert.ok(both(result)); assert.ok(!completed(result));
  }
});

test('A on a refreshed session (same person) keeps A\'s warnings but no completion', async () => {
  for (const sessions of [[A, A, A, A2], [A, A, A, A, A2], [A, A, A, A, A, A2], [A, A, A, A, A, A, A2]]) {
    const h = harness({ sessions });
    const result = await h.client.end(input(await h.client.preview()));
    assert.equal(result.ok, false, `refreshed at read ${sessions.length}`); assert.ok(both(result)); assert.ok(!completed(result));
  }
});

test('the normal path still completes with both warnings when A is observed throughout', async () => {
  const h = harness();
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.ok, true); assert.ok(completed(result)); assert.ok(both(result));
});

// ---------------------------------------------------------------- double submission / retry

test('double submission sends one mutation; the late answer after a switch carries none of A\'s facts', async () => {
  let release; const held = new Promise((r) => { release = r; });
  const h = harness({ responses: [answer(previewBody()), async () => { await held; return answer(ended); }, answer(previewBody('ended'))] });
  const p = await h.client.preview();
  const first = h.client.end(input(p));
  assert.equal((await h.client.end(input(p))).code, 'DELETION_IN_PROGRESS');
  await new Promise((r) => setImmediate(r)); h.switchTo(B); release();
  const result = await first;
  assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result));
  assert.equal(h.calls.filter((c) => c.action === 'withdraw_postona').length, 1);
  assert.equal((await h.client.end(input(p))).code, 'LIFECYCLE_CHANGED', 'the consumed preview cannot be replayed');
});

// ---------------------------------------------------------------- the actual screen still hides a late result

const jwt = (id, sid) => ({ user: { id, identities: [{ provider: 'email' }] }, access_token: `synthetic.${Buffer.from(JSON.stringify({ session_id: sid })).toString('base64url')}.signature` });
const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); walk(n.props?.children, out); } return out; };
const texts = (tree) => walk(tree).filter((n) => n.type === 'Text' || n.type === 'SectionTitle').map((n) => [n.props.children].flat(Infinity).filter((s) => typeof s === 'string').join(''));
const findButton = (tree, label) => walk(tree).find((n) => n.type === 'Pressable' && texts(n).some((s) => s.includes(label)));
const flush = () => new Promise((r) => setImmediate(r));

test('actual screen control: A\'s late result (with A\'s warning lines) is not shown once B is signed in', async () => {
  const slots = []; let cursor = 0; const effects = [];
  const ctxA = { userId: 'u1', sessionId: 's1' };
  const bound = { ok: true, accountStatus: 'active', lifecycleVersion: 7, services: [{ service: 'kabumori', status: 'active' }, { service: 'x_autopost', status: 'active' }], acknowledgementRequired: ['threads'], postonaAvailable: true, deletionInProgress: false, context: ctxA };
  let release; const held = new Promise((r) => { release = r; });
  const auth = { session: jwt('u1', 's1'), backendAvailable: true, email: { signIn: true }, readiness: () => ({ usableNow: true }),
    reauthenticate: async () => ({ ok: true, context: ctxA }), previewPostonaEnd: async () => bound, endPostonaService: async () => held };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(cb) { return cb; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((v, j) => v !== slots[i][j])) { slots[i] = deps; effects.push(fn); } },
  };
  const jsx = (type, props) => ({ type, props });
  const modules = { react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': Object.fromEntries(['ActivityIndicator', 'Linking', 'Pressable', 'ScrollView', 'Text', 'TextInput'].map((n) => [n, n])),
    '@/constants/theme': { colors: {} }, '@/components/ui': { Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/domain/account-deletion': account, '@/domain/postona-service-end': { ...endDomain, POSTONA_END_SOURCE_ENABLED: true }, '@/domain/postona-end-notices': notices,
    '@/domain/auth-flows': flows, '@/domain/recovery-binding': recovery, '@/domain/legal-links': { LEGAL_LINK_LABELS: {} },
    '@/lib/legal-config': { LEGAL_LINKS: { support: {} } }, '@/providers/auth-provider': { useAuth: () => auth },
    '@/features/service-lifecycle/service-lifecycle': { useServiceLifecycle: () => ({ openFor: null, open: () => false, close() {}, bump: () => false }) } };
  const source = await readFile(new URL('../src/app/account-deletion.tsx', import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, require: (n) => { assert.ok(Object.hasOwn(modules, n), n); return modules[n]; } });
  const render = () => { cursor = 0; const tree = module.exports.default(); effects.splice(0).forEach((fn) => fn()); return tree; };
  render(); await flush();
  walk(render()).find((n) => n.type === 'TextInput' && n.props.secureTextEntry).props.onChangeText('synthetic');
  await findButton(render(), 'で本人確認').props.onPress(); await flush();
  walk(render()).find((n) => n.type === 'TextInput' && !n.props.secureTextEntry).props.onChangeText(POSTONA_END_CONFIRM_PHRASE);
  walk(render()).find((n) => n.type === 'Pressable' && n.props.accessibilityRole === 'checkbox').props.onPress();
  findButton(render(), 'POSTONAの利用を終了').props.onPress(); await flush();
  // B signs in while A's answer is still on its way; A's answer (with A's warnings) then arrives.
  auth.session = jwt('u2', 's2'); render();
  release(endDomain.endFailure('RESULT_UNCONFIRMED', undefined, { remoteUnverified: ['threads'], xPostsUnconfirmed: 2 })); await flush();
  const shown = texts(render());
  // (The Threads remote line is also part of the screen's general explanation, so A's RESULT is identified by the
  // unconfirmed-count line and the result notice, which only a result shows.)
  assert.ok(!shown.some((s) => s.includes('予約が2件')), 'B sees none of A\'s warnings');
  assert.ok(!shown.some((s) => s.includes('手続きの結果を確認できませんでした')), 'B sees none of A\'s result');
  // Control: the same late answer IS shown when A is still signed in.
  auth.session = jwt('u1', 's1'); const again = texts(render());
  assert.ok(again.some((s) => s.includes('予約が2件')), 'A still sees A\'s own result');
});
