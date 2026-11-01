import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planBatch, rerollBatch, editDraftText, moveDraftText, cancelDraft } from '../src/domain/schedule-planner.ts';
import { buildSaveRequest, confirmPost, confirmationHolds, serverReservationLabel, verifySavedByReadBack } from '../src/domain/reservation-flow.ts';
import { createReservationStore, DISABLED_RESERVATION_STORE, POSTONA_RESERVATION_PERSISTENCE_ENABLED } from '../src/features/schedule/reservation-store.ts';

const sha256 = async (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const NOW = new Date('2026-10-11T10:00:00+09:00');
const OWNER = { accountId: 'x_a', brandId: 'brand_a', platform: 'x' };
const TEN = Array.from({ length: 10 }, (_, i) => `手動の投稿${i + 1}`);
const OPT_OUT = { source: 'saved', approvalMode: 'manual_review' };

function tenRandom() {
  const planned = planBatch({ mode: 'manual_random_batch', texts: TEN, dateFrom: '2026-10-15', dateTo: '2026-10-25', window: { start: '09:00', end: '21:00' } },
    { owner: OWNER, now: NOW, batchId: '0f9d2a52-8c1b-4b6a-9d55-1a2b3c4d5e6f' });
  assert.equal(planned.ok, true);
  return planned;
}
async function confirmAll(drafts) {
  const out = {};
  for (const draft of drafts) out[draft.id] = await confirmPost(draft, sha256);
  return out;
}

test('10 manual texts, Oct 15-25 09-21 JST: every post must be confirmed before a save request exists', async () => {
  const { batch, drafts } = tenRandom();
  const none = await buildSaveRequest({ batch, drafts, confirmations: {}, aiOptIn: OPT_OUT, sha256 });
  assert.equal(none.ok, false);
  assert.equal(none.issues.length, 10);
  const nine = await confirmAll(drafts.slice(0, 9));
  const partial = await buildSaveRequest({ batch, drafts, confirmations: nine, aiOptIn: OPT_OUT, sha256 });
  assert.equal(partial.ok, false, 'no partial batch');
  assert.deepEqual(partial.issues.map((i) => i.draftId), [drafts[9].id]);
  const all = await buildSaveRequest({ batch, drafts, confirmations: await confirmAll(drafts), aiOptIn: OPT_OUT, sha256 });
  assert.equal(all.ok, true);
  const { request } = all;
  assert.equal(request.items.length, 10);
  assert.equal(request.socialAccountId, 'x_a');
  assert.equal(request.mode, 'manual_random_batch');
  assert.deepEqual(request.band, { date_from: '2026-10-15', date_to: '2026-10-25', window_start: '09:00', window_end: '21:00' });
  assert.deepEqual(request.items.map((i) => i.body), TEN, 'text exactly as shown, in order');
  for (const item of request.items) assert.equal(item.consent.content_sha256, await sha256(item.body));
});

test('changing the time or the text invalidates that post\'s confirmation (re-roll included)', async () => {
  const planned = tenRandom();
  const confirmations = await confirmAll(planned.drafts);
  // Edit one text.
  const edited = editDraftText(planned.drafts[0], '直した本文');
  assert.equal(await confirmationHolds(edited, confirmations[edited.id], sha256), false);
  // Re-roll moves every time: every confirmation is void, and nothing can be saved until re-confirmed.
  const rerolled = rerollBatch(planned.batch, { owner: OWNER, now: NOW }, planned.drafts);
  assert.equal(rerolled.ok, true);
  const stale = await buildSaveRequest({ batch: rerolled.batch, drafts: rerolled.drafts, confirmations, aiOptIn: OPT_OUT, sha256 });
  assert.equal(stale.ok, false);
  assert.equal(stale.issues.length, 10);
  const fresh = await buildSaveRequest({ batch: rerolled.batch, drafts: rerolled.drafts, confirmations: await confirmAll(rerolled.drafts), aiOptIn: OPT_OUT, sha256 });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.request.revision, rerolled.batch.revision + 1);
});

test('edits, reorder and cancellation from the preview are what gets saved; cancelled posts are never sent', async () => {
  const planned = tenRandom();
  let drafts = planned.drafts;
  drafts = drafts.map((d, i) => (i === 1 ? editDraftText(d, '二番目を直した') : d));
  drafts = moveDraftText(drafts, drafts[1].id, 1);
  drafts = drafts.map((d, i) => (i === 0 ? cancelDraft(d) : d));
  const result = await buildSaveRequest({ batch: planned.batch, drafts, confirmations: await confirmAll(drafts), aiOptIn: OPT_OUT, sha256 });
  assert.equal(result.ok, true);
  assert.equal(result.request.items.length, 9);
  assert.ok(!result.request.items.some((i) => i.draft_id === drafts[0].id), 'cancelled never sent');
  assert.equal(result.request.items[0].body, TEN[2]);
  assert.equal(result.request.items[1].body, '二番目を直した');
});

test('exact and interval batches keep their user-chosen times as confirmed', async () => {
  const exact = planBatch({ mode: 'manual_exact', posts: [{ text: '朝', date: '2026-10-15', time: '08:30' }, { text: '夜', date: '2026-10-15', time: '22:15' }] },
    { owner: OWNER, now: NOW, batchId: 'ex1' });
  const r1 = await buildSaveRequest({ batch: exact.batch, drafts: exact.drafts, confirmations: await confirmAll(exact.drafts), aiOptIn: OPT_OUT, sha256 });
  assert.deepEqual(r1.request.items.map((i) => i.scheduled_at), exact.drafts.map((d) => d.scheduledAt));
  assert.equal(r1.request.band, null);
  const interval = planBatch({ mode: 'manual_interval', texts: ['a', 'b'], startDate: '2026-10-15', startTime: '12:00', every: { unit: 'days', value: 2 } },
    { owner: OWNER, now: NOW, batchId: 'iv1' });
  const r2 = await buildSaveRequest({ batch: interval.batch, drafts: interval.drafts, confirmations: await confirmAll(interval.drafts), aiOptIn: OPT_OUT, sha256 });
  assert.equal(r2.ok, true);
  assert.equal(r2.request.mode, 'manual_interval');
  assert.ok(r1.request.items.every((i) => !('slot' in i)), 'exact items carry no slot');
});

test('interval: the cadence and each post\'s slot come from the SAME batch request; the server formula gives every instant', async () => {
  const cases = [
    { texts: ['a', 'b', 'c'], startDate: '2026-10-31', startTime: '23:30', every: { unit: 'days', value: 1 }, stepH: 24 },
    { texts: ['a', 'b', 'c'], startDate: '2026-10-15', startTime: '12:00', every: { unit: 'days', value: 3 }, stepH: 72 },
    { texts: ['a', 'b', 'c'], startDate: '2026-10-31', startTime: '22:00', every: { unit: 'hours', value: 2 }, stepH: 2 },
  ];
  for (const c of cases) {
    const planned = planBatch({ mode: 'manual_interval', texts: c.texts, startDate: c.startDate, startTime: c.startTime, every: c.every }, { owner: OWNER, now: NOW, batchId: `iv-${c.stepH}` });
    assert.equal(planned.ok, true);
    const result = await buildSaveRequest({ batch: planned.batch, drafts: planned.drafts, confirmations: await confirmAll(planned.drafts), aiOptIn: OPT_OUT, sha256 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.request.band, {
      time_zone: 'Asia/Tokyo', start_date: c.startDate, start_time: c.startTime, every_unit: c.every.unit, every_value: c.every.value, count: 3,
    });
    assert.deepEqual(result.request.items.map((i) => i.slot), [0, 1, 2]);
    // The SQL candidate's assert_interval: (start_date + start_time) at time zone 'Asia/Tokyo' + slot * every (absolute hours).
    const start = Date.parse(`${c.startDate}T${c.startTime}:00+09:00`);
    for (const item of result.request.items) assert.equal(Date.parse(item.scheduled_at), start + item.slot * c.stepH * 3600 * 1000);
  }
});

test('interval: a cancelled post leaves its slot empty; a moved time or a changed cadence is refused before any request', async () => {
  const planned = planBatch({ mode: 'manual_interval', texts: ['a', 'b', 'c'], startDate: '2026-10-15', startTime: '09:00', every: { unit: 'hours', value: 3 } },
    { owner: OWNER, now: NOW, batchId: 'iv-x' });
  const withCancel = planned.drafts.map((d, i) => (i === 1 ? cancelDraft(d) : d));
  const skipped = await buildSaveRequest({ batch: planned.batch, drafts: withCancel, confirmations: await confirmAll(withCancel), aiOptIn: OPT_OUT, sha256 });
  assert.equal(skipped.ok, true);
  assert.deepEqual(skipped.request.items.map((i) => i.slot), [0, 2]);
  assert.equal(skipped.request.band.count, 3, 'count is the confirmed series length, not the number sent');
  // A time moved off the cadence (re-confirmed, so only the cadence check can refuse it).
  const moved = planned.drafts.map((d, i) => (i === 2 ? { ...d, scheduledAt: new Date(Date.parse(d.scheduledAt) + 30 * 60 * 1000).toISOString() } : d));
  const off = await buildSaveRequest({ batch: planned.batch, drafts: moved, confirmations: await confirmAll(moved), aiOptIn: OPT_OUT, sha256 });
  assert.deepEqual(off.issues?.map((i) => i.code), ['INTERVAL_CADENCE_MISMATCH']);
  // The cadence is read from the batch request, never inferred from the drafts' times.
  const otherCadence = { ...planned.batch, request: { ...planned.batch.request, every: { unit: 'hours', value: 2 } } };
  const changed = await buildSaveRequest({ batch: otherCadence, drafts: planned.drafts, confirmations: await confirmAll(planned.drafts), aiOptIn: OPT_OUT, sha256 });
  assert.deepEqual(changed.issues?.map((i) => i.code), ['INTERVAL_CADENCE_MISMATCH']);
  const otherStart = { ...planned.batch, request: { ...planned.batch.request, startTime: '09:30' } };
  const shifted = await buildSaveRequest({ batch: otherStart, drafts: planned.drafts, confirmations: await confirmAll(planned.drafts), aiOptIn: OPT_OUT, sha256 });
  assert.deepEqual(shifted.issues?.map((i) => i.code), ['INTERVAL_CADENCE_MISMATCH']);
  // A batch whose mode does not match its request is refused (no flat list labelled as an interval).
  const relabelled = { ...tenRandom().batch, mode: 'manual_interval' };
  const flat = await buildSaveRequest({ batch: relabelled, drafts: tenRandom().drafts, confirmations: await confirmAll(tenRandom().drafts), aiOptIn: OPT_OUT, sha256 });
  assert.deepEqual(flat.issues?.map((i) => i.code), ['BATCH_INCONSISTENT']);
  // Random batches are unaffected: no slot on any item.
  const random = await buildSaveRequest({ batch: tenRandom().batch, drafts: tenRandom().drafts, confirmations: await confirmAll(tenRandom().drafts), aiOptIn: OPT_OUT, sha256 });
  assert.ok(random.ok && random.request.items.every((i) => !('slot' in i)));
});

test('selected-brand isolation: a confirmation for one account never authorises another', async () => {
  const planned = tenRandom();
  const foreign = Object.fromEntries(Object.entries(await confirmAll(planned.drafts)).map(([id, c]) => [id, { ...c, socialAccountId: 'x_b' }]));
  const result = await buildSaveRequest({ batch: planned.batch, drafts: planned.drafts, confirmations: foreign, aiOptIn: OPT_OUT, sha256 });
  assert.equal(result.ok, false);
  const mixed = planned.drafts.map((d, i) => (i === 0 ? { ...d, accountId: 'x_b' } : d));
  const mixedResult = await buildSaveRequest({ batch: planned.batch, drafts: mixed, confirmations: await confirmAll(mixed), aiOptIn: OPT_OUT, sha256 });
  assert.deepEqual(mixedResult.issues.map((i) => i.code), ['OWNER_MISMATCH']);
});

test('AI slots: no per-post text; saved only with the brand\'s own saved opt-in, never from defaults or consultation', async () => {
  const ai = planBatch({ mode: 'ai_flexible', frequencyTargetPerWeek: 4, publishWindow: { start: '18:00', end: '22:00' }, dateFrom: '2026-10-15', dateTo: '2026-10-28', approvalMode: 'auto_post_preference' },
    { owner: OWNER, now: NOW, batchId: 'ai1' });
  for (const optIn of [{ source: 'default', approvalMode: 'auto_post_preference' }, { source: 'saved', approvalMode: 'manual_review' }]) {
    const refused = await buildSaveRequest({ batch: ai.batch, drafts: ai.drafts, confirmations: {}, aiOptIn: optIn, sha256 });
    assert.deepEqual(refused.issues.map((i) => i.code), ['AI_NOT_OPTED_IN']);
  }
  const ok = await buildSaveRequest({ batch: ai.batch, drafts: ai.drafts, confirmations: {}, aiOptIn: { source: 'saved', approvalMode: 'auto_post_preference' }, sha256 });
  assert.equal(ok.ok, true);
  assert.ok(ok.request.items.every((i) => i.body === undefined && i.consent === undefined));
  assert.deepEqual(ok.request.band, { date_from: '2026-10-15', date_to: '2026-10-28', window_start: '18:00', window_end: '22:00' });
});

test('予約済み only after a read-back that matches every item; anything else is an explicit failure', async () => {
  const planned = tenRandom();
  const { request } = await buildSaveRequest({ batch: planned.batch, drafts: planned.drafts, confirmations: await confirmAll(planned.drafts), aiOptIn: OPT_OUT, sha256 });
  const rows = request.items.map((item, i) => ({ reservationId: `r${i}`, draftId: item.draft_id, scheduledAt: item.scheduled_at, status: 'planned', revision: 1, consentState: 'confirmed' }));
  const saved = verifySavedByReadBack(request, rows);
  assert.equal(saved.kind, 'saved');
  assert.equal(saved.reservations.length, 10);
  assert.deepEqual(verifySavedByReadBack(request, rows.slice(1)), { kind: 'failed', code: 'READ_BACK_MISSING' });
  assert.deepEqual(verifySavedByReadBack(request, rows.map((r, i) => (i === 3 ? { ...r, status: 'cancelled' } : r))), { kind: 'failed', code: 'READ_BACK_NOT_PLANNED' });
  assert.deepEqual(verifySavedByReadBack(request, rows.map((r, i) => (i === 3 ? { ...r, scheduledAt: '2030-01-01T00:00:00.000Z' } : r))), { kind: 'failed', code: 'READ_BACK_TIME_MISMATCH' });
  assert.deepEqual(verifySavedByReadBack(request, rows.map((r, i) => (i === 3 ? { ...r, consentState: 'needs_reconfirm' } : r))), { kind: 'failed', code: 'READ_BACK_CONSENT_MISMATCH' });
  assert.equal(serverReservationLabel(rows[0]), '予約済み');
  assert.equal(serverReservationLabel({ ...rows[0], consentState: 'needs_reconfirm' }), '再確認が必要');
  assert.equal(serverReservationLabel({ ...rows[0], status: 'uncertain' }), '結果を確認中');
});

test('release gate OFF: the store is the disabled store and never reaches the network', async () => {
  assert.equal(POSTONA_RESERVATION_PERSISTENCE_ENABLED, false);
  const store = createReservationStore();
  assert.equal(store, DISABLED_RESERVATION_STORE);
  assert.equal(store.enabled, false);
  assert.equal(createReservationStore(true), DISABLED_RESERVATION_STORE, 'flipping the flag alone does not enable a remote store');
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => { fetched += 1; return Promise.reject(new Error('no network')); };
  try {
    assert.deepEqual(await store.save({}), { kind: 'not_available' });
    assert.deepEqual(await store.list('x_a'), { ok: false, code: 'NOT_AVAILABLE' });
    assert.deepEqual(await store.cancel('r', 1), { ok: false, code: 'NOT_AVAILABLE' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetched, 0);
});

test('source: the client store has no Supabase client, fetch or storage; the gate is a literal false', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/features/schedule/reservation-store.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
  assert.match(code, /export const POSTONA_RESERVATION_PERSISTENCE_ENABLED = false as const;/u);
  assert.doesNotMatch(code, /supabase|fetch\(|\.rpc\(|AsyncStorage|localStorage|SecureStore/iu);
});

test('the schedule screen shows an honest disabled save and never calls the store', async () => {
  const { readFile } = await import('node:fs/promises');
  const screen = await readFile(new URL('../src/app/(tabs)/schedule.tsx', import.meta.url), 'utf8');
  assert.match(screen, /createReservationStore\(POSTONA_RESERVATION_PERSISTENCE_ENABLED, live\)/u, 'the gate constant decides');
  assert.match(screen, /label="予約として保存（準備中）" onPress=\{\(\) => \{\}\} disabled/u);
  // Every store call sits behind an explicit `reservationStore.enabled` guard in the same function (the
  // disabled store answers enabled === false); the wiring tests also prove zero calls with the gate OFF.
  const calls = [...screen.matchAll(/reservationStore\.(save|list|get|reschedule|reconfirm|cancel)\(/gu)];
  assert.ok(calls.length > 0);
  for (const call of calls) {
    const before = screen.slice(0, call.index);
    const fnStart = Math.max(before.lastIndexOf('function '), before.lastIndexOf('useEffect('));
    assert.match(screen.slice(fnStart, call.index), /if \(!reservationStore\.enabled[^)]*\) return;/u, `guarded: ${call[0]}`);
  }
  assert.doesNotMatch(screen, /予約しました|予約済み/u, 'the screen never claims a reservation exists');
});
