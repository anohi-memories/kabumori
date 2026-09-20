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

/**
 * Allows text generation for the authenticated user's isolated mobile preview even when the workspace
 * remains inactive/disabled. This is not a publishing permission; the dedicated preview handler has no
 * scheduled-post, X, or token-loading dependency and must prove owner membership before calling it.
 */
export function assertSocialMobilePreviewGenerationAllowed(context: BrandContext): void {
  if (context.brand.code_profile_key !== "social_mobile_user_v1" || context.codeProfile.key !== "social_mobile_user_v1") {
    throw new BrandContextError("SOCIAL_MOBILE_PREVIEW_PROFILE_REQUIRED");
  }
}
