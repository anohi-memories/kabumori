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
import { createLiveReservationStore, type LiveReservationDeps } from './live-reservation-store.ts';

export const POSTONA_RESERVATION_PERSISTENCE_ENABLED = false as const;

export type StoreResult<T> = { ok: true; value: T } | { ok: false; code: string };

export type ReservationStore = {
  readonly enabled: boolean;
  save(request: SaveRequest): Promise<SaveOutcome>;
  list(socialAccountId: string): Promise<StoreResult<ServerReservation[]>>;
  get(reservationId: string): Promise<StoreResult<ServerReservation>>;
  reschedule(reservationId: string, expectedRevision: number, scheduledAt: string): Promise<StoreResult<ServerReservation>>;
  reconfirm(reservationId: string, expectedRevision: number, contentSha256: string): Promise<StoreResult<ServerReservation>>;
  cancel(reservationId: string, expectedRevision: number): Promise<StoreResult<ServerReservation>>;
};

const NOT_AVAILABLE = 'NOT_AVAILABLE';

/** The only store this build can construct: no network, no storage, always NOT_AVAILABLE. */
export const DISABLED_RESERVATION_STORE: ReservationStore = Object.freeze({
  enabled: false,
  save: () => Promise.resolve({ kind: 'not_available' } as const),
  list: () => Promise.resolve({ ok: false as const, code: NOT_AVAILABLE }),
  get: () => Promise.resolve({ ok: false as const, code: NOT_AVAILABLE }),
  reschedule: () => Promise.resolve({ ok: false as const, code: NOT_AVAILABLE }),
  reconfirm: () => Promise.resolve({ ok: false as const, code: NOT_AVAILABLE }),
  cancel: () => Promise.resolve({ ok: false as const, code: NOT_AVAILABLE }),
});

/**
 * Returns the store for this build. With the release gate OFF (the source constant) it is the disabled store,
 * whatever is passed. Only with the gate ON AND a live Supabase client (URL + session) is the live store
 * (live-reservation-store.ts -> the postona-x-reservations function) built -- flipping the constant is a reviewed
 * rollout step that also needs the deployed function, the G5 / G4 decisions, a Sol review and user approval.
 */
export function createReservationStore(gate: boolean = POSTONA_RESERVATION_PERSISTENCE_ENABLED, live: LiveReservationDeps | null = null): ReservationStore {
  if (gate !== true || !live) return DISABLED_RESERVATION_STORE;
  return createLiveReservationStore(live);
}
