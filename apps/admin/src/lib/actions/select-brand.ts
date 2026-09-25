"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { ADMIN_BRANDS } from "@/lib/admin-brands";
import { resolveAdminBrandAccess } from "@/lib/admin-context";
import { BRAND_SELECTION_COOKIE, chooseAdminActiveBrand } from "@/lib/selected-brand";
import { createAdminServerClient } from "@/lib/supabase/server";

const SELECTION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Persists the admin's brand selection. The cookie is only a selector: getActiveBrandContext()
 * re-validates it on every request. The action also independently requires admin_users authority;
 * a brand membership alone cannot set an admin-app selection.
 */
export async function selectAdminBrand(formData: FormData): Promise<void> {
  const requested = formData.get("brand_id");
  if (typeof requested !== "string" || requested.length === 0) return;

  const supabase = await createAdminServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return;

  const access = await resolveAdminBrandAccess(supabase, user.id);
  const resolution = chooseAdminActiveBrand({ access, requestedBrandId: requested, registry: ADMIN_BRANDS });
  if (resolution.kind !== "ok" || resolution.selectionRejected) return;

  (await cookies()).set(BRAND_SELECTION_COOKIE, resolution.active.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SELECTION_MAX_AGE_SECONDS,
  });
  revalidatePath("/", "layout");
}
