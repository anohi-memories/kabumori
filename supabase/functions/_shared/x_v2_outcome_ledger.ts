/**
 * Phase1F mapping from a v2 provider outcome to the ledger RPC that must
 * persist it (source only; no live caller yet).
 *
 * - pre-X outcomes settle the attempt (retryable returns the post to pending
 *   on the same account; terminal fails it).
 * - x_rejected / x_outcome_uncertain finish the attempt terminally; the post
 *   becomes failed and neither lane can re-claim it.
 * - x_created must go through the post type's typed atomic completion. If
 *   that completion fails, record_post_x_confirmed_incomplete_v2 keeps the
 *   confirmed X id so the same typed completion can finish it later.
 * - tip, morning_greeting and brand_post have no v2 completion: tip and
 *   morning_greeting need several provider steps, brand_post's live
 *   completion RPC is not in repository source. They stay v2-disabled.
 */
import type { XV2Claim } from "./x_v2_claim_credentials.ts";
import type { XV2ProviderOutcome } from "./x_v2_one_request_provider.ts";

export type LedgerCall = { rpc: string; body: Record<string, unknown> };

export const V2_TYPED_COMPLETION_RPC: Readonly<Record<string, string>> = Object.freeze({
  interaction: "complete_interaction_post_v2",
  useful_tip: "complete_useful_tip_post_v2",
  morning_report: "complete_report_post_v2",
  close_report: "complete_report_post_v2",
  us_premarket_report: "complete_report_post_v2",
});

export const V2_DISABLED_POST_TYPES: Readonly<Record<string, string>> = Object.freeze({
  tip: "MULTI_STEP_THREAD_NOT_SUPPORTED",
  morning_greeting: "MEDIA_AND_CREATE_NOT_SUPPORTED",
  brand_post: "COMPLETION_SOURCE_NOT_IN_REPOSITORY",
});

/** The typed completion RPC for a post type, or null when v2 must not publish it. */
export function typedCompletionRpcFor(postType: string): string | null {
  return Object.hasOwn(V2_TYPED_COMPLETION_RPC, postType) ? V2_TYPED_COMPLETION_RPC[postType] : null;
}

/** Ledger call for every outcome except x_created. */
export function ledgerCallForOutcome(outcome: XV2ProviderOutcome, claim: XV2Claim): LedgerCall {
  const ids = { p_attempt_id: claim.attemptId, p_claim_token: claim.claimToken };
  switch (outcome.kind) {
    case "pre_x_retryable":
    case "pre_x_terminal":
      return {
        rpc: "settle_post_pre_x_v2",
        body: { ...ids, p_retryable: outcome.kind === "pre_x_retryable", p_error_code: outcome.code },
      };
    case "x_rejected":
      return { rpc: "record_post_x_rejected_v2", body: { ...ids, p_error_code: outcome.code } };
    case "x_outcome_uncertain":
      return { rpc: "record_post_x_uncertain_v2", body: { ...ids, p_error_code: outcome.code } };
    case "x_created":
      throw new Error("X_CREATED_REQUIRES_TYPED_COMPLETION");
  }
}

/** Ledger call for a confirmed create whose typed completion failed. */
export function confirmedIncompleteCall(claim: XV2Claim, xPostId: string, errorCode: string): LedgerCall {
  return {
    rpc: "record_post_x_confirmed_incomplete_v2",
    body: { p_attempt_id: claim.attemptId, p_claim_token: claim.claimToken, p_x_post_id: xPostId, p_error_code: errorCode },
  };
}
