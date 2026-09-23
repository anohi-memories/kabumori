// Password recovery for the consumer mobile app.
//
// Supabase can deliver a recovery link in three shapes depending on the project's auth flow and
// email template, and the app cannot change which one arrives from inside the client:
//   * implicit flow       -> #access_token=...&refresh_token=...&type=recovery
//   * PKCE flow           -> ?code=...
//   * token-hash template -> ?token_hash=...&type=recovery
// A failed or expired link comes back as ?error=...&error_code=otp_expired instead.
//
// parseRecoveryLink() is deliberately pure so every one of those shapes (and the expired-link case)
// is covered by tests without a network or a real deep link. The screen decides what to do with the
// result; nothing here logs a token or puts one in a message shown to the user.

export const RECOVERY_PATH = 'reset-password';

export type RecoveryLink =
  | { kind: 'none' }
  | { kind: 'tokens'; accessToken: string; refreshToken: string }
  | { kind: 'code'; code: string }
  | { kind: 'token-hash'; tokenHash: string }
  | { kind: 'error'; message: string };

const LINK_ERROR_MESSAGES: Record<string, string> = {
  otp_expired: 'パスワード再設定リンクの有効期限が切れています。もう一度メールを送信してください。',
  access_denied: 'パスワード再設定リンクが無効です。もう一度メールを送信してください。',
  invalid_request: 'パスワード再設定リンクが正しくありません。もう一度メールを送信してください。',
};

const GENERIC_LINK_ERROR =
  'パスワード再設定リンクを確認できませんでした。もう一度メールを送信してください。';

function collectParams(url: URL) {
  const params = new URLSearchParams(url.search);
  // Supabase's implicit flow puts everything after '#', which URL exposes as a raw string.
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  for (const [key, value] of new URLSearchParams(fragment)) {
    if (!params.has(key)) params.set(key, value);
  }
  return params;
}

/**
 * Classifies an incoming deep link. Returns `none` for every link that is not a recovery link, so
 * the caller can pass it every URL the app receives without special-casing.
 */
export function parseRecoveryLink(rawUrl: string): RecoveryLink {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: 'none' };
  }

  const params = collectParams(url);
  const type = params.get('type');
  // `kabumori://reset-password` parses with an empty pathname and the path in `host`, so both are
  // checked rather than assuming a shape.
  const onRecoveryPath = `${url.host}${url.pathname}`.includes(RECOVERY_PATH);
  if (type !== 'recovery' && !onRecoveryPath) return { kind: 'none' };

  const errorCode = params.get('error_code') ?? params.get('error');
  if (errorCode) {
    return { kind: 'error', message: LINK_ERROR_MESSAGES[errorCode] ?? GENERIC_LINK_ERROR };
  }

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken && refreshToken) return { kind: 'tokens', accessToken, refreshToken };

  const tokenHash = params.get('token_hash');
  if (tokenHash) return { kind: 'token-hash', tokenHash };

  const code = params.get('code');
  if (code) return { kind: 'code', code };

  return { kind: 'error', message: GENERIC_LINK_ERROR };
}

export function newPasswordIssue(password: string, confirmation: string): string | null {
  if (password.length < 6) return 'パスワードは6文字以上で入力してください。';
  if (password !== confirmation) return '確認用パスワードが一致しません。';
  return null;
}

export function resetEmailIssue(email: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim().toLowerCase())) {
    return '正しいメールアドレスを入力してください。';
  }
  return null;
}

type AuthResult = { error: { message: string } | null };

/** The only parts of the Supabase client this module needs -- so tests can supply a fake. */
export type RecoveryClient = {
  auth: {
    setSession(tokens: { access_token: string; refresh_token: string }): Promise<AuthResult>;
    exchangeCodeForSession(code: string): Promise<AuthResult>;
    verifyOtp(params: { token_hash: string; type: 'recovery' }): Promise<AuthResult>;
    updateUser(attributes: { password: string }): Promise<AuthResult>;
  };
};

const SESSION_FAILED =
  'パスワード再設定リンクを確認できませんでした。もう一度メールを送信してください。';

const UPDATE_FAILED = 'パスワードを変更できませんでした。時間をおいてもう一度お試しください。';

/**
 * Turns a verified recovery link into a usable recovery session. Returns a Japanese message on
 * failure instead of surfacing the raw auth error, which can contain link material.
 */
export async function startRecoverySession(
  client: RecoveryClient,
  link: RecoveryLink,
): Promise<string | null> {
  if (link.kind === 'error') return link.message;
  if (link.kind === 'none') return SESSION_FAILED;

  const result =
    link.kind === 'tokens'
      ? await client.auth.setSession({
          access_token: link.accessToken,
          refresh_token: link.refreshToken,
        })
      : link.kind === 'code'
        ? await client.auth.exchangeCodeForSession(link.code)
        : await client.auth.verifyOtp({ token_hash: link.tokenHash, type: 'recovery' });

  return result.error ? SESSION_FAILED : null;
}

/**
 * Applies the new password to the recovery session. Validation runs first so an invalid pair never
 * reaches the network.
 */
export async function applyNewPassword(
  client: RecoveryClient,
  password: string,
  confirmation: string,
): Promise<string | null> {
  const issue = newPasswordIssue(password, confirmation);
  if (issue) return issue;
  const { error } = await client.auth.updateUser({ password });
  if (!error) return null;
  if (/password/i.test(error.message) && /(weak|should be|short)/i.test(error.message)) {
    return 'パスワードが短すぎるか、安全性の条件を満たしていません。';
  }
  if (/expired|invalid|session/i.test(error.message)) return SESSION_FAILED;
  return UPDATE_FAILED;
}
