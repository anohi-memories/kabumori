// The X unconfirmed-post evidence contract (x_unconfirmed.ts): the pair of a saga answer, the acknowledgement's
// arguments and the reading of its answers. The integrated test (supabase/tests/common_account_phase8_integrated_test.ts,
// I0) holds each equal to F3's own mapper over the real PR #204 source; this file holds the cases that can be run without
// F3's tree.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACK_ROUNDS,
  SNAPSHOT_PATTERN,
  xUnconfirmedAckArgs,
  xUnconfirmedAckOutcomeOf,
  xUnconfirmedPairOf,
} from './x_unconfirmed.ts';

const SNAP = '0123456789abcdef'.repeat(4);
const USER = '00000000-0000-4000-8000-0000000000aa';

test('a snapshot is exactly 64 lowercase hex characters', () => {
  assert.ok(SNAPSHOT_PATTERN.test(SNAP));
  for (const bad of ['', SNAP.toUpperCase(), SNAP.slice(1), `${SNAP}0`, ` ${SNAP.slice(1)}`, `${SNAP.slice(0, 63)}g`, `${SNAP}\n`]) {
    assert.ok(!SNAPSHOT_PATTERN.test(bad), JSON.stringify(bad));
  }
});

test('the pair of a saga answer: both or neither', () => {
  assert.equal(xUnconfirmedPairOf(undefined, undefined), null, 'nothing unconfirmed');
  assert.deepEqual(xUnconfirmedPairOf(3, SNAP), { count: 3, snapshot: SNAP });
  for (const [count, snapshot] of [
    [3, undefined], [undefined, SNAP], [0, SNAP], [-1, SNAP], [1.5, SNAP], ['3', SNAP], [null, SNAP],
    [3, null], [3, ''], [3, SNAP.toUpperCase()], [3, 7], [3, SNAP.slice(1)],
  ] as [unknown, unknown][]) {
    assert.equal(xUnconfirmedPairOf(count, snapshot), 'invalid', JSON.stringify([count, snapshot]));
  }
});

test('the acknowledgement names the person and the snapshot, never a count', () => {
  assert.deepEqual(xUnconfirmedAckArgs(USER, SNAP), { p_user_id: USER, p_snapshot: SNAP });
  for (const bad of ['', 'abc', SNAP.toUpperCase(), `${SNAP}0`]) assert.throws(() => xUnconfirmedAckArgs(USER, bad), /X_UNCONFIRMED_SNAPSHOT_INVALID/u);
});

test('every answer of the acknowledgement has one reading; anything else clears nothing', () => {
  assert.deepEqual(xUnconfirmedAckOutcomeOf({ status: 'acknowledged', replay: false, cleared: 2 }), { status: 'acknowledged', cleared: 2, replay: false });
  assert.deepEqual(xUnconfirmedAckOutcomeOf({ status: 'acknowledged', replay: true, cleared: 2 }), { status: 'acknowledged', cleared: 2, replay: true });
  assert.deepEqual(xUnconfirmedAckOutcomeOf({ status: 'snapshot_changed', x_posts_unconfirmed: 4, x_unconfirmed_snapshot: SNAP }),
    { status: 'snapshot_changed', count: 4, snapshot: SNAP });
  assert.deepEqual(xUnconfirmedAckOutcomeOf({ status: 'snapshot_changed', x_posts_unconfirmed: 0, x_unconfirmed_snapshot: null }),
    { status: 'snapshot_changed', count: 0, snapshot: null }, 'the saga holds nothing any more');
  assert.deepEqual(xUnconfirmedAckOutcomeOf({ status: 'deletion_in_progress' }), { status: 'deletion_in_progress' });
  assert.deepEqual(xUnconfirmedAckOutcomeOf({ status: 'snapshot_required' }), { status: 'snapshot_required' });
  for (const body of [
    { status: 'acknowledged', replay: false }, { status: 'acknowledged', replay: false, cleared: 0 }, { status: 'acknowledged', replay: false, cleared: -1 },
    { status: 'acknowledged', replay: false, cleared: 1.5 }, { status: 'acknowledged', cleared: 2 }, { status: 'acknowledged', replay: 'no', cleared: 2 },
    { status: 'snapshot_changed' }, { status: 'snapshot_changed', x_posts_unconfirmed: 2, x_unconfirmed_snapshot: null },
    { status: 'snapshot_changed', x_posts_unconfirmed: 2, x_unconfirmed_snapshot: 'ABC' },
    { status: 'snapshot_changed', x_posts_unconfirmed: 0, x_unconfirmed_snapshot: SNAP },
    { status: 'snapshot_changed', x_posts_unconfirmed: -1, x_unconfirmed_snapshot: SNAP },
    { status: 'cleared' }, { status: 7 }, {}, [], null, undefined, 'acknowledged',
  ]) {
    assert.deepEqual(xUnconfirmedAckOutcomeOf(body), { status: 'failed' }, JSON.stringify(body));
  }
});

test('the number of rounds is small and fixed', () => {
  assert.ok(Number.isInteger(ACK_ROUNDS) && ACK_ROUNDS >= 1 && ACK_ROUNDS <= 8);
});
