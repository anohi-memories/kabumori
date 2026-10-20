// G5-06 REFERENCE CANDIDATE (2026-10-20). A MODEL of the brand-less BOOTSTRAP verdict for the first POSTONA X / Threads connection, NOT its SQL.
// Nothing here creates, applies or calls a database object; nothing outside its own tests imports it.
// Contract: docs/common-account/g5-06-brandless-oauth-bootstrap.md.
//
// The first connection has no workspace yet: the begin RPC creates the person's own workspace. R1 needs a brand, so a SEPARATE verdict answers
// only "may this person START a connection now" -- from the verified JWT, the live session, the common account and the x_autopost entitlement, plus
// one fact about the person's own (server-derived) workspace: it is absent, or it is already exactly theirs. It is a different FEATURE
// (`x_connect_bootstrap` / `threads_connect_bootstrap`), has no brand and no owner epoch, and is accepted by nothing else: not R1's features, not a
// worker binding (no epoch), not an AI plan. The code exchange stays behind the brand R1 at the callback and a recheck right before it.
import { type AuthFacts, decide, type Principal, type Scope, type VerdictWire } from './verdict.ts';

export const BOOTSTRAP_FEATURES = Object.freeze(['x_connect_bootstrap', 'threads_connect_bootstrap'] as const);
export type BootstrapFeature = (typeof BOOTSTRAP_FEATURES)[number];
/** The brand-scoped feature a bootstrap leads to, and the only one whose callback may follow it. */
export const CONNECT_FEATURE_OF: Readonly<Record<BootstrapFeature, 'x_connect' | 'threads_connect'>> = Object.freeze({
  x_connect_bootstrap: 'x_connect',
  threads_connect_bootstrap: 'threads_connect',
});

/**
 * The person's own workspace, looked up by the id the SERVER derives from the verified subject (today `u_` || md5(user)[:24],
 * public.social_mobile_account_deletion_workspace in main) -- never a brand id from the request. null = it does not exist yet.
 */
export type OwnWorkspaceFact = Readonly<{ kind: string; callerRole: string | null; ownerUserId: string | null; ownerCount: number }> | null;
export type BootstrapFacts = Readonly<Omit<AuthFacts, 'brand'> & { ownWorkspace: OwnWorkspaceFact }>;

const BOOT_KEYS = new Set<string>(BOOTSTRAP_FEATURES);

/**
 * The bootstrap verdict: the 8-key wire of G5-01 (with times), scope `{app: 'postona', feature: <bootstrap feature>, brand_slug: null}`,
 * owner_epoch null. Person checks are exactly R1's (decide() on the same facts with a neutral brand); then the own-workspace rule.
 */
export async function bootstrapVerdict(scope: Scope, principal: Principal | null, facts: BootstrapFacts | undefined, nowMs: number): Promise<VerdictWire> {
  const refusal = (decision: 'deny' | 'unknown', reason: string, base?: VerdictWire): VerdictWire => ({
    v: 1, decision, reason, scope: { app: scope.app, feature: scope.feature, brand_slug: scope.brandId },
    subject: base?.subject ?? { kind: 'system' }, session: base && base.decision !== 'allow' ? base.session : null, owner_epoch: null, entitlements: [],
    issued_at_ms: nowMs, expires_at_ms: nowMs,
  });
  if (scope.app !== 'postona' || !BOOT_KEYS.has(scope.feature)) return refusal('deny', 'FEATURE_NOT_ENABLED');
  // a bootstrap never names a brand: a brand id from the request is refused, not ignored
  if (scope.brandId !== null) return refusal('deny', 'BRAND_NOT_EXPECTED');
  // the person checks of R1, run on a stand-in brand that is the caller's own: only the person / session / account / entitlement order matters
  const personScope: Scope = { app: 'postona', feature: CONNECT_FEATURE_OF[scope.feature as BootstrapFeature], brandId: 'u_bootstrap' };
  const personFacts: AuthFacts | undefined = facts
    ? { ...facts, brand: principal ? { kind: 'social_mobile_user_v1', callerRole: 'owner', ownerUserId: principal.userId, ownerCount: 1, ownerEpoch: 1 } : null }
    : undefined;
  const person = await decide(personScope, principal, personFacts, nowMs);
  if (person.decision !== 'allow') {
    return { ...refusal(person.decision as 'deny' | 'unknown', person.reason ?? 'UNKNOWN', person), decision: person.decision };
  }
  const own = facts!.ownWorkspace;
  if (own !== null) {
    if (typeof own !== 'object' || own === undefined) return refusal('unknown', 'OWN_WORKSPACE_UNREADABLE', person);
    // the derived id is taken by a workspace that is not exactly this person's: never join it, never become a second owner
    if (own.kind !== 'social_mobile_user_v1') return refusal('deny', 'OWN_WORKSPACE_CONFLICT', person);
    if (own.ownerCount !== 1 || own.ownerUserId === null) return refusal('unknown', 'WORKSPACE_OWNER_UNKNOWN', person);
    if (own.ownerUserId !== principal!.userId || own.callerRole !== 'owner') return refusal('deny', 'OWN_WORKSPACE_CONFLICT', person);
  }
  return {
    v: 1, decision: 'allow', reason: null,
    scope: { app: 'postona', feature: scope.feature, brand_slug: null },
    subject: person.subject, session: person.session, owner_epoch: null, entitlements: person.entitlements,
    issued_at_ms: nowMs, expires_at_ms: person.expires_at_ms,
  };
}

/**
 * What the begin writer (G4 / F3 SQL, ONE transaction) must do with a bootstrap allow, modelled on a world map so the tests can race it:
 * the G5 write guard first (F5 P3b private.account_lifecycle_assert_active_service_write: the person, a live session, account + entitlement
 * active, under row locks), then the deterministic workspace created idempotently, then a CHECK that its owners are exactly {caller} and its kind
 * is a user workspace -- refusing (and rolling back) otherwise. Returns the workspace id or a refusal code.
 */
export type BeginWorld = {
  guard: (userId: string) => string | null;                                     // null = P3b allows; else its code
  workspaces: Map<string, { kind: string; members: Map<string, string> }>;     // brand id -> members (user -> role)
  derive: (userId: string) => string;                                           // the server's derivation
};
export function beginCreateWorkspace(world: BeginWorld, userId: string): { workspace: string } | { refused: string } {
  const guard = world.guard(userId);
  if (guard !== null) return { refused: guard };
  const id = world.derive(userId);
  const snapshot = new Map([...world.workspaces].map(([k, v]) => [k, { kind: v.kind, members: new Map(v.members) }]));
  let ws = world.workspaces.get(id);
  if (!ws) {
    ws = { kind: 'social_mobile_user_v1', members: new Map() };
    world.workspaces.set(id, ws);
  }
  if (!ws.members.has(userId)) ws.members.set(userId, 'owner');                // "on conflict do nothing" for the caller's own row
  const owners = [...ws.members].filter(([, role]) => role === 'owner').map(([u]) => u);
  if (ws.kind !== 'social_mobile_user_v1' || owners.length !== 1 || owners[0] !== userId || ws.members.get(userId) !== 'owner') {
    world.workspaces.clear();                                                   // the whole transaction rolls back
    for (const [k, v] of snapshot) world.workspaces.set(k, v);
    return { refused: 'OWN_WORKSPACE_CONFLICT' };
  }
  return { workspace: id };
}
