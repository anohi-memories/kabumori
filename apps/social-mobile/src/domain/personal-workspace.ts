// The person's own first run of the personal workspace (G5 W0, PR #590 2c8087fc; source-only, not applied anywhere).
// After the X autopost service has been started (service-enrollment.ts), the app calls the no-argument RPC
// public.postona_ensure_my_personal_workspace() with the person's own access token. The person is the JWT, never an
// input. The server creates (once) or finds the one personal workspace and answers {"status": ...}; the app only reads
// that answer and then the snapshot again. It never names a workspace, never writes a table, never adds a member.
//
// Rules:
//   * one call, bound to the access token captured when it started, cancelled (never sent) when the login changes;
//   * only the exact canonical answers are accepted; anything else fails closed (never "ready");
//   * OWN_WORKSPACE_CONFLICT is asked once more, and only "ready, created false" -- the person's own workspace that
//     another honest writer (their own X begin RPC) made at the same time -- counts; anything else stops (support);
//   * no other retry, no loop, no guessed id.

import { EnrollmentCancelledError } from './service-enrollment.ts';

export const PERSONAL_WORKSPACE_RPC = 'postona_ensure_my_personal_workspace';

/** What one request answered: the HTTP status and the parsed JSON body (null when there was none), or 0 for no answer. */
export type PersonalWorkspaceResponse = { httpStatus: number; body: unknown };
export type PersonalWorkspaceCall = (signal: AbortSignal) => Promise<PersonalWorkspaceResponse>;

export type PersonalWorkspaceOutcome =
  /** The person's own personal workspace (created true only for the call that wrote it). */
  | { kind: 'ready'; workspaceId: string; created: boolean }
  /** No live, non-anonymous login (401, or the session refused): sign in again. */
  | { kind: 'relogin' }
  /** POSTONA is not started / has ended for this account. The existing start / reactivate flow decides; not retried here. */
  | { kind: 'service_inactive' }
  /** The account or the service is locked or being deleted. Not retried. */
  | { kind: 'not_available' }
  /** The data is not one personal workspace (a repeated conflict, another membership, an unknown owner). Support. */
  | { kind: 'support' }
  /** W0 is not installed (404). The feature is off. */
  | { kind: 'off' }
  /** Nothing was decided (network, server, stopped grant, an answer not understood). May be asked again later. */
  | { kind: 'unavailable' };

const WORKSPACE_ID = /^u_[0-9a-f]{24}$/u;
const RELOGIN = ['AUTH_REQUIRED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED'];
const SERVICE_INACTIVE = ['ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'SERVICE_NOT_REGISTERED', 'SERVICE_NOT_ACTIVE'];
const NOT_AVAILABLE = ['ACCOUNT_LOCKED', 'ACCOUNT_DELETION_IN_PROGRESS', 'SERVICE_DELETION_IN_PROGRESS'];
const SUPPORT = ['WORKSPACE_OWNER_UNKNOWN', 'OTHER_WORKSPACE_MEMBERSHIP'];
const CONFLICT = 'OWN_WORKSPACE_CONFLICT';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keysAre(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => key === actual[index]);
}

/** Strict reading of one W0 answer. OWN_WORKSPACE_CONFLICT is returned as 'conflict' for the caller to decide. */
export function parsePersonalWorkspaceAnswer(response: PersonalWorkspaceResponse): PersonalWorkspaceOutcome | { kind: 'conflict' } {
  const { httpStatus, body } = response;
  if (httpStatus === 401) return { kind: 'relogin' };
  if (httpStatus === 404) {
    return isRecord(body) && (body.code === 'PGRST202' || body.code === '42883') ? { kind: 'off' } : { kind: 'unavailable' };
  }
  if (httpStatus !== 200 || !isRecord(body)) return { kind: 'unavailable' };
  if (body.status === 'ready') {
    return keysAre(body, ['status', 'workspace_id', 'created']) && typeof body.workspace_id === 'string'
      && WORKSPACE_ID.test(body.workspace_id) && typeof body.created === 'boolean'
      ? { kind: 'ready', workspaceId: body.workspace_id, created: body.created }
      : { kind: 'unavailable' };
  }
  if (!keysAre(body, ['status']) || typeof body.status !== 'string') return { kind: 'unavailable' };
  if (body.status === CONFLICT) return { kind: 'conflict' };
  if (RELOGIN.includes(body.status)) return { kind: 'relogin' };
  if (SERVICE_INACTIVE.includes(body.status)) return { kind: 'service_inactive' };
  if (NOT_AVAILABLE.includes(body.status)) return { kind: 'not_available' };
  if (SUPPORT.includes(body.status)) return { kind: 'support' };
  // ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE and anything unknown: nothing decided.
  return { kind: 'unavailable' };
}

/**
 * W0 once; on OWN_WORKSPACE_CONFLICT once more (W0 wrote nothing, so asking again is safe). The second answer counts only
 * as "ready, created false" (the workspace someone else -- the person's own begin RPC -- had just made), a refusal of the
 * login, or the same kind of stop as the first; a second conflict, or a workspace this retry itself created, is support.
 */
export async function ensurePersonalWorkspace(call: PersonalWorkspaceCall, signal: AbortSignal): Promise<PersonalWorkspaceOutcome> {
  if (signal.aborted) throw new EnrollmentCancelledError();
  const first = parsePersonalWorkspaceAnswer(await call(signal));
  if (first.kind !== 'conflict') return first;
  if (signal.aborted) throw new EnrollmentCancelledError();
  const second = parsePersonalWorkspaceAnswer(await call(signal));
  if (second.kind === 'conflict') return { kind: 'support' };
  if (second.kind === 'ready' && second.created) return { kind: 'support' };
  return second;
}

/**
 * POST /rest/v1/rpc/postona_ensure_my_personal_workspace with an empty body and the Authorization fixed to one access
 * token (held only in this closure; never logged or stored). A network failure answers httpStatus 0.
 */
export function createPersonalWorkspaceCall(options: {
  url: string;
  apiKey: string;
  accessToken: string;
  fetch?: typeof fetch;
}): PersonalWorkspaceCall {
  const base = options.url.replace(/\/+$/u, '');
  const send = options.fetch ?? fetch;
  return async (signal) => {
    if (signal.aborted) throw new EnrollmentCancelledError();
    let response: Response;
    try {
      response = await send(`${base}/rest/v1/rpc/${PERSONAL_WORKSPACE_RPC}`, {
        method: 'POST',
        headers: {
          apikey: options.apiKey,
          Authorization: `Bearer ${options.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: '{}',
        signal,
      });
    } catch {
      if (signal.aborted) throw new EnrollmentCancelledError();
      return { httpStatus: 0, body: null };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (signal.aborted) throw new EnrollmentCancelledError();
    return { httpStatus: response.status, body };
  };
}
