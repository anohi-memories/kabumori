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
