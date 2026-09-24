import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { ADMIN_BRANDS } from "@/lib/admin-brands";
import { resolveAdminBrandAccess } from "@/lib/admin-context";
import {
  BRAND_SELECTION_COOKIE,
  chooseActiveBrand,
  type ActiveBrand,
  type ActiveBrandResolution,
} from "@/lib/selected-brand";
import { createAdminServerClient } from "@/lib/supabase/server";

export type ActiveBrandContext = ActiveBrandResolution | { kind: "unauthenticated" };

/**
 * Resolves the active brand for the current request. Runs on every request (memoized per request via
 * React cache so the layout and page share one resolution): identity always comes from
 * supabase.auth.getUser(), authority from resolveAdminBrandAccess(), and the cookie value is treated only
 * as a request to be validated -- never as authority.
 */
export const getActiveBrandContext = cache(async (): Promise<ActiveBrandContext> => {
  const supabase = await createAdminServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return { kind: "unauthenticated" };

  const access = await resolveAdminBrandAccess(supabase, user.id);
  const requestedBrandId = (await cookies()).get(BRAND_SELECTION_COOKIE)?.value ?? null;
  return chooseActiveBrand({ access, requestedBrandId, registry: ADMIN_BRANDS });
});

/**
 * For pages: the authorized active brand, or a redirect. The (admin) layout performs the same checks,
 * but a page renders in parallel with its layout, so each page resolves its own brand before querying.
 */
export async function requireActiveBrand(): Promise<ActiveBrand> {
  const context = await getActiveBrandContext();
  if (context.kind === "unauthenticated") redirect("/login");
  if (context.kind !== "ok") redirect("/unauthorized");
  return context.active;
}
