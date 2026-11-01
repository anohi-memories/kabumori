import * as Crypto from 'expo-crypto';
import { useMemo } from 'react';
import { buildReservationPorts } from '@/features/reservations/live-reservation-ports';
import type { ReservationPorts } from '@/features/reservations/reservation-ports';
import { POSTONA_THREADS_RESERVATION_PERSISTENCE_ENABLED } from '@/features/schedule/remote-threads-reservation-store';
import { POSTONA_RESERVATION_PERSISTENCE_ENABLED } from '@/features/schedule/reservation-store';
import { getSupabaseConfig, supabase } from '@/lib/supabase';

/**
 * The reservations screen's only way to the stores: G3's real X / Threads stores with the person's client. Their release
 * gates are G3's source constants and are OFF, so these are G3's disabled stores and nothing is sent; turning them on is
 * a separately approved rollout step, never this file.
 */
export function useReservationPorts(): ReservationPorts {
  return useMemo(() => {
    const config = getSupabaseConfig();
    const live = supabase && config.ok ? { supabaseUrl: config.config.url, session: supabase, publishableKey: config.config.publishableKey } : null;
    return buildReservationPorts({ x: POSTONA_RESERVATION_PERSISTENCE_ENABLED, threads: POSTONA_THREADS_RESERVATION_PERSISTENCE_ENABLED }, live);
  }, []);
}

/** A new id for one Threads create (one press); the same id is only ever used to read or cancel that request. */
export function newClientRequestId(): string {
  return Crypto.randomUUID();
}

/** SHA-256 (hex, UTF-8) of a post's text: the same digest G3's sha256Hex gives. */
export function contentSha256(text: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);
}
