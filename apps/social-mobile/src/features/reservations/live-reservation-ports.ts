// The screen's ports over G3's real stores (G1 TASK 31). G3 owns the stores, the gates and the code -> action table; this
// file only hands them the person's client. A gate that is not `true`, or no client, is G3's disabled store: no network.
import { reservationErrorAction } from '../schedule/reservation-error-actions.ts';
import { createReservationStore } from '../schedule/reservation-store.ts';
import type { LiveReservationDeps } from '../schedule/live-reservation-store.ts';
import { createThreadsReservationStore } from '../schedule/remote-threads-reservation-store.ts';
import type { ReservationPorts } from './reservation-ports.ts';

export type ReservationGates = { x: boolean; threads: boolean };

export function buildReservationPorts(gates: ReservationGates, live: LiveReservationDeps | null): ReservationPorts {
  return {
    x: createReservationStore(gates.x, live),
    threads: createThreadsReservationStore(gates.threads, live),
    actionOf: reservationErrorAction,
  };
}
