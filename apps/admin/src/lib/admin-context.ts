import type { SupabaseClient } from "@supabase/supabase-js";

// Phase 1 of the multibrand admin context (design doc:
// docs/phase1-netlify-thin-control-plane.md). This module only RESOLVES which brands the signed-in
// admin may see; it does not change what any existing page queries. Every current page still hardcodes
// KABUMORI_BRAND_ID (enforced by brand-boundary.test.ts) -- wiring this resolver into an explicit
// brand selector is the next, separate step once the UI/UX for switching brands is designed and
// reviewed, so that today's Kabumori-only behavior is never put at risk by this change alone.
//
// Authority model:
// - `admin_users` membership (already used by (admin)/layout.tsx to gate access to this app at all) is
//   treated as GLOBAL admin authority: a global admin may act on any brand. This matches how the wider
//   system already uses `admin_users` / `private.is_admin()` as a cross-brand override policy elsewhere
//   (e.g. the `admin_select_*` RLS policies alongside the Phase 5 social-mobile `brand_memberships`
//   tenant policies) -- this module does not invent a new authority concept, it exposes the existing one
//   in a typed, admin-app-local form.
// - `brand_memberships` rows with role 'owner' or 'admin' resolve BRAND-SCOPED authority for callers
//   that support it. They do not grant entry to this admin app: the layout, independently rendered
//   pages, and Server Actions still require an `admin_users` row. 'member'/'viewer' roles are not
//   admin authority here.

export type AdminBrandAccess =
  | { kind: "global"; brandIds: null }
  | { kind: "scoped"; brandIds: string[] };

type BrandMembershipRow = { brand_id: string; role: string };

const BRAND_ADMIN_ROLES = new Set(["owner", "admin"]);

/**
 * Resolves which brands `userId` (confirmed to be a real signed-in user by the caller) may act on.
 * Callers in this admin app separately require `admin_users` before accepting the result as authority.
 * Never trusts a client-supplied brand id or user id -- `userId` must come from
 * `supabase.auth.getUser()` on the current request, and every read here is scoped to that exact id.
 */
export async function resolveAdminBrandAccess(
  supabase: SupabaseClient,
  userId: string,
): Promise<AdminBrandAccess> {
  const { data: adminRow, error: adminError } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (adminError) {
    console.error("[admin/admin-context] admin_users query failed", { code: adminError.code });
  }
  if (adminRow) {
    return { kind: "global", brandIds: null };
  }

  const { data: membershipRows, error: membershipError } = await supabase
    .from("brand_memberships")
    .select("brand_id,role")
    .eq("user_id", userId);
  if (membershipError) {
    console.error("[admin/admin-context] brand_memberships query failed", { code: membershipError.code });
    return { kind: "scoped", brandIds: [] };
  }

  const rows = (membershipRows ?? []) as BrandMembershipRow[];
  const brandIds = [...new Set(
    rows.filter((row) => BRAND_ADMIN_ROLES.has(row.role)).map((row) => row.brand_id),
  )];
  return { kind: "scoped", brandIds };
}

/** True if `access` permits acting on `brandId` -- global admins may act on any brand id. */
export function canAccessBrand(access: AdminBrandAccess, brandId: string): boolean {
  return access.kind === "global" || access.brandIds.includes(brandId);
}
