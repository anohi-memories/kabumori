// G3 reservation confirmation UI (offline): per-post confirmation state, fixed-time edits and the preview card.
// Everything here is local: nothing is saved, reserved or posted, and the release gate stays OFF.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as planner from '../src/domain/schedule-planner.ts';
import { buildSaveRequest, confirmationHolds } from '../src/domain/reservation-flow.ts';
import * as state from '../src/features/schedule/confirmation-state.ts';
import { jstFieldsOf, retimeFixedDraft } from '../src/features/schedule/time-edit.ts';
import * as labels from '../src/features/schedule/schedule-labels.ts';

const { planBatch, rerollBatch, editDraftText, moveDraftText, cancelDraft, resolveConflicts } = planner;
const sha256 = async (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const NOW = new Date('2026-10-12T10:00:00+09:00');
const OWNER_A = { accountId: 'x_a', brandId: 'brand_a', platform: 'x' };
const OWNER_B = { accountId: 'x_b', brandId: 'brand_b', platform: 'x' };
const OPT_OUT = { source: 'saved', approvalMode: 'manual_review' };
const TEXTS = (n, prefix = '本文') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

const exact = (owner = OWNER_A, batchId = 'ex1') => planBatch({
  mode: 'manual_exact',
  posts: [{ text: '朝の投稿', date: '2026-10-15', time: '08:30' }, { text: '昼の投稿', date: '2026-10-15', time: '12:00' }, { text: '夜の投稿', date: '2026-10-16', time: '21:15' }],
}, { owner, now: NOW, batchId });
const random10 = (owner = OWNER_A, batchId = 'rb1') => planBatch({
  mode: 'manual_random_batch', texts: TEXTS(10), dateFrom: '2026-10-15', dateTo: '2026-10-25', window: { start: '09:00', end: '21:00' },
}, { owner, now: NOW, batchId });
const interval = (every, batchId) => planBatch({
  mode: 'manual_interval', texts: TEXTS(3, '間隔'), startDate: '2026-10-15', startTime: '09:00', every,
}, { owner: OWNER_A, now: NOW, batchId });

async function confirmAll(drafts, from = state.EMPTY_CONFIRMATIONS) {
  let map = from;
  for (const draft of drafts) map = state.withConfirmation(map, await state.confirmDraft(draft, sha256));
  return map;
}
const statuses = (drafts, map) => drafts.map((draft) => state.confirmationStatus(draft, map));

test('fixed times: each post is confirmed on its own and progress follows; a save request exists only when all are confirmed', async () => {
  const { batch, drafts } = exact();
  let map = state.EMPTY_CONFIRMATIONS;
  assert.deepEqual(state.confirmationProgress(drafts, map), { manualTotal: 3, confirmed: 0, invalidated: 0, unconfirmed: 3, aiSlots: 0, complete: false });
  map = state.withConfirmation(map, await state.confirmDraft(drafts[0], sha256));
  assert.deepEqual(statuses(drafts, map), ['confirmed', 'unconfirmed', 'unconfirmed']);
  assert.equal(state.confirmationProgress(drafts, map).confirmed, 1);
  const partial = await buildSaveRequest({ batch, drafts, confirmations: Object.fromEntries(Object.values(map).map((c) => [c.confirmation.draftId, c.confirmation])), aiOptIn: OPT_OUT, sha256 });
  assert.equal(partial.ok, false, 'no partial batch');
  map = await confirmAll(drafts);
  assert.equal(state.confirmationProgress(drafts, map).complete, true);
  const all = await buildSaveRequest({ batch, drafts, confirmations: Object.fromEntries(Object.values(map).map((c) => [c.confirmation.draftId, c.confirmation])), aiOptIn: OPT_OUT, sha256 });
  assert.equal(all.ok, true);
  assert.deepEqual(all.request.items.map((i) => i.scheduled_at), drafts.map((d) => d.scheduledAt));
});

test('10 random posts: confirmable one by one; a re-roll invalidates every confirmation', async () => {
  const planned = random10();
  const map = await confirmAll(planned.drafts);
  assert.equal(state.confirmationProgress(planned.drafts, map).complete, true);
  const rerolled = rerollBatch(planned.batch, { owner: OWNER_A, now: NOW }, planned.drafts);
  assert.equal(rerolled.ok, true);
  const moved = rerolled.drafts.filter((d, i) => d.scheduledAt !== planned.drafts[i].scheduledAt);
  assert.ok(moved.length > 0, 'a re-roll moves times');
  for (const draft of moved) assert.equal(state.confirmationStatus(draft, map), 'invalidated');
  const progress = state.confirmationProgress(rerolled.drafts, map);
  assert.equal(progress.complete, false);
  assert.equal(progress.confirmed + progress.invalidated, 10);
  assert.equal(progress.invalidated, moved.length);
});

test('daily and N-day interval posts: confirmed per post, and the save request carries the same cadence', async () => {
  for (const [every, label] of [[{ unit: 'days', value: 1 }, 'daily'], [{ unit: 'days', value: 3 }, 'every 3 days']]) {
    const { batch, drafts } = interval(every, `iv-${label}`);
    const map = await confirmAll(drafts);
    assert.equal(state.confirmationProgress(drafts, map).complete, true, label);
    const result = await buildSaveRequest({ batch, drafts, confirmations: Object.fromEntries(Object.values(map).map((c) => [c.confirmation.draftId, c.confirmation])), aiOptIn: OPT_OUT, sha256 });
    assert.equal(result.ok, true, label);
    assert.deepEqual(result.request.band, { time_zone: 'Asia/Tokyo', start_date: '2026-10-15', start_time: '09:00', every_unit: 'days', every_value: every.value, count: 3 });
  }
});

test('editing, reordering or moving a time invalidates exactly the changed posts, in agreement with the save flow', async () => {
  const { drafts } = exact();
  const map = await confirmAll(drafts);
  // Text edit of one post.
  const edited = drafts.map((d, i) => (i === 1 ? editDraftText(d, '直した本文') : d));
  assert.deepEqual(statuses(edited, map), ['confirmed', 'invalidated', 'confirmed']);
  // Reorder swaps two texts, so both change.
  const reordered = moveDraftText(drafts, drafts[0].id, 1);
  assert.deepEqual(statuses(reordered, map), ['invalidated', 'invalidated', 'confirmed']);
  // A time change.
  const retimed = retimeFixedDraft(drafts[2], { date: '2026-10-17', time: '07:00' }, NOW);
  assert.ok(!('code' in retimed));
  assert.equal(state.confirmationStatus(retimed, map), 'invalidated');
  // The synchronous check agrees with the domain's own confirmationHolds in every case above.
  for (const [draft, original] of [[edited[1], drafts[1]], [reordered[0], drafts[0]], [retimed, drafts[2]], [drafts[0], drafts[0]]]) {
    const confirmed = map[original.id];
    assert.equal(state.confirmationIsCurrent(draft, confirmed), await confirmationHolds(draft, confirmed.confirmation, sha256), draft.id);
  }
  // A different account never inherits a confirmation.
  const otherAccount = { ...drafts[0], accountId: 'x_b' };
  assert.equal(state.confirmationStatus(otherAccount, map), 'invalidated');
  assert.equal(await confirmationHolds(otherAccount, map[drafts[0].id].confirmation, sha256), false);
});

test('a cancelled post is terminal: it is never counted, never confirmable and never revived by an old confirmation', async () => {
  const { drafts } = exact();
  const map = await confirmAll(drafts);
  const cancelled = drafts.map((d, i) => (i === 0 ? cancelDraft(d) : d));
  assert.equal(state.confirmationStatus(cancelled[0], map), 'not_applicable');
  assert.equal(state.confirmationIsCurrent(cancelled[0], map[cancelled[0].id]), false);
  assert.equal(await state.confirmDraft(cancelled[0], sha256), null);
  const progress = state.confirmationProgress(cancelled, map);
  assert.deepEqual([progress.manualTotal, progress.confirmed, progress.complete], [2, 2, true]);
  const dropped = state.withoutConfirmations(map, [cancelled[0].id]);
  assert.ok(!(cancelled[0].id in dropped));
  assert.ok(cancelled[1].id in dropped);
  assert.equal(state.withoutConfirmations(map, ['nope']), map, 'nothing to drop returns the same map');
});

test('AI slots have no per-post confirmation and are counted separately', async () => {
  const ai = planBatch({ mode: 'ai_flexible', frequencyTargetPerWeek: 4, publishWindow: { start: '18:00', end: '22:00' }, dateFrom: '2026-10-15', dateTo: '2026-10-28', approvalMode: 'auto_post_preference' },
    { owner: OWNER_A, now: NOW, batchId: 'ai1' });
  assert.equal(ai.ok, true);
  assert.equal(await state.confirmDraft(ai.drafts[0], sha256), null);
  assert.equal(state.confirmationStatus(ai.drafts[0], state.EMPTY_CONFIRMATIONS), 'not_applicable');
  const progress = state.confirmationProgress(ai.drafts, state.EMPTY_CONFIRMATIONS);
  assert.deepEqual([progress.manualTotal, progress.aiSlots, progress.complete], [0, ai.drafts.length, false]);
});

test('accounts never mix: progress is per account list, and a confirmation is bound to its own account', async () => {
  const a = exact(OWNER_A, 'a-batch');
  const b = exact(OWNER_B, 'b-batch');
  const map = await confirmAll(a.drafts);
  assert.equal(state.confirmationProgress(a.drafts, map).complete, true);
  assert.deepEqual(state.confirmationProgress(b.drafts, map), { manualTotal: 3, confirmed: 0, invalidated: 0, unconfirmed: 3, aiSlots: 0, complete: false });
  const mixedMap = await confirmAll(b.drafts, map);
  assert.equal(state.confirmationProgress(a.drafts, mixedMap).confirmed, 3);
  assert.equal(state.confirmationProgress(b.drafts, mixedMap).confirmed, 3);
  for (const draft of a.drafts) assert.equal(mixedMap[draft.id].confirmation.socialAccountId, 'x_a');
  for (const draft of b.drafts) assert.equal(mixedMap[draft.id].confirmation.socialAccountId, 'x_b');
});

test('a conflict move invalidates the moved post (resolve is an explicit action, never confirmed silently)', async () => {
  // Two random posts that collide once an exact post occupies the slot.
  const random = planBatch({ mode: 'manual_random_batch', texts: ['a', 'b'], dateFrom: '2026-10-15', dateTo: '2026-10-15', window: { start: '09:00', end: '12:00' } },
    { owner: OWNER_A, now: NOW, batchId: 'rc1' });
  assert.equal(random.ok, true);
  const map = await confirmAll(random.drafts);
  const collided = random.drafts.map((d, i) => (i === 1 ? { ...d, scheduledAt: random.drafts[0].scheduledAt } : d));
  const result = resolveConflicts({ drafts: collided, batches: [random.batch], serverPosts: [], now: NOW });
  assert.ok(result.moved.length >= 1);
  for (const id of result.moved) {
    const draft = result.drafts.find((d) => d.id === id);
    assert.notEqual(state.confirmationStatus(draft, map), 'confirmed');
  }
});

test('retiming: only a fixed-time post can be moved by hand, never a cancelled, random, interval or AI post', async () => {
  const fixed = exact().drafts[0];
  const moved = retimeFixedDraft(fixed, { date: '2026-10-20', time: '06:05' }, NOW);
  assert.equal(moved.scheduledAt, '2026-10-19T21:05:00.000Z');
  assert.equal(moved.text, fixed.text);
  assert.equal(moved.accountId, fixed.accountId);
  assert.equal(moved.fixed, true);
  assert.equal(moved.persistence, 'local_only');
  assert.equal(moved.publishable, false);
  // The edit fields round-trip the stored instant.
  const fields = jstFieldsOf(fixed.scheduledAt);
  assert.deepEqual(fields, { date: '2026-10-15', time: '08:30' });
  assert.equal(retimeFixedDraft(fixed, fields, NOW).scheduledAt, fixed.scheduledAt);
  const refused = (draft, input, now = NOW) => retimeFixedDraft(draft, input, now).code;
  assert.equal(refused(cancelDraft(fixed), fields), 'DRAFT_CANCELLED');
  assert.equal(refused(random10().drafts[0], fields), 'RETIME_NOT_ALLOWED');
  assert.equal(refused(interval({ unit: 'days', value: 1 }, 'iv-r').drafts[0], fields), 'RETIME_NOT_ALLOWED');
  const ai = planBatch({ mode: 'ai_flexible', frequencyTargetPerWeek: 4, publishWindow: { start: '18:00', end: '22:00' }, dateFrom: '2026-10-15', dateTo: '2026-10-28', approvalMode: 'manual_review' },
    { owner: OWNER_A, now: NOW, batchId: 'ai-r' });
  assert.equal(refused(ai.drafts[0], fields), 'RETIME_NOT_ALLOWED');
  assert.equal(refused(fixed, { date: '2026-10-12', time: '10:03' }), 'DATETIME_IN_PAST', 'less than 5 minutes ahead');
  assert.equal(refused(fixed, { date: '2026-10-11', time: '10:00' }), 'DATETIME_IN_PAST');
  assert.equal(refused(fixed, { date: '2027-03-01', time: '10:00' }), 'HORIZON_TOO_LONG');
  for (const bad of [{ date: '2026-02-30', time: '10:00' }, { date: '2026-10-20', time: '25:00' }, { date: '', time: '' }, { date: '10/20', time: '9:00' }]) {
    assert.equal(refused(fixed, bad), 'DATETIME_INVALID', JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------------------------------
// The preview card, rendered from its real source with stubbed React Native
// ---------------------------------------------------------------------------------------------------

async function loadCard() {
  const source = await readFile(new URL('../src/features/schedule/preview-card.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const stubs = {
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }),
      jsxs: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }),
    },
    'react-native': { Text: 'Text', TextInput: 'TextInput', View: 'View' },
    '@/constants/theme': { colors: { border: 'b', ink: 'i', danger: 'd' } },
    '@/components/ui': { Card: 'Card', Pill: 'Pill', styles: { muted: {} } },
    '@/domain/schedule-planner': planner,
    '@/features/schedule/schedule-labels': labels,
    '@/features/schedule/schedule-composer': { SmallButton: 'SmallButton' },
  };
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: 'preview-card.tsx' });
  return module.exports.PreviewCard;
}

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node === null || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
};
const textsOf = (tree) => {
  const out = [];
  const collect = (node) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === 'object') collect(node.props?.children);
  };
  collect(tree);
  return out.join(' | ');
};
const buttonLabels = (tree) => {
  const out = [];
  walk(tree, (n) => { if (n.type === 'SmallButton') out.push(n.props.label); });
  return out;
};
const buttonByLabel = (tree, label) => {
  let found = null;
  walk(tree, (n) => { if (n.type === 'SmallButton' && n.props.label === label) found = n.props; });
  return found;
};
const noop = () => {};
const cardProps = (overrides = {}) => ({
  draft: exact().drafts[0], account: { displayName: 'かぶモリ公式', handle: '@kabumori' }, conflict: false, confirmation: 'unconfirmed',
  editing: null, retiming: null, onEdit: noop, onEditChange: noop, onEditApply: noop, onEditCancel: noop,
  onRetime: noop, onRetimeChange: noop, onRetimeApply: noop, onRetimeCancel: noop, onMove: noop, onCancel: noop, onConfirm: noop, onUnconfirm: noop,
  ...overrides,
});

test('card: shows text, JST time, X account and the preview label; an unconfirmed post offers the confirmation', async () => {
  const PreviewCard = await loadCard();
  let confirmed = 0;
  const tree = PreviewCard(cardProps({ onConfirm: () => { confirmed += 1; } }));
  const text = textsOf(tree);
  assert.match(text, /朝の投稿/u);
  assert.match(text, /10\/15\(木\) 08:30/u);
  assert.match(text, /投稿先: かぶモリ公式（@kabumori）・日本時間/u);
  assert.match(text, /プレビュー／未予約・投稿されません/u);
  assert.match(text, /未確認/u);
  const button = buttonByLabel(tree, '本文・日時・投稿先を確認');
  assert.equal(button.disabled, false);
  button.onPress();
  assert.equal(confirmed, 1);
  assert.doesNotMatch(text, /予約済み|予約しました|投稿しました/u);
});

test('card: confirmed shows 確認済み and can be un-confirmed; invalidated says what changed and asks again', async () => {
  const PreviewCard = await loadCard();
  let undone = 0;
  const done = PreviewCard(cardProps({ confirmation: 'confirmed', onUnconfirm: () => { undone += 1; } }));
  assert.match(textsOf(done), /確認済み（本文・日時・投稿先）/u);
  assert.deepEqual(buttonLabels(done).filter((l) => /確認/u.test(l)), ['確認を取り消す']);
  buttonByLabel(done, '確認を取り消す').onPress();
  assert.equal(undone, 1);
  const stale = PreviewCard(cardProps({ confirmation: 'invalidated' }));
  assert.match(textsOf(stale), /本文・日時・投稿先が変わったため、確認が無効になりました/u);
  assert.equal(buttonByLabel(stale, '本文・日時・投稿先を確認').disabled, false);
  assert.doesNotMatch(textsOf(stale), /確認済み/u);
});

test('card: a conflicting post or an unknown account cannot be confirmed; editing disables it too', async () => {
  const PreviewCard = await loadCard();
  const conflict = PreviewCard(cardProps({ conflict: true }));
  assert.equal(buttonByLabel(conflict, '本文・日時・投稿先を確認').disabled, true);
  assert.match(textsOf(conflict), /近い予定があるため、確認できません/u);
  const noAccount = PreviewCard(cardProps({ account: null }));
  assert.equal(buttonByLabel(noAccount, '本文・日時・投稿先を確認').disabled, true);
  assert.match(textsOf(noAccount), /投稿先: 確認できません/u);
  const editing = PreviewCard(cardProps({ editing: '直し中' }));
  assert.equal(buttonByLabel(editing, '本文・日時・投稿先を確認').disabled, true);
  assert.equal(buttonByLabel(editing, '反映') !== null, true);
  const retiming = PreviewCard(cardProps({ retiming: { date: '2026-10-15', time: '08:30' } }));
  assert.equal(buttonByLabel(retiming, '本文・日時・投稿先を確認').disabled, true);
  assert.ok(buttonByLabel(retiming, '日時を反映'));
});

test('card: only fixed-time posts offer 日時を変更; random and interval posts explain how their times change; AI slots have no confirmation', async () => {
  const PreviewCard = await loadCard();
  assert.ok(buttonLabels(PreviewCard(cardProps())).includes('日時を変更'));
  const random = PreviewCard(cardProps({ draft: random10().drafts[0] }));
  assert.ok(!buttonLabels(random).includes('日時を変更'));
  assert.match(textsOf(random), /再抽選/u);
  const iv = PreviewCard(cardProps({ draft: interval({ unit: 'days', value: 1 }, 'iv-c').drafts[0] }));
  assert.ok(!buttonLabels(iv).includes('日時を変更'));
  assert.match(textsOf(iv), /間隔のまま保たれます/u);
  const aiPlan = planBatch({ mode: 'ai_flexible', frequencyTargetPerWeek: 4, publishWindow: { start: '18:00', end: '22:00' }, dateFrom: '2026-10-15', dateTo: '2026-10-28', approvalMode: 'manual_review' },
    { owner: OWNER_A, now: NOW, batchId: 'ai-card' });
  const ai = PreviewCard(cardProps({ draft: aiPlan.drafts[0], confirmation: 'not_applicable' }));
  const aiButtons = buttonLabels(ai);
  assert.ok(!aiButtons.some((l) => /確認|編集|日時を変更/u.test(l)), `no confirmation or edit on AI slots: ${aiButtons}`);
  assert.match(textsOf(ai), /AIが投稿の直前に本文を作成します/u);
  assert.match(textsOf(ai), /自動投稿の同意なし/u);
});

test('source: the confirmation modules are local-only (no network, storage, store call or reservation claim)', async () => {
  for (const file of ['confirmation-state.ts', 'time-edit.ts', 'preview-card.tsx', 'schedule-labels.ts', 'sha256.ts']) {
    const source = await readFile(new URL(`../src/features/schedule/${file}`, import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
    assert.doesNotMatch(code, /supabase|fetch\(|\.rpc\(|AsyncStorage|localStorage|SecureStore|reservation-store|createReservationStore|XMLHttpRequest/iu, file);
    assert.doesNotMatch(code, /予約済み|予約しました|投稿しました|予約が完了/u, `${file} never claims a reservation or a post`);
  }
});
