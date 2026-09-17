import { type BrandContext, BrandContextError } from "./brand_context.ts";
import { assertBrandPublishAllowed } from "./publish_guard.ts";
import { assertAiLabBrandPostDispatchAllowed } from "./brand_post_dispatch_guard.ts";
import {
  checkCrossBrandDuplicate,
  fingerprintText,
  type PublishedFingerprint,
} from "./cross_brand_dedupe.ts";
import {
  type BrandPostDraft,
  generateBrandPost,
} from "./brand_post_generator.ts";
import type { DailyContentPlanItem } from "./daily_content_plan.ts";

export type AiLabBrandPostCompletion = {
  fingerprintPersisted: boolean;
};

export class AiLabConfirmedPostCompletionError extends Error {
  constructor() {
    super("AI_LAB_POST_CONFIRMED_COMPLETION_UNCONFIRMED");
    this.name = "AiLabConfirmedPostCompletionError";
  }
}

function xPostIdFrom(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const data = (response as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function dispatchAiLabScheduledBrandPost({
  context,
  postType,
  scheduledPostId,
  openAiApiKey,
  scheduleDate,
  slotNo,
  loadContentPlan,
  loadRecentFingerprints,
  publishText,
  completePublishedPost,
  generate = generateBrandPost,
}: {
  context: BrandContext;
  postType: string;
  scheduledPostId: string;
  openAiApiKey: string;
  scheduleDate?: string;
  slotNo?: number;
  loadContentPlan?: (args: {
    scheduleDate: string;
    slotNo: number;
  }) => Promise<DailyContentPlanItem | null>;
  loadRecentFingerprints: () => Promise<PublishedFingerprint[]>;
  publishText: (text: string) => Promise<unknown>;
  completePublishedPost: (args: {
    scheduledPostId: string;
    xPostId: string;
    normalizedTextSha256: string;
  }) => Promise<AiLabBrandPostCompletion>;
  generate?: (args: {
    openAiApiKey: string;
    context: BrandContext;
    postType: string;
    contentPlan?: DailyContentPlanItem;
  }) => Promise<BrandPostDraft>;
}): Promise<{
  brandId: "ai_salaryman_lab";
  postType: "brand_post";
  characterCount: number;
  xPostId: string;
  fingerprintPersisted: boolean;
}> {
  if (context.brand.id !== "ai_salaryman_lab") {
    throw new BrandContextError("AI_LAB_DISPATCH_BRAND_MISMATCH");
  }
  if (postType !== "brand_post") {
    throw new BrandContextError("AI_LAB_POST_TYPE_NOT_ENABLED");
  }
  assertBrandPublishAllowed(context);

  const recentFingerprints = await loadRecentFingerprints();
  const contentPlan =
    loadContentPlan && scheduleDate && typeof slotNo === "number"
      ? await loadContentPlan({ scheduleDate, slotNo })
      : undefined;
  const draft = await generate({
    openAiApiKey,
    context,
    postType,
    contentPlan: contentPlan ?? undefined,
  });
  if (draft.brandId !== "ai_salaryman_lab" || draft.postType !== "brand_post") {
    throw new BrandContextError("AI_LAB_GENERATION_CONTEXT_MISMATCH");
  }

  // Independent of the generation prompt and generator check: this is the final gate directly before
  // handing text to the existing X text-post abstraction.
  const characterCount = assertAiLabBrandPostDispatchAllowed(
    context,
    postType,
    draft.text,
  );
  const duplicate = await checkCrossBrandDuplicate({
    brandId: context.brand.id,
    candidateText: draft.text,
    recentFingerprints,
  });
  if (duplicate.blocked) {
    throw new BrandContextError("AI_LAB_CROSS_BRAND_DUPLICATE");
  }

  const normalizedTextSha256 = await fingerprintText(draft.text);
  // Keep this second invocation adjacent to the X callback so later edits cannot accidentally add
  // decoration or another text transform after the length check.
  assertAiLabBrandPostDispatchAllowed(context, postType, draft.text);
  const xResponse = await publishText(draft.text);
  const xPostId = xPostIdFrom(xResponse);
  if (!xPostId) throw new Error("X_RESPONSE_MISSING_POST_ID");

  let completion: AiLabBrandPostCompletion;
  try {
    completion = await completePublishedPost({
      scheduledPostId,
      xPostId,
      normalizedTextSha256,
    });
  } catch {
    // The X write is confirmed. Never let the outer handler call fail_scheduled_post here; keeping the
    // schedule row non-pending is safer than risking a second X write after an uncertain DB response.
    throw new AiLabConfirmedPostCompletionError();
  }

  return {
    brandId: "ai_salaryman_lab",
    postType: "brand_post",
    characterCount,
    xPostId,
    fingerprintPersisted: completion.fingerprintPersisted,
  };
}
