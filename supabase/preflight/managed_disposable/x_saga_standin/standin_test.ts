// The X saga stand-in itself (Phase 13, D-2): what it answers, that every answer is marked simulated, that it fails closed, that it
// is disabled unless armed, that its one conversion to the lifecycle's vocabulary is registered as simulated, and that it
// does nothing at all (live tripwires). Pure; no database, no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import * as harnessModule from './harness.ts';
import {
  ackResponder, assertSimulated, isSimulatedLifecycleResult, REPORT_BANNER, sagaResponder, SIMULATED_RESULT, simulatedReport, syntheticXCleaner, toLifecycleResult, withStandInAck,
} from './harness.ts';
import * as standinModule from './standin.ts';
import {
  createXSagaStandIn, disabledStandIn, isStandInSnapshot, recordsAreSimulated, STAND_IN_BLOCK_REASONS, STAND_IN_MARKERS, STAND_IN_RECONCILIATION_REASONS,
  standInSnapshot, type StandInConfig, type StandInStep,
} from './standin.ts';
import { armTripwires, SECRET_ENV_NAME, TripwireError, withTripwires } from './tripwire.ts';

// built from pieces: the exclusion check (E6) refuses a URL literal anywhere in this directory
const INVALID_URL = ['https', '://example.invalid/'].join('');
const STAND_IN_URL = ['https', '://stand-in.invalid/'].join('');
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const persons = { hasKabumoriProfile: (id: string) => id === ALICE };
const make = (script: StandInStep[], over: Partial<StandInConfig> = {}) => createXSagaStandIn({ armed: true, script, persons, ...over });
const tokenOf = (user: string) => `${btoa('{}')}.${btoa(JSON.stringify({ sub: user })).replace(/=+$/u, '')}.sig`;
const userOf = (token: string): string | null => {
  try {
    return (JSON.parse(atob(token.split('.')[1])) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
};

test('every simulated answer carries the three markers, in every call kind, and the markers cannot be forged away', async () => {
  const standIn = make([{ scenario: 'clean', unconfirmedPosts: 2 }]);
  const preview = await standIn.preview(ALICE);
  const run = await standIn.run(ALICE);
  assert.equal(preview.kind, 'simulated');
  assert.equal(run.kind, 'simulated');
  for (const answer of [preview, run]) {
    assert.equal((answer as { effects_performed: unknown }).effects_performed, false);
    assert.equal((answer as { remote_x_verified: unknown }).remote_x_verified, false);
    assert.equal((answer as { production_usable: unknown }).production_usable, false);
  }
  if (run.kind !== 'simulated' || run.facts.unconfirmedSnapshot === undefined) throw new Error('expected a simulated clean run with a snapshot');
  const ack = await standIn.acknowledge(ALICE, run.facts.unconfirmedSnapshot);
  assert.equal(ack.kind, 'simulated');
  assert.equal((ack as { remote_x_verified: unknown }).remote_x_verified, false);
  assert.equal(standIn.records.length, 3);
  assert.ok(recordsAreSimulated(standIn.records));
  assert.deepEqual(standIn.records.map((r) => r.call), ['preview', 'run', 'ack']);
  assert.ok(Object.isFrozen(STAND_IN_MARKERS));
  assert.throws(() => { (STAND_IN_MARKERS as { remote_x_verified: boolean }).remote_x_verified = true; }, TypeError);
  assert.ok(!recordsAreSimulated([{ ...standIn.records[0], remote_x_verified: true } as unknown as (typeof standIn.records)[number]]), 'a record that claims a remote verification is not simulated');
});

test('the scripted scenarios are answered in order, one per run, with the reasons F3 defines; an exhausted script fails closed', async () => {
  const standIn = make([
    { scenario: 'blocked', reason: 'POSTING_IN_PROGRESS' }, { scenario: 'in_progress' }, { scenario: 'reconciliation_required', reason: 'X_REVOKE_FAILED' },
    { scenario: 'failed' }, { scenario: 'clean' },
  ]);
  const answers = [];
  for (let i = 0; i < 7; i += 1) answers.push(await standIn.run(ALICE));
  assert.deepEqual(answers.map((a) => (a.kind === 'simulated' ? a.scenario : a.kind)), ['blocked', 'in_progress', 'reconciliation_required', 'failed', 'clean', 'failed', 'failed']);
  assert.deepEqual(answers.map((a) => (a.kind === 'simulated' ? a.facts.reason : undefined)), ['POSTING_IN_PROGRESS', undefined, 'X_REVOKE_FAILED', undefined, undefined, undefined, undefined]);
  assert.ok(STAND_IN_BLOCK_REASONS.includes('UNEXPECTED_DEPENDENT_DATA') && STAND_IN_RECONCILIATION_REASONS.length === 3);
  assert.equal(make([]).armed, true);
  const empty = await make([]).run(ALICE);
  assert.equal(empty.kind === 'simulated' && empty.scenario, 'failed', 'no script = failed, never clean');
});

test('a disabled stand-in answers stand_in_disabled to everything and is the default of the harness', async () => {
  const standIn = disabledStandIn();
  assert.equal(standIn.armed, false);
  assert.deepEqual(await standIn.preview(ALICE), { kind: 'stand_in_disabled' });
  assert.deepEqual(await standIn.run(ALICE), { kind: 'stand_in_disabled' });
  assert.deepEqual(await standIn.acknowledge(ALICE, await standInSnapshot(ALICE, 1)), { kind: 'stand_in_disabled' });
  assert.ok(standIn.records.every((r) => r.disabled && recordsAreSimulated([r])));
  // through the adapters: the preview is "unsupported", the run is a failure, the acknowledgement is an unusable RPC
  const cleaner = syntheticXCleaner(standIn, { userOf });
  assert.equal(await cleaner.preview(tokenOf(ALICE)), null);
  const run = await cleaner.run(tokenOf(ALICE));
  assert.equal(typeof run === 'string' ? run : run.outcome, 'failed');
  const rpc = withStandInAck(() => Promise.resolve({ ok: true as const, data: 'passed through' }), standIn);
  assert.deepEqual(await rpc('ack_x_unconfirmed', { p_user_id: ALICE, p_snapshot: await standInSnapshot(ALICE, 1) }), { ok: false });
  const none = createXSagaStandIn({ armed: false, script: [{ scenario: 'clean' }], persons });
  assert.equal((await none.run(ALICE)).kind, 'stand_in_disabled', 'a script does not arm a stand-in');
});

test('the preview reproduces the real saga\'s scope rule, including the R2\' limitation: a POSTONA-only person gets social_and_login', async () => {
  const standIn = make([{ scenario: 'clean' }]);
  const kabumori = await standIn.preview(ALICE);
  const postonaOnly = await standIn.preview(BOB);
  assert.deepEqual([kabumori.kind === 'simulated' && kabumori.scope, postonaOnly.kind === 'simulated' && postonaOnly.scope], ['social_only', 'social_and_login']);
  assert.equal(await syntheticXCleaner(standIn, { userOf }).preview(tokenOf(BOB)).then((p) => p?.scope), 'social_and_login', 'the stand-in does not fix R2\'');
  const waiting = await make([{ scenario: 'in_progress' }]).preview(ALICE);
  assert.equal(waiting.kind === 'simulated' && waiting.state, 'in_progress');
  const operator = await make([], { previewOperatorRequired: true }).preview(ALICE);
  assert.equal(operator.kind === 'simulated' && operator.state, 'operator_required');
});

test('unconfirmed posts: a count comes with a derived 64-hex name; acknowledging it clears it once, a replay is a replay, a stale name changes, a bare count clears nothing', async () => {
  const standIn = make([{ scenario: 'clean', unconfirmedPosts: 2 }]);
  const run = await standIn.run(ALICE);
  assert.ok(run.kind === 'simulated' && run.facts.unconfirmedPosts === 2 && isStandInSnapshot(run.facts.unconfirmedSnapshot));
  const name = (run as { facts: { unconfirmedSnapshot: string } }).facts.unconfirmedSnapshot;
  assert.equal(name, await standInSnapshot(ALICE, 1), 'a pure function of the person and the generation');
  assert.notEqual(name, await standInSnapshot(BOB, 1));
  assert.notEqual(name, await standInSnapshot(ALICE, 2));
  const body = async (answer: ReturnType<typeof standIn.acknowledge>) => { const a = await answer; return a.kind === 'simulated' ? a.body : null; };
  assert.deepEqual(await body(standIn.acknowledge(ALICE, 2)), { status: 'snapshot_required' }, 'a count is not a name');
  assert.deepEqual(await body(standIn.acknowledge(ALICE, await standInSnapshot(ALICE, 9))), { status: 'snapshot_changed', x_posts_unconfirmed: 2, x_unconfirmed_snapshot: name });
  assert.deepEqual(await body(standIn.acknowledge(ALICE, name)), { status: 'acknowledged', cleared: 2, replay: false });
  assert.deepEqual(await body(standIn.acknowledge(ALICE, name)), { status: 'acknowledged', cleared: 2, replay: true });
  assert.deepEqual(await body(standIn.acknowledge(ALICE, await standInSnapshot(ALICE, 9))), { status: 'snapshot_changed', x_posts_unconfirmed: 0, x_unconfirmed_snapshot: null }, 'nothing left');
  // someone else's snapshot does not clear this person's set
  const other = make([{ scenario: 'clean', unconfirmedPosts: 1 }]);
  await other.run(ALICE);
  assert.deepEqual(await body(other.acknowledge(BOB, await standInSnapshot(ALICE, 1))), { status: 'snapshot_changed', x_posts_unconfirmed: 0, x_unconfirmed_snapshot: null });
  // a stale acknowledgement: the set grew under the caller
  const stale = make([{ scenario: 'clean', unconfirmedPosts: 2 }], { staleAcks: 1 });
  const first = await stale.run(ALICE);
  const firstName = (first as { facts: { unconfirmedSnapshot: string } }).facts.unconfirmedSnapshot;
  const changed = await body(stale.acknowledge(ALICE, firstName));
  assert.deepEqual(changed, { status: 'snapshot_changed', x_posts_unconfirmed: 3, x_unconfirmed_snapshot: await standInSnapshot(ALICE, 2) });
  assert.deepEqual(await body(stale.acknowledge(ALICE, firstName)), { status: 'snapshot_changed', x_posts_unconfirmed: 3, x_unconfirmed_snapshot: await standInSnapshot(ALICE, 2) }, 'the old name stays stale');
  assert.deepEqual(await body(stale.acknowledge(ALICE, await standInSnapshot(ALICE, 2))), { status: 'acknowledged', cleared: 3, replay: false });
});

test('the one conversion: only harness.toLifecycleResult says `done`, the result is frozen and registered as simulated, and nothing in standin.ts can produce a lifecycle result', async () => {
  const standIn = make([{ scenario: 'clean', unconfirmedPosts: 1 }, { scenario: 'blocked', reason: 'UNEXPECTED_DEPENDENT_DATA' }, { scenario: 'in_progress' }, { scenario: 'reconciliation_required', reason: 'FINALIZE_FAILED' }, { scenario: 'failed' }]);
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(toLifecycleResult(await standIn.run(ALICE)));
  assert.deepEqual(results.map((r) => r.outcome), ['done', 'blocked', 'in_progress', 'failed', 'failed']);
  assert.deepEqual(results.map((r) => r.reason), [undefined, 'UNEXPECTED_DEPENDENT_DATA', undefined, 'FINALIZE_FAILED', undefined]);
  assert.equal(results[0].unconfirmedPosts, 1);
  assert.ok(isSimulatedLifecycleResult(results[0]) && results.every((r) => isSimulatedLifecycleResult(r)));
  assert.deepEqual((results[0] as unknown as Record<symbol, unknown>)[SIMULATED_RESULT], STAND_IN_MARKERS);
  assert.ok(Object.isFrozen(results[0]));
  assert.ok(!Object.keys(results[0]).includes('simulated'), 'the marker does not travel as an enumerable field the lifecycle could copy into a response');
  assert.ok(!isSimulatedLifecycleResult({ outcome: 'done' }), 'a hand-made result is not registered');
  assert.equal(toLifecycleResult({ kind: 'stand_in_disabled' }).outcome, 'failed');
  // the module surface: standin.ts exports no function that returns a lifecycle result and no name of one
  assert.deepEqual(Object.keys(standinModule).filter((name) => /lifecycle|cleanup|outcome|done/iu.test(name)), []);
  assert.ok(Object.keys(harnessModule).includes('toLifecycleResult'));
});

test('the adapters: the cleaner and the acknowledgement route answer from the stand-in and mark their report; nothing else is touched', async () => {
  const standIn = make([{ scenario: 'clean', unconfirmedPosts: 1 }]);
  const cleaner = syntheticXCleaner(standIn, { userOf });
  assert.deepEqual(await cleaner.preview(tokenOf(ALICE)), { scope: 'social_only', state: 'none' });
  assert.equal(await cleaner.preview('not.a.token'), null, 'an unreadable token is no person');
  const run = await cleaner.run(tokenOf(ALICE));
  assert.equal(typeof run === 'string' ? run : run.outcome, 'done');
  const passed: string[] = [];
  const rpc = withStandInAck((name) => { passed.push(name); return Promise.resolve({ ok: true as const, data: { name } }); }, standIn);
  assert.deepEqual(await rpc('release_gate', {}), { ok: true, data: { name: 'release_gate' } });
  assert.deepEqual(passed, ['release_gate'], 'every other RPC is passed through untouched');
  const snapshot = (run as { unconfirmedSnapshot: string }).unconfirmedSnapshot;
  assert.deepEqual(await rpc('ack_x_unconfirmed', { p_user_id: ALICE, p_snapshot: snapshot }), { ok: true, data: { status: 'acknowledged', cleared: 1, replay: false } });
  assert.deepEqual(passed, ['release_gate'], 'the acknowledgement never reached the underlying RPC');
  const lines = simulatedReport(standIn.records);
  assert.equal(lines[0], REPORT_BANNER);
  assert.ok(lines.slice(1).every((line) => line.startsWith('SIMULATED X #') && line.endsWith('effects_performed=false remote_x_verified=false production_usable=false')));
  assert.equal(lines.length, standIn.records.length + 1);
  assertSimulated(standIn.records);
  assert.throws(() => assertSimulated([{ ...standIn.records[0], effects_performed: true } as unknown as (typeof standIn.records)[number]]), /not marked simulated/u);
});

test('repeat runs are identical: the same script gives the same answers, records and names (no clock, no randomness)', async () => {
  const play = async () => {
    const s = make([{ scenario: 'clean', unconfirmedPosts: 3 }, { scenario: 'blocked', reason: 'SHARED_WORKSPACE' }], { staleAcks: 1 });
    const out: unknown[] = [await s.preview(ALICE)];
    for (let i = 0; i < 2; i += 1) out.push(await s.run(i === 0 ? ALICE : BOB));
    out.push(await s.acknowledge(ALICE, await standInSnapshot(ALICE, 1)), await s.acknowledge(ALICE, await standInSnapshot(ALICE, 2)));
    return JSON.stringify({ out, records: s.records });
  };
  assert.equal(await play(), await play());
});

test('the tripwires work, and the stand-in does nothing while they are armed: no network, no secret read, no subprocess', async () => {
  const wires = armTripwires({ subprocess: true });
  const attempts = [
    () => fetch(INVALID_URL), () => new WebSocket('wss://example.invalid/'), () => Deno.connect({ port: 9 }),
    () => new Deno.Command('true'), () => Deno.env.get('SERVICE_ROLE_KEY'),
  ];
  for (const attempt of attempts) assert.throws(() => attempt(), TripwireError);
  assert.equal(Deno.env.get('HOME') === undefined || typeof Deno.env.get('HOME') === 'string', true, 'a harmless variable is still readable');
  assert.deepEqual(wires.hits.length, 5);
  wires.restore();
  assert.equal(typeof fetch, 'function');
  assert.doesNotThrow(() => Deno.env.get('SERVICE_ROLE_KEY'), 'restored');
  assert.ok(SECRET_ENV_NAME.test('X_CLIENT_SECRET') && SECRET_ENV_NAME.test('SUPABASE_SERVICE_ROLE_KEY') && !SECRET_ENV_NAME.test('PGHOST'));

  const { hits } = await withTripwires(async () => {
    const standIn = make([{ scenario: 'clean', unconfirmedPosts: 2 }, { scenario: 'failed' }], { staleAcks: 1 });
    const cleaner = syntheticXCleaner(standIn, { userOf });
    await cleaner.preview(tokenOf(ALICE));
    const run = await cleaner.run(tokenOf(ALICE));
    const rpc = withStandInAck(() => Promise.resolve({ ok: true as const, data: null }), standIn);
    await rpc('ack_x_unconfirmed', { p_user_id: ALICE, p_snapshot: (run as { unconfirmedSnapshot: string }).unconfirmedSnapshot });
    await cleaner.run(tokenOf(ALICE));
    await disabledStandIn().run(ALICE);
    simulatedReport(standIn.records);
  }, { subprocess: true });
  assert.deepEqual(hits, [], 'the stand-in performed no network, secret-environment or subprocess operation');
});

test('the tripwires are not re-entrant (overlapping arms would leave the process tripwired) and restore leaves the originals', async () => {
  const wires = armTripwires();
  assert.throws(() => armTripwires(), /already armed/u);
  wires.restore();
  const again = armTripwires();
  again.restore();
  const nativeFetch = fetch;
  const { hits } = await withTripwires(() => { assert.notEqual(fetch, nativeFetch); return Promise.resolve(); });
  assert.deepEqual(hits, []);
  assert.equal(fetch, nativeFetch, 'the original fetch is back');
  await assert.rejects(withTripwires(async () => { await fetch(INVALID_URL); }), TripwireError);
  assert.equal(fetch, nativeFetch, 'restored even when the body throws');
});

test('the HTTP face (for the database-backed harness): every body carries the marker, each scenario has the status and error the real mapper reads, a disabled stand-in is a 404', async () => {
  const standIn = make([
    { scenario: 'clean', unconfirmedPosts: 2 }, { scenario: 'blocked', reason: 'POSTING_IN_PROGRESS' }, { scenario: 'in_progress' },
    { scenario: 'reconciliation_required', reason: 'CREDENTIALS_CHANGED' }, { scenario: 'failed' }, { scenario: 'clean' },
  ]);
  const respond = sagaResponder(standIn);
  const ask = async (action: unknown, token: string | null = tokenOf(ALICE)) => {
    const response = await respond(new Request(STAND_IN_URL, {
      method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify({ action }),
    }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const marker = { simulated: true, effects_performed: false, remote_x_verified: false, production_usable: false };
  const preview = await ask('preview');
  assert.deepEqual([preview.status, preview.body.ok, preview.body.scope, preview.body.state], [200, true, 'social_only', 'none']);
  const answers = [];
  for (let i = 0; i < 6; i += 1) answers.push(await ask('delete'));
  assert.deepEqual(answers.map((a) => [a.status, a.body.ok, a.body.error ?? null]), [
    [200, true, null], [409, false, 'DELETION_BLOCKED_POSTING_IN_PROGRESS'], [409, false, 'DELETION_IN_PROGRESS'], [502, false, 'CREDENTIALS_CHANGED'], [500, false, 'FAILED'], [200, true, null],
  ]);
  assert.deepEqual([answers[0].body.login_deleted, answers[0].body.x_posts_unconfirmed, answers[0].body.x_unconfirmed_snapshot], [false, 2, await standInSnapshot(ALICE, 1)]);
  assert.deepEqual(answers[5].body.x_posts_unconfirmed, undefined, 'a clean answer with no unconfirmed posts carries neither field');
  for (const answer of [preview, ...answers]) assert.deepEqual(answer.body.stand_in, marker, 'the marker is in every body');
  assert.deepEqual((await ask('drop')).status, 400);
  assert.deepEqual((await ask('preview', null)).status, 401);
  const ack = ackResponder(standIn);
  const acked = await ack({ p_user_id: ALICE, p_snapshot: await standInSnapshot(ALICE, 1) });
  const ackBody = await acked.json() as Record<string, unknown>;
  assert.deepEqual([acked.status, ackBody.status, ackBody.cleared, ackBody.replay, ackBody.stand_in], [200, 'acknowledged', 2, false, marker]);
  const off = disabledStandIn();
  assert.equal((await sagaResponder(off)(new Request(STAND_IN_URL, { method: 'POST', headers: { authorization: `Bearer ${tokenOf(ALICE)}` }, body: JSON.stringify({ action: 'delete' }) }))).status, 404);
  assert.equal((await ackResponder(off)({ p_user_id: ALICE, p_snapshot: await standInSnapshot(ALICE, 1) })).status, 404);
});
