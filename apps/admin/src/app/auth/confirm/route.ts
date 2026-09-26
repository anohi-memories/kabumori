import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminServerClient } from "@/lib/supabase/server";
import {
  CLEARED_INVITE_PURPOSE_COOKIE_OPTIONS,
  confirmEmailLink,
  INVITE_PURPOSE_COOKIE,
  INVITE_PURPOSE_COOKIE_OPTIONS,
  readInviteBindingSecret,
} from "@/lib/invite-purpose";
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
// logged. Session cookies written by verifyOtp / exchangeCodeForSession, and
// the invite-purpose cookie, are attached to the redirect response by Next.js.
export async function GET(request: NextRequest) {
  const action = resolveConfirmAction(request.nextUrl.searchParams);

  // Any earlier invite-purpose binding is dropped on every link; only an
  // invite verified by this request (below) issues a new one.
  const cookieStore = await cookies();
  cookieStore.set(INVITE_PURPOSE_COOKIE, "", CLEARED_INVITE_PURPOSE_COOKIE_OPTIONS);

  if (action.kind === "invalid") redirect(CONFIRM_FAILURE_DESTINATION);

  // Implicit-flow tokens (if any) live in the URL fragment, which the browser
  // carries across this redirect to /reset-password.
  if (action.kind === "forward_fragment") redirect(CONFIRM_SUCCESS_DESTINATION);

  const supabase = await createAdminServerClient();
  const outcome = await confirmEmailLink(supabase.auth, action, readInviteBindingSecret(), () =>
    Math.floor(Date.now() / 1000),
  );
  if (outcome.invitePurposeToken !== null) {
    cookieStore.set(INVITE_PURPOSE_COOKIE, outcome.invitePurposeToken, INVITE_PURPOSE_COOKIE_OPTIONS);
  }

  redirect(outcome.destination);
}
