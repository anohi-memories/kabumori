"use client";

import { KeyboardEvent, useState } from "react";
import { createAdminBrowserClient } from "@/lib/supabase/client";
import { requestPasswordReset, type ResetRequestStatus } from "@/lib/password-recovery";

// The "sent" message is identical whether or not the address has an account,
// so this page cannot be used to discover which emails are registered.
const STATUS_MESSAGES: Readonly<Record<Exclude<ResetRequestStatus, "sent">, string>> = {
  invalid_email: "メールアドレスの形式を確認してください。",
  config_error: "この画面の接続設定に問題があります。管理者にお問い合わせください。",
  unavailable: "送信処理を開始できませんでした。時間をおいて再度お試しください。",
};

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // No <form> element, for the same reason as the login form: a native
  // submission fallback would put the field into the URL query string.
  async function handleSubmit() {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    const status = await requestPasswordReset(
      createAdminBrowserClient().auth,
      email,
      window.location.origin,
    );
    setIsSubmitting(false);
    if (status === "sent") {
      setSent(true);
      return;
    }
    setErrorMessage(STATUS_MESSAGES[status]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void handleSubmit();
  }

  if (sent) {
    return (
      <p className="login-description" role="status">
        入力されたメールアドレスが登録されている場合、パスワード再設定用のメールを送信しました。
        メール内のリンクは、この操作を行ったブラウザで開いてください。
      </p>
    );
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
      {errorMessage ? <p className="form-error" role="alert">{errorMessage}</p> : null}
      <button
        className="primary-button"
        type="button"
        disabled={isSubmitting}
        onClick={() => void handleSubmit()}
      >
        {isSubmitting ? "送信中…" : "再設定メールを送信"}
      </button>
      <noscript>
        <p className="form-error" role="alert">
          このページの操作にはJavaScriptが必要です。ブラウザの設定をご確認ください。
        </p>
      </noscript>
    </div>
  );
}
