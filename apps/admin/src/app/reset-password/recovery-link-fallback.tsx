"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createAdminBrowserClient } from "@/lib/supabase/client";
import {
  establishSessionFromFragment,
  parseRecoveryFragment,
  RESET_PASSWORD_PATH,
} from "@/lib/password-recovery";

type FallbackState = "checking" | "no_link" | "invalid";

// Rendered when the server found no fresh recovery/invite session. The one
// legitimate way to arrive here with credentials is the implicit flow used by
// Supabase's default invite template, which puts tokens in the URL fragment
// (never sent to the server). Only recovery/invite fragments are accepted; the
// fragment is stripped from the address bar before anything else happens, and
// the page is then reloaded so the server re-checks the new session.
export function RecoveryLinkFallback() {
  const [state, setState] = useState<FallbackState>("checking");

  useEffect(() => {
    const fragment = parseRecoveryFragment(window.location.hash);
    if (fragment.kind !== "none") {
      window.history.replaceState(null, "", window.location.pathname);
    }
    let cancelled = false;
    void establishSessionFromFragment(createAdminBrowserClient().auth, fragment).then((status) => {
      // Not gated on `cancelled`: in development StrictMode the effect runs
      // twice and the first run is the one that consumed the fragment.
      if (status === "established") {
        window.location.replace(RESET_PASSWORD_PATH);
        return;
      }
      if (cancelled) return;
      setState(status === "invalid" ? "invalid" : "no_link");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "checking") {
    return <p className="login-description" role="status">リンクを確認しています…</p>;
  }

  return (
    <>
      <p className="form-error" role="alert">
        {state === "invalid"
          ? "リンクが無効か、有効期限が切れています。"
          : "この画面は、パスワード再設定メールまたは招待メールのリンクから開いてください。"}
      </p>
      <p className="login-description">
        <Link className="text-link" href="/forgot-password">再設定メールを送信する</Link>
        {" ・ "}
        <Link className="text-link" href="/login">ログイン画面に戻る</Link>
      </p>
    </>
  );
}
