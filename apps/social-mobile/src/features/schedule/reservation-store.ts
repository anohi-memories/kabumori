/**
 * POSTONA X reservation store (client side). Release gate: OFF.
 *
 * The server candidate (supabase/candidates/postona_x_reservations/) is NOT applied anywhere and exposes no
 * API endpoint; its G5 (x_autopost entitlement / lifecycle) and G4 (verified X account, Issue #131) predicates
 * deny everything until reviewed implementations exist. Until a separately approved rollout flips this
 * constant in source, every call answers NOT_AVAILABLE without touching the network, and the schedule tab
 * keeps every plan a preview.
 */
import type { SaveOutcome, SaveRequest, ServerReservation } from '@/domain/reservation-flow';

export const POSTONA_RESERVATION_PERSISTENCE_ENABLED = false as const;

export type StoreResult<T> = { ok: true; value: T } | { ok: false; code: string };

export type ReservationStore = {
  readonly enabled: boolean;
  save(request: SaveRequest): Promise<SaveOutcome>;
  list(socialAccountId: string): Promise<StoreResult<ServerReservation[]>>;
  cancel(reservationId: string, expectedRevision: number): Promise<StoreResult<ServerReservation>>;
};

const NOT_AVAILABLE = 'NOT_AVAILABLE';

/** The only store this build can construct: no network, no storage, always NOT_AVAILABLE. */
export const DISABLED_RESERVATION_STORE: ReservationStore = Object.freeze({
  enabled: false,
  save: () => Promise.resolve({ kind: 'not_available' } as const),
  list: () => Promise.resolve({ ok: false as const, code: NOT_AVAILABLE }),
  cancel: () => Promise.resolve({ ok: false as const, code: NOT_AVAILABLE }),
});

/**
 * Returns the store for this build. With the release gate OFF it is the disabled store, whatever is passed;
 * a remote implementation is added only together with the reviewed server rollout.
 */
export function createReservationStore(gate: boolean = POSTONA_RESERVATION_PERSISTENCE_ENABLED): ReservationStore {
  if (gate !== true) return DISABLED_RESERVATION_STORE;
  // Reaching here means the constant was flipped without the reviewed remote implementation: fail closed.
  return DISABLED_RESERVATION_STORE;
}
