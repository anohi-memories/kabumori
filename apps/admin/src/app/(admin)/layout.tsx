import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandSelector } from "@/app/brand-selector";
import { LogoutButton } from "@/app/logout-button";
import { getActiveBrandContext } from "@/lib/active-brand";
import { createAdminServerClient } from "@/lib/supabase/server";

const LOGIN_ATTEMPT_COOKIE = "kabumori_admin_login_attempt";
const isDev = process.env.NODE_ENV !== "production";

// Dev-only diagnostics. Never logs email, password, or tokens — only
// outcome/status information safe to print to the console.
function devLog(message: string, detail?: Record<string, unknown>) {
  if (!isDev) return;
  console.log(`[admin/layout] ${message}`, detail ?? "");
}

export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createAdminServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    // The login form sets this short-lived, non-sensitive marker right
    // before navigating to "/" after a seemingly successful signIn. Its
    // presence here means the session cookie signInWithPassword just wrote
    // did not make it into this request — surface that distinctly instead
    // of silently bouncing back to a blank login form. Its absence means
    // this is an ordinary unauthenticated visit, not a failed login.
    const hadLoginAttempt = (await cookies()).get(LOGIN_ATTEMPT_COOKIE)?.value === "1";
    devLog("no session on request", { hadLoginAttempt, hadUserError: Boolean(userError) });
    redirect(hadLoginAttempt ? "/login?reason=session" : "/login");
  }

  const { data: admin, error: adminError } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminError || !admin) {
    devLog("admin check failed", { hadAdminError: Boolean(adminError) });
    redirect("/unauthorized");
  }

  devLog("session and admin check passed");

  // Entry to this app is still gated on admin_users above (unchanged). The active brand is resolved and
  // re-authorized server-side on every request; the selection cookie is only a request.
  const brandContext = await getActiveBrandContext();
  if (brandContext.kind !== "ok") {
    devLog("no authorized brand for admin", { kind: brandContext.kind });
    redirect("/unauthorized");
  }

  return (
    <div className="admin-app-shell">
      <header className="admin-site-header">
        <div className="admin-site-header-inner">
          <Link className="admin-brand" href="/">かぶモリ Admin</Link>
          <nav className="admin-navigation" aria-label="管理画面ナビゲーション">
            <Link href="/">ダッシュボード</Link>
            <Link href="/posts">投稿履歴</Link>
            <Link href="/important-news">重要ニュース</Link>
          </nav>
          <BrandSelector
            activeBrandId={brandContext.active.id}
            options={brandContext.options.map(({ id, label }) => ({ id, label }))}
          />
          <LogoutButton />
        </div>
      </header>
      {brandContext.selectionRejected ? (
        <p className="brand-selection-warning" role="alert">
          選択されたブランドは利用できないため、{brandContext.active.label}を表示しています。
        </p>
      ) : null}
      {children}
    </div>
  );
}
