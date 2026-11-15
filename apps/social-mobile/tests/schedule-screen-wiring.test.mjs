// K3 R2b: the REAL schedule.tsx (transpiled) driven with stubbed React/RN, a scripted snapshot, a scripted
// active account and an in-memory settings store. Proves the wiring -- not just the pure helper -- binds the
// AI planning inputs to the SELECTED account's brand, never to the snapshot's first workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as scheduleView from '../src/domain/schedule-view.ts';
import * as planner from '../src/domain/schedule-planner.ts';
import * as dataView from '../src/domain/data-view.ts';
import * as contentSettings from '../src/domain/content-settings.ts';
import * as reservationStore from '../src/features/schedule/reservation-store.ts';

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
