// The X / Threads reservation stores, as the reservations screen sees them (G1 TASK 30 / 31).
//
// The stores themselves are G3's (apps/social-mobile/src/features/schedule/). This file holds only the SHAPE of the part
// of their public contract the screen uses; live-reservation-ports.ts assigns G3's real stores to it, so tsc proves the
// shapes match. It contains no store logic.

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
  /** G3's reservationErrorAction; anything it does not know is 'check'. */
  actionOf: (code: string) => ReservationAction;
};
