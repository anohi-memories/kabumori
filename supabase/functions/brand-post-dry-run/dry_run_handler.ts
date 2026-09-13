// Phase 3F: pure, injectable request-handling logic for the admin-only "brand-post-dry-run" Edge
// Function. Kept separate from index.ts's Deno.serve wrapper so this can be exercised in `deno test`
// with fixture dependencies (no real network/DB/OpenAI call) while index.ts wires the real
// loadBrandContext / runBrandPostDryRun / runCrossBrandDedupeProbe at request time.
//
// This module never imports token_loader.ts, x_oauth2_post.ts, or index.ts from x-test-post -- there is
// no code path here that could reach the legacy Kabumori token store or call the X API. x_write_calls and
// legacy_kabumori_token_reads are therefore both 0 by construction, not by runtime luck.
import { BrandContextError, type BrandContext } from "../_shared/brand/brand_context.ts";
import { toScheduledPostPayload, type BrandPostDryRunResult } from "../_shared/brand/brand_post_dry_run.ts";
import type { CrossBrandDedupeProbeResult } from "../_shared/brand/cross_brand_dedupe_probe.ts";

// This phase's approved production execution target is ai_salaryman_lab only (Phase 3F Section B). The
// handler itself stays brand-agnostic -- extending this list is the only change a future brand needs.
const APPROVED_DRY_RUN_BRAND_IDS: readonly string[] = ["ai_salaryman_lab"];

export type BrandPostDryRunHandlerDeps = {
  loadBrandContext: (args: { supabaseUrl: string; serviceRoleKey: string; brandId: string }) => Promise<BrandContext>;
  runBrandPostDryRun: (args: {
    openAiApiKey: string;
    context: BrandContext;
    postType: string;
    topicSeed?: string;
  }) => Promise<BrandPostDryRunResult>;
  runCrossBrandDedupeProbe: (args: {
    brandId: string;
    candidateText: string;
    now?: Date;
  }) => Promise<CrossBrandDedupeProbeResult>;
  openAiApiKey: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  now?: Date;
};

export type HandlerResult = { status: number; body: Record<string, unknown> };

function errorCode(error: unknown): string {
  return error instanceof BrandContextError ? error.message : "BRAND_POST_DRY_RUN_FAILED";
}

export async function handleBrandPostDryRunRequest(
  rawBody: unknown,
  deps: BrandPostDryRunHandlerDeps,
): Promise<HandlerResult> {
  const body = typeof rawBody === "object" && rawBody !== null ? rawBody as Record<string, unknown> : {};

  const brandId = typeof body.brand_id === "string" && body.brand_id.length > 0
    ? body.brand_id
    : "ai_salaryman_lab";
  if (!APPROVED_DRY_RUN_BRAND_IDS.includes(brandId)) {
    return { status: 403, body: { error: "BRAND_POST_DRY_RUN_TARGET_NOT_APPROVED", brand_id: brandId } };
  }
  const postType = typeof body.post_type === "string" && body.post_type.length > 0 ? body.post_type : "brand_post";
  const topicSeed = typeof body.topic_seed === "string" && body.topic_seed.trim().length > 0
    ? body.topic_seed
    : undefined;

  let context: BrandContext;
  try {
    context = await deps.loadBrandContext({
      supabaseUrl: deps.supabaseUrl,
      serviceRoleKey: deps.serviceRoleKey,
      brandId,
    });
  } catch (error) {
    return { status: 404, body: { error: errorCode(error) } };
  }

  // Extra, endpoint-specific safety gate on top of runBrandPostDryRun's own publish gate: this admin
  // dry-run tool must refuse to even generate against a brand/account that isn't actually sitting in the
  // expected dry-run-only state, so it can never be pointed at a brand that has since gone live by mistake.
  const publishEnabled = context.socialAccount?.publish_enabled ?? false;
  if (context.brand.publish_mode !== "dry_run" || publishEnabled) {
    return {
      status: 409,
      body: {
        error: "BRAND_NOT_IN_EXPECTED_DRY_RUN_STATE",
        brand_id: context.brand.id,
        publish_mode: context.brand.publish_mode,
        publish_enabled: publishEnabled,
      },
    };
  }

  let result: BrandPostDryRunResult;
  try {
    result = await deps.runBrandPostDryRun({
      openAiApiKey: deps.openAiApiKey,
      context,
      postType,
      topicSeed,
    });
  } catch (error) {
    return { status: 502, body: { error: errorCode(error) } };
  }

  const dedupeProbe = await deps.runCrossBrandDedupeProbe({
    brandId: context.brand.id,
    candidateText: result.generated.text,
    now: deps.now,
  });

  return {
    status: 200,
    body: {
      dry_run: true,
      published: false,
      brand_id: result.brandId,
      post_type: result.postType,
      publish_mode: context.brand.publish_mode,
      publish_enabled: publishEnabled,
      generated: {
        text: result.generated.text,
        model: result.generated.model,
        input_tokens: result.generated.inputTokens,
        output_tokens: result.generated.outputTokens,
        api_cost_usd: result.generated.apiCostUsd,
      },
      scheduled_post_payload_preview: toScheduledPostPayload(result),
      cross_brand_dedupe: {
        would_block_on_exact_match: dedupeProbe.wouldBlockOnExactMatch,
        would_allow_on_distinct_text: dedupeProbe.wouldAllowOnDistinctText,
      },
      publish_gate: result.publishGate,
      x_write_calls: result.xWriteCalls,
      legacy_kabumori_token_reads: 0,
    },
  };
}
