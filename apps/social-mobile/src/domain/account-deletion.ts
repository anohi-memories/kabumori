/**
 * Account deletion — what the app shows and how it reads the server answer.
 * Pure (no runtime imports). The server (Edge Function
 * `social-mobile-account-delete`) is the authority; nothing here can make the
 * UI claim a deletion the server did not confirm.
 */

export const ACCOUNT_DELETION_CONFIRM_PHRASE = '削除する';
/** Sent to the server; must match the Edge Function's constant. */
export const ACCOUNT_DELETION_CONFIRMATION = 'DELETE_MY_ACCOUNT';
export const ACCOUNT_DELETION_FUNCTION = 'social-mobile-account-delete';

export type DeletionAvailability = 'available' | 'setup_pending';

/**
 * Offered only when the operator enabled it for this build (after the backend
 * is reviewed and deployed) and the Supabase client is configured.
 */
export function deletionAvailability(input: { enabledFlag: string | undefined; backendAvailable: boolean }): DeletionAvailability {
  return input.backendAvailable && input.enabledFlag?.trim() === 'true' ? 'available' : 'setup_pending';
}

/** What is deleted (source-supported facts of the candidate backend). */
export const DELETED_ITEMS: readonly string[] = [
  'ログイン用のアカウント（メールアドレス・パスワード、X・Apple・Googleのログイン方法）',
  'あなた専用のワークスペースと投稿の設定',
  '投稿用のX接続（Xの認可を取り消し、保存していた認証情報を削除）',
  '予約中の投稿、投稿の履歴・実行記録',
];

/** What is not deleted by the app, stated honestly. */
export const RETAINED_ITEMS: readonly string[] = [
  'X上にすでに公開された投稿は削除されません。必要な場合はXで削除してください。',
  '削除の実行記録（個人を特定できない形の識別子と日時・結果のみ）は残ります。',
  'ほかの人のワークスペースは削除されません。',
];

export const DELETION_TIMING = '削除はすぐに実行されます。完了すると自動的にログアウトし、元に戻すことはできません。';

export type DeletionOutcome = { ok: true } | { ok: false; code: string };

/** Only an explicit 200 {ok:true} is a success; anything else is a failure code. */
export function parseDeletionResponse(status: number, body: unknown): DeletionOutcome {
  const record = (typeof body === 'object' && body !== null ? body : {}) as { ok?: unknown; error?: unknown };
  if (status === 200 && record.ok === true) return { ok: true };
  return { ok: false, code: typeof record.error === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/u.test(record.error) ? record.error : 'FAILED' };
}

const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'ログインし直してから、もう一度お試しください。',
  REAUTH_REQUIRED: '本人確認の有効期限が切れました。もう一度本人確認をしてください。',
  CONFIRMATION_REQUIRED: '確認の入力が正しくありません。',
  APPLE_REVOCATION_UNAVAILABLE: 'Appleでログインしているアカウントの削除は、現在準備中です。お問い合わせください。',
  APPLE_REAUTH_REQUIRED: 'Appleで本人確認をしてから、もう一度お試しください。',
  APPLE_REVOKE_FAILED: 'Appleの連携を解除できませんでした。時間をおいてもう一度お試しください。',
  DELETION_BLOCKED_SHARED_WORKSPACE: 'ほかの人も参加しているワークスペースがあるため、ここでは削除できません。お問い合わせください。',
  DELETION_BLOCKED_OWNS_OTHER_WORKSPACE: '管理しているワークスペースがあるため、ここでは削除できません。お問い合わせください。',
  DELETION_BLOCKED_ADMIN_ACCOUNT: '管理者のアカウントは、ここでは削除できません。',
  DELETION_BLOCKED_POSTING_IN_PROGRESS: '投稿の処理中です。しばらく待ってから、もう一度お試しください。',
  DELETION_BLOCKED_CREDENTIAL_REFRESH_IN_PROGRESS: 'Xとの接続を更新中です。しばらく待ってから、もう一度お試しください。',
  X_REVOKE_FAILED: 'Xの認可を取り消せませんでした。投稿はすでに停止しています。時間をおいてもう一度お試しください。',
  AUTH_DELETE_FAILED: 'データは削除しましたが、ログイン用アカウントの削除が完了していません。もう一度お試しください。',
};

/** Fixed Japanese messages; server text is never shown. */
export function deletionErrorMessage(code: string): string {
  return MESSAGES[code]
    ?? (code.startsWith('DELETION_BLOCKED_') ? 'このアカウントは、ここでは削除できません。お問い合わせください。' : 'アカウントを削除できませんでした。時間をおいてもう一度お試しください。');
}

export type ReauthMethod = 'email' | 'x' | 'google' | 'apple';

/** Re-authentication offered only through the user's own linked methods. */
export function reauthMethods(linkedProviders: readonly string[], usable: (method: ReauthMethod) => boolean): ReauthMethod[] {
  return (['email', 'x', 'google', 'apple'] as const).filter((method) => linkedProviders.includes(method) && usable(method));
}
