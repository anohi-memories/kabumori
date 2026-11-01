/**
 * What the screen should offer for a reservation store code (G3-02 #5; X and Threads). The codes are the ones the G3 entries answer on
 * the real local Supabase runtime (supabase/candidates/postona_reservations_rollout/README.md, "HTTP contract"), plus the stores' own
 * AUTH_REQUIRED / RATE_LIMITED / UNCERTAIN / NOT_AVAILABLE. Anything not listed is `check`: read again before deciding, never assume
 * success and never re-send blindly.
 */
export type ReservationErrorAction =
  | 'sign_in' //        401: the session is gone, expired or anonymous -> sign in again
  | 'start_service' //  403 the POSTONA service is not active -> start (or restart) it
  | 'reconnect_x' //    403 the X account is not verified -> reconnect X
  | 'reconnect_threads'
  | 'not_available' //  the feature is not available now (gate OFF, Threads publish-disabled by U8, the brand / AI not eligible)
  | 'reload' //         409 the row changed (stale revision) or the batch id was reused with another content -> read again
  | 'final' //          409 the row is already final / no longer plannable / too late -> show it as it is
  | 'not_found' //      404 not the caller's, or gone (one answer: no oracle)
  | 'fix_input' //      422 / 409 slot or capacity: the request itself must change
  | 'retry_later' //    nothing was written; the server is busy or rate-limited
  | 'check'; //         the outcome is unknown: read again (list / get / receipt), never re-send blindly

const BY_CODE: Record<string, ReservationErrorAction> = {
  AUTH_REQUIRED: 'sign_in',
  POSTONA_RESV_AUTH_REQUIRED: 'sign_in',
  POSTONA_RESV_SERVICE_NOT_ACTIVE: 'start_service',
  POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE: 'start_service',
  POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED: 'reconnect_x',
  POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED: 'reconnect_threads',
  NOT_AVAILABLE: 'not_available',
  NOT_CONFIGURED: 'not_available',
  POSTONA_THREADS_RESV_PUBLISH_DISABLED: 'not_available',
  POSTONA_RESV_BRAND_NOT_ELIGIBLE: 'not_available',
  POSTONA_RESV_AI_NOT_OPTED_IN: 'not_available',
  POSTONA_RESV_STALE_REVISION: 'reload',
  POSTONA_RESV_IDEMPOTENCY_CONFLICT: 'reload',
  POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT: 'reload',
  POSTONA_RESV_ALREADY_FINAL: 'final',
  POSTONA_RESV_NOT_PLANNED: 'final',
  POSTONA_RESV_CANCEL_TOO_LATE: 'final',
  POSTONA_THREADS_RESV_NOT_CANCELLABLE: 'final',
  POSTONA_RESV_NOT_FOUND: 'not_found',
  POSTONA_RESV_ACCOUNT_NOT_FOUND: 'not_found',
  POSTONA_THREADS_RESV_NOT_FOUND: 'not_found',
  POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND: 'not_found',
  POSTONA_RESV_SLOT_CONFLICT: 'fix_input',
  POSTONA_RESV_DAILY_CAPACITY: 'fix_input',
  POSTONA_RESV_MONTHLY_CAPACITY: 'fix_input',
  REQUEST_INVALID: 'fix_input',
  REQUEST_TOO_LARGE: 'fix_input',
  POSTONA_RESV_REQUEST_INVALID: 'fix_input',
  POSTONA_RESV_ITEM_INVALID: 'fix_input',
  POSTONA_RESV_TIME_OUT_OF_RANGE: 'fix_input',
  POSTONA_RESV_OUTSIDE_BAND: 'fix_input',
  POSTONA_RESV_BAND_REQUIRED: 'fix_input',
  POSTONA_RESV_TEXT_INVALID: 'fix_input',
  POSTONA_RESV_CONSENT_REQUIRED: 'fix_input',
  POSTONA_RESV_AI_TEXT_NOT_ALLOWED: 'fix_input',
  POSTONA_RESV_INTERVAL_INVALID: 'fix_input',
  POSTONA_RESV_INTERVAL_MISMATCH: 'fix_input',
  POSTONA_THREADS_RESV_REQUEST_INVALID: 'fix_input',
  POSTONA_THREADS_RESV_TEXT_INVALID: 'fix_input',
  POSTONA_THREADS_RESV_CONSENT_REQUIRED: 'fix_input',
  POSTONA_THREADS_RESV_SCHEDULE_INVALID: 'fix_input',
  POSTONA_RESV_SERVICE_BUSY: 'retry_later',
  AUTH_UNAVAILABLE: 'retry_later',
  PERMISSION_UNAVAILABLE: 'retry_later',
  RATE_LIMITED: 'retry_later',
};

export function reservationErrorAction(code: string): ReservationErrorAction {
  return Object.prototype.hasOwnProperty.call(BY_CODE, code) ? BY_CODE[code] : 'check';
}
