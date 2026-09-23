// Client side of in-app account deletion.
//
// The app never deletes rows itself: it asks the `account-delete` Edge Function, which re-verifies
// the caller's JWT server-side and deletes exactly that user. This module only decides what to send,
// what a response means, and what the user is told. No user id is ever sent -- the server derives it
// from the verified token, so a tampered client cannot target anyone else.

export type DeletionOutcome = { ok: true } | { ok: false; message: string };

export const ACCOUNT_DELETE_FUNCTION = 'account-delete';

const MESSAGES: Record<string, string> = {
  ACCOUNT_DELETE_AUTH_REQUIRED: 'ログイン状態を確認できませんでした。もう一度ログインしてお試しください。',
  ACCOUNT_DELETE_FAILED: 'アカウントを削除できませんでした。時間をおいてもう一度お試しください。',
};

const GENERIC = 'アカウントを削除できませんでした。時間をおいてもう一度お試しください。';

/**
 * Interprets the Edge Function result. `already_deleted` is a success for the user: the account is
 * gone either way, and reporting it as a failure would leave the UI claiming the opposite of the
 * truth. Anything unrecognised fails closed with the generic message so the UI never shows a
 * "deleted" state the server did not confirm.
 */
export function deletionOutcome(
  status: number,
  body: { success?: unknown; error?: unknown } | null,
): DeletionOutcome {
  if (status >= 200 && status < 300 && body?.success === true) return { ok: true };
  const code = typeof body?.error === 'string' ? body.error : '';
  return { ok: false, message: MESSAGES[code] ?? GENERIC };
}

export function deleteConfirmationIssue(typed: string, registeredEmail: string): string | null {
  if (typed.trim().toLowerCase() !== registeredEmail.trim().toLowerCase()) {
    return '登録しているメールアドレスを正しく入力してください。';
  }
  return null;
}

type InvokeResult = { status: number; body: { success?: unknown; error?: unknown } | null };

export type DeletionClient = {
  invokeAccountDelete(accessToken: string): Promise<InvokeResult>;
};

export async function deleteMyAccount(
  client: DeletionClient,
  accessToken: string | null | undefined,
): Promise<DeletionOutcome> {
  if (!accessToken) return { ok: false, message: MESSAGES.ACCOUNT_DELETE_AUTH_REQUIRED };
  try {
    const { status, body } = await client.invokeAccountDelete(accessToken);
    return deletionOutcome(status, body);
  } catch {
    return { ok: false, message: GENERIC };
  }
}
