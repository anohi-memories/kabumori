// The X-specific port of the POSTONA end / common-account deletion flows (F3-owned contract, SOURCE CANDIDATE).
//
// G5/F5's orchestrator (account-delete, PR #178) owns the order and its own service-deletion lease; it calls the X
// saga (this function, `social-mobile-account-delete`) with THE PERSON'S OWN token, exactly like the X app:
//   POST {SUPABASE_URL}/functions/v1/social-mobile-account-delete
//     { action: 'preview' }                                                                   -> read-only scope / state
//     { action: 'delete', confirmation: 'DELETE_MY_ACCOUNT', expected_scope: 'social_only' } -> run or resume the saga
// xServiceEndRequest() is that COMPLETE body (the router refuses a body without action: 'delete' with 400
// ACTION_REQUIRED). The person is only ever the bearer token's user: the body never names a user.
// The saga holds ITS OWN deletion lease (social_mobile_account_deletions) and, inside it, stops X publishing
// (authority revoked, planned reservations cancelled) before any credential is read, revoked at X or removed.
// F3 does not read or verify F5's service-deletion lease: F5 checks its own lease right before and right after
// this call (as it does today) -- see the handoff in the F3 Report.
//
// xServiceEndOutcomeOf maps the saga's HTTP answer onto a TYPED outcome. Nothing ambiguous is ever 'done':
//   done                     -> X tokens revoked at X (X answered success), workspace purged, login kept
//                               (social_only). unconfirmedPosts > 0 = X posts whose result was never known
//                               (reconciliation needed; the person may have to check X). The count is DURABLE
//                               (checkpointed before the purge, keyed by the subject hash): a retry after a
//                               purge / finalize failure or a lease takeover still reports it, until the
//                               caller acknowledges it (social_mobile_account_deletion_x_unconfirmed_ack).
//   blocked + reason         -> typed and retryable unless noted: POSTING_IN_PROGRESS (X publishing is already
//                               stopped; retry when it settles), NON_X_ACCOUNT_PRESENT (remove the other providers
//                               first), SHARED_WORKSPACE / OWNS_OTHER_WORKSPACE / ADMIN_ACCOUNT /
//                               WORKSPACE_NOT_SELF_SERVICE / WORKSPACE_ROLE_MISMATCH (not by one person's word),
//                               CREDENTIAL_* / UNEXPECTED_DEPENDENT_DATA / UNKNOWN (stop; investigate)
//   operator_required        -> handed to an operator by the saga's own checks
//   reconciliation_required  -> X_REVOKE_FAILED (remote authorization NOT verified revoked), CREDENTIALS_CHANGED,
//                               FINALIZE_FAILED: the remote / local state must be read back before any retry decision
//   in_progress              -> another attempt holds the saga's lease
//   scope_refused            -> the saga would act in another scope (e.g. delete the login): never in this flow
//   auth_required            -> the person's token was refused / not recent enough
//   login_deleted            -> must never happen in scope social_only: treat as a verification failure
//   failed                   -> anything else (unknown body, 5xx)
import { BLOCK_REASONS, type BlockReason } from './delete_logic.ts';

export const X_SAGA_FUNCTION = 'social-mobile-account-delete';
export const X_SAGA_SCOPE = 'social_only' as const;

export type XServiceEndPurpose = 'postona_service_end' | 'common_account_deletion';

/** The complete HTTP body G5/F5 sends for both purposes (the purpose itself is F5's record; the saga does not need it). */
export type XServiceEndRequest = { action: 'delete'; confirmation: 'DELETE_MY_ACCOUNT'; expected_scope: typeof X_SAGA_SCOPE };

export type XServiceEndOutcome =
  | { status: 'done'; unconfirmedPosts: number }
  | { status: 'blocked'; reason: BlockReason; retryable: boolean }
  | { status: 'operator_required' }
  | { status: 'reconciliation_required'; reason: 'X_REVOKE_FAILED' | 'CREDENTIALS_CHANGED' | 'FINALIZE_FAILED' }
  | { status: 'in_progress' }
  | { status: 'scope_refused' }
  | { status: 'auth_required' }
  | { status: 'login_deleted' }
  | { status: 'failed' };

const RETRYABLE: ReadonlySet<BlockReason> = new Set(['POSTING_IN_PROGRESS', 'CREDENTIAL_REFRESH_IN_PROGRESS', 'NON_X_ACCOUNT_PRESENT']);

export function xServiceEndRequest(): XServiceEndRequest {
  return { action: 'delete', confirmation: 'DELETE_MY_ACCOUNT', expected_scope: X_SAGA_SCOPE };
}

export function xServiceEndOutcomeOf(status: number, body: unknown): XServiceEndOutcome {
  const data = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (status === 200 && data.ok === true) {
    if (data.login_deleted === true) return { status: 'login_deleted' };
    if (data.login_deleted !== false) return { status: 'failed' };
    const unconfirmed = data.x_posts_unconfirmed;
    if (unconfirmed !== undefined && !(typeof unconfirmed === 'number' && Number.isInteger(unconfirmed) && unconfirmed > 0)) return { status: 'failed' };
    return { status: 'done', unconfirmedPosts: typeof unconfirmed === 'number' ? unconfirmed : 0 };
  }
  const error = typeof data.error === 'string' ? data.error : '';
  if (error.startsWith('DELETION_BLOCKED_')) {
    const reason = error.slice('DELETION_BLOCKED_'.length);
    if (!(BLOCK_REASONS as readonly string[]).includes(reason)) return { status: 'failed' };
    return { status: 'blocked', reason: reason as BlockReason, retryable: RETRYABLE.has(reason as BlockReason) };
  }
  switch (error) {
    case 'DELETION_OPERATOR_REQUIRED': return { status: 'operator_required' };
    case 'X_REVOKE_FAILED':
    case 'CREDENTIALS_CHANGED':
    case 'FINALIZE_FAILED': return { status: 'reconciliation_required', reason: error };
    case 'DELETION_IN_PROGRESS': return { status: 'in_progress' };
    case 'SCOPE_CHANGED':
    case 'SCOPE_REQUIRED': return { status: 'scope_refused' };
    case 'AUTH_REQUIRED':
    case 'REAUTH_REQUIRED': return { status: 'auth_required' };
    default: return { status: 'failed' };
  }
}
