import assert from "node:assert/strict";
import test from "node:test";
import {
  V2_MULTISTEP_PLAN_KIND,
  confirmedIncompleteCall,
  ledgerCallForOutcome,
  typedCompletionRpcFor,
  V2_DISABLED_POST_TYPES,
  V2_TYPED_COMPLETION_RPC,
} from "./x_v2_outcome_ledger.ts";
import type { XV2Claim } from "./x_v2_claim_credentials.ts";

const claim: XV2Claim = { attemptId: "att", claimToken: "tok", socialAccountId: "acct_a", brandId: "brand_a" };
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,99}$/u;

test("each non-created outcome maps to exactly one ledger RPC with the claim identity", () => {
  assert.deepEqual(ledgerCallForOutcome({ kind: "pre_x_retryable", code: "X_IDENTITY_CHECK_UNAVAILABLE", createRequests: 0 }, claim), {
    rpc: "settle_post_pre_x_v2",
    body: { p_attempt_id: "att", p_claim_token: "tok", p_retryable: true, p_error_code: "X_IDENTITY_CHECK_UNAVAILABLE" },
  });
  assert.deepEqual(ledgerCallForOutcome({ kind: "pre_x_terminal", code: "X_CREDENTIAL_IDENTITY_MISMATCH", createRequests: 0 }, claim).body.p_retryable, false);
  assert.deepEqual(ledgerCallForOutcome({ kind: "x_rejected", code: "X_CREATE_REJECTED_403", httpStatus: 403, createRequests: 1 }, claim), {
    rpc: "record_post_x_rejected_v2",
    body: { p_attempt_id: "att", p_claim_token: "tok", p_error_code: "X_CREATE_REJECTED_403" },
  });
  assert.deepEqual(ledgerCallForOutcome({ kind: "x_outcome_uncertain", code: "X_CREATE_HTTP_503", httpStatus: 503, createRequests: 1 }, claim), {
    rpc: "record_post_x_uncertain_v2",
    body: { p_attempt_id: "att", p_claim_token: "tok", p_error_code: "X_CREATE_HTTP_503" },
  });
});

test("a confirmed create is never settled generically", () => {
  assert.throws(
    () => ledgerCallForOutcome({ kind: "x_created", xPostId: "1", httpStatus: 201, createRequests: 1 }, claim),
    /X_CREATED_REQUIRES_TYPED_COMPLETION/u,
  );
  assert.deepEqual(confirmedIncompleteCall(claim, "1", "X_COMPLETION_FAILED"), {
    rpc: "record_post_x_confirmed_incomplete_v2",
    body: { p_attempt_id: "att", p_claim_token: "tok", p_x_post_id: "1", p_error_code: "X_COMPLETION_FAILED" },
  });
});

test("post types split into typed completions and v2-disabled types with no overlap", () => {
  assert.equal(typedCompletionRpcFor("interaction"), "complete_interaction_post_v2");
  assert.equal(typedCompletionRpcFor("useful_tip"), "complete_useful_tip_post_v2");
  for (const t of ["morning_report", "close_report", "us_premarket_report"]) assert.equal(typedCompletionRpcFor(t), "complete_report_post_v2");
  assert.equal(typedCompletionRpcFor("tip"), "complete_tip_post_v2");
  assert.equal(typedCompletionRpcFor("morning_greeting"), "complete_morning_greeting_post_v2");
  for (const t of ["brand_post", "unknown", "__proto__", "toString"]) assert.equal(typedCompletionRpcFor(t), null, t);
  assert.deepEqual(Object.keys(V2_MULTISTEP_PLAN_KIND).sort(), ["morning_greeting", "tip"]);
  const typed = Object.keys(V2_TYPED_COMPLETION_RPC);
  const disabled = Object.keys(V2_DISABLED_POST_TYPES);
  assert.deepEqual([...typed, ...disabled].sort(), [
    "brand_post", "close_report", "interaction", "morning_greeting", "morning_report", "tip", "us_premarket_report", "useful_tip",
  ]);
  assert.ok(Object.isFrozen(V2_TYPED_COMPLETION_RPC) && Object.isFrozen(V2_DISABLED_POST_TYPES));
});

test("typed completion RPCs named here exist in the Phase1F/1G migrations and the generic one is retired", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20260924180000_x_autopost_phase1f_atomic_completion.sql", import.meta.url)) +
    await Deno.readTextFile(new URL("../../migrations/20260925090000_x_autopost_phase1g_multistep_completion.sql", import.meta.url));
  for (const rpc of new Set(Object.values(V2_TYPED_COMPLETION_RPC))) {
    assert.match(sql, new RegExp(`create function public\\.${rpc}\\(`, "u"), rpc);
  }
  assert.match(sql, /create function public\.record_post_x_rejected_v2\(/u);
  assert.match(sql, /revoke execute on function public\.complete_post_x_confirmed_v2\(uuid, uuid, text\) from service_role;/u);
  for (const code of ["X_IDENTITY_CHECK_UNAVAILABLE", "X_CREATE_REJECTED_403", "X_CREATE_HTTP_503"]) assert.match(code, ERROR_CODE);
});
