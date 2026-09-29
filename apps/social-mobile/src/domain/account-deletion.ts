/**
 * Account deletion — what the app shows and how it reads the server answer.
 * Pure (no runtime imports). The server (Edge Function
 * `social-mobile-account-delete` + its DB state machine) is the authority;
 * nothing here can make the UI claim a deletion the server did not confirm.
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

/**
 * social_and_login: the login is used only by this app -> login + social data.
 * social_only: the same login also holds かぶモリ data -> only this app's data;
 * the login and かぶモリ data stay (never deleted as a side effect).
 */
export type DeletionScope = 'social_only' | 'social_and_login';

const SOCIAL_DATA = [
  'あなた専用のワークスペースと投稿の設定',
  '投稿用のX接続（Xの認可を取り消し、保存していた認証情報を削除）',
  '予約中の投稿、投稿の履歴・実行記録',
];

export function deletionItems(scope: DeletionScope): { deleted: string[]; kept: string[] } {
  const kept = [
    'X上にすでに公開された投稿は削除されません。必要な場合はXで削除してください。',
    '削除の実行記録（利用者IDから計算した識別子と日時・結果のみ）は残ります。',
    'ほかの人のワークスペースは削除されません。',
  ];
  if (scope === 'social_and_login') {
    return { deleted: ['ログイン用のアカウント（メールアドレス・パスワード、X・Apple・Googleのログイン方法）', ...SOCIAL_DATA], kept };
  }
  return {
    deleted: SOCIAL_DATA,
    kept: [
      'このログイン用アカウントは「かぶモリ」でも使われているため、ログイン用アカウントと「かぶモリ」のデータは削除されません。「かぶモリ」のアカウントを削除する場合は、「かぶモリ」アプリから行ってください。',
      ...kept,
    ],
  };
}

export const DELETION_TIMING = '削除は確認後すぐに実行され、元に戻すことはできません。完了すると、この端末からログアウトします。';

export type DeletionPreview =
  | { ok: true; scope: DeletionScope; state: string; appleSupported: boolean; appleCodeRequired: boolean }
  | { ok: false; code: string };

const CODE = /^[A-Z][A-Z0-9_]{1,80}$/u;
const record = (body: unknown) => (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
const failure = (body: Record<string, unknown>) => ({ ok: false as const, code: typeof body.error === 'string' && CODE.test(body.error) ? body.error : 'FAILED' });

export function parseDeletionPreview(status: number, body: unknown): DeletionPreview {
  const data = record(body);
  if (status !== 200 || data.ok !== true) return failure(data);
  if (data.scope !== 'social_only' && data.scope !== 'social_and_login') return { ok: false, code: 'FAILED' };
  return {
    ok: true,
    scope: data.scope,
    state: typeof data.state === 'string' ? data.state : 'none',
    appleSupported: data.apple_supported === true,
    appleCodeRequired: data.apple_code_required === true,
  };
}

export type DeletionOutcome = { ok: true; loginDeleted: boolean; loginKept: boolean } | { ok: false; code: string };

/** Only an explicit 200 {ok:true} is a success; anything else is a failure code. */
export function parseDeletionResponse(status: number, body: unknown): DeletionOutcome {
  const data = record(body);
  if (status === 200 && data.ok === true) {
    return { ok: true, loginDeleted: data.login_deleted === true, loginKept: data.login_deleted !== true };
  }
  return failure(data);
}

/** The result text always states exactly what happened to the login. */
export function deletionResultMessage(outcome: { loginDeleted: boolean }): string {
  return outcome.loginDeleted
    ? 'アカウントを削除しました。ご利用ありがとうございました。'
    : 'このアプリのデータを削除しました。ログイン用アカウントと「かぶモリ」のデータは残っています。';
}

export type DeletionPlatformSupport = 'supported' | 'apple_native_required' | 'apple_unavailable';

/**
 * Deleting a Sign in with Apple login needs a native Apple authorization
 * code, which only the iOS app can obtain. Other platforms say so truthfully.
 */
export function deletionPlatformSupport(input: { appleCodeRequired: boolean; appleSupported: boolean; nativeAppleAvailable: boolean }): DeletionPlatformSupport {
  if (!input.appleCodeRequired) return 'supported';
  if (!input.appleSupported) return 'apple_unavailable';
  return input.nativeAppleAvailable ? 'supported' : 'apple_native_required';
}

const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'ログインし直してから、もう一度お試しください。すでに削除が完了している場合は、ログインできません。',
  REAUTH_REQUIRED: '本人確認の有効期限が切れました。もう一度本人確認をしてください。',
  SESSION_CHANGED: 'ログイン状態が変わったため中止しました。もう一度本人確認からやり直してください。',
  CONFIRMATION_REQUIRED: '確認の入力が正しくありません。',
  SCOPE_REQUIRED: '削除の内容を確認できませんでした。画面を開き直してください。',
  SCOPE_CHANGED: '削除される内容が変わりました。内容を確認し直してください。',
  APPLE_REVOCATION_UNAVAILABLE: 'Appleでログインしているアカウントの削除は、現在準備中です。お問い合わせください。',
  APPLE_REAUTH_REQUIRED: 'Appleで本人確認をしてから、もう一度お試しください。',
  APPLE_REVOKE_FAILED: 'Appleの連携を解除できませんでした。Appleで本人確認をやり直してから、もう一度お試しください。',
  DELETION_IN_PROGRESS: '削除の処理中です。しばらく待ってから、もう一度お試しください。',
  DELETION_OPERATOR_REQUIRED: '削除を安全に進められない状態のため、処理を止めています。投稿は停止済みです。お問い合わせください。',
  DELETION_BLOCKED_SHARED_WORKSPACE: 'ほかの人も参加しているワークスペースがあるため、ここでは削除できません。お問い合わせください。',
  DELETION_BLOCKED_OWNS_OTHER_WORKSPACE: '管理しているワークスペースがあるため、ここでは削除できません。お問い合わせください。',
  DELETION_BLOCKED_ADMIN_ACCOUNT: '管理者のアカウントは、ここでは削除できません。',
  DELETION_BLOCKED_POSTING_IN_PROGRESS: '投稿の処理中です。しばらく待ってから、もう一度お試しください。',
  DELETION_BLOCKED_CREDENTIAL_REFRESH_IN_PROGRESS: 'Xとの接続を更新中です。しばらく待ってから、もう一度お試しください。',
  X_REVOKE_FAILED: 'Xの認可を取り消せませんでした。投稿はすでに停止しています。時間をおいてもう一度お試しください。',
  CREDENTIALS_CHANGED: 'Xとの接続情報が変わったため中止しました。もう一度お試しください。',
  FINALIZE_FAILED: '削除の最後の手続きが完了していません。もう一度お試しください。',
};

/** Fixed Japanese messages; server text is never shown. */
export function deletionErrorMessage(code: string): string {
  return MESSAGES[code]
    ?? (code.startsWith('DELETION_BLOCKED_') ? 'このアカウントは、ここでは削除できません。お問い合わせください。' : 'アカウントを削除できませんでした。時間をおいてもう一度お試しください。');
}

/** After these, the held re-authentication (and any Apple code) is no longer usable. */
export function deletionNeedsFreshReauth(code: string): boolean {
  return ['REAUTH_REQUIRED', 'SESSION_CHANGED', 'APPLE_REAUTH_REQUIRED', 'APPLE_REVOKE_FAILED', 'SCOPE_CHANGED', 'AUTH_REQUIRED'].includes(code);
}

export type ReauthMethod = 'email' | 'x' | 'google' | 'apple';

/** Re-authentication offered only through the user's own linked methods. */
export function reauthMethods(linkedProviders: readonly string[], usable: (method: ReauthMethod) => boolean): ReauthMethod[] {
  return (['email', 'x', 'google', 'apple'] as const).filter((method) => linkedProviders.includes(method) && usable(method));
}

/** The exact user + session the confirmation was made for. */
export type DeletionContext = { userId: string; sessionId: string };

export function sameDeletionContext(expected: DeletionContext | null, current: { userId: string | null; sessionId: string | null }): boolean {
  return expected !== null && current.userId === expected.userId && current.sessionId === expected.sessionId;
}
