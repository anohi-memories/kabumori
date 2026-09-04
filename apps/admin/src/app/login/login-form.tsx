"use client";

import { KeyboardEvent, useState } from "react";
import { createAdminBrowserClient } from "@/lib/supabase/client";

const isDev = process.env.NODE_ENV !== "production";
const LOGIN_ATTEMPT_COOKIE = "kabumori_admin_login_attempt";

// Dev-only diagnostics for the login flow. Never logs email, password, or
// tokens — only outcome/status information safe to print to the console.
function devLog(message: string, detail?: Record<string, unknown>) {
  if (!isDev) return;
  console.log(`[admin/login] ${message}`, detail ?? "");
}

export function LoginForm({
  initialErrorMessage = null,
}: {
  initialErrorMessage?: string | null;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(initialErrorMessage);

  // No <form> element on purpose: a native form submit (e.g. if this
  // component's event handlers never attach — hydration failure, JS
  // blocked, etc.) defaults to method="get" and puts every field, including
  // the password, into the URL query string and server logs. Without a
  // <form>, there is no browser-native submission path at all — login can
  // only happen by this function actually running in JS. If JS fails, the
  // button is simply inert, which is the safe failure mode.
  async function handleLogin() {
    if (isSubmitting) return;

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setErrorMessage("メールアドレスとパスワードを入力してください。");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const supabase = createAdminBrowserClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });

      if (error) {
        devLog("signIn failed", { status: error.status, code: error.code });
        setErrorMessage("メールアドレスまたはパスワードを確認してください。");
        setIsSubmitting(false);
        return;
      }

      if (!data.session) {
        // signInWithPassword resolved without an error but returned no
        // session. Surface this distinctly rather than navigating blindly.
        devLog("signIn succeeded but no session was returned");
        setErrorMessage(
          "セッションを確立できませんでした。もう一度お試しください。",
        );
        setIsSubmitting(false);
        return;
      }

      devLog("signIn succeeded, redirecting");
      // Short-lived, non-sensitive marker read by the (admin) layout: if the
      // server still finds no session on the very next request, it knows
      // that request followed a real login attempt (vs. an ordinary
      // unauthenticated visit) and can show a specific message instead of a
      // silent bounce back to a blank form.
      document.cookie = `${LOGIN_ATTEMPT_COOKIE}=1; path=/; max-age=20; samesite=lax`;
      // A full top-level navigation (not the Next.js client router) so the
      // browser issues a fresh request that reliably carries the session
      // cookie signInWithPassword just wrote. A soft client-side transition
      // (router.replace/refresh) reuses an in-flight fetch that can race
      // ahead of the cookie write on some mobile browsers, landing back on
      // /login with the session silently missing.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation, see comment above
      window.location.assign("/");
    } catch (err) {
      devLog("signIn threw", { name: err instanceof Error ? err.name : typeof err });
      setErrorMessage("ログイン処理を開始できませんでした。接続設定を確認してください。");
      setIsSubmitting(false);
    }
  }

  // Enter key support without a <form>: this only runs once JS has attached
  // it, so there is no native-submission fallback if it doesn't.
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void handleLogin();
  }

  return (
    <div className="login-form">
      <div className="field">
        <label htmlFor="email">メールアドレス</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div className="field">
        <label htmlFor="password">パスワード</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {errorMessage ? <p className="form-error" role="alert">{errorMessage}</p> : null}
      <button
        className="primary-button"
        type="button"
        disabled={isSubmitting}
        onClick={() => void handleLogin()}
      >
        {isSubmitting ? "ログイン中…" : "ログイン"}
      </button>
      <noscript>
        <p className="form-error" role="alert">
          このページの操作にはJavaScriptが必要です。ブラウザの設定をご確認ください。
        </p>
      </noscript>
    </div>
  );
}
