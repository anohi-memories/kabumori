// Common-account service enrollment (Phase 2). Every accepted X autopost session is enrolled through the
// reviewed lifecycle RPC public.start_x_autopost_service(): it creates the common account if missing and
// the active `x_autopost` entitlement, atomically and idempotently, for auth.uid() only. It creates no
// workspace, social account, OAuth state or credential: posting authorization stays the separate "Xを接続"
// flow. This module holds the decision logic; the Supabase calls come in through EnrollmentClient.
//
// What it never does: write common_accounts / service_entitlements directly, look at e-mail, merge
// accounts, or start a service that the person ended (an `ended` entitlement is restarted only by an
// explicit user action, `allowReenroll`).

export type EnrollmentServiceKey = 'kabumori' | 'x_autopost';

export type EnrollmentQueryError = { message: string; code?: string };
export type EnrollmentQueryResult<T> = { data: T | null; error: EnrollmentQueryError | null };

export type EntitlementRow = { service_key: string; status: string };

export interface EnrollmentClient {
  /** The caller's own entitlement rows (RLS: service_entitlements_select_own). */
  readOwnEntitlements(): PromiseLike<EnrollmentQueryResult<EntitlementRow[]>>;
  /** The reviewed start RPC for this app's service, called with the user's JWT. */
  startService(): PromiseLike<EnrollmentQueryResult<unknown>>;
}

export type EnrollmentBlockReason =
  | 'ACCOUNT_DELETION_IN_PROGRESS'
  | 'ACCOUNT_LOCKED'
  | 'SERVICE_DELETION_IN_PROGRESS'
  | 'SERVICE_SUSPENDED'
  | 'SERVICE_NOT_READY'
  | 'ACCOUNT_NOT_FOUND'
  | 'UNKNOWN';

export type EnrollmentOutcome =
  /** Entitlement active. `sharedAccountNotice`: this start added the service to an account that already used another one. */
  | { kind: 'ready'; started: boolean; sharedAccountNotice: boolean }
  /** The person ended this service earlier; restarting it needs their explicit action. */
  | { kind: 'reenroll_required' }
  /** The lifecycle refused the start (deletion in progress, locked, ...). Fail closed. */
  | { kind: 'blocked'; reason: EnrollmentBlockReason };

/** A transient failure (network, server); nothing was decided, the caller may retry. */
export class EnrollmentUnavailableError extends Error {
  constructor(message = 'サービスの利用準備を確認できませんでした。') {
    super(message);
    this.name = 'EnrollmentUnavailableError';
  }
}

const BLOCK_REASONS: readonly EnrollmentBlockReason[] = [
  'ACCOUNT_DELETION_IN_PROGRESS',
  'ACCOUNT_LOCKED',
  'SERVICE_DELETION_IN_PROGRESS',
  'SERVICE_SUSPENDED',
  'SERVICE_NOT_READY',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Errors the RPC raises for a person whose login cannot be used (no auth.uid(), login removed). */
function isLoginGone(error: EnrollmentQueryError) {
  return /ACCOUNT_LIFECYCLE_(ACCOUNT_NOT_FOUND|AUTH_REQUIRED)/u.test(error.message);
}

export async function enrollService(
  client: EnrollmentClient,
  service: EnrollmentServiceKey,
  options: { allowReenroll?: boolean } = {},
): Promise<EnrollmentOutcome> {
  const read = await client.readOwnEntitlements();
  if (read.error) throw new EnrollmentUnavailableError();
  const rows = Array.isArray(read.data) ? read.data : [];
  const own = rows.find((row) => row.service_key === service);
  const otherActive = rows.some((row) => row.service_key !== service && row.status === 'active');

  if (own?.status === 'ended' && !options.allowReenroll) return { kind: 'reenroll_required' };

  const start = await client.startService();
  if (start.error) {
    if (isLoginGone(start.error)) return { kind: 'blocked', reason: 'ACCOUNT_NOT_FOUND' };
    throw new EnrollmentUnavailableError();
  }
  const result = start.data;
  if (isRecord(result) && result.status === 'active' && result.service === service) {
    const started = result.started === true;
    return { kind: 'ready', started, sharedAccountNotice: started && !own && otherActive };
  }
  if (isRecord(result) && result.status === 'blocked') {
    const reason = BLOCK_REASONS.find((known) => known === result.reason) ?? 'UNKNOWN';
    return { kind: 'blocked', reason };
  }
  // An answer this client does not understand is never treated as "ready".
  return { kind: 'blocked', reason: 'UNKNOWN' };
}

/**
 * One logical enrollment per signed-in person: concurrent callers (sign-in, the initial session,
 * every auth-state event) share the same request, and a decided outcome is reused until reset()
 * (sign-out, user change, an explicit retry). Transient failures are not remembered.
 */
export function createEnrollmentGate(run: (allowReenroll: boolean) => Promise<EnrollmentOutcome>) {
  let current: { userId: string; promise: Promise<EnrollmentOutcome> } | null = null;

  function start(userId: string, allowReenroll: boolean) {
    const entry = { userId, promise: run(allowReenroll) };
    current = entry;
    entry.promise.catch(() => {
      if (current === entry) current = null;
    });
    return entry.promise;
  }

  return {
    ensure(userId: string) {
      if (current && current.userId === userId) return current.promise;
      return start(userId, false);
    },
    /** The person chose to use the service again after ending it. */
    reenroll(userId: string) {
      return start(userId, true);
    },
    reset() {
      current = null;
    },
  };
}

export const ENROLLMENT_NOTICE = '共通IDはお持ちです。このサービスの利用登録を行いました。';

/** Japanese copy for a refused start: what happened and what the person can do. */
export function enrollmentBlockedCopy(reason: EnrollmentBlockReason): { title: string; description: string; canRetry: boolean } {
  switch (reason) {
    case 'ACCOUNT_DELETION_IN_PROGRESS':
      return { title: '共通IDの削除手続き中です', description: '削除手続き中のため、このサービスは利用できません。', canRetry: false };
    case 'ACCOUNT_LOCKED':
      return { title: '共通IDが利用停止中です', description: 'このIDは現在利用が停止されています。お問い合わせください。', canRetry: false };
    case 'SERVICE_DELETION_IN_PROGRESS':
      return { title: '退会手続き中です', description: 'このサービスの退会手続きが進行中です。完了までお待ちください。', canRetry: false };
    case 'SERVICE_SUSPENDED':
      return { title: 'このサービスは利用停止中です', description: 'このサービスの利用が一時的に停止されています。お問い合わせください。', canRetry: false };
    case 'SERVICE_NOT_READY':
      return { title: '利用準備が完了していません', description: 'しばらくしてから、もう一度お試しください。', canRetry: true };
    case 'ACCOUNT_NOT_FOUND':
      return { title: 'ログイン情報が無効です', description: 'もう一度ログインしてください。', canRetry: false };
    default:
      return { title: '利用状態を確認できませんでした', description: '時間をおいて、もう一度お試しください。', canRetry: true };
  }
}

export const REENROLL_COPY = {
  title: 'このサービスは退会済みです',
  description: '共通IDはお持ちです。もう一度このサービスを使うには、利用登録をやり直してください。',
  action: '利用登録する',
} as const;
