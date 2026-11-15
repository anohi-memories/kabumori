"use server";

import { cookies } from "next/headers";
import { createAdminServerClient } from "@/lib/supabase/server";
import {
  CLEARED_INVITE_PURPOSE_COOKIE_OPTIONS,
  hasPasswordSetupAuthority,
  INVITE_PURPOSE_COOKIE,
  readInviteBindingSecret,
} from "@/lib/invite-purpose";

/**
 * Server-side recovery/invite authority check, used both when /reset-password
 * renders and again immediately before the password update is sent, so a form
 * left open past the window cannot still change the password.
 *
 * getClaims() verifies the session JWT (signature, or the Auth server for
 * legacy symmetric keys) before its amr / sub / session_id claims are trusted,
 * the invite-purpose cookie is checked against those verified claims, and the
 * freshness window is measured against the server's clock, not the browser's.
 * The password itself never passes through this action.
 */
export async function verifyRecoveryContext(): Promise<boolean> {
  const supabase = await createAdminServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || data === null) return false;
  const cookieStore = await cookies();
  return hasPasswordSetupAuthority({
    claims: data.claims,
    invitePurposeToken: cookieStore.get(INVITE_PURPOSE_COOKIE)?.value ?? null,
    secret: readInviteBindingSecret(),
    nowSeconds: Math.floor(Date.now() / 1000),
  });
}

/**
 * Drops the invite-purpose binding once the password has been set. It only
 * ever removes the cookie, so exposing it as an action grants nothing.
 */
export async function clearInvitePurpose(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(INVITE_PURPOSE_COOKIE, "", CLEARED_INVITE_PURPOSE_COOKIE_OPTIONS);
}
