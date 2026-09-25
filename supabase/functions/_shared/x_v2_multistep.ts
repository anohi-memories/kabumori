/**
 * Phase1G multi-request helpers for v2 tip threads and morning_greeting
 * (source only; no live caller yet).
 *
 * - `nextThreadAction` / `nextGreetingAction` read the persisted step ledger
 *   and return only the single next safe action. Anything unfinished,
 *   rejected, uncertain, out of order or unexpected is `blocked`; nothing is
 *   ever re-sent.
 * - `runProviderStepOnceV2` durably begins exactly one planned step, then makes
 *   exactly one X request (no refresh, no retry, redirects not followed) and
 *   returns the step outcome to record with finish_provider_step_v2.
 * - `createV2StepLedgerClient` calls the service_role-only Phase1F/1G RPCs.
 *
 * The caller resolves the credential with the Phase1E exact-account resolver
 * and verifies identity before mark_post_provider_started_v2. No helper loops
 * over steps, infers an account from a brand, or logs tokens or bodies.
 */
import type { XAccountCredential } from "./x_v2_claim_credentials.ts";

export type StepRecord = {
  step_no: number;
  step_kind: "media_upload" | "create_post" | "create_reply";
  parent_provider_object_id: string | null;
  input_provider_object_id: string | null;
  phase: "provider_started" | "finished";
  outcome: "provider_object_confirmed" | "x_rejected" | "x_outcome_uncertain" | null;
  provider_object_id: string | null;
};

export type BeginAction = {
  action: "begin";
  stepNo: number;
  stepKind: StepRecord["step_kind"];
  parentProviderObjectId: string | null;
  inputProviderObjectId: string | null;
};
export type NextAction =
  | BeginAction
  | { action: "complete"; xPostIds: string[] }
  | { action: "blocked"; code: string };

function ordered(steps: readonly StepRecord[]): StepRecord[] | null {
  const sorted = [...steps].sort((a, b) => a.step_no - b.step_no);
  return sorted.every((s, i) => s.step_no === i + 1) ? sorted : null;
}

function lastBlock(step: StepRecord): { action: "blocked"; code: string } | null {
  if (step.phase !== "finished") return { action: "blocked", code: "STEP_IN_FLIGHT_OUTCOME_UNKNOWN" };
  if (step.outcome === "x_rejected") return { action: "blocked", code: "STEP_REJECTED" };
  if (step.outcome !== "provider_object_confirmed" || !step.provider_object_id) {
    return { action: "blocked", code: "STEP_OUTCOME_UNCERTAIN" };
  }
  return null;
}

/** Next safe action for a planned thread of `expectedSteps` parts (1..3). */
export function nextThreadAction(expectedSteps: number, steps: readonly StepRecord[]): NextAction {
  if (!Number.isInteger(expectedSteps) || expectedSteps < 1 || expectedSteps > 3) {
    return { action: "blocked", code: "THREAD_PLAN_INVALID" };
  }
  const list = ordered(steps);
  if (!list || list.length > expectedSteps) return { action: "blocked", code: "THREAD_STEPS_INCONSISTENT" };
  let parent: string | null = null;
  const confirmedIds = new Set<string>();
  for (const step of list) {
    const block = lastBlock(step);
    if (block) return block;
    const expectedKind = step.step_no === 1 ? "create_post" : "create_reply";
    if (step.step_kind !== expectedKind || step.parent_provider_object_id !== parent || step.input_provider_object_id !== null) {
      return { action: "blocked", code: "THREAD_STEPS_INCONSISTENT" };
    }
    if (confirmedIds.has(step.provider_object_id as string)) return { action: "blocked", code: "THREAD_STEPS_INCONSISTENT" };
    confirmedIds.add(step.provider_object_id as string);
    parent = step.provider_object_id;
  }
  if (list.length === expectedSteps) {
    return { action: "complete", xPostIds: list.map((s) => s.provider_object_id as string) };
  }
  const stepNo = list.length + 1;
  return {
    action: "begin",
    stepNo,
    stepKind: stepNo === 1 ? "create_post" : "create_reply",
    parentProviderObjectId: parent,
    inputProviderObjectId: null,
  };
}

/** Next safe action for the planned media_upload → create_post greeting. */
export function nextGreetingAction(steps: readonly StepRecord[]): NextAction {
  const list = ordered(steps);
  if (!list || list.length > 2) return { action: "blocked", code: "GREETING_STEPS_INCONSISTENT" };
  const [media, create] = list;
  if (!media) {
    return { action: "begin", stepNo: 1, stepKind: "media_upload", parentProviderObjectId: null, inputProviderObjectId: null };
  }
  const mediaBlock = lastBlock(media);
  if (mediaBlock) return mediaBlock;
  if (media.step_kind !== "media_upload") return { action: "blocked", code: "GREETING_STEPS_INCONSISTENT" };
  if (!create) {
    return {
      action: "begin", stepNo: 2, stepKind: "create_post", parentProviderObjectId: null,
      inputProviderObjectId: media.provider_object_id,
    };
  }
  const createBlock = lastBlock(create);
  if (createBlock) return createBlock;
  if (create.step_kind !== "create_post" || create.input_provider_object_id !== media.provider_object_id) {
    return { action: "blocked", code: "GREETING_STEPS_INCONSISTENT" };
  }
  return { action: "complete", xPostIds: [create.provider_object_id as string] };
}

// ---------------------------------------------------------------------------

const X_CREATE_POST_URL = "https://api.x.com/2/tweets";
const X_MEDIA_UPLOAD_URL = "https://api.x.com/2/media/upload";
const DEFAULT_TIMEOUT_MS = 15_000;

export type StepRequest =
  | { kind: "create_post"; text: string; mediaId?: string; madeWithAi?: boolean }
  | { kind: "create_reply"; text: string; parentId: string }
  | { kind: "media_upload"; bytes: Uint8Array<ArrayBuffer>; contentType: string; filename: string; mediaCategory: string };

export type StepOutcome =
  | { kind: "not_started"; code: string; requests: 0 }
  | { kind: "provider_object_confirmed"; objectId: string; httpStatus: number; requests: 1 }
  | { kind: "x_rejected"; code: string; httpStatus: number; requests: 1 }
  | { kind: "x_outcome_uncertain"; code: string; httpStatus: number | null; requests: 1 };

function dataId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function requestFor(action: BeginAction, request: StepRequest): { url: string; init: RequestInit } | null {
  if (request.kind !== action.stepKind) return null;
  if (request.kind === "create_reply") {
    if (!request.text.trim() || request.parentId !== action.parentProviderObjectId) return null;
    return {
      url: X_CREATE_POST_URL,
      init: { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: request.text, reply: { in_reply_to_tweet_id: request.parentId } }) },
    };
  }
  if (request.kind === "create_post") {
    if (!request.text.trim() || (request.mediaId ?? null) !== action.inputProviderObjectId) return null;
    return {
      url: X_CREATE_POST_URL,
      init: { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: request.text,
          ...(request.madeWithAi ? { made_with_ai: true } : {}),
          ...(request.mediaId ? { media: { media_ids: [request.mediaId] } } : {}),
        }) },
    };
  }
  if (request.bytes.byteLength === 0 || action.inputProviderObjectId !== null) return null;
  const form = new FormData();
  form.append("media", new Blob([request.bytes], { type: request.contentType }), request.filename);
  form.append("media_category", request.mediaCategory);
  return { url: X_MEDIA_UPLOAD_URL, init: { method: "POST", body: form } };
}

/**
 * Begin (durably) and run exactly one planned step. `beginStep` must commit
 * begin_planned_provider_step_v2 for exactly `action` before it resolves.
 */
export async function runProviderStepOnceV2(
  { credential, action, request, beginStep }: {
    credential: XAccountCredential;
    action: BeginAction;
    request: StepRequest;
    beginStep: (action: BeginAction) => Promise<void>;
  },
  { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<StepOutcome> {
  const built = requestFor(action, request);
  if (!built) return { kind: "not_started", code: "STEP_REQUEST_DOES_NOT_MATCH_ACTION", requests: 0 };
  try {
    await beginStep(action);
  } catch {
    return { kind: "not_started", code: "STEP_BEGIN_NOT_RECORDED", requests: 0 };
  }
  const headers = new Headers(built.init.headers);
  headers.set("Authorization", credential.bearerHeader());
  let response: Response;
  try {
    response = await fetchImpl(built.url, {
      ...built.init, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "x_outcome_uncertain", code: "X_STEP_NETWORK_UNCERTAIN", httpStatus: null, requests: 1 };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch { /* classified below */ }
  const status = response.status;
  if (status >= 200 && status < 300) {
    const id = dataId(body);
    return id
      ? { kind: "provider_object_confirmed", objectId: id, httpStatus: status, requests: 1 }
      : { kind: "x_outcome_uncertain", code: "X_STEP_RESPONSE_MISSING_ID", httpStatus: status, requests: 1 };
  }
  if (status < 400 || status === 408 || status >= 500) {
    return { kind: "x_outcome_uncertain", code: `X_STEP_HTTP_${status}`, httpStatus: status, requests: 1 };
  }
  return { kind: "x_rejected", code: `X_STEP_REJECTED_${status}`, httpStatus: status, requests: 1 };
}

// ---------------------------------------------------------------------------

export const STEP_LEDGER_ERROR_CODES = [
  "X_CLAIM_NOT_PRE_X", "X_COMPLETION_CLAIM_INVALID", "X_COMPLETION_ACCOUNT_MISMATCH", "X_COMPLETION_POST_TYPE_MISMATCH",
  "X_COMPLETION_CONFLICT", "ATTEMPT_NOT_CONFIRMABLE", "ATTEMPT_NOT_PROVIDER_STARTED",
  "PROVIDER_STEP_PLAN_REQUIRED", "PROVIDER_STEP_PLAN_CONFLICT", "PROVIDER_STEP_PLAN_INVALID",
  "PROVIDER_STEP_BEYOND_PLAN", "PROVIDER_STEP_KIND_NOT_IN_PLAN", "PROVIDER_STEP_INPUT_MISMATCH",
  "PROVIDER_STEP_ALREADY_STARTED", "PROVIDER_STEP_OUT_OF_ORDER", "PROVIDER_STEP_PREVIOUS_NOT_CONFIRMED",
  "PROVIDER_STEP_KIND_SEQUENCE_INVALID", "PROVIDER_STEP_PARENT_MISMATCH", "PROVIDER_STEP_FIRST_MUST_CREATE",
  "PROVIDER_STEP_NOT_STARTED", "PROVIDER_STEP_CONFLICT",
  "GREETING_ALREADY_PUBLISHED", "GREETING_PUBLISH_CLAIM_HELD", "GREETING_PUBLISH_CLAIM_NOT_HELD",
  "GREETING_SCHEDULE_DATE_STALE",
  "GREETING_STEPS_NOT_COMPLETE", "THREAD_STEPS_NOT_COMPLETE",
] as const;

export class StepLedgerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StepLedgerError";
  }
}

export type V2StepLedgerClient = {
  acquireGreetingClaim(attemptId: string, claimToken: string): Promise<unknown>;
  plan(attemptId: string, claimToken: string, planKind: "tip_thread" | "morning_greeting_media_post", expectedSteps: number): Promise<unknown>;
  beginPlannedStep(attemptId: string, claimToken: string, action: BeginAction): Promise<unknown>;
  finishStep(attemptId: string, claimToken: string, stepNo: number, outcome: StepOutcome): Promise<unknown>;
  listSteps(attemptId: string): Promise<StepRecord[]>;
  completeTip(args: { attemptId: string; claimToken: string; socialAccountId: string; brandId: string; tipId: string }): Promise<unknown>;
  completeGreeting(args: { attemptId: string; claimToken: string; socialAccountId: string; brandId: string }): Promise<unknown>;
};

export function createV2StepLedgerClient({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}: { supabaseUrl: string; serviceRoleKey: string; fetchImpl?: typeof fetch }): V2StepLedgerClient {
  const base = supabaseUrl.replace(/\/$/u, "");
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" };
  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, { ...init, headers, redirect: "manual" });
    } catch {
      throw new StepLedgerError("STEP_LEDGER_UNAVAILABLE");
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch { /* empty body */ }
    if (!response.ok) {
      const message = (payload as { message?: unknown } | null)?.message;
      const known = typeof message === "string" && (STEP_LEDGER_ERROR_CODES as readonly string[]).includes(message);
      throw new StepLedgerError(known ? message : "STEP_LEDGER_UNAVAILABLE");
    }
    return payload;
  };
  const rpc = (name: string, body: Record<string, unknown>) =>
    call(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
  return {
    acquireGreetingClaim: (attemptId, claimToken) =>
      rpc("acquire_greeting_publish_claim_v2", { p_attempt_id: attemptId, p_claim_token: claimToken }),
    plan: (attemptId, claimToken, planKind, expectedSteps) =>
      rpc("plan_provider_steps_v2", { p_attempt_id: attemptId, p_claim_token: claimToken, p_plan_kind: planKind, p_expected_steps: expectedSteps }),
    beginPlannedStep: (attemptId, claimToken, action) =>
      rpc("begin_planned_provider_step_v2", {
        p_attempt_id: attemptId, p_claim_token: claimToken, p_step_no: action.stepNo, p_step_kind: action.stepKind,
        p_parent_provider_object_id: action.parentProviderObjectId, p_input_provider_object_id: action.inputProviderObjectId,
      }),
    finishStep: (attemptId, claimToken, stepNo, outcome) => {
      if (outcome.kind === "not_started") {
        return Promise.reject(new StepLedgerError("STEP_NOT_STARTED_NOTHING_TO_FINISH"));
      }
      return rpc("finish_provider_step_v2", {
        p_attempt_id: attemptId, p_claim_token: claimToken, p_step_no: stepNo, p_outcome: outcome.kind,
        p_provider_object_id: outcome.kind === "provider_object_confirmed" ? outcome.objectId : null,
        p_error_code: outcome.kind === "provider_object_confirmed" ? null : outcome.code,
      });
    },
    listSteps: async (attemptId) => {
      const params = new URLSearchParams({
        select: "step_no,step_kind,parent_provider_object_id,input_provider_object_id,phase,outcome,provider_object_id",
        attempt_id: `eq.${attemptId}`,
        order: "step_no.asc",
      });
      const rows = await call(`/rest/v1/post_provider_steps_v2?${params}`, { method: "GET" });
      if (!Array.isArray(rows)) throw new StepLedgerError("STEP_LEDGER_UNAVAILABLE");
      return rows as StepRecord[];
    },
    completeTip: ({ attemptId, claimToken, socialAccountId, brandId, tipId }) =>
      rpc("complete_tip_post_v2", {
        p_attempt_id: attemptId, p_claim_token: claimToken, p_social_account_id: socialAccountId, p_brand_id: brandId, p_tip_id: tipId,
      }),
    completeGreeting: ({ attemptId, claimToken, socialAccountId, brandId }) =>
      rpc("complete_morning_greeting_post_v2", {
        p_attempt_id: attemptId, p_claim_token: claimToken, p_social_account_id: socialAccountId, p_brand_id: brandId,
      }),
  };
}
