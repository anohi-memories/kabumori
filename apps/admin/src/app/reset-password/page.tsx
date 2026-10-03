import { verifyRecoveryContext } from "@/lib/actions/recovery-context";
import { RecoveryLinkFallback } from "./recovery-link-fallback";
import { ResetPasswordForm } from "./reset-password-form";

// Per-request: the decision depends on the caller's session cookie.
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  // Render-time gate. The same check runs again server-side right before the
  // update is submitted (see ResetPasswordForm), so this is not the only one.
  const recoveryContext = await verifyRecoveryContext();

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="reset-password-title">
        <div className="brand-mark" aria-hidden="true">株</div>
        <h1 id="reset-password-title">新しいパスワードの設定</h1>
        {recoveryContext ? (
          <>
            <p className="login-description">新しいパスワードを入力してください。</p>
            <ResetPasswordForm />
          </>
        ) : (
          <RecoveryLinkFallback />
        )}
      </section>
    </main>
  );
}
