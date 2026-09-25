import { type NextRequest } from "next/server";
import { redirect } from "next/navigation";
import { createAdminServerClient } from "@/lib/supabase/server";
import {
  CONFIRM_FAILURE_DESTINATION,
  CONFIRM_SUCCESS_DESTINATION,
  resolveConfirmAction,
} from "@/lib/password-recovery";

// Receiver for password recovery and invite email links. It establishes the
// session server-side (so no token is ever handled by page JavaScript for the
// PKCE and token_hash forms) and then redirects to one of two fixed
// same-origin destinations. The destination is never read from the request,
// so this cannot be used as an open redirect; see CONFIRM_*_DESTINATION for why
// each carries its own query string. Nothing about the link, token, or user is
// logged. Session cookies written by verifyOtp / exchangeCodeForSession are
// attached to the redirect response by Next.js.
export async function GET(request: NextRequest) {
  const action = resolveConfirmAction(request.nextUrl.searchParams);

  if (action.kind === "invalid") redirect(CONFIRM_FAILURE_DESTINATION);

  // Implicit-flow tokens (if any) live in the URL fragment, which the browser
  // carries across this redirect to /reset-password.
  if (action.kind === "forward_fragment") redirect(CONFIRM_SUCCESS_DESTINATION);

  const supabase = await createAdminServerClient();
  const { error } =
    action.kind === "verify_otp"
      ? await supabase.auth.verifyOtp({ type: action.type, token_hash: action.tokenHash })
      : await supabase.auth.exchangeCodeForSession(action.code);

  redirect(error ? CONFIRM_FAILURE_DESTINATION : CONFIRM_SUCCESS_DESTINATION);
}
