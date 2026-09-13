// Phase 3E: the full safe dry-run pipeline --
//   persona/settings -> generation -> cross-brand dedupe check -> publish gate -> stop before X.
// This mirrors, at the logic level, the exact sequence x-test-post/index.ts runs in production
// (loadBrandContext -> assertBrandPublishAllowed -> loadBrandXTokens, proven in
// _shared/brand/dispatch_gate_test.ts) but never calls loadBrandXTokens or any X endpoint itself, so
// x_write_calls is always structurally 0 -- not just 0 by accident of current brand state. There is no
// import of x_oauth2_post.ts, token_loader.ts, or index.ts anywhere in this file or in
// brand_post_generator.ts, which is what makes "AI Lab path never reads the legacy Kabumori token
// store" true by construction rather than by test coverage alone.
import { assertBrandPublishAllowed } from "./publish_guard.ts";
import { type BrandContext } from "./brand_context.ts";
import { generateBrandPost, type BrandPostDraft } from "./brand_post_generator.ts";
import { checkCrossBrandDuplicate, type CrossBrandDuplicateResult, type PublishedFingerprint } from "./cross_brand_dedupe.ts";

export type PublishGateResult =
  | { blocked: false }
  | { blocked: true; reason: string };

export type BrandPostDryRunResult = {
  brandId: string;
  postType: string;
  generated: BrandPostDraft;
  crossBrandDedupe: CrossBrandDuplicateResult;
  publishGate: PublishGateResult;
  xWriteCalls: 0;
};

// The shape a scheduled_posts / execution-log row would carry if this dry-run were persisted. Proves
// brand_id flows unchanged from generation through to what claim/execution-log attribution would see,
// without this task performing the actual production INSERT (see task's own instruction to prove this
// locally rather than write synthetic production rows).
export type ScheduledBrandPostPayload = {
  brand_id: string;
  post_type: string;
  generated_text: string;
  model_used: string;
  input_tokens: number;
  output_tokens: number;
  api_cost_usd: number;
};

export function toScheduledPostPayload(result: BrandPostDryRunResult): ScheduledBrandPostPayload {
  return {
    brand_id: result.brandId,
    post_type: result.postType,
    generated_text: result.generated.text,
    model_used: result.generated.model,
    input_tokens: result.generated.inputTokens,
    output_tokens: result.generated.outputTokens,
    api_cost_usd: result.generated.apiCostUsd,
  };
}

export async function runBrandPostDryRun({
  openAiApiKey,
  context,
  postType,
  topicSeed,
  recentFingerprints = [],
  now,
  fetchImpl = fetch,
}: {
  openAiApiKey: string;
  context: BrandContext;
  postType: string;
  topicSeed?: string;
  // Caller-supplied recent window (would come from published_content_fingerprints once that table is
  // deployed and wired up -- see Phase 3D). An empty array is the correct, safe default until then: it
  // never blocks anything, which is the same as "no dedupe data available yet", not "duplicate approved".
  recentFingerprints?: PublishedFingerprint[];
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<BrandPostDryRunResult> {
  const generated = await generateBrandPost({ openAiApiKey, context, postType, topicSeed, fetchImpl });

  const crossBrandDedupe = await checkCrossBrandDuplicate({
    brandId: context.brand.id,
    candidateText: generated.text,
    recentFingerprints,
    now,
  });

  let publishGate: PublishGateResult;
  try {
    assertBrandPublishAllowed(context);
    publishGate = { blocked: false };
  } catch (error) {
    publishGate = { blocked: true, reason: error instanceof Error ? error.message : "UNKNOWN" };
  }

  return {
    brandId: context.brand.id,
    postType,
    generated,
    crossBrandDedupe,
    publishGate,
    xWriteCalls: 0,
  };
}
