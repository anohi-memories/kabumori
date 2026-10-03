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
import { collectAiLabContentViolations } from "./ai_lab_theme_guard.ts";

// 汎用テーマ・「個人開発は、」書き出し・直近投稿との重複で弾かれた場合に、再生成する最大試行回数
// （初回を含む）。全て不合格なら投稿せず失敗側に倒す（重複投稿を出すより1枠見送る方が安全）。
export const AI_LAB_MAX_GENERATION_ATTEMPTS = 3;

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
  loadRecentFingerprints,
  publishText,
  completePublishedPost,
  generate = generateBrandPost,
  topicSeed = "",
  recentPostTexts = [],
  onContentRejected,
  recordTopicUsage,
}: {
  context: BrandContext;
  postType: string;
  scheduledPostId: string;
  openAiApiKey: string;
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
    /** Violations of the previous attempt (empty on the first attempt) so the prompt can name them. */
    retryViolations: readonly string[];
  }) => Promise<BrandPostDraft>;
  /** The topic seed handed to the generator; a generic theme explicitly in the seed is allowed in the text. */
  topicSeed?: string;
  /** Recent own-post texts, when the caller has them. Hash-only history cannot supply these today. */
  recentPostTexts?: readonly string[];
  onContentRejected?: (info: { attempt: number; violations: readonly string[] }) => void;
  /**
   * Marks the selected topic event as used. Called exactly once, only after X confirmed the post (never on
   * a generation, guard, or X failure) and before completion, so an uncertain completion still consumes
   * the event. Any rejection/false is absorbed: it must never turn a confirmed X post into a retry.
   */
  recordTopicUsage?: (args: { scheduledPostId: string; xPostId: string }) => Promise<boolean>;
}): Promise<{
  brandId: "ai_salaryman_lab";
  postType: "brand_post";
  characterCount: number;
  xPostId: string;
  fingerprintPersisted: boolean;
  topicUsagePersisted: boolean | null;
}> {
  if (context.brand.id !== "ai_salaryman_lab") {
    throw new BrandContextError("AI_LAB_DISPATCH_BRAND_MISMATCH");
  }
  if (postType !== "brand_post") {
    throw new BrandContextError("AI_LAB_POST_TYPE_NOT_ENABLED");
  }
  assertBrandPublishAllowed(context);

  const recentFingerprints = await loadRecentFingerprints();
  let draft: BrandPostDraft | null = null;
  let retryViolations: readonly string[] = [];
  for (let attempt = 1; attempt <= AI_LAB_MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const candidate = await generate({ openAiApiKey, context, postType, retryViolations });
    if (candidate.brandId !== "ai_salaryman_lab" || candidate.postType !== "brand_post") {
      throw new BrandContextError("AI_LAB_GENERATION_CONTEXT_MISMATCH");
    }
    const violations = collectAiLabContentViolations({
      text: candidate.text,
      seedText: topicSeed,
      recentPostTexts,
    });
    if (violations.length === 0) {
      draft = candidate;
      break;
    }
    onContentRejected?.({ attempt, violations });
    retryViolations = violations;
  }
  if (!draft) throw new BrandContextError("AI_LAB_CONTENT_DIVERSITY_REJECTED");

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

  let topicUsagePersisted: boolean | null = null;
  if (recordTopicUsage) {
    try {
      topicUsagePersisted = await recordTopicUsage({ scheduledPostId, xPostId });
    } catch {
      topicUsagePersisted = false;
    }
  }

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
    topicUsagePersisted,
  };
}
