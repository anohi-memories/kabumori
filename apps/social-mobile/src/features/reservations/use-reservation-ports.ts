import * as Crypto from 'expo-crypto';
import { DISABLED_RESERVATION_PORTS, type ReservationPorts } from '@/features/reservations/reservation-ports';

/**
 * The reservations screen's only way to the stores. The release gates are OFF and G3's stores are not on this branch,
 * so it is the disabled ports: nothing is sent. Wiring G3's createReservationStore / createThreadsReservationStore
 * (with the client's publishable key) and reservationErrorAction happens here, and only here, after the G3 stack is
 * merged and the gates are approved.
 */
export function useReservationPorts(): ReservationPorts {
  return DISABLED_RESERVATION_PORTS;
}

/** A new id for one Threads create (one press); the same id is only ever used to read or cancel that request. */
export function newClientRequestId(): string {
  return Crypto.randomUUID();
}

/** SHA-256 (hex, UTF-8) of a post's text: the same digest G3's sha256Hex gives. */
export function contentSha256(text: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);
}
