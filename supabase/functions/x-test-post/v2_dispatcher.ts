/**
 * Phase1H gated v2 dispatcher (source only). Not imported by index.ts; the
 * live scheduler keeps using the legacy dispatcher. Nothing here runs unless
 * a caller passes `gateOn === true`, which `isV2DispatchGateOn` returns only
 * for the exact server env value `X_AUTOPOST_V2_DISPATCH=enabled`.
 *
 * One run does at most one unit of work:
 *   1. resume the oldest resumable multi-step attempt (tip / morning_greeting)
 *      whose last step is confirmed, else
 *   2. claim one bound due post through the Phase1D v2 claim domain.
 * Every X request is preceded by a committed provider-start / step-begin;
 * exactly one request per durable step; no refresh, no retry, no fallback to
 * the legacy path; every outcome is written to the v2 ledger before the run
 * ends. The only credential authority is the claim's social_account_id.
 */
import {
  resolveXCredentialForClaim,
  XCredentialResolutionError,
  type XAccountCredential,
  type XClaimCredentialReader,
  type XV2Claim,
} from "../_shared/x_v2_claim_credentials.ts";
import { createXTextPostOnceV2, verifyXCredentialIdentityPreX } from "../_shared/x_v2_one_request_provider.ts";
import {
  nextGreetingAction,
  nextThreadAction,
  runProviderStepOnceV2,
  type BeginAction,
  type StepOutcome,
  type StepRecord,
  type StepRequest,
} from "../_shared/x_v2_multistep.ts";

// --- gate --------------------------------------------------------------------

export const V2_DISPATCH_GATE_ENV = "X_AUTOPOST_V2_DISPATCH";
export const V2_DISPATCH_GATE_ENABLED_VALUE = "enabled";

/** True only for the exact server-side value; missing/other/throwing = OFF. */
export function isV2DispatchGateOn(getEnv: (name: string) => string | undefined): boolean {
  try {
    return getEnv(V2_DISPATCH_GATE_ENV) === V2_DISPATCH_GATE_ENABLED_VALUE;
  } catch {
    return false;
  }
}

// --- post types ----------------------------------------------------------------

export const V2_SINGLE_CREATE_TYPES = ["useful_tip", "morning_report", "close_report", "us_premarket_report"] as const;
export const V2_MULTI_STEP_TYPES = ["tip", "morning_greeting"] as const;
export const V2_DISABLED_TYPES: Readonly<Record<string, string>> = Object.freeze({
  interaction: "V2_INTERACTION_POLL_SEAM_MISSING",
  brand_post: "V2_BRAND_POST_COMPLETION_SOURCE_MISSING",
});

// --- ports ---------------------------------------------------------------------

export type V2ClaimRow = {
  attemptId: string;
  claimToken: string;
  scheduledPostId: string;
  brandId: string;
  socialAccountId: string;
  postType: string;
};

export type V2ResumableRow = V2ClaimRow & {
  planKind: "tip_thread" | "morning_greeting_media_post";
  expectedSteps: number;
};

export type V2PreparedContent =
  | {
    kind: "useful_tip"; text: string; usefulTipId: string; sourceUrls: unknown; modelUsed: string | null;
    escalated: boolean | null; inputTokens: number | null; outputTokens: number | null; apiCost: number | null;
  }
  | { kind: "report"; text: string; runId: string }
  | { kind: "tip"; tipId: string; parts: string[] }
  | { kind: "morning_greeting"; text: string };

export type V2GreetingMedia = { bytes: Uint8Array<ArrayBuffer>; contentType: string; filename: string };

export type V2DispatchLedger = {
  listResumable(limit: number): Promise<V2ResumableRow[]>;
  claim(): Promise<V2ClaimRow | null>;
  readScheduleDate(scheduledPostId: string): Promise<string | null>;
  markProviderStarted(attemptId: string, claimToken: string): Promise<void>;
  settlePreX(attemptId: string, claimToken: string, retryable: boolean, code: string): Promise<"pre_x_retryable" | "pre_x_terminal">;
  recordRejected(attemptId: string, claimToken: string, code: string): Promise<void>;
  recordUncertain(attemptId: string, claimToken: string, code: string): Promise<void>;
  recordConfirmedIncomplete(attemptId: string, claimToken: string, xPostId: string, code: string): Promise<void>;
  completeSingle(claim: V2ClaimRow, content: Extract<V2PreparedContent, { kind: "useful_tip" | "report" }>, xPostId: string): Promise<string>;
  acquireGreetingClaim(attemptId: string, claimToken: string): Promise<void>;
  plan(attemptId: string, claimToken: string, planKind: "tip_thread" | "morning_greeting_media_post", expectedSteps: number): Promise<void>;
  recordSnapshot(attemptId: string, claimToken: string, payload: Record<string, unknown>): Promise<void>;
  readSnapshot(attemptId: string): Promise<unknown>;
  listSteps(attemptId: string): Promise<StepRecord[]>;
  beginPlannedStep(attemptId: string, claimToken: string, action: BeginAction): Promise<void>;
  finishStep(attemptId: string, claimToken: string, stepNo: number, outcome: StepOutcome): Promise<void>;
  completeTip(claim: V2ClaimRow, tipId: string): Promise<string>;
  completeGreeting(claim: V2ClaimRow): Promise<string>;
};

export type V2DispatchPorts = {
  ledger: V2DispatchLedger;
  /** Phase1E pre-X reader (read_x_publish_credential_for_claim_v2). */
  claimCredentials: XClaimCredentialReader;
  /** Phase1H resume reader (read_x_publish_credential_for_resume_v2). */
  resumeCredentials: XClaimCredentialReader;
  content: {
    prepare(claim: V2ClaimRow): Promise<V2PreparedContent>;
    loadGreetingMedia(claim: V2ClaimRow): Promise<V2GreetingMedia>;
  };
  /** Best-effort, after commit (legacy Storage receipt). Errors are ignored. */
  afterGreetingPublished?(claim: V2ClaimRow, xPostId: string): Promise<void>;
  /** Current JST date, YYYY-MM-DD. */
  nowJstDate(): string;
  fetchImpl?: typeof fetch;
  /** Provider steps per run for multi-step posts (default: until done/blocked). */
  maxProviderStepsPerRun?: number;
  /**
   * Phase1I exact-account pre-X refresh (refreshXAccountPreX). Called at most
   * once per run, only while the attempt is still pre-X and only after X
   * rejected the access token at the identity pre-check. The attempt is then
   * settled with the returned outcome; a successful refresh is used by the
   * next run (re-entry), never by this one. Omitted = no refresh.
   */
  refreshAccountPreX?(claim: V2ClaimRow): Promise<{ postOutcome: "pre_x_retryable" | "pre_x_terminal"; code: string; tokenRequests: number }>;
};

export type V2DispatchClass =
  | "gate_off" | "no_work" | "unsupported_type" | "pre_x_retryable" | "pre_x_terminal"
  | "provider_rejected" | "provider_uncertain" | "confirmed_db_incomplete" | "completed"
  | "in_progress" | "blocked_manual_reconciliation";

export type V2DispatchResult = {
  class: V2DispatchClass;
  code?: string;
  attemptId?: string;
  postType?: string;
  xPostIds?: string[];
  createRequests: number;
  mediaUploads: number;
  refreshRequests: number;
};

/** Classes after which the scheduler must never reclaim or republish automatically. */
export const V2_NON_RECLAIMABLE_CLASSES: ReadonlySet<V2DispatchClass> = new Set([
  "pre_x_terminal", "provider_rejected", "provider_uncertain", "confirmed_db_incomplete",
  "completed", "unsupported_type", "blocked_manual_reconciliation",
]);

// --- helpers -------------------------------------------------------------------

type Counters = { createRequests: number; mediaUploads: number; refreshRequests: number };

export const X_ACCESS_TOKEN_REFRESH_REQUIRED = "X_ACCESS_TOKEN_REFRESH_REQUIRED_PRE_X";

function toClaim(row: V2ClaimRow): XV2Claim {
  return { attemptId: row.attemptId, claimToken: row.claimToken, socialAccountId: row.socialAccountId, brandId: row.brandId };
}

function errorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{1,99}$/u.test(message) ? message : fallback;
}

function result(cls: V2DispatchClass, claim: V2ClaimRow | null, counters: Counters, extra: Partial<V2DispatchResult> = {}): V2DispatchResult {
  return {
    class: cls,
    ...(claim ? { attemptId: claim.attemptId, postType: claim.postType } : {}),
    createRequests: counters.createRequests,
    mediaUploads: counters.mediaUploads,
    refreshRequests: counters.refreshRequests,
    ...extra,
  };
}

async function settle(ports: V2DispatchPorts, claim: V2ClaimRow, retryable: boolean, code: string, counters: Counters): Promise<V2DispatchResult> {
  try {
    const outcome = await ports.ledger.settlePreX(claim.attemptId, claim.claimToken, retryable, code);
    return result(outcome, claim, counters, { code });
  } catch {
    // No durable outcome is known. A stale-pre-X reconciler may decide later;
    // never report the requested outcome as though the write had committed.
    return result("blocked_manual_reconciliation", claim, counters, { code: "PRE_X_SETTLEMENT_NOT_RECORDED" });
  }
}

/**
 * Pre-X identity failure. When X rejected the access token and a refresh port
 * exists, refresh the exact account once, then settle the attempt so the next
 * run re-resolves and re-verifies the new token. Never refreshes after
 * provider start (callers only reach this before markProviderStarted).
 */
async function settleIdentityFailure(
  ports: V2DispatchPorts, claim: V2ClaimRow, retryable: boolean, code: string, counters: Counters,
): Promise<V2DispatchResult> {
  if (code !== X_ACCESS_TOKEN_REFRESH_REQUIRED || !ports.refreshAccountPreX) return settle(ports, claim, retryable, code, counters);
  let refreshed: { postOutcome: "pre_x_retryable" | "pre_x_terminal"; code: string; tokenRequests: number };
  try {
    refreshed = await ports.refreshAccountPreX(claim);
  } catch {
    refreshed = { postOutcome: "pre_x_terminal", code: "X_REFRESH_HELPER_FAILED", tokenRequests: 0 };
  }
  counters.refreshRequests += refreshed.tokenRequests;
  return settle(ports, claim, refreshed.postOutcome === "pre_x_retryable", refreshed.code, counters);
}

async function recordAfterStart(
  ports: V2DispatchPorts, claim: V2ClaimRow, kind: "rejected" | "uncertain", code: string, counters: Counters,
): Promise<V2DispatchResult> {
  try {
    if (kind === "rejected") await ports.ledger.recordRejected(claim.attemptId, claim.claimToken, code);
    else await ports.ledger.recordUncertain(claim.attemptId, claim.claimToken, code);
  } catch {
    return result("blocked_manual_reconciliation", claim, counters, { code: `OUTCOME_NOT_RECORDED:${code}` });
  }
  return result(kind === "rejected" ? "provider_rejected" : "provider_uncertain", claim, counters, { code });
}

async function recordIncomplete(
  ports: V2DispatchPorts, claim: V2ClaimRow, xPostId: string, code: string, counters: Counters, ids: string[],
): Promise<V2DispatchResult> {
  try {
    await ports.ledger.recordConfirmedIncomplete(claim.attemptId, claim.claimToken, xPostId, code);
  } catch {
    return result("blocked_manual_reconciliation", claim, counters, { code: `CONFIRMED_X_NOT_RECORDED:${code}`, xPostIds: ids });
  }
  return result("confirmed_db_incomplete", claim, counters, { code, xPostIds: ids });
}

async function resolveCredential(
  claim: V2ClaimRow, reader: XClaimCredentialReader,
): Promise<{ credential: XAccountCredential } | { outcome: "pre_x_retryable" | "pre_x_terminal"; code: string }> {
  try {
    return { credential: await resolveXCredentialForClaim(toClaim(claim), reader, { requirePublishEnabled: true }) };
  } catch (error) {
    if (error instanceof XCredentialResolutionError) return { outcome: error.outcome, code: error.code };
    return { outcome: "pre_x_retryable", code: "X_CREDENTIAL_READ_FAILED" };
  }
}

function snapshotParts(snapshot: unknown, kind: "tip" | "morning_greeting"): { parts: string[]; tipId: string | null } | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const record = snapshot as Record<string, unknown>;
  if (kind === "tip") {
    const parts = record.parts;
    if (!Array.isArray(parts) || !parts.every((p) => typeof p === "string" && p.trim()) || typeof record.tip_id !== "string") return null;
    return { parts: parts as string[], tipId: record.tip_id };
  }
  return typeof record.text === "string" && record.text.trim() ? { parts: [record.text], tipId: null } : null;
}

// --- multi-step execution --------------------------------------------------------

type StepRun = {
  claim: V2ClaimRow;
  kind: "tip" | "morning_greeting";
  expectedSteps: number;
  parts: string[];
  tipId: string | null;
  credential: XAccountCredential | null;
  credentialReader: XClaimCredentialReader;
};

async function runSteps(ports: V2DispatchPorts, run: StepRun, counters: Counters): Promise<V2DispatchResult> {
  const { claim, ledger } = { claim: run.claim, ledger: ports.ledger };
  const budget = ports.maxProviderStepsPerRun ?? Number.POSITIVE_INFINITY;
  let stepsThisRun = 0;
  let credential = run.credential;
  for (let guard = 0; guard <= run.expectedSteps + 1; guard++) {
    let steps: StepRecord[];
    try {
      steps = await ledger.listSteps(claim.attemptId);
    } catch {
      return result("in_progress", claim, counters, { code: "V2_LEDGER_UNAVAILABLE" });
    }
    const action = run.kind === "tip" ? nextThreadAction(run.expectedSteps, steps) : nextGreetingAction(steps);
    if (action.action === "blocked") {
      return result("blocked_manual_reconciliation", claim, counters, { code: action.code });
    }
    if (action.action === "complete") {
      const ids = action.xPostIds;
      const xPostId = run.kind === "tip" ? ids[0] : ids[ids.length - 1];
      try {
        if (run.kind === "tip") await ledger.completeTip(claim, run.tipId as string);
        else await ledger.completeGreeting(claim);
      } catch (error) {
        return recordIncomplete(ports, claim, xPostId, errorCode(error, "V2_TYPED_COMPLETION_FAILED"), counters, ids);
      }
      if (run.kind === "morning_greeting" && ports.afterGreetingPublished) {
        try {
          await ports.afterGreetingPublished(claim, xPostId);
        } catch { /* legacy receipt is best-effort after commit */ }
      }
      return result("completed", claim, counters, { xPostIds: ids });
    }
    if (stepsThisRun >= budget) return result("in_progress", claim, counters, { code: "V2_STEP_BUDGET_REACHED" });
    if (!credential) {
      const resolved = await resolveCredential(claim, run.credentialReader);
      if (!("credential" in resolved)) return result("in_progress", claim, counters, { code: resolved.code });
      const identity = await verifyXCredentialIdentityPreX(resolved.credential, { fetchImpl: ports.fetchImpl });
      if (identity.kind !== "ok") return result("in_progress", claim, counters, { code: identity.code });
      credential = resolved.credential;
    }
    let request: StepRequest;
    if (run.kind === "tip") {
      const text = run.parts[action.stepNo - 1];
      request = action.stepKind === "create_post"
        ? { kind: "create_post", text }
        : { kind: "create_reply", text, parentId: action.parentProviderObjectId as string };
    } else if (action.stepKind === "media_upload") {
      let media: V2GreetingMedia;
      try {
        media = await ports.content.loadGreetingMedia(claim);
      } catch {
        return result("in_progress", claim, counters, { code: "V2_GREETING_MEDIA_UNAVAILABLE" });
      }
      request = { kind: "media_upload", bytes: media.bytes, contentType: media.contentType, filename: media.filename, mediaCategory: "tweet_image" };
    } else {
      request = { kind: "create_post", text: run.parts[0], mediaId: action.inputProviderObjectId as string, madeWithAi: true };
    }
    const outcome = await runProviderStepOnceV2({
      credential, action, request,
      beginStep: (a) => ledger.beginPlannedStep(claim.attemptId, claim.claimToken, a),
    }, { fetchImpl: ports.fetchImpl });
    if (outcome.kind === "not_started") return result("in_progress", claim, counters, { code: outcome.code });
    if (action.stepKind === "media_upload") counters.mediaUploads += 1;
    else counters.createRequests += 1;
    stepsThisRun += 1;
    try {
      await ledger.finishStep(claim.attemptId, claim.claimToken, action.stepNo, outcome);
    } catch {
      // The step stays in flight in the ledger: never resumed, never re-sent.
      return result("blocked_manual_reconciliation", claim, counters, { code: "STEP_OUTCOME_NOT_RECORDED" });
    }
    if (outcome.kind === "x_outcome_uncertain") return recordAfterStart(ports, claim, "uncertain", outcome.code, counters);
    if (outcome.kind === "x_rejected") {
      // Something already exists on X once a create step was confirmed.
      const createdBefore = steps.some((s) => s.step_kind !== "media_upload" && s.outcome === "provider_object_confirmed");
      return createdBefore
        ? recordAfterStart(ports, claim, "uncertain", `X_THREAD_PARTIAL_${outcome.code}`, counters)
        : recordAfterStart(ports, claim, "rejected", outcome.code, counters);
    }
  }
  return result("blocked_manual_reconciliation", claim, counters, { code: "V2_STEP_LOOP_GUARD" });
}

// --- per-claim flows -----------------------------------------------------------

async function dispatchSingle(ports: V2DispatchPorts, claim: V2ClaimRow, counters: Counters): Promise<V2DispatchResult> {
  const resolved = await resolveCredential(claim, ports.claimCredentials);
  if (!("credential" in resolved)) return settle(ports, claim, resolved.outcome === "pre_x_retryable", resolved.code, counters);
  let content: V2PreparedContent;
  try {
    content = await ports.content.prepare(claim);
  } catch (error) {
    return settle(ports, claim, true, errorCode(error, "V2_CONTENT_PREPARATION_FAILED"), counters);
  }
  const expectedKind = claim.postType === "useful_tip" ? "useful_tip" : "report";
  if (content.kind !== expectedKind) return settle(ports, claim, false, "V2_CONTENT_KIND_MISMATCH", counters);
  const outcome = await createXTextPostOnceV2({
    credential: resolved.credential,
    text: content.text,
    markProviderStarted: () => ports.ledger.markProviderStarted(claim.attemptId, claim.claimToken),
  }, { fetchImpl: ports.fetchImpl });
  counters.createRequests += outcome.createRequests;
  switch (outcome.kind) {
    case "pre_x_retryable":
    case "pre_x_terminal":
      return settleIdentityFailure(ports, claim, outcome.kind === "pre_x_retryable", outcome.code, counters);
    case "x_rejected":
      return recordAfterStart(ports, claim, "rejected", outcome.code, counters);
    case "x_outcome_uncertain":
      return recordAfterStart(ports, claim, "uncertain", outcome.code, counters);
    case "x_created":
      try {
        await ports.ledger.completeSingle(claim, content, outcome.xPostId);
      } catch (error) {
        return recordIncomplete(ports, claim, outcome.xPostId, errorCode(error, "V2_TYPED_COMPLETION_FAILED"), counters, [outcome.xPostId]);
      }
      return result("completed", claim, counters, { xPostIds: [outcome.xPostId] });
  }
}

async function dispatchMultiStep(ports: V2DispatchPorts, claim: V2ClaimRow, counters: Counters): Promise<V2DispatchResult> {
  const kind = claim.postType as "tip" | "morning_greeting";
  if (kind === "morning_greeting") {
    let scheduleDate: string | null;
    try {
      scheduleDate = await ports.ledger.readScheduleDate(claim.scheduledPostId);
    } catch {
      return settle(ports, claim, true, "V2_LEDGER_UNAVAILABLE", counters);
    }
    if (scheduleDate !== ports.nowJstDate()) return settle(ports, claim, false, "GREETING_SCHEDULE_DATE_STALE", counters);
  }
  const resolved = await resolveCredential(claim, ports.claimCredentials);
  if (!("credential" in resolved)) return settle(ports, claim, resolved.outcome === "pre_x_retryable", resolved.code, counters);
  // Identity (and token validity) before taking the day claim, so an expired
  // token does not burn the greeting day.
  const identity = await verifyXCredentialIdentityPreX(resolved.credential, { fetchImpl: ports.fetchImpl });
  if (identity.kind !== "ok") return settleIdentityFailure(ports, claim, identity.kind === "pre_x_retryable", identity.code, counters);
  let content: V2PreparedContent;
  try {
    content = await ports.content.prepare(claim);
  } catch (error) {
    return settle(ports, claim, true, errorCode(error, "V2_CONTENT_PREPARATION_FAILED"), counters);
  }
  let expectedSteps: number;
  let snapshot: Record<string, unknown>;
  if (kind === "tip") {
    if (content.kind !== "tip" || content.parts.length < 1 || content.parts.length > 3 || !content.parts.every((p) => p.trim())) {
      return settle(ports, claim, false, "V2_CONTENT_KIND_MISMATCH", counters);
    }
    expectedSteps = content.parts.length;
    snapshot = { tip_id: content.tipId, parts: content.parts };
  } else {
    if (content.kind !== "morning_greeting" || !content.text.trim()) return settle(ports, claim, false, "V2_CONTENT_KIND_MISMATCH", counters);
    expectedSteps = 2;
    snapshot = { text: content.text };
  }
  try {
    if (kind === "morning_greeting") await ports.ledger.acquireGreetingClaim(claim.attemptId, claim.claimToken);
  } catch (error) {
    return settle(ports, claim, false, errorCode(error, "GREETING_PUBLISH_CLAIM_HELD"), counters);
  }
  try {
    await ports.ledger.plan(claim.attemptId, claim.claimToken, kind === "tip" ? "tip_thread" : "morning_greeting_media_post", expectedSteps);
    await ports.ledger.recordSnapshot(claim.attemptId, claim.claimToken, snapshot);
    await ports.ledger.markProviderStarted(claim.attemptId, claim.claimToken);
  } catch (error) {
    return settle(ports, claim, true, errorCode(error, "X_PROVIDER_START_NOT_RECORDED"), counters);
  }
  const parts = kind === "tip" ? (content as { parts: string[] }).parts : [(content as { text: string }).text];
  return runSteps(ports, {
    claim, kind, expectedSteps, parts, tipId: kind === "tip" ? (content as { tipId: string }).tipId : null,
    credential: resolved.credential, credentialReader: ports.resumeCredentials,
  }, counters);
}

async function resume(ports: V2DispatchPorts, row: V2ResumableRow, counters: Counters): Promise<V2DispatchResult> {
  const kind = row.planKind === "tip_thread" ? "tip" : "morning_greeting";
  if ((kind === "tip") !== (row.postType === "tip")) {
    return result("blocked_manual_reconciliation", row, counters, { code: "V2_RESUME_PLAN_TYPE_MISMATCH" });
  }
  let snapshot: unknown;
  try {
    snapshot = await ports.ledger.readSnapshot(row.attemptId);
  } catch {
    return result("in_progress", row, counters, { code: "V2_LEDGER_UNAVAILABLE" });
  }
  const parsed = snapshotParts(snapshot, kind);
  if (!parsed || (kind === "tip" && parsed.parts.length !== row.expectedSteps)) {
    return result("blocked_manual_reconciliation", row, counters, { code: "V2_SNAPSHOT_INVALID" });
  }
  if (kind === "morning_greeting") {
    let scheduleDate: string | null = null;
    try {
      scheduleDate = await ports.ledger.readScheduleDate(row.scheduledPostId);
    } catch {
      return result("in_progress", row, counters, { code: "V2_LEDGER_UNAVAILABLE" });
    }
    let steps: StepRecord[] = [];
    try {
      steps = await ports.ledger.listSteps(row.attemptId);
    } catch {
      return result("in_progress", row, counters, { code: "V2_LEDGER_UNAVAILABLE" });
    }
    const next = nextGreetingAction(steps);
    if (scheduleDate !== ports.nowJstDate() && next.action === "begin") {
      // The day passed mid-flight; the DB refuses further steps. Close it for review.
      return recordAfterStart(ports, row, "uncertain", "GREETING_RESUME_DAY_PASSED", counters);
    }
  }
  return runSteps(ports, {
    claim: row, kind, expectedSteps: row.expectedSteps, parts: parsed.parts, tipId: parsed.tipId,
    credential: null, credentialReader: ports.resumeCredentials,
  }, counters);
}

// --- entrypoint ------------------------------------------------------------------

/** Run one unit of v2 work. Does nothing at all unless `gateOn` is true. */
export async function runV2DispatchOnce(ports: V2DispatchPorts, gateOn: boolean): Promise<V2DispatchResult> {
  const counters: Counters = { createRequests: 0, mediaUploads: 0, refreshRequests: 0 };
  if (gateOn !== true) return result("gate_off", null, counters);
  let resumable: V2ResumableRow[];
  try {
    resumable = await ports.ledger.listResumable(1);
  } catch {
    return result("no_work", null, counters, { code: "V2_LEDGER_UNAVAILABLE" });
  }
  if (resumable[0]) return resume(ports, resumable[0], counters);
  let claim: V2ClaimRow | null;
  try {
    claim = await ports.ledger.claim();
  } catch {
    return result("no_work", null, counters, { code: "V2_LEDGER_UNAVAILABLE" });
  }
  if (!claim) return result("no_work", null, counters);
  if (Object.hasOwn(V2_DISABLED_TYPES, claim.postType)) {
    const settled = await settle(ports, claim, false, V2_DISABLED_TYPES[claim.postType], counters);
    return settled.class === "pre_x_terminal" ? { ...settled, class: "unsupported_type" } : settled;
  }
  if ((V2_SINGLE_CREATE_TYPES as readonly string[]).includes(claim.postType)) return dispatchSingle(ports, claim, counters);
  if ((V2_MULTI_STEP_TYPES as readonly string[]).includes(claim.postType)) return dispatchMultiStep(ports, claim, counters);
  const settled = await settle(ports, claim, false, "V2_UNSUPPORTED_POST_TYPE", counters);
  return settled.class === "pre_x_terminal" ? { ...settled, class: "unsupported_type" } : settled;
}
