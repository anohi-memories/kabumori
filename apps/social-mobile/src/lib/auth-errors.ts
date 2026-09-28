/**
 * Maps a Supabase Auth sign-in error to a fixed user message. Never echoes the
 * provider message (it can contain the e-mail address or internal detail).
 */
export function signInErrorMessage(error: { code?: unknown; status?: unknown; name?: unknown } | null | undefined): string {
  const code = typeof error?.code === 'string' ? error.code : '';
  const status = typeof error?.status === 'number' ? error.status : null;
  const name = typeof error?.name === 'string' ? error.name : '';
  if (code === 'email_not_confirmed') return 'メールアドレスの確認が完了していません。届いた確認メールを開いてください。';
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || status === 429) {
    return '試行回数が多すぎます。しばらく待ってから再度お試しください。';
  }
  if (name === 'AuthRetryableFetchError' || status === 0 || (status !== null && status >= 500)) {
    return '通信できませんでした。接続を確認して再度お試しください。';
  }
  if (code === 'user_banned') return 'このアカウントは現在ご利用いただけません。';
  return 'メールアドレスまたはパスワードを確認してください。';
}
