// The POSTONA service-exit scenarios with the X saga STAND-IN at the harness' dependency boundary (Phase 13, D-2), over the same fake
// lifecycle database as the production tests (account-delete/fake_lifecycle.ts). F5's lifecycle code (handleWithdrawPostona,
// endPostona) is the REAL one and is not touched; only `deps.x` and the acknowledgement RPC are the stand-in's. Every scenario
// runs with the live tripwires armed (no network, no secret read, no subprocess), and every outcome that depends on the stand-in
// is asserted with a [SIMULATED X] label: a PASS here is never a real revoke, purge, Vault read or managed M12.
// The real database half (leases, fences, footprint, results) is proven by the PostgreSQL-backed twin of this file,
// supabase/tests/common_account_phase13_d2_standin_test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';

import { bearer, deferred, NOW, signIn, USER, world, type World, type WorldOptions } from '../../../functions/account-delete/fake_lifecycle.ts';
import { END_POSTONA_CONFIRMATION, handleWithdrawPostona, LEASE_SECONDS, type LifecycleResponse } from '../../../functions/account-delete/lifecycle_logic.ts';
import type { ProviderCleanupAdapter } from '../../../functions/account-delete/provider_cleanup.ts';
import { ACK_ROUNDS } from '../../../functions/account-delete/x_unconfirmed.ts';
import { assertSimulated, REPORT_BANNER, simulated, simulatedReport, syntheticXCleaner, withStandInAck } from './harness.ts';
import { createXSagaStandIn, standInSnapshot, type StandInConfig, type StandInStep, type XSagaStandIn } from './standin.ts';
import { withTripwires } from './tripwire.ts';

const userOf = (token: string): string | null => {
  try {
    return (JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
};
const ACK = { acknowledged_remote_unverified: ['threads'] };

type Setup = { w: World; standIn: XSagaStandIn };
/** The real fake lifecycle world with the stand-in as its X dependency; `xConnected: false` = the person has no X footprint at all. */
function setup(script: StandInStep[], options: { world?: WorldOptions; xConnected?: boolean; standIn?: Partial<StandInConfig> } = {}): Setup {
  const w = world({ x: 'active', ...options.world });
  if (options.xConnected === false) w.state.xWorkspace = false;
  const standIn = createXSagaStandIn({ armed: true, script, persons: { hasKabumoriProfile: () => w.state.profile }, ...options.standIn });
  w.deps.x = syntheticXCleaner(standIn, { userOf });
  w.deps.rpc = withStandInAck(w.deps.rpc, standIn);
  return { w, standIn };
}
const withdraw = (w: World, body: Record<string, unknown> = {}, token = signIn()) =>
  handleWithdrawPostona({ authorization: bearer(token), body: { confirmation: END_POSTONA_CONFIRMATION, ...body } }, w.deps);
const error = (response: LifecycleResponse) => (response.body.ok ? null : response.body.error);
const bodyOf = (response: LifecycleResponse) => response.body as Record<string, unknown>;
const lose = (w: World) => { w.state.clock += LEASE_SECONDS + 1; };
const runs = (standIn: XSagaStandIn) => standIn.records.filter((r) => r.call === 'run').length;
const acks = (standIn: XSagaStandIn) => standIn.records.filter((r) => r.call === 'ack').map((r) => r.answered);

/** Every scenario: tripwires armed around it, and every stand-in record marked simulated afterwards. */
function scenario(name: string, body: () => Promise<Setup[] | Setup | void>) {
  test(name, async () => {
    const { result, hits } = await withTripwires(body, { subprocess: true });
    assert.deepEqual(hits, [], simulated('the stand-in and the lifecycle made no network call, read no secret, started no subprocess'));
    for (const item of Array.isArray(result) ? result : result ? [result] : []) assertSimulated(item.standIn.records);
  });
}

scenario('POSTONA-only person (no Kabumori profile): the stand-in reproduces R2\', the end is refused before anything changes and the saga is never run', async () => {
  const s = setup([{ scenario: 'clean' }], { world: { kabumori: null }, xConnected: false });
  const response = await withdraw(s.w);
  assert.equal(response.status, 409);
  assert.equal(error(response), 'X_CLEANUP_UNSUPPORTED', simulated('the stand-in did not fix R2\''));
  assert.equal(s.w.state.services.x_autopost, 'active');
  assert.ok(!s.w.effects.includes('rpc:begin_service_deletion'));
  assert.deepEqual(s.standIn.records.map((r) => `${r.call}:${r.answered}`), ['preview:social_and_login/none'], simulated('only the read-only preview was asked'));
  assert.equal(runs(s.standIn), 0);
  // parity with the fake world's own preview (which models the real saga's rule): the two never disagree about the scope
  const own = await world({ x: 'active', kabumori: null }).deps.x.preview(signIn());
  assert.equal(own?.scope, 'social_and_login');
  return s;
});

scenario('a Kabumori person with no X footprint (X not connected): the stand-in\'s clean answer ends POSTONA only; the login, Kabumori, the profile and every other service stay', async () => {
  const s = setup([{ scenario: 'clean' }], { world: { otherServices: [{ service_key: 'future_app', status: 'active' }] }, xConnected: false });
  const others = () => JSON.stringify([...s.w.state.services.kabumori ? [s.w.state.services.kabumori] : [], s.w.state.profile, s.w.state.login, s.w.state.account]);
  const before = others();
  const response = await withdraw(s.w);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, outcome: 'ended', providers: { x: 'done' } }, simulated('"x: done" is the stand-in\'s simulated answer, nothing was revoked'));
  assert.equal(s.w.state.services.x_autopost, 'ended');
  assert.equal(others(), before, 'Kabumori, the profile, the login and the account are unchanged');
  assert.equal(s.w.state.services.kabumori, 'active');
  assert.equal(s.w.state.login, true);
  assert.deepEqual(s.w.deps.nowSeconds(), NOW);
  for (const never of ['rpc:begin_account_deletion', 'auth:delete', 'auth:revoke_sessions', 'rpc:withdraw_kabumori', 'storage:remove']) {
    assert.ok(!s.w.effects.includes(never), `${never} is not part of ending POSTONA alone`);
  }
  assert.equal(s.w.state.calls.x, 0, 'the fake world\'s own X dependency was replaced: it was never called');
  assert.deepEqual(s.standIn.records.map((r) => `${r.call}:${r.answered}`), ['preview:social_only/none', 'run:clean']);
  const report = simulatedReport(s.standIn.records);
  assert.equal(report[0], REPORT_BANNER);
  assert.ok(report.slice(1).every((line) => line.includes('production_usable=false')));
  // the future app's entitlement is untouched
  assert.deepEqual((await s.w.deps.rpc('eligibility', { p_user_id: USER }) as { ok: true; data: { services: { service_key: string; status: string }[] } }).data.services.filter((x) => x.service_key === 'future_app'), [{ service_key: 'future_app', status: 'active' }]);
  return s;
});

scenario('a simulated clean answer cannot end POSTONA while an X footprint remains: F5\'s own database check refuses (the stand-in has no effect to hide behind)', async () => {
  const s = setup([{ scenario: 'clean' }, { scenario: 'clean' }]);   // the person HAS an X workspace
  const first = await withdraw(s.w);
  assert.equal(first.status, 409);
  assert.equal(error(first), 'SERVICE_CLEANUP_INCOMPLETE', simulated('"done" from a stand-in does not make a real footprint disappear'));
  assert.equal(s.w.state.services.x_autopost, 'deleting', 'not ended; the operation stays resumable');
  assert.equal(s.w.state.xWorkspace, true);
  assert.equal(s.w.state.svc?.lease, null, 'the lease was given back');
  // the HARNESS (not the stand-in) simulates the local effect the real saga would have had, in the synthetic world only, and the retry completes
  s.w.state.xWorkspace = false;
  const retry = await withdraw(s.w);
  assert.equal(retry.status, 200);
  assert.equal(s.w.state.services.x_autopost, 'ended');
  assert.equal(runs(s.standIn), 2);
  return s;
});

scenario('bookings and an ongoing X post: the saga\'s typed blocks stop the end, nothing is ended, the lease is returned, and a later clean answer finishes it', async () => {
  const s = setup([
    { scenario: 'blocked', reason: 'UNEXPECTED_DEPENDENT_DATA' }, { scenario: 'blocked', reason: 'POSTING_IN_PROGRESS' }, { scenario: 'in_progress' }, { scenario: 'clean' },
  ], { xConnected: false });
  const booking = await withdraw(s.w);
  assert.deepEqual([booking.status, error(booking), bodyOf(booking).reasons], [409, 'X_CLEANUP_BLOCKED', ['UNEXPECTED_DEPENDENT_DATA']], simulated('booking present (simulated block)'));
  const post = await withdraw(s.w);
  assert.deepEqual([post.status, error(post), bodyOf(post).reasons], [409, 'X_CLEANUP_BLOCKED', ['POSTING_IN_PROGRESS']], simulated('ongoing X post (simulated block)'));
  const busy = await withdraw(s.w);
  assert.deepEqual([busy.status, error(busy)], [409, 'X_CLEANUP_IN_PROGRESS']);
  assert.equal(s.w.state.services.x_autopost, 'deleting', 'three refusals, nothing ended');
  assert.equal(s.w.state.svc?.lease, null, 'F5\'s own lease is returned after every refusal');
  assert.equal(s.w.state.svc?.status, 'in_progress');
  assert.ok(!s.w.effects.includes('rpc:finish_owned_service'), 'no completion was attempted');
  const done = await withdraw(s.w);
  assert.equal(done.status, 200);
  assert.equal(s.w.state.services.x_autopost, 'ended');
  assert.equal(s.w.state.svc?.fence, 4, 'one lease per attempt: the fence only moves forward');
  return s;
});

scenario('an X revoke failure (simulated) is a reconciliation, never a success: typed reason, resumable, and the retry can finish', async () => {
  const s = setup([{ scenario: 'reconciliation_required', reason: 'X_REVOKE_FAILED' }, { scenario: 'failed' }, { scenario: 'clean' }], { xConnected: false });
  const revoke = await withdraw(s.w);
  assert.deepEqual([revoke.status, error(revoke), bodyOf(revoke).reasons], [502, 'X_CLEANUP_FAILED', ['X_REVOKE_FAILED']]);
  assert.equal(s.w.state.svc?.results.x, 'reconciliation_required');
  const failed = await withdraw(s.w);
  assert.deepEqual([failed.status, error(failed)], [502, 'X_CLEANUP_FAILED']);
  assert.equal(s.w.state.services.x_autopost, 'deleting');
  const done = await withdraw(s.w);
  assert.equal(done.status, 200);
  assert.equal(s.w.state.svc?.results.x, 'done');
  assert.equal(s.w.state.services.x_autopost, 'ended');
  return s;
});

scenario('unconfirmed posts: the pair is recorded BEFORE the stand-in is told, the exact snapshot is acknowledged by the stand-in, the person is told the count', async () => {
  const s = setup([{ scenario: 'clean', unconfirmedPosts: 2 }], { xConnected: false });
  const response = await withdraw(s.w);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, outcome: 'ended', providers: { x: 'done' }, x_posts_unconfirmed: 2 });
  const name = await standInSnapshot(USER, 1);
  assert.deepEqual(s.w.state.svc?.recon, { x_posts_unconfirmed: 2, x_unconfirmed_snapshots: [name] }, 'recorded in F5\'s own state');
  assert.deepEqual(acks(s.standIn), ['acknowledged'], simulated('the acknowledgement is the stand-in\'s own, synthetic'));
  assert.deepEqual(s.w.state.xAcks, [], 'the lifecycle database\'s acknowledgement RPC (the real saga\'s) was never reached');
  const order = ['rpc:record_x_unconfirmed', 'rpc:record_provider_result'].map((e) => s.w.effects.indexOf(e));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1], 'recorded before X is marked done');
  return s;
});

scenario('a stale snapshot acknowledgement: the changed set is recorded first, then acknowledged; after ACK_ROUNDS the end still tells the highest count and acknowledges nothing it did not record', async () => {
  const stale = setup([{ scenario: 'clean', unconfirmedPosts: 2 }], { xConnected: false, standIn: { staleAcks: 1 } });
  const response = await withdraw(stale.w);
  assert.equal(response.status, 200);
  assert.equal(bodyOf(response).x_posts_unconfirmed, 3);
  assert.deepEqual(stale.w.state.svc?.recon.x_unconfirmed_snapshots, [await standInSnapshot(USER, 1), await standInSnapshot(USER, 2)], 'both sets are on record');
  assert.deepEqual(acks(stale.standIn), ['snapshot_changed', 'acknowledged']);

  const never = setup([{ scenario: 'clean', unconfirmedPosts: 2 }], { xConnected: false, standIn: { staleAcks: 99 } });
  const capped = await withdraw(never.w);
  assert.equal(capped.status, 200);
  assert.equal(acks(never.standIn).length, ACK_ROUNDS, 'the loop stops after ACK_ROUNDS');
  assert.ok(acks(never.standIn).every((answer) => answer === 'snapshot_changed'), simulated('the stand-in never acknowledged anything'));
  assert.equal(bodyOf(capped).x_posts_unconfirmed, 2 + ACK_ROUNDS, 'the highest observed count is still told');
  return [stale, never];
});

scenario('a Threads-connected service: without an adapter nothing changes and the saga is not run; with a test adapter the order is Threads, then X', async () => {
  const none = setup([{ scenario: 'clean' }], { world: { threads: true }, xConnected: false });
  const refused = await withdraw(none.w, ACK);
  assert.equal(error(refused), 'PROVIDER_ADAPTER_MISSING');
  assert.equal(none.w.state.services.x_autopost, 'active');
  assert.equal(runs(none.standIn), 0);

  const s = setup([{ scenario: 'clean' }], { world: { threads: true }, xConnected: false });
  const adapter: ProviderCleanupAdapter = {
    provider: 'threads',
    hasConnection: () => Promise.resolve(s.w.state.threads),
    cleanup: () => { s.w.effects.push('provider:threads:cleanup'); s.w.state.threads = false; return Promise.resolve('local_removed_remote_unverified' as const); },
  };
  s.w.deps.providers = [adapter];
  const response = await withdraw(s.w, ACK);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, outcome: 'ended', providers: { threads: 'local_removed_remote_unverified', x: 'done' }, remote_unverified: ['threads'] });
  assert.ok(s.w.effects.indexOf('provider:threads:cleanup') < s.w.effects.indexOf('rpc:record_provider_result'), 'Threads is cleaned first');
  assert.deepEqual(s.standIn.records.map((r) => `${r.call}:${r.answered}`), ['preview:social_only/none', 'run:clean']);
  return [none, s];
});

scenario('lease and fence independence: a saga that is busy (the stand-in\'s in_progress) never holds F5\'s lease; a retry takes a new one with a higher fence', async () => {
  const s = setup([{ scenario: 'in_progress' }, { scenario: 'clean' }], { xConnected: false });
  const first = await withdraw(s.w);
  assert.equal(error(first), 'X_CLEANUP_IN_PROGRESS');
  assert.equal(s.w.state.svc?.lease, null);
  assert.equal(s.w.state.svc?.fence, 1);
  // a different device asks right away: F5's lease is free, the stand-in is asked again and now answers
  const second = await withdraw(s.w, {}, signIn());
  assert.equal(second.status, 200);
  assert.equal(s.w.state.svc?.fence, 2, 'the fence moved forward');
  assert.equal(s.w.state.svc?.status, 'completed');
  return s;
});

scenario('concurrent cleanup: while one end is inside the stand-in, a second request is told it is in progress and asks the stand-in nothing; the first ends once', async () => {
  const gate = deferred();
  const entered = deferred();
  const s = setup([{ scenario: 'clean' }], { xConnected: false, standIn: { onRun: async () => { entered.resolve(); await gate.promise; } } });
  const first = withdraw(s.w);
  await entered.promise;
  const second = await withdraw(s.w, {}, signIn());
  assert.deepEqual([second.status, error(second)], [409, 'DELETION_IN_PROGRESS']);
  assert.equal(runs(s.standIn), 0, 'the stand-in has not answered yet and was not asked a second time');
  gate.resolve();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(runs(s.standIn), 1);
  assert.equal(s.w.state.svc?.status, 'completed');
  // the third request after the end: the same answer, no new question to the stand-in
  const again = await withdraw(s.w);
  assert.equal(again.status, 200);
  assert.equal(bodyOf(again).outcome, 'already_ended');
  assert.equal(runs(s.standIn), 1, 'idempotent: the stand-in is not asked again');
  return s;
});

scenario('an expired lease and a rotated owner: the stale owner ends nothing when it wakes up, the second owner completes once, a stale completion is refused', async () => {
  const gate = deferred();
  const entered = deferred();
  let calls = 0;
  const s = setup([{ scenario: 'clean' }, { scenario: 'clean' }], {
    xConnected: false,
    standIn: { onRun: async () => { calls += 1; if (calls === 1) { entered.resolve(); await gate.promise; } } },
  });
  const staleLease = (): string | null => s.w.state.svc?.lease ?? null;
  const first = withdraw(s.w);
  await entered.promise;
  const oldLease = staleLease();
  assert.ok(oldLease);
  lose(s.w);   // the first owner's lease expires on the database clock while it waits inside the stand-in
  const second = await withdraw(s.w, {}, signIn());
  assert.equal(second.status, 200, 'the second owner took over and finished');
  assert.equal(s.w.state.svc?.fence, 2);
  const versionAtEnd = s.w.state.version;
  gate.resolve();
  const stale = await first;
  assert.deepEqual([stale.status, error(stale)], [409, 'DELETION_IN_PROGRESS'], 'the stale owner learns it lost the lease and stops');
  assert.equal(s.w.state.version, versionAtEnd, 'the entitlement was ended exactly once');
  assert.equal(s.w.effects.filter((e) => e === 'rpc:finish_owned_service').length, 1, 'only one completion was ever attempted');
  // a completion attempt with the old lease is refused by the database (fake answers as the SQL does)
  assert.deepEqual(s.w.answers.finish_owned_service({ p_user_id: USER, p_service_key: 'x_autopost', p_operation_id: s.w.state.svc?.id, p_lease: oldLease }), { status: 'lease_lost' });
  assert.equal(runs(s.standIn), 2, 'both owners asked the stand-in; only the current one could record and finish');
  return s;
});

scenario('repeat runs are identical: the same script over fresh worlds gives the same responses, effects and records', async () => {
  const play = async () => {
    const s = setup([{ scenario: 'blocked', reason: 'SHARED_WORKSPACE' }, { scenario: 'clean', unconfirmedPosts: 1 }], { xConnected: false, world: { threads: false } });
    const out = [await withdraw(s.w), await withdraw(s.w)];
    return JSON.stringify({ out, effects: s.w.effects, records: s.standIn.records });
  };
  assert.equal(await play(), await play());
});
