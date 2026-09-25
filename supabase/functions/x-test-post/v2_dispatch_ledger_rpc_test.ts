// Mocked fetch is async by contract even when it does not await.
// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import test from "node:test";
import { XCredentialResolutionError } from "../_shared/x_v2_claim_credentials.ts";
import { createV2DispatchLedgerRpc, createXResumeCredentialRpcReader, V2LedgerError } from "./v2_dispatch_ledger_rpc.ts";

type Sent = { url: string; method: string; body: unknown; redirect: RequestRedirect | undefined; auth: string | null };

function recorder(reply: (url: string) => Response) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    sent.push({
      url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null,
      redirect: init?.redirect, auth: new Headers(init?.headers).get("Authorization"),
    });
    return reply(String(input));
  };
  return { sent, fetchImpl };
}

const claim = { attemptId: "att", claimToken: "tok", scheduledPostId: "post", brandId: "brand_a", socialAccountId: "acct_a", postType: "close_report" };

test("claim / resume listing map the service-role RPC rows exactly", async () => {
  const r = recorder((url) => url.endsWith("claim_due_post_v2")
    ? Response.json([{ scheduled_post_id: "post", attempt_id: "att", claim_token: "tok", brand_id: "brand_a", social_account_id: "acct_a", post_type: "tip" }])
    : Response.json([{ attempt_id: "att", claim_token: "tok", scheduled_post_id: "post", brand_id: "brand_a", social_account_id: "acct_a", post_type: "tip", plan_kind: "tip_thread", expected_steps: 3, confirmed_steps: 1 }]));
  const ledger = createV2DispatchLedgerRpc({ supabaseUrl: "https://e.supabase.co/", serviceRoleKey: "srk", fetchImpl: r.fetchImpl });
  assert.deepEqual(await ledger.claim(), { attemptId: "att", claimToken: "tok", scheduledPostId: "post", brandId: "brand_a", socialAccountId: "acct_a", postType: "tip" });
  assert.deepEqual(await ledger.listResumable(1), [{
    attemptId: "att", claimToken: "tok", scheduledPostId: "post", brandId: "brand_a", socialAccountId: "acct_a", postType: "tip",
    planKind: "tip_thread", expectedSteps: 3,
  }]);
  assert.deepEqual(r.sent.map((s) => [s.url, s.method, s.body]), [
    ["https://e.supabase.co/rest/v1/rpc/claim_due_post_v2", "POST", {}],
    ["https://e.supabase.co/rest/v1/rpc/list_resumable_v2_attempts", "POST", { p_limit: 1 }],
  ]);
  assert.ok(r.sent.every((s) => s.redirect === "manual" && s.auth === "Bearer srk"));
});

test("empty claim is no work; malformed rows fail closed", async () => {
  const empty = createV2DispatchLedgerRpc({ supabaseUrl: "https://e", serviceRoleKey: "k", fetchImpl: recorder(() => Response.json([])).fetchImpl });
  assert.equal(await empty.claim(), null);
  const bad = createV2DispatchLedgerRpc({ supabaseUrl: "https://e", serviceRoleKey: "k", fetchImpl: recorder(() => Response.json([{ attempt_id: 7 }])).fetchImpl });
  await assert.rejects(bad.claim(), (e: unknown) => e instanceof V2LedgerError && e.code === "V2_LEDGER_INVALID_RESPONSE");
});

test("outcome, completion and snapshot calls send exactly the reviewed parameters", async () => {
  const r = recorder((url) => url.includes("complete_") ? Response.json("completed") : url.includes("post_v2_content_snapshots")
    ? Response.json([{ payload: { text: "t" } }]) : url.includes("scheduled_posts") ? Response.json([{ schedule_date: "2026-09-25" }]) : Response.json(null));
  const ledger = createV2DispatchLedgerRpc({ supabaseUrl: "https://e.supabase.co", serviceRoleKey: "srk", fetchImpl: r.fetchImpl });
  await ledger.markProviderStarted("att", "tok");
  await ledger.settlePreX("att", "tok", true, "X_IDENTITY_CHECK_UNAVAILABLE");
  await ledger.recordRejected("att", "tok", "X_CREATE_REJECTED_403");
  await ledger.recordUncertain("att", "tok", "X_CREATE_HTTP_503");
  await ledger.recordConfirmedIncomplete("att", "tok", "x1", "V2_TYPED_COMPLETION_FAILED");
  assert.equal(await ledger.completeSingle(claim, { kind: "report", text: "t", runId: "run1" }, "x1"), "completed");
  assert.equal(await ledger.completeSingle({ ...claim, postType: "useful_tip" }, {
    kind: "useful_tip", text: "t", usefulTipId: "u1", sourceUrls: ["s"], modelUsed: "m", escalated: false, inputTokens: 1, outputTokens: 2, apiCost: 0.1,
  }, "x2"), "completed");
  await ledger.recordSnapshot("att", "tok", { text: "t" });
  assert.deepEqual(await ledger.readSnapshot("att"), { text: "t" });
  assert.equal(await ledger.readScheduleDate("post"), "2026-09-25");
  const bodies = r.sent.map((s) => [s.url.replace("https://e.supabase.co/rest/v1/", ""), s.body]);
  assert.deepEqual(bodies.slice(0, 7), [
    ["rpc/mark_post_provider_started_v2", { p_attempt_id: "att", p_claim_token: "tok" }],
    ["rpc/settle_post_pre_x_v2", { p_attempt_id: "att", p_claim_token: "tok", p_retryable: true, p_error_code: "X_IDENTITY_CHECK_UNAVAILABLE" }],
    ["rpc/record_post_x_rejected_v2", { p_attempt_id: "att", p_claim_token: "tok", p_error_code: "X_CREATE_REJECTED_403" }],
    ["rpc/record_post_x_uncertain_v2", { p_attempt_id: "att", p_claim_token: "tok", p_error_code: "X_CREATE_HTTP_503" }],
    ["rpc/record_post_x_confirmed_incomplete_v2", { p_attempt_id: "att", p_claim_token: "tok", p_x_post_id: "x1", p_error_code: "V2_TYPED_COMPLETION_FAILED" }],
    ["rpc/complete_report_post_v2", {
      p_attempt_id: "att", p_claim_token: "tok", p_social_account_id: "acct_a", p_brand_id: "brand_a", p_x_post_id: "x1",
      p_post_type: "close_report", p_run_id: "run1",
    }],
    ["rpc/complete_useful_tip_post_v2", {
      p_attempt_id: "att", p_claim_token: "tok", p_social_account_id: "acct_a", p_brand_id: "brand_a", p_x_post_id: "x2",
      p_useful_tip_id: "u1", p_source_urls: ["s"], p_model_used: "m", p_escalated: false, p_input_tokens: 1, p_output_tokens: 2, p_api_cost: 0.1,
    }],
  ]);
  assert.deepEqual(bodies[7], ["rpc/record_v2_content_snapshot", { p_attempt_id: "att", p_claim_token: "tok", p_payload: { text: "t" } }]);
  assert.ok(String(bodies[8][0]).startsWith("post_v2_content_snapshots?select=payload&attempt_id=eq.att"));
  assert.ok(String(bodies[9][0]).startsWith("scheduled_posts?select=schedule_date&id=eq.post"));
  assert.ok(r.sent.every((s) => s.redirect === "manual"));
});

test("errors: known codes pass through, everything else becomes V2_LEDGER_UNAVAILABLE without the body", async () => {
  const known = createV2DispatchLedgerRpc({ supabaseUrl: "https://e", serviceRoleKey: "k",
    fetchImpl: recorder(() => Response.json({ message: "ATTEMPT_NOT_PROVIDER_STARTED" }, { status: 400 })).fetchImpl });
  await assert.rejects(known.recordUncertain("a", "t", "X"), (e: unknown) => e instanceof V2LedgerError && e.code === "ATTEMPT_NOT_PROVIDER_STARTED");
  const leaky = createV2DispatchLedgerRpc({ supabaseUrl: "https://e", serviceRoleKey: "k",
    fetchImpl: recorder(() => Response.json({ message: "permission denied tok_SECRET" }, { status: 500 })).fetchImpl });
  await assert.rejects(leaky.markProviderStarted("a", "t"), (e: unknown) => e instanceof V2LedgerError && e.code === "V2_LEDGER_UNAVAILABLE" && !e.message.includes("SECRET"));
  const redirect = createV2DispatchLedgerRpc({ supabaseUrl: "https://e", serviceRoleKey: "k",
    fetchImpl: recorder(() => new Response(null, { status: 307, headers: { Location: "https://evil" } })).fetchImpl });
  await assert.rejects(redirect.claim(), (e: unknown) => e instanceof V2LedgerError);
  const down = createV2DispatchLedgerRpc({ supabaseUrl: "https://e", serviceRoleKey: "k", fetchImpl: async () => { throw new TypeError("offline"); } });
  await assert.rejects(down.claim(), (e: unknown) => e instanceof V2LedgerError && e.code === "V2_LEDGER_UNAVAILABLE");
});

test("resume credential reader calls only the resume RPC and maps failures to fixed codes", async () => {
  const ok = recorder(() => Response.json([{ social_account_id: "acct_a", brand_id: "brand_a", platform_user_id: "x_a", access_token: "tok" }]));
  const reader = createXResumeCredentialRpcReader({ supabaseUrl: "https://e.supabase.co", serviceRoleKey: "srk", fetchImpl: ok.fetchImpl });
  await reader.readForClaim({ attemptId: "att", claimToken: "tok", socialAccountId: "acct_a", brandId: "brand_a" }, true);
  assert.deepEqual([ok.sent[0].url, ok.sent[0].body, ok.sent[0].redirect], [
    "https://e.supabase.co/rest/v1/rpc/read_x_publish_credential_for_resume_v2",
    { p_attempt_id: "att", p_claim_token: "tok", p_social_account_id: "acct_a", p_expected_brand_id: "brand_a" },
    "manual",
  ]);
  for (const [message, code] of [["X_RESUME_NOT_ALLOWED", "X_CREDENTIAL_READ_FAILED"], ["X_CLAIM_ACCOUNT_MISMATCH", "X_CLAIM_ACCOUNT_MISMATCH"]]) {
    const bad = createXResumeCredentialRpcReader({ supabaseUrl: "https://e", serviceRoleKey: "k",
      fetchImpl: recorder(() => Response.json({ message }, { status: 400 })).fetchImpl });
    await assert.rejects(bad.readForClaim({ attemptId: "a", claimToken: "t", socialAccountId: "s", brandId: "b" }, true),
      (e: unknown) => e instanceof XCredentialResolutionError && e.code === code);
  }
});
