import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUnifiedSchedule,
  cancelDraft,
  detectConflicts,
  editDraftText,
  formatJst,
  jstDateOf,
  moveDraftText,
  planBatch,
  rerollBatch,
  resolveConflicts,
  xWeightedLength,
} from '../src/domain/schedule-planner.ts';

const NOW = new Date('2026-10-11T10:00:00+09:00');
const OWNER = { accountId: 'acc_a', brandId: 'u_a', platform: 'x' };
const TEN = Array.from({ length: 10 }, (_, index) => `投稿${index + 1}`);
const ctx = (over = {}) => ({ owner: OWNER, now: NOW, batchId: 'b1', ...over });
const jst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
const minutesOfDay = (iso) => jst(iso).getUTCHours() * 60 + jst(iso).getUTCMinutes();
const plain = (value) => JSON.parse(JSON.stringify(value));

const randomRequest = (over = {}) => ({
  mode: 'manual_random_batch', texts: TEN, dateFrom: '2026-10-15', dateTo: '2026-10-25', window: { start: '09:00', end: '21:00' }, ...over,
});

test('10 texts over Oct 15-25, 09:00-21:00: every post gets one valid, distinct, spaced JST slot; text order is kept', () => {
  const result = planBatch(randomRequest(), ctx());
  assert.equal(result.ok, true);
  const { drafts } = result;
  assert.equal(drafts.length, 10);
  assert.deepEqual(drafts.map((d) => d.text), TEN);
  const times = drafts.map((d) => new Date(d.scheduledAt).getTime());
  assert.deepEqual([...times].sort((a, b) => a - b), times, 'chronological, in text order');
  assert.equal(new Set(times).size, 10, 'no duplicate slot');
  for (const draft of drafts) {
    const day = jstDateOf(new Date(draft.scheduledAt).getTime());
    assert.ok(day >= '2026-10-15' && day <= '2026-10-25', day);
    assert.ok(minutesOfDay(draft.scheduledAt) >= 9 * 60 && minutesOfDay(draft.scheduledAt) < 21 * 60);
    assert.equal(draft.publishable, false);
    assert.equal(draft.persistence, 'local_only');
    assert.equal(draft.manualPublishConsent, false);
  }
  for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] >= 60 * 60 * 1000, 'min gap');
  // Spread rather than clustered: at least 8 distinct days for 10 posts over 11 days.
  assert.ok(new Set(drafts.map((d) => jstDateOf(new Date(d.scheduledAt).getTime()))).size >= 8);
});

test('the same seed re-renders identically; only an explicit re-roll changes random slots', () => {
  const first = planBatch(randomRequest(), ctx());
  const again = planBatch(randomRequest(), ctx());
  assert.deepEqual(plain(again), plain(first));
  const rerolled = rerollBatch(first.batch, { owner: OWNER, now: NOW });
  assert.equal(rerolled.ok, true);
  assert.equal(rerolled.batch.revision, 1);
  assert.notDeepEqual(rerolled.drafts.map((d) => d.scheduledAt), first.drafts.map((d) => d.scheduledAt));
  assert.deepEqual(rerolled.drafts.map((d) => d.text), TEN, 're-roll keeps the text order');
  // The re-roll itself is deterministic too (same batch + revision -> same result).
  assert.deepEqual(plain(rerollBatch(first.batch, { owner: OWNER, now: NOW })), plain(rerolled));
});

test('content shuffle happens only when chosen, and is seeded', () => {
  const shuffledA = planBatch(randomRequest({ shuffleContent: true }), ctx());
  const shuffledB = planBatch(randomRequest({ shuffleContent: true }), ctx());
  assert.deepEqual(shuffledA.drafts.map((d) => d.text), shuffledB.drafts.map((d) => d.text));
  assert.notDeepEqual(shuffledA.drafts.map((d) => d.text), TEN);
  assert.deepEqual([...shuffledA.drafts.map((d) => d.text)].sort(), [...TEN].sort(), 'same texts, none dropped');
});

test('multiple exact posts keep exactly the chosen times; exact batches cannot be re-rolled', () => {
  const result = planBatch({ mode: 'manual_exact', posts: [
    { text: '朝の投稿', date: '2026-10-15', time: '08:30' },
    { text: '夜の投稿', date: '2026-10-15', time: '22:15' },
  ] }, ctx());
  assert.equal(result.ok, true);
  assert.deepEqual(result.drafts.map((d) => formatJst(d.scheduledAt)), ['10/15(木) 08:30', '10/15(木) 22:15']);
  assert.ok(result.drafts.every((d) => d.fixed));
  assert.equal(rerollBatch(result.batch, { owner: OWNER, now: NOW }).ok, false);
});

test('validation: empty/too-long text, past times, bad dates/windows, zones, reversed ranges and horizon', () => {
  const codes = (result) => result.issues.map((issue) => issue.code);
  assert.deepEqual(codes(planBatch({ mode: 'manual_exact', posts: [{ text: '  ', date: '2026-10-15', time: '09:00' }] }, ctx())), ['TEXT_EMPTY']);
  assert.deepEqual(codes(planBatch({ mode: 'manual_exact', posts: [{ text: 'あ'.repeat(141), date: '2026-10-15', time: '09:00' }] }, ctx())), ['TEXT_TOO_LONG']);
  assert.equal(planBatch({ mode: 'manual_exact', posts: [{ text: 'a'.repeat(280), date: '2026-10-15', time: '09:00' }] }, ctx()).ok, true, 'X-wide limit is weighted, not the 140 automated policy');
  assert.deepEqual(codes(planBatch({ mode: 'manual_exact', posts: [{ text: 'x', date: '2026-10-11', time: '10:02' }] }, ctx())), ['DATETIME_IN_PAST']);
  assert.deepEqual(codes(planBatch({ mode: 'manual_exact', posts: [{ text: 'x', date: '2026-02-30', time: '09:00' }] }, ctx())), ['DATETIME_INVALID']);
  assert.deepEqual(codes(planBatch({ mode: 'manual_exact', posts: [{ text: 'x', date: '2026-10-15', time: '24:00' }] }, ctx())), ['DATETIME_INVALID'], '24:00 is only a window end');
  assert.deepEqual(codes(planBatch(randomRequest({ window: { start: '21:00', end: '09:00' } }), ctx())), ['WINDOW_EMPTY']);
  assert.deepEqual(codes(planBatch(randomRequest({ dateFrom: '2026-10-25', dateTo: '2026-10-15' }), ctx())), ['DATE_RANGE_REVERSED']);
  assert.deepEqual(codes(planBatch(randomRequest({ dateTo: '2027-03-01' }), ctx())), ['HORIZON_TOO_LONG']);
  assert.deepEqual(codes(planBatch(randomRequest(), ctx({ timeZone: 'America/New_York' }))), ['TIME_ZONE_UNSUPPORTED']);
  assert.equal(planBatch(randomRequest({ window: { start: '09:00', end: '24:00' } }), ctx()).ok, true, 'a window may end at 24:00');
  assert.equal(xWeightedLength('あいう abc https://example.com/x'), 6 + 5 + 23, 'wide x2, ascii and spaces x1, URL 23');
});

test('an impossible window is an explicit error, never a silent drop or overrun', () => {
  const tight = planBatch(randomRequest({ dateFrom: '2026-10-15', dateTo: '2026-10-15', window: { start: '09:00', end: '10:00' } }), ctx());
  assert.equal(tight.ok, false);
  assert.ok(['SPACING_INFEASIBLE', 'NOT_ENOUGH_SLOTS'].includes(tight.issues[0].code));
  const capped = planBatch(randomRequest({ dateFrom: '2026-10-15', dateTo: '2026-10-16' }), ctx({ spacing: { minGapMinutes: 30, maxPostsPerDay: 3 } }));
  assert.equal(capped.ok, false, '10 posts cannot fit 2 days x 3 per day');
  assert.equal(capped.issues[0].code, 'SPACING_INFEASIBLE');
});

test('weekdays and excluded dates are respected', () => {
  const result = planBatch(randomRequest({ texts: TEN.slice(0, 4), weekdays: [1, 2, 3, 4, 5], excludedDates: ['2026-10-20'] }), ctx());
  assert.equal(result.ok, true);
  for (const draft of result.drafts) {
    const day = jst(draft.scheduledAt).getUTCDay();
    assert.ok(day >= 1 && day <= 5);
    assert.notEqual(jstDateOf(new Date(draft.scheduledAt).getTime()), '2026-10-20');
  }
});

test('interval mode: concrete times; a blocked slot fails with an explicit alternative instead of moving', () => {
  const ok = planBatch({ mode: 'manual_interval', texts: ['a', 'b', 'c'], startDate: '2026-10-15', startTime: '12:00', every: { unit: 'days', value: 2 } }, ctx());
  assert.deepEqual(ok.drafts.map((d) => formatJst(d.scheduledAt)), ['10/15(木) 12:00', '10/17(土) 12:00', '10/19(月) 12:00']);
  const hours = planBatch({ mode: 'manual_interval', texts: ['a', 'b'], startDate: '2026-10-15', startTime: '23:30', every: { unit: 'hours', value: 6 } }, ctx());
  assert.deepEqual(hours.drafts.map((d) => formatJst(d.scheduledAt)), ['10/15(木) 23:30', '10/16(金) 05:30'], 'crosses the day boundary');
  const blocked = planBatch({ mode: 'manual_interval', texts: ['a', 'b'], startDate: '2026-10-15', startTime: '12:00', every: { unit: 'days', value: 1 } },
    ctx({ occupied: [{ scheduledAt: '2026-10-16T03:20:00.000Z', fixed: true }] }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.issues[0].code, 'INTERVAL_SLOT_BLOCKED');
  assert.match(blocked.issues[0].message, /空いている近い時刻/u);
});

test('exact times that clash with each other or with existing posts are reported, never shifted', () => {
  const result = planBatch({ mode: 'manual_exact', posts: [
    { text: 'a', date: '2026-10-15', time: '09:00' },
    { text: 'b', date: '2026-10-15', time: '09:30' },
  ] }, ctx());
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((i) => [i.code, i.index]), [['FIXED_TIME_CONFLICT', 1]]);
});

test('AI flexible slots use frequencyTargetPerWeek and the separate publish window; consent is not implied', () => {
  const base = { mode: 'ai_flexible', frequencyTargetPerWeek: 4, publishWindow: { start: '18:00', end: '22:00' }, dateFrom: '2026-10-15', dateTo: '2026-10-28' };
  const manual = planBatch({ ...base, approvalMode: 'manual_review' }, ctx({ batchId: 'ai1' }));
  assert.equal(manual.ok, true);
  assert.equal(manual.drafts.length, 8, '4/week over 14 days');
  for (const draft of manual.drafts) {
    assert.equal(draft.origin, 'ai_generated');
    assert.equal(draft.text, '');
    assert.equal(draft.aiAutoPostConsent, 'not_granted', 'a remembered consultation is not consent');
    assert.equal(draft.publishable, false);
    assert.ok(minutesOfDay(draft.scheduledAt) >= 18 * 60 && minutesOfDay(draft.scheduledAt) < 22 * 60, 'publish window, not generationWindow');
  }
  const optedIn = planBatch({ ...base, approvalMode: 'auto_post_preference' }, ctx({ batchId: 'ai1' }));
  assert.ok(optedIn.drafts.every((d) => d.aiAutoPostConsent === 'granted_by_owner_setting' && d.publishable === false));
});

test('AI/manual collision: fixed wins, AI moves first inside its own window, nothing is dropped', () => {
  const ai = planBatch({ mode: 'ai_flexible', frequencyTargetPerWeek: 7, publishWindow: { start: '18:00', end: '22:00' }, dateFrom: '2026-10-15', dateTo: '2026-10-15', approvalMode: 'manual_review' }, ctx({ batchId: 'ai' }));
  const aiTime = ai.drafts[0].scheduledAt;
  const local = new Date(new Date(aiTime).getTime() + 9 * 3600 * 1000);
  const hhmm = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  const exact = planBatch({ mode: 'manual_exact', posts: [{ text: '固定', date: '2026-10-15', time: hhmm }] }, ctx({ batchId: 'ex' }));
  const drafts = [...ai.drafts, ...exact.drafts];
  const view = buildUnifiedSchedule({ accountId: 'acc_a', serverPosts: [], drafts });
  assert.equal(detectConflicts(view).length, 1);
  const resolved = resolveConflicts({ drafts, batches: [ai.batch, exact.batch], serverPosts: [], now: NOW });
  assert.deepEqual(resolved.issues, []);
  assert.deepEqual(resolved.moved, [ai.drafts[0].id]);
  const after = resolved.drafts;
  assert.equal(after.find((d) => d.id === exact.drafts[0].id).scheduledAt, exact.drafts[0].scheduledAt, 'fixed did not move');
  const movedAi = after.find((d) => d.id === ai.drafts[0].id);
  assert.ok(minutesOfDay(movedAi.scheduledAt) >= 18 * 60 && minutesOfDay(movedAi.scheduledAt) < 22 * 60);
  assert.equal(detectConflicts(buildUnifiedSchedule({ accountId: 'acc_a', serverPosts: [], drafts: after })).length, 0);
  assert.equal(after.length, drafts.length);
});

test('a conflict nobody may move is reported as an explicit error', () => {
  const a = planBatch({ mode: 'manual_exact', posts: [{ text: 'a', date: '2026-10-15', time: '09:00' }] }, ctx({ batchId: 'x1' }));
  const b = planBatch({ mode: 'manual_exact', posts: [{ text: 'b', date: '2026-10-15', time: '09:20' }] }, ctx({ batchId: 'x2' }));
  const resolved = resolveConflicts({ drafts: [...a.drafts, ...b.drafts], batches: [a.batch, b.batch], serverPosts: [], now: NOW });
  assert.equal(resolved.moved.length, 0);
  assert.equal(resolved.issues[0].code, 'FIXED_TIME_CONFLICT');
});

test('edit, reorder (texts swap, times stay), cancel; AI text is not editable; cancelled drafts leave the view', () => {
  const { drafts } = planBatch(randomRequest({ texts: ['一', '二', '三'] }), ctx());
  const times = drafts.map((d) => d.scheduledAt);
  const moved = moveDraftText(drafts, drafts[0].id, 1);
  assert.deepEqual(moved.map((d) => d.text), ['二', '一', '三']);
  assert.deepEqual(moved.map((d) => d.scheduledAt), times);
  const edited = editDraftText(moved[2], '  三（修正）  ');
  assert.equal(edited.text, '三（修正）');
  assert.equal(editDraftText(moved[2], '').code, 'TEXT_EMPTY');
  const cancelled = cancelDraft(moved[1]);
  assert.equal(editDraftText(cancelled, 'x').code, 'DRAFT_CANCELLED');
  const view = buildUnifiedSchedule({ accountId: 'acc_a', serverPosts: [], drafts: [moved[0], cancelled, moved[2]] });
  assert.equal(view.length, 2);
  const ai = planBatch({ mode: 'ai_flexible', frequencyTargetPerWeek: 7, publishWindow: { start: '18:00', end: '22:00' }, dateFrom: '2026-10-15', dateTo: '2026-10-15', approvalMode: 'auto_post_preference' }, ctx({ batchId: 'ai' }));
  assert.equal(editDraftText(ai.drafts[0], '勝手な本文').code, 'AI_TEXT_NOT_EDITABLE');
});

test('account isolation and filters in the unified view; server rows stay read-only server rows', () => {
  const mine = planBatch(randomRequest({ texts: ['mine'] }), ctx({ batchId: 'm' })).drafts;
  const theirs = planBatch(randomRequest({ texts: ['theirs'] }), ctx({ batchId: 't', owner: { accountId: 'acc_b', brandId: 'u_b', platform: 'x' } })).drafts;
  const ai = planBatch({ mode: 'ai_flexible', frequencyTargetPerWeek: 7, publishWindow: { start: '18:00', end: '22:00' }, dateFrom: '2026-10-15', dateTo: '2026-10-15', approvalMode: 'manual_review' }, ctx({ batchId: 'ai' })).drafts;
  const server = [{ id: 's1', accountId: 'acc_a', scheduledAt: '2026-10-14T00:00:00.000Z', origin: 'ai_generated', status: 'scheduled', text: '' },
    { id: 's2', accountId: 'acc_b', scheduledAt: '2026-10-14T00:00:00.000Z', origin: 'ai_generated', status: 'scheduled', text: '' }];
  const all = buildUnifiedSchedule({ accountId: 'acc_a', serverPosts: server, drafts: [...mine, ...theirs, ...ai] });
  assert.deepEqual(all.map((i) => i.id).sort(), ['ai:0', 'm:0', 's1']);
  assert.equal(all.find((i) => i.id === 's1').source, 'server');
  assert.deepEqual(buildUnifiedSchedule({ accountId: 'acc_a', serverPosts: server, drafts: [...mine, ...ai], filter: 'manual' }).map((i) => i.id), ['m:0']);
  assert.deepEqual(buildUnifiedSchedule({ accountId: 'acc_a', serverPosts: server, drafts: [...mine, ...ai], filter: 'ai' }).map((i) => i.id).sort(), ['ai:0', 's1']);
  assert.deepEqual(buildUnifiedSchedule({ accountId: null, serverPosts: server, drafts: mine }), []);
});

test('the planner has no persistence, network or publish capability', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/domain/schedule-planner.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import /mu, 'pure module: no imports at all');
  assert.doesNotMatch(source, /fetch\(|supabase|AsyncStorage|localStorage|insert|\.rpc\(/u);
  const result = planBatch(randomRequest(), ctx());
  assert.ok(result.drafts.every((d) => d.publishable === false && d.persistence === 'local_only' && d.state === 'previewed'));
});

test('the schedule screen and composer cannot save, schedule or publish: read-only settings access only', async () => {
  const { readFile } = await import('node:fs/promises');
  const screen = await readFile(new URL('../src/app/(tabs)/schedule.tsx', import.meta.url), 'utf8');
  const composer = await readFile(new URL('../src/features/schedule/schedule-composer.tsx', import.meta.url), 'utf8');
  for (const source of [screen, composer]) {
    assert.doesNotMatch(source, /saveConfirmed|\.upsert\(|\.insert\(|\.update\(|\.rpc\(|functions\.invoke|requestConsult|AsyncStorage|localStorage|SecureStore|fetch\(/u);
    assert.doesNotMatch(source, /予約確定|予約しました|投稿しました/u, 'no wording that pretends a plan was saved or posted');
  }
  // The only backend touch is the read of the confirmed AI-consult settings (frequency / approvalMode).
  assert.equal((screen.match(/repository\.\w+\(/gu) ?? []).join(','), 'repository.read(');
  assert.doesNotMatch(composer, /@\/data\/|@\/lib\/supabase/u, 'the composer has no data access at all');
  assert.match(screen, /プレビュー／未予約・投稿されません/u);
  assert.match(screen, /再起動したりすると消えます/u);
});
