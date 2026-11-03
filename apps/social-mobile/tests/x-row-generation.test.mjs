// G1 TASK 39: the row's connection generation, read from G3 #629's list / get field without G3's type. Pure module; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../src/features/reservations/x-row-generation.ts';
import * as xWriteView from '../src/features/reservations/x-write-view.ts';

const planned = (connectionGeneration) => (connectionGeneration === undefined ? { status: 'planned' } : { status: 'planned', connectionGeneration });

test('only the two words count; absent, null, another word, another type or case is unknown, never current', () => {
  assert.equal(g.rowGenerationOf(planned('current')), 'current');
  assert.equal(g.rowGenerationOf(planned('earlier')), 'earlier');
  for (const value of [undefined, null, 'unknown', 'CURRENT', 'later', '', 1, true, {}, ['current']]) assert.equal(g.rowGenerationOf(planned(value)), 'unknown', String(value));
});

test('the refusal: earlier first, then a refusal this app saw; current and unknown widen nothing and narrow nothing on their own', () => {
  assert.deepEqual(g.rowRefusalOf(planned('earlier'), false), { label: g.EARLIER_LABEL, text: g.EARLIER_TEXT });
  assert.deepEqual(g.rowRefusalOf(planned('earlier'), true), { label: g.EARLIER_LABEL, text: g.EARLIER_TEXT });
  assert.deepEqual(g.rowRefusalOf(planned('current'), true), { label: xWriteView.NOT_EDITABLE_LABEL, text: xWriteView.NOT_EDITABLE_TEXT }, 'a 409 seen here is not undone by current');
  assert.equal(g.rowRefusalOf(planned('current'), false), null);
  assert.equal(g.rowRefusalOf(planned(undefined), false), null);
});

test('the line: planned rows only; current only while the writes are open; unknown always; earlier has its own words', () => {
  assert.equal(g.rowGenerationNote(planned('current'), true), g.CURRENT_TEXT);
  assert.equal(g.rowGenerationNote(planned('current'), false), null);
  assert.equal(g.rowGenerationNote(planned(undefined), false), g.UNKNOWN_TEXT);
  assert.equal(g.rowGenerationNote(planned('weird'), true), g.UNKNOWN_TEXT);
  assert.equal(g.rowGenerationNote(planned('earlier'), true), null);
  assert.equal(g.rowGenerationNote({ status: 'published' }, true), null);
  assert.equal(g.rowGenerationNote({ status: 'cancelled', connectionGeneration: 'current' }, true), null);
});

test('rows the app cannot tell apart: planned and unknown only', () => {
  assert.equal(g.anyGenerationUnproven([]), false);
  assert.equal(g.anyGenerationUnproven([planned('current'), planned('earlier')]), false);
  assert.equal(g.anyGenerationUnproven([planned('current'), planned(undefined)]), true);
  assert.equal(g.anyGenerationUnproven([{ status: 'published' }, { status: 'cancelled' }]), false);
});

test('the words: earlier is never sent even after a reconnect; current and unknown promise nothing', () => {
  assert.match(g.EARLIER_TEXT, /再接続しても投稿されません/u);
  assert.match(g.EARLIER_TEXT, /取り消して/u);
  assert.match(g.CURRENT_TEXT, /投稿を保証するものではありません/u);
  assert.match(g.UNKNOWN_TEXT, /確認できません/u);
  assert.doesNotMatch(g.UNKNOWN_TEXT + g.CURRENT_TEXT, /投稿されます/u);
});
