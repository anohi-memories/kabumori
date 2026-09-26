"use client";

import Link from "next/link";
import { KeyboardEvent, useState } from "react";
import { clearInvitePurpose, verifyRecoveryContext } from "@/lib/actions/recovery-context";
import { createAdminBrowserClient } from "@/lib/supabase/client";
import {
  completePasswordReset,
  PASSWORD_MIN_LENGTH,
  signOutConfirmed,
  type CompleteResetResult,
} from "@/lib/password-recovery";

const PASSWORD_UPDATED_LOGIN = "/login?reason=password_updated";

const INVALID_MESSAGES: Readonly<
  Record<Extract<CompleteResetResult, { status: "invalid" }>["reason"], string>
> = {
  empty: "新しいパスワードを2回入力してください。",
  too_short: `パスワードは${PASSWORD_MIN_LENGTH}文字以上にしてください。`,
  too_long: "パスワードが長すぎます。短くしてください。",
  mismatch: "確認用のパスワードが一致しません。",
};

type SignOutRetryState = "idle" | "retrying" | "failed";

export function ResetPasswordForm() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [needsNewLink, setNeedsNewLink] = useState(false);
  // Set once the password has changed but sign-out could not be confirmed.
  const [signOutPending, setSignOutPending] = useState(false);
  const [signOutRetry, setSignOutRetry] = useState<SignOutRetryState>("idle");

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
      // Re-verified server-side right now, not trusted from page render.
      verifyRecoveryContext,
      // The invite-purpose binding is dropped as soon as the password is set.
      clearInvitePurpose,
    );
    if (result.status === "updated") {
      // Full navigation so the now signed-out state is what the server sees,
      // replacing this page so Back does not return to the reset form.
      window.location.replace(PASSWORD_UPDATED_LOGIN);
      return;
    }
    setIsSubmitting(false);
    switch (result.status) {
      case "updated_signout_unconfirmed":
        setPassword("");
        setConfirmation("");
        setSignOutPending(true);
        return;
      case "invalid":
        setErrorMessage(INVALID_MESSAGES[result.reason]);
        return;
      case "no_context":
        setErrorMessage(
          "リンクの有効期限が切れたため、パスワードを変更できませんでした。再設定メールを送り直してください。",
        );
        setNeedsNewLink(true);
        return;
      case "failed":
        setErrorMessage(
          "パスワードを更新できませんでした。リンクの有効期限が切れた可能性があります。",
        );
        setNeedsNewLink(true);
        return;
    }
  }

  async function handleRetrySignOut() {
    if (signOutRetry === "retrying") return;
    setSignOutRetry("retrying");
    if (await signOutConfirmed(createAdminBrowserClient().auth)) {
      window.location.replace(PASSWORD_UPDATED_LOGIN);
      return;
    }
    setSignOutRetry("failed");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void handleSubmit();
  }

  if (signOutPending) {
    // The password has changed, but this browser may still hold the recovery
    // session. Say exactly that; do not claim the user was signed out.
    return (
      <div className="login-form">
        <p className="form-error" role="alert">
          パスワードは変更されましたが、ログアウトを確認できませんでした。この画面を開いたまま離れず、下のボタンでログアウトをやり直してください。
        </p>
        {signOutRetry === "failed" ? (
          <p className="form-error" role="alert">
            ログアウトできませんでした。このブラウザを閉じてから、新しいパスワードでログインし直してください。
          </p>
        ) : null}
        <button
          className="primary-button"
          type="button"
          disabled={signOutRetry === "retrying"}
          onClick={() => void handleRetrySignOut()}
        >
          {signOutRetry === "retrying" ? "ログアウト中…" : "ログアウトを再試行"}
        </button>
      </div>
    );
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
