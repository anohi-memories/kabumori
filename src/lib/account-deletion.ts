// Client side of the common-account lifecycle in Kabumori: 「かぶモリの利用を終了」 and 「共通アカウントを削除」.
//
// The app never deletes anything itself and never names a person. It calls the `account-delete` Edge
// Function with an explicit action; for a withdrawal or a deletion it sends the access token of a FRESH
// sign-in (the person re-enters their password in a separate, non-persisted client, so the app's own
// session is untouched), and the server derives the person from that token and checks that the sign-in is
// recent. This module decides what is sent, what an answer means and what the person is told. It never
// reports a state the server did not confirm: anything unrecognised fails closed with a generic message.
// The e-mail address used for the re-authentication is the signed-in one; it is never typed or looked up.

export const ACCOUNT_LIFECYCLE_FUNCTION = 'account-delete';
/** Must equal the server's constants (supabase/functions/account-delete/lifecycle_logic.ts). */
export const WITHDRAW_CONFIRMATION = 'END_KABUMORI_SERVICE';
export const DELETE_CONFIRMATION = 'DELETE_COMMON_ACCOUNT';
/** What the person types to confirm a whole-account deletion. */
export const DELETE_TYPED_PHRASE = '削除';

export type LifecycleAction = 'preview' | 'withdraw_kabumori' | 'delete_common_account';
export type InvokeResult = { status: number; body: unknown };

/** A fresh sign-in used only as proof of a recent authentication. `release` ends that extra session. */
export type Reauthentication =
  | { ok: true; accessToken: string; userId: string; release: () => Promise<void> }
  | { ok: false; reason: 'invalid_credentials' | 'rate_limited' | 'failed' };

export type LifecycleClient = {
  invoke(action: LifecycleAction, payload: Record<string, unknown>, accessToken: string): Promise<InvokeResult>;
  reauthenticate(email: string, password: string): Promise<Reauthentication>;
};

export type ServiceName = 'kabumori' | 'x_autopost';
export const SERVICE_LABEL: Record<ServiceName, string> = { kabumori: 'かぶモリ', x_autopost: 'X自動投稿' };

export type DeletionPreview = {
  accountStatus: string;
  lifecycleVersion: number;
  /** Services that are not ended yet (they end as part of the deletion). */
  services: ServiceName[];
  blockers: string[];
  deletionInProgress: boolean;
  apple: { required: boolean; supported: boolean; codeRequired: boolean };
  xCleanup: 'not_needed' | 'supported' | 'unsupported';
};

export type WithdrawOutcome = { ok: true } | { ok: false; message: string };
export type DeleteOutcome =
  | { ok: true }
  | {
      ok: false;
      message: string;
      /** The server already revoked every session: the app must sign out and the person sign in again to continue. */
      signedOut: boolean;
      /** The login may already be gone but the deletion is not verified yet (an operator follows up). */
      pending: boolean;
      /** The state changed since the preview: show the new preview before asking again. */
      refreshPreview: boolean;
    };

const GENERIC_WITHDRAW = 'かぶモリの利用を終了できませんでした。時間をおいてもう一度お試しください。';
const GENERIC_DELETE = '共通アカウントを削除できませんでした。時間をおいてもう一度お試しください。';
const GENERIC_PREVIEW = '削除の内容を確認できませんでした。時間をおいてもう一度お試しください。';
const CONTACT = 'お問い合わせください。';

export const REAUTH_MESSAGES = {
  password_required: 'パスワードを入力してください。',
  invalid_credentials: 'パスワードが正しくありません。',
  rate_limited: '試行回数が多すぎます。しばらく待ってからお試しください。',
  failed: '本人確認ができませんでした。時間をおいてもう一度お試しください。',
  email_missing: 'ログイン中のメールアドレスを確認できません。一度ログインし直してからお試しください。',
  other_person: 'ログイン中のアカウントと一致しません。一度ログインし直してからお試しください。',
} as const;

export const APPLE_UNSUPPORTED_MESSAGE =
  'Appleでサインインしたことのある共通アカウントは、現在かぶモリアプリから削除できません。' + CONTACT;

const BLOCKER_MESSAGES: Record<string, string> = {
  ADMIN_ACCOUNT: '運営用のアカウントは、アプリから削除できません。' + CONTACT,
  ACCOUNT_LOCKED: '共通アカウントが利用停止中のため、アプリから削除できません。' + CONTACT,
  X_WORKSPACE_NOT_SELF_SERVICE: '共有されているX自動投稿のワークスペースがあるため、アプリから削除できません。' + CONTACT,
};

const DELETE_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'ログイン状態を確認できませんでした。もう一度ログインしてお試しください。',
  REAUTH_REQUIRED: '本人確認の有効期限が切れました。もう一度パスワードを入力してください。',
  CONFIRMATION_REQUIRED: GENERIC_DELETE,
  LIFECYCLE_VERSION_REQUIRED: GENERIC_DELETE,
  LIFECYCLE_CHANGED: 'ご利用状況が変わりました。内容を確認して、もう一度お試しください。',
  DELETION_BLOCKED: '現在の状態では、アプリから共通アカウントを削除できません。' + CONTACT,
  APPLE_REAUTH_REQUIRED: APPLE_UNSUPPORTED_MESSAGE,
  APPLE_REVOCATION_UNAVAILABLE: APPLE_UNSUPPORTED_MESSAGE,
  APPLE_REVOKE_FAILED: 'Appleとの連携を解除できませんでした。時間をおいてもう一度お試しください。',
  X_CLEANUP_UNSUPPORTED: 'X自動投稿のデータを安全に削除できる状態ではありません。' + CONTACT,
  X_CLEANUP_IN_PROGRESS: 'X自動投稿の削除処理が進行中です。少し待ってからもう一度お試しください。',
  X_CLEANUP_BLOCKED: 'X自動投稿のデータを削除できない状態です。' + CONTACT,
  X_CLEANUP_FAILED: 'X自動投稿のデータを削除できませんでした。時間をおいてもう一度お試しください。',
  SERVICE_CLEANUP_INCOMPLETE: 'サービスのデータ削除が完了しませんでした。時間をおいてもう一度お試しください。',
  SESSION_REVOKE_FAILED: 'ログイン中の端末をログアウトできませんでした。時間をおいてもう一度お試しください。',
  STORAGE_CLEANUP_FAILED: '保存されたファイルを削除できませんでした。時間をおいてもう一度お試しください。',
  STORAGE_NOT_EMPTY: '保存されたファイルの削除が完了しませんでした。時間をおいてもう一度お試しください。',
  STORAGE_BUCKET_OWNED: '保存領域の削除にはお手続きが必要です。' + CONTACT,
  NOT_READY: '削除の準備が完了しませんでした。時間をおいてもう一度お試しください。',
  AUTH_DELETE_FAILED: 'ログイン情報を削除できませんでした。時間をおいてもう一度お試しください。',
  AUTH_DELETE_UNCONFIRMED: 'ログイン情報の削除を確認できませんでした。運営で確認します。',
  DELETION_VERIFICATION_PENDING: '削除の最終確認が完了していません。運営で確認します。',
};

const record = (value: unknown) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
const isService = (value: unknown): value is ServiceName => value === 'kabumori' || value === 'x_autopost';

/** Reads the server's preview. Anything malformed is an error, never a permissive default. */
export function parsePreview(result: InvokeResult): { ok: true; preview: DeletionPreview } | { ok: false; message: string } {
  const body = record(result.body);
  if (result.status !== 200 || body.ok !== true) {
    return { ok: false, message: body.error === 'AUTH_REQUIRED' ? DELETE_MESSAGES.AUTH_REQUIRED : GENERIC_PREVIEW };
  }
  const version = body.lifecycle_version;
  const apple = record(body.apple);
  const services = Array.isArray(body.services) ? body.services.map(record) : null;
  const blockers = Array.isArray(body.blockers) && body.blockers.every((b) => typeof b === 'string') ? body.blockers as string[] : null;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0 || !services || !blockers
      || !services.every((s) => isService(s.service) && typeof s.status === 'string')
      || typeof body.account_status !== 'string' || typeof body.deletion_in_progress !== 'boolean'
      || typeof apple.required !== 'boolean' || typeof apple.supported !== 'boolean' || typeof apple.code_required !== 'boolean'
      || (body.x_cleanup !== 'not_needed' && body.x_cleanup !== 'supported' && body.x_cleanup !== 'unsupported')) {
    return { ok: false, message: GENERIC_PREVIEW };
  }
  return {
    ok: true,
    preview: {
      accountStatus: body.account_status,
      lifecycleVersion: version,
      services: services.filter((s) => s.status !== 'ended').map((s) => s.service as ServiceName),
      blockers,
      deletionInProgress: body.deletion_in_progress,
      apple: { required: apple.required, supported: apple.supported, codeRequired: apple.code_required },
      xCleanup: body.x_cleanup,
    },
  };
}

/** Whether this app can carry out the deletion the preview describes; if not, why (fail closed). */
export function deletionAvailability(preview: DeletionPreview): { available: true } | { available: false; message: string } {
  if (preview.blockers.length > 0) {
    return { available: false, message: BLOCKER_MESSAGES[preview.blockers[0]] ?? DELETE_MESSAGES.DELETION_BLOCKED };
  }
  // Kabumori has no Sign in with Apple, so it cannot obtain the authorization code the revocation needs.
  if (preview.apple.required && preview.apple.codeRequired) return { available: false, message: APPLE_UNSUPPORTED_MESSAGE };
  if (preview.xCleanup === 'unsupported') return { available: false, message: DELETE_MESSAGES.X_CLEANUP_UNSUPPORTED };
  if (preview.accountStatus !== 'active' && preview.accountStatus !== 'deleting') return { available: false, message: DELETE_MESSAGES.DELETION_BLOCKED };
  return { available: true };
}

export function deleteTypedPhraseIssue(typed: string): string | null {
  return typed.trim() === DELETE_TYPED_PHRASE ? null : `確認のため「${DELETE_TYPED_PHRASE}」と入力してください。`;
}

export function withdrawOutcome(result: InvokeResult): WithdrawOutcome {
  const body = record(result.body);
  if (result.status === 200 && body.ok === true && ['ended', 'already_ended', 'not_registered'].includes(body.outcome as string)) return { ok: true };
  const reasons = Array.isArray(body.reasons) ? body.reasons : [];
  switch (body.error) {
    case 'AUTH_REQUIRED':
      return { ok: false, message: DELETE_MESSAGES.AUTH_REQUIRED };
    case 'REAUTH_REQUIRED':
      return { ok: false, message: DELETE_MESSAGES.REAUTH_REQUIRED };
    case 'WITHDRAW_BLOCKED':
      return {
        ok: false,
        message: reasons.includes('ACCOUNT_DELETION_IN_PROGRESS')
          ? '共通アカウントの削除手続き中です。「共通アカウントを削除」から手続きを続けてください。'
          : '現在の状態では、かぶモリの利用を終了できません。' + CONTACT,
      };
    case 'WITHDRAW_INTERRUPTED':
      return { ok: false, message: '手続きが中断されました。もう一度お試しください。' };
    default:
      return { ok: false, message: GENERIC_WITHDRAW };
  }
}

export function deleteOutcome(result: InvokeResult): DeleteOutcome {
  const body = record(result.body);
  if (result.status === 200 && body.ok === true && body.outcome === 'deleted') return { ok: true };
  const code = typeof body.error === 'string' ? body.error : '';
  const signedOut = body.sessions_revoked === true;
  const pending = code === 'DELETION_VERIFICATION_PENDING' || code === 'AUTH_DELETE_UNCONFIRMED';
  let message = Object.prototype.hasOwnProperty.call(DELETE_MESSAGES, code) ? DELETE_MESSAGES[code] : GENERIC_DELETE;
  const firstReason = Array.isArray(body.reasons) && typeof body.reasons[0] === 'string' ? body.reasons[0] : '';
  if (code === 'DELETION_BLOCKED' && Object.prototype.hasOwnProperty.call(BLOCKER_MESSAGES, firstReason)) message = BLOCKER_MESSAGES[firstReason];
  if (signedOut && !pending) message += '\nすべての端末からログアウトしました。続きを行うには、もう一度ログインしてください。';
  return { ok: false, message, signedOut, pending, refreshPreview: code === 'LIFECYCLE_CHANGED' };
}

async function invokeSafely(client: LifecycleClient, action: LifecycleAction, payload: Record<string, unknown>, token: string): Promise<InvokeResult> {
  try {
    return await client.invoke(action, payload, token);
  } catch {
    return { status: 0, body: null };
  }
}

async function reauthenticateSafely(client: LifecycleClient, email: string, password: string): Promise<Reauthentication> {
  try {
    return await client.reauthenticate(email, password);
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

async function releaseSafely(reauth: Reauthentication) {
  if (!reauth.ok) return;
  try {
    await reauth.release();
  } catch {
    // The extra session is short-lived and holds nothing; ending it is best effort.
  }
}

export type SignedInPerson = { email: string | null; userId: string };
type FreshSignIn = { ok: true; accessToken: string; reauth: Reauthentication } | { ok: false; message: string };

/** A fresh sign-in of the signed-in person (never anyone else), or the message to show. */
async function freshSignIn(client: LifecycleClient, signed: SignedInPerson, password: string): Promise<FreshSignIn> {
  if (!signed.email) return { ok: false, message: REAUTH_MESSAGES.email_missing };
  if (!password) return { ok: false, message: REAUTH_MESSAGES.password_required };
  const reauth = await reauthenticateSafely(client, signed.email, password);
  if (!reauth.ok) return { ok: false, message: REAUTH_MESSAGES[reauth.reason] };
  if (reauth.userId !== signed.userId) {
    await releaseSafely(reauth);
    return { ok: false, message: REAUTH_MESSAGES.other_person };
  }
  return { ok: true, accessToken: reauth.accessToken, reauth };
}

export async function previewCommonAccountDeletion(
  client: LifecycleClient,
  accessToken: string | null | undefined,
): Promise<{ ok: true; preview: DeletionPreview } | { ok: false; message: string }> {
  if (!accessToken) return { ok: false, message: DELETE_MESSAGES.AUTH_REQUIRED };
  return parsePreview(await invokeSafely(client, 'preview', {}, accessToken));
}

/** かぶモリの利用を終了: the login and the other services stay. */
export async function withdrawKabumori(client: LifecycleClient, signed: SignedInPerson, password: string): Promise<WithdrawOutcome> {
  const fresh = await freshSignIn(client, signed, password);
  if (!fresh.ok) return fresh;
  const result = await invokeSafely(client, 'withdraw_kabumori', { confirmation: WITHDRAW_CONFIRMATION }, fresh.accessToken);
  await releaseSafely(fresh.reauth);
  return withdrawOutcome(result);
}

/** 共通アカウントを削除: bound to the lifecycle version of the preview the person confirmed. */
export async function deleteCommonAccount(
  client: LifecycleClient,
  signed: SignedInPerson,
  input: { password: string; typed: string; preview: DeletionPreview },
): Promise<DeleteOutcome> {
  const failure = (message: string): DeleteOutcome => ({ ok: false, message, signedOut: false, pending: false, refreshPreview: false });
  const typedIssue = deleteTypedPhraseIssue(input.typed);
  if (typedIssue) return failure(typedIssue);
  const availability = deletionAvailability(input.preview);
  if (!availability.available) return failure(availability.message);
  const fresh = await freshSignIn(client, signed, input.password);
  if (!fresh.ok) return failure(fresh.message);
  const result = await invokeSafely(client, 'delete_common_account', {
    confirmation: DELETE_CONFIRMATION,
    expected_lifecycle_version: input.preview.lifecycleVersion,
  }, fresh.accessToken);
  await releaseSafely(fresh.reauth);
  return deleteOutcome(result);
}
