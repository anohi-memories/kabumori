import { BrandContextError, type BrandContext } from "./brand_context.ts";
import { assertBrandDryRunAllowed } from "./publish_guard.ts";

export type BrandDryRunPreview = {
  brandId: string;
  displayName: string;
  postType: string;
  promptPreamble: string;
  voiceInstructions: readonly string[];
  fixedHashtags: readonly string[];
  xTokenLoaderCalled: 0;
  xApiCalled: 0;
};

/** A pure, no-network preflight used before a brand receives an actual publisher. */
export function buildBrandDryRunPreview(
  context: BrandContext,
  postType: string,
): BrandDryRunPreview {
  assertBrandDryRunAllowed(context);
  if (!context.codeProfile.dryRunPostTypes.includes(postType)) {
    throw new BrandContextError("BRAND_DRY_RUN_POST_TYPE_UNSUPPORTED");
  }
  return {
    brandId: context.brand.id,
    displayName: context.brand.display_name,
    postType,
    promptPreamble: context.codeProfile.dryRunPromptPreamble,
    voiceInstructions: context.codeProfile.voiceInstructions,
    fixedHashtags: context.codeProfile.reportFixedHashtags,
    xTokenLoaderCalled: 0,
    xApiCalled: 0,
  };
}
