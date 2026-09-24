// Code-owned registry of the brands this admin app can operate on.
//
// Why code, not a `brands` table read: RLS on `public.brands` (and `public.social_accounts`) only has the
// social-mobile membership SELECT policy -- there is no admin_users / private.is_admin() SELECT policy on
// either table, so a global admin (no brand_memberships row) sees zero rows from them. Adding such a
// policy is a DB change this phase is not allowed to make. The operational tables this app actually
// reads (scheduled_posts, post_execution_logs, posting_windows, *_report_runs) DO have admin SELECT
// policies -- which also means RLS does NOT scope a global admin to any brand on those tables, and the
// explicit brand_id filter in every lib/*.ts query is the only brand boundary for them.
//
// A brand id that is not listed here can never become the active brand (see selected-brand.ts), so this
// list is also the allowlist for the selector. `mio` is intentionally absent: it is disabled and has no
// operational rows to show.
export type AdminBrandDefinition = {
  id: string;
  label: string;
  // Used only to build public x.com links for already-posted items. Kept here (not read from
  // social_accounts) for the RLS reason above.
  xHandle: string;
};

export const ADMIN_BRANDS: readonly AdminBrandDefinition[] = [
  { id: "kabumori", label: "かぶモリ", xHandle: "yume_daka" },
  { id: "ai_salaryman_lab", label: "会社員AIラボ", xHandle: "kaishain_ai_lab" },
];
