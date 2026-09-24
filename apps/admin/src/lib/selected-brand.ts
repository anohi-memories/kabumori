import { canAccessBrand, type AdminBrandAccess } from "./admin-context.ts";
import { KABUMORI_BRAND_ID } from "./brand-boundary.ts";
import type { AdminBrandDefinition } from "./admin-brands.ts";

// The persisted selection is only ever a *request*. It is re-validated against the signed-in admin's
// authority on every request (server-side, in active-brand.ts) before any query sees it.
export const BRAND_SELECTION_COOKIE = "kabumori_admin_brand";

declare const authorizedBrandMarker: unique symbol;
/**
 * A brand id that has already been checked against the current admin's authority and the ADMIN_BRANDS
 * allowlist. Every lib/*.ts operational query takes this type, not a plain string, so a raw client
 * value (cookie, form field, query param) cannot be passed to a query without going through
 * chooseActiveBrand() first.
 */
export type AuthorizedBrandId = string & { readonly [authorizedBrandMarker]: true };

export type ActiveBrand = {
  id: AuthorizedBrandId;
  label: string;
  xHandle: string;
};

export type ActiveBrandResolution =
  | {
      kind: "ok";
      active: ActiveBrand;
      options: AdminBrandDefinition[];
      // True when a selection was requested but not honored (unknown id, or outside this admin's
      // authority). The active brand then falls back to the default -- never to the requested one.
      selectionRejected: boolean;
    }
  | { kind: "no_brand" };

function toActive(brand: AdminBrandDefinition): ActiveBrand {
  return { id: brand.id as AuthorizedBrandId, label: brand.label, xHandle: brand.xHandle };
}

export function chooseActiveBrand({
  access,
  requestedBrandId,
  registry,
}: {
  access: AdminBrandAccess;
  requestedBrandId: string | null | undefined;
  registry: readonly AdminBrandDefinition[];
}): ActiveBrandResolution {
  const options = registry.filter((brand) => canAccessBrand(access, brand.id));
  if (options.length === 0) return { kind: "no_brand" };

  const requested = requestedBrandId?.trim() || null;
  const honored = requested ? options.find((brand) => brand.id === requested) : undefined;
  if (honored) {
    return { kind: "ok", active: toActive(honored), options, selectionRejected: false };
  }

  // Default: a scoped admin with exactly one brand gets that brand; otherwise Kabumori when authorized
  // (preserves the pre-Phase-2 behavior for today's global admins); otherwise the first authorized brand
  // in registry order.
  const fallback =
    access.kind === "scoped" && options.length === 1
      ? options[0]
      : options.find((brand) => brand.id === KABUMORI_BRAND_ID) ?? options[0];
  return { kind: "ok", active: toActive(fallback), options, selectionRejected: requested !== null };
}
