"use client";

import Link from "next/link";
import { KeyboardEvent, useState } from "react";
import { createAdminBrowserClient } from "@/lib/supabase/client";
import {
  completePasswordReset,
  PASSWORD_MIN_LENGTH,
  type CompleteResetResult,
} from "@/lib/password-recovery";

const INVALID_MESSAGES: Readonly<
  Record<Extract<CompleteResetResult, { status: "invalid" }>["reason"], string>
> = {
  empty: "新しいパスワードを2回入力してください。",
  too_short: `パスワードは${PASSWORD_MIN_LENGTH}文字以上にしてください。`,
  too_long: "パスワードが長すぎます。短くしてください。",
  mismatch: "確認用のパスワードが一致しません。",
};

export function ResetPasswordForm({ recoveryContext }: { recoveryContext: boolean }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [needsNewLink, setNeedsNewLink] = useState(false);

  // No <form> element: a native submission fallback would put both password
  // fields into the URL query string.
  async function handleSubmit() {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    const result = await completePasswordReset(
      createAdminBrowserClient().auth,
      password,
      confirmation,
      recoveryContext,
    );
    if (result.status === "updated") {
      // Full navigation so the now signed-out state is what the server sees,
      // replacing this page so Back does not return to the reset form.
      window.location.replace("/login?reason=password_updated");
      return;
    }
    setIsSubmitting(false);
    if (result.status === "invalid") {
      setErrorMessage(INVALID_MESSAGES[result.reason]);
      return;
    }
    setErrorMessage(
      "パスワードを更新できませんでした。リンクの有効期限が切れた可能性があります。",
    );
    setNeedsNewLink(true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void handleSubmit();
  }

  return (
    <div className="login-form">
      <div className="field">
        <label htmlFor="new-password">新しいパスワード</label>
        <input
          id="new-password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div className="field">
        <label htmlFor="confirm-password">新しいパスワード（確認）</label>
        <input
          id="confirm-password"
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {errorMessage ? <p className="form-error" role="alert">{errorMessage}</p> : null}
      {needsNewLink ? (
        <p className="login-description">
          <Link className="text-link" href="/forgot-password">再設定メールを送り直す</Link>
        </p>
      ) : null}
      <button
        className="primary-button"
        type="button"
        disabled={isSubmitting}
        onClick={() => void handleSubmit()}
      >
        {isSubmitting ? "更新中…" : "パスワードを設定"}
      </button>
      <noscript>
        <p className="form-error" role="alert">
          このページの操作にはJavaScriptが必要です。ブラウザの設定をご確認ください。
        </p>
      </noscript>
    </div>
  );
}
