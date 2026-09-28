// Social-mobile self-service account deletion. SOURCE CANDIDATE -- not deployed;
// independent review is mandatory before deploy (new privileged boundary).
//
// Security model:
//   * The user is whoever the caller's own bearer token belongs to (GET
//     /auth/v1/user). The request body never names a user.
//   * Recent authentication is required: the token's newest `amr` timestamp
//     must be at most RECENT_AUTH_SECONDS old, and its `sub` must equal the
//     verified user id.
//   * An explicit confirmation constant must be sent.
//   * Order: pre-checks (no side effects) -> begin (posting authority off)
//     -> revoke X tokens at X -> revoke Apple grant (Sign in with Apple
//     users) -> purge workspace data + Vault secrets -> delete the auth user.
//     Every step is idempotent, so a failed request is retried from the top.
//   * Any failure stops the sequence and returns a fixed code; the client can
//     never show "deleted" unless the auth user deletion succeeded.
//   * Tokens, keys and server messages are never returned or logged. The
//     audit trail stores only a hash of the user id plus fixed codes.

export const CONFIRMATION = 'DELETE_MY_ACCOUNT';
export const RECENT_AUTH_SECONDS = 600;

export type DeletionErrorCode =
  | 'AUTH_REQUIRED'
  | 'CONFIRMATION_REQUIRED'
  | 'REAUTH_REQUIRED'
  | 'APPLE_REVOCATION_UNAVAILABLE'
  | 'APPLE_REAUTH_REQUIRED'
  | 'APPLE_REVOKE_FAILED'
  | `DELETION_BLOCKED_${BlockReason}`
  | 'X_REVOKE_FAILED'
  | 'PURGE_FAILED'
  | 'AUTH_DELETE_FAILED'
  | 'FAILED';

export const BLOCK_REASONS = [
  'ADMIN_ACCOUNT', 'OWNS_OTHER_WORKSPACE', 'WORKSPACE_NOT_SELF_SERVICE', 'SHARED_WORKSPACE',
  'WORKSPACE_ROLE_MISMATCH', 'POSTING_IN_PROGRESS', 'CREDENTIAL_REFRESH_IN_PROGRESS', 'UNEXPECTED_DEPENDENT_DATA', 'UNKNOWN',
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/** providers and Apple subjects come from the server's view of the user's identities. */
export type VerifiedUser = { id: string; providers: readonly string[]; appleSubjects: readonly string[] };
export type RpcResult = { ok: true; data: unknown } | { ok: false; code: string | null };
export type AuditStep = 'requested' | 'blocked' | 'credentials_revoked' | 'auth_user_deleted' | 'failed';

export type DeletionDeps = {
  getUser: (token: string) => Promise<VerifiedUser | null>;
  rpc: (name: 'begin' | 'credentials' | 'purge' | 'record', args: Record<string, unknown>) => Promise<RpcResult>;
  revokeX: (token: string, hint: 'access_token' | 'refresh_token') => Promise<boolean>;
  /** null when Sign in with Apple revocation is not configured on the server. */
  revokeApple: ((authorizationCode: string, expectedSubjects: readonly string[]) => Promise<boolean>) | null;
  deleteAuthUser: (userId: string) => Promise<boolean>;
  nowSeconds: () => number;
};

export type DeletionResponse = { status: number; body: { ok: true } | { ok: false; error: DeletionErrorCode } };

const fail = (status: number, error: DeletionErrorCode): DeletionResponse => ({ status, body: { ok: false, error } });

export function bearerToken(header: string | null): string | null {
  const match = header ? /^Bearer\s+(\S+)$/iu.exec(header.trim()) : null;
  return match ? match[1] : null;
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const claims = JSON.parse(json);
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

/** Our fixed exception codes from the DB boundary; anything else is not trusted. */
function purgeFailure(code: string | null): DeletionResponse {
  if (code === 'SOCIAL_MOBILE_DELETION_UNEXPECTED_DEPENDENT_DATA') return fail(409, 'DELETION_BLOCKED_UNEXPECTED_DEPENDENT_DATA');
  const blocked = code?.startsWith('SOCIAL_MOBILE_DELETION_BLOCKED_') ? code.slice('SOCIAL_MOBILE_DELETION_BLOCKED_'.length) : null;
  if (blocked) return fail(409, `DELETION_BLOCKED_${blockReason(blocked)}`);
  return fail(500, 'PURGE_FAILED');
}

export async function handleAccountDeletion(
  input: { authorization: string | null; body: unknown },
  deps: DeletionDeps,
): Promise<DeletionResponse> {
  const token = bearerToken(input.authorization);
  if (!token) return fail(401, 'AUTH_REQUIRED');
  let user: VerifiedUser | null;
  try {
    user = await deps.getUser(token);
  } catch {
    user = null;
  }
  if (!user) return fail(401, 'AUTH_REQUIRED');

  const body = (typeof input.body === 'object' && input.body !== null ? input.body : {}) as { confirmation?: unknown; apple_authorization_code?: unknown };
  if (body.confirmation !== CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');

  const authenticatedAt = lastAuthenticatedAt(token, user.id);
  if (authenticatedAt === null || deps.nowSeconds() - authenticatedAt > RECENT_AUTH_SECONDS) return fail(403, 'REAUTH_REQUIRED');

  // Sign in with Apple users: the Apple grant must be revoked, so refuse up front
  // (before anything changes) when that is not possible.
  const usesApple = user.providers.includes('apple');
  const appleCode = typeof body.apple_authorization_code === 'string' && body.apple_authorization_code.length > 0 ? body.apple_authorization_code : null;
  if (usesApple && !deps.revokeApple) return fail(409, 'APPLE_REVOCATION_UNAVAILABLE');
  if (usesApple && !appleCode) return fail(400, 'APPLE_REAUTH_REQUIRED');

  const userId = user.id;
  const record = async (step: AuditStep, reason: string | null = null) => {
    try {
      await deps.rpc('record', { p_user_id: userId, p_step: step, p_reason_code: reason });
    } catch {
      // The audit trail is best effort; it never changes the outcome.
    }
  };
  await record('requested');

  const begin = await deps.rpc('begin', { p_user_id: userId });
  if (!begin.ok) { await record('failed', 'BEGIN_FAILED'); return fail(500, 'FAILED'); }
  const started = (begin.data ?? {}) as { status?: unknown; reason?: unknown };
  if (started.status === 'blocked') return fail(409, `DELETION_BLOCKED_${blockReason(started.reason)}`);
  if (started.status !== 'ready') { await record('failed', 'BEGIN_UNEXPECTED'); return fail(500, 'FAILED'); }

  const credentials = await deps.rpc('credentials', { p_user_id: userId });
  if (!credentials.ok || !Array.isArray(credentials.data)) { await record('failed', 'CREDENTIALS_FAILED'); return fail(500, 'FAILED'); }
  for (const row of credentials.data as { refresh_token?: unknown; access_token?: unknown }[]) {
    for (const [value, hint] of [[row.refresh_token, 'refresh_token'], [row.access_token, 'access_token']] as const) {
      if (typeof value !== 'string' || value.length === 0) continue;
      let revoked = false;
      try {
        revoked = await deps.revokeX(value, hint);
      } catch {
        revoked = false;
      }
      if (!revoked) { await record('failed', 'X_REVOKE_FAILED'); return fail(502, 'X_REVOKE_FAILED'); }
    }
  }
  await record('credentials_revoked');

  if (usesApple && deps.revokeApple && appleCode) {
    let revoked = false;
    try {
      revoked = await deps.revokeApple(appleCode, user.appleSubjects);
    } catch {
      revoked = false;
    }
    if (!revoked) { await record('failed', 'APPLE_REVOKE_FAILED'); return fail(502, 'APPLE_REVOKE_FAILED'); }
  }

  const purge = await deps.rpc('purge', { p_user_id: userId });
  if (!purge.ok) { await record('failed', 'PURGE_FAILED'); return purgeFailure(purge.code); }

  let deleted = false;
  try {
    deleted = await deps.deleteAuthUser(userId);
  } catch {
    deleted = false;
  }
  if (!deleted) { await record('failed', 'AUTH_DELETE_FAILED'); return fail(500, 'AUTH_DELETE_FAILED'); }
  await record('auth_user_deleted');
  return { status: 200, body: { ok: true } };
}
