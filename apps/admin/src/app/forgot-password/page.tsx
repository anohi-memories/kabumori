import Link from "next/link";
import { ForgotPasswordForm } from "./forgot-password-form";

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  link_invalid:
    "リンクが無効か、有効期限が切れています。お手数ですが、もう一度再設定メールを送信してください。",
};

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const reasonMessage = reason ? (REASON_MESSAGES[reason] ?? null) : null;

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="forgot-password-title">
        <div className="brand-mark" aria-hidden="true">株</div>
        <h1 id="forgot-password-title">パスワードの再設定</h1>
        <p className="login-description">
          登録済みのメールアドレスを入力してください。パスワード再設定用のリンクをお送りします。
        </p>
        {reasonMessage ? <p className="form-error" role="alert">{reasonMessage}</p> : null}
        <ForgotPasswordForm />
        <p className="login-description">
          <Link className="text-link" href="/login">ログイン画面に戻る</Link>
        </p>
      </section>
    </main>
  );
}
