// G1 TASK 46 (G2 #10, G3-02 #19 §5a): the read-only history a person sees once the X autopost service has ended. The REAL hook, the
// REAL component and the REAL approval client over a scripted stand-in of G3's API in its service-ended state: notifications / get
// answer 200, every write answers 403 SERVICE_NOT_ACTIVE. React / RN are stubbed; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as approvalView from '../src/features/approvals/approval-view.ts';
import { has, texts, walk } from './approvals-harness.mjs';
import { mountEndedHistory as mount } from './ended-history-harness.mjs';

const REAL_FETCH = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = REAL_FETCH; });

// G3 after the service ended: reads answer, writes are refused. Each row belongs to one person; another person's id is NOT_FOUND.
function endedG3() {
  const s = { calls: [], tokens: { 'jwt-a': 'person-a', 'jwt-b': 'person-b' }, candidates: [], notes: [] };
  const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const strip = ({ owner: _o, ...rest }) => rest;
  s.fetch = async (url, init) => {
    const { action, payload } = JSON.parse(init.body);
    const token = (init.headers.authorization ?? '').replace(/^Bearer /u, '');
    s.calls.push({ action, token, payload });
    const who = s.tokens[token];
    if (!who) return out(401, { ok: false, code: 'AUTH_REQUIRED' });
    if (s.inject?.[action]) return out(s.inject[action].status, s.inject[action].body);
    if (action === 'notifications') return out(200, { ok: true, notifications: s.notes.filter((n) => n.owner === who).map(strip) });
    if (action === 'get') { const c = s.candidates.find((x) => x.owner === who && x.candidateId === payload.candidateId); return c ? out(200, { ok: true, candidates: [strip(c)] }) : out(404, { ok: false, code: 'POSTONA_RESV_NOT_FOUND' }); }
    if (['submit', 'revise', 'approve'].includes(action)) return out(403, { ok: false, code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE' });
    return out(400, { ok: false, code: 'REQUEST_INVALID' });
  };
  s.candidate = (owner, id, body, state, revision = 1) => s.candidates.push({ owner, candidateId: id, socialAccountId: `sa_${owner}`, body, contentSha256: 'a'.repeat(64), scheduledAt: '2026-11-20T01:00:00.000Z', state, revision, reservationId: state === 'approved' ? 'resv-1' : null, decidedAt: null, createdAt: '2026-11-10T01:00:00.000Z' });
  let n = 0;
  s.note = (owner, kind, candidateId, revision = 1) => { n += 1; s.notes.unshift({ owner, notificationId: `n-${n}`, kind, candidateId, reservationId: null, subjectRevision: revision, state: null, scheduledAt: null, createdAt: new Date(Date.UTC(2026, 10, 10, 2, n)).toISOString(), readAt: null }); };
  return s;
}


function worldOfA() {
  const srv = endedG3();
  srv.candidate('person-a', 'cand-x', 'Aの候補X（修正済み）', 'pending_approval', 2);
  srv.candidate('person-a', 'cand-y', 'Aの候補Y', 'approved');
  srv.candidate('person-b', 'cand-b', 'Bだけの候補', 'pending_approval');
  srv.note('person-a', 'approval_requested', 'cand-x', 1);
  srv.note('person-a', 'approval_requested', 'cand-y', 1);
  srv.note('person-a', 'approval_requested', 'cand-x', 2);
  srv.note('person-a', 'approval_approved', 'cand-y', 1);
  srv.note('person-b', 'approval_requested', 'cand-b', 1);
  return srv;
}

test('T46 ended history: the person\'s own candidates and grouped notifications; only notifications + get are sent; no write, no input, no mark-read', async () => {
  const srv = worldOfA();
  const h = await mount({ fetch: srv.fetch });
  const tree = await h.render();
  assert.ok(has(tree, approvalView.ENDED_HISTORY_NOTE));
  assert.ok(has(tree, 'Aの候補X（修正済み）') && has(tree, 'Aの候補Y'));
  assert.ok(has(tree, approvalView.STATE_LABEL.pending_approval) && has(tree, approvalView.STATE_LABEL.approved));
  assert.ok(has(tree, approvalView.olderRequestsText(1)), 'cand-x\'s two requests are one line');
  assert.ok(!has(tree, 'Bだけの候補'));
  assert.deepEqual([...new Set(srv.calls.map((c) => c.action))].sort(), ['get', 'notifications']);
  assert.deepEqual(srv.calls.filter((c) => c.action === 'get').map((c) => c.payload.candidateId).sort(), ['cand-x', 'cand-y'], 'one get per candidate, not per row');
  assert.ok(srv.calls.every((c) => c.token === 'jwt-a'));
  assert.deepEqual(h.buttons(tree).map((b) => b.label), ['最新の状態を読み込む'], 'the only button reads again');
  assert.equal(srv.notes.filter((n) => n.readAt !== null).length, 0);
});

test('T46 ended history: a notification naming a candidate the server will not show (another person\'s, another workspace\'s) shows no candidate, only a count', async () => {
  const srv = worldOfA();
  srv.note('person-a', 'approval_requested', 'cand-b', 1);   // the server answers get(cand-b) for A with NOT_FOUND
  const h = await mount({ fetch: srv.fetch });
  const tree = await h.render();
  assert.ok(!has(tree, 'Bだけの候補'));
  assert.ok(has(tree, '読み込めなかった投稿候補が 1件あります。'));
  assert.ok(h.frames.every((f) => !has(f, 'Bだけの候補')));
});

test('T46 ended history: the session moved to B under A\'s view: nothing is sent with B\'s token, A\'s rows go; B\'s own view shows only B', async () => {
  const srv = worldOfA();
  const h = await mount({ fetch: srv.fetch });
  let tree = await h.render();
  assert.ok(has(tree, 'Aの候補Y'));
  h.world.session = { token: 'jwt-b', userId: 'person-b' };
  const before = srv.calls.length;
  walk(tree, (n) => { if (n.type === 'ActionButton' && n.props.label === '最新の状態を読み込む') n.props.onPress(); });
  tree = await h.render();
  assert.equal(srv.calls.length, before, 'the client refuses to send B\'s token for A');
  assert.ok(!has(tree, 'Aの候補Y'));
  assert.ok(has(tree, approvalView.ACTION_TEXT.sign_in));
  h.frames.length = 0;
  h.world.userId = 'person-b';
  tree = await h.render();
  assert.ok(h.frames.every((f) => !has(f, 'Aの候補')), 'B never sees A\'s rows');
  assert.ok(has(tree, 'Bだけの候補'));
  assert.ok(srv.calls.slice(before).every((c) => c.token === 'jwt-b'));
});

test('T46 ended history: gate off, a non-https endpoint, or no person: nothing is shown and nothing is sent', async () => {
  for (const initial of [{ gate: false }, { config: { ok: true, config: { url: 'http://proj.example.test', publishableKey: 'sb_publishable_testkey01' } } }, { userId: null }, { config: { ok: false } }]) {
    const srv = worldOfA();
    const h = await mount({ fetch: srv.fetch, ...initial });
    const tree = await h.render();
    assert.equal(tree, null, JSON.stringify(initial));
    assert.equal(srv.calls.length, 0, JSON.stringify(initial));
  }
});

test('T46 ended history: a refused or lost read says it could not read and shows no rows; the retry that works shows them', async () => {
  const srv = worldOfA();
  srv.inject = { notifications: { status: 403, body: { ok: false, code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE' } } };
  const h = await mount({ fetch: srv.fetch });
  let tree = await h.render();
  assert.ok(has(tree, approvalView.ACTION_TEXT.forbidden));
  assert.ok(!has(tree, 'Aの候補Y'));
  srv.inject = { notifications: { status: 503, body: { ok: false, code: 'STORE_UNAVAILABLE' } } };
  walk(tree, (n) => { if (n.type === 'ActionButton' && n.props.label === 'もう一度読み込む') n.props.onPress(); });
  tree = await h.render();
  assert.ok(has(tree, approvalView.readFailedText('later')));
  srv.inject = {};
  walk(tree, (n) => { if (n.type === 'ActionButton' && n.props.label === 'もう一度読み込む') n.props.onPress(); });
  tree = await h.render();
  assert.ok(has(tree, 'Aの候補Y'));
  assert.ok(!texts(tree).some((t) => t.includes('読み込めませんでした')));
});

test('T46 ended history: the source sends no write — the hook only calls notifications and get', async () => {
  const source = await readFile(new URL('../src/features/approvals/use-ended-history.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
  assert.deepEqual([...code.matchAll(/client\.(\w+)\(/gu)].map((m) => m[1]).sort(), ['get', 'notifications']);
});

test('T46 ended history: A -> B while B\'s read is still on its way: no frame shows A\'s rows to B, B\'s own rows arrive, A\'s late answer never lands', async () => {
  const srv = worldOfA();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetch = async (url, init) => { if ((init.headers.authorization ?? '').endsWith('jwt-b')) await gate; return srv.fetch(url, init); };
  const h = await mount({ fetch });
  let tree = await h.render();
  assert.ok(has(tree, 'Aの候補Y'));
  h.frames.length = 0;
  h.world.session = { token: 'jwt-b', userId: 'person-b' };
  h.world.userId = 'person-b';
  tree = await h.render(3);
  assert.ok(has(tree, '読み込んでいます'), 'B waits for its own read');
  release();
  tree = await h.render();
  assert.ok(has(tree, 'Bだけの候補'));
  assert.ok(h.frames.every((f) => !has(f, 'Aの候補')), 'no frame showed A\'s rows to B');
});
