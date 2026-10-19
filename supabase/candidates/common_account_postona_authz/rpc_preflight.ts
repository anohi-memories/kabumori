// G5-02 REFERENCE CANDIDATE (2026-10-19). A MODEL of the proposed read RPCs, NOT their SQL. Nothing here creates, applies or calls a database
// object; nothing outside its own tests imports it. Contract: docs/common-account/g5-02-authorization-verdict-rpc-preflight.md.
//
//   R1  public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text) -> jsonb       (EXECUTE: authenticated ONLY)
//       the person's verdict (G5-01 wire v1 without the times), the subject and session taken from the request's JWT claims, never a parameter.
//   W1  private.account_lifecycle_worker_brand_verdict(p_brand_id, p_service_key, p_expected_owner_epoch, p_expected_lifecycle_version) -> text   (owner-only)
//       the same answer for a reviewed SQL writer of another owner (G3's claim / preflight, G4's credential statement) inside its own statement.
//   W2  public.common_account_worker_brand_verdict(...same...) -> text                                          (EXECUTE: service_role ONLY)
//       W1 for an Edge worker's last check right before the provider (no person session; never callable by a person).
//
// What this file models and the tests prove: where the subject comes from (R1-3), which inputs are refused before any read (R1-4), why the
// facts must be ONE snapshot (R1-6), how the Edge stamps and classifies an answer (R1-8), the ACL postcondition over the role graph (R1-1), and
// the worker answer with its generation guard (W-3).
import { type AuthFacts, BRAND_ID, decide, POSTONA_FEATURES, type Principal, type Scope, UUID, type VerdictWire } from './verdict.ts';

// ---------------------------------------------------------------------------------------------------------------------------------
// R1-3: the subject. The same claim sources F5 P3b reads (20261010051938): the per-claim settings of an older PostgREST when present, else the
// JSON claims; the subject must also equal auth.uid(). A body field is never a source.
export type ClaimSources = Readonly<{
  legacy: Readonly<{ sub: string | null; role: string | null; sessionId: string | null; isAnonymous?: string | null }> | null; // request.jwt.claim.sub / .role / .session_id / .is_anonymous
  claimsJson: string | null;                                                                          // request.jwt.claims
  authUid: string | null;                                                                             // auth.uid()
}>;

export function principalFromClaims(c: ClaimSources): Principal | { refused: 'AUTH_REQUIRED' } {
  let sub: unknown;
  let role: unknown;
  let session: unknown;
  let anonymous: unknown = false;
  if (c.legacy && c.legacy.sub) {
    ({ sub, role } = c.legacy);
    session = c.legacy.sessionId;
    // a per-claim setting is text: absent, empty or 'false' is not anonymous; anything else is
    anonymous = c.legacy.isAnonymous === undefined || c.legacy.isAnonymous === null || c.legacy.isAnonymous === '' || c.legacy.isAnonymous === 'false' ? false : c.legacy.isAnonymous;
  } else {
    let parsed: unknown = null;
    try {
      parsed = c.claimsJson ? JSON.parse(c.claimsJson) : null;
    } catch {
      parsed = null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { refused: 'AUTH_REQUIRED' };
    const o = parsed as Record<string, unknown>;
    sub = o.sub;
    role = o.role;
    session = o.session_id;
    anonymous = o.is_anonymous ?? false;
  }
  if (typeof sub !== 'string' || !UUID.test(sub) || typeof session !== 'string' || !UUID.test(session)) return { refused: 'AUTH_REQUIRED' };
  if (role !== 'authenticated' || anonymous !== false) return { refused: 'AUTH_REQUIRED' };
  if (c.authUid !== sub) return { refused: 'AUTH_REQUIRED' };
  return { userId: sub, role: 'authenticated', sessionId: session };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// R1: the answer of the RPC = the G5-01 wire without issued_at_ms / expires_at_ms (the Edge stamps them with its own clock).
export const RPC_KEYS = 'decision,entitlements,owner_epoch,reason,scope,session,subject,v';
export type RpcAnswer = Omit<VerdictWire, 'issued_at_ms' | 'expires_at_ms'>;
/** One read, one snapshot: in SQL, a STABLE function whose helpers are all STABLE reads everything with the calling statement's snapshot. */
export type SnapshotReader = (principal: Principal, brandId: string) => Promise<AuthFacts>;

/** R1-4: what is refused before ANY row is read (the parameters the RPC takes, and nothing else). */
export function rpcInputRefusal(p_app: unknown, p_feature: unknown, p_brand_id: unknown): string | null {
  if (p_app !== 'postona') return 'FEATURE_NOT_ENABLED';
  if (typeof p_feature !== 'string' || !Object.hasOwn(POSTONA_FEATURES, p_feature)) return 'FEATURE_NOT_ENABLED';
  if (typeof p_brand_id !== 'string' || !BRAND_ID.test(p_brand_id)) return 'BRAND_REQUIRED';
  return null;
}

export async function rpcVerdict(
  params: Readonly<{ p_app: unknown; p_feature: unknown; p_brand_id: unknown }>,
  claims: ClaimSources,
  read: SnapshotReader,
): Promise<RpcAnswer> {
  const scope: Scope = {
    app: typeof params.p_app === 'string' ? params.p_app : '',
    feature: typeof params.p_feature === 'string' ? params.p_feature : '',
    brandId: typeof params.p_brand_id === 'string' ? params.p_brand_id : null,
  };
  const strip = (w: VerdictWire): RpcAnswer => {
    const { issued_at_ms: _i, expires_at_ms: _e, ...rest } = w;
    return rest;
  };
  const inputRefusal = rpcInputRefusal(params.p_app, params.p_feature, params.p_brand_id);
  const principal = principalFromClaims(claims);
  if (inputRefusal || 'refused' in principal) {
    // the same refusal shape decide() gives, without reading anything
    return strip(await decide(scope, 'refused' in principal ? null : principal, undefined, 0));
  }
  let facts: AuthFacts | undefined;
  try {
    facts = await read(principal, scope.brandId as string);
  } catch {
    // In SQL an exception is NOT caught into a value: the call fails and the Edge classifies it (R1-8). The model returns unknown.
    facts = undefined;
  }
  return strip(await decide(scope, principal, facts, 0));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// R1-8: the Edge's stamp and error classification. The transport result is PostgREST's answer to POST /rest/v1/rpc/<R1> with the person's JWT.
export type RpcTransportResult = Readonly<{ status: number; body: unknown }>;
export const EDGE_TTL_MS = 60_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Turn the RPC's answer into the wire a consumer accepts. 401 / 403 = the token was refused before the function ran -> deny AUTH_REQUIRED;
 * 404 = the function is not deployed -> unknown; any other non-200, or a body that is not exactly the RPC shape for the scope asked -> unknown.
 * A transport failure (network, timeout) is thrown by the caller and becomes AUTH_UNAVAILABLE at the consumer, never allow.
 */
export function edgeStamp(scope: Scope, result: RpcTransportResult, nowMs: number): VerdictWire {
  const refusal = (decision: 'deny' | 'unknown', reason: string): VerdictWire => ({
    v: 1, decision, reason, scope: { app: scope.app, feature: scope.feature, brand_slug: scope.brandId }, subject: { kind: 'system' }, session: null,
    owner_epoch: null, entitlements: [], issued_at_ms: nowMs, expires_at_ms: nowMs,
  });
  if (result.status === 401 || result.status === 403) return refusal('deny', 'AUTH_REQUIRED');
  if (result.status === 404) return refusal('unknown', 'RPC_NOT_DEPLOYED');
  if (result.status !== 200) return refusal('unknown', 'RPC_FAILED');
  const b = result.body;
  if (!isRecord(b) || Object.keys(b).sort().join(',') !== RPC_KEYS || b.v !== 1) return refusal('unknown', 'RPC_SHAPE');
  const s = b.scope;
  if (!isRecord(s) || s.app !== scope.app || s.feature !== scope.feature || s.brand_slug !== scope.brandId) return refusal('unknown', 'SCOPE_MISMATCH');
  // the body has exactly RPC_KEYS, so adding the two times gives exactly WIRE_KEYS; a consumer still checks every field (acceptAllow)
  return { ...(b as unknown as RpcAnswer), issued_at_ms: nowMs, expires_at_ms: b.decision === 'allow' ? nowMs + EDGE_TTL_MS : nowMs } as VerdictWire;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// R1-1 / W2-1: the ACL postcondition over the role graph, the same MEMBER-path rule PR #303 uses (direct or indirect, INHERIT or not, SET or not,
// ADMIN-only edges included). `grants` are the roles holding EXECUTE directly (PUBLIC included as "public").
export type RoleEdge = Readonly<{ member: string; role: string }>;
export const API_ROLES = ['anon', 'authenticated', 'service_role', 'authenticator'] as const;

export function memberClosure(start: string, edges: readonly RoleEdge[]): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const e of edges) if (e.member === cur && !seen.has(e.role)) { seen.add(e.role); queue.push(e.role); }
  }
  return seen;
}

/**
 * Null when the function's EXECUTE is held exactly by `allowed` among the API roles (counting every role each API role is a member of) and no API
 * role reaches the owner or a superuser; otherwise the first violation.
 */
export function aclViolation(input: Readonly<{
  owner: string; grants: readonly string[]; edges: readonly RoleEdge[]; superusers: readonly string[]; allowed: readonly (typeof API_ROLES)[number][];
}>): string | null {
  if (input.grants.includes('public')) return 'PUBLIC_EXECUTE';
  for (const api of API_ROLES) {
    const reach = memberClosure(api, input.edges);
    if (reach.has(input.owner)) return `${api.toUpperCase()}_REACHES_OWNER`;
    if (input.superusers.some((s) => reach.has(s))) return `${api.toUpperCase()}_REACHES_SUPERUSER`;
    const executes = input.grants.some((g) => reach.has(g));
    const expected = (input.allowed as readonly string[]).includes(api);
    // authenticator may reach an allowed role through SET (PostgREST switches to it); that is the allowed role executing, not authenticator itself
    if (executes && !expected && !(api === 'authenticator' && input.grants.every((g) => !reach.has(g) || (input.allowed as readonly string[]).includes(g)))) {
      return `${api.toUpperCase()}_CAN_EXECUTE`;
    }
    if (!executes && expected) return `${api.toUpperCase()}_CANNOT_EXECUTE`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// W1 / W2: the worker answer. No person and no session: the brand's owner state (F5 P5 common_account_brand_service_state), and two monotonic
// counters bound when the reservation / attestation was made -- the F5 owner epoch (owner changes) and the owner's lifecycle_version (the service
// GENERATION: F5 P1 moves it on every entitlement insert / update / delete and every account status change, and never lowers it). Both must be
// EQUAL now. No timestamp is compared: a service ended and re-started after the bind is a new generation even inside one transaction or a long one,
// where now() is the transaction's start (H1 C1 P2 of PR #351).
export type WorkerFacts = Readonly<{ serviceState: string; ownerEpoch: number | null; ownerLifecycleVersion: number | null }>;
export type WorkerBinding = Readonly<{ serviceKey: string; expectedOwnerEpoch: number | null; expectedLifecycleVersion: number | null }>;
export const P5_REFUSALS = Object.freeze(['WORKSPACE_OWNER_UNKNOWN', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'ACCOUNT_DELETION_IN_PROGRESS', 'ACCOUNT_LOCKED',
  'SERVICE_NOT_REGISTERED', 'SERVICE_DELETION_IN_PROGRESS', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LIFECYCLE_SERVICE_INVALID']);
/** The service key POSTONA posting (X and Threads) is entitled under. G5's decision for PR #337's THREADS_POSTING_SERVICE_KEY. */
export const POSTONA_POSTING_SERVICE_KEY = 'x_autopost' as const;

const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;

/**
 * The binding a consumer stores when it creates a reservation from a person's request: taken from R1's ALLOW token `g5oe:<epoch>:<lifecycle>`.
 * Anything else (a refusal, a malformed or out-of-range token) gives no binding: the reservation is not created.
 */
export function bindingFromAllow(wire: unknown): WorkerBinding | null {
  if (typeof wire !== 'object' || wire === null || (wire as { decision?: unknown }).decision !== 'allow') return null;
  const token = (wire as { owner_epoch?: unknown }).owner_epoch;
  const m = typeof token === 'string' ? /^g5oe:([1-9][0-9]{0,15}):([1-9][0-9]{0,15})$/u.exec(token) : null;
  if (!m) return null;
  const epoch = Number(m[1]);
  const lifecycle = Number(m[2]);
  if (!positive(epoch) || !positive(lifecycle)) return null;
  return { serviceKey: POSTONA_POSTING_SERVICE_KEY, expectedOwnerEpoch: epoch, expectedLifecycleVersion: lifecycle };
}

export function workerBrandVerdict(facts: WorkerFacts | undefined, bound: WorkerBinding): 'active' | string {
  if (bound.serviceKey !== POSTONA_POSTING_SERVICE_KEY) return 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  if (!positive(bound.expectedOwnerEpoch)) return 'EXPECTED_OWNER_EPOCH_REQUIRED';
  if (!positive(bound.expectedLifecycleVersion)) return 'EXPECTED_LIFECYCLE_VERSION_REQUIRED';
  if (!facts) return 'FACTS_UNAVAILABLE';
  if (facts.serviceState !== 'active') return P5_REFUSALS.includes(facts.serviceState) ? facts.serviceState : 'SERVICE_STATE_UNKNOWN';
  if (!positive(facts.ownerEpoch)) return 'OWNER_EPOCH_UNAVAILABLE';
  if (facts.ownerEpoch !== bound.expectedOwnerEpoch) return 'OWNER_EPOCH_CHANGED';
  // an unreadable generation is a changed one (as the SQL's null-safe `is distinct from`)
  if (facts.ownerLifecycleVersion !== bound.expectedLifecycleVersion) return 'SERVICE_GENERATION_CHANGED';
  return 'active';
}
