/**
 * Remote POSTONA Threads reservation store: the client side of postona-threads-reservations (G3 SOURCE CANDIDATE, G3-02 #5). Release
 * gate: OFF -- `createThreadsReservationStore()` returns the disabled store whatever is passed; tests inject a transport.
 *
 * Truth is always a SEPARATE receipt read, never the answer to the write itself:
 *   create  -> (idempotent on socialAccountId + clientRequestId) -> receipt -> 'pending' => saved; an explicit refusal => failed;
 *              anything unknown => uncertain (the SAME clientRequestId may be sent again: the server answers the stored row);
 *   cancel  -> receipt -> 'cancelled' => ok.
 * While G4's U8 holds, create is refused with POSTONA_THREADS_RESV_PUBLISH_DISABLED (reservation-error-actions.ts: not available):
 * never shown as saved. A receipt in state 'uncertain' may have reached Threads: show "check Threads", never create again.
 */
import { createFetchTransport, refusalOf, type TransportResponse, UNCERTAIN } from './remote-reservation-store.ts';
import type { SessionSource } from './live-reservation-store.ts';
import { accessTokenFrom } from './live-reservation-store.ts';

export const POSTONA_THREADS_RESERVATION_PERSISTENCE_ENABLED = false as const;
export const THREADS_RESERVATION_FUNCTION_PATH = '/functions/v1/postona-threads-reservations';

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
export type ThreadsStoreResult<T> = { ok: true; value: T } | { ok: false; code: string };

export type ThreadsReservationStore = {
  readonly enabled: boolean;
  create(request: ThreadsCreateRequest): Promise<ThreadsSaveOutcome>;
  cancel(reservationId: string, socialAccountId: string, clientRequestId: string): Promise<ThreadsStoreResult<ThreadsReceipt>>;
  receipt(socialAccountId: string, clientRequestId: string): Promise<ThreadsStoreResult<ThreadsReceipt>>;
};

type ThreadsAction = 'create' | 'cancel' | 'receipt';
export type ThreadsTransport = (call: { action: ThreadsAction; payload: Record<string, unknown> }, accessToken: string) => Promise<TransportResponse>;

const NOT_AVAILABLE = 'NOT_AVAILABLE';
const STATES: readonly ThreadsReceiptState[] = ['sent', 'failed', 'cancelled', 'pending', 'uncertain'];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The only Threads store a gate-OFF build constructs: no network, always NOT_AVAILABLE. */
export const DISABLED_THREADS_RESERVATION_STORE: ThreadsReservationStore = Object.freeze({
  enabled: false,
  create: () => Promise.resolve({ kind: 'not_available' } as const),
  cancel: () => Promise.resolve({ ok: false as const, code: NOT_AVAILABLE }),
  receipt: () => Promise.resolve({ ok: false as const, code: NOT_AVAILABLE }),
});

function parseReceipt(value: unknown): ThreadsReceipt | null {
  if (!isObject(value)) return null;
  const { reservationId, state, providerPostId, outcomeCode, afterFreeze, simulated } = value;
  if (typeof reservationId !== 'string' || !STATES.includes(state as ThreadsReceiptState)) return null;
  if (providerPostId !== null && typeof providerPostId !== 'string') return null;
  if (outcomeCode !== null && typeof outcomeCode !== 'string') return null;
  if (typeof afterFreeze !== 'boolean' || typeof simulated !== 'boolean') return null;
  return { reservationId, state: state as ThreadsReceiptState, providerPostId, outcomeCode, afterFreeze, simulated };
}

export function createRemoteThreadsReservationStore(input: { transport: ThreadsTransport; getAccessToken: () => Promise<string | null> }): ThreadsReservationStore {
  type Answer = { ok: true; body: Record<string, unknown> } | { ok: false; code: string; definite: boolean };
  async function call(action: ThreadsAction, payload: Record<string, unknown>): Promise<Answer> {
    let token: string | null;
    try {
      token = await input.getAccessToken();
    } catch {
      token = null;
    }
    if (!token) return { ok: false, code: 'AUTH_REQUIRED', definite: true };
    let response: TransportResponse;
    try {
      response = await input.transport({ action, payload }, token);
    } catch {
      return { ok: false, code: UNCERTAIN, definite: false };
    }
    if (response.status === 200 && isObject(response.body) && response.body.ok === true) return { ok: true, body: response.body };
    return { ok: false, ...refusalOf(response) };
  }
  async function receipt(socialAccountId: string, clientRequestId: string): Promise<ThreadsStoreResult<ThreadsReceipt>> {
    const answer = await call('receipt', { socialAccountId, clientRequestId });
    if (!answer.ok) return { ok: false, code: answer.code };
    const parsed = parseReceipt(answer.body.receipt);
    return parsed ? { ok: true, value: parsed } : { ok: false, code: UNCERTAIN };
  }
  return {
    enabled: true,
    async create(request) {
      const created = await call('create', { ...request });
      if (!created.ok && created.definite) return created.code === NOT_AVAILABLE ? { kind: 'not_available' } : { kind: 'failed', code: created.code };
      // The write's own answer is never enough: the receipt decides.
      const read = await receipt(request.socialAccountId, request.clientRequestId);
      if (read.ok && read.value.state === 'pending') return { kind: 'saved', receipt: read.value };
      if (read.ok && created.ok) return { kind: 'failed', code: `READ_BACK_${read.value.state.toUpperCase()}` };
      return { kind: 'uncertain', code: UNCERTAIN };
    },
    async cancel(reservationId, socialAccountId, clientRequestId) {
      const written = await call('cancel', { reservationId });
      if (!written.ok && written.definite) return { ok: false, code: written.code };
      const read = await receipt(socialAccountId, clientRequestId);
      if (read.ok && read.value.reservationId === reservationId && read.value.state === 'cancelled') return read;
      return { ok: false, code: UNCERTAIN };
    },
    receipt,
  };
}

export type LiveThreadsReservationDeps = { supabaseUrl: string; session: SessionSource; publishableKey?: string; fetch?: typeof fetch };

/** Gate OFF (the source constant): the disabled store, whatever is passed. Gate ON + a live client: the live store (a reviewed step). */
export function createThreadsReservationStore(
  gate: boolean = POSTONA_THREADS_RESERVATION_PERSISTENCE_ENABLED,
  live: LiveThreadsReservationDeps | null = null,
): ThreadsReservationStore {
  if (gate !== true || !live) return DISABLED_THREADS_RESERVATION_STORE;
  const base = new URL(live.supabaseUrl);
  if (base.protocol !== 'https:') throw new Error('SUPABASE_URL_MUST_BE_HTTPS');
  return createRemoteThreadsReservationStore({
    transport: createFetchTransport({ url: `${base.origin}${THREADS_RESERVATION_FUNCTION_PATH}`, fetch: live.fetch ?? fetch, apiKey: live.publishableKey }) as ThreadsTransport,
    getAccessToken: accessTokenFrom(live.session),
  });
}
