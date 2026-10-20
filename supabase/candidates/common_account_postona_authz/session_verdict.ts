// G5-09 (Issue #320, G5-01 task 9): the SESSION-ONLY verdict a person-facing read / stop action needs (G3's reservation cancel and receipt, P7 of
// G3 PR #392) -- a pure reference model, NOT SQL. Contract: docs/common-account/g5-09-session-verdict-interface.md.
//
// What it answers: "is this request made by a signed-in, non-anonymous person whose session is live right now" -- exactly R1's first two stages
// (the subject from the JWT claims, then the session row), and NOTHING about the common account, the entitlement or a brand. So it can gate actions
// that must keep working after a service ended (reading one's own receipt, stopping one's own reservation) without inventing an R1 feature.
//
//   sessionVerdict()        the proposed SQL function private.account_lifecycle_session_verdict() (NOT created; a later G5 TASK behind Codex Sol)
//   reservationPersonGate() how a consumer (G3's 007 cancel / receipt) uses it: the session first, then the row by its owner, never the entitlement
//   edgeClaimsForDb()       what an Edge that verified the token with GET /auth/v1/user must hand the database (sub AND session_id), or refuse
//
// Pure functions: no network, no clock of their own, no database.
import { type ClaimSources, principalFromClaims } from './rpc_preflight.ts';
import { UUID } from './verdict.ts';

export const SESSION_VERDICTS = Object.freeze(['active', 'AUTH_REQUIRED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'SESSION_UNKNOWN'] as const);
export type SessionVerdict = (typeof SESSION_VERDICTS)[number];

/**
 * What the database reads in ONE statement for the verified subject: whether the login exists and the auth.sessions row whose id is the claim's
 * session_id. `session` is that row (null: no such row), whoever it belongs to; `undefined` facts = could not be read.
 */
export type SessionFacts = Readonly<{
  userExists: boolean;
  session: Readonly<{ userId: string; notAfterMs: number | null }> | null;
}>;

/**
 * R1's subject + session stages, alone. Order and codes are R1's (decide() / 001_authorization_verdict.sql): the claims first (nothing is read
 * before), then the login, then the session row -- missing OR another person's = SESSION_REVOKED (R1 joins on id AND user_id), not_after in the past
 * = SESSION_EXPIRED. Anonymous / non-authenticated role / malformed claims / sub != auth.uid() = AUTH_REQUIRED (one code: the consumer answers 401
 * for all of them). Unreadable facts = SESSION_UNKNOWN (fail closed; the SQL form raises instead).
 */
export function sessionVerdict(claims: ClaimSources, facts: SessionFacts | undefined, nowMs: number): SessionVerdict {
  const principal = principalFromClaims(claims);
  if ('refused' in principal) return 'AUTH_REQUIRED';
  if (facts === undefined || typeof facts !== 'object' || facts === null || typeof facts.userExists !== 'boolean') return 'SESSION_UNKNOWN';
  if (!facts.userExists) return 'AUTH_REQUIRED';
  const s = facts.session;
  if (s === null) return 'SESSION_REVOKED';
  if (typeof s !== 'object' || typeof s.userId !== 'string' || (s.notAfterMs !== null && !Number.isFinite(s.notAfterMs))) return 'SESSION_UNKNOWN';
  if (s.userId !== principal.userId) return 'SESSION_REVOKED';
  if (s.notAfterMs !== null && !(s.notAfterMs > nowMs)) return 'SESSION_EXPIRED';
  return 'active';
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The consumer rule for G3's person-facing reservation reads / stops (cancel, receipt). The entitlement is deliberately NOT an input: a person
// whose service ended (or is suspended / deleting) may still read their own receipts and stop their own pending reservations -- both send nothing.

export type ReservationOp = 'receipt' | 'cancel';
export type ReservationRow = Readonly<{ ownerUserId: string; status: string }>;
export type GateResult =
  | Readonly<{ proceed: true; userId: string }>
  | Readonly<{ refused: 'AUTH_REQUIRED' | 'AUTH_UNAVAILABLE' | 'NOT_FOUND' | 'NOT_CANCELLABLE' }>;
/** Statuses a person may stop (the worker has not taken the row). The authority is G3's 007; this is the model's stand-in. */
export const CANCELLABLE = Object.freeze(['planned'] as const);

/**
 * 1. the session verdict, BEFORE any reservation row is read (a dead session learns nothing, changes nothing);
 * 2. the row by id, visible only when it is the caller's (another person's row and an unknown id: the same NOT_FOUND);
 * 3. cancel only from a cancellable status.
 * `readRow` is called at most once, and only after step 1 passed.
 */
export function reservationPersonGate(
  op: ReservationOp,
  verdict: SessionVerdict,
  callerUserId: string,
  readRow: () => ReservationRow | null,
): GateResult {
  if (verdict === 'SESSION_UNKNOWN') return { refused: 'AUTH_UNAVAILABLE' };
  if (verdict !== 'active') return { refused: 'AUTH_REQUIRED' };
  if (!UUID.test(callerUserId)) return { refused: 'AUTH_REQUIRED' };
  const row = readRow();
  if (row === null || row.ownerUserId !== callerUserId) return { refused: 'NOT_FOUND' };
  if (op === 'cancel' && !(CANCELLABLE as readonly string[]).includes(row.status)) return { refused: 'NOT_CANCELLABLE' };
  return { proceed: true, userId: callerUserId };
}

/** HTTP mapping the consumer keeps (G3's fixture today): a session refusal is 401 (sign in again), never 403 / 404. */
export const GATE_HTTP: Readonly<Record<string, number>> = Object.freeze({ AUTH_REQUIRED: 401, AUTH_UNAVAILABLE: 503, NOT_FOUND: 404, NOT_CANCELLABLE: 409 });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The Edge side. GoTrue's GET /auth/v1/user (supabase/auth ce9a8eee, internal/api/auth.go:118-170) verifies the signature and exp, loads the user
// by sub and -- ONLY WHEN the token carries a session_id -- the session row by id (missing -> 403 session_not_found). It does NOT check the
// session's not_after, does NOT compare the session's user with sub, and allows anonymous users. So the Edge must (a) refuse a token without a
// session_id and an anonymous one itself, and (b) hand the database the token's own sub AND session_id, so the database can check not_after and
// the session's owner in the transaction that acts (closing the window between the Auth call and the action, too).

const B64URL = /^[A-Za-z0-9_-]+$/u;
function decodePayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return null;
  try {
    const b64 = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0)));
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * `token` is the EXACT bearer string GoTrue just answered 200 for, and `userBody` that 200 body. Returns the value for request.jwt.claims
 * ({sub, role, session_id, is_anonymous:false}) or null (= 401). The payload is trusted only because GoTrue verified this very string.
 */
export function edgeClaimsForDb(token: string, userBody: unknown): string | null {
  if (typeof userBody !== 'object' || userBody === null || Array.isArray(userBody)) return null;
  const body = userBody as Record<string, unknown>;
  const payload = decodePayload(token);
  if (!payload) return null;
  const sub = payload.sub;
  const session = payload.session_id;
  if (typeof sub !== 'string' || !UUID.test(sub) || body.id !== sub) return null;
  if (typeof session !== 'string' || !UUID.test(session)) return null;
  if (payload.role !== 'authenticated' || (body.role !== undefined && body.role !== 'authenticated')) return null;
  if (payload.is_anonymous === true || body.is_anonymous === true) return null;
  if (payload.is_anonymous !== undefined && payload.is_anonymous !== false) return null;
  return JSON.stringify({ sub, role: 'authenticated', session_id: session, is_anonymous: false });
}
