/**
 * Visible state for the e-mail form. Pure (no imports).
 *
 * A sign-up that is in flight, or one that just succeeded, must be visibly
 * different from an idle form so the user does not press the button again
 * (Supabase's e-mail sending is rate limited; a second press can hit the
 * limit). "Sent" is shown only after the request really succeeded.
 */
export const SIGN_UP_COOLDOWN_MS = 60_000;

export type EmailMode = 'sign_in' | 'sign_up' | 'reset';

export type EmailSubmitView = {
  disabled: boolean;
  label: string;
  /** Whole seconds until the button is usable again after a successful sign-up. */
  cooldownSeconds: number;
};

const IDLE_LABEL: Record<EmailMode, string> = { sign_in: 'ログイン', sign_up: '登録する', reset: '再設定メールを送る' };
const BUSY_LABEL: Record<EmailMode, string> = { sign_in: 'ログインしています…', sign_up: '登録しています…', reset: '送信しています…' };

export function emailSubmitView(input: { mode: EmailMode; busy: boolean; allowed: boolean; signUpSentAt: number | null; now: number }): EmailSubmitView {
  const remainingMs = input.signUpSentAt === null ? 0 : Math.max(0, input.signUpSentAt + SIGN_UP_COOLDOWN_MS - input.now);
  const cooldownSeconds = input.mode === 'sign_up' ? Math.ceil(remainingMs / 1000) : 0;
  if (input.busy) return { disabled: true, label: BUSY_LABEL[input.mode], cooldownSeconds };
  if (cooldownSeconds > 0) return { disabled: true, label: `送信済み（あと${cooldownSeconds}秒で再送できます）`, cooldownSeconds };
  return { disabled: !input.allowed, label: IDLE_LABEL[input.mode], cooldownSeconds: 0 };
}
