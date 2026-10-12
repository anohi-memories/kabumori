/**
 * The live reservation store: the remote store wired to the real transport and the real session (F3 SOURCE
 * CANDIDATE). Constructed ONLY by createReservationStore() when the source release gate is true -- it is false,
 * so no app build reaches this today.
 *
 *   transport  -> HTTPS POST {SUPABASE_URL}/functions/v1/postona-x-reservations (not deployed yet)
 *   token      -> the CURRENT session's access token from the app's Supabase client (auto-refreshed by the
 *                 client); no session -> nothing is sent. The server verifies it live with Auth on every call.
 * No service-role key, no stored credential and no user id ever leave the device; the token is never logged.
 */
import { createFetchTransport, createRemoteReservationStore, type RemoteReservationStore } from './remote-reservation-store.ts';

export const RESERVATION_FUNCTION_PATH = '/functions/v1/postona-x-reservations';

/** The part of the Supabase client used here. */
export type SessionSource = {
  auth: { getSession(): Promise<{ data: { session: { access_token?: string | null } | null }; error: unknown }> };
};

export type LiveReservationDeps = { supabaseUrl: string; session: SessionSource; fetch?: typeof fetch };

/** The current access token, or null when there is no usable session (the store then sends nothing). */
export function accessTokenFrom(source: SessionSource): () => Promise<string | null> {
  return async () => {
    const { data, error } = await source.auth.getSession();
    if (error) return null;
    const token = data.session?.access_token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  };
}

export function createLiveReservationStore(deps: LiveReservationDeps): RemoteReservationStore {
  const base = new URL(deps.supabaseUrl);
  if (base.protocol !== 'https:') throw new Error('SUPABASE_URL_MUST_BE_HTTPS');
  return createRemoteReservationStore({
    transport: createFetchTransport({ url: `${base.origin}${RESERVATION_FUNCTION_PATH}`, fetch: deps.fetch ?? fetch }),
    getAccessToken: accessTokenFrom(deps.session),
  });
}
