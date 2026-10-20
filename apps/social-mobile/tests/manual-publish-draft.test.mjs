// F1/G1 manual X single post, G2-U1: the short-lived copy of the DRAFT (manual-publish-draft-store.ts) that lets what the
// person typed survive a callback route replacing the screen. Proven offline with a device storage that can fail.
// The copy holds text + chosen account + sign-in session mark + time -- never a token, a consent, a confirmation, a
// reservation or a clientRequestId -- and every doubt means "no draft" (and the record is removed).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as draft from '../src/features/manual-publish/manual-publish-draft-store.ts';
import * as m from '../src/features/manual-publish/manual-publish-model.ts';

const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'];
const saved = new Map();
let trapped = 0;
test.before(() => {
  for (const name of NETWORK) {
    saved.set(name, globalThis[name]);
    globalThis[name] = function forbidden() { trapped += 1; throw new Error(`network entry point ${name} must not be used`); };
  }
});
test.after(() => {
  for (const name of NETWORK) {
    if (saved.get(name) === undefined) delete globalThis[name];
    else globalThis[name] = saved.get(name);
  }
});

const NOW = 1_000_000_000_000;
const KEY = (userId = 'U1') => draft.draftKeyOf(userId);
const account = (id, over = {}) => ({ id, brandId: 'A', platform: 'x', profile: { displayName: id, handle: `@${id}`, avatarColor: '#000000' }, connectionStatus: 'connected', postingState: 'active', ...over });
const RECORD = (over = {}) => ({ accountId: 'X_A', text: '下書きの本文', sessionMark: 'S1', savedAt: NOW - 1000, ...over });
const NOWARGS = (over = {}) => ({ at: NOW, sessionMark: 'S1', xAccounts: [account('X_A'), account('X_B')], ...over });

function fakeKV() {
  const data = new Map();
  const fail = { get: false, set: false, remove: false };
  const log = [];
  return {
    data, fail, log,
    getItem: async (key) => { if (fail.get) throw new Error('read failed'); return data.has(key) ? data.get(key) : null; },
    setItem: async (key, value) => { log.push(['set', value]); if (fail.set) throw new Error('write failed'); data.set(key, value); },
    removeItem: async (key) => { log.push(['remove']); if (fail.remove) throw new Error('remove failed'); data.delete(key); },
  };
}
const stored = (over = {}) => JSON.stringify({ v: 1, ...RECORD(over) });

// ---- the record --------------------------------------------------------------------------------------------------------------

test('record: it round-trips and holds exactly account, text, session mark and time -- nothing a send could use', async () => {
  const kv = fakeKV();
  const s = draft.createDraftStore(kv);
  assert.equal(await s.write('U1', RECORD()), true);
  assert.deepEqual(JSON.parse(kv.data.get(KEY())), { v: 1, accountId: 'X_A', text: '下書きの本文', sessionMark: 'S1', savedAt: NOW - 1000 });
  assert.deepEqual(await s.read('U1'), { kind: 'found', record: RECORD() });
  // Fields handed to write() that are not part of the record are not stored (an explicit whitelist).
  await s.write('U1', { ...RECORD(), accessToken: 'SECRET-TOKEN', consent: { confirmed: true }, clientRequestId: '00000000-0000-4000-8000-000000000001', requestId: 'r', contentSha256: 'a'.repeat(64) });
  const raw = kv.data.get(KEY());
  for (const forbidden of ['SECRET-TOKEN', 'consent', 'clientRequestId', '00000000-0000', 'requestId', 'contentSha256']) assert.ok(!raw.includes(forbidden), forbidden);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['accountId', 'savedAt', 'sessionMark', 'text', 'v']);
  // A draft without an account choice is allowed.
  await s.write('U1', RECORD({ accountId: null }));
  assert.equal((await s.read('U1')).record.accountId, null);
});

test('record: one per signed-in user; a user id that cannot be a key is never read, written or cleared', async () => {
  const kv = fakeKV();
  const s = draft.createDraftStore(kv);
  await s.write('U1', RECORD());
  assert.deepEqual(await s.read('U2'), { kind: 'none' });
  assert.notEqual(KEY('U1'), KEY('U2'));
  assert.equal(await s.clear('U2'), true);
  assert.equal((await s.read('U1')).kind, 'found', "clearing another user's record does not touch this one");
  for (const userId of ['', 'a/b', 'x'.repeat(65), 'u 1']) {
    assert.equal((await s.read(userId)).kind, 'unreadable', userId);
    assert.equal(await s.write(userId, RECORD()), false, userId);
    assert.equal(await s.clear(userId), false, userId);
  }
});

test('record: anything that is not exactly what was written is unreadable -- corrupt, extra field, wrong types, too long, newer version', async () => {
  const cases = [
    ['not json', '{oops', 'corrupt'],
    ['null', 'null', 'corrupt'],
    ['array', '[]', 'corrupt'],
    ['empty object', '{}', 'corrupt'],
    ['missing field', JSON.stringify({ v: 1, accountId: 'X_A', text: 't', sessionMark: 'S1' }), 'corrupt'],
    ['extra field (a token)', JSON.stringify({ v: 1, ...RECORD(), accessToken: 'x' }), 'corrupt'],
    ['extra field (a consent)', JSON.stringify({ v: 1, ...RECORD(), consent: { confirmed: true } }), 'corrupt'],
    ['text a number', stored({ text: 5 }), 'corrupt'],
    ['text too long', stored({ text: 'あ'.repeat(draft.DRAFT_MAX_TEXT_UNITS + 1) }), 'corrupt'],
    ['bad account', stored({ accountId: 'a b' }), 'corrupt'],
    ['account a number', stored({ accountId: 7 }), 'corrupt'],
    ['mark too long', stored({ sessionMark: 'm'.repeat(65) }), 'corrupt'],
    ['time a string', stored({ savedAt: 'now' }), 'corrupt'],
    ['time infinite', '{"v":1,"accountId":"X_A","text":"t","sessionMark":"S1","savedAt":1e999}', 'corrupt'],
    ['newer version', JSON.stringify({ ...RECORD(), v: 2 }), 'version'],
    ['version as text', JSON.stringify({ ...RECORD(), v: '1' }), 'corrupt'],
  ];
  for (const [label, raw, reason] of cases) {
    const kv = fakeKV();
    kv.data.set(KEY(), raw);
    assert.deepEqual(await draft.createDraftStore(kv).read('U1'), { kind: 'unreadable', reason }, label);
  }
  const kv = fakeKV();
  kv.fail.get = true;
  assert.deepEqual(await draft.createDraftStore(kv).read('U1'), { kind: 'unreadable', reason: 'io' });
  kv.fail.get = false;
  kv.getItem = async () => 42;
  assert.deepEqual(await draft.createDraftStore(kv).read('U1'), { kind: 'unreadable', reason: 'corrupt' });
});

test('record: a failed write or remove is only "not kept" (false) -- it never throws', async () => {
  const kv = fakeKV();
  const s = draft.createDraftStore(kv);
  kv.fail.set = true;
  assert.equal(await s.write('U1', RECORD()), false);
  kv.fail.set = false;
  await s.write('U1', RECORD());
  kv.fail.remove = true;
  assert.equal(await s.clear('U1'), false);
});

test('record: writes and removals are applied strictly in the order asked, and a read waits for them (no older text can win)', async () => {
  const kv = fakeKV();
  const slow = kv.setItem;
  let release;
  kv.setItem = (key, value) => (value.includes('一回目') ? new Promise((resolve) => { release = () => resolve(slow(key, value)); }) : slow(key, value));
  const s = draft.createDraftStore(kv);
  const first = s.write('U1', RECORD({ text: '一回目' }));
  const second = s.write('U1', RECORD({ text: '二回目' }));
  const read = s.read('U1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kv.data.size, 0, 'the second write waits for the first');
  release();
  await Promise.all([first, second]);
  assert.equal((await read).record.text, '二回目');
  const cleared = s.clear('U1');
  const after = s.read('U1');
  await cleared;
  assert.deepEqual(await after, { kind: 'none' });
});

// ---- what may be put back -----------------------------------------------------------------------------------------------------

test('decideRestore: a fresh draft of this session for a connected X account is restored with its text and account', () => {
  assert.deepEqual(draft.decideRestore(RECORD(), NOWARGS()), { kind: 'restore', text: '下書きの本文', accountId: 'X_A' });
  assert.deepEqual(draft.decideRestore(RECORD({ accountId: null }), NOWARGS()), { kind: 'restore', text: '下書きの本文', accountId: null });
  // An account that needs attention is still the person's account: the send gate (not the draft) judges it.
  assert.equal(draft.decideRestore(RECORD(), NOWARGS({ xAccounts: [account('X_A', { connectionStatus: 'needs_attention' })] })).kind, 'restore');
});

test('decideRestore: every doubt is a discard -- empty, expired, from the future, another session, account gone / disconnected / not X', () => {
  const reason = (record, args) => {
    const d = draft.decideRestore(record, args ?? NOWARGS());
    assert.equal(d.kind, 'discard', JSON.stringify(record));
    return d.reason;
  };
  assert.equal(reason(RECORD({ text: '' })), 'empty');
  assert.equal(reason(RECORD({ text: ' \n\t ' })), 'empty');
  assert.equal(reason(RECORD({ savedAt: NOW - draft.DRAFT_MAX_AGE_MS - 1 })), 'expired');
  assert.equal(draft.decideRestore(RECORD({ savedAt: NOW - draft.DRAFT_MAX_AGE_MS }), NOWARGS()).kind, 'restore', 'exactly 24h is still fresh');
  assert.equal(reason(RECORD({ savedAt: NOW + 6 * 60 * 1000 })), 'future');
  assert.equal(draft.decideRestore(RECORD({ savedAt: NOW + 60 * 1000 }), NOWARGS()).kind, 'restore', 'a small clock skew is tolerated');
  assert.equal(reason(RECORD({ sessionMark: 'S0' })), 'other_session');
  assert.equal(reason(RECORD({ sessionMark: '' }), NOWARGS({ sessionMark: 'S1' })), 'other_session');
  assert.equal(reason(RECORD({ accountId: 'X_Z' })), 'account_missing');
  assert.equal(reason(RECORD(), NOWARGS({ xAccounts: [] })), 'account_missing');
  assert.equal(reason(RECORD({ accountId: 'T_1' }), NOWARGS({ xAccounts: [account('T_1', { platform: 'threads' })] })), 'account_missing');
  assert.equal(reason(RECORD(), NOWARGS({ xAccounts: [account('X_A', { connectionStatus: 'not_connected' })] })), 'account_disconnected');
});

test('loadDraftForRestore: whatever is not restored is removed from the device; a restored one stays', async () => {
  for (const [label, raw, args, expected] of [
    ['fresh', stored(), NOWARGS(), 'restore'],
    ['expired', stored({ savedAt: NOW - draft.DRAFT_MAX_AGE_MS - 1 }), NOWARGS(), 'discard'],
    ['other session', stored({ sessionMark: 'S0' }), NOWARGS(), 'discard'],
    ['account gone', stored({ accountId: 'X_Z' }), NOWARGS(), 'discard'],
    ['corrupt', '{broken', NOWARGS(), 'discard'],
    ['newer version', JSON.stringify({ ...RECORD(), v: 9 }), NOWARGS(), 'discard'],
  ]) {
    const kv = fakeKV();
    kv.data.set(KEY(), raw);
    const result = await draft.loadDraftForRestore(draft.createDraftStore(kv), 'U1', args);
    assert.equal(result.kind, expected, label);
    assert.equal(kv.data.has(KEY()), expected === 'restore', `${label}: the record ${expected === 'restore' ? 'stays' : 'is removed'}`);
  }
  const none = fakeKV();
  assert.deepEqual(await draft.loadDraftForRestore(draft.createDraftStore(none), 'U1', NOWARGS()), { kind: 'none' });
  // A storage that throws on read, or an unremovable record: never restored, never an exception.
  const broken = fakeKV();
  broken.fail.get = true;
  assert.equal((await draft.loadDraftForRestore(draft.createDraftStore(broken), 'U1', NOWARGS())).kind, 'discard');
  assert.equal((await draft.loadDraftForRestore({ read: async () => { throw new Error('boom'); }, clear: async () => { throw new Error('boom'); } }, 'U1', NOWARGS())).kind, 'discard');
  const stuck = fakeKV();
  stuck.data.set(KEY(), stored({ sessionMark: 'S0' }));
  stuck.fail.remove = true;
  assert.equal((await draft.loadDraftForRestore(draft.createDraftStore(stuck), 'U1', NOWARGS())).kind, 'discard', 'not restored even if it cannot be removed');
});

// ---- the reducer: restored once, into an untouched editor only ---------------------------------------------------------------------

const apply = (state, ...actions) => actions.reduce((s, a) => m.manualPublishReducer(s, a), state);

test('draft_restored: puts text and account into an untouched editor ONCE, with no consent, confirmation or attempt', () => {
  const start = m.createInitialState();
  assert.equal(start.draftRestore, 'pending');
  const restored = apply(start, { type: 'draft_restored', text: '下書き', accountId: 'X_B' });
  assert.equal(restored.draft, '下書き');
  assert.equal(restored.accountId, 'X_B');
  assert.equal(restored.phase, 'editing');
  assert.equal(restored.consent, null);
  assert.equal(restored.readiness, null);
  assert.equal(restored.requestId, null);
  assert.equal(restored.result, null);
  assert.equal(restored.unresolved, null);
  assert.equal(restored.draftRestore, 'done');
  const again = apply(restored, { type: 'draft_changed', text: '' }, { type: 'draft_restored', text: '別の下書き', accountId: 'X_A' });
  assert.equal(again.draft, '', 'looked at once: a cleared draft is never put back');
  // An account of the current choice is kept when the record has none.
  const kept = apply(apply(start, { type: 'account_selected', accountId: 'X_A' }), { type: 'draft_restored', text: 't', accountId: null });
  assert.equal(kept.accountId, 'X_A');
});

test('draft_restored: never over text the person already typed, a phase that moved on, an unresolved attempt or an unready record', () => {
  const start = m.createInitialState();
  const typed = apply(start, { type: 'draft_changed', text: 'もう入力した' }, { type: 'draft_restored', text: '古い下書き', accountId: 'X_B' });
  assert.equal(typed.draft, 'もう入力した');
  assert.equal(typed.draftRestore, 'done');
  const confirming = apply(start, { type: 'account_selected', accountId: 'X_A' }, { type: 'draft_changed', text: 'a' }, { type: 'confirm_opened' }, { type: 'draft_restored', text: 'x', accountId: 'X_B' });
  assert.equal(confirming.draft, 'a');
  assert.equal(confirming.phase, 'confirming');
  const loading = m.createInitialState(null, { kind: 'loading' });
  assert.equal(apply(loading, { type: 'draft_restored', text: 'x', accountId: null }), loading, 'the record of an unresolved attempt is not known yet: wait');
  const unresolved = m.createInitialState({ accountId: 'X_A', requestId: '00000000-0000-4000-8000-000000000001', contentSha256: 'a'.repeat(64), text: null, kind: 'pending' });
  assert.equal(unresolved.draftRestore, 'done', 'an unresolved attempt starts with no draft to restore');
  assert.equal(apply(unresolved, { type: 'draft_restored', text: 'x', accountId: null }), unresolved);
  for (const text of [null, '', '   ']) assert.equal(apply(start, { type: 'draft_restored', text, accountId: null }).draft, '', String(text));
  assert.equal(apply(start, { type: 'draft_restored', text: 'x', accountId: 'a b' }).draft, '', 'an account id the server would refuse is not accepted');
});

test('draft_restored: its own guards hold even for a state that should not exist (a confirmation / unresolved attempt / old consent still pending a restore)', () => {
  const base = m.createInitialState();
  const confirming = { ...base, phase: 'confirming', draft: '', accountId: 'X_A' };
  const a = apply(confirming, { type: 'draft_restored', text: '復元', accountId: 'X_B' });
  assert.equal(a.draft, '', 'not into a confirmation');
  assert.equal(a.accountId, 'X_A');
  assert.equal(a.draftRestore, 'done');
  const attempt = { accountId: 'X_A', requestId: '00000000-0000-4000-8000-000000000001', contentSha256: 'a'.repeat(64), text: null, kind: 'pending' };
  const unresolved = { ...m.createInitialState(attempt), phase: 'editing', draft: '', draftRestore: 'pending' };
  const b = apply(unresolved, { type: 'draft_restored', text: '復元', accountId: 'X_B' });
  assert.equal(b.draft, '', 'not in front of an unresolved attempt');
  assert.equal(b.accountId, 'X_A');
  const withConsent = { ...base, consent: { accountId: 'X_A', contentSha256: 'b'.repeat(64) }, readiness: { accountId: 'X_A', checkedAt: 1, result: { kind: 'ready' } } };
  const c = apply(withConsent, { type: 'draft_restored', text: '復元', accountId: 'X_A' });
  assert.equal(c.draft, '復元');
  assert.equal(c.consent, null, 'a restored draft starts without any consent');
  assert.equal(c.readiness, null);
});

test('no network entry point was touched by any step', () => {
  assert.equal(trapped, 0);
});
