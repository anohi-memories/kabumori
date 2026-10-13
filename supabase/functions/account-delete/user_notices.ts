// What a person is told about ending POSTONA and deleting the common account (F5 Phase 7). G5's CONTRACT for the app
// owners (G1/G2 Kabumori, G4 POSTONA): the apps copy these strings (they cannot import from supabase/functions; the
// test supabase/tests/common_account_phase7_notices_test.ts pins every one, and reports which server answers an
// app's client does not map yet). Nothing here is shown by the server: the server answers fixed codes, never text.
//
// The rules the texts follow (pinned by the test):
//   * a remote authorization that this system could NOT revoke is never described as revoked, cancelled, released or
//     deleted; it is a separate line from the local result and says where the person can remove it;
//   * "POSTONAの利用を終了" and "共通アカウントを削除" are different acts and are never presented as one;
//   * every server error code has a notice; an unknown code falls back to a generic one (fail closed).
import type { LifecycleErrorCode } from './lifecycle_logic.ts';

export type NoticeKind = 'login' | 'consent' | 'retry' | 'wait' | 'operator' | 'blocked';
export type Notice = { ja: string; kind: NoticeKind; retryable: boolean };

const CONTACT = 'お問い合わせください。';
const GENERIC_END = '利用を終了できませんでした。時間をおいてもう一度お試しください。';
const GENERIC_DELETE = '共通アカウントを削除できませんでした。時間をおいてもう一度お試しください。';

/** Per provider that cannot be revoked from here: the local result and the remote line are SEPARATE lines. */
export const REMOTE_UNVERIFIED: Readonly<Record<string, { name: string; local: string; remote: string; consent: string }>> = {
  threads: {
    name: 'Threads',
    local: 'POSTONAに保存していたThreadsの連携情報（アクセストークンと投稿の設定）を削除します。',
    remote:
      'Threads（Meta）側のアプリへのアクセス許可は、このアプリからは取り消せません。取り消すには、Threads（Meta）側の設定でPOSTONAのアクセス許可を削除してください。',
    consent: 'Threads側の許可が残ることを理解したうえで、削除を続ける。',
  },
};

/** The two acts, side by side (shown before the confirmation of either). */
export const POSTONA_END_VS_ACCOUNT_DELETE = {
  postona_end: {
    title: 'POSTONAの利用を終了',
    removes: [
      'POSTONAのワークスペースと投稿の設定',
      'X連携（Xの認可の取り消しと、保存していた認証情報の削除）',
      'Threads連携（POSTONA内の連携情報と投稿の設定。Threads側の許可は残ります）',
      '予約中の投稿と、投稿の履歴・実行記録',
    ],
    keeps: ['ログイン用のアカウント', 'かぶモリの利用状況とデータ', 'XやThreadsにすでに公開された投稿'],
    reversible: 'あとから利用登録をやり直すことはできますが、削除したデータは元に戻りません。',
  },
  account_delete: {
    title: '共通アカウントを削除',
    removes: [
      'ログイン用のアカウント（メールアドレス・パスワードなど）',
      'かぶモリのデータ',
      'POSTONAのデータ（「POSTONAの利用を終了」と同じ内容）',
    ],
    keeps: [
      'XやThreadsにすでに公開された投稿',
      'Threads側のアクセス許可（このアプリからは取り消せません）',
      '削除の実行記録（利用者IDから計算した識別子と日時・結果のみ）',
    ],
    reversible: '元に戻すことはできません。',
  },
} as const;

const n = (ja: string, kind: NoticeKind, retryable: boolean): Notice => ({ ja, kind, retryable });

/** One notice per server error code (the type forces the list to stay complete). */
export const ERROR_NOTICES: Readonly<Record<LifecycleErrorCode, Notice>> = {
  AUTH_REQUIRED: n('ログイン状態を確認できませんでした。もう一度ログインしてお試しください。', 'login', false),
  ACTION_REQUIRED: n('操作を確認できませんでした。アプリを最新版にしてからお試しください。', 'blocked', false),
  CONFIRMATION_REQUIRED: n('確認の入力が正しくありません。', 'blocked', false),
  REAUTH_REQUIRED: n('本人確認の有効期限が切れました。もう一度パスワードを入力してください。', 'login', false),
  LIFECYCLE_VERSION_REQUIRED: n(GENERIC_DELETE, 'retry', true),
  LIFECYCLE_CHANGED: n('ご利用状況が変わりました。内容を確認して、もう一度お試しください。', 'retry', true),
  DELETION_BLOCKED: n('現在の状態では、アプリから削除できません。' + CONTACT, 'operator', false),
  COMMON_ACCOUNT_DELETION_UNAVAILABLE: n('共通アカウントの削除は、現在準備中です。お手数ですが' + CONTACT, 'operator', false),
  DELETION_IN_PROGRESS: n('別の端末または画面で手続きが進行中です。しばらく待ってから、もう一度お試しください。', 'wait', true),
  RECONCILIATION_REQUIRED: n('手続きの一部の結果を確認する必要があります。運営で確認しますので、しばらくお待ちください。', 'operator', false),
  APPLE_REAUTH_REQUIRED: n('Appleでサインインしたことのあるアカウントは、現在このアプリから削除できません。' + CONTACT, 'operator', false),
  APPLE_REVOCATION_UNAVAILABLE: n('Appleでサインインしたことのあるアカウントは、現在このアプリから削除できません。' + CONTACT, 'operator', false),
  APPLE_REVOKE_FAILED: n('Appleとの連携を解除できませんでした。時間をおいてもう一度お試しください。', 'retry', true),
  X_CLEANUP_UNSUPPORTED: n('X自動投稿のデータを安全に削除できる状態ではありません。' + CONTACT, 'operator', false),
  X_CLEANUP_IN_PROGRESS: n('X自動投稿の削除処理が進行中です。少し待ってからもう一度お試しください。', 'wait', true),
  X_CLEANUP_BLOCKED: n('X自動投稿のデータを削除できない状態です。' + CONTACT, 'operator', false),
  X_CLEANUP_FAILED: n('X自動投稿のデータを削除できませんでした。時間をおいてもう一度お試しください。', 'retry', true),
  PROVIDER_CLEANUP_BLOCKED: n(
    '連携しているSNS（Threadsなど）のデータをまだ削除できていません。時間をおいてもう一度お試しください。続く場合は' + CONTACT, 'retry', true),
  PROVIDER_REMOTE_UNVERIFIED: n(
    '連携しているSNS側のアクセス許可が取り消されたことを確認できませんでした。内容を確認のうえ、もう一度お試しください。', 'consent', true),
  PROVIDER_ADAPTER_MISSING: n('連携しているSNSのデータは、アプリからはまだ削除できません。' + CONTACT, 'operator', false),
  REMOTE_UNVERIFIED_ACK_REQUIRED: n(
    REMOTE_UNVERIFIED.threads.remote + '\n' + REMOTE_UNVERIFIED.threads.consent, 'consent', true),
  ACKNOWLEDGEMENT_INVALID: n(GENERIC_DELETE, 'retry', true),
  SERVICE_CLEANUP_INCOMPLETE: n('サービスのデータ削除が完了しませんでした。時間をおいてもう一度お試しください。', 'retry', true),
  SESSION_REVOKE_FAILED: n('ログイン中の端末をログアウトできませんでした。時間をおいてもう一度お試しください。', 'retry', true),
  STORAGE_CLEANUP_FAILED: n('保存されたファイルを削除できませんでした。時間をおいてもう一度お試しください。', 'retry', true),
  STORAGE_NOT_EMPTY: n('保存されたファイルの削除が完了しませんでした。時間をおいてもう一度お試しください。', 'retry', true),
  STORAGE_BUCKET_OWNED: n('保存領域の削除にはお手続きが必要です。' + CONTACT, 'operator', false),
  NOT_READY: n('削除の準備が完了しませんでした。時間をおいてもう一度お試しください。', 'retry', true),
  AUTH_DELETE_FAILED: n('ログイン情報を削除できませんでした。時間をおいてもう一度お試しください。', 'retry', true),
  AUTH_DELETE_UNCONFIRMED: n('ログイン情報の削除を確認できませんでした。運営で確認します。', 'operator', false),
  DELETION_VERIFICATION_PENDING: n('削除の最終確認が完了していません。運営で確認します。', 'operator', false),
  WITHDRAW_BLOCKED: n('現在の状態では、利用を終了できません。' + CONTACT, 'operator', false),
  WITHDRAW_INTERRUPTED: n('手続きが中断されました。もう一度お試しください。', 'retry', true),
  WITHDRAW_INCOMPLETE: n(GENERIC_END, 'retry', true),
  FAILED: n(GENERIC_END, 'retry', true),
};

/** What to show for a code the app does not know yet: never the server's text, never a success. */
export const UNKNOWN_CODE_NOTICE: Notice = n(GENERIC_END, 'retry', true);

export type EndResultBody = {
  outcome?: unknown;
  providers?: unknown;
  remote_unverified?: unknown;
};

/**
 * The lines to show after a success: the LOCAL result and, as a SEPARATE line per provider, the remote authorization
 * that was not revoked. Only what the server confirmed is described; an unknown shape yields nothing.
 */
export function resultLines(body: EndResultBody, kind: 'postona_end' | 'account_delete'): string[] {
  const lines: string[] = [];
  if (body.outcome === 'ended' && kind === 'postona_end') lines.push('POSTONAの利用を終了しました。ログイン用のアカウントとかぶモリのデータは残っています。');
  else if (body.outcome === 'already_ended') lines.push('POSTONAの利用はすでに終了しています。');
  else if (body.outcome === 'not_registered') lines.push('POSTONAの利用登録はありません。');
  else if (body.outcome === 'deleted' && kind === 'account_delete') lines.push('共通アカウントを削除しました。ご利用ありがとうございました。');
  else return lines;
  const unverified = Array.isArray(body.remote_unverified) ? body.remote_unverified.filter((p): p is string => typeof p === 'string') : [];
  for (const provider of unverified) {
    const notice = REMOTE_UNVERIFIED[provider];
    if (notice) lines.push(notice.remote);
  }
  return lines;
}
