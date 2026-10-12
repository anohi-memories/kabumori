/**
 * Remote POSTONA X reservation store: the client side of the reservation API candidate
 * (supabase/functions/_shared/postona_reservations/api.ts). NOT constructed by the app while the release gate is
 * OFF (`createReservationStore()` returns the disabled store); tests inject a transport.
 *
 * Truth is always a SEPARATE server read-back, never the answer to the write itself:
 *   save       -> create (idempotent on clientBatchId + revision) -> list -> every item planned at its time with
 *                 its consent => 'saved'; an explicit refusal => 'failed'; anything unknown => 'uncertain'
 *                 (the same request can be sent again safely: the server returns the stored rows);
 *   reschedule / reconfirm / cancel (CAS on the row revision) -> get -> the change is visible => ok.
 * A refusal (4xx with a fixed code) means nothing was written. A network error, a 5xx or a malformed answer
 * means the outcome is unknown and is reported as such -- never as success.
 */
import { verifySavedByReadBack, type SaveOutcome, type SaveRequest, type ServerReservation } from '../../domain/reservation-flow.ts';
import type { ReservationStore, StoreResult } from './reservation-store.ts';

export type ReservationApiAction = 'create' | 'list' | 'get' | 'reschedule' | 'reconfirm' | 'cancel';
export type TransportCall = { action: ReservationApiAction; payload: Record<string, unknown> };
export type TransportResponse = { status: number; body: unknown };
/** Sends one call with the user's access token. Throws (or rejects) when the outcome is unknown. */
export type ReservationTransport = (call: TransportCall, accessToken: string) => Promise<TransportResponse>;

/** The store's code for "the server may or may not have applied it": the UI must reload, never assume. */
export const UNCERTAIN = 'UNCERTAIN';

const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const STATUSES: readonly ServerReservation['status'][] = ['planned', 'claimed', 'published', 'failed', 'uncertain', 'cancelled', 'expired'];
const CONSENTS: readonly ServerReservation['consentState'][] = ['confirmed', 'needs_reconfirm', 'ai_owner_opt_in'];

type ApiResult = { ok: true; rows: ServerReservation[] } | { ok: false; code: string; definite: boolean };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseRow(value: unknown): ServerReservation | null {
  if (!isObject(value)) return null;
  const { reservationId, batchId, draftId, scheduledAt, status, revision, consentState, body, mode, origin } = value;
  if (typeof reservationId !== 'string' || typeof batchId !== 'string' || typeof draftId !== 'string') return null;
  if (typeof scheduledAt !== 'string' || !Number.isFinite(Date.parse(scheduledAt))) return null;
  if (!STATUSES.includes(status as ServerReservation['status']) || !CONSENTS.includes(consentState as ServerReservation['consentState'])) return null;
  if (!Number.isInteger(revision) || (revision as number) < 1) return null;
  if (body !== null && typeof body !== 'string') return null;
  if (typeof mode !== 'string' || typeof origin !== 'string') return null;
  return {
    reservationId, batchId, draftId, scheduledAt, body, mode, origin,
    status: status as ServerReservation['status'],
    revision: revision as number,
    consentState: consentState as ServerReservation['consentState'],
  };
}

/** For each requested draft, the planned row wins over older rows of the same draft (e.g. a cancelled one). */
function rowsForRequest(request: SaveRequest, rows: ServerReservation[]): ServerReservation[] {
  const wanted = new Set(request.items.map((item) => item.draft_id));
  const relevant = rows.filter((row) => wanted.has(row.draftId));
  return [...relevant.filter((row) => row.status !== 'planned'), ...relevant.filter((row) => row.status === 'planned')];
}

export type RemoteReservationStore = ReservationStore;

export function createRemoteReservationStore(input: {
  transport: ReservationTransport;
  getAccessToken: () => Promise<string | null>;
}): RemoteReservationStore {
  async function call(action: ReservationApiAction, payload: Record<string, unknown>): Promise<ApiResult> {
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
    const body = response.body;
    if (response.status === 200 && isObject(body) && body.ok === true && Array.isArray(body.reservations)) {
      const rows = body.reservations.map(parseRow);
      if (rows.some((row) => row === null)) return { ok: false, code: UNCERTAIN, definite: false };
      return { ok: true, rows: rows as ServerReservation[] };
    }
    const code = isObject(body) && typeof body.code === 'string' && CODE_RE.test(body.code) ? body.code : UNCERTAIN;
    // Only an explicit 4xx refusal with a fixed code proves nothing was written.
    const definite = response.status >= 400 && response.status < 500 && code !== UNCERTAIN;
    return { ok: false, code, definite };
  }

  async function readOne(reservationId: string): Promise<ServerReservation | null> {
    const back = await call('get', { reservationId });
    return back.ok && back.rows.length === 1 && back.rows[0].reservationId === reservationId ? back.rows[0] : null;
  }

  async function mutate(action: 'reschedule' | 'reconfirm' | 'cancel', payload: Record<string, unknown>, reservationId: string,
    applied: (row: ServerReservation) => boolean): Promise<StoreResult<ServerReservation>> {
    const written = await call(action, payload);
    if (!written.ok && written.definite) return { ok: false, code: written.code };
    const row = await readOne(reservationId);
    if (row && applied(row)) return { ok: true, value: row };
    // Written but not visible, or unknown and not visible: the user must look again before deciding.
    return { ok: false, code: UNCERTAIN };
  }

  return {
    enabled: true,
    async save(request: SaveRequest): Promise<SaveOutcome> {
      const created = await call('create', {
        socialAccountId: request.socialAccountId,
        clientBatchId: request.clientBatchId,
        revision: request.revision,
        mode: request.mode,
        band: request.band,
        items: request.items,
      });
      if (!created.ok && created.definite) return { kind: 'failed', code: created.code };
      // The write's own answer is never enough: an independent read-back decides.
      const readBack = await call('list', { socialAccountId: request.socialAccountId });
      if (!readBack.ok) return { kind: 'uncertain', code: UNCERTAIN };
      const verdict = verifySavedByReadBack(request, rowsForRequest(request, readBack.rows));
      if (verdict.kind === 'saved') return verdict;
      return created.ok ? { kind: 'failed', code: verdict.kind === 'failed' ? verdict.code : UNCERTAIN } : { kind: 'uncertain', code: UNCERTAIN };
    },
    async list(socialAccountId: string) {
      const result = await call('list', { socialAccountId });
      return result.ok ? { ok: true as const, value: result.rows } : { ok: false as const, code: result.code };
    },
    async get(reservationId: string) {
      const result = await call('get', { reservationId });
      if (!result.ok) return { ok: false as const, code: result.code };
      const row = result.rows.length === 1 && result.rows[0].reservationId === reservationId ? result.rows[0] : null;
      return row ? { ok: true as const, value: row } : { ok: false as const, code: UNCERTAIN };
    },
    reschedule(reservationId: string, expectedRevision: number, scheduledAt: string) {
      const target = new Date(scheduledAt).getTime();
      return mutate('reschedule', { reservationId, expectedRevision, scheduledAt }, reservationId,
        (row) => row.status === 'planned' && row.revision > expectedRevision && new Date(row.scheduledAt).getTime() === target);
    },
    reconfirm(reservationId: string, expectedRevision: number, contentSha256: string) {
      return mutate('reconfirm', { reservationId, expectedRevision, contentSha256 }, reservationId,
        (row) => row.status === 'planned' && row.revision === expectedRevision && row.consentState === 'confirmed');
    },
    cancel(reservationId: string, expectedRevision: number) {
      return mutate('cancel', { reservationId, expectedRevision }, reservationId, (row) => row.status === 'cancelled');
    },
  };
}

/**
 * HTTPS transport for the (future, registered) reservation API. Not used while the gate is OFF. No redirects,
 * a hard timeout, and a non-JSON answer is returned as `body: null` (the store treats it as unknown).
 */
export function createFetchTransport(input: { url: string; fetch: typeof fetch; timeoutMs?: number }): ReservationTransport {
  const url = new URL(input.url);
  if (url.protocol !== 'https:') throw new Error('RESERVATION_API_URL_MUST_BE_HTTPS');
  const timeoutMs = input.timeoutMs ?? 15000;
  return async (call, accessToken) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await input.fetch(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(call),
        redirect: 'error',
        signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  };
}
