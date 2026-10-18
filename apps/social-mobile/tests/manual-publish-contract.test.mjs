// F1 manual X single post: the app's copy of the F3 single-post contract (Draft PR #272), the classification of every
// answer, and parity with F3's own file as soon as it exists in this tree. Offline; nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as c from '../src/features/manual-publish/single-post-contract.ts';
import * as model from '../src/features/manual-publish/manual-publish-model.ts';

const RID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT = '00000000-0000-4000-8000-000000000001';

test('the request is exactly the server\'s shape: no user id, consent bound to the text\'s hash', () => {
  const body = c.singlePostRequest({ socialAccountId: 'sa_x', clientRequestId: ATTEMPT, text: 't', contentSha256: 'a'.repeat(64) });
  assert.deepEqual(body, { socialAccountId: 'sa_x', clientRequestId: ATTEMPT, text: 't', consent: { confirmed: true, contentSha256: 'a'.repeat(64) } });
  assert.deepEqual(Object.keys(body).sort(), ['clientRequestId', 'consent', 'socialAccountId', 'text']);
  assert.deepEqual(Object.keys(body.consent).sort(), ['confirmed', 'contentSha256']);
  assert.equal(c.SINGLE_POST_FUNCTION, 'postona-x-single-post');
});

const MATRIX = [
  [200, { ok: true, status: 'sent', reservationId: RID, xPostId: '1790000000000000001' }],
  [200, { ok: true, status: 'sent', reservationId: RID }],
  [200, { ok: true, status: 'sent', reservationId: RID, xPostId: 'abc' }],
  [200, { ok: true, status: 'sent', reservationId: 'x', xPostId: '1' }],
  [200, { ok: true, status: 'pending', reservationId: RID, code: 'IN_PROGRESS' }],
  [200, { ok: true, status: 'pending', reservationId: RID }],
  [200, { ok: true, status: 'failed', reservationId: RID, code: 'X_REJECTED_403' }],
  [200, { ok: true, status: 'uncertain', reservationId: RID, code: 'X_TIMEOUT' }],
  [200, { ok: true, status: 'uncertain', reservationId: RID, code: 'lowercase' }],
  [200, { ok: true, status: 'posted', reservationId: RID }],
  [200, { ok: false, code: 'SOMETHING' }],
  [200, 'ok'],
  [200, null],
  [200, [1, 2]],
  [401, { ok: false, code: 'AUTH_REQUIRED' }],
  [403, { ok: false, code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE' }],
  [409, { ok: false, code: 'POSTONA_RESV_IDEMPOTENCY_CONFLICT' }],
  [422, { ok: false, code: 'POSTONA_RESV_CONSENT_REQUIRED' }],
  [400, { ok: false }],
  [400, { ok: false, code: 'bad code' }],
  [503, { ok: false, code: 'NOT_AVAILABLE' }],
  [503, { ok: false, code: 'X_NOT_AVAILABLE' }],
  [503, { ok: false, code: 'POSTONA_RESV_SERVICE_BUSY' }],
  [500, null],
  [0, undefined],
  [302, { ok: true }],
];

test('results: sent only with a stored X post id; pending / failed / uncertain are typed; refusals; anything else is unavailable', () => {
  assert.deepEqual(c.singlePostResultOf(200, { ok: true, status: 'sent', reservationId: RID, xPostId: '1790000000000000001' }), { kind: 'sent', reservationId: RID, xPostId: '1790000000000000001' });
  assert.deepEqual(c.singlePostResultOf(200, { ok: true, status: 'sent', reservationId: RID }), { kind: 'unavailable', code: null }, 'sent without an id is never sent');
  assert.deepEqual(c.singlePostResultOf(200, { ok: true, status: 'sent', reservationId: RID, xPostId: 'abc' }), { kind: 'unavailable', code: null });
  for (const status of ['pending', 'failed', 'uncertain']) {
    assert.deepEqual(c.singlePostResultOf(200, { ok: true, status, reservationId: RID, code: 'X_TIMEOUT' }), { kind: status, reservationId: RID, code: 'X_TIMEOUT' });
  }
  assert.deepEqual(c.singlePostResultOf(200, { ok: true, status: 'pending', reservationId: RID }), { kind: 'pending', reservationId: RID, code: null });
  assert.deepEqual(c.singlePostResultOf(403, { ok: false, code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE' }), { kind: 'refused', code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE', retryable: false });
  assert.deepEqual(c.singlePostResultOf(401, { ok: false, code: 'AUTH_REQUIRED' }), { kind: 'refused', code: 'AUTH_REQUIRED', retryable: true });
  for (const [status, body] of [[503, { ok: false, code: 'X_NOT_AVAILABLE' }], [200, { ok: true, status: 'posted', reservationId: RID }], [200, { ok: true, status: 'sent', reservationId: 'x', xPostId: '1' }], [500, null], [200, 'ok']]) {
    assert.equal(c.singlePostResultOf(status, body).kind, 'unavailable', JSON.stringify(body));
  }
});

test('the 503 answers carry their stable code but stay "unavailable" (nothing known), never refused / failed', () => {
  assert.deepEqual(c.singlePostResultOf(503, { ok: false, code: 'NOT_AVAILABLE' }), { kind: 'unavailable', code: 'NOT_AVAILABLE' });
  assert.deepEqual(c.singlePostResultOf(503, { ok: false, code: 'POSTONA_RESV_SERVICE_BUSY' }), { kind: 'unavailable', code: 'POSTONA_RESV_SERVICE_BUSY' });
});

test('pending, uncertain, failed, refused and unavailable are five DIFFERENT screen classes (no mis-classification)', () => {
  const attempt = (status, body) => model.resultOf(ATTEMPT, c.outcomeOfSinglePost(ATTEMPT, c.singlePostResultOf(status, body))).kind;
  assert.equal(attempt(200, { ok: true, status: 'pending', reservationId: RID }), 'pending');
  assert.equal(attempt(200, { ok: true, status: 'uncertain', reservationId: RID }), 'uncertain');
  assert.equal(attempt(200, { ok: true, status: 'failed', reservationId: RID }), 'failed');
  assert.equal(attempt(422, { ok: false, code: 'POSTONA_RESV_TEXT_INVALID' }), 'refused');
  assert.equal(attempt(503, { ok: false, code: 'NOT_AVAILABLE' }), 'unconfirmed');
  assert.equal(attempt(200, { ok: true, status: 'sent', reservationId: RID, xPostId: '9' }), 'sent');
  // Nothing but a stored X post id may be "sent"; nothing unknown may be "failed" (provably not posted).
  const classes = new Set();
  for (const [status, body] of MATRIX) {
    const kind = attempt(status, body);
    classes.add(kind);
    const sentBody = body !== null && typeof body === 'object' && !Array.isArray(body) && body.status === 'sent' && /^[0-9]{1,30}$/u.test(String(body.xPostId)) && /^[0-9a-f-]{36}$/u.test(String(body.reservationId));
    if (kind === 'sent') assert.ok(sentBody, JSON.stringify(body));
    if (kind === 'failed') assert.equal(status === 200 && body.status === 'failed', true, JSON.stringify(body));
    if (kind === 'refused') assert.ok(status >= 400 && status < 500, `${status}`);
  }
  assert.deepEqual([...classes].sort(), ['failed', 'pending', 'refused', 'sent', 'uncertain', 'unconfirmed']);
});

test('outcomeOfSinglePost: the attempt id is carried through unchanged, and the vocabulary maps one to one', () => {
  const o = (result) => c.outcomeOfSinglePost(ATTEMPT, result);
  assert.deepEqual(o({ kind: 'sent', reservationId: RID, xPostId: '9' }), { kind: 'published', targetId: ATTEMPT, providerPostId: '9' });
  assert.deepEqual(o({ kind: 'pending', reservationId: RID, code: null }), { kind: 'pending', targetId: ATTEMPT, code: null });
  assert.deepEqual(o({ kind: 'failed', reservationId: RID, code: null }), { kind: 'rejected', targetId: ATTEMPT, code: 'FAILED' });
  assert.deepEqual(o({ kind: 'uncertain', reservationId: RID, code: null }), { kind: 'uncertain', targetId: ATTEMPT, code: 'UNCERTAIN' });
  assert.deepEqual(o({ kind: 'refused', code: 'AUTH_REQUIRED', retryable: true }), { kind: 'refused', targetId: ATTEMPT, code: 'AUTH_REQUIRED', retryable: true });
  assert.deepEqual(o({ kind: 'unavailable', code: 'NOT_AVAILABLE' }), { kind: 'unavailable', targetId: ATTEMPT, code: 'NOT_AVAILABLE' });
});

test('the server\'s input rules are mirrored (UUID attempt id, account id, sha, post id, code shapes)', () => {
  assert.ok(c.UUID_RE.test(ATTEMPT));
  assert.ok(!c.UUID_RE.test(ATTEMPT.toUpperCase().replace(/0/gu, 'A')), 'lowercase only');
  assert.ok(!c.UUID_RE.test(`manual-${ATTEMPT}`));
  assert.ok(c.ACCOUNT_RE.test('sa_x:1-2') && !c.ACCOUNT_RE.test('a b') && !c.ACCOUNT_RE.test('') && !c.ACCOUNT_RE.test('x'.repeat(129)));
  assert.ok(c.SHA_RE.test('a'.repeat(64)) && !c.SHA_RE.test('A'.repeat(64)) && !c.SHA_RE.test('a'.repeat(63)));
  assert.ok(c.POST_ID_RE.test('1') && !c.POST_ID_RE.test('') && !c.POST_ID_RE.test('1'.repeat(31)));
  assert.ok(c.CODE_RE.test('X_TIMEOUT') && !c.CODE_RE.test('x_timeout') && !c.CODE_RE.test('A'));
  assert.equal(c.SERVER_TEXT_MAX_UNITS, 2000);
});

// ---- parity with F3's own file (once PR #272 is in this tree; or point F3_SINGLE_POST_CONTRACT at a checkout) -----------------

const F3_CANDIDATES = [
  process.env.F3_SINGLE_POST_CONTRACT,
  resolve(import.meta.dirname, '../../../supabase/functions/_shared/postona_reservations/single_post_contract.ts'),
].filter(Boolean);
const F3_FILE = F3_CANDIDATES.find((path) => existsSync(path));

test('parity: this copy decides exactly like F3 single_post_contract.ts on every case of the matrix', { skip: F3_FILE ? false : 'F3 single_post_contract.ts is not in this tree (PR #272 is unmerged); set F3_SINGLE_POST_CONTRACT to compare' }, async () => {
  const f3 = await import(pathToFileURL(F3_FILE).href);
  assert.equal(f3.SINGLE_POST_FUNCTION, c.SINGLE_POST_FUNCTION);
  assert.deepEqual(
    f3.singlePostRequest({ socialAccountId: 'sa_x', clientRequestId: ATTEMPT, text: 'テキスト', contentSha256: 'b'.repeat(64) }),
    c.singlePostRequest({ socialAccountId: 'sa_x', clientRequestId: ATTEMPT, text: 'テキスト', contentSha256: 'b'.repeat(64) }),
  );
  for (const [status, body] of MATRIX) assert.deepEqual(c.singlePostResultOf(status, body), f3.singlePostResultOf(status, body), `${status} ${JSON.stringify(body)}`);
});
