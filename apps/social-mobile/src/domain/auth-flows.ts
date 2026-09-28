/**
 * Pure contracts for app sign-in (Supabase Auth). This is only about how the
 * user logs into the app. The X account used for auto-posting is a separate
 * consent and credential path (x-oauth-connect-user + Vault); nothing here
 * ever touches a posting credential or a provider access/refresh token.
 *
 * No runtime imports: this module is executed directly by the node:test
 * suites against the real supabase-js client.
 */

export type AuthProviderId = 'x' | 'apple' | 'google' | 'email';
export type SocialProviderId = Exclude<AuthProviderId, 'email'>;

/** Deep link for Supabase Auth returns (OAuth sign-in, e-mail confirmation, recovery, linking). */
export const AUTH_CALLBACK_URL = 'kabumori-social://auth-callback';
/** The posting-account X connect return; never handled as an auth callback. */
export const POSTING_CALLBACK_URL = 'kabumori-social://oauth-callback';

// ---------------------------------------------------------------------------
// Callback parsing (exact authority, documented fields only, no ambiguity)
// ---------------------------------------------------------------------------

export type OtpType = 'signup' | 'recovery' | 'email_change' | 'email' | 'invite' | 'magiclink';
export type AuthCallback =
  | { kind: 'code'; code: string; flowId: string }
  | { kind: 'token_hash'; tokenHash: string; type: OtpType; flowId: string | null }
  | { kind: 'error'; errorCode: string; flowId: string | null }
  | { kind: 'invalid' };

const OTP_TYPES: ReadonlySet<string> = new Set(['signup', 'recovery', 'email_change', 'email', 'invite', 'magiclink']);
/** Supabase Auth callback fields (PKCE code + reserved flow id, e-mail token hash, error). */
const CALLBACK_FIELDS: ReadonlySet<string> = new Set(['code', 'sb_flow_id', 'token_hash', 'type', 'error', 'error_code', 'error_description']);
const SAFE_VALUE = /^[A-Za-z0-9_-]{1,512}$/u;
/** Same shape auth-js validates for its PKCE flow ids. */
export const FLOW_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;

function isExactCallbackAuthority(parsed: URL, expected: URL): boolean {
  return parsed.protocol === expected.protocol
    && parsed.username === '' && parsed.password === ''
    && parsed.hostname === expected.hostname && parsed.port === ''
    && (parsed.pathname === '' || parsed.pathname === '/');
}

/**
 * Parses a Supabase Auth redirect back into the app. Fails closed on:
 * another scheme/host/path, userinfo, a port, unknown fields (incl. implicit
 * access_token returns), any field repeated in or across query and fragment,
 * both a code and a token hash, a code without a valid flow id, malformed
 * values.
 */
export function parseAuthCallbackUrl(url: string): AuthCallback {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isExactCallbackAuthority(parsed, new URL(AUTH_CALLBACK_URL))) return { kind: 'invalid' };
  const values = new Map<string, string>();
  const sources = [parsed.search.replace(/^\?/u, ''), parsed.hash.replace(/^#/u, '')];
  for (const source of sources) {
    for (const [key, value] of new URLSearchParams(source)) {
      if (!CALLBACK_FIELDS.has(key) || values.has(key)) return { kind: 'invalid' };
      values.set(key, value);
    }
  }
  const rawFlow = values.get('sb_flow_id');
  if (rawFlow !== undefined && !FLOW_ID_PATTERN.test(rawFlow)) return { kind: 'invalid' };
  const flowId = rawFlow ?? null;
  const error = values.get('error_code') ?? values.get('error');
  const code = values.get('code');
  const tokenHash = values.get('token_hash');
  const type = values.get('type');
  const credentialCount = [code, tokenHash].filter((value) => value !== undefined).length;
  if (error !== undefined) {
    if (credentialCount > 0) return { kind: 'invalid' };
    return { kind: 'error', errorCode: SAFE_VALUE.test(error) ? error : 'unknown_error', flowId };
  }
  if (credentialCount !== 1) return { kind: 'invalid' };
  if (code !== undefined) {
    // A PKCE code is only usable with its own flow's verifier: no fallback to the latest one.
    if (type !== undefined || !flowId || !SAFE_VALUE.test(code)) return { kind: 'invalid' };
    return { kind: 'code', code, flowId };
  }
  if (tokenHash === undefined || type === undefined || !OTP_TYPES.has(type) || !SAFE_VALUE.test(tokenHash)) return { kind: 'invalid' };
  return { kind: 'token_hash', tokenHash, type: type as OtpType, flowId };
}

// ---------------------------------------------------------------------------
// Callback completion: one real outcome per credential, shared by duplicates
// ---------------------------------------------------------------------------

export type AuthFlowResult = { ok: true; userId: string | null } | { ok: false; cancelled?: boolean; message: string };

/** The subset of the Supabase client used to complete a callback. */
export type CallbackAuthClient = {
  auth: {
    exchangeCodeForSession(code: string, options?: { flowId?: string }): Promise<{ data: { session: { user: { id: string } } | null } | null; error: { code?: string } | null }>;
    verifyOtp(params: { token_hash: string; type: OtpType }): Promise<{ data: { session: { user: { id: string } } | null } | null; error: { code?: string } | null }>;
  };
};

export type CallbackExpectation = { flowId?: string | null };

const MAX_REMEMBERED = 32;
type RememberedOutcome = { context: string; promise: Promise<AuthFlowResult>; pending: boolean };
const outcomes = new Map<string, RememberedOutcome>();

function errorCodeOf(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : null;
  return typeof code === 'string' ? code : null;
}

/**
 * Completes one Supabase Auth return. The same code/token hash delivered
 * twice (in-app browser result and OS deep link) shares the one real exchange
 * and gets its real result — never an assumed success. A caller that started
 * a specific flow must receive that flow's callback.
 */
export function completeAuthCallback(client: CallbackAuthClient, callback: AuthCallback, expectation: CallbackExpectation = {}): Promise<AuthFlowResult> {
  if (callback.kind === 'invalid') return Promise.resolve({ ok: false, message: authFlowMessage(null) });
  if (callback.kind === 'error') {
    return Promise.resolve({ ok: false, cancelled: callback.errorCode === 'access_denied', message: authFlowMessage(callback.errorCode) });
  }
  if (expectation.flowId !== undefined && callback.flowId !== expectation.flowId) {
    return Promise.resolve({ ok: false, message: authFlowMessage('flow_state_not_found') });
  }
  const key = callback.kind === 'code' ? `code:${callback.code}` : `otp:${callback.tokenHash}`;
  const context = callback.kind === 'code' ? callback.flowId : `${callback.type}:${callback.flowId ?? ''}`;
  const existing = outcomes.get(key);
  // A duplicate must represent the same flow/type, not just the same credential.
  // Refuse conflicting replays before they can borrow a result or consume a verifier.
  if (existing) return existing.context === context
    ? existing.promise
    : Promise.resolve({ ok: false, message: authFlowMessage('flow_state_not_found') });
  if (outcomes.size >= MAX_REMEMBERED) {
    // Never evict an exchange in flight: its duplicate must still share it.
    const settled = [...outcomes].find(([, entry]) => !entry.pending);
    if (!settled) return Promise.resolve({ ok: false, message: authFlowMessage(null) });
    outcomes.delete(settled[0]);
  }
  const outcome = (async (): Promise<AuthFlowResult> => {
    try {
      const { data, error } = callback.kind === 'code'
        ? await client.auth.exchangeCodeForSession(callback.code, { flowId: callback.flowId })
        : await client.auth.verifyOtp({ token_hash: callback.tokenHash, type: callback.type });
      if (error) return { ok: false, message: authFlowMessage(errorCodeOf(error)) };
      return { ok: true, userId: data?.session?.user.id ?? null };
    } catch {
      return { ok: false, message: authFlowMessage(null) };
    }
  })();
  const entry: RememberedOutcome = { context, promise: outcome, pending: true };
  outcomes.set(key, entry);
  void outcome.then(() => { entry.pending = false; });
  return outcome;
}

/** Test/support hook: forget remembered outcomes (e.g. on sign-out). */
export function forgetAuthCallbackOutcomes(): void {
  outcomes.clear();
}

// ---------------------------------------------------------------------------
// Where the in-app browser may go
// ---------------------------------------------------------------------------

function strictHttps(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Sign-in starts at the project's own Supabase Auth authorize endpoint. */
export function isAllowedSignInUrl(url: string, supabaseHost: string): boolean {
  const parsed = strictHttps(url);
  return parsed !== null && parsed.host === supabaseHost && parsed.pathname === '/auth/v1/authorize';
}

const PROVIDER_AUTHORIZE_HOSTS: Record<SocialProviderId, readonly string[]> = {
  google: ['accounts.google.com'],
  x: ['x.com', 'twitter.com'],
  apple: ['appleid.apple.com'],
};
const PROVIDER_AUTHORIZE_PATHS: Record<SocialProviderId, readonly string[]> = {
  google: ['/o/oauth2/v2/auth', '/o/oauth2/auth'],
  x: ['/i/oauth2/authorize'],
  apple: ['/auth/authorize'],
};

/**
 * Authenticated linking (linkIdentity) returns the provider's own authorize
 * URL. Accept it only for that provider's authorize host, and only when the
 * provider will send the result back to this project's Supabase Auth callback.
 */
export function isAllowedLinkUrl(url: string, provider: SocialProviderId, supabaseHost: string): boolean {
  const parsed = strictHttps(url);
  if (!parsed || !PROVIDER_AUTHORIZE_HOSTS[provider].includes(parsed.hostname)) return false;
  if (!PROVIDER_AUTHORIZE_PATHS[provider].includes(parsed.pathname)) return false;
  const redirects = parsed.searchParams.getAll('redirect_uri');
  return redirects.length === 1 && redirects[0] === `https://${supabaseHost}/auth/v1/callback`;
}

// ---------------------------------------------------------------------------
// Outcomes and messages
// ---------------------------------------------------------------------------

/**
 * Supabase hides whether an e-mail is already registered. Every no-session
 * sign-up outcome — new address, obfuscated existing address, or an explicit
 * "already registered" error — gets the same neutral next step.
 */
export type SignUpOutcome = 'signed_in' | 'check_email';
export const SIGN_UP_CHECK_EMAIL_MESSAGE =
  '確認メールを送信しました。メール内のリンクをこの端末で開いてください。届かない場合は、ログインまたはパスワード再設定をお試しください。';
const ENUMERATING_SIGN_UP_ERRORS: ReadonlySet<string> = new Set(['email_exists', 'user_already_exists', 'identity_already_exists']);

export function classifySignUp(result: { session: unknown; user: unknown }): SignUpOutcome {
  return result.session ? 'signed_in' : 'check_email';
}

/** An error that would reveal an existing account is reported as the neutral outcome. */
export function signUpErrorIsNeutral(errorCode: string | null | undefined): boolean {
  return typeof errorCode === 'string' && ENUMERATING_SIGN_UP_ERRORS.has(errorCode);
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

const AUTH_MESSAGES: Record<string, string> = {
  identity_already_exists: 'このログイン方法は、すでに別のアカウントで使われています。そのアカウントでログインしてください。',
  manual_linking_disabled: 'ログイン方法の追加は、まだ有効になっていません。',
  single_identity_not_deletable: '最後のログイン方法は解除できません。',
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
  link_user_mismatch: 'ログイン方法を追加できませんでした。もう一度ログインしてからお試しください。',
  recovery_context_lost: '再設定のリンクからやり直してください。',
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

// ---------------------------------------------------------------------------
// Provider readiness (enabled on the project x configured for this build)
// ---------------------------------------------------------------------------

export type ProviderSettings = { external: Record<AuthProviderId, boolean>; signupDisabled: boolean } | null;

/** GET /auth/v1/settings → enabled flags; anything unreadable is null (unknown). */
export function parseAuthSettings(settings: unknown): ProviderSettings {
  if (typeof settings !== 'object' || settings === null) return null;
  const record = settings as { external?: unknown; disable_signup?: unknown };
  if (typeof record.external !== 'object' || record.external === null) return null;
  const external = record.external as Record<string, unknown>;
  return {
    external: { x: external.x === true, apple: external.apple === true, google: external.google === true, email: external.email === true },
    signupDisabled: record.disable_signup !== false,
  };
}

export type BuildAuthConfig = {
  /** EXPO_PUBLIC_AUTH_PROVIDERS: providers the operator configured for this build (email/x/google/apple/apple_web). */
  configured: ReadonlySet<string>;
  platform: 'ios' | 'android' | 'web' | string;
  nativeAppleAvailable: boolean;
  iosBundleIdentifier: string | null;
};

export type ProviderReadiness = {
  enabledInSupabase: boolean;
  configuredForBuild: boolean;
  /** Real-device E2E is a later gate; never claimed by source. */
  e2eVerified: false;
  usable: boolean;
};

/** Build-time declaration; without it only e-mail (the pre-existing login) is configured. */
export function parseConfiguredProviders(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value.trim() === '') return new Set(['email']);
  return new Set(value.split(',').map((item) => item.trim()).filter((item) => ['email', 'x', 'google', 'apple', 'apple_web'].includes(item)));
}

/** How Apple is used on this platform: native on iOS, browser OAuth elsewhere. */
export function applePath(build: BuildAuthConfig): 'native' | 'browser' {
  return build.platform === 'ios' ? 'native' : 'browser';
}

function configuredFor(provider: AuthProviderId, build: BuildAuthConfig): boolean {
  if (provider !== 'apple') return build.configured.has(provider);
  return applePath(build) === 'native'
    ? build.configured.has('apple') && build.nativeAppleAvailable && Boolean(build.iosBundleIdentifier)
    : build.configured.has('apple_web');
}

export function providerReadiness(provider: AuthProviderId, settings: ProviderSettings, build: BuildAuthConfig): ProviderReadiness {
  const enabledInSupabase = settings !== null && settings.external[provider];
  const configuredForBuild = configuredFor(provider, build);
  return { enabledInSupabase, configuredForBuild, e2eVerified: false, usable: enabledInSupabase && configuredForBuild };
}

/**
 * E-mail: signing in stays possible while settings are unknown (existing
 * users; the server still decides) but not when the project disables e-mail;
 * sign-up and reset need known settings with e-mail enabled; sign-up also
 * needs sign-ups open.
 */
export function emailCapabilities(settings: ProviderSettings, build: BuildAuthConfig): { signIn: boolean; signUp: boolean; reset: boolean } {
  const configured = build.configured.has('email');
  const known = settings !== null;
  const enabled = known && settings.external.email;
  return {
    signIn: configured && (!known || enabled),
    signUp: configured && enabled && !(settings?.signupDisabled ?? true),
    reset: configured && enabled,
  };
}

// ---------------------------------------------------------------------------
// Duplicate-account notice
// ---------------------------------------------------------------------------

export type AuthIdentitySummary = { provider: string };

/**
 * A social-provider account (single identity) with no workspace yet sees the
 * duplicate-account notice until this exact user acknowledges it — no time
 * limit, so an interrupted first run cannot skip it.
 */
export function shouldShowNewAccountNotice(input: {
  identities: readonly AuthIdentitySummary[];
  hasWorkspace: boolean;
  acknowledged: boolean;
}): boolean {
  if (input.hasWorkspace || input.acknowledged || input.identities.length !== 1) return false;
  return input.identities[0].provider !== 'email';
}

export const PROVIDER_LABELS: Record<AuthProviderId, string> = {
  x: 'X',
  apple: 'Apple',
  google: 'Google',
  email: 'メールアドレス',
};
