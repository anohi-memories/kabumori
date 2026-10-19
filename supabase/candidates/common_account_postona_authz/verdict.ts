// G5-01 REFERENCE CANDIDATE (2026-10-19). NOT wired into any Edge function, app or SQL. Nothing imports it outside its own tests.
//
// The G5 authorization verdict for POSTONA requests: login -> the person's verified JWT -> the service entitlement -> the brand
// (workspace) membership and owner -> the feature policy -> a verdict, and a RECHECK right before an irreversible external action.
// The wire object is exactly G6's proposal (docs/ai-provider/G6_APP_POLICY_AUTHORITY_PORT.md on PR #336, `v: 1`); G3 / G4 consumers use
// the same object. Contract and evidence: docs/common-account/g5-01-postona-entitlement-auth-boundary.md.
//
// Pure: no I/O, no network, no Deno / Node API. The FACTS are read elsewhere (in production by a G5 read RPC that does not exist yet --
// a separate TASK behind a Codex Sol (high) gate; in the tests by a TEST-ONLY single-statement read of the real F5 chain). Anything
// missing, unexpected or contradictory is "unknown" or "deny", never "allow".

export const VERDICT_VERSION = 1 as const;

export type Decision = 'allow' | 'deny' | 'unknown' | 'pending';
export type SessionState = 'active' | 'revoked' | 'expired' | 'unknown';
export type AppId = 'postona' | 'kabumori' | 'miseiro';
export type ServiceKey = 'kabumori' | 'x_autopost';
export type BrandRole = 'owner' | 'admin' | 'member' | 'viewer';

/** What a feature needs. Owner-only today: a POSTONA workspace is a person's own user workspace (F5 P5 `brand_owner`). */
export type FeaturePolicy = Readonly<{ service: ServiceKey; brand: 'required' | 'none'; roles: readonly BrandRole[]; irreversible: boolean }>;

/** The POSTONA features G5 answers for. A feature that is not here is refused without reading anything (FEATURE_NOT_ENABLED). */
export const POSTONA_FEATURES: Readonly<Record<string, FeaturePolicy>> = Object.freeze({
  read_workspace: Object.freeze({ service: 'x_autopost', brand: 'required', roles: Object.freeze(['owner'] as const), irreversible: false }),
  x_connect: Object.freeze({ service: 'x_autopost', brand: 'required', roles: Object.freeze(['owner'] as const), irreversible: true }),
  x_publish: Object.freeze({ service: 'x_autopost', brand: 'required', roles: Object.freeze(['owner'] as const), irreversible: true }),
  threads_connect: Object.freeze({ service: 'x_autopost', brand: 'required', roles: Object.freeze(['owner'] as const), irreversible: true }),
  threads_publish: Object.freeze({ service: 'x_autopost', brand: 'required', roles: Object.freeze(['owner'] as const), irreversible: true }),
  consult: Object.freeze({ service: 'x_autopost', brand: 'required', roles: Object.freeze(['owner'] as const), irreversible: true }),
  post_generation: Object.freeze({ service: 'x_autopost', brand: 'required', roles: Object.freeze(['owner'] as const), irreversible: true }),
});

/** The service key of an entitlement, as the wire names it ("<app>:<service>"). Only the scope app's entitlements are listed. */
const ENTITLEMENT_WIRE: Readonly<Record<ServiceKey, string>> = Object.freeze({ x_autopost: 'postona:x_autopost', kabumori: 'kabumori:kabumori' });
const APP_OF_SERVICE: Readonly<Record<ServiceKey, AppId>> = Object.freeze({ x_autopost: 'postona', kabumori: 'kabumori' });

export type Scope = Readonly<{ app: string; feature: string; brandId: string | null }>;

/** The verified caller. Built ONLY from a JWT the Edge runtime / GoTrue verified; a user id from a request body is never a principal. */
export type Principal = Readonly<{ userId: string; role: string; sessionId: string }>;

/**
 * What G5 read, in ONE statement (one snapshot): the person, the session, the common account, the entitlements, the brand and its
 * owner epoch. `null` means "not there"; `undefined` anywhere means "could not be read" and makes the verdict unknown.
 */
export type AuthFacts = Readonly<{
  userExists: boolean;
  sessionLive: boolean | null;            // null: the session row exists but its expiry is past (expired)
  account: Readonly<{ status: string; lifecycleVersion: number; deletionOpen: boolean }> | null;
  entitlements: Readonly<Record<string, Readonly<{ status: string; deletionOpen: boolean }>>>;
  brand: Readonly<{
    kind: string;
    callerRole: string | null;
    ownerUserId: string | null;           // F5 P5 private.account_lifecycle_brand_owner: exactly one owner of a user workspace, else null
    ownerCount: number;
    ownerEpoch: number | null;            // F5 private.account_lifecycle_brand_owner_epoch: NULL = unknown, refuse
  }> | null;
}>;

export type VerdictWire = {
  v: 1;
  decision: Decision;
  reason: string | null;
  scope: { app: string; feature: string; brand_slug: string | null };
  subject: { kind: 'user'; user_id: string } | { kind: 'system' };
  session: { state: SessionState; ref: string } | null;
  owner_epoch: string | null;
  entitlements: string[];
  issued_at_ms: number;
  expires_at_ms: number;
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
export const ENTITLEMENT = /^[a-z][a-z0-9_]{0,31}:[a-z][a-z0-9_]{0,63}$/u;
/** POSTONA brand ids are text slugs (the X onboarding RPC makes `u_<hex>`); anything else is not looked up. */
export const BRAND_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
export const WIRE_KEYS = 'decision,entitlements,expires_at_ms,issued_at_ms,owner_epoch,reason,scope,session,subject,v';
/** An allow lives at most this long; a consumer must recheck right before every irreversible action anyway. */
export const ALLOW_TTL_MS = 60_000;

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The session reference on the wire: a hash, so a session id never travels to a consumer or a log. Stable for one session. */
export async function sessionRef(sessionId: string): Promise<string> {
  return 's:' + (await sha256Hex(`g5-session:${sessionId}`)).slice(0, 32);
}

/**
 * The opaque `owner_epoch` token: the F5 brand owner epoch AND the owner's account lifecycle_version. The epoch moves on every owner
 * change (A -> B -> A included); lifecycle_version moves on every account-state or entitlement change (I7), so an entitlement that
 * went active -> ended -> active, or a deletion that started and was cancelled, is a different token too.
 */
export function ownerEpochToken(ownerEpoch: number, lifecycleVersion: number): string {
  return `g5oe:${ownerEpoch}:${lifecycleVersion}`;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function refusal(scope: Scope, decision: Exclude<Decision, 'allow'>, reason: string, nowMs: number, principal: Principal | null): VerdictWire {
  return {
    v: VERDICT_VERSION,
    decision,
    reason,
    scope: { app: scope.app, feature: scope.feature, brand_slug: scope.brandId },
    subject: principal && UUID.test(principal.userId) ? { kind: 'user', user_id: principal.userId } : { kind: 'system' },
    session: null,
    owner_epoch: null,
    entitlements: [],
    issued_at_ms: nowMs,
    expires_at_ms: nowMs,
  };
}

/** The feature policy of a scope, or the refusal code. Read nothing before this passes. */
export function policyFor(scope: Scope): FeaturePolicy | string {
  if (scope.app === 'miseiro' || scope.app === 'kabumori') return 'FEATURE_NOT_ENABLED';
  if (scope.app !== 'postona') return 'FEATURE_NOT_ENABLED';
  if (!Object.hasOwn(POSTONA_FEATURES, scope.feature)) return 'FEATURE_NOT_ENABLED';
  const policy = POSTONA_FEATURES[scope.feature];
  if (policy.brand === 'required' && !(typeof scope.brandId === 'string' && BRAND_ID.test(scope.brandId))) return 'BRAND_REQUIRED';
  if (policy.brand === 'none' && scope.brandId !== null) return 'BRAND_NOT_EXPECTED';
  return policy;
}

/**
 * The verdict. Order: feature -> caller -> session -> common account -> entitlement -> brand membership / owner -> owner epoch.
 * `facts` must belong to `principal.userId` and `scope.brandId`; the reader is responsible for that (see readFacts in the tests).
 */
export async function decide(scope: Scope, principal: Principal | null, facts: AuthFacts | undefined, nowMs: number): Promise<VerdictWire> {
  const policy = policyFor(scope);
  if (typeof policy === 'string') return refusal(scope, 'deny', policy, nowMs, principal);
  if (!principal || !UUID.test(principal.userId) || principal.role !== 'authenticated' || !UUID.test(principal.sessionId)) {
    return refusal(scope, 'deny', 'AUTH_REQUIRED', nowMs, null);
  }
  if (!facts) return refusal(scope, 'unknown', 'FACTS_UNAVAILABLE', nowMs, principal);
  if (!facts.userExists) return refusal(scope, 'deny', 'AUTH_REQUIRED', nowMs, principal);
  const ref = await sessionRef(principal.sessionId);
  const withSession = (v: VerdictWire, state: SessionState): VerdictWire => ({ ...v, session: { state, ref } });
  if (facts.sessionLive === false) return withSession(refusal(scope, 'deny', 'SESSION_REVOKED', nowMs, principal), 'revoked');
  if (facts.sessionLive === null) return withSession(refusal(scope, 'deny', 'SESSION_EXPIRED', nowMs, principal), 'expired');
  if (facts.sessionLive !== true) return withSession(refusal(scope, 'unknown', 'SESSION_UNKNOWN', nowMs, principal), 'unknown');

  const account = facts.account;
  if (account === null) return refusal(scope, 'deny', 'ACCOUNT_NOT_FOUND', nowMs, principal);
  if (!account || !isInt(account.lifecycleVersion) || account.lifecycleVersion < 1) return refusal(scope, 'unknown', 'ACCOUNT_UNREADABLE', nowMs, principal);
  // common_accounts.status CHECK (F5 P1): active, deleting, locked. Anything else is unknown.
  if (account.status === 'deleting' || account.deletionOpen) return refusal(scope, 'deny', 'ACCOUNT_DELETION_IN_PROGRESS', nowMs, principal);
  if (account.status === 'locked') return refusal(scope, 'deny', 'ACCOUNT_LOCKED', nowMs, principal);
  if (account.status !== 'active') return refusal(scope, 'unknown', 'ACCOUNT_STATE_UNKNOWN', nowMs, principal);

  if (typeof facts.entitlements !== 'object' || facts.entitlements === null) return refusal(scope, 'unknown', 'ENTITLEMENTS_UNREADABLE', nowMs, principal);
  const ent = Object.hasOwn(facts.entitlements, policy.service) ? facts.entitlements[policy.service] : null;
  if (!ent) return refusal(scope, 'deny', 'SERVICE_NOT_REGISTERED', nowMs, principal);
  // service_entitlements.status CHECK (F5 P1): provisioning, active, suspended, deleting, ended. Anything else is unknown.
  if (ent.status === 'deleting' || ent.deletionOpen) return refusal(scope, 'deny', 'SERVICE_DELETION_IN_PROGRESS', nowMs, principal);
  if (ent.status === 'provisioning') return refusal(scope, 'pending', 'SERVICE_PROVISIONING', nowMs, principal);
  if (ent.status === 'suspended') return refusal(scope, 'deny', 'SERVICE_SUSPENDED', nowMs, principal);
  if (ent.status === 'ended') return refusal(scope, 'deny', 'SERVICE_NOT_ACTIVE', nowMs, principal);
  if (ent.status !== 'active') return refusal(scope, 'unknown', 'SERVICE_STATE_UNKNOWN', nowMs, principal);

  const brand = facts.brand;
  // Not found and not a member are the same answer: a brand id must not become an existence oracle.
  if (brand !== null && (typeof brand !== 'object' || brand === undefined)) return refusal(scope, 'unknown', 'BRAND_UNREADABLE', nowMs, principal);
  if (brand === null || brand.callerRole === null) return refusal(scope, 'deny', 'BRAND_ACCESS_DENIED', nowMs, principal);
  if (!(policy.roles as readonly string[]).includes(brand.callerRole)) return refusal(scope, 'deny', 'ROLE_NOT_ALLOWED', nowMs, principal);
  if (brand.kind !== 'social_mobile_user_v1') return refusal(scope, 'deny', 'WORKSPACE_KIND_UNSUPPORTED', nowMs, principal);
  if (brand.ownerCount !== 1 || brand.ownerUserId === null) return refusal(scope, 'unknown', 'WORKSPACE_OWNER_UNKNOWN', nowMs, principal);
  if (brand.ownerUserId !== principal.userId) return refusal(scope, 'deny', 'BRAND_ACCESS_DENIED', nowMs, principal);
  if (!isInt(brand.ownerEpoch) || brand.ownerEpoch < 1) return refusal(scope, 'unknown', 'OWNER_EPOCH_UNAVAILABLE', nowMs, principal);

  const entitlements = Object.entries(facts.entitlements)
    .filter(([key, e]) => (key === 'x_autopost' || key === 'kabumori') && e.status === 'active' && !e.deletionOpen
      && APP_OF_SERVICE[key as ServiceKey] === scope.app)
    .map(([key]) => ENTITLEMENT_WIRE[key as ServiceKey])
    .sort();
  return {
    v: VERDICT_VERSION,
    decision: 'allow',
    reason: null,
    scope: { app: scope.app, feature: scope.feature, brand_slug: scope.brandId },
    subject: { kind: 'user', user_id: principal.userId },
    session: { state: 'active', ref },
    owner_epoch: ownerEpochToken(brand.ownerEpoch, account.lifecycleVersion),
    entitlements,
    issued_at_ms: nowMs,
    expires_at_ms: nowMs + ALLOW_TTL_MS,
  };
}

/**
 * The entry point: refuse an unknown feature, a malformed brand id or a missing / malformed caller WITHOUT reading anything; otherwise
 * read the facts for exactly (principal.userId, scope.brandId) -- never a user id from the request -- and decide. A reader that throws
 * is "unknown".
 */
export async function authorize(
  scope: Scope,
  principal: Principal | null,
  read: (principal: Principal, scope: Scope) => Promise<AuthFacts>,
  nowMs: number,
): Promise<VerdictWire> {
  const policy = policyFor(scope);
  if (typeof policy === 'string') return refusal(scope, 'deny', policy, nowMs, principal);
  if (!principal || !UUID.test(principal.userId) || principal.role !== 'authenticated' || !UUID.test(principal.sessionId)) {
    return refusal(scope, 'deny', 'AUTH_REQUIRED', nowMs, null);
  }
  let facts: AuthFacts | undefined;
  try {
    facts = await read(principal, scope);
  } catch {
    facts = undefined;
  }
  return decide(scope, principal, facts, nowMs);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysAre = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys;

/**
 * The consumer side (G3 / G4 / G6 / an Edge handler): accept a wire object as "allow" ONLY when every rule holds for the scope that was
 * asked. Returns the generation (what must not change before the irreversible action) or a refusal code.
 */
export function acceptAllow(wire: unknown, scope: Scope, nowMs: number, maxTtlMs = ALLOW_TTL_MS): { generation: string; userId: string } | { refused: string } {
  if (!isRecord(wire) || !keysAre(wire, WIRE_KEYS) || wire.v !== VERDICT_VERSION) return { refused: 'WIRE_SHAPE' };
  if (wire.decision !== 'allow') return { refused: typeof wire.reason === 'string' && TOKEN.test(wire.reason) ? wire.reason : 'NOT_ALLOWED' };
  if (wire.reason !== null) return { refused: 'WIRE_REASON' };
  const s = wire.scope;
  if (!isRecord(s) || !keysAre(s, 'app,brand_slug,feature') || s.app !== scope.app || s.feature !== scope.feature || s.brand_slug !== scope.brandId) {
    return { refused: 'SCOPE_MISMATCH' };
  }
  const subject = wire.subject;
  if (!isRecord(subject) || !keysAre(subject, 'kind,user_id') || subject.kind !== 'user' || typeof subject.user_id !== 'string' || !UUID.test(subject.user_id)) {
    return { refused: 'SUBJECT_SHAPE' };
  }
  const session = wire.session;
  if (!isRecord(session) || !keysAre(session, 'ref,state') || session.state !== 'active' || typeof session.ref !== 'string' || !TOKEN.test(session.ref)) {
    return { refused: 'SESSION_SHAPE' };
  }
  const brandScoped = scope.brandId !== null;
  if (brandScoped ? !(typeof wire.owner_epoch === 'string' && /^g5oe:[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$/u.test(wire.owner_epoch)) : wire.owner_epoch !== null) {
    return { refused: 'OWNER_EPOCH_SHAPE' };
  }
  const ents = wire.entitlements;
  if (!Array.isArray(ents) || ents.length > 32 || new Set(ents).size !== ents.length || !ents.every((e) => typeof e === 'string' && ENTITLEMENT.test(e))) {
    return { refused: 'WIRE_ENTITLEMENTS' };
  }
  if (!isInt(wire.issued_at_ms) || !isInt(wire.expires_at_ms)) return { refused: 'WIRE_TIME' };
  if (wire.issued_at_ms > nowMs + 30_000) return { refused: 'ISSUED_IN_FUTURE' };
  if (!(wire.expires_at_ms > nowMs)) return { refused: 'EXPIRED' };
  if (wire.expires_at_ms - wire.issued_at_ms > maxTtlMs) return { refused: 'TTL_TOO_LONG' };
  const generation = JSON.stringify([subject.user_id, session.ref, wire.owner_epoch, [...ents].sort()]);
  return { generation, userId: subject.user_id };
}

export type IrreversibleOutcome = { sent: true; result: unknown } | { sent: false; refused: string };

/**
 * The only shape in which an irreversible external action (an X / Threads post, a token exchange, a paid AI call) may run: an accepted
 * verdict, the preparation, then a FRESH verdict for the same scope with the SAME generation, then the action -- once. Any change of
 * the person, the session, the owner, the owner's lifecycle or the entitlements in between sends nothing. No database lock is held
 * across `act` (the external call cannot be undone; the residual window is from the recheck to the provider's acceptance).
 */
export async function guardIrreversible(input: Readonly<{
  scope: Scope;
  first: unknown;
  prepare: () => Promise<void>;
  recheck: () => Promise<unknown>;
  act: () => Promise<unknown>;
  nowMs: () => number;
}>): Promise<IrreversibleOutcome> {
  const policy = policyFor(input.scope);
  if (typeof policy === 'string') return { sent: false, refused: policy };
  const before = acceptAllow(input.first, input.scope, input.nowMs());
  if ('refused' in before) return { sent: false, refused: before.refused };
  await input.prepare();
  let fresh: unknown;
  try {
    fresh = await input.recheck();
  } catch {
    return { sent: false, refused: 'AUTH_UNAVAILABLE_BEFORE_SEND' };
  }
  const after = acceptAllow(fresh, input.scope, input.nowMs());
  if ('refused' in after) return { sent: false, refused: `RECHECK_${after.refused}` };
  if (after.generation !== before.generation) return { sent: false, refused: 'AUTH_CHANGED_BEFORE_SEND' };
  return { sent: true, result: await input.act() };
}
