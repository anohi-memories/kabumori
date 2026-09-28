/**
 * Pure contracts for app sign-in (Supabase Auth). This is only about how the
 * user logs into the app. The X account used for auto-posting is a separate
 * consent and credential path (x-oauth-connect-user + Vault); nothing here
 * ever touches a posting credential or a provider access/refresh token.
 */

export type AuthProviderId = 'x' | 'apple' | 'google' | 'email';

/** Deep link for Supabase Auth returns (OAuth sign-in, e-mail confirmation, recovery, linking). */
export const AUTH_CALLBACK_URL = 'kabumori-social://auth-callback';
/** The posting-account X connect return; never handled as an auth callback. */
export const POSTING_CALLBACK_URL = 'kabumori-social://oauth-callback';

export type AuthCallback =
  | { kind: 'code'; code: string }
  | { kind: 'token_hash'; tokenHash: string; type: 'signup' | 'recovery' | 'email_change' | 'email' | 'invite' | 'magiclink' }
  | { kind: 'error'; errorCode: string }
  | { kind: 'invalid' };

const OTP_TYPES = new Set(['signup', 'recovery', 'email_change', 'email', 'invite', 'magiclink']);
const SAFE_CODE = /^[A-Za-z0-9_-]{1,512}$/u;

/**
 * Parses a Supabase Auth redirect back into the app. Only the exact auth
 * callback URL is accepted (not the posting callback, not another scheme or
 * path). Values from both the query and the fragment are read; nothing else
 * from the URL is trusted.
 */
export function parseAuthCallbackUrl(url: string): AuthCallback {
  let parsed: URL;
  let expected: URL;
  try {
    parsed = new URL(url);
    expected = new URL(AUTH_CALLBACK_URL);
  } catch {
    return { kind: 'invalid' };
  }
  if (parsed.protocol !== expected.protocol || parsed.hostname !== expected.hostname
      || parsed.pathname.replace(/\/$/u, '') !== expected.pathname.replace(/\/$/u, '')) {
    return { kind: 'invalid' };
  }
  const params = new URLSearchParams(parsed.search);
  new URLSearchParams(parsed.hash.replace(/^#/u, '')).forEach((value, key) => { if (!params.has(key)) params.set(key, value); });
  const error = params.get('error_code') ?? params.get('error');
  if (error) return { kind: 'error', errorCode: SAFE_CODE.test(error) ? error : 'unknown_error' };
  const code = params.get('code');
  if (code) return SAFE_CODE.test(code) ? { kind: 'code', code } : { kind: 'invalid' };
  const tokenHash = params.get('token_hash');
  const type = params.get('type');
  if (tokenHash && type && OTP_TYPES.has(type) && SAFE_CODE.test(tokenHash)) {
    return { kind: 'token_hash', tokenHash, type: type as Extract<AuthCallback, { kind: 'token_hash' }>['type'] };
  }
  return { kind: 'invalid' };
}

export type SignUpOutcome = 'signed_in' | 'confirmation_sent' | 'check_inbox_or_sign_in';

/**
 * Supabase hides whether an e-mail is already registered: an existing address
 * returns a user with no identities and no session. Never reveal the
 * difference to the user beyond a neutral next step.
 */
export function classifySignUp(result: { session: unknown; user: { identities?: unknown[] | null } | null }): SignUpOutcome {
  if (result.session) return 'signed_in';
  if (result.user && Array.isArray(result.user.identities) && result.user.identities.length === 0) return 'check_inbox_or_sign_in';
  return 'confirmation_sent';
}

export type BrowserAuthResult = { type: string; url?: string };
export type BrowserOutcome = { kind: 'callback'; url: string } | { kind: 'cancelled' } | { kind: 'failed' };

export function classifyBrowserResult(result: BrowserAuthResult): BrowserOutcome {
  if (result.type === 'cancel' || result.type === 'dismiss') return { kind: 'cancelled' };
  if (result.type === 'success' && typeof result.url === 'string') return { kind: 'callback', url: result.url };
  return { kind: 'failed' };
}

/** Apple native sign-in cancellation (expo-apple-authentication). */
export function isAppleCancel(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_REQUEST_CANCELED';
}

export type ProviderAvailability = Record<AuthProviderId, boolean> & { signupDisabled: boolean };

/**
 * Reads GET /auth/v1/settings (public). A provider is offered only when the
 * project really has it enabled; unknown/invalid settings disable every
 * provider rather than faking availability.
 */
export function providerAvailability(settings: unknown): ProviderAvailability {
  const none: ProviderAvailability = { x: false, apple: false, google: false, email: false, signupDisabled: true };
  if (typeof settings !== 'object' || settings === null) return none;
  const record = settings as { external?: unknown; disable_signup?: unknown };
  if (typeof record.external !== 'object' || record.external === null) return none;
  const external = record.external as Record<string, unknown>;
  return {
    x: external.x === true,
    apple: external.apple === true,
    google: external.google === true,
    email: external.email === true,
    signupDisabled: record.disable_signup === true,
  };
}

const AUTH_MESSAGES: Record<string, string> = {
  identity_already_exists: 'このログイン方法は、すでに別のアカウントで使われています。そのアカウントでログインしてください。',
  manual_linking_disabled: 'ログイン方法の追加は、まだ有効になっていません。',
  single_identity_not_deletable: '最後のログイン方法は解除できません。',
  email_exists: 'このメールアドレスでは登録できません。ログインまたはパスワード再設定をお試しください。',
  user_already_exists: 'このメールアドレスでは登録できません。ログインまたはパスワード再設定をお試しください。',
  weak_password: 'パスワードが短すぎるか、推測されやすい可能性があります。8文字以上で設定してください。',
  same_password: '以前と異なるパスワードを設定してください。',
  signup_disabled: '現在、新規登録を受け付けていません。',
  provider_disabled: 'このログイン方法は、まだ有効になっていません。',
  otp_expired: 'リンクの有効期限が切れています。もう一度お試しください。',
  flow_state_expired: 'ログインの有効期限が切れました。もう一度お試しください。',
  flow_state_not_found: 'ログインを完了できませんでした。同じ端末でもう一度お試しください。',
  bad_code_verifier: 'ログインを完了できませんでした。同じ端末でもう一度お試しください。',
  access_denied: 'ログインがキャンセルされました。',
  over_email_send_rate_limit: 'メールの送信回数が多すぎます。しばらく待ってから再度お試しください。',
  over_request_rate_limit: '試行回数が多すぎます。しばらく待ってから再度お試しください。',
};

/** Fixed Japanese messages; the provider/server text is never shown. */
export function authFlowMessage(errorCode: string | null | undefined): string {
  return (errorCode && AUTH_MESSAGES[errorCode]) ?? 'ログインを完了できませんでした。時間をおいて再度お試しください。';
}

export function validateNewPassword(password: string, confirmation: string): { ok: true } | { ok: false; message: string } {
  if (password.length < 8) return { ok: false, message: 'パスワードは8文字以上にしてください。' };
  if (password.length > 72) return { ok: false, message: 'パスワードは72文字以内にしてください。' };
  if (password !== confirmation) return { ok: false, message: '確認用のパスワードが一致しません。' };
  return { ok: true };
}

export type AuthIdentitySummary = { provider: string; createdAt?: string | null };

/**
 * A just-created account from a social provider with no workspace yet: tell
 * the user before any workspace is created, so an accidental second account
 * (e.g. X login that returned no e-mail) is noticed instead of silently used.
 */
export function shouldShowNewAccountNotice(input: {
  identities: readonly AuthIdentitySummary[];
  userCreatedAt: string | null | undefined;
  hasWorkspace: boolean;
  acknowledged: boolean;
  now: number;
}): boolean {
  if (input.hasWorkspace || input.acknowledged || input.identities.length !== 1) return false;
  if (input.identities[0].provider === 'email') return false;
  const created = input.userCreatedAt ? Date.parse(input.userCreatedAt) : NaN;
  return Number.isFinite(created) && input.now - created < 30 * 60_000;
}

export const PROVIDER_LABELS: Record<AuthProviderId, string> = {
  x: 'X',
  apple: 'Apple',
  google: 'Google',
  email: 'メールアドレス',
};
