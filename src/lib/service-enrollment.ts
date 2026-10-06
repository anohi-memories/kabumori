// Common-account service enrollment (Phase 2). Every accepted Kabumori session is enrolled through the
// reviewed lifecycle RPC public.start_kabumori_service(): it creates the common account if missing, the
// active `kabumori` entitlement and the Kabumori profile row, atomically and idempotently, for
// auth.uid() only, and never restarts an ended service (20261006230000). This module holds the decision
// logic; it never consults a shared client, so a request can only ever carry the credential it started with.
//
// Rules (identical in both apps below this header; a test pins that):
//   * the server decides the lifecycle state in one atomic call -- there is no client read before it;
//   * every request is bound to the access token captured when it started, and is cancelled (never sent)
//     if the person signs out, or another person or another login of the same person starts, before dispatch;
//   * work and answers belong to one login (the token's session id), not merely to the person: a token
//     refresh keeps the login, a new sign-in of the same person does not inherit anything;
//   * an ended service is restarted only by reactivate_*_service(version), sent from the person's own
//     click with the version the server reported, once;
//   * only the exact canonical answers are accepted; anything else fails closed;
//   * no direct table write, no e-mail, no account merge, and each app enrolls only its own service.

export type EnrollmentServiceKey = 'kabumori' | 'x_autopost';

export type EnrollmentQueryError = { message: string; code?: string };
export type RpcResult = { data: unknown; error: EnrollmentQueryError | null };

/** Immutable request context, captured when the request starts. Its login is derived from the token itself. */
export type EnrollmentContext = { userId: string; accessToken: string };

/** Calls one RPC with a credential fixed at creation. */
export type RpcTransport = (fn: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<RpcResult>;

export type EnrollmentBlockReason =
  | 'ACCOUNT_DELETION_IN_PROGRESS'
  | 'ACCOUNT_LOCKED'
  | 'SERVICE_DELETION_IN_PROGRESS'
  | 'SERVICE_SUSPENDED'
  | 'SERVICE_NOT_READY'
  | 'ACCOUNT_NOT_FOUND'
  | 'UNKNOWN';

export type EnrollmentOutcome =
  /** Entitlement active. `sharedAccountNotice`: this call started the service on an account that already used another one. */
  | { kind: 'ready'; started: boolean; sharedAccountNotice: boolean }
  /** The service was ended; restarting it needs the person's explicit action at this lifecycle version. */
  | { kind: 'reenroll_required'; lifecycleVersion: number }
  /** The lifecycle refused the start (deletion in progress, locked, ...), or the answer was not understood. */
  | { kind: 'blocked'; reason: EnrollmentBlockReason };

/** A transient failure (network, server); nothing was decided, the caller may retry. */
export class EnrollmentUnavailableError extends Error {
  constructor(message = 'サービスの利用準備を確認できませんでした。') {
    super(message);
    this.name = 'EnrollmentUnavailableError';
  }
}

/** The request was cancelled before it was sent (sign-out, another person, a newer request). */
export class EnrollmentCancelledError extends Error {
  constructor() {
    super('enrollment request cancelled');
    this.name = 'EnrollmentCancelledError';
  }
}

const START_RPC: Record<EnrollmentServiceKey, string> = {
  kabumori: 'start_kabumori_service',
  x_autopost: 'start_x_autopost_service',
};
const REACTIVATE_RPC: Record<EnrollmentServiceKey, string> = {
  kabumori: 'reactivate_kabumori_service',
  x_autopost: 'reactivate_x_autopost_service',
};

const BLOCK_REASONS: readonly EnrollmentBlockReason[] = [
  'ACCOUNT_DELETION_IN_PROGRESS',
  'ACCOUNT_LOCKED',
  'SERVICE_DELETION_IN_PROGRESS',
  'SERVICE_SUSPENDED',
  'SERVICE_NOT_READY',
];

const UNKNOWN: EnrollmentOutcome = { kind: 'blocked', reason: 'UNKNOWN' };
/** A session whose login cannot be identified is never enrolled; the person signs in again. */
const LOGIN_UNIDENTIFIED: EnrollmentOutcome = { kind: 'blocked', reason: 'ACCOUNT_NOT_FOUND' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** base64url (unpadded) -> one character per byte; enough for JSON.parse of the ASCII claims read here. */
function decodeBase64Url(text: string): string {
  if (!/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) throw new Error('not base64url');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const char of text) {
    value = ((value << 6) | BASE64URL.indexOf(char)) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * The login an access token belongs to. Supabase Auth puts the session's UUID (`session_id`, a required
 * claim) in every access token of a sign-in; refreshing the token keeps the session, a new sign-in (or a
 * recovery link) starts a new one. The token is only decoded, not verified -- the server verifies it on
 * every request -- so the id only tells this device's logins apart. It stays in memory and is never logged
 * or stored. Null unless the token is well formed, belongs to exactly this person and names a session.
 */
export function loginSessionIdOf(userId: string, accessToken: string): string | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
  if (!isRecord(claims) || claims.sub !== userId || typeof claims.session_id !== 'string') return null;
  return SESSION_ID.test(claims.session_id) ? claims.session_id.toLowerCase() : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Strict reading of the canonical start / reactivate answers. Anything else is not "ready". */
export function parseServiceAnswer(service: EnrollmentServiceKey, data: unknown): EnrollmentOutcome {
  if (!isRecord(data)) return UNKNOWN;
  switch (data.status) {
    case 'active':
      if (hasExactKeys(data, ['status', 'service', 'started', 'shared_account'])
          && data.service === service && typeof data.started === 'boolean' && typeof data.shared_account === 'boolean') {
        return { kind: 'ready', started: data.started, sharedAccountNotice: data.started && data.shared_account };
      }
      return UNKNOWN;
    case 'reenroll_required':
    case 'lifecycle_changed': {
      const version = data.lifecycle_version;
      if (hasExactKeys(data, ['status', 'service', 'lifecycle_version']) && data.service === service
          && typeof version === 'number' && Number.isSafeInteger(version) && version >= 1) {
        return { kind: 'reenroll_required', lifecycleVersion: version };
      }
      return UNKNOWN;
    }
    case 'blocked': {
      const reason = BLOCK_REASONS.find((known) => known === data.reason);
      return hasExactKeys(data, ['status', 'reason']) && reason ? { kind: 'blocked', reason } : UNKNOWN;
    }
    default:
      // includes not_registered (a restart for a service that was never started): retry runs the automatic start
      return UNKNOWN;
  }
}

/** Errors the RPCs raise for a person whose login cannot be used (no auth.uid(), login removed). */
function isLoginGone(error: EnrollmentQueryError) {
  return /ACCOUNT_LIFECYCLE_(ACCOUNT_NOT_FOUND|AUTH_REQUIRED)/u.test(error.message);
}

function interpret(service: EnrollmentServiceKey, result: RpcResult): EnrollmentOutcome {
  if (result.error) {
    if (isLoginGone(result.error)) return { kind: 'blocked', reason: 'ACCOUNT_NOT_FOUND' };
    throw new EnrollmentUnavailableError();
  }
  return parseServiceAnswer(service, result.data);
}

/** The automatic start (every accepted session). The server never restarts an ended service here. */
export async function startServiceAutomatically(
  transport: RpcTransport, service: EnrollmentServiceKey, signal: AbortSignal,
): Promise<EnrollmentOutcome> {
  if (signal.aborted) throw new EnrollmentCancelledError();
  return interpret(service, await transport(START_RPC[service], {}, signal));
}

/** The explicit restart of an ended service, at the lifecycle version the person confirmed. */
export async function reactivateServiceExplicitly(
  transport: RpcTransport, service: EnrollmentServiceKey, lifecycleVersion: number, signal: AbortSignal,
): Promise<EnrollmentOutcome> {
  if (signal.aborted) throw new EnrollmentCancelledError();
  if (!Number.isSafeInteger(lifecycleVersion) || lifecycleVersion < 1) return UNKNOWN;
  return interpret(service, await transport(REACTIVATE_RPC[service], { p_expected_lifecycle_version: lifecycleVersion }, signal));
}

/**
 * PostgREST RPC over fetch with the Authorization fixed to one access token. The token is held only in
 * this closure for the request; it is never logged or stored.
 */
export function createSessionBoundTransport(options: {
  url: string;
  apiKey: string;
  accessToken: string;
  fetch?: typeof fetch;
}): RpcTransport {
  const base = options.url.replace(/\/+$/u, '');
  const send = options.fetch ?? fetch;
  return async (fn, args, signal) => {
    if (signal.aborted) throw new EnrollmentCancelledError();
    let response: Response;
    try {
      response = await send(`${base}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: options.apiKey,
          Authorization: `Bearer ${options.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(args),
        signal,
      });
    } catch {
      if (signal.aborted) throw new EnrollmentCancelledError();
      return { data: null, error: { message: 'network' } };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    // Cancelled while the answer was arriving: it belongs to work nobody waits for any more.
    if (signal.aborted) throw new EnrollmentCancelledError();
    if (!response.ok) {
      const detail = isRecord(body) ? body : {};
      return {
        data: null,
        error: {
          message: typeof detail.message === 'string' ? detail.message : `HTTP ${response.status}`,
          code: typeof detail.code === 'string' ? detail.code : undefined,
        },
      };
    }
    return { data: body, error: null };
  };
}

/**
 * One logical enrollment per login (person + the token's session id). Concurrent callers for the same login
 * -- including a refreshed token of it -- share one request; a decided outcome is reused until reset(). A
 * request for another person or another login of the same person, a newer request and reset() each abort
 * the previous one, so its unsent work is never sent and its answer reaches nobody. A token whose login
 * cannot be identified is never sent. Transient failures are not remembered.
 */
export function createEnrollmentGate(
  automatic: (context: EnrollmentContext, signal: AbortSignal) => Promise<EnrollmentOutcome>,
) {
  let current: { userId: string; sessionId: string; controller: AbortController; promise: Promise<EnrollmentOutcome> } | null = null;

  function begin(
    context: EnrollmentContext,
    run: (context: EnrollmentContext, signal: AbortSignal) => Promise<EnrollmentOutcome>,
  ) {
    current?.controller.abort();
    current = null;
    const sessionId = loginSessionIdOf(context.userId, context.accessToken);
    if (sessionId === null) return Promise.resolve(LOGIN_UNIDENTIFIED);
    const controller = new AbortController();
    const entry = { userId: context.userId, sessionId, controller, promise: run({ ...context }, controller.signal) };
    current = entry;
    entry.promise.catch(() => {
      if (current === entry) current = null;
    });
    return entry.promise;
  }

  return {
    ensure(context: EnrollmentContext) {
      if (current && current.userId === context.userId
          && current.sessionId === loginSessionIdOf(context.userId, context.accessToken)) {
        return current.promise;
      }
      return begin(context, automatic);
    },
    /** An explicit action of this login, sent now; it replaces (and cancels) whatever was pending. */
    explicit(
      context: EnrollmentContext,
      run: (context: EnrollmentContext, signal: AbortSignal) => Promise<EnrollmentOutcome>,
    ) {
      return begin(context, run);
    },
    reset() {
      current?.controller.abort();
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
