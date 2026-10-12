// K3 R2b: the REAL schedule.tsx (transpiled) driven with stubbed React/RN, a scripted snapshot, a scripted
// active account and an in-memory settings store. Proves the wiring -- not just the pure helper -- binds the
// AI planning inputs to the SELECTED account's brand, never to the snapshot's first workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as scheduleView from '../src/domain/schedule-view.ts';
import * as planner from '../src/domain/schedule-planner.ts';
import * as dataView from '../src/domain/data-view.ts';
import * as contentSettings from '../src/domain/content-settings.ts';
import * as reservationStore from '../src/features/schedule/reservation-store.ts';
import * as confirmationState from '../src/features/schedule/confirmation-state.ts';
import * as timeEdit from '../src/features/schedule/time-edit.ts';
import * as scheduleLabels from '../src/features/schedule/schedule-labels.ts';

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node === null || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
};
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const SETTINGS = (frequencyTargetPerWeek, approvalMode) => ({ ...contentSettings.SOCIAL_MOBILE_CONTENT_DEFAULTS, frequencyTargetPerWeek, approvalMode });
const ACCOUNTS = [
  { id: 'X_A', brandId: 'A', platform: 'x', profile: { displayName: 'a', handle: '@a' }, connectionStatus: 'connected', postingState: 'active' },
  { id: 'X_B', brandId: 'B', platform: 'x', profile: { displayName: 'b', handle: '@b' }, connectionStatus: 'connected', postingState: 'active' },
  { id: 'X_A2', brandId: 'A', platform: 'x', profile: { displayName: 'a2', handle: '@a2' }, connectionStatus: 'connected', postingState: 'active' },
];

async function scheduleHarness({ status = 'ready', active = 'X_B', rows = {}, accounts = ACCOUNTS, workspaceId = 'A' } = {}) {
  const slots = []; let cursor = 0; const effects = []; const cleanups = [];
  const slot = (init) => { const i = cursor++; if (!(i in slots)) slots[i] = init(); return i; };
  const react = {
    useState: (initial) => { const i = slot(() => (typeof initial === 'function' ? initial() : initial)); return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => slots[slot(() => ({ current: initial }))],
    useMemo: (factory) => slots[slot(factory)],
    useEffect: (effect, deps) => {
      const i = cursor++;
      const changed = !(i in slots) || !deps || deps.length !== slots[i].length || deps.some((d, k) => !Object.is(d, slots[i][k]));
      if (!changed) return;
      slots[i] = deps ?? [];
      effects.push(effect);
    },
  };
  const world = { status, active, rows: { ...rows }, reads: [], pending: new Map(), hold: new Set(), workspaceId, accounts };
  class Repository {
    read(brandId) {
      world.reads.push(brandId);
      const answer = () => {
        const row = world.rows[brandId];
        if (row === 'unavailable') return { state: 'unavailable', data: contentSettings.SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null, reason: 'x' };
        if (row === 'blocked') return { state: 'blocked', data: contentSettings.SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null, reason: 'x' };
        if (!row) return { state: 'ready', data: contentSettings.SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null, updatedAt: null };
        return { state: 'ready', data: row, persona: null, updatedAt: 'v1' };
      };
      if (world.hold.has(brandId)) return new Promise((resolve) => { world.pending.set(brandId, () => resolve(answer())); });
      return Promise.resolve(answer());
    }
    async upsert() { throw new Error('the schedule screen must never write settings'); }
    async saveConfirmedIfUnchanged() { throw new Error('the schedule screen must never write settings'); }
    async saveConfirmedProposal() { throw new Error('the schedule screen must never write settings'); }
  }
  const stubs = {
    'expo-router': { useRouter: () => ({ push: () => {} }) },
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), jsxs: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }) },
    'react-native': { Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    '@/constants/theme': { colors: { primary: 'p', primarySoft: 'ps', surface: 's', border: 'b', ink: 'i', danger: 'd' } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', EmptyState: 'EmptyState', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: {}, buttonPressed: {} } },
    '@/data/mock-repository': { mockRepository: { getPlannedPosts: () => [], getAccounts: () => world.accounts } },
    '@/data/content-settings-repository': { SupabaseContentSettingsRepository: Repository },
    '@/lib/supabase': { supabase: status === 'mock_preview' ? null : {} },
    '@/domain/data-view': dataView,
    '@/domain/schedule-view': scheduleView,
    '@/domain/schedule-planner': planner,
    '@/domain/types': {},
    '@/features/schedule/schedule-composer': {
      // The composer is the consumer of `ai`: capture exactly what the screen hands it.
      ScheduleComposer: function ScheduleComposer(props) { return { type: 'ScheduleComposer', props }; },
      SmallButton: 'SmallButton',
    },
    // The real (disabled) reservation store: the screen must never be able to save from here.
    '@/features/schedule/reservation-store': reservationStore,
    // The real confirmation / time-edit / label modules; the card is captured as props, the hash is node's.
    '@/features/schedule/confirmation-state': confirmationState,
    '@/features/schedule/time-edit': timeEdit,
    '@/features/schedule/schedule-labels': scheduleLabels,
    '@/features/schedule/preview-card': { PreviewCard: function PreviewCard(props) { return { type: 'PreviewCard', props }; } },
    '@/features/schedule/sha256': { sha256Hex: async (text) => createHash('sha256').update(text, 'utf8').digest('hex') },
    '@/providers/active-account-provider': { useActiveAccount: () => ({ activeAccount: world.accounts.find((a) => a.id === world.active) ?? null, accounts: world.accounts }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status, reason: null, snapshot: world.status === 'ready' ? { workspace: world.workspaceId ? { id: world.workspaceId } : null, accounts: world.accounts, plannedPosts: [], history: [] } : null }) },
  };
  const source = await readFile(new URL('../src/app/(tabs)/schedule.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, Promise, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: 'schedule.tsx' });
  const render = () => { cursor = 0; const tree = module.exports.default({}); return tree; };
  const flush = async () => {
    for (let round = 0; round < 4; round += 1) {
      const pending = effects.splice(0);
      pending.forEach((effect) => { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup); });
      render();
      await settle();
    }
  };
  render(); await flush();
  /** Re-render after the world changed (account / workspace / status switch). */
  const update = async () => { render(); await flush(); return render(); };
  return { world, render, update, flush };
}

// The screen only mounts the composer after 「投稿を作成」. Instead of clicking through the stubbed tree, the
// tests read the AI inputs through the same pure function the screen calls, bound to what the screen read.
async function openComposer(h) {
  let already = null;
  walk(h.render(), (n) => { if (n.type === 'ScheduleComposer') already = n.props; });
  if (already) return already; // already open: the props are re-derived from the current render
  const tree = h.render();
  let create = null;
  walk(tree, (n) => { if (n.type === 'ActionButton' && n.props.label === '投稿を作成') create = n.props; });
  assert.ok(create, '投稿を作成 button exists');
  assert.equal(create.disabled, false, 'an X account is selected');
  create.onPress();
  await settle();
  let props = null;
  walk(h.render(), (n) => { if (n.type === 'ScheduleComposer') props = n.props; });
  assert.ok(props, 'composer opened');
  return props;
}

test('R2b wiring: snapshot.workspace=A but the selected account is X_B (brand B): B is read and B is shown, never A', async () => {
  const h = await scheduleHarness({
    active: 'X_B',
    rows: { A: SETTINGS(7, 'auto_post_preference'), B: SETTINGS(2, 'manual_review') },
  });
  assert.ok(!h.world.reads.includes('A'), `the first workspace must not be read for X_B; reads=${JSON.stringify(h.world.reads)}`);
  assert.ok(h.world.reads.includes('B'), 'the selected account\'s brand is read');
  const props = await openComposer(h);
  assert.equal(props.ai.frequencyTargetPerWeek, 2);
  assert.equal(props.ai.approvalMode, 'manual_review');
  assert.equal(props.ai.source, 'saved');
  assert.equal(props.context.owner.brandId, 'B');
  assert.equal(props.context.owner.accountId, 'X_B');
});

test('R2b wiring: switching the selected account A -> B -> A never shows the other brand and ignores a late answer', async () => {
  const h = await scheduleHarness({
    active: 'X_A',
    rows: { A: SETTINGS(7, 'auto_post_preference'), B: SETTINGS(2, 'manual_review') },
  });
  let props = await openComposer(h);
  assert.equal(props.ai.frequencyTargetPerWeek, 7);
  assert.equal(props.ai.approvalMode, 'auto_post_preference');
  // Switch to B while B's answer is still in flight: A's values must be gone at once.
  h.world.hold.add('B');
  h.world.active = 'X_B';
  await h.update();
  const during = h.render();
  let duringProps = null;
  walk(during, (n) => { if (n.type === 'ScheduleComposer') duringProps = n.props; });
  if (duringProps) {
    assert.equal(duringProps.ai.source, 'default');
    assert.equal(duringProps.ai.approvalMode, 'manual_review');
    assert.notEqual(duringProps.ai.frequencyTargetPerWeek, 7);
  }
  // Back to A before B answers; then B's late answer arrives and must be ignored.
  h.world.active = 'X_A';
  await h.update();
  h.world.pending.get('B')?.();
  await settle();
  await h.update();
  props = await openComposer(h);
  assert.equal(props.context.owner.brandId, 'A');
  assert.equal(props.ai.frequencyTargetPerWeek, 7, 'A is A again');
  assert.notEqual(props.ai.frequencyTargetPerWeek, 2, 'B\'s late answer is not applied to A');
});

test('R2b wiring: a failed / blocked / missing read for the selected brand shows the default and no opt-in', async () => {
  for (const bad of ['unavailable', 'blocked', undefined]) {
    const h = await scheduleHarness({ active: 'X_B', rows: { A: SETTINGS(7, 'auto_post_preference'), B: bad } });
    const props = await openComposer(h);
    assert.equal(props.ai.source, 'default', String(bad));
    assert.equal(props.ai.approvalMode, 'manual_review', String(bad));
    assert.notEqual(props.ai.frequencyTargetPerWeek, 7, String(bad));
    assert.ok(['unavailable', 'blocked', 'no_saved_settings'].includes(props.ai.status), `${bad}: ${props.ai.status}`);
  }
});

test('R2b wiring: a selected account whose brand is unknown reads nothing and is not planned with another brand\'s settings', async () => {
  const noBrand = [{ ...ACCOUNTS[1], brandId: undefined }, ACCOUNTS[0]];
  const h = await scheduleHarness({ active: 'X_B', accounts: noBrand, rows: { A: SETTINGS(7, 'auto_post_preference') } });
  assert.deepEqual(h.world.reads, [], 'no brand -> no read, and never the snapshot\'s first workspace');
  const tree = h.render();
  let create = null;
  walk(tree, (n) => { if (n.type === 'ActionButton' && n.props.label === '投稿を作成') create = n.props; });
  assert.equal(create.disabled, true, 'planning is not offered without a verified brand');
});

test('R2b wiring: mock preview shows demo defaults and never reads a production brand setting', async () => {
  const h = await scheduleHarness({ status: 'mock_preview', active: 'X_B', rows: { A: SETTINGS(7, 'auto_post_preference'), B: SETTINGS(2, 'manual_review') } });
  assert.deepEqual(h.world.reads, [], 'no production read in mock preview');
});

test('R2b wiring: two accounts of the same brand share the brand-scoped settings (one read per brand)', async () => {
  const h = await scheduleHarness({ active: 'X_A', rows: { A: SETTINGS(5, 'manual_review') } });
  let props = await openComposer(h);
  assert.equal(props.ai.frequencyTargetPerWeek, 5);
  h.world.active = 'X_A2';
  await h.update();
  props = await openComposer(h);
  assert.equal(props.context.owner.brandId, 'A');
  assert.equal(props.ai.frequencyTargetPerWeek, 5);
});

test('R2b wiring: loading / blocked data never plans from a leftover workspace', async () => {
  for (const status of ['loading', 'blocked', 'unavailable']) {
    const h = await scheduleHarness({ status, active: 'X_B', rows: { A: SETTINGS(7, 'auto_post_preference') } });
    assert.deepEqual(h.world.reads, [], status);
  }
});

// ---------------------------------------------------------------------------------------------------
// Reservation confirmation UI: the REAL screen drives the real confirmation state (nothing is saved)
// ---------------------------------------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
const dayAhead = (n) => planner.jstDateOf(Date.now() + n * DAY);
const collectText = (tree) => {
  const out = [];
  const visit = (node) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') visit(node.props?.children);
  };
  visit(tree);
  return out.join(' | ');
};
const cardsOf = (tree) => {
  const cards = [];
  walk(tree, (n) => { if (n.type === 'PreviewCard') cards.push(n.props); });
  return cards;
};
const labelled = (tree, type, label) => {
  let found = null;
  walk(tree, (n) => { if (n.type === type && n.props.label === label) found = n.props; });
  return found;
};
async function plan(h, request, batchId) {
  const props = await openComposer(h);
  const result = planner.planBatch(request, { ...props.context, batchId });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  props.onPlanned(result);
  await settle();
  return h.render();
}
const threeFixed = () => ({
  mode: 'manual_exact',
  posts: [
    { text: '朝の投稿', date: dayAhead(3), time: '08:30' },
    { text: '昼の投稿', date: dayAhead(3), time: '12:00' },
    { text: '夜の投稿', date: dayAhead(4), time: '21:15' },
  ],
});
const byText = (tree, text) => cardsOf(tree).find((card) => card.draft.text === text);

test('confirmation wiring: each post is confirmed on its own; the card names the selected account; saving stays unavailable', async () => {
  const h = await scheduleHarness({ active: 'X_B', rows: { B: SETTINGS(2, 'manual_review') } });
  let tree = await plan(h, threeFixed(), 'wire-fixed');
  let cards = cardsOf(tree);
  assert.equal(cards.length, 3);
  assert.ok(cards.every((card) => card.confirmation === 'unconfirmed'));
  assert.ok(cards.every((card) => card.account.displayName === 'b' && card.account.handle === '@b'), 'the selected X account is shown');
  assert.match(collectText(tree), /確認済み 0\/3件/u);
  assert.match(collectText(tree), /プレビュー／未予約・投稿されません/u);
  byText(tree, '朝の投稿').onConfirm();
  await settle();
  tree = h.render();
  assert.equal(byText(tree, '朝の投稿').confirmation, 'confirmed');
  assert.equal(byText(tree, '昼の投稿').confirmation, 'unconfirmed');
  assert.match(collectText(tree), /確認済み 1\/3件/u);
  assert.match(collectText(tree), /確認 1\/3/u, 'per-batch progress');
  for (const text of ['昼の投稿', '夜の投稿']) { byText(h.render(), text).onConfirm(); await settle(); }
  tree = h.render();
  assert.match(collectText(tree), /確認済み 3\/3件/u);
  assert.match(collectText(tree), /ただし、予約の保存はまだ利用できません/u);
  const save = labelled(tree, 'ActionButton', '予約として保存（準備中）');
  assert.equal(save.disabled, true, 'saving is not available');
  save.onPress();
  assert.doesNotMatch(collectText(tree), /予約済み|予約しました|投稿しました/u);
  // Un-confirming one post takes the progress back.
  byText(h.render(), '昼の投稿').onUnconfirm();
  await settle();
  assert.match(collectText(h.render()), /確認済み 2\/3件/u);
});

test('confirmation wiring: a text edit, a time change and a cancel are reflected at once and nothing is revived', async () => {
  const h = await scheduleHarness({ active: 'X_B', rows: { B: SETTINGS(2, 'manual_review') } });
  await plan(h, threeFixed(), 'wire-edit');
  for (const text of ['朝の投稿', '昼の投稿', '夜の投稿']) { byText(h.render(), text).onConfirm(); await settle(); }
  assert.match(collectText(h.render()), /確認済み 3\/3件/u);
  // Edit the text of one post: only that post is invalidated.
  byText(h.render(), '昼の投稿').onEdit();
  byText(h.render(), '昼の投稿').onEditChange('直した昼の投稿');
  h.render();
  let editing = cardsOf(h.render()).find((card) => card.editing !== null);
  editing.onEditChange('直した昼の投稿');
  editing = cardsOf(h.render()).find((card) => card.editing !== null);
  editing.onEditApply();
  await settle();
  let tree = h.render();
  assert.equal(byText(tree, '直した昼の投稿').confirmation, 'invalidated');
  assert.equal(byText(tree, '朝の投稿').confirmation, 'confirmed');
  assert.match(collectText(tree), /確認済み 2\/3件/u);
  assert.match(collectText(tree), /変更により確認が無効 1件/u);
  // Change the time of another fixed post.
  byText(tree, '夜の投稿').onRetime();
  tree = h.render();
  const retiming = cardsOf(tree).find((card) => card.retiming !== null);
  assert.deepEqual(Object.keys(retiming.retiming).sort(), ['date', 'time']);
  retiming.onRetimeChange({ date: dayAhead(6), time: '07:45' });
  tree = h.render();
  cardsOf(tree).find((card) => card.retiming !== null).onRetimeApply();
  await settle();
  tree = h.render();
  assert.equal(byText(tree, '夜の投稿').confirmation, 'invalidated');
  assert.equal(planner.formatJst(byText(tree, '夜の投稿').draft.scheduledAt).endsWith('07:45'), true);
  assert.match(collectText(tree), /日時を変更しました。この投稿の確認は無効になりました/u, 'the user is told the confirmation was voided');
  // An invalid time is refused with a message and changes nothing.
  byText(tree, '朝の投稿').onRetime();
  tree = h.render();
  cardsOf(tree).find((card) => card.retiming !== null).onRetimeChange({ time: '99:99' });
  cardsOf(h.render()).find((card) => card.retiming !== null).onRetimeApply();
  tree = h.render();
  assert.match(collectText(tree), /日時が正しくありません/u);
  assert.equal(byText(tree, '朝の投稿').confirmation, 'confirmed');
  // Cancel a confirmed post: it disappears and is no longer counted.
  cardsOf(h.render()).find((card) => card.retiming !== null)?.onRetimeCancel();
  byText(h.render(), '朝の投稿').onCancel();
  await settle();
  tree = h.render();
  assert.equal(byText(tree, '朝の投稿'), undefined);
  assert.equal(cardsOf(tree).length, 2);
  assert.match(collectText(tree), /確認済み 0\/2件/u);
});

test('confirmation wiring: a re-roll invalidates the confirmations of the posts it moved', async () => {
  const h = await scheduleHarness({ active: 'X_B', rows: { B: SETTINGS(2, 'manual_review') } });
  const tree0 = await plan(h, {
    mode: 'manual_random_batch', texts: ['ランダム1', 'ランダム2', 'ランダム3'], dateFrom: dayAhead(2), dateTo: dayAhead(12), window: { start: '09:00', end: '21:00' },
  }, 'wire-random');
  const before = new Map(cardsOf(tree0).map((card) => [card.draft.id, card.draft.scheduledAt]));
  for (const card of cardsOf(tree0)) { cardsOf(h.render()).find((c) => c.draft.id === card.draft.id).onConfirm(); await settle(); }
  assert.match(collectText(h.render()), /確認済み 3\/3件/u);
  labelled(h.render(), 'SmallButton', '再抽選').onPress();
  await settle();
  const after = cardsOf(h.render());
  const moved = after.filter((card) => card.draft.scheduledAt !== before.get(card.draft.id));
  assert.ok(moved.length > 0, 'the re-roll moved at least one post');
  for (const card of after) assert.equal(card.confirmation, moved.includes(card) ? 'invalidated' : 'confirmed', card.draft.id);
  assert.doesNotMatch(collectText(h.render()), /確認済み 3\/3件/u);
  // Random posts offer no hand edit of the time (that is what the re-roll is for).
  assert.ok(after.every((card) => card.draft.mode === 'manual_random_batch'));
});

test('confirmation wiring: switching accounts never mixes drafts, progress or confirmations', async () => {
  const h = await scheduleHarness({ active: 'X_B', rows: { A: SETTINGS(2, 'manual_review'), B: SETTINGS(2, 'manual_review') } });
  await plan(h, threeFixed(), 'wire-b');
  byText(h.render(), '朝の投稿').onConfirm();
  await settle();
  assert.match(collectText(h.render()), /確認済み 1\/3件/u);
  // Another account of ANOTHER brand: nothing of X_B is shown or counted.
  h.world.active = 'X_A';
  await h.update();
  let tree = h.render();
  assert.equal(cardsOf(tree).length, 0);
  assert.doesNotMatch(collectText(tree), /確認済み/u);
  const aTree = await plan(h, { mode: 'manual_exact', posts: [{ text: 'Aの投稿', date: dayAhead(5), time: '10:00' }, { text: 'Aの二つ目', date: dayAhead(5), time: '15:00' }] }, 'wire-a');
  assert.deepEqual(cardsOf(aTree).map((card) => card.account.handle), ['@a', '@a']);
  byText(aTree, 'Aの投稿').onConfirm();
  await settle();
  assert.match(collectText(h.render()), /確認済み 1\/2件/u);
  // Back to X_B: its own state is intact and X_A's confirmation does not count there.
  h.world.active = 'X_B';
  await h.update();
  tree = h.render();
  assert.equal(cardsOf(tree).length, 3);
  assert.ok(cardsOf(tree).every((card) => card.account.handle === '@b'));
  assert.match(collectText(tree), /確認済み 1\/3件/u);
  assert.equal(byText(tree, '朝の投稿').confirmation, 'confirmed');
  assert.equal(byText(tree, 'Aの投稿'), undefined);
});

test('confirmation wiring: an interval plan and an AI plan show the right confirmation affordances', async () => {
  const h = await scheduleHarness({ active: 'X_B', rows: { B: SETTINGS(3, 'auto_post_preference') } });
  let tree = await plan(h, { mode: 'manual_interval', texts: ['間隔1', '間隔2', '間隔3'], startDate: dayAhead(2), startTime: '09:00', every: { unit: 'days', value: 3 } }, 'wire-iv');
  assert.equal(cardsOf(tree).length, 3);
  assert.ok(cardsOf(tree).every((card) => card.draft.mode === 'manual_interval' && card.draft.fixed === false));
  assert.match(collectText(tree), /確認 0\/3/u);
  const ai = await plan(h, { mode: 'ai_flexible', frequencyTargetPerWeek: 3, publishWindow: { start: '18:00', end: '22:00' }, dateFrom: dayAhead(2), dateTo: dayAhead(16), approvalMode: 'auto_post_preference' }, 'wire-ai');
  tree = ai;
  const aiCards = cardsOf(tree).filter((card) => card.draft.origin === 'ai_generated');
  assert.ok(aiCards.length > 0);
  assert.ok(aiCards.every((card) => card.confirmation === 'not_applicable'));
  assert.match(collectText(tree), /これで覚えて」は自動投稿の同意になりません/u);
  // The AI slots do not count towards the manual confirmation progress.
  assert.match(collectText(tree), /確認済み 0\/3件/u);
  assert.equal(labelled(tree, 'ActionButton', '予約として保存（準備中）').disabled, true);
});

test('confirmation wiring: 「まとめて取り消し」 cancels every post of the batch, and only that batch', async () => {
  const h = await scheduleHarness({ active: 'X_B', rows: { B: SETTINGS(2, 'manual_review') } });
  await plan(h, threeFixed(), 'wire-bulk-1');
  await plan(h, { mode: 'manual_exact', posts: [{ text: '別のまとまり', date: dayAhead(8), time: '10:00' }] }, 'wire-bulk-2');
  for (const text of ['朝の投稿', '昼の投稿', '別のまとまり']) { byText(h.render(), text).onConfirm(); await settle(); }
  assert.match(collectText(h.render()), /確認済み 3\/4件/u);
  const bulk = [];
  walk(h.render(), (n) => { if (n.type === 'SmallButton' && n.props.label === 'まとめて取り消し') bulk.push(n.props); });
  assert.equal(bulk.length, 2, 'one per batch');
  bulk[0].onPress();
  await settle();
  const tree = h.render();
  assert.deepEqual(cardsOf(tree).map((card) => card.draft.text), ['別のまとまり']);
  assert.match(collectText(tree), /確認済み 1\/1件/u);
});
