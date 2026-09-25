import { createAdminServerClient } from "@/lib/supabase/server";
import { hasRecoveryContext } from "@/lib/password-recovery";
import { RecoveryLinkFallback } from "./recovery-link-fallback";
import { ResetPasswordForm } from "./reset-password-form";

// Per-request: the decision depends on the caller's session cookie.
export const dynamic = "force-dynamic";

async function sessionHasRecoveryContext(): Promise<boolean> {
  const supabase = await createAdminServerClient();
  // getClaims verifies the JWT (signature, or the Auth server for legacy
  // symmetric keys) before we trust its amr claim.
  const { data, error } = await supabase.auth.getClaims();
  if (error || data === null) return false;
  return hasRecoveryContext(data.claims.amr, Math.floor(Date.now() / 1000));
}

export default async function ResetPasswordPage() {
  const recoveryContext = await sessionHasRecoveryContext();

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="reset-password-title">
        <div className="brand-mark" aria-hidden="true">株</div>
        <h1 id="reset-password-title">新しいパスワードの設定</h1>
        {recoveryContext ? (
          <>
            <p className="login-description">新しいパスワードを入力してください。</p>
            <ResetPasswordForm recoveryContext={recoveryContext} />
          </>
        ) : (
          <RecoveryLinkFallback />
        )}
      </section>
    </main>
  );
}
