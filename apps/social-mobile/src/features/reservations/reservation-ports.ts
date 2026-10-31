// The X / Threads reservation stores, as the reservations screen sees them (G1 TASK 30).
//
// The stores themselves are G3's (apps/social-mobile/src/features/schedule/reservation-store.ts,
// remote-threads-reservation-store.ts and reservation-error-actions.ts on the G3 stack, PR #601 2a02fcbd; not on this
// branch). This file holds only the SHAPE of their public contract (G3 handoff 6536788017), so the screen can be built
// and tested before the G3 stack reaches main, and a type check against G3's real files proves the shapes match.
// It contains no store logic. Until G3's stores are wired here (one adapter, after the G3 merge and the release gates),
// the only ports this build has are the disabled ones below: no network, no storage, every call NOT_AVAILABLE --
// the same answers as G3's DISABLED_RESERVATION_STORE / DISABLED_THREADS_RESERVATION_STORE.

export type StoreResult<T> = { ok: true; value: T } | { ok: false; code: string };

/** G3 domain/reservation-flow.ts ServerReservation (display fields optional). */
export type ServerReservation = {
  reservationId: string;
  draftId: string;
  scheduledAt: string;
  status: 'planned' | 'claimed' | 'published' | 'failed' | 'uncertain' | 'cancelled' | 'expired';
  revision: number;
  consentState: 'confirmed' | 'needs_reconfirm' | 'ai_owner_opt_in';
  batchId?: string;
  body?: string | null;
  mode?: string;
  origin?: string;
};

/** The X store's edits and reads (G3 ReservationStore without `save`: X reservations are made in the schedule composer). */
export type XReservationPort = {
  readonly enabled: boolean;
  list(socialAccountId: string): Promise<StoreResult<ServerReservation[]>>;
  get(reservationId: string): Promise<StoreResult<ServerReservation>>;
  reschedule(reservationId: string, expectedRevision: number, scheduledAt: string): Promise<StoreResult<ServerReservation>>;
  reconfirm(reservationId: string, expectedRevision: number, contentSha256: string): Promise<StoreResult<ServerReservation>>;
  cancel(reservationId: string, expectedRevision: number): Promise<StoreResult<ServerReservation>>;
};

export type ThreadsReceiptState = 'sent' | 'failed' | 'cancelled' | 'pending' | 'uncertain';
export type ThreadsReceipt = {
  reservationId: string;
  state: ThreadsReceiptState;
  providerPostId: string | null;
  outcomeCode: string | null;
  afterFreeze: boolean;
  simulated: boolean;
};
export type ThreadsCreateRequest = { socialAccountId: string; clientRequestId: string; text: string; contentSha256: string; scheduledAt: string };
export type ThreadsSaveOutcome =
  | { kind: 'saved'; receipt: ThreadsReceipt }
  | { kind: 'not_available' }
  | { kind: 'failed'; code: string }
  | { kind: 'uncertain'; code: string };

/** G3 ThreadsReservationStore. */
export type ThreadsReservationPort = {
  readonly enabled: boolean;
  create(request: ThreadsCreateRequest): Promise<ThreadsSaveOutcome>;
  cancel(reservationId: string, socialAccountId: string, clientRequestId: string): Promise<StoreResult<ThreadsReceipt>>;
  receipt(socialAccountId: string, clientRequestId: string): Promise<StoreResult<ThreadsReceipt>>;
};

/** G3 reservation-error-actions.ts ReservationErrorAction: what the screen may offer for a store code. */
export type ReservationAction =
  | 'sign_in'
  | 'start_service'
  | 'reconnect_x'
  | 'reconnect_threads'
  | 'not_available'
  | 'reload'
  | 'final'
  | 'not_found'
  | 'fix_input'
  | 'retry_later'
  | 'check';

export type ReservationPorts = {
  x: XReservationPort;
  threads: ThreadsReservationPort;
  /** G3's reservationErrorAction once wired; anything it does not know is 'check'. */
  actionOf: (code: string) => ReservationAction;
};

const NOT_AVAILABLE = 'NOT_AVAILABLE';
const refused = () => Promise.resolve({ ok: false as const, code: NOT_AVAILABLE });

/**
 * The ports of this build: the release gates are OFF, so nothing is sent and nothing can be saved. Only the code the
 * disabled ports answer is known here; every other code is 'check' (read again, never success, never a blind re-send).
 */
export const DISABLED_RESERVATION_PORTS: ReservationPorts = Object.freeze({
  x: Object.freeze({ enabled: false, list: refused, get: refused, reschedule: refused, reconfirm: refused, cancel: refused }),
  threads: Object.freeze({
    enabled: false,
    create: () => Promise.resolve({ kind: 'not_available' } as const),
    cancel: refused,
    receipt: refused,
  }),
  actionOf: (code: string): ReservationAction => (code === NOT_AVAILABLE ? 'not_available' : 'check'),
});
