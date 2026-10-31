// G3-02 #5: every code the G3 reservation entries answer (as measured on the real local Supabase runtime) maps to what the screen offers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reservationErrorAction } from '../src/features/schedule/reservation-error-actions.ts';

test('the codes the screen must route', () => {
  const cases = {
    sign_in: ['AUTH_REQUIRED', 'POSTONA_RESV_AUTH_REQUIRED'],
    start_service: ['POSTONA_RESV_SERVICE_NOT_ACTIVE', 'POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE'],
    reconnect_x: ['POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED'],
    reconnect_threads: ['POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED'],
    not_available: ['NOT_AVAILABLE', 'NOT_CONFIGURED', 'POSTONA_THREADS_RESV_PUBLISH_DISABLED', 'POSTONA_RESV_BRAND_NOT_ELIGIBLE'],
    reload: ['POSTONA_RESV_STALE_REVISION', 'POSTONA_RESV_IDEMPOTENCY_CONFLICT', 'POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT'],
    final: ['POSTONA_RESV_ALREADY_FINAL', 'POSTONA_RESV_NOT_PLANNED', 'POSTONA_RESV_CANCEL_TOO_LATE', 'POSTONA_THREADS_RESV_NOT_CANCELLABLE'],
    not_found: ['POSTONA_RESV_NOT_FOUND', 'POSTONA_RESV_ACCOUNT_NOT_FOUND', 'POSTONA_THREADS_RESV_NOT_FOUND', 'POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND'],
    fix_input: ['POSTONA_RESV_SLOT_CONFLICT', 'POSTONA_RESV_CONSENT_REQUIRED', 'POSTONA_RESV_TIME_OUT_OF_RANGE', 'REQUEST_INVALID', 'POSTONA_THREADS_RESV_SCHEDULE_INVALID'],
    retry_later: ['RATE_LIMITED', 'POSTONA_RESV_SERVICE_BUSY', 'AUTH_UNAVAILABLE'],
  };
  for (const [action, codes] of Object.entries(cases)) for (const code of codes) assert.equal(reservationErrorAction(code), action, code);
});

test('unknown outcomes and anything unlisted are `check` (read again; never success, never a blind re-send)', () => {
  for (const code of ['UNCERTAIN', 'STORE_UNAVAILABLE', 'INTERNAL', 'DB_ERROR', 'SOMETHING_NEW', '', 'toString', '__proto__', 'constructor']) {
    assert.equal(reservationErrorAction(code), 'check', code);
  }
});
