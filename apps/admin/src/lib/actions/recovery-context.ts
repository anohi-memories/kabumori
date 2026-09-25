"use server";

import { createAdminServerClient } from "@/lib/supabase/server";
import { hasRecoveryContext } from "@/lib/password-recovery";

/**
 * Server-side recovery/invite authority check, used both when /reset-password
 * renders and again immediately before the password update is sent, so a form
 * left open past the window cannot still change the password.
 *
 * getClaims() verifies the session JWT (signature, or the Auth server for
 * legacy symmetric keys) before its amr claim is trusted, and the freshness
 * window is measured against the server's clock, not the browser's. The
 * password itself never passes through this action.
 */
export async function verifyRecoveryContext(): Promise<boolean> {
  const supabase = await createAdminServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || data === null) return false;
  return hasRecoveryContext(data.claims.amr, Math.floor(Date.now() / 1000));
}
