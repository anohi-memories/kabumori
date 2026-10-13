// Social-mobile self-service account deletion. SOURCE CANDIDATE -- not deployed;
// independent review is mandatory before deploy (new privileged boundary).
//
// Security model:
//   * The user is whoever the caller's own bearer token belongs to (GET
//     /auth/v1/user). The request body never names a user.
//   * delete requires recent authentication (newest `amr` <= RECENT_AUTH_SECONDS,
//     `sub` == verified user), an explicit confirmation constant and the scope
//     the user was shown (preview). A different current scope refuses.
//   * The durable DB state machine (migration 20260928160000) does the
//     serialization: acquire (lease) -> stop X publishing (F3 candidate
//     social_mobile_account_deletion_stop_x) -> credentials -> X revoke -> mark (by
//     SHA-256 of exactly the revoked material) -> Apple revoke + durable
//     checkpoint (only when the login itself is deleted) -> stop X publishing
//     again (pre-purge) -> purge -> finalize.
//     A retry resumes where the DB says it stopped; nothing external is
//     repeated after its checkpoint.
//   * X posts whose result is unknown are counted from the DB's DURABLE
//     checkpoint (x_posts_unconfirmed, written before the purge), never from
//     this request's memory: a retry after a committed purge, a failed
//     finalize or a lease takeover still reports them.
//   * Every failure returns a fixed code and releases the lease; success is
//     reported only after finalize committed.
//   * Tokens, keys and server messages are never returned or logged.

export const CONFIRMATION = 'DELETE_MY_ACCOUNT';
export const RECENT_AUTH_SECONDS = 600;

export type DeletionScope = 'social_only' | 'social_and_login';

export const BLOCK_REASONS = [
  'ADMIN_ACCOUNT', 'OWNS_OTHER_WORKSPACE', 'WORKSPACE_NOT_SELF_SERVICE', 'SHARED_WORKSPACE', 'WORKSPACE_ROLE_MISMATCH',
  'POSTING_IN_PROGRESS', 'CREDENTIAL_REFRESH_IN_PROGRESS', 'CREDENTIAL_OWNERSHIP_AMBIGUOUS', 'UNEXPECTED_DEPENDENT_DATA',
  'NON_X_ACCOUNT_PRESENT', 'UNKNOWN',
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export type DeletionErrorCode =
  | 'AUTH_REQUIRED' | 'CONFIRMATION_REQUIRED' | 'REAUTH_REQUIRED' | 'SCOPE_REQUIRED' | 'SCOPE_CHANGED'
  | 'APPLE_REVOCATION_UNAVAILABLE' | 'APPLE_REAUTH_REQUIRED' | 'APPLE_REVOKE_FAILED'
  | `DELETION_BLOCKED_${BlockReason}` | 'DELETION_IN_PROGRESS' | 'DELETION_OPERATOR_REQUIRED'
  | 'X_REVOKE_FAILED' | 'CREDENTIALS_CHANGED' | 'FINALIZE_FAILED' | 'FAILED';

/** providers and Apple subjects come from the server's view of the user's identities. */
export type VerifiedUser = { id: string; providers: readonly string[]; appleSubjects: readonly string[] };
export type RpcName = 'preview' | 'x_precheck' | 'acquire' | 'release' | 'stop_x' | 'credentials' | 'mark_x_revoked' | 'mark_apple_revoked' | 'purge' | 'finalize' | 'record';
export type RpcResult = { ok: true; data: unknown } | { ok: false; code: string | null };

export type DeletionDeps = {
  getUser: (token: string) => Promise<VerifiedUser | null>;
  rpc: (name: RpcName, args: Record<string, unknown>) => Promise<RpcResult>;
  revokeX: (token: string, hint: 'access_token' | 'refresh_token') => Promise<boolean>;
  /** null when Sign in with Apple revocation is not configured on the server. */
  revokeApple: ((authorizationCode: string, expectedSubjects: readonly string[]) => Promise<boolean>) | null;
  sha256Hex: (value: string) => Promise<string>;
  nowSeconds: () => number;
};

type Body = { ok: false; error: DeletionErrorCode } | ({ ok: true } & Record<string, unknown>);
export type DeletionResponse = { status: number; body: Body };

const fail = (status: number, error: DeletionErrorCode): DeletionResponse => ({ status, body: { ok: false, error } });

export function bearerToken(header: string | null): string | null {
  const match = header ? /^Bearer\s+(\S+)$/iu.exec(header.trim()) : null;
  return match ? match[1] : null;
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(atob(part.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
    return typeof claims === 'object' && claims !== null ? claims as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Newest authentication time in the (already server-verified) token, or null. */
export function lastAuthenticatedAt(token: string, userId: string): number | null {
  const claims = jwtClaims(token);
  if (!claims || claims.sub !== userId || !Array.isArray(claims.amr)) return null;
  const times = claims.amr
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { timestamp?: unknown }).timestamp : null))
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return times.length ? Math.max(...times) : null;
}

export function blockReason(value: unknown): BlockReason {
  return (BLOCK_REASONS as readonly unknown[]).includes(value) ? value as BlockReason : 'UNKNOWN';
}

const isScope = (value: unknown): value is DeletionScope => value === 'social_only' || value === 'social_and_login';
/** A durable count from the DB: a non-negative integer, or null (= the answer is not trusted). */
const durableCount = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);
const record = (value: unknown) => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : {});

async function verifiedUser(authorization: string | null, deps: DeletionDeps): Promise<{ token: string; user: VerifiedUser } | null> {
  const token = bearerToken(authorization);
  if (!token) return null;
  try {
    const user = await deps.getUser(token);
    return user ? { token, user } : null;
  } catch {
    return null;
  }
}

/** Apple grant revocation belongs to deleting the login itself. */
const appleRevocationApplies = (user: VerifiedUser, scope: DeletionScope) => scope === 'social_and_login' && user.providers.includes('apple');

/** Read-only: what a deletion would do now (shown before confirmation). */
export async function handlePreview(input: { authorization: string | null }, deps: DeletionDeps): Promise<DeletionResponse> {
  const caller = await verifiedUser(input.authorization, deps);
  if (!caller) return fail(401, 'AUTH_REQUIRED');
  const preview = await deps.rpc('preview', { p_user_id: caller.user.id });
  if (!preview.ok) return fail(500, 'FAILED');
  const data = record(preview.data);
  if (!isScope(data.scope)) return fail(500, 'FAILED');
  const apple = appleRevocationApplies(caller.user, data.scope);
  return {
    status: 200,
    body: {
      ok: true,
      scope: data.scope,
      state: typeof data.state === 'string' ? data.state : 'none',
      apple_supported: !apple || deps.revokeApple !== null,
      apple_code_required: apple && data.apple_revoked !== true,
    },
  };
}

export async function handleAccountDeletion(
  input: { authorization: string | null; body: unknown },
  deps: DeletionDeps,
): Promise<DeletionResponse> {
  const caller = await verifiedUser(input.authorization, deps);
  if (!caller) return fail(401, 'AUTH_REQUIRED');
  const { token, user } = caller;
  const body = record(input.body);
  if (body.confirmation !== CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');
  const authenticatedAt = lastAuthenticatedAt(token, user.id);
  if (authenticatedAt === null || deps.nowSeconds() - authenticatedAt > RECENT_AUTH_SECONDS) return fail(403, 'REAUTH_REQUIRED');
  if (!isScope(body.expected_scope)) return fail(400, 'SCOPE_REQUIRED');
  const scope = body.expected_scope;
  const apple = appleRevocationApplies(user, scope);
  if (apple && !deps.revokeApple) return fail(409, 'APPLE_REVOCATION_UNAVAILABLE');
  const appleCode = typeof body.apple_authorization_code === 'string' && body.apple_authorization_code.length > 0 ? body.apple_authorization_code : null;

  const userId = user.id;
  const audit = async (step: 'requested' | 'failed', reason: string | null = null) => {
    try {
      await deps.rpc('record', { p_user_id: userId, p_step: step, p_reason_code: reason });
    } catch {
      // Best effort; state transitions are recorded by the DB boundary itself.
    }
  };

  // Pre-check without side effects.
  const preview = await deps.rpc('preview', { p_user_id: userId });
  if (!preview.ok) return fail(500, 'FAILED');
  const current = record(preview.data);
  if (current.state === 'operator_required') return fail(409, 'DELETION_OPERATOR_REQUIRED');
  if (current.scope !== scope) return fail(409, 'SCOPE_CHANGED');
  if (apple && current.apple_revoked !== true && !appleCode) return fail(400, 'APPLE_REAUTH_REQUIRED');

  // A non-X social account refuses before anything is recorded (the credential set is bound at acquire).
  const precheck = await deps.rpc('x_precheck', { p_user_id: userId });
  if (!precheck.ok) return fail(500, 'FAILED');
  const nonX = durableCount(record(precheck.data).non_x_accounts);
  const unconfirmedBefore = durableCount(record(precheck.data).x_posts_unconfirmed);
  if (nonX === null || unconfirmedBefore === null) return fail(500, 'FAILED');
  if (nonX > 0) return fail(409, 'DELETION_BLOCKED_NON_X_ACCOUNT_PRESENT');

  await audit('requested');
  const acquired = await deps.rpc('acquire', { p_expected_scope: scope, p_apple_required: apple, p_user_id: userId });
  if (!acquired.ok) return fail(500, 'FAILED');
  const lease = record(acquired.data);
  if (lease.status === 'blocked') return fail(409, `DELETION_BLOCKED_${blockReason(lease.reason)}`);
  if (lease.status === 'in_progress') return fail(409, 'DELETION_IN_PROGRESS');
  if (lease.status === 'scope_changed') return fail(409, 'SCOPE_CHANGED');
  if (lease.status === 'operator_required') return fail(409, 'DELETION_OPERATOR_REQUIRED');
  if (lease.status !== 'acquired' || typeof lease.lease !== 'string') return fail(500, 'FAILED');
  const leaseArgs = { p_lease: lease.lease, p_user_id: userId };
  const stop = async (status: number, error: DeletionErrorCode, reason: string): Promise<DeletionResponse> => {
    await audit('failed', reason);
    try {
      await deps.rpc('release', leaseArgs);
    } catch {
      // The lease also expires on its own.
    }
    return fail(status, error);
  };
  const leaseLost = (result: RpcResult) => !result.ok && result.code === 'SOCIAL_MOBILE_DELETION_LEASE_LOST';

  // X publishing stops before any credential is read, revoked at X or removed, and again right before the purge:
  // publish authority revoked, planned reservations cancelled (idempotent). A post in flight, a non-X account or a
  // shared workspace answers a TYPED block (the stop itself stays in effect) -- never an operator hand-off from here.
  // Every stop answer carries the DURABLE count of X posts whose result is unknown (it only grows until acknowledged).
  let unconfirmedPosts = unconfirmedBefore;
  const stopXPublishing = async (): Promise<DeletionResponse | null> => {
    const halted = await deps.rpc('stop_x', leaseArgs);
    if (leaseLost(halted)) return fail(409, 'DELETION_IN_PROGRESS');
    if (!halted.ok) return stop(500, 'FAILED', 'X_STOP_FAILED');
    const result = record(halted.data);
    if (result.status === 'blocked') {
      const reason = blockReason(result.reason);
      return stop(409, `DELETION_BLOCKED_${reason}`, reason);
    }
    const durable = durableCount(result.x_posts_unconfirmed);
    if ((result.status === 'stopped' || result.status === 'not_applicable') && durable !== null) {
      unconfirmedPosts = Math.max(unconfirmedPosts, durable);
      return null;
    }
    return stop(500, 'FAILED', 'X_STOP_UNEXPECTED');
  };
  const stopped = await stopXPublishing();
  if (stopped) return stopped;

  // X: revoke exactly the current material, then record it by fingerprint.
  if (lease.state === 'started') {
    const credentials = await deps.rpc('credentials', leaseArgs);
    if (leaseLost(credentials)) return fail(409, 'DELETION_IN_PROGRESS');
    if (!credentials.ok) return stop(500, 'FAILED', 'CREDENTIALS_FAILED');
    const found = record(credentials.data);
    if (found.status === 'operator_required') return fail(409, 'DELETION_OPERATOR_REQUIRED');
    if (found.status === 'ok') {
      const revoked: { id: string; access_sha256: string; refresh_sha256: string }[] = [];
      for (const account of (Array.isArray(found.accounts) ? found.accounts : []).map(record)) {
        if (account.revoke_required !== true) continue;
        const access = account.access_token;
        const refresh = account.refresh_token;
        if (typeof account.id !== 'string' || typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) {
          return stop(500, 'FAILED', 'CREDENTIAL_MATERIAL_MISSING');
        }
        for (const [value, hint] of [[refresh, 'refresh_token'], [access, 'access_token']] as const) {
          let ok = false;
          try {
            ok = await deps.revokeX(value, hint);
          } catch {
            ok = false;
          }
          if (!ok) return stop(502, 'X_REVOKE_FAILED', 'X_REVOKE_FAILED');
        }
        revoked.push({ id: account.id, access_sha256: await deps.sha256Hex(access), refresh_sha256: await deps.sha256Hex(refresh) });
      }
      const marked = await deps.rpc('mark_x_revoked', { ...leaseArgs, p_revoked: revoked });
      if (!marked.ok) return stop(500, 'FAILED', 'MARK_FAILED');
      if (record(marked.data).status === 'credentials_changed') return stop(409, 'CREDENTIALS_CHANGED', 'CREDENTIALS_CHANGED');
    } else if (found.status !== 'not_needed') {
      return stop(500, 'FAILED', 'CREDENTIALS_UNEXPECTED');
    }
  }

  // Apple: only once; the checkpoint makes a retry skip it (the code is single-use).
  if (apple && lease.apple_revoked !== true) {
    if (!appleCode || !deps.revokeApple) return stop(400, 'APPLE_REAUTH_REQUIRED', 'APPLE_CODE_MISSING');
    let ok = false;
    try {
      ok = await deps.revokeApple(appleCode, user.appleSubjects);
    } catch {
      ok = false;
    }
    if (!ok) return stop(502, 'APPLE_REVOKE_FAILED', 'APPLE_REVOKE_FAILED');
    const checkpoint = await deps.rpc('mark_apple_revoked', leaseArgs);
    if (!checkpoint.ok) return stop(500, 'FAILED', 'APPLE_CHECKPOINT_FAILED');
  }

  const stoppedAgain = await stopXPublishing();
  if (stoppedAgain) return stoppedAgain;
  const purge = await deps.rpc('purge', leaseArgs);
  if (leaseLost(purge)) return fail(409, 'DELETION_IN_PROGRESS');
  if (!purge.ok) {
    return purge.code === 'SOCIAL_MOBILE_DELETION_UNEXPECTED_DEPENDENT_DATA'
      ? stop(409, 'DELETION_BLOCKED_UNEXPECTED_DEPENDENT_DATA', 'UNEXPECTED_DEPENDENT_DATA')
      : stop(500, 'FAILED', 'PURGE_FAILED');
  }
  const purged = record(purge.data);
  if (purged.status === 'operator_required') return fail(409, 'DELETION_OPERATOR_REQUIRED');
  if (purged.status === 'apple_revoke_required') return stop(400, 'APPLE_REAUTH_REQUIRED', 'APPLE_REVOKE_REQUIRED');
  if (purged.status !== 'purged') return stop(500, 'FAILED', 'PURGE_NOT_READY');

  const finalize = await deps.rpc('finalize', leaseArgs);
  if (leaseLost(finalize)) return fail(409, 'DELETION_IN_PROGRESS');
  if (!finalize.ok) return stop(500, 'FINALIZE_FAILED', 'FINALIZE_FAILED');
  const done = record(finalize.data);
  if (done.status === 'operator_required') return fail(409, 'DELETION_OPERATOR_REQUIRED');
  if (done.status !== 'completed') return stop(500, 'FINALIZE_FAILED', 'FINALIZE_NOT_READY');
  return {
    status: 200,
    body: {
      ok: true,
      login_deleted: done.login_deleted === true,
      ...(done.reason === 'MAIN_APP_ACCOUNT_PRESENT' ? { login_kept_reason: 'MAIN_APP_ACCOUNT_PRESENT' } : {}),
      // Reservations whose X result was never known: reported, never hidden behind the success.
      ...(unconfirmedPosts > 0 ? { x_posts_unconfirmed: unconfirmedPosts } : {}),
    },
  };
}
