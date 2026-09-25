import { type NextRequest } from "next/server";
import { redirect } from "next/navigation";
import { createAdminServerClient } from "@/lib/supabase/server";
import {
  FORGOT_PASSWORD_PATH,
  RESET_PASSWORD_PATH,
  resolveConfirmAction,
} from "@/lib/password-recovery";

// Receiver for password recovery and invite email links. It establishes the
// session server-side (so no token is ever handled by page JavaScript for the
// PKCE and token_hash forms) and then redirects to a fixed same-origin path.
// The destination is never read from the request, so this cannot be used as
// an open redirect. Nothing about the link, token, or user is logged.
export async function GET(request: NextRequest) {
  const action = resolveConfirmAction(request.nextUrl.searchParams);

  if (action.kind === "invalid") {
    redirect(`${FORGOT_PASSWORD_PATH}?reason=link_invalid`);
  }

  if (action.kind === "forward_fragment") {
    // Implicit-flow tokens (if any) live in the URL fragment, which the
    // browser carries across this redirect to /reset-password.
    redirect(RESET_PASSWORD_PATH);
  }

  const supabase = await createAdminServerClient();
  const { error } =
    action.kind === "verify_otp"
      ? await supabase.auth.verifyOtp({ type: action.type, token_hash: action.tokenHash })
      : await supabase.auth.exchangeCodeForSession(action.code);

  redirect(error ? `${FORGOT_PASSWORD_PATH}?reason=link_invalid` : RESET_PASSWORD_PATH);
}
