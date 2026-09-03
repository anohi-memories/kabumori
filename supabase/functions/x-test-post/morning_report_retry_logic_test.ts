import assert from "node:assert/strict";
import test from "node:test";
import { MorningLaneResponseError } from "./morning_lane_response_logic.ts";
import { VoiceEvaluationOutputError } from "./voice_evaluation_logic.ts";
import {
  MORNING_REPORT_MAX_ATTEMPTS,
  MORNING_REPORT_STALE_RUN_ERROR,
  MORNING_REPORT_STALE_RUN_THRESHOLD_MS,
  classifyMorningReportFailure,
  computeMorningReportRetryTime,
  reconcileStaleMorningReportRuns,
  shouldRetryMorningReport,
} from "./morning_report_retry_logic.ts";

const referenceTime = new Date("2026-09-01T23:20:00.000Z");

// --- classification -------------------------------------------------------

test("an OpenAI 503 is classified as retryable", () => {
  const result = classifyMorningReportFailure(new Error("MORNING_REPORT_LANE_A_US_MARKET_FAILED:503"));
  assert.equal(result.retryable, true);
});

test("an OpenAI 429 rate limit is classified as retryable", () => {
  const result = classifyMorningReportFailure(new Error("MORNING_REPORT_WRITING_FAILED:429"));
  assert.equal(result.retryable, true);
});

test("a 400-class HTTP failure is not classified as retryable", () => {
  const result = classifyMorningReportFailure(new Error("MORNING_REPORT_LANE_B_MACRO_POLICY_FAILED:400"));
  assert.equal(result.retryable, false);
});

test("a raw network failure (fetch rejecting) is classified as retryable", () => {
  const result = classifyMorningReportFailure(new TypeError("error sending request for url"));
  assert.equal(result.retryable, true);
});

test("a Supabase REST read/write failure before generation is classified as retryable", () => {
  assert.equal(classifyMorningReportFailure(new Error("JPX_CALENDAR_SELECT_FAILED")).retryable, true);
  assert.equal(classifyMorningReportFailure(new Error("US_MARKET_CALENDAR_SELECT_FAILED")).retryable, true);
  assert.equal(classifyMorningReportFailure(new Error("MORNING_REPORT_LOG_CREATE_FAILED")).retryable, true);
});

test("Fact Check failure is never retryable", () => {
  const result = classifyMorningReportFailure(new Error("MORNING_REPORT_FACT_CHECK_FAILED"));
  assert.equal(result.retryable, false);
});

test("a lane schema/freshness failure (MorningLaneResponseError) is never retryable", () => {
  const error = new MorningLaneResponseError("SCHEMA_INVALID", {
    lane: "lane_b_macro_policy", responseStatus: "completed", incomplete: false, incompleteReason: null,
    refusal: false, outputTextItemCount: 1, outputTextItemLengths: [10], parseTargetLength: 10,
    jsonParsePassed: true, schemaValidationPassed: false, failureCategory: null, schemaIssues: [],
    candidateReturnedCount: 1, candidateExclusions: [], candidateNormalizations: [],
  });
  const result = classifyMorningReportFailure(error);
  assert.equal(result.retryable, false);
});

test("a voice safety/schema failure is never retryable", () => {
  const error = new VoiceEvaluationOutputError("VOICE_EVALUATION_SCHEMA_INVALID", {
    http_status: 200, response_status: "completed", incomplete_details: null, finish_state: "completed",
    output_character_count: 10, extracted_text_character_count: 10, output_item_types: [], output_item_statuses: [],
  });
  const result = classifyMorningReportFailure(error);
  assert.equal(result.retryable, false);
});

test("an unrecognized error defaults to non-retryable", () => {
  const result = classifyMorningReportFailure(new Error("SOMETHING_NEW_AND_UNEXPECTED"));
  assert.equal(result.retryable, false);
});

// --- retry decision (attempt cap + the X-post safety override) ------------

test("a retryable transient error is retried while attempts remain", () => {
  const decision = shouldRetryMorningReport({
    error: new Error("MORNING_REPORT_LANE_A_US_MARKET_FAILED:502"),
    postAttempted: false,
    attemptNumber: 1,
    maxAttempts: MORNING_REPORT_MAX_ATTEMPTS,
  });
  assert.equal(decision.retryable, true);
});

test("retry stops once the attempt cap is reached, even for a transient error", () => {
  const decision = shouldRetryMorningReport({
    error: new Error("MORNING_REPORT_LANE_A_US_MARKET_FAILED:502"),
    postAttempted: false,
    attemptNumber: MORNING_REPORT_MAX_ATTEMPTS,
    maxAttempts: MORNING_REPORT_MAX_ATTEMPTS,
  });
  assert.equal(decision.retryable, false);
  assert.equal(decision.reasonCode, "MAX_ATTEMPTS_REACHED");
});

test("once postToX has been attempted, retry is refused regardless of the error shape", () => {
  const decision = shouldRetryMorningReport({
    error: new Error("MORNING_REPORT_LANE_A_US_MARKET_FAILED:503"), // otherwise a clearly retryable shape
    postAttempted: true,
    attemptNumber: 1,
    maxAttempts: MORNING_REPORT_MAX_ATTEMPTS,
  });
  assert.equal(decision.retryable, false);
  assert.equal(decision.reasonCode, "POST_ATTEMPTED_NO_RETRY");
});

test("a missing X post id after a successful call is not retried (X may already be posted)", () => {
  const decision = shouldRetryMorningReport({
    error: new Error("X_RESPONSE_MISSING_POST_ID"),
    postAttempted: true,
    attemptNumber: 1,
    maxAttempts: MORNING_REPORT_MAX_ATTEMPTS,
  });
  assert.equal(decision.retryable, false);
});

test("Fact Check / Freshness content failures are not retried even with attempts remaining", () => {
  const factCheck = shouldRetryMorningReport({
    error: new Error("MORNING_REPORT_FACT_CHECK_FAILED"),
    postAttempted: false, attemptNumber: 1, maxAttempts: MORNING_REPORT_MAX_ATTEMPTS,
  });
  assert.equal(factCheck.retryable, false);

  const freshness = shouldRetryMorningReport({
    error: new MorningLaneResponseError("SCHEMA_INVALID", {
      lane: "lane_a_us_market", responseStatus: "completed", incomplete: false, incompleteReason: null,
      refusal: false, outputTextItemCount: 1, outputTextItemLengths: [10], parseTargetLength: 10,
      jsonParsePassed: true, schemaValidationPassed: false, failureCategory: null, schemaIssues: [],
      candidateReturnedCount: 1, candidateExclusions: [], candidateNormalizations: [],
    }),
    postAttempted: false, attemptNumber: 1, maxAttempts: MORNING_REPORT_MAX_ATTEMPTS,
  });
  assert.equal(freshness.retryable, false);
});

// --- retry delay ------------------------------------------------------------

test("retry delay grows linearly with the attempt number", () => {
  const first = computeMorningReportRetryTime(referenceTime, 1, 60_000);
  const second = computeMorningReportRetryTime(referenceTime, 2, 60_000);
  assert.equal(first.getTime() - referenceTime.getTime(), 60_000);
  assert.equal(second.getTime() - referenceTime.getTime(), 120_000);
});

// --- stale reconciliation ---------------------------------------------------

type StaleScheduledPost = { id: string; postType: string; status: "running" | "pending" | "failed" | "succeeded"; startedAt: string };
type StaleRun = { id: string; status: "generating" | "failed" | "succeeded"; createdAt: string };

function fetcher(scheduledPosts: StaleScheduledPost[], runs: StaleRun[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/rest/v1/scheduled_posts")) {
      assert.equal(url.searchParams.get("post_type"), "eq.morning_report");
      assert.equal(url.searchParams.get("status"), "eq.running");
      const cutoff = Date.parse((url.searchParams.get("started_at") ?? "").replace(/^lte\./, ""));
      const matches = scheduledPosts.filter((row) =>
        row.postType === "morning_report" && row.status === "running" && Date.parse(row.startedAt) <= cutoff
      );
      return Response.json(matches.map((row) => ({ id: row.id })));
    }
    if (url.pathname.endsWith("/rest/v1/rpc/fail_scheduled_post")) {
      const body = JSON.parse(String(init?.body)) as { p_scheduled_post_id: string; p_message: string };
      const row = scheduledPosts.find((item) => item.id === body.p_scheduled_post_id);
      if (row && row.status === "running") row.status = "failed";
      return Response.json(null);
    }
    if (url.pathname.endsWith("/rest/v1/morning_report_runs")) {
      assert.equal(url.searchParams.get("status"), "eq.generating");
      const cutoff = Date.parse((url.searchParams.get("created_at") ?? "").replace(/^lte\./, ""));
      const updated: Array<{ id: string }> = [];
      for (const run of runs) {
        if (run.status !== "generating" || Date.parse(run.createdAt) > cutoff) continue;
        run.status = "failed";
        updated.push({ id: run.id });
      }
      return Response.json(updated);
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  };
}

async function reconcile(scheduledPosts: StaleScheduledPost[], runs: StaleRun[]) {
  return await reconcileStaleMorningReportRuns({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-key",
    referenceTime,
    fetcher: fetcher(scheduledPosts, runs),
  });
}

test("A: a stale running scheduled_post and run are detected and marked failed", async () => {
  const scheduledPosts: StaleScheduledPost[] = [{
    id: "stale-post", postType: "morning_report", status: "running",
    startedAt: new Date(referenceTime.getTime() - MORNING_REPORT_STALE_RUN_THRESHOLD_MS - 1000).toISOString(),
  }];
  const runs: StaleRun[] = [{
    id: "stale-run", status: "generating",
    createdAt: new Date(referenceTime.getTime() - MORNING_REPORT_STALE_RUN_THRESHOLD_MS - 1000).toISOString(),
  }];
  const result = await reconcile(scheduledPosts, runs);
  assert.equal(result.scheduledPostsReconciled, 1);
  assert.equal(result.runsReconciled, 1);
  assert.equal(scheduledPosts[0].status, "failed");
  assert.equal(runs[0].status, "failed");
});

test("B: a running row younger than the threshold is left untouched", async () => {
  const scheduledPosts: StaleScheduledPost[] = [{
    id: "recent-post", postType: "morning_report", status: "running",
    startedAt: new Date(referenceTime.getTime() - MORNING_REPORT_STALE_RUN_THRESHOLD_MS + 1000).toISOString(),
  }];
  const runs: StaleRun[] = [{
    id: "recent-run", status: "generating",
    createdAt: new Date(referenceTime.getTime() - MORNING_REPORT_STALE_RUN_THRESHOLD_MS + 1000).toISOString(),
  }];
  const result = await reconcile(scheduledPosts, runs);
  assert.equal(result.scheduledPostsReconciled, 0);
  assert.equal(result.runsReconciled, 0);
  assert.equal(scheduledPosts[0].status, "running");
  assert.equal(runs[0].status, "generating");
});

test("stale reconciliation error code is the message used to fail the row", async () => {
  const scheduledPosts: StaleScheduledPost[] = [{
    id: "p1", postType: "morning_report", status: "running",
    startedAt: new Date(referenceTime.getTime() - MORNING_REPORT_STALE_RUN_THRESHOLD_MS - 1).toISOString(),
  }];
  let capturedMessage: string | null = null;
  const fetcherWithCapture = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/rest/v1/scheduled_posts")) return Response.json([{ id: "p1" }]);
    if (url.pathname.endsWith("/rest/v1/rpc/fail_scheduled_post")) {
      capturedMessage = (JSON.parse(String(init?.body)) as { p_message: string }).p_message;
      return Response.json(null);
    }
    return Response.json([]);
  };
  await reconcileStaleMorningReportRuns({
    supabaseUrl: "https://example.supabase.co", serviceRoleKey: "test-key",
    referenceTime, fetcher: fetcherWithCapture,
  });
  assert.equal(capturedMessage, MORNING_REPORT_STALE_RUN_ERROR);
});
