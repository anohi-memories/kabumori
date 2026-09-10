import {
  BrandContextError,
  type BrandContext,
} from "./brand_context.ts";

/** Blocks every X send unless this exact brand is configured and live. */
export function assertBrandPublishAllowed(context: BrandContext): void {
  if (!context.brand.is_active) throw new BrandContextError("BRAND_DISABLED");
  if (context.brand.publish_mode !== "live") {
    throw new BrandContextError(
      context.brand.publish_mode === "dry_run"
        ? "BRAND_PUBLISH_MODE_DRY_RUN"
        : "BRAND_PUBLISH_MODE_DISABLED",
    );
  }
  if (!context.socialAccount || !context.socialAccount.publish_enabled) {
    throw new BrandContextError("BRAND_X_ACCOUNT_DISABLED");
  }
}

/**
 * Generation previews may run for a deliberately dry-run brand, but never for
 * a disabled/unknown one. This is intentionally separate from the X boundary.
 */
export function assertBrandDryRunAllowed(context: BrandContext): void {
  if (!context.brand.is_active) throw new BrandContextError("BRAND_DISABLED");
  if (context.brand.publish_mode !== "dry_run" && context.brand.publish_mode !== "live") {
    throw new BrandContextError("BRAND_PUBLISH_MODE_DISABLED");
  }
}
