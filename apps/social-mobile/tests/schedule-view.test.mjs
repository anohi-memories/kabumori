// K3 correction R2 / R3: brand-bound AI settings and brand-level server rows (pure view logic).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_SETTINGS_UNLOADED,
  aiPlanningFor,
  applyAiSettingsResult,
  classifyServerPosts,
  startAiSettingsLoad,
} from '../src/domain/schedule-view.ts';
import { buildUnifiedSchedule, detectConflicts, resolveConflicts } from '../src/domain/schedule-planner.ts';

const SAVED_A = { frequencyTargetPerWeek: 7, approvalMode: 'auto_post_preference' };
const SAVED_B = { frequencyTargetPerWeek: 2, approvalMode: 'manual_review' };

// ---- R2 -------------------------------------------------------------------------------------------

test('R2: before any read, a brand has no remembered frequency and no owner opt-in', () => {
  const planning = aiPlanningFor(AI_SETTINGS_UNLOADED, 'brand_a');
  assert.equal(planning.source, 'default');
  assert.equal(planning.approvalMode, 'manual_review');
  assert.equal(planning.status, 'unloaded');
});

test('R2: A ready -> switch to B: A is not shown for B immediately, and B loads its own', () => {
  let state = applyAiSettingsResult(startAiSettingsLoad(AI_SETTINGS_UNLOADED, 'brand_a', 1), 'brand_a', 1, { state: 'ready', data: SAVED_A });
  const forA = aiPlanningFor(state, 'brand_a');
  assert.equal(forA.source, 'saved');
  assert.equal(forA.frequencyTargetPerWeek, 7);
  assert.equal(forA.approvalMode, 'auto_post_preference');
  // The workspace switches to B: the very next read of the state for B must not carry A's values.
  const forBBefore = aiPlanningFor(state, 'brand_b');
  assert.equal(forBBefore.source, 'default');
  assert.equal(forBBefore.approvalMode, 'manual_review');
  assert.notEqual(forBBefore.frequencyTargetPerWeek, 7);
  state = startAiSettingsLoad(state, 'brand_b', 2);
  state = applyAiSettingsResult(state, 'brand_b', 2, { state: 'ready', data: SAVED_B });
  const forB = aiPlanningFor(state, 'brand_b');
  assert.equal(forB.frequencyTargetPerWeek, 2);
  assert.equal(forB.approvalMode, 'manual_review');
});

test('R2: a slow A result arriving after the switch to B is ignored (stale async)', () => {
  let state = startAiSettingsLoad(AI_SETTINGS_UNLOADED, 'brand_a', 1);
  state = startAiSettingsLoad(state, 'brand_b', 2);
  const afterStaleA = applyAiSettingsResult(state, 'brand_a', 1, { state: 'ready', data: SAVED_A });
  assert.deepEqual(afterStaleA, state, 'the stale result changes nothing');
  assert.equal(aiPlanningFor(afterStaleA, 'brand_b').approvalMode, 'manual_review');
  assert.equal(aiPlanningFor(afterStaleA, 'brand_a').source, 'default', 'A is no longer the active brand');
});

test('R2: B read error / blocked / no-row never inherits A and is labelled honestly', () => {
  const stateA = applyAiSettingsResult(startAiSettingsLoad(AI_SETTINGS_UNLOADED, 'brand_a', 1), 'brand_a', 1, { state: 'ready', data: SAVED_A });
  for (const outcome of [{ state: 'unavailable' }, { state: 'blocked' }]) {
    let state = startAiSettingsLoad(stateA, 'brand_b', 2);
    state = applyAiSettingsResult(state, 'brand_b', 2, outcome);
    const planning = aiPlanningFor(state, 'brand_b');
    assert.equal(planning.source, 'default');
    assert.equal(planning.approvalMode, 'manual_review');
    assert.equal(planning.status, outcome.state, 'the real status is shown');
    assert.notEqual(planning.frequencyTargetPerWeek, 7);
  }
  // A brand with no saved row: defaults, labelled as "nothing saved yet" (not "unavailable").
  let state = startAiSettingsLoad(stateA, 'brand_c', 3);
  state = applyAiSettingsResult(state, 'brand_c', 3, { state: 'ready', data: null });
  const none = aiPlanningFor(state, 'brand_c');
  assert.equal(none.source, 'default');
  assert.equal(none.status, 'no_saved_settings');
  assert.equal(none.approvalMode, 'manual_review');
});

test('R2: rapid A -> B -> A: the second A is a new load and the first A result is stale', () => {
  let state = startAiSettingsLoad(AI_SETTINGS_UNLOADED, 'brand_a', 1);
  state = startAiSettingsLoad(state, 'brand_b', 2);
  state = startAiSettingsLoad(state, 'brand_a', 3);
  state = applyAiSettingsResult(state, 'brand_a', 1, { state: 'ready', data: { frequencyTargetPerWeek: 1, approvalMode: 'auto_post_preference' } });
  assert.equal(aiPlanningFor(state, 'brand_a').source, 'default', 'the first A result must not apply to the second A load');
  state = applyAiSettingsResult(state, 'brand_a', 3, { state: 'ready', data: SAVED_A });
  assert.equal(aiPlanningFor(state, 'brand_a').frequencyTargetPerWeek, 7);
});

test('R2: no brand (signed out / no workspace) is always the unloaded default', () => {
  const state = applyAiSettingsResult(startAiSettingsLoad(AI_SETTINGS_UNLOADED, 'brand_a', 1), 'brand_a', 1, { state: 'ready', data: SAVED_A });
  assert.equal(aiPlanningFor(state, null).source, 'default');
  assert.equal(aiPlanningFor(state, undefined).approvalMode, 'manual_review');
});

// ---- R3 -------------------------------------------------------------------------------------------

const ACCOUNTS = [
  { id: 'x_a', brandId: 'brand_a', platform: 'x' },
  { id: 'th_a', brandId: 'brand_a', platform: 'threads' },
  { id: 'x_b', brandId: 'brand_b', platform: 'x' },
];
const real = (id, brandId, accountId = 'unknown') => ({ id, brandId, accountId, scheduledAt: '2026-10-15T01:00:00.000Z', origin: 'ai_generated', status: 'scheduled', text: '' });

test('R3: an unbound server row is brand-level: never relabelled as the selected X account', () => {
  const rows = [real('s1', 'brand_a'), real('s2', 'brand_b')];
  const result = classifyServerPosts({ rows, accounts: ACCOUNTS, activeAccount: ACCOUNTS[0], isPreview: false });
  assert.deepEqual(result.accountBound.map((r) => r.id), [], 'nothing is attributed to x_a');
  assert.deepEqual(result.brandLevel.map((r) => r.id), ['s1'], 'only the active account\'s brand is listed, as brand-level');
});

test('R3: switching to a Threads account or another X account keeps the same brand rows unattributed', () => {
  const rows = [real('s1', 'brand_a')];
  const threads = classifyServerPosts({ rows, accounts: ACCOUNTS, activeAccount: ACCOUNTS[1], isPreview: false });
  assert.deepEqual(threads.accountBound, []);
  assert.deepEqual(threads.brandLevel.map((r) => r.id), ['s1']);
  const otherBrand = classifyServerPosts({ rows, accounts: ACCOUNTS, activeAccount: ACCOUNTS[2], isPreview: false });
  assert.deepEqual(otherBrand.brandLevel, [], 'another brand never sees brand_a rows');
  assert.deepEqual(otherBrand.accountBound, []);
});

test('R3: brand-level rows never enter the per-account conflict solver, and rows without a brand are not shown', () => {
  const rows = [real('s1', 'brand_a'), { ...real('s2', 'brand_a'), brandId: undefined }];
  const result = classifyServerPosts({ rows, accounts: ACCOUNTS, activeAccount: ACCOUNTS[0], isPreview: false });
  assert.deepEqual(result.brandLevel.map((r) => r.id), ['s1']);
  assert.deepEqual(result.unattributable.map((r) => r.id), ['s2'], 'unknown brand: counted, never attributed');
  // The solver and the conflict detector only ever receive account-bound rows.
  const view = buildUnifiedSchedule({ accountId: 'x_a', serverPosts: result.accountBound, drafts: [] });
  assert.equal(view.length, 0);
  assert.deepEqual(detectConflicts(view), []);
  const solved = resolveConflicts({ drafts: [], batches: [], serverPosts: result.accountBound, now: new Date('2026-10-11T10:00:00+09:00') });
  assert.deepEqual(solved.issues, []);
});

test('R3: mock preview rows with a known account still filter normally by that account', () => {
  const rows = [
    { id: 'm1', accountId: 'x_a', scheduledAt: '2026-10-15T01:00:00.000Z', origin: 'user_authored', status: 'scheduled', text: 'm1' },
    { id: 'm2', accountId: 'th_a', scheduledAt: '2026-10-15T02:00:00.000Z', origin: 'user_authored', status: 'scheduled', text: 'm2' },
  ];
  const result = classifyServerPosts({ rows, accounts: ACCOUNTS, activeAccount: ACCOUNTS[0], isPreview: true });
  assert.deepEqual(result.accountBound.map((r) => r.id), ['m1']);
  assert.deepEqual(result.brandLevel, []);
});

test('R3: a row bound to an account of another brand is never shown for this one', () => {
  const rows = [{ ...real('s9', 'brand_a'), accountId: 'x_b' }];
  const result = classifyServerPosts({ rows, accounts: ACCOUNTS, activeAccount: ACCOUNTS[0], isPreview: false });
  assert.deepEqual(result.accountBound, []);
  assert.deepEqual(result.brandLevel, []);
  assert.deepEqual(result.unattributable.map((r) => r.id), ['s9']);
});

test('R3: no active account -> nothing is attributed or listed', () => {
  const result = classifyServerPosts({ rows: [real('s1', 'brand_a')], accounts: ACCOUNTS, activeAccount: null, isPreview: false });
  assert.deepEqual(result, { accountBound: [], brandLevel: [], unattributable: [] });
});

// ---- the screen itself uses the tested logic (static) ----------------------------------------------

test('the schedule screen routes AI settings and server rows through the tested pure logic', async () => {
  const { readFile } = await import('node:fs/promises');
  const screen = await readFile(new URL('../src/app/(tabs)/schedule.tsx', import.meta.url), 'utf8');
  // R3: no relabelling of unbound rows as the selected account's rows.
  assert.doesNotMatch(screen, /accountId === 'unknown'|post\.accountId === 'unknown'/u);
  assert.match(screen, /classifyServerPosts\(/u);
  assert.match(screen, /const serverPosts = classified\.accountBound;/u, 'only account-bound rows reach the solver / conflict check');
  assert.match(screen, /投稿先アカウント未特定／ブランド単位/u);
  // R2: the AI settings come from the brand-bound state, not a free-floating copy.
  assert.match(screen, /aiPlanningFor\(aiState, brandId\)/u);
  assert.match(screen, /startAiSettingsLoad\(/u);
  assert.match(screen, /applyAiSettingsResult\(/u);
  assert.doesNotMatch(screen, /setAi\(/u);
  // R1: a re-roll is given the current drafts and applies times only.
  assert.match(screen, /rerollBatch\(batch, \{ owner, now: new Date\(\), occupied: occupiedExcept\(batch\.id\) \}, drafts\)/u);
});

test('R2: a ready read for brand A does not leak through a "not ready" window of brand B', () => {
  // The screen skips loading while the workspace is not ready; the state still holds A's values.
  const state = applyAiSettingsResult(startAiSettingsLoad(AI_SETTINGS_UNLOADED, 'brand_a', 1), 'brand_a', 1, { state: 'ready', data: SAVED_A });
  for (const brand of ['brand_b', null, undefined, '']) {
    const planning = aiPlanningFor(state, brand);
    assert.equal(planning.source, 'default');
    assert.equal(planning.approvalMode, 'manual_review');
    assert.equal(planning.status, 'unloaded');
  }
});
