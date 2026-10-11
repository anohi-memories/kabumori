// E4 upper bound (Phase 3e, H2 R3): the last successful delay is a lower bound; a mitigation needs the configured
// expiry, a refused callback after it, request-duration and skew margins, a covering settle, a drain of started flows
// and an exclusive re-check in order.
import assert from 'node:assert/strict';
import test from 'node:test';

import { E4_REQUIRED_SEQUENCE, evaluateE4Bound, type E4BoundEvidence } from './e4_bound.ts';
import { completeBound } from './test_support.ts';

const reasons = (mutate: (b: E4BoundEvidence) => void) => { const b = completeBound(); mutate(b); return evaluateE4Bound(b); };
const expectReason = (reason: string, mutate: (b: E4BoundEvidence) => void, label = reason) => {
  const got = reasons(mutate);
  assert.ok(got.includes(reason), `${label}: expected ${reason}, got ${got.join(', ')}`);
};

test('a complete bound holds; no bound at all does not', () => {
  assert.deepEqual(evaluateE4Bound(completeBound()), []);
  assert.deepEqual(evaluateE4Bound(undefined), ['E4_BOUND_MISSING']);
});

test('the longest successful delay is only a lower bound: it can never stand in for the expiry', () => {
  // 600 s linked; "expiry 600" with a callback at 600 is not a callback AFTER the expiry.
  expectReason('E4_BOUND_NO_CALLBACK_AFTER_EXPIRY', (b) => { b.lastSuccessfulCallbackDelaySeconds = 600; b.configuredFlowExpirySeconds = 600; b.expiredCallbackAttemptDelaySeconds = 600; b.settleSeconds = 700; });
  // A configured "expiry" shorter than an observed successful link is contradicted.
  expectReason('E4_BOUND_CONTRADICTED_BY_OBSERVED_LINK', (b) => { b.lastSuccessfulCallbackDelaySeconds = 400; });
  expectReason('E4_BOUND_EXPIRED_CALLBACK_NOT_REJECTED', (b) => { b.expiredCallbackRejected = false; });
});

test('the settle must cover expiry + request duration + skew on both sides', () => {
  expectReason('E4_BOUND_SETTLE_TOO_SHORT', (b) => { b.settleSeconds = 319; });
  assert.deepEqual(reasons((b) => { b.settleSeconds = 320; }), []);
  expectReason('E4_BOUND_SETTLE_TOO_SHORT', (b) => { b.requestDurationMaxSeconds = 60; });
  expectReason('E4_BOUND_SETTLE_TOO_SHORT', (b) => { b.clockSkewMarginSeconds = 30; });
});

test('every number must be a real positive measurement; the version and source pinned', () => {
  for (const field of ['configuredFlowExpirySeconds', 'expiredCallbackAttemptDelaySeconds', 'requestDurationMaxSeconds', 'clockSkewMarginSeconds', 'settleSeconds'] as const) {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expectReason(`E4_BOUND_NOT_POSITIVE:${field}`, (b) => { b[field] = bad; }, `${field}=${bad}`);
  }
  expectReason('E4_BOUND_VERSION_NOT_PINNED', (b) => { b.gotrueVersion = 'latest'; });
  expectReason('E4_BOUND_EXPIRY_SOURCE', (b) => { (b as { configuredFlowExpirySource: string }).configuredFlowExpirySource = 'last_successful_delay'; });
});

test('disabling links does not cancel started flows: the drain and the exclusive re-check are required, in order', () => {
  expectReason('E4_BOUND_IN_FLIGHT_NOT_DRAINED', (b) => { b.inFlightDrainVerified = false; });
  expectReason('E4_BOUND_NO_EXCLUSIVE_RECHECK', (b) => { b.exclusiveRecheckVerified = false; });
  expectReason('E4_BOUND_SEQUENCE', (b) => { b.sequence = ['ban', 'revoke_sessions', 'drain', 'exclusive_recheck', 'admin_delete']; });
  expectReason('E4_BOUND_SEQUENCE', (b) => { b.sequence = E4_REQUIRED_SEQUENCE.filter((s) => s !== 'drain'); });
  expectReason('E4_BOUND_NO_EVIDENCE', (b) => { b.evidence = []; });
});
