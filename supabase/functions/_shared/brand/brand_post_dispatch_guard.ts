import { type BrandContext, BrandContextError } from "./brand_context.ts";
import { assertPostWithinLengthPolicy } from "./post_length_policy.ts";

/** Final pre-X boundary check for the AI Lab scheduled brand_post branch. */
export function assertAiLabBrandPostDispatchAllowed(
  context: BrandContext,
  postType: string,
  text: string,
): number {
  if (
    context.brand.id !== "ai_salaryman_lab" ||
    context.socialAccount?.id !== "ai_salaryman_lab_x" ||
    context.socialAccount.brand_id !== "ai_salaryman_lab" ||
    context.socialAccount.platform !== "x" ||
    context.socialAccount.handle !== "kaishain_ai_lab"
  ) {
    throw new BrandContextError("AI_LAB_DISPATCH_ACCOUNT_MISMATCH");
  }
  if (
    postType !== "brand_post" ||
    !context.operationalSettings.enabled_post_types.includes("brand_post")
  ) {
    throw new BrandContextError("AI_LAB_POST_TYPE_NOT_ENABLED");
  }
  const policy = context.codeProfile.postLengthPolicy;
  if (!policy) {
    throw new BrandContextError("AI_LAB_LENGTH_POLICY_NOT_CONFIGURED");
  }
  try {
    return assertPostWithinLengthPolicy(policy, text);
  } catch (error) {
    if (
      error instanceof Error && error.message === "POST_LENGTH_LIMIT_EXCEEDED"
    ) {
      throw new BrandContextError("BRAND_POST_LENGTH_LIMIT_EXCEEDED");
    }
    throw error;
  }
}
