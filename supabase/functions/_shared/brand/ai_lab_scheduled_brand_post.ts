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
import type { AiLabTopicPort } from "./ai_lab_brand_post_store.ts";

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

/** X 前の失敗を、解除理由コード（DB の CHECK に合う形）へ写す。本文やメッセージ全体は使わない。 */
export function preXReleaseReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^BRAND_POST_(GENERATION_FAILED|EMPTY_OUTPUT|LENGTH_LIMIT_EXCEEDED)/u.test(message)) return "PRE_X_GENERATION_FAILED";
  if (message === "AI_LAB_CONTENT_DIVERSITY_REJECTED") return "PRE_X_CONTENT_REJECTED";
  if (message === "AI_LAB_CROSS_BRAND_DUPLICATE") return "PRE_X_FINGERPRINT_BLOCKED";
  return "PRE_X_FAILED";
}

/**
 * X が「明確に受け付けなかった」と言える応答だけを返す（その場合だけ確保を解除できる）。
 * 400/401/422/429 は X が投稿を作らずに返す拒否。403（重複投稿を含む）・5xx・通信断・タイムアウト・
 * 応答喪失・その他の例外は「投稿されていない」と証明できないので null（＝結果不明として保持）。
 */
export function definitiveProviderRejection(error: unknown): number | null {
  const match = /^X_REQUEST_FAILED:(400|401|422|429)$/u.exec(error instanceof Error ? error.message : "");
  return match ? Number(match[1]) : null;
}

export async function dispatchAiLabScheduledBrandPost({
  context,
  postType,
  scheduledPostId,
  openAiApiKey,
  topic,
  loadRecentFingerprints,
  publishText,
  completePublishedPost,
  generate = generateBrandPost,
  recentPostTexts = [],
  onContentRejected,
}: {
  context: BrandContext;
  postType: string;
  scheduledPostId: string;
  openAiApiKey: string;
  /**
   * 題材イベントの確保ポート（必須）。X 送信前に1イベントを確保し、X の前後で解除・保持・確定する。
   * 同じイベントを2つの処理が同時に投稿できないこと、結果不明のイベントを再開放しないことはここで担保する。
   */
  topic: AiLabTopicPort;
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
    /** The claimed topic seed for this post. */
    topicSeed: string;
    /** Violations of the previous attempt (empty on the first attempt) so the prompt can name them. */
    retryViolations: readonly string[];
  }) => Promise<BrandPostDraft>;
  /** Recent own-post texts, when the caller has them. Hash-only history cannot supply these today. */
  recentPostTexts?: readonly string[];
  onContentRejected?: (info: { attempt: number; violations: readonly string[] }) => void;
}): Promise<{
  brandId: "ai_salaryman_lab";
  postType: "brand_post";
  characterCount: number;
  xPostId: string;
  fingerprintPersisted: boolean;
  topicEventKey: string;
  /** "PUBLISHED" / "IDEMPOTENT"、または確定の書き込みに失敗した場合 "SETTLE_FAILED"（イベントは provider_started のまま保持）。 */
  topicSettlement: string;
}> {
  if (context.brand.id !== "ai_salaryman_lab") {
    throw new BrandContextError("AI_LAB_DISPATCH_BRAND_MISMATCH");
  }
  if (postType !== "brand_post") {
    throw new BrandContextError("AI_LAB_POST_TYPE_NOT_ENABLED");
  }
  assertBrandPublishAllowed(context);

  // 1. X の前にイベントを確保する。確保できなければ（使用済み・確保中・クールダウン・衝突）ここで終わり、X へ進まない。
  const claim = await topic.claim();
  const releaseQuietly = async (reason: string) => {
    try {
      await topic.release(claim, reason);
    } catch {
      // 解除できなくても lease 切れで expired になる（X に触れていないので安全）。
    }
  };

  // 2. X 前の処理。ここで失敗したら、自分の確保だけを解除する（X に触れていないことが確定しているため）。
  let draft: BrandPostDraft | null = null;
  let characterCount: number;
  let normalizedTextSha256: string;
  try {
    const recentFingerprints = await loadRecentFingerprints();
    let retryViolations: readonly string[] = [];
    for (let attempt = 1; attempt <= AI_LAB_MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = await generate({ openAiApiKey, context, postType, topicSeed: claim.topic, retryViolations });
      if (candidate.brandId !== "ai_salaryman_lab" || candidate.postType !== "brand_post") {
        throw new BrandContextError("AI_LAB_GENERATION_CONTEXT_MISMATCH");
      }
      const violations = collectAiLabContentViolations({
        text: candidate.text,
        seedText: claim.topic,
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
    characterCount = assertAiLabBrandPostDispatchAllowed(context, postType, draft.text);
    const duplicate = await checkCrossBrandDuplicate({
      brandId: context.brand.id,
      candidateText: draft.text,
      recentFingerprints,
    });
    if (duplicate.blocked) {
      throw new BrandContextError("AI_LAB_CROSS_BRAND_DUPLICATE");
    }
    normalizedTextSha256 = await fingerprintText(draft.text);
  } catch (error) {
    await releaseQuietly(preXReleaseReason(error));
    throw error;
  }

  // 3. X へ送る直前に provider_started をコミットする。lease 切れ等で自分の確保でなくなっていれば X へ進まない。
  //    この呼び出し自体が不明確に失敗した場合も X へは進まない（DB 側が provider_started になっていても、
  //    イベントは保持されるだけで二重投稿にはならない）。
  let started = false;
  try {
    started = await topic.startProvider(claim);
  } catch {
    started = false;
  }
  if (!started) {
    await releaseQuietly("PRE_X_PROVIDER_START_REJECTED");
    throw new BrandContextError("AI_LAB_TOPIC_CLAIM_LOST");
  }

  // 4. X。ここから先はイベントを自動で再開放しない（X が明確に拒否した場合を除く）。
  let xResponse: unknown;
  try {
    // Keep this second invocation adjacent to the X callback so later edits cannot accidentally add
    // decoration or another text transform after the length check.
    assertAiLabBrandPostDispatchAllowed(context, postType, draft.text);
    xResponse = await publishText(draft.text);
  } catch (error) {
    const status = definitiveProviderRejection(error);
    try {
      if (status !== null) {
        await topic.release(claim, `PROVIDER_REJECTED:${status}`);
      } else {
        await topic.markAmbiguous(claim, "PROVIDER_OUTCOME_UNKNOWN");
      }
    } catch {
      // 記録できなくても provider_started のまま保持される（再開放されない）。
    }
    throw error;
  }
  const xPostId = xPostIdFrom(xResponse);
  if (!xPostId) {
    try {
      await topic.markAmbiguous(claim, "PROVIDER_RESPONSE_WITHOUT_ID");
    } catch {
      // provider_started のまま保持される。
    }
    throw new Error("X_RESPONSE_MISSING_POST_ID");
  }

  // 5. X 成功。イベントを published に確定する。失敗・衝突しても例外は外へ出さない（X 済みの投稿を retry に
  //    回さないため）。確定できなくても行は provider_started のままで、イベントが未使用に戻ることはない。
  let topicSettlement: string;
  try {
    topicSettlement = await topic.settlePublished(claim, xPostId);
  } catch {
    topicSettlement = "SETTLE_FAILED";
  }

  // 6. 既存の completion（scheduled post / fingerprint / X 二重送信の安全）。挙動は従来どおり。
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
    topicEventKey: claim.eventKey,
    topicSettlement,
  };
}
