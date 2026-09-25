import { type NextRequest, NextResponse } from "next/server";
import { createAdminServerClient } from "@/lib/supabase/server";
import {
  buildSameOriginRedirect,
  FORGOT_PASSWORD_PATH,
  RESET_PASSWORD_PATH,
  resolveConfirmAction,
} from "@/lib/password-recovery";

const LINK_INVALID_PATH = `${FORGOT_PASSWORD_PATH}?reason=link_invalid`;

// Receiver for password recovery and invite email links. It establishes the
// session server-side (so no token is ever handled by page JavaScript for the
// PKCE and token_hash forms) and then redirects to a fixed same-origin path.
// The destination is never read from the request, and the incoming query
// string is never carried over, so this cannot be used as an open redirect and
// consumed link material does not end up in the next page's URL or history.
// Nothing about the link, token, or user is logged.
export async function GET(request: NextRequest) {
  const redirectTo = (path: string) =>
    NextResponse.redirect(buildSameOriginRedirect(request.url, path), 307);

  const action = resolveConfirmAction(request.nextUrl.searchParams);

  if (action.kind === "invalid") return redirectTo(LINK_INVALID_PATH);

  if (action.kind === "forward_fragment") {
    // Implicit-flow tokens (if any) live in the URL fragment, which the
    // browser carries across this redirect to /reset-password.
    return redirectTo(RESET_PASSWORD_PATH);
  }

  // Session cookies written here are merged into the returned redirect by
  // Next.js (route handler mutable cookies).
  const supabase = await createAdminServerClient();
  const { error } =
    action.kind === "verify_otp"
      ? await supabase.auth.verifyOtp({ type: action.type, token_hash: action.tokenHash })
      : await supabase.auth.exchangeCodeForSession(action.code);

  return redirectTo(error ? LINK_INVALID_PATH : RESET_PASSWORD_PATH);
}
