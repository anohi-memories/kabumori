/**
 * Phase1H PostgREST adapter for the gated v2 dispatcher (source only; not
 * imported by index.ts). Server-only: uses the service_role key, calls only
 * the service_role v2 RPCs and SELECT-only ledger tables, never follows
 * redirects, and reduces every error to a fixed code (no response bodies).
 */
import { XCredentialResolutionError, type XClaimCredentialReader } from "../_shared/x_v2_claim_credentials.ts";
import { createV2StepLedgerClient } from "../_shared/x_v2_multistep.ts";
import type { V2ClaimRow, V2DispatchLedger, V2ResumableRow } from "./v2_dispatcher.ts";

const CODE = /^[A-Z][A-Z0-9_]{1,99}$/u;

export class V2LedgerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "V2LedgerError";
  }
}

type Config = { supabaseUrl: string; serviceRoleKey: string; fetchImpl?: typeof fetch };

function client({ supabaseUrl, serviceRoleKey, fetchImpl = fetch }: Config) {
  const base = supabaseUrl.replace(/\/$/u, "");
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" };
  return async (path: string, init: RequestInit): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, { ...init, headers, redirect: "manual" });
    } catch {
      throw new V2LedgerError("V2_LEDGER_UNAVAILABLE");
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch { /* empty */ }
    if (!response.ok) {
      const message = (payload as { message?: unknown } | null)?.message;
      throw new V2LedgerError(typeof message === "string" && CODE.test(message) ? message : "V2_LEDGER_UNAVAILABLE");
    }
    return payload;
  };
}

function str(value: unknown): string {
  if (typeof value !== "string" || !value) throw new V2LedgerError("V2_LEDGER_INVALID_RESPONSE");
  return value;
}

export function createV2DispatchLedgerRpc(config: Config): V2DispatchLedger {
  const call = client(config);
  const rpc = (name: string, body: Record<string, unknown>) =>
    call(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
  const steps = createV2StepLedgerClient(config);
  const ids = (attemptId: string, claimToken: string) => ({ p_attempt_id: attemptId, p_claim_token: claimToken });
  return {
    async listResumable(limit) {
      const rows = await rpc("list_resumable_v2_attempts", { p_limit: limit });
      if (!Array.isArray(rows)) throw new V2LedgerError("V2_LEDGER_INVALID_RESPONSE");
      return rows.map((r: Record<string, unknown>): V2ResumableRow => ({
        attemptId: str(r.attempt_id), claimToken: str(r.claim_token), scheduledPostId: str(r.scheduled_post_id),
        brandId: str(r.brand_id), socialAccountId: str(r.social_account_id), postType: str(r.post_type),
        planKind: str(r.plan_kind) as V2ResumableRow["planKind"], expectedSteps: Number(r.expected_steps),
      }));
    },
    async claim() {
      const rows = await rpc("claim_due_post_v2", {});
      if (!Array.isArray(rows)) throw new V2LedgerError("V2_LEDGER_INVALID_RESPONSE");
      const r = rows[0] as Record<string, unknown> | undefined;
      if (!r) return null;
      return {
        attemptId: str(r.attempt_id), claimToken: str(r.claim_token), scheduledPostId: str(r.scheduled_post_id),
        brandId: str(r.brand_id), socialAccountId: str(r.social_account_id), postType: str(r.post_type),
      } satisfies V2ClaimRow;
    },
    async readScheduleDate(scheduledPostId) {
      const params = new URLSearchParams({ select: "schedule_date", id: `eq.${scheduledPostId}` });
      const rows = await call(`/rest/v1/scheduled_posts?${params}`, { method: "GET" });
      const r = Array.isArray(rows) ? rows[0] as { schedule_date?: unknown } | undefined : undefined;
      return typeof r?.schedule_date === "string" ? r.schedule_date : null;
    },
    async markProviderStarted(a, t) { await rpc("mark_post_provider_started_v2", ids(a, t)); },
    async settlePreX(a, t, retryable, code) {
      const outcome = await rpc("settle_post_pre_x_v2", { ...ids(a, t), p_retryable: retryable, p_error_code: code });
      if (outcome !== "pre_x_retryable" && outcome !== "pre_x_terminal") {
        throw new V2LedgerError("V2_LEDGER_INVALID_RESPONSE");
      }
      return outcome;
    },
    async recordRejected(a, t, code) { await rpc("record_post_x_rejected_v2", { ...ids(a, t), p_error_code: code }); },
    async recordUncertain(a, t, code) { await rpc("record_post_x_uncertain_v2", { ...ids(a, t), p_error_code: code }); },
    async recordConfirmedIncomplete(a, t, xPostId, code) {
      await rpc("record_post_x_confirmed_incomplete_v2", { ...ids(a, t), p_x_post_id: xPostId, p_error_code: code });
    },
    async completeSingle(claim, content, xPostId) {
      const identity = {
        ...ids(claim.attemptId, claim.claimToken), p_social_account_id: claim.socialAccountId,
        p_brand_id: claim.brandId, p_x_post_id: xPostId,
      };
      const out = content.kind === "useful_tip"
        ? await rpc("complete_useful_tip_post_v2", {
          ...identity, p_useful_tip_id: content.usefulTipId, p_source_urls: content.sourceUrls ?? null,
          p_model_used: content.modelUsed, p_escalated: content.escalated, p_input_tokens: content.inputTokens,
          p_output_tokens: content.outputTokens, p_api_cost: content.apiCost,
        })
        : await rpc("complete_report_post_v2", { ...identity, p_post_type: claim.postType, p_run_id: content.runId });
      return str(out);
    },
    async acquireGreetingClaim(a, t) { await steps.acquireGreetingClaim(a, t); },
    async plan(a, t, kind, expected) { await steps.plan(a, t, kind, expected); },
    async recordSnapshot(a, t, payload) { await rpc("record_v2_content_snapshot", { ...ids(a, t), p_payload: payload }); },
    async readSnapshot(attemptId) {
      const params = new URLSearchParams({ select: "payload", attempt_id: `eq.${attemptId}` });
      const rows = await call(`/rest/v1/post_v2_content_snapshots?${params}`, { method: "GET" });
      return Array.isArray(rows) ? (rows[0] as { payload?: unknown } | undefined)?.payload ?? null : null;
    },
    listSteps: (attemptId) => steps.listSteps(attemptId),
    async beginPlannedStep(a, t, action) { await steps.beginPlannedStep(a, t, action); },
    async finishStep(a, t, stepNo, outcome) { await steps.finishStep(a, t, stepNo, outcome); },
    async completeTip(claim, tipId) {
      return str(await steps.completeTip({
        attemptId: claim.attemptId, claimToken: claim.claimToken, socialAccountId: claim.socialAccountId, brandId: claim.brandId, tipId,
      }));
    },
    async completeGreeting(claim) {
      return str(await steps.completeGreeting({
        attemptId: claim.attemptId, claimToken: claim.claimToken, socialAccountId: claim.socialAccountId, brandId: claim.brandId,
      }));
    },
  };
}

/** Reader for read_x_publish_credential_for_resume_v2 (next step of a resumable attempt only). */
export function createXResumeCredentialRpcReader(config: Config): XClaimCredentialReader {
  const call = client(config);
  return {
    async readForClaim(claim) {
      try {
        return await call("/rest/v1/rpc/read_x_publish_credential_for_resume_v2", {
          method: "POST",
          body: JSON.stringify({
            p_attempt_id: claim.attemptId, p_claim_token: claim.claimToken,
            p_social_account_id: claim.socialAccountId, p_expected_brand_id: claim.brandId,
          }),
        });
      } catch (error) {
        const code = error instanceof V2LedgerError ? error.code : "";
        throw new XCredentialResolutionError(code === "X_CLAIM_ACCOUNT_MISMATCH" ? "X_CLAIM_ACCOUNT_MISMATCH" : "X_CREDENTIAL_READ_FAILED");
      }
    },
  };
}
